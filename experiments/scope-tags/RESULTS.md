# 検証結果：scope相当の値をSTSとIAMに強制させる

実施：2026-09-30（UTC）、ap-northeast-1。テスト用スクリプト（TypeScript、AWS SDK for JavaScript v3）から、
IAM roleだけのスタックに対して実行した。

目的：認可サーバーを置かずに、OAuthのscope相当の値（委任の範囲）をSTSとIAMに強制させられるかを確かめる。あわせて、
`GetWebIdentityToken`の発行条件（署名方式、有効期間、宛先）が効くかを確かめる。

生データ：`out-results.json`（git管理外）。

## 構成

- **E0**：`GetWebIdentityToken`を、宛先`ForAllValues:StringEquals`（＋`Null`）、`sts:SigningAlgorithm`＝ES384、`sts:DurationSeconds`≦300で許すrole。
- **E1（形A：ホップごとのscope）**：`GetWebIdentityToken`は宛先`ForAnyValue:StringEquals`（参照実装の本体と同じ書き方）で許す。
  `sts:TagGetWebIdentityToken`は、宛先ごとに文を分け、宛先を`ForAllValues`で1つに限り、tagのキーを`scope`だけ、値を1つに限って許す
  （case-service宛ては`case:summary`、account-service宛ては`account:read`）。
- **E2（形B：取引の目的）**：User（ログイン時のfederated roleのセッションに相当。SourceIdentity＝yamada、transitive tag `branch`＝tokyo）→
  Purpose（取引の目的を刻む）→ Chain（下流のchain用role）。
  - Purposeの信頼ポリシーは、`sts:TagSession`をキー`branch`・`purpose`だけ、`aws:RequestTag/purpose`を`case-summary`・`agent-analysis`だけに限る。
  - Chainは、case-service宛てのJWTはいつでも、account-service宛てのJWTは`aws:PrincipalTag/purpose`＝`case-summary`のときだけ発行できる。
- **E3（形Aと形Bの組み合わせ）**：Chainに、case-service宛てで`scope`＝`case:read`だけを付けられる`sts:TagGetWebIdentityToken`を許す。

## 結論

**形A・形Bとも成立した。** 認可サーバーなしで、scope相当の値をAWSに強制させられる。

- 形A：JWTに付ける`scope`（`request_tags`）の値を、宛先ごとにIAMで限れた。付けられるのは許した値だけで、宛先の違う値、余計なキー、
  複数の宛先へのtag付けは拒否された。
- 形B：取引の目的をtransitive session tagとして刻め、下流のすべてのJWTの`principal_tags`に入り、途中で上書きできなかった。
  目的によって、下流が発行できるJWTの宛先をIAMで変えられた。
- **参照実装の本体の宛先の条件に穴があった。** `ForAnyValue:StringEquals`では、許した宛先に外部の宛先を混ぜたJWTを発行できた。
  `ForAllValues:StringEquals`と`Null`の組み合わせなら拒否できた。

## 観測した事実

### E0：発行条件

| 試験 | 結果 |
|---|---|
| E0-1：ES384、300秒 | 発行できた |
| E0-2：RS256 | 拒否（`sts:SigningAlgorithm`） |
| E0-3：900秒 | 拒否（`sts:DurationSeconds`） |
| E0-4：宛先`[case-service, https://external.example]`（ForAllValues） | 拒否 |

### E1：ホップごとのscope（形A）

| 試験 | 結果 |
|---|---|
| E1-1：case-service宛てに`scope=case:summary` | 発行できた。JWTの`https://sts.amazonaws.com/`の下に`request_tags: {"scope": "case:summary"}` |
| E1-2：case-service宛てに`scope=account:read` | 拒否（`sts:TagGetWebIdentityToken`） |
| E1-3：account-service宛てに`scope=account:read` | 発行できた |
| E1-4：case-service宛てに`scope`と別のキー | 拒否 |
| E1-5：case-serviceとaccount-serviceの両方宛てに`scope=case:summary` | 拒否（tagの文は宛先を`ForAllValues`で1つに限っている） |
| E1-6：tagなし | 発行できた。**`scope`のないJWTも作れるので、受信側は`scope`がないことを「何も許さない」と扱う必要がある** |
| E1-7：宛先`[case-service, https://external.example]`（ForAnyValue） | **発行できた**。`aud`は2つの値の配列 |

- `request_tags`は`principal_tags`とは別のクレームに入る。セッションタグ（ユーザーの属性や取引の目的）と混ざらない。
- `sts:TagGetWebIdentityToken`の判定でも、`sts:IdentityTokenAudience`の条件が効いた。宛先と値の組を1つの文で限れる。

### E2：取引の目的（形B）

| 試験 | 結果 |
|---|---|
| E2-1：Userのセッションから、`purpose=agent-analysis`（transitive）を刻んでPurposeへchain | 成功 |
| E2-2：`purpose=admin` | 拒否（信頼ポリシーの`aws:RequestTag/purpose`） |
| E2-3：`purpose`と別のキー`role` | 拒否（`aws:TagKeys`） |
| E2-4：Chainのセッションで発行したJWT | `source_identity=yamada`、`principal_tags`に`branch=tokyo`と`purpose=agent-analysis` |
| E2-5：PurposeからChainへのchainで`purpose=case-summary`に上書き | 拒否（`InvalidParameterValue`：呼び出し元のセッションのtransitive tagと衝突） |
| E2-6：`purpose=agent-analysis`のChainでaccount-service宛てのJWT | 拒否 |
| E2-7：`purpose=case-summary`のChainでaccount-service宛てのJWT | 発行できた |

- 目的を刻むchain（User→Purpose）の追加時間は、10回で中央値118ms、最大1147ms（1回だけ突出）。スクリプトはローカルから実行したので、
  Lambdaの中ではこれより短い見込み（参照実装のchainはLambdaの中で約60ms）。

### E3：組み合わせ

| 試験 | 結果 |
|---|---|
| E3-1：`purpose=agent-analysis`のChainで、case-service宛てに`scope=case:read` | 発行できた。`principal_tags`の`purpose`と`request_tags`の`scope`が両方入る |
| E3-2：同じChainで、case-service宛てに`scope=case:summary` | 拒否 |

## 設計への示唆

- 取引の目的（Transaction Tokensの`purp`に相当）は形Bで、ホップごとの委任の範囲（Token Exchangeのdownscopingに相当）は形Aで、
  AWSに強制させられる。いずれも、値を決めるのはIAMのポリシー（CDKで生成）で、各ホップのコードではない。
- 形Bは、目的に応じてIAM自体の判定（どの宛先のJWTを作れるか）を変えられる。目的に合わない下流への呼び出しを、アプリの判定より前に止められる。
- 受信側は、`scope`がないJWTを「何も許さない」と扱う必要がある（E1-6）。
- 参照実装の本体は、`GetWebIdentityToken`の宛先の条件を`ForAllValues`＋`Null`に直す必要がある（E1-7）。
