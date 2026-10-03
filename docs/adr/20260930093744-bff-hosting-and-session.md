# ADR: BFFはCloudFront経由のFunction URLで公開し、セッションはDynamoDBに置く

## 状態

採用（2026-09-30）

## 背景

[入口のADR](20260930083437-entry-via-bff.md)で、入口をBFFとし、ブラウザには認証情報を持たせないことを決めた。
BFFをどう公開するか、セッションとトークンをどこに置くか、`AssumeRoleWithWebIdentity`をどの頻度で呼ぶかを決める必要がある。
前提はサーバーレスとマネージドサービスを最大限に使うこと、パブリッククライアントに認証情報を持たせないことである（[要件定義](../requirements.md)）。

## 決定

1. **公開**：静的なフロントエンド（S3）とBFF（Lambda Function URL、`AWS_IAM`認証）を、同じCloudFrontディストリビューションから配信する。
   BFFのFunction URLはCloudFrontのOAC（オリジンアクセスコントロール）でだけ呼べるようにする。
2. **セッション**：DynamoDB（オンデマンド、TTL付き）にセッションを置き、cookieにはランダムなセッションIDだけを入れる。
   セッションのcookieは`HttpOnly`・`Secure`・`SameSite=Strict`とする。
3. **ログイン**：Cognitoのマネージドログインを使い、BFFがコンフィデンシャルクライアントとしてAuthorization Code＋PKCEを行う。
   アプリクライアントのシークレットはSSM Parameter StoreのSecureStringに置く。
4. **`AssumeRoleWithWebIdentity`の頻度**：BFFはリクエストごとに呼び、STSの認証情報はどこにも保存しない。

## 採用しなかった選択肢

- **API Gateway（HTTP API）＋Lambda**：APIの管理機能が揃うが、呼び出しごとの課金が増え、画面と同じオリジンにするにはCloudFrontも要る。
- **Function URLを認証なしで直接公開**：構成は最少だが、画面と別オリジンになりcookieのCSRF対策が複雑になるうえ、BFFを直接呼ばれることを防げない。
- **トークンを暗号化してcookieに入れる**：保存先が不要だが、IDトークンとリフレッシュトークンでcookieの上限（約4KB）を超えるおそれがあり、ログアウト時に無効化できない。
- **Secrets Managerにシークレットを置く**：1件ごとに月額費用がかかり、Cognitoのシークレットには自動ローテーションも効かない。
- **STSの認証情報をIDトークンの有効期限の範囲で再利用する**：呼び出し回数とレイテンシを減らせるが、AWSの認証情報をセッションストアに保存することになる。
  レイテンシの目標は置いていないので、まず保存しない形を取り、実測して判断する。

## 結果として引き受けること

### よくなること

- 画面とBFFが同じオリジンになり、`SameSite=Strict`のcookieでCSRF対策が単純になる。
- BFFのFunction URLはCloudFront経由でしか呼べない。固定費はかからない。
- ログアウト時にセッションを確実に無効化できる。STSの認証情報は保存されない。

### 引き受けること

- **OACを通すPOST・PUTでは、クライアントが本文のSHA-256を`x-amz-content-sha256`ヘッダーに付ける必要がある**（Lambdaは署名されない本文を受け付けない）。
  フロントエンドで計算する。
- **ログイン途中の状態（`state`とPKCEの`code_verifier`）を結ぶcookieは`SameSite=Lax`にする必要がある**。Cognitoのドメインから戻る
  リダイレクトはサイトをまたぐ遷移なので、`Strict`のcookieは送られない。
- リクエストごとに`AssumeRoleWithWebIdentity`の分だけレイテンシが増える。
