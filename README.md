# gekko08

AWS上のマイクロサービスで、Authorization Context（誰の権限で処理するのか）とWorkload Identity（どのサービスが呼んでいるのか）を分け、
多段呼び出しの奥まで届ける仕組みの参照実装。認可サーバーもサイドカーも置かず、Cognito・STS・IAM・Lambdaだけで、OAuth Token Exchangeと
同じこと（各ホップが「誰の代理か」「どのサービスから来たか」「自分宛てか」を確かめる）を実現する。

仕組みと当てはめ方は[設計ガイド](docs/guide.md)に、背景と設計の詳細は[docs/](docs/README.md)にある。

## 構成

```
ブラウザ ─> CloudFront ─> bff ─┬─> case-service ─> account-service        マイクロサービスの経路
                               └─> fraud-agent ─> fraud-mcp ─┬─> case-service      エージェントの経路
                                        │                    └─> account-service
                                        └─> Amazon Bedrock（Claude Haiku 4.5）
```

| ディレクトリ | 内容 |
|---|---|
| [infra/](infra/) | CDKアプリ（単一のスタック`Gekko08App`） |
| [packages/authz-context/](packages/authz-context/) | 各ホップが使う共通部品。JWTの検証、chain、JWTの発行、署名付きの呼び出し |
| [services/](services/) | 各Lambdaのハンドラー |
| [web/](web/) | デモの画面 |
| [tests/](tests/) | 要件のIDにひも付けたシナリオテスト |

## 前提条件

- Node.js 24、AWS CLI、CDKでブートストラップ済みのAWSアカウント
- IAMのアウトバウンドIDフェデレーションが有効であること。アカウント全体の設定なので、参照実装は自動では有効にしない。
  無効のままデプロイすると、デプロイが失敗して有効化の手順を示す。

  ```sh
  aws iam get-outbound-web-identity-federation-info   # JwtVendingEnabled が true か確かめる
  aws iam enable-outbound-web-identity-federation     # 無効なら有効にする
  ```

- Amazon BedrockでClaude Haiku 4.5を使えること。アカウントによっては、Anthropicのモデルを初めて使う前に利用目的の申請が必要になる
  （Bedrockのコンソールのモデルカタログから行う）。参照実装は日本国内の推論プロファイル（東京・大阪）で呼ぶので、
  ap-northeast-1にデプロイする。

## 始め方

```sh
export AWS_REGION=ap-northeast-1
npm install
npm test                          # 共通部品の単体テスト
npm run deploy                    # スタック Gekko08App をデプロイする（5分ほど）
npm run test:scenario             # デプロイしたスタックに対するシナリオテスト（2〜3分）
npm run test:scenario:cloudtrail  # CloudTrailでの追跡も確かめる（最大15分ほどかかる）
```

## デモ

### ユーザーを用意する

デモのユーザーは、yamada（`branch`＝tokyo）とtanaka（`branch`＝osaka）の2人。次のコマンドで作り、パスワードを設定する。
パスワードは12文字以上で、大文字・小文字・数字・記号を含める。

```sh
POOL=$(aws cloudformation describe-stacks --stack-name Gekko08App --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
for u in yamada:tokyo tanaka:osaka; do
  aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "${u%%:*}" --message-action SUPPRESS \
    --user-attributes Name=custom:branch,Value="${u##*:}"
done
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username yamada --password '<パスワード>' --permanent
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username tanaka --password '<パスワード>' --permanent
```

シナリオテストも同じユーザーを使い、実行のたびにパスワードをランダムな値に置き換える。テストを流したあとは、パスワードを設定し直す。

### 試す

スタックの出力`WebUrl`をブラウザで開き、ログインする。

| 操作 | yamada（tokyo）の結果 | tanaka（osaka）の結果 |
|---|---|---|
| 案件`C-1001`（tokyo）の要約を開く | 200。案件と口座A-101が返る | 403。case-serviceが拒否する |
| 案件`C-2001`（osaka）の要約を開く | 403 | 200 |
| 案件`C-1001`をエージェントに分析させる | 200。下を参照 | 案件の取得がcase-serviceに拒否され、分析できない |

案件`C-1001`の取引メモには、他の支店の口座A-999を参照させるプロンプトインジェクションが入っている。yamadaがエージェントに分析させると、
応答の`toolCalls`で次のことがわかる（モデルの判断は毎回変わるので、誘導されないこともある）。

```json
"toolCalls": [
  { "name": "get_case", "input": { "caseId": "C-1001" }, "status": 200 },
  { "name": "get_account", "input": { "accountId": "A-101" }, "status": 200 },
  { "name": "get_account", "input": { "accountId": "A-999" }, "status": 403 }
]
```

エージェントは誘導されてA-999を要求したが、account-serviceが、JWTで届いたyamadaの`branch`（tokyo）とA-999の`branch`（osaka）を比べて拒否した。
エージェントの判断は揺らいでも、ユーザーの権限の境界は揺らがない。

各ホップのCloudWatch Logsには、同じ`requestId`で、ユーザー（`subject`）、呼び出し元の実行role（`actor`）、処理時間が出る。

## 片付け

```sh
npm run destroy
```

IAMのアウトバウンドIDフェデレーションはアカウント全体の設定なので、スタックを消しても無効にならない。不要なら
`aws iam disable-outbound-web-identity-federation`で無効にする。
