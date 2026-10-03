# 検証結果：実現性検証（STSのSourceIdentity・GetWebIdentityToken・Function URLの認可・Cognito連携）

実施：2026-09-30（UTC）、ap-northeast-1、Lambda Python 3.13（ランタイム同梱のboto3 1.42.97）。
スタック`Gekko08Spike`・`Gekko08SpikeCognito`は検証後に削除した。

目的：AWSのマネージドサービスだけで、ユーザーの識別子と業務属性をログイン時にSTSセッションへ刻み、
ワークロード間で扱えるかを確かめる。以後の検証とADRの前提になる。

## 検証1：Lambdaからの`GetWebIdentityToken`

- Lambda関数の実行roleから`sts:GetWebIdentityToken`を呼べた。ランタイム同梱のSDKで足り、追加のバンドルは不要だった。
- JWTの`sub`は呼び出し元（実行role）のARN。`https://sts.amazonaws.com/`名前空間に`lambda_source_function_arn`・
  `principal_tags`・`org_id`・`aws_account`などが入った。
- `iss`はアカウント固有の`https://<uuid>.tokens.sts.global.api.aws`。受け手はOIDCディスカバリで鍵を取得して署名を検証できる。
- 発行は`sts:GetWebIdentityToken`の権限と、`sts:IdentityTokenAudience`・`sts:DurationSeconds`・`sts:SigningAlgorithm`の条件キーで制御できる。

## 検証2：Function URL（`AWS_IAM`認証）と受信側のresource policy

- 呼び出し元のidentity policyには何も書かず、受信側のresource policy（`lambda:InvokeFunctionUrl`と、
  `lambda:InvokedViaFunctionUrl`付きの`lambda:InvokeFunction`）だけで許可したroleは200だった。
- 同じアカウントで許可していないroleと、署名のない呼び出しは、いずれも403だった（関数コードに届く前に拒否）。
- 受信側には`requestContext.authorizer.iam`として、呼び出し元の`userArn`・`principalOrgId`などが渡る。

## 検証3：Cognito User Pool → IAM OIDC provider → `AssumeRoleWithWebIdentity` → role chaining

- User Pool（Essentialsプラン）にPre Token Generation V2トリガーを付け、IDトークンに
  `https://aws.amazon.com/source_identity`（文字列）と`https://aws.amazon.com/tags`
  （ネストしたJSON：`principal_tags`と`transitive_tag_keys`）を入れられた。
- User PoolをIAM OIDC providerとして登録し（信頼ポリシーは`aud`＝アプリクライアントのIDで絞る）、`AssumeRoleWithWebIdentity`を
  直接呼ぶと、SourceIdentityとsession tagsが1回の呼び出しで設定された。
- chain先のroleへの`AssumeRole`でもSourceIdentityは保持され、transitiveに指定したtagも引き継がれた。
- 必要な権限：federated roleの信頼ポリシーには`sts:AssumeRoleWithWebIdentity`に加えて`sts:TagSession`と`sts:SetSourceIdentity`、
  chain先の信頼ポリシーには`sts:AssumeRole`と同じ2つ。
- chainしたセッションで`GetWebIdentityToken`を呼ぶと、JWTに`source_identity`が引き継がれ、transitiveなtagも`principal_tags`に入った
  （`sub`はchain先のroleのARN）。
- chainしたセッションによる`GetWebIdentityToken`のCloudTrailイベントに、`userIdentity.sessionContext.sourceIdentity`が記録された。
- ログインは`USER_PASSWORD_AUTH`で行った。Authorization Code＋PKCEは検証していない（発行されるIDトークンの形式は同じ）。

## 検証4：受信側のresource policyでのSourceIdentity・tagの条件

- 呼び出し元roleのidentity policyに、`aws:PrincipalTag/department`だけ、または`aws:SourceIdentity`だけを条件にした許可を書くと、
  条件を満たすユーザーだけが200、満たさないユーザーは403になった（片方の条件だけを満たすユーザーも正しく区別された）。
- 受信側のresource policy（`AWS::Lambda::ResourcePolicy`）に同じ条件を書いた場合も、結果は同じだった。
- `PutResourcePolicy`は関数の既存のresource policyを置き換える（`AddPermission`で付けた許可も上書きされる）ため、同じ関数で両方を併用しない。

## 文書で確認した事実（実機では未確認）

- SourceIdentityは、一度設定するとrole chaining全体で変更できない（変更の拒否は後の[多段伝播の方式比較](../multi-hop-propagation/RESULTS.md)で実機確認）。
- アカウントをまたぐchainでは、起点側の権限と先方の信頼ポリシーの両方に`sts:SetSourceIdentity`が必要。
- role chainingのセッションは最大1時間。
- Cognito Identity Poolsの「Attributes for access control」はprincipal tagsのマッピングに対応するが、SourceIdentityについての記載はない。
- Pre Token Generation V1トリガーはクレームの値が文字列だけで、配列の`transitive_tag_keys`を返せない。
