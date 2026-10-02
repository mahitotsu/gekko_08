# 検証結果：STSの呼び出しがCloudTrailに残す値

実施：2026-10-02（UTC）、ap-northeast-1。デプロイ済みのスタック`Gekko08App`のリクエストで記録されたイベントと、手元で発行したJWT（宛先`gekko08-jti-check`）のイベントを、
`aws cloudtrail lookup-events`で読んだ。検証のための構成は作っていない。

目的：監査サービスが、各ホップのログ（アプリの記録）とAWSの記録を突き合わせるために、CloudTrailのイベントから何が得られるかを確かめる。

## 結論

**`GetWebIdentityToken`のイベントの`responseElements.webIdentityTokenId`は、発行されたJWTの`jti`と一致した。** 受信側がJWTの`jti`を記録すれば、
ホップの記録とAWSの記録を、推測ではなく1対1で突き合わせられる。

**`AssumeRole`のイベントの`responseElements`には、発行されたセッションのアクセスキーIDとセッショントークンが入っていた**（シークレットアクセスキーは入っていない）。
イベントをそのまま画面やログに出してはならない。

## 観測した事実

| イベント | 呼んだ主体（`userIdentity`） | `requestParameters` | `responseElements` |
|---|---|---|---|
| `GetWebIdentityToken` | `arn`＝chain用role（bffでは目的を刻むrole）のセッション（セッション名＝リクエストID）。`sessionContext.sessionIssuer.arn`＝そのroleのARN。`sessionContext.sourceIdentity`＝ユーザー | `audience`（配列。例：`Gekko08App:entitlement-service`）、`durationSeconds`、`signingAlgorithm`、`tags`（`[{key: "scope", value: …}]`） | `webIdentityTokenId`、`expiration` |
| `AssumeRole`（bffが目的を刻む） | federated roleのセッション。`sessionContext.sourceIdentity`＝ユーザー | `roleArn`＝目的を刻むrole、`roleSessionName`＝リクエストID、`tags`（`[{key: "purpose", value: …}]`）、`transitiveTagKeys`（`["purpose"]`） | `credentials`（`accessKeyId`、`sessionToken`、`expiration`）、`assumedRoleUser`、`sourceIdentity` |

- 手元で発行したJWTのクレームは`aud`、`exp`、`https://sts.amazonaws.com/`、`iat`、`iss`、`jti`、`sub`だった。
- 手元で発行したJWTのイベントは、発行から数分で`lookup-events`で引けた（30秒ごとに引き直した）。

## 設計への示唆

- 受信側の共通部品は、検証したJWTの`jti`をログに記録する。`jti`は識別子で、それだけではホップを呼べない（SR-1）。
- 監査サービスは、イベントから突き合わせに使う項目だけを取り出し、`responseElements`の`credentials`を返さない（SR-3）。
