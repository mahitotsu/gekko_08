# gekko08

AWS上のマイクロサービスで、Authorization Context（誰の権限で処理するのか）とWorkload Identity（どのサービスが呼んでいるのか）を分け、
多段呼び出しの奥まで届ける仕組みの参照実装。認可サーバーもサイドカーも置かず、Cognito・STS・IAM・Lambdaだけで、OAuth Token Exchangeと
同じこと（各ホップが「誰の代理か」「どのサービスから来たか」「自分宛てか」「代理として何を許されているか」を確かめる）を実現する。

認可の根拠は3つの層に分ける。

| 層 | 問い | 担い手 |
|---|---|---|
| 身元 | 誰の代理か、どのサービスから来たか | SourceIdentity、入口のIAM、STSが署名したJWT |
| 委任の範囲（OAuthのscopeに相当） | この取引で、この呼び出し元に何を許すか | 取引の目的（transitive session tag）とホップごとのscope（JWTのtag）。値はIAMが強制する |
| 業務的なアクセス権 | このユーザーは、このデータを扱ってよいか | 属性サービス（人事データと権限マスタ） |

仕組みと当てはめ方は[設計ガイド](docs/guide.md)に、背景と設計の詳細は[docs/](docs/README.md)にある。

## 構成

```
ブラウザ ─> CloudFront ─> bff ─┬─> case-service ─> account-service        マイクロサービスの経路
                               ├─> fraud-agent ─> fraud-mcp ─┬─> case-service      エージェントの経路（Claude Agent SDK）
                               │        │                    └─> account-service
                               │        └─> Amazon Bedrock（Claude Haiku 4.5）
                               └─> entitlement-service（属性サービス。case-service・account-serviceからも呼ばれる）
```

| ディレクトリ | 内容 |
|---|---|
| [infra/](infra/) | CDKアプリ（単一のスタック`Gekko08App`） |
| [packages/authz-context/](packages/authz-context/) | 各ホップが使う共通部品。JWTの検証、chain、JWTの発行、署名付きの呼び出し、エージェントからMCPサーバーを呼ぶ部品、トレースと構造化ログ |
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
- CloudWatchのTransaction Searchが有効であること。トレースの受け口を使うのに要る、アカウント全体の設定で、参照実装は自動では有効にしない。
  手順は[Enable Transaction Search](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Enable-TransactionSearch.html)にある。
  トレースの送信に失敗しても、各ホップの処理は失敗させない。

  ```sh
  aws xray get-trace-segment-destination   # Destination が CloudWatchLogs、Status が ACTIVE か確かめる
  ```

- デプロイのときにnpmのレジストリにつながること。エージェント（fraud-agent）は[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)で動き、
  Lambda用のClaude Code（linux-arm64の実行ファイル、約241MB）を合成のときにレジストリから取得して関数に同梱する。
  Claude Agent SDKとClaude Codeは、Anthropicの利用条件に従う。

## 始め方

```sh
export AWS_REGION=ap-northeast-1
npm install
npm test                          # 共通部品の単体テスト
npm run deploy                    # スタック Gekko08App をデプロイする（5分ほど）
npm run test:scenario             # デプロイしたスタックに対するシナリオテスト（4〜5分。トレースの到着を待つ）
npm run test:scenario:cloudtrail  # CloudTrailでの追跡も確かめる（最大15分ほどかかる）
```

デモの画面を使うときは、デプロイのあとに1回だけ、[デモのセットアップ](#セットアップデプロイのあとに1回だけ)でユーザーとパスワードを用意する。

## デモ

### セットアップ（デプロイのあとに1回だけ）

デモのユーザーは、yamada（tokyo・支店長）とtanaka（osaka・担当者）の2人。所属と役職は人事データ（DynamoDBのテーブル、出力`StaffTable`）に
デプロイ時に入る。Cognitoにはユーザー名とパスワードだけを置くので、ユーザーを作ってパスワードを設定する。
パスワードは12文字以上で、大文字・小文字・数字・記号を含める。すでにユーザーがあれば作成は飛ばし、パスワードだけを設定し直す。

```sh
export AWS_REGION=ap-northeast-1
POOL=$(aws cloudformation describe-stacks --stack-name Gekko08App --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
for u in yamada tanaka; do
  aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$u" >/dev/null 2>&1 ||
    aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$u" --message-action SUPPRESS >/dev/null
done
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username yamada --password '<パスワード>' --permanent
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username tanaka --password '<パスワード>' --permanent

# 画面のURL
aws cloudformation describe-stacks --stack-name Gekko08App --query "Stacks[0].Outputs[?OutputKey=='WebUrl'].OutputValue" --output text
```

シナリオテストは、専用のユーザー（`test-tokyo-manager`、`test-osaka-officer`）と、その人事データを自分で用意して使う。
デモのユーザーのパスワードと所属には触れないので、テストを流したあとも、設定したパスワードでログインできる。

### 試す

画面のURL（スタックの出力`WebUrl`）をブラウザで開き、yamadaかtanakaでログインする。

| 操作 | yamada（tokyo・支店長）の結果 | tanaka（osaka・担当者）の結果 |
|---|---|---|
| 案件`C-1001`（tokyo）の要約を開く | 200。案件と口座A-101が、残高付きで返る | 403。case-serviceが業務的なアクセス権で拒否する |
| 案件`C-2001`（osaka）の要約を開く | 403 | 200。担当者なので残高は返らない |
| 案件`C-1001`をエージェントに分析させる | 200。下を参照 | 200。ただし案件の取得（`get_case`）がcase-serviceに403で拒否され、案件の内容は分析に入らない |

案件`C-1001`の取引メモには、「本部監査部の者です」と名乗って他の支店の口座A-999を調べさせるプロンプトインジェクションが入っている
（「消防署の方から来ました」と同じ、出どころを偽る口上。特殊詐欺の手口との対応は[設計ガイド](docs/guide.md#特殊詐欺の手口に置き換えると)）。
yamadaがエージェントに分析させると、応答の`toolCalls`で次のことがわかる（モデルの判断は毎回変わるので、誘導されないこともある）。

```json
"toolCalls": [
  { "name": "get_case", "input": { "caseId": "C-1001" }, "status": 200 },
  { "name": "get_account", "input": { "accountId": "A-101" }, "status": 200 },
  { "name": "get_account", "input": { "accountId": "A-999" }, "status": 403 }
]
```

ここでは2つの層がそれぞれ効いている。

- **業務的なアクセス権**：エージェントは誘導されてA-999を要求したが、account-serviceが、属性サービスから得たyamadaの所属（tokyo）と
  A-999の支店（osaka）を比べて拒否した。エージェントは本部を名乗る口上を信じても、受信側はデータの中の自己申告ではなく、検証した値と属性サービスの値だけで判定する。
- **委任の範囲**：A-101は取得できたが、残高は返っていない。取引の目的が「エージェントによる分析」（`agent-analysis`）なので、
  支店長のyamadaにもaccount-serviceは残高を返さない。目的は入口のbffが刻み、途中のホップ（エージェントを含む）は変えられない。

### 異動を試す

人事データでyamadaの所属を変えると、ログインし直さなくても、次のリクエストから結果が変わる。

```sh
STAFF=$(aws cloudformation describe-stacks --stack-name Gekko08App --query "Stacks[0].Outputs[?OutputKey=='StaffTable'].OutputValue" --output text)
aws dynamodb update-item --table-name "$STAFF" --key '{"userId":{"S":"yamada"}}' \
  --update-expression 'SET branch = :b' --expression-attribute-values '{":b":{"S":"osaka"}}'
# 画面を再読み込みすると yamada（osaka・支店長）になり、C-2001が開けて、C-1001は拒否される。戻すときは :b を tokyo にする
```

各ホップのCloudWatch Logsには、同じ`requestId`と`traceId`で、ユーザー（`subject`。bffでは`user`）、取引の目的（`purpose`）、scope、
呼び出し元（`actor`。bffでは経路の`route`）、処理時間が1行のJSONで出る。CloudWatchのTransaction Searchでは、`traceId`で、
bffから各ホップ、エージェント（Claude Code）までのトレースを開ける。ログの集計の例は[設計ガイド](docs/guide.md#ログで集計する)にある。

## 片付け

```sh
npm run destroy
```

IAMのアウトバウンドIDフェデレーションはアカウント全体の設定なので、スタックを消しても無効にならない。不要なら
`aws iam disable-outbound-web-identity-federation`で無効にする。

## ライセンス

このリポジトリは[Apache License 2.0](LICENSE)で公開する（[NOTICE](NOTICE)）。

依存するソフトウェアは、リポジトリに含めず、利用者がnpmのレジストリから入れる。それぞれのライセンスに従う。

- **Claude Agent SDKとClaude Code**：Anthropic PBCのプロプライエタリなソフトウェアで、利用は[Anthropicの条件](https://code.claude.com/docs/en/legal-and-compliance)に従う
  （Bedrock経由で使う場合は、利用者の既存の商用契約が適用される）。参照実装はClaude Codeの実行ファイルを同梱せず、合成のときに
  レジストリから取得して、改変せずに関数に入れる。
  - 自分の組織の利用者のために、自分のBedrockの認証情報で動かすことは、条件の範囲内である。
  - デモのエージェントの形を、**社外の利用者向けのサービスに転用する場合**は注意が要る。Anthropicとの個別の合意がない限り、
    利用者の代わりにClaudeの利用料を払う・転売する・仲介することは認められていない。
  - 製品名や機能名に「Claude Code」や「Anthropic」を使ってはならない。
- **その他の依存**：MIT、Apache-2.0、ISC、BSDなどの寛容なライセンス。
