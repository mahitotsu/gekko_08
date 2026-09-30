# gekko08

AWS上のマイクロサービスで、Authorization Context（誰の権限で処理するのか）とWorkload Identity（どのサービスが呼んでいるのか）を分け、
多段呼び出しの奥まで届ける仕組みの参照実装。仕組みと当てはめ方は[設計ガイド](docs/guide.md)に、背景と設計の詳細は[docs/](docs/README.md)にある。

## 前提条件

- Node.js 24、AWS CLI、CDKでブートストラップ済みのAWSアカウント
- IAMのアウトバウンドIDフェデレーションが有効であること。アカウント全体の設定なので、参照実装は自動では有効にしない。

  ```sh
  aws iam get-outbound-web-identity-federation-info   # JwtVendingEnabled が true か確かめる
  aws iam enable-outbound-web-identity-federation     # 無効なら有効にする
  ```

## 始め方

```sh
export AWS_REGION=ap-northeast-1   # デプロイ先のリージョン
npm install
npm test               # 共通部品の単体テスト
npm run deploy         # スタック Gekko08App をデプロイする
npm run test:scenario  # デプロイしたスタックに対するシナリオテスト
npm run test:scenario:cloudtrail  # CloudTrailでの追跡も確かめる（最大15分ほどかかる）
```

デモのユーザー（yamada：tokyo、tanaka：osaka）はシナリオテストが作る。ブラウザで試すときは、パスワードを設定してから、
出力`WebUrl`を開く。

```sh
aws cognito-idp admin-set-user-password --user-pool-id <UserPoolId> --username yamada --password '<パスワード>' --permanent
```

片付けは`npm run destroy`。
