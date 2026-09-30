# 検証結果：Token Exchange相当の構成（actor＝実行role、subject＝STS発行のJWT）

実施：2026-09-30、ap-northeast-1、Lambda Python 3.13（PyJWT 2.15.1、cryptography 50.0.1を同梱）。

目的：Token Exchangeと同等に、各ホップが「誰の代理か（subject）」「どのサービスから来たか（actor）」「自分宛てか（aud）」を
確実に知れるかを確かめる。あわせて、受け渡すセッションが漏れても害がないことを確かめる。VPCやIPv6の縛りは使わない。

## 構成

Frontend（テスト用スクリプト）→ A → B → C。

- **actor**：各ホップの受信側resource policyは、呼び出し元の**実行role**だけを許可する（Aの入口だけはFrontend）。
  Cの入口はさらに`lambda:SourceFunctionArn`で関数Bに限る。許可したrole以外は明示的にDenyする（後述のx4を受けて追加）。
- **subject・aud**：呼び出し元は、aliceの属性を持つセッションで`GetWebIdentityToken`を呼び、`aud`＝次のホップのJWTを
  `x-authz-context`ヘッダーに付ける。受信側のアプリは、STSの発行者のJWKSで署名を検証し、`aud`・`iss`・`exp`と、
  `sub`＝呼び出し元のchain用roleであることを確かめてから、`source_identity`とtagsを使う。
- **ABAC**：終端Cは、検証済みの`department`が`sales`のときだけ許可する（アプリで判定）。
- **chain用role**（Frontend、AChain、BChain）の権限は「次のchain用roleへのchain」と「次のホップ宛てJWTの発行」だけ。
  ホップの呼び出し権限もデータの権限も持たない。
- **受け渡し**：各ホップは、受け取ったセッションで自分のchain用roleにchainし、そのセッションを次のホップへ渡す
  （次のホップ宛てのJWTを作るため）。ホップの呼び出しには自分の実行roleで署名する。

生データ：`out-results.json`（Deny追加後）、`out-results-no-deny.json`（Deny追加前）。いずれもgit管理外。

## 結論

**成立した。** 受け渡すセッションが漏れても、どのホップも呼べず、害はなかった。IPv6の縛りなしで次のことが成り立った。

- 各ホップは、STSの署名付きJWTから「aliceの代理」と業務属性を確実に知れる。`aud`の違うJWTや改ざんしたJWTは拒否される。
- 入口は実行role（と関数）で呼び出し元を確かめるので、ホップの飛ばしも、同じ実行roleを共有する別の関数からの呼び出しも拒否される。
- **ただし、入口のresource policyに「許可したrole以外はDeny」が必須**。ないと、同じアカウントの広いidentity policyを持つ主体が、
  漏れたセッションで作ったJWTを使って呼べてしまった。

## 観測した事実

### 正常系とJWTの検証

| 試験 | 結果 |
|---|---|
| t1：alice（sales） | A・B・Cすべて200。各ホップで`subject=alice`、`department=sales`を検証。Cは許可 |
| t2：bob（hr） | Cのアプリが拒否（403、`department=hr`） |
| t3：Aが受け取ったA宛てのJWTをそのままBへ転送 | Bが拒否（401、`InvalidAudienceError`） |
| t4：署名を改ざんしたJWT | Bが拒否（401、`InvalidSignatureError`） |
| t5：JWTなし | Bが拒否（401） |
| 自己申告ヘッダー`x-auth-sub: bob` | すべてのホップで付けて送ったが、受信側は読まず、結果に影響しなかった |

- JWTの`sub`は呼び出し元のchain用roleのARN、`https://sts.amazonaws.com/`名前空間の`source_identity`と`principal_tags`は
  Frontendで設定した値がそのまま引き継がれた。
- chain用roleは、許可された宛先以外のJWTを発行できなかった（AChainにC宛てやexternal宛てを発行させるとAccessDenied）。
  宛先の制限はIAMの`sts:IdentityTokenAudience`条件で効く。

### ホップの飛ばしとなりすまし

| 試験 | 結果 |
|---|---|
| t6：侵害されたAが、受け取ったセッションからBChainにchainしてC宛てのJWTを作り、自分の実行roleでCを呼ぶ | 403（Cの入口はBの実行roleだけを許可） |
| x5：Bと同じ実行roleを共有する別の関数B2が、正規のC宛てJWTでCを呼ぶ | 403（`lambda:SourceFunctionArn`で関数Bに限定） |

- **`lambda:SourceFunctionArn`は、Function URLのresource policyの条件として使え、同じ実行roleを持つ関数どうしを区別できた。**

### 漏れたセッションを外で使う

| 試験 | 結果 |
|---|---|
| x1：Aが持ち出したAChainのセッションでB宛てのJWTを作り、そのセッションで署名してBを呼ぶ | 403 |
| x2：AChainのセッションで、外からBChainにchainする | **成功**（送信元の条件がないため） |
| x3：x2で得たBChainのセッションでC宛てのJWTを作り、そのセッションで署名してCを呼ぶ | 403 |
| x4：管理者（AdministratorAccess）の認証情報で署名し、x3のJWTを付けてCを呼ぶ | Deny追加前は**200**、Deny追加後は403 |

- 漏れたセッションでできたのは、chain用roleどうしのchainと、許された宛先のJWTの発行だけで、それを使って呼べるホップはなかった。
- x4（Deny追加前）：同じアカウントでは、resource policyが許可していない主体でも、identity policyに`lambda:InvokeFunctionUrl`等の
  広い許可があれば呼べる。Function URLのresource policyに`ArnNotEquals aws:PrincipalArn`のDenyを入れると403になった。

### レイテンシ（参考）

1ホップあたりの追加処理（chain、JWTの発行、JWTの検証）の実測。

| 状態 | chain | JWTの発行 | JWTの検証 |
|---|---|---|---|
| コールドスタート直後 | 約1.9〜2.1秒 | 約260ms | 約850ms（JWKSの取得を含む） |
| ウォーム | 約230ms | 約250ms | 1ms未満 |

ウォームでも1ホップあたり約0.5秒増える。コードは呼び出しのたびにboto3のクライアントを作っており、最適化はしていない。

## 設計への示唆

- 入口のresource policyは「呼び出し元の実行role（＋`lambda:SourceFunctionArn`）だけAllow、それ以外はDeny」の形にする。
- 関数ごとに実行roleを分ける必要はない（`lambda:SourceFunctionArn`で区別できる）が、分けておく方が単純。
- 受信側は、`aud`＝自分、`iss`＝自アカウントの発行者、`sub`＝期待する呼び出し元のchain用roleを必ず確かめる。
  `sub`と入口のIAMが確かめた実行roleが同じホップを指すことで、actorとsubjectの証明が揃う。
- JWTの宛先を内部のホップだけに限る（外部サービスがこのJWTを単独で信じると、そこではaliceになりすませる）。
- 残るリスク：侵害されたホップが、自分に許された範囲でaliceとして振る舞えること（Token Exchangeでも同じ）。
- 未確認：レイテンシの最適化（クライアントの使い回し、JWKSのキャッシュ）、JWTの有効期限（今回は300秒）の最適値。
