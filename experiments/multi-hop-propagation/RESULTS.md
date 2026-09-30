# 検証結果：多段伝播の方式比較

実施：2026-09-30、ap-northeast-1、Lambda Python 3.13。
目的：2ホップ目以降へAuthorization Context（SourceIdentity＋transitive session tags）を
届ける方式(a)(b)(c)を比べ、ADRの根拠にする（[PRFAQ 内部FAQ Q4](../../docs/prfaq/aws-authorization-context-propagation.md#q4-技術的に未解決なことは何か)）。

構成：Cognito（alice＝sales、bob＝hr）→ `AssumeRoleWithWebIdentity`でFrontend role → A → (B) → C。
Cは受信側resource policyで`aws:PrincipalTag/department = sales`のときだけ許可する。
生データ：`out-results.json`（方式の比較）、`out-tags.json`・`out-tags-no-tagsession.json`（タグの上書き・追加）。
いずれもgit管理外。

## 結論

| 方式 | 結果 | 判定 |
|---|---|---|
| (a) 一時クレデンシャルを下流へ渡す | 3ホップ先のCまでSourceIdentityとtagsが届き、CのIAMが正しく判定した | **唯一、最後のホップまでIAMの強制が続く方式**。ただし下記の弱点がある |
| (b) 受信側がSourceIdentityを付け直す | 受信側は呼び出し元のSourceIdentityやtagsを観測できず、任意の値を設定できた。偽装した属性でCが200を返した | **棄却** |
| (c) `GetWebIdentityToken`のJWTを伝達媒体にする | 自アカウントのSTS発行者をIAM OIDC providerとして登録できない（IAMが拒否） | **IAMセッションに戻す形は実現不可**。JWTをアプリで検証する形しか残らない |

## 観測した事実

### (a) 一時クレデンシャルを下流へ渡す

- alice：Frontend → AaOut → BaOut の各セッションで`source_identity=alice`、`department=sales`が保たれ、Cは200。
- bob：同じく`source_identity=bob`、`department=hr`が保たれ、Cは403。
- 途中のホップが別人を名乗れるか：
  - SourceIdentityの変更は拒否された（`ValidationError: The source identity is already set for this assume role session`）。
  - 引き継いだtransitive tag（`department`）の上書きは拒否された（`InvalidParameterValue: ... conflicts with a transitive tag key from the calling session`）。
  - **新しいキーのtag（`clearance=top`）の追加は、chain先のtrust policyが`sts:TagSession`を許していれば成功した。**
- 新しいキーの追加への対策：
  - trust policyから`sts:TagSession`を外すと、**tagを付けない通常のchainも拒否された**（transitive tagsの引き継ぎにも`sts:TagSession`が要る）。
  - `sts:TagSession`を`ForAllValues:StringEquals`の`aws:TagKeys`でログイン時に決めたキー（`department`）に絞ると、通常のchainは成功し、上書きも新しいキーの追加も拒否された。
- CloudTrail：各ホップの`AssumeRole`イベントに、呼び出し元の`userIdentity.sessionContext.sourceIdentity`（alice/bob）が記録された。
- `principal_tags`にはsession tagsに加えて、role自身のtag（スタックタグ`experiment`）も入る。

### (b) 受信側がSourceIdentityを付け直す

- 受信側に渡る`requestContext.authorizer.iam`は`accessKey`・`accountId`・`callerId`・`principalOrgId`・`userArn`・`userId`だけで、
  **SourceIdentityもsession tagsも含まれない**。`userArn`末尾のセッション名は呼び出し元が自由に決める値である。
- 受信側の実行roleから`SourceIdentity`・`Tags`を付けてAssumeRoleすると、任意の値を設定できた。
  bob（hr）のリクエストで`department=sales`を設定すると、Cは200を返した。
- CloudTrailには、SourceIdentityを持たないサービスroleのセッションが`sourceIdentity: bob`を設定した記録が残る。
  偽装を防げないが、事後に検出はできる。

### (c) JWTを伝達媒体にする

- `AWS::IAM::OIDCProvider`の作成が失敗した：
  `Creating an OIDC provider with an STS issuer URL from the same partition is not supported. Within a partition, use AssumeRole instead of web identity federation.`
- したがって、受信側が`GetWebIdentityToken`のJWTで`AssumeRoleWithWebIdentity`し、SourceIdentityとtags付きのIAMセッションに戻すことはできない。
- 残る形は、各ホップがJWTをアプリで検証する方式。そのホップより先ではIAMによる強制が途切れる。この形は今回検証していない。

## ADRで扱うべき論点（(a)の弱点）

- **3つの値すべてを通信路に乗せる**：SigV4の送信者拘束的な性質を失い、漏れた認証情報は有効期限まで使える。
- **Workload Identityが弱まる**：Cを呼ぶセッション（BaOut）は、Bの実行roleではなく、上流から受け取った認証情報でAssumeRoleしたもの。
  AaOutの認証情報を持つ者なら誰でもBaOutになれるため、Cが見る呼び出し元roleは「Bのコード」を証明しない。
  Lambda実行環境に縛る条件（`lambda:SourceFunctionArn`など）が使えるかは未検証。
- **role chainingの1時間上限**。
- **chain先のtrust policyでは`sts:TagSession`を`aws:TagKeys`で絞ることが必須**（絞らないと途中のホップが属性を追加できる）。
