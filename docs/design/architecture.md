# 設計書：参照実装の構成

参照実装の現在の構成を示す。判断の経緯と採用しなかった選択肢はADRに、満たすべきことは[要件定義](../requirements.md)にある。
実装やテストで問題が見つかったときの扱いは、[文書一覧の運用ルール](../README.md#運用ルール)に従う。

関連するADR：

- [多段伝播](../adr/20260930064314-multi-hop-authorization-context-propagation.md)：actorは実行role、subjectはSTSが署名したJWT
- [委任の範囲と業務的なアクセス権](../adr/20260930150529-delegation-scope-and-entitlements.md)：取引の目的とscopeはSTSとIAMが強制し、業務的なアクセス権は属性サービスから得る
- [委任の範囲の定義](../adr/20261001130745-delegation-definitions.md)：目的の一覧・提供側・利用側の定義を突き合わせる。目的は影響の大きいscopeの発行を限るためだけに使う
- [デモは口座の凍結解除](../adr/20261001123029-demo-account-unfreeze.md)
- [デモの画面はReactの静的なSPA](../adr/20261002065842-demo-ui-react-static.md)
- [監査サービス](../adr/20261002074437-audit-service.md)：各ホップのログとCloudTrailを、JWTの`jti`で突き合わせる
- [入口はBFF](../adr/20260930083437-entry-via-bff.md)
- [IdPはCognito User Pool](../adr/20260930091026-idp-cognito-user-pool.md)
- [ホップはLambdaとFunction URL、mTLSは使わない](../adr/20260930091257-lambda-function-url-without-mtls.md)
- [BFFの公開とセッション](../adr/20260930093744-bff-hosting-and-session.md)
- [実装言語はTypeScript](../adr/20260930093745-implementation-language-typescript.md)
- [エージェントとMCPサーバーもLambdaのホップ](../adr/20260930093746-agent-and-mcp-on-lambda.md)
- [エージェントはClaude Agent SDK、MCPは関数の中の中継から](../adr/20261001040729-fraud-agent-on-claude-agent-sdk.md)
- [トレースの収集先はCloudWatch、メトリクスは出さない](../adr/20261001020115-telemetry-destination-cloudwatch.md)
- [トレースは関数の中のSDKが署名して直接送る](../adr/20261001053646-telemetry-direct-export.md)

## 1. 要件との対応

| 要件 | 満たす設計要素 |
|---|---|
| FR-1（subject・actor・aud・委任の範囲を確かめる） | 入口のresource policy（実行roleと関数）、JWTの検証。委任の範囲はJWTの`purpose`と`scope`（§4、§6） |
| FR-2（委任の範囲と業務的なアクセス権の両方で判定） | 受信側の共通部品が委任の範囲（scope）を渡し、業務のコードが属性サービスのアクセス権と合わせて判定する。目的とscopeの組み合わせはIAMと共通部品が守り、業務のコードは目的を使わない。ヘッダーや引数、LLMの出力からユーザーを読まない（§4、§6） |
| FR-3（ユーザーと目的は入口で確定し、変更も拡大もできない） | SourceIdentityとtransitive session tagの`purpose`。刻める目的、付けられるscope、影響の大きいscopeを発行できる目的はIAMで限る。業務的なアクセス権は属性サービスが持つ（§3、§4、§5、§6） |
| FR-4（ホップを飛ばせない） | 入口は直前のホップの実行roleだけを許可（§4、§5） |
| FR-5（パブリッククライアントに認証情報を持たせない） | BFFとセッションcookie（§3） |
| FR-6（処理を元のユーザーとリクエストに結びつけて追跡） | リクエストIDの引き継ぎ（transitive session tag `requestId`と、それに縛った`RoleSessionName`）、構造化ログ、トレース（§7） |
| FR-7（デモ） | 口座の凍結解除のシナリオと、取引の監査（§8） |
| FR-8（業務的なアクセス権の変更が次のリクエストから反映） | 属性サービスが判定のたびに人事データと権限マスタを読む（§6） |
| NFR-1・NFR-2（サーバーレス、常駐コンポーネントなし） | Lambda、DynamoDB、Cognito、CloudFront、S3、SSM Parameter Store、Amazon Bedrock、CloudWatch（Logs、Transaction Search）だけで構成（§2、§7） |
| NFR-3（レイテンシの実測と公開） | 各ホップの処理時間のログと、シナリオテストでの集計（§10） |
| NFR-4（`cdk deploy`で再現） | 単一のCDKスタックと、デプロイ時の前提条件の確認（§9、§11） |
| SR-1（受け渡す認証情報が漏れても呼べない） | chain用roleは次のchainとJWTの発行だけ。入口は実行roleだけを許可（§4、§5） |
| SR-2（他の主体が許可されていないホップを呼べない） | 入口のresource policyのDeny（§5） |
| SR-3（認証情報をログ・トレース・LLMに入れない） | 共通部品が認証情報をヘッダーだけで扱い、ログにもスパンにも出さない。エージェントの子プロセスには、委任に使う認証情報を渡さない（渡すのはモデルの呼び出しだけを許すroleの認証情報だけ。§6、§7、§8） |

## 2. 全体構成

```
ブラウザ ──HTTPS──> CloudFront ──(既定)──────────> S3（静的なフロントエンド）
                        │
                        └──(/api/*、OAC)──> bff ──┬──> case-service ──> account-service
                                                  │          ↑               ↑
                                                  ├──> fraud-agent ──> fraud-mcp
                                                  │          │
                                                  │          └──> Amazon Bedrock（Claude Haiku 4.5。Claude Codeの子プロセスが呼ぶ）
                                                  │
                                                  ├──> audit-service ──> CloudWatch Logs（各ホップのログ）、CloudTrail（STSのイベント）
                                                  │
                                                  └──> entitlement-service  <── case-service、account-service、audit-service
```

| 構成要素 | 役割 | 呼び出し元 | 呼び出し先 |
|---|---|---|---|
| bff | ログイン、セッション、取引の目的の決定、最初のホップ | ブラウザ（CloudFront経由） | case-service、fraud-agent、audit-service、entitlement-service |
| case-service | 凍結の見直しの案件と取引の参照、凍結の解除の依頼 | bff、fraud-mcp | account-service、entitlement-service |
| account-service | 口座の参照と凍結の解除 | case-service、fraud-mcp | entitlement-service |
| fraud-agent | 案件を分析し、凍結を解除してよいかを提案するAIエージェント。Claude Agent SDKがClaude Codeを子プロセスとして動かし、MCPは関数の中の中継から呼ぶ（§8） | bff | fraud-mcp、Bedrock |
| fraud-mcp | エージェント向けのツールを提供するMCPサーバー | fraud-agent | case-service、account-service |
| audit-service | 監査サービス。1回の取引について、各ホップのログとCloudTrailの記録を突き合わせる（§8） | bff | entitlement-service、CloudWatch Logs、CloudTrail |
| entitlement-service | 属性サービス。ユーザー本人の業務的なアクセス権を返す（終端） | bff、case-service、account-service、audit-service | なし |

呼び出しの経路は3つある。

- **マイクロサービスの経路**：bff → case-service → account-service。案件を開く取引と、凍結を解除する取引が同じホップを通る
- **エージェントの経路**：bff → fraud-agent → fraud-mcp → case-service または account-service
- **監査の経路**：bff → audit-service（→ entitlement-service）

データはDynamoDBに置き、各サービスが自分の実行roleで扱う（案件はcase-service、口座はaccount-service、人事データと権限マスタは
entitlement-service）。デモのデータに書き込むのは、account-serviceによる口座の凍結の解除だけで、ほかは読むだけである。
audit-serviceはデータを持たず、各ホップのロググループとCloudTrailのイベント履歴を読む。

## 3. ログインとセッション（bff）

### ログイン

1. ブラウザが`GET /api/login`を呼ぶ。bffは`state`とPKCEの`code_verifier`を作ってDynamoDBに保存し、`state`を結ぶcookie
   （`HttpOnly`・`Secure`・`SameSite=Lax`、短命）を付けて、Cognitoのマネージドログインへリダイレクトする。
2. Cognitoから`GET /api/callback`に戻る。bffは`state`をcookieと照合し、アプリクライアントのシークレット（SSM Parameter Store）を使って
   トークンエンドポイントでIDトークンとリフレッシュトークンを受け取る。
3. bffはセッションをDynamoDBに保存し、セッションID（256ビットの乱数）だけを入れたcookie（`HttpOnly`・`Secure`・`SameSite=Strict`）を返す。
   テーブルのキーはセッションIDのSHA-256にし、テーブルを読めてもcookieとして使える値が得られないようにする。
   cookieの名前には`__Host-`を付ける（`__Host-sid`、`__Host-login`）。
   セッションには、ログインのセッションの識別子（`ref`。セッションIDとは別の96ビットの乱数で、cookieとしては使えない）とログインの時刻も保存する。
   bffは、最初のホップを呼ぶたびに、この2つと案件ID（経路のパスから得たもの）をログに書く。監査で、ログインのセッションごとに操作をまとめるのに使う。

ログアウト（`POST /api/logout`）では、bffがセッションを消し、リフレッシュトークンを取り消し、セッションのcookieを消す。あわせて、Cognitoのログアウトの
URL（`/logout`、`client_id`と`logout_uri`＝画面のURL）を返し、画面はブラウザをそこへ送る。マネージドログインのログインの状態（Cognitoのcookie）を消さないと、
次のログインでユーザー名とパスワードを聞かれず、同じユーザーでログインしてしまうため。

bffの設定（アプリクライアントのID、マネージドログインのドメイン、コールバックURL、ログアウトの戻り先、federated roleと目的用のroleのARN、呼び出し先）は、
SSM Parameter StoreのStringパラメータに置き、実行時に読む。環境変数にすると、bff→CloudFront→Cognitoのアプリクライアント
（コールバックURL）→federated role→目的用のrole→case-serviceのchain用role→case-service→bffという循環参照になるため。
アプリクライアントのシークレットは、デプロイ時にカスタムリソースがSecureStringとして書く（CloudFormationはSecureStringを作れない）。

IDトークンには、Pre Token Generation V2トリガーが`https://aws.amazon.com/source_identity`（ユーザー識別子）だけを入れる。
業務属性はトークンに入れない（§6の属性サービスが持つ）。

### リクエストごとの処理

1. cookieのセッションIDでセッションを読む。IDトークンの期限の60秒前を過ぎていれば、リフレッシュトークンで更新する。更新に失敗したら、セッションを消す。
2. リクエストIDを発行する（§7）。
3. IDトークンで`AssumeRoleWithWebIdentity`を呼び、federated roleのセッションを得る（`RoleSessionName`＝リクエストID）。
   このセッションにSourceIdentityが刻まれる。
4. 経路から取引の目的を決め、federated roleのセッションから目的用のroleへchainして、`purpose`と`requestId`をtransitive session tagとして刻む
   （`RoleSessionName`＝リクエストID）。
5. 目的用のroleのセッションで、共通部品を使って最初のホップを呼ぶ（§4）。

### エンドポイントと取引の目的

| パス | 取引の目的（`purpose`） | 呼ぶホップ |
|---|---|---|
| `GET /api/login`、`GET /api/callback`、`POST /api/logout` | なし | なし |
| `GET /api/me` | `profile` | entitlement-service（scope＝`entitlements:read`。ユーザー名と、所属・役職を表示用に返す。認証情報は含めない） |
| `GET /api/cases/{id}/summary` | `case-summary` | case-service（scope＝`case:summary`） |
| `POST /api/cases/{id}/unfreeze` | `account-unfreeze` | case-service（scope＝`case:unfreeze`） |
| `POST /api/agent` | `agent-analysis` | fraud-agent（scope＝`agent:analyze`） |
| `GET /api/audit/requests` | `audit` | audit-service（scope＝`audit:read`。最近の取引の一覧） |
| `GET /api/audit/requests/{リクエストID}` | `audit` | audit-service（scope＝`audit:read`。1回の取引の突き合わせ） |

目的はbffが経路ごとに決める。bffは取引の入口として、Transaction Tokensの発行サービスに当たる役割を持つ。目的の一覧はbffの定義に置き（§4）、刻める目的の値はIAMで限る（§5）。
目的は、取引の種類として少数に保つ。画面を増やしても、既存の目的で足りるなら目的を増やさない。

フロントエンドは、POSTの本文のSHA-256を`x-amz-content-sha256`ヘッダーに付ける（CloudFrontのOACの要件）。

最初のホップを呼ぶ経路（`/api/me`を除く）の応答は、ホップの応答の本文に、bffが付けた`requestId`と`purpose`（刻んだ取引の目的）を加えたものである。
ホップの本文に同じ名前の項目があっても、bffの値で上書きする（ホップに、画面に出る目的やリクエストIDを偽らせない）。
`purpose`は画面に見せるためのもので、ブラウザから目的は受け取らない。fraud-agentの応答の`toolCalls`は、各要素に`name`、`input`、`status`と、
拒否されたときは呼び出し先のホップが返した`reason`を持つ。

画面（`web/`）は、ReactとViteで作る静的なSPAである（[画面のADR](../adr/20261002065842-demo-ui-react-static.md)）。操作ごとに、取引の目的、リクエストID、結果、
拒否したときはその層を表示する。理由から層への対応（`scope does not allow the action`は委任の範囲、`no entitlement`と`branch mismatch`は業務的なアクセス権）は
表示にだけ使い、画面はユーザーに応じて操作を隠さない。

## 4. ホップ間の呼び出し

呼び出し元は、1回の呼び出しで次のものを送る。

| 送るもの | 載せ方 | 受信側での使い道 |
|---|---|---|
| SigV4署名 | 呼び出し元の**実行role**で署名 | 入口のIAMが呼び出し元（actor）を確かめる |
| JWT | `x-authz-context`ヘッダー。`aud`は`<スタック名>:<ホップ名>` | アプリがsubject（誰の代理か）、aud（自分宛てか）、委任の範囲（`principal_tags`の`purpose`と`request_tags`の`scope`）を確かめる |
| chainのセッション | `x-authz-session`ヘッダー（呼び出し先がchain用roleを持つ場合だけ）。認証情報のJSONをbase64urlにしたもの | 受信側が次のホップ宛てのJWTを作るために、自分のchain用roleへchainする |
| リクエストID | `x-request-id`ヘッダー | 追跡（§7） |

呼び出し元での手順：

1. 受け取ったchainのセッションで、自分のchain用roleにchainする（`DurationSeconds`＝900、`RoleSessionName`＝リクエストID）。
   bffは目的用のroleのセッションをそのまま使う。
2. そのセッションで`GetWebIdentityToken`を呼び、`aud`＝呼び出し先、`Tags`＝`scope`（業務のコードが呼び出しごとに指定した値。利用側の定義で
   その呼び出し先に1つしか求めていなければ省略できる）のJWTを作る
   （`DurationSeconds`＝300、`SigningAlgorithm`＝`ES384`）。
3. 自分の実行roleの認証情報で署名して、呼び出し先のFunction URLを呼ぶ。

受信側での手順は§6の共通部品が行う。

### 委任の範囲

委任の範囲は、3つの定義に分けて書き、合成のときに突き合わせる（[委任の範囲の定義のADR](../adr/20261001130745-delegation-definitions.md)）。

| 定義 | 置き場所 | 書くこと |
|---|---|---|
| 目的の一覧 | `services/bff/authz.ts` | 取引の目的 |
| 提供側の定義 | `services/<名前>/authz.ts`の`provides` | 提供するscope。影響の大きい操作のscopeには、使ってよい目的（`purposes`）と、必要なら使ってよい呼び出し元（`callers`）。以下、これを「目的の制限があるscope」と呼ぶ |
| 利用側の定義 | `services/<名前>/authz.ts`の`consumes` | 呼び出し先ごとに、付けたいscopeの一覧 |

| 提供側 | scope | 目的と呼び出し元の制限 | 利用側 |
|---|---|---|---|
| case-service | `case:summary` | なし | bff |
| case-service | `case:read` | なし | fraud-mcp |
| case-service | `case:unfreeze` | 目的＝`account-unfreeze` | bff |
| account-service | `account:read` | なし | case-service、fraud-mcp |
| account-service | `account:unfreeze` | 目的＝`account-unfreeze`、呼び出し元＝case-service | case-service |
| fraud-agent | `agent:analyze` | なし | bff |
| fraud-mcp | `mcp:tools` | なし | fraud-agent |
| audit-service | `audit:read` | なし | bff |
| entitlement-service | `entitlements:read` | なし | bff、case-service、account-service、audit-service |

- **突き合わせ**：合成のときに、利用側が求めるscopeが提供側にあること、目的や呼び出し元の制限があるscopeでは利用側が許された呼び出し元であること、
  提供側が名指しする目的が目的の一覧にあること、どのホップにも利用側があることを確かめる。整合しなければ合成を失敗させる。
- **生成するもの**：利用側のchain用roleのJWTの発行の権限（§5）、呼び出し先の入口のresource policyと`sub`の対応表、利用側の呼び出し先の設定
  （URL、aud、付けられるscope）、提供側の受信時の照合の設定（§6）、目的用のroleの信頼ポリシー（刻める目的）。
- **目的が効く場所**：目的の制限があるscopeは、許した目的の取引でだけIAMが発行させる。たとえば、案件を開く取引（`case-summary`）のcase-serviceは、
  account-service宛てに`account:unfreeze`のJWTを発行できない。エージェントの取引（`agent-analysis`）で、fraud-mcpから呼ばれたcase-serviceも同じである。
  scopeと呼び出し元が効くのは1ホップ分だけなので、複数の経路が共有するホップ（case-service）が侵害されたときに、経路をまたいで影響の大きい操作を
  持ち出させないのは目的である。
- **目的の制限がないscope**は、どの取引でも、許された組なら発行される。
- **業務のコードは目的を使わない**。目的で振る舞いを変えたいときは、scopeを分けて、提供側の定義で目的を限る。

### chain用role

| role | 使うホップ | chainを許す相手 |
|---|---|---|
| bffのfederated role | bff | Cognito（OIDC provider） |
| 目的用のrole | bff | federated role |
| fraud-agentのchain用role | fraud-agent | 目的用のrole |
| fraud-mcpのchain用role | fraud-mcp | fraud-agentのchain用role |
| case-serviceのchain用role | case-service | 目的用のrole、fraud-mcpのchain用role |
| account-serviceのchain用role | account-service | case-serviceのchain用role、fraud-mcpのchain用role |

entitlement-serviceは呼び出し先を持たないので、chain用roleを持たず、chainのセッションも受け取らない。

## 5. IAMの設計

### roleの一覧

| 種類 | 個数 | 権限 |
|---|---|---|
| 実行role | Lambda関数ごとに1つ | 自分のデータ（DynamoDB）へのアクセス、ログ出力、トレースの送信（`xray:PutTraceSegments`。§7）。fraud-agentはモデル用のroleの引き受け、bffはセッションのテーブルとSSMのパラメータ、audit-serviceは`cloudtrail:LookupEvents`と、各ホップのロググループに限った`logs:StartQuery`（と`logs:GetQueryResults`・`logs:StopQuery`）。ホップの呼び出しの許可は付けない（呼び出し先のresource policyで許可する）。呼び出し先ごとに、自分の関数以外からの呼び出しをDenyする文を持つ（下の入口のresource policyのひな形の後ろ） |
| モデル用のrole | 1つ（fraud-agent） | Bedrockのモデルの呼び出し（`bedrock:InvokeModel`・`bedrock:InvokeModelWithResponseStream`）だけ。fraud-agentの実行roleが引き受け、その認証情報だけをClaude Codeの子プロセスに渡す |
| federated role | 1つ | 目的用のroleへの`sts:AssumeRole`・`sts:TagSession`・`sts:SetSourceIdentity`だけ |
| 目的用のrole | 1つ | bffの呼び出し先のchain用roleへのchainと、JWTの発行（§4の定義のとおり） |
| chain用role | §4の表のとおり | 次のchain用roleへの`sts:AssumeRole`・`sts:TagSession`・`sts:SetSourceIdentity`と、JWTの発行（§4の定義のとおり） |

JWTの発行の権限（利用側のchain用roleに、呼び出し先ごとに、JWTの発行の文が1つと、scopeを付ける許可の文。後者は、目的の制限がないscopeをまとめた1つと、目的の制限があるscopeごとに1つ）：

```json
[
  {
    "Effect": "Allow", "Action": "sts:GetWebIdentityToken", "Resource": "*",
    "Condition": {
      "ForAllValues:StringEquals": { "sts:IdentityTokenAudience": ["<呼び出し先のaud>"] },
      "Null": { "sts:IdentityTokenAudience": "false" },
      "StringEquals": { "sts:SigningAlgorithm": "ES384" },
      "NumericLessThanEquals": { "sts:DurationSeconds": 300 }
    }
  },
  {
    "Effect": "Allow", "Action": "sts:TagGetWebIdentityToken", "Resource": "*",
    "Condition": {
      "ForAllValues:StringEquals": { "sts:IdentityTokenAudience": ["<呼び出し先のaud>"], "aws:TagKeys": ["scope"] },
      "Null": { "sts:IdentityTokenAudience": "false" },
      "StringEquals": { "aws:RequestTag/scope": ["<目的の制限がないscope>"] }
    }
  },
  {
    "Effect": "Allow", "Action": "sts:TagGetWebIdentityToken", "Resource": "*",
    "Condition": {
      "ForAllValues:StringEquals": { "sts:IdentityTokenAudience": ["<呼び出し先のaud>"], "aws:TagKeys": ["scope"] },
      "Null": { "sts:IdentityTokenAudience": "false" },
      "StringEquals": { "aws:RequestTag/scope": "<目的の制限があるscope>", "aws:PrincipalTag/purpose": ["<そのscopeを許した目的>"] }
    }
  }
]
```

2つ目の文は、目的の制限がないscopeを利用側が求めたときだけ、3つ目の文は目的の制限があるscopeごとに作る。目的の制限があるscopeを、
2つ目の文に含めない。`sts:TagGetWebIdentityToken`の許可で`aws:PrincipalTag/purpose`が効くことは、[検証](../../experiments/scope-tags/RESULTS.md)のE4で確かめた。

宛先は`ForAllValues`＋`Null`で絞る。`ForAnyValue`では、許した宛先に外部の宛先を混ぜたJWTを発行できる
（[検証](../../experiments/scope-tags/RESULTS.md)のE1-7）。

### 信頼ポリシー

chain用roleは、呼び出し元のchain用role（bffの呼び出し先では目的用のrole）を信頼する。セッション名は、刻まれたリクエストIDに限る。新しいtagのキーは加えられない
（[リクエストIDのtagのADR](../adr/20261002154129-request-id-transitive-tag.md)）。

```json
{
  "Statement": [
    {
      "Effect": "Allow", "Principal": { "AWS": ["<呼び出し元のchain用role>"] }, "Action": "sts:AssumeRole",
      "Condition": { "StringEquals": { "sts:RoleSessionName": "${aws:PrincipalTag/requestId}" } }
    },
    { "Effect": "Allow", "Principal": { "AWS": ["<呼び出し元のchain用role>"] }, "Action": "sts:SetSourceIdentity" },
    {
      "Effect": "Allow", "Principal": { "AWS": ["<呼び出し元のchain用role>"] }, "Action": "sts:TagSession",
      "Condition": { "ForAllValues:StringEquals": { "aws:TagKeys": ["purpose", "requestId"] } }
    }
  ]
}
```

目的用のroleは、federated roleを信頼し、`sts:TagSession`をキー`purpose`と`requestId`だけ、`purpose`の値を目的の一覧（`profile`・`case-summary`・`account-unfreeze`・`agent-analysis`・`audit`）だけに限る。
`sts:AssumeRole`は、`RoleSessionName`が刻む`requestId`のtagと同じ値（`"sts:RoleSessionName": "${aws:RequestTag/requestId}"`）のときだけ許す。
federated roleは、Cognitoを指すOIDC providerをPrincipalとし、`aud`＝アプリクライアントのIDで絞る。IDトークンにtagがないので`sts:TagSession`は許さない。

### 入口のresource policyのひな形（bff以外のホップ）

```json
{
  "Statement": [
    {
      "Sid": "DenyOtherPrincipals", "Effect": "Deny", "Principal": "*",
      "Action": ["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"], "Resource": "<この関数>",
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": ["<呼び出し元の実行role>"] } }
    },
    {
      "Sid": "AllowUrl", "Effect": "Allow", "Principal": { "AWS": ["<呼び出し元の実行role>"] },
      "Action": "lambda:InvokeFunctionUrl", "Resource": "<この関数>",
      "Condition": { "StringEquals": { "lambda:FunctionUrlAuthType": "AWS_IAM" } }
    },
    {
      "Sid": "AllowInvoke", "Effect": "Allow", "Principal": { "AWS": ["<呼び出し元の実行role>"] },
      "Action": "lambda:InvokeFunction", "Resource": "<この関数>",
      "Condition": { "Bool": { "lambda:InvokedViaFunctionUrl": "true" } }
    }
  ]
}
```

実行roleは関数ごとに分けるので、「実行role」と「関数」は1対1に対応する。

同じ実行roleを持つ別の関数からの呼び出しは、呼び出し元の実行roleに付けるDenyで塞ぐ（[置き場所のADR](../adr/20261001094443-source-function-arn-in-caller-identity-policy.md)）。
`lambda:SourceFunctionArn`は、resource-based policyでは使えないため。`Hop#allowCaller`が、呼び出し先ごとに次の文を、呼び出し元の実行roleに
別のポリシーとして付ける。

```json
{
  "Effect": "Deny",
  "Action": ["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"], "Resource": "<呼び出し先の関数>",
  "Condition": { "ArnNotEquals": { "lambda:SourceFunctionArn": ["<呼び出し元の関数>"] } }
}
```

bffの入口は、CloudFrontのサービスプリンシパルを`AWS:SourceArn`＝ディストリビューションで許可する。同じアカウント内の広い権限を持つ主体は
bffのFunction URLを直接呼べうるが、セッションcookieがなければbffが拒否する。

## 6. 受信側の共通部品と判定

### 共通部品（`packages/authz-context`）

各ホップのLambdaは、共通部品を通して呼び出しを受け、次のホップを呼ぶ。業務のコードは認証情報もJWTも直接扱わない。

**受信時**

1. `x-request-id`があり、形式（`^[\w+=,.@-]{2,64}$`。`RoleSessionName`に使えるもの）に合うことを確かめる。合わなければ400を返す。
2. 入口のIAMが確かめた呼び出し元の実行roleが、対応表にあることを確かめる。なければ403を返す。
3. `x-authz-context`のJWTを検証する。署名はES384だけを受け付け、`iss`＝自アカウントのSTS発行者、`aud`＝自分、`exp`・`iat`・`sub`があることを確かめる
   （JWKSはメモリにキャッシュし、10分ごとか、未知の`kid`のときに取り直す。未知の`kid`による取り直しは30秒に1回まで）。
4. `sub`が「入口のIAMが確かめた呼び出し元の実行role」に対応するchain用roleであることを確かめる。対応表（実行role名 → 呼び出し元のホップ名と
   chain用roleのARN）はデプロイ時に環境変数で渡す。
5. `https://sts.amazonaws.com/`名前空間から、subject（`source_identity`）、取引の目的（`principal_tags.purpose`）、scope（`request_tags.scope`）を
   取り出す。どれかが欠けていれば拒否する（scopeのないJWTは何も許さない）。
   bffが刻んだリクエストID（`principal_tags.requestId`）が、ヘッダーのリクエストIDと違うか、欠けていれば401を返す。
   食い違いで拒否したときは、`rejected`のログに、刻まれていた値（`stampedRequestId`）も書く。
6. scopeが提供側の定義にあることを確かめる。目的の制限があるscopeなら、目的と呼び出し元が許されたものであることも確かめる。合わなければ403を返す。
   IAMが発行させない組み合わせなので、通常は起きない。IAMの設定の誤りや手での変更を、提供側の定義で止めるための照合である。
7. subject、呼び出し元のホップ名（actor）、scopeを業務のコードに渡す。目的は渡さない（ログとトレースには出す）。ヘッダーや引数に含まれるユーザー情報は使わない。
8. 3〜5の検証に失敗したら401を返す。業務のコードが例外を投げたら500を返す。

**送信時**：§4の手順を行う。業務のコードは、呼び出しごとに付けるscopeを指定する（呼び出し先に1つしか求めていなければ省略できる）。
業務のコードは追加のヘッダー（MCPの`Accept`など）を渡せるが、認可・追跡・署名に使うヘッダー（`x-authz-context`、`x-authz-session`、`x-request-id`、
`traceparent`、`authorization`など）は、渡しても除く。
利用側の定義にないscopeなら、STSを呼ばずに失敗させる。目的の制限があるscopeを、許されていない目的の取引で付けようとすると、IAMが拒否する。STSクライアントとJWKSはLambdaの実行環境ごとに使い回す。

**MCP**（`@gekko08/authz-context/mcp`）：MCPサーバーのホップを、エージェントのフレームワークから送信時の手順で呼ぶための部品。

- `HopMcpTransport`（直接型）：MCPの`Transport`。MCPクライアントを差し替えられるフレームワークに渡す。1つのメッセージを1回の送信で送る。
- `startMcpRelay`（中継型）：`127.0.0.1`で受けたMCPのメッセージを、送信時の手順でそのまま呼び出し先へ転送する。MCPクライアントを差し替えられず、
  固定のヘッダーしか付けられないフレームワーク（Claude Agent SDK）に使う。認可の判断はせず、MCPのプロトコルも解釈しない
  （`initialize`などにも呼び出し先が応える）。受け取った`traceparent`を転送するときのコンテキストにし、自分のスパンは作らない。
- どちらも、呼び出し先が受け付けたメッセージ（200か202）とその応答を業務のコードに知らせる（fraud-agentはツールの呼び出しの記録に使う）。
  呼び出し先の入口で拒否された（401や403）呼び出しは知らせない。中継は、POST以外には405を、転送に失敗したら502のJSON-RPCのエラーを返す。

**トレース**：受信と送信のスパンを作り、`traceparent`を引き継ぐ。応答を返す前に送り切る（§7）。

**ログ**：1件を1行のJSONで標準出力に書く（Lambdaのログの形式はJSON。`timestamp`と`level`を持つので、レベルで絞り込める）。リクエストID、トレースID、ホップ名、呼び出し元のホップ名（actor）と実行role名、subject、目的、scope、JWTの`sub`と`jti`、判定結果、処理時間を構造化ログに出す。
`jti`は、CloudTrailの`GetWebIdentityToken`のイベントの`webIdentityTokenId`と一致し、監査でAWSの記録と突き合わせるのに使う（[検証](../../experiments/cloudtrail-records/RESULTS.md)）。`jti`は識別子で、それだけではホップを呼べない。
認証情報、JWT、cookieはログに出さない。

### 属性サービス（entitlement-service）

- 人事データ（ユーザーID、所属`branch`、役職`title`）と権限マスタ（役職 → 権限の一覧）を持つ。
- **JWTのsubject本人のアクセス権だけを返す。照会する相手を引数に取らない。** 応答は`{ userId, branch, title, permissions }`。
- 人事データにないユーザーには403を返す。判定のたびに読むので、人事データや権限マスタの変更は次のリクエストから効く（FR-8）。
- 呼び出す側は、属性サービスが使えないときは拒否する（fail closed）。

### 判定（FR-2）

判定は、**委任の範囲（scope）が操作を許し、かつ業務的なアクセス権がデータを許す**ときだけ許す。業務のコードは目的を見ない。

| ホップ | 操作 | scope | 業務的なアクセス権 |
|---|---|---|---|
| case-service | 案件を開く（口座の凍結の状態を含む） | `case:summary` | `case:view`を持ち、案件の`branch`が所属と一致 |
| case-service | 案件の取得（エージェントのツール） | `case:read` | 同上 |
| case-service | 凍結の解除の依頼 | `case:unfreeze` | 同上。解除の可否はaccount-serviceが判定する |
| account-service | 口座の参照 | `account:read` | `account:view`を持ち、口座の`branch`が所属と一致 |
| account-service | 凍結の解除 | `account:unfreeze` | `account:unfreeze`を持ち、口座の`branch`が所属と一致し、口座が凍結中 |
| audit-service | 取引の一覧と突き合わせ | `audit:read` | `audit:view`を持つ（支店を問わない） |
| entitlement-service | アクセス権の参照 | `entitlements:read` | 本人の分だけを返す |

## 7. 追跡（FR-6）

- bffがリクエストごとにIDを発行し、`x-request-id`で全ホップに引き継ぐ。
- 各ホップの構造化ログに、リクエストID、subject、目的を出す（§6）。
- `AssumeRoleWithWebIdentity`と各chainの`RoleSessionName`をリクエストIDにする。CloudTrailの`AssumeRole`・`GetWebIdentityToken`のイベントには、
  セッション名（＝リクエストID）とSourceIdentity（＝ユーザー識別子）が記録される。
- bffはリクエストIDを、取引の目的と同じくtransitive session tag（`requestId`）として刻む。各chain用roleの信頼ポリシーが`RoleSessionName`をこのtagの値に限り、
  受信側がJWTの`principal_tags.requestId`とヘッダーを照合するので、途中のホップはリクエストIDを変えられない（§5、§6）。
- ログとCloudTrailを、リクエストIDとユーザー識別子で突き合わせられる。

### トレース

OpenTelemetryで出し、CloudWatchのTransaction Searchに集める（[収集先のADR](../adr/20261001020115-telemetry-destination-cloudwatch.md)）。
関数の中のSDKが、実行roleで署名してX-RayのOTLPの受け口（`https://xray.<region>.amazonaws.com/v1/traces`）に直接送り、
応答を返す前に送り切る（[送り方のADR](../adr/20261001053646-telemetry-direct-export.md)）。送れなくても、ホップの処理は失敗させない（待つのは2秒まで）。

| スパン | 作る場所 | 種類 | 主な属性 |
|---|---|---|---|
| `bff` | bff | SERVER | `authz.hop`、`authz.route`、`authz.purpose`、`authz.request_id`、`enduser.id`、`http.response.status_code` |
| `assume (sts:AssumeRoleWithWebIdentity)`、`stamp purpose (sts:AssumeRole)` | bff | INTERNAL | — |
| `<ホップ名>` | 共通部品の受信 | SERVER | `authz.hop`、`authz.inbound`（`accepted`／`rejected`）、`authz.reject_reason`、`authz.actor`、`authz.purpose`、`authz.scope`、`enduser.id`、`authz.request_id`、`http.response.status_code` |
| `call <呼び出し先>` | 共通部品の送信 | CLIENT | `authz.target`、`authz.request_id`、`http.response.status_code` |
| `chain (sts:AssumeRole)`、`mint JWT (sts:GetWebIdentityToken)` | 共通部品の送信 | INTERNAL | — |
| `<サービス>.<操作>`（`DynamoDB.GetItem`、`STS.AssumeRole`など） | 共通部品の`traceAwsClient`を付けたAWS SDKのクライアント | CLIENT | `rpc.system`（`aws-api`）、`rpc.service`、`rpc.method`、`aws.dynamodb.table_names`、`aws.request_id`、`http.response.status_code` |
| `claude_code.*`（`interaction`、`llm_request`、`tool`、`tool.execution`など） | fraud-agentのClaude Code（子プロセス） | — | Claude Codeが決める。プロンプトや応答の本文は記録させない |

- **引き継ぎ**：送信のスパンの`traceparent`を、ホップへのリクエストのヘッダーに付ける。受信側はそれを親にする。`traceparent`を受け入れるのは、
  入口のIAMで呼び出し元を確かめたホップの間だけで、bffはブラウザから届いた`traceparent`を使わず、新しいトレースを始める。
- **AWS SDK**：esbuildで1ファイルにまとめた関数では、AWS SDKの自動計装が効かない。共通部品の`traceAwsClient`がクライアントにミドルウェアを
  加え、呼び出しごとにスパンを作る。キーや本文は属性に入れない。
- **Claude Code**：fraud-agentは、Claude Codeのトレースを有効にし（トレースだけ。メトリクスとログのイベントは出さない）、送り先を
  共通部品の`startOtlpTraceRelay`が`127.0.0.1`に立てた受け口にする。受け口は、受けたOTLPを実行roleで署名してX-Rayに転送する。
  Claude Codeは、SDKが入れる`TRACEPARENT`を親にするので、`claude_code.interaction`はfraud-agentの受信のスパンの子になる。
  分析の終わりに、Claude Codeが残りを送り終えるのを待つ（最後の受信から300ms、最大2秒）。
- **中継**：fraud-agentのMCPの中継（§6）は自分のスパンを作らず、受け取った`traceparent`を転送するときのコンテキストにする。
  Claude Codeは`tools/call`に`traceparent`を付けるので、fraud-mcpへの送信のスパンは`claude_code.tool.execution`の子になる。
  接続の処理（`initialize`、`tools/list`）はClaude Codeのスパンの外で行われるので、fraud-agentの受信のスパンの子になる。
- **ログ**：構造化ログに、その時点のスパンのトレースID（`traceId`）を入れる。
- **メトリクスは出さない**：認可の判定の件数や処理時間は、構造化ログ（`handled`と`rejected`）からLogs Insightsで集計する（[収集先のADR](../adr/20261001020115-telemetry-destination-cloudwatch.md)）。
- **入れないもの**：認証情報（JWT、受け渡すセッション）、リクエストとレスポンスの本文、プロンプト、ツールの入出力。業務のコードは属性を加えない。
- **有効化**：CDKが、bffと各ホップに環境変数`AUTHZ_TELEMETRY=cloudwatch`と、`xray:PutTraceSegments`の権限を付ける。環境変数がなければ、
  OTelのAPIは何もしない（単体テストなど）。

## 8. デモのシナリオ（FR-7）

口座の凍結解除を題材にする（[デモのADR](../adr/20261001123029-demo-account-unfreeze.md)）。疑わしい取引で凍結された口座について、
人間が案件を開き、エージェントに分析させ、解除してよければ人間が解除する。

### シナリオ

- **ユーザー**（人事データ）：yamada（tokyo、支店長）、tanaka（osaka、担当者）、suzuki（honbu、監査担当）
- **権限マスタ**：担当者は`case:view`・`account:view`、支店長はそれに加えて`account:unfreeze`、監査担当は`audit:view`だけ
- **データ**：案件と取引（case-service）、口座（account-service）。それぞれ`branch`を持つ。口座は凍結の状態（`status`＝`frozen`／`active`）と凍結の理由を持ち、
  デモの口座（A-101はtokyo、A-201とA-999はosaka）はデプロイの時点で凍結しておく。案件は凍結の見直しの案件（C-1001はA-101、C-2001はA-201）。
- **案件を開く**（目的`case-summary`）：yamadaが自分の支店の案件を開くと、case-serviceが口座の凍結の状態と理由をaccount-serviceから取得して返す。
  他の支店の案件は、case-serviceが業務的なアクセス権で拒否する。
- **凍結を解除する**（目的`account-unfreeze`）：yamadaが案件の「凍結を解除」を押すと、case-serviceがaccount-serviceに案件の口座の解除を依頼する。
  account-serviceは、状態と、解除したユーザー（subject）、日時、リクエストIDを、1回の条件付きの更新（凍結中のときだけ）で口座に記録する。
  解除の記録はこの口座の記録だけで、case-serviceは案件に書き込まない。tanakaは担当者なので、解除の取引でもaccount-serviceが拒否する。
  解除済みの口座は409を返す。
- **エージェントの経路**（目的`agent-analysis`）：yamadaが案件の分析をfraud-agentに依頼する。エージェントは案件と口座を読み、解除してよいかの判断と理由を応答で返す（提案）。
  提案は記録しない。
  - 案件の取引メモには、本部監査部を名乗って口座A-101とA-999の凍結の解除を求める文言を混ぜておく。エージェントがそれに誘導されて`unfreeze_account`を呼んでも、
    fraud-mcpがaccount-serviceに付けられるscopeは`account:read`だけなので、account-serviceが拒否する。A-999は、口座の参照も業務的なアクセス権で拒否される。
- **ホップが侵害された場合**：画面では再現できないので、シナリオテストで確かめる（§10）。案件を開く取引やエージェントの取引のcase-serviceのセッションからは、
  account-service宛てに`account:unfreeze`のJWTを発行できない。
- **異動**：人事データでyamadaの所属をosakaに変えると、次のリクエストから、tokyoの案件は拒否され、osakaの案件を開ける（FR-8）。
- **監査**（目的`audit`。[監査サービスのADR](../adr/20261002074437-audit-service.md)）：suzukiが監査の画面で取引を選ぶと、audit-serviceが次の2つを集めて突き合わせる。
  支店長と担当者は監査できず、監査担当は案件の参照も解除もできない。どちらも業務的なアクセス権で拒否される。
  - **ホップの記録**：各ホップのロググループの`handled`と`rejected`を、リクエストIDでLogs Insightsで引く（直近7日）。`rejected`は、刻まれていた値（`stampedRequestId`）でも引き、
    それがある記録は、その値の取引にだけ出す（ヘッダーで名乗ったリクエストIDを、偽った値として示す）。ログは各ホップが処理を終えたときに書くので、
    ログの時刻から処理時間（`timings.totalMs`）を引いて処理の区間を求め、呼び出し元（`actor`）のホップの区間のうち、その区間を含む最も短いものを親とみなして、
    呼び出しの順（深さ優先）に並べる。
  - **一覧**：bffの`handled`の直近24時間の取引（表示の経路を除く。監査の操作も含め、監査した取引のリクエストID（`auditTarget`。bffが経路のパスから得てログに書く）を添える）。1回の操作（リクエスト）を1件とし、ログインのセッション（`sessionRef`）ごとにまとめ、
    セッションのログインの新しい順、セッションの中は時刻の順に並べる。
  - **AWSの記録**：CloudTrailの`LookupEvents`を`Username`＝リクエストIDで引き、`AssumeRoleWithWebIdentity`・`AssumeRole`・`GetWebIdentityToken`から、
    呼んだ主体、`sourceIdentity`、引き受け先と目的のtag、宛先とscopeのtag、`webIdentityTokenId`だけを取り出す。イベントをそのまま返さない（`AssumeRole`の
    `responseElements`には、アクセスキーIDとセッショントークンが入る）。roleのARNは、CDKが渡す対応表（role名 → ホップ名とroleの種類）で表示名に置き換える。
  - **突き合わせ**：ホップの記録の`jti`と`webIdentityTokenId`が一致するイベントについて、JWTを発行したrole、宛先、scope、ユーザーを比べ、bffの`AssumeRole`の目的のtagと
    各ホップの記録の目的を比べる。bffの記録は、目的とユーザーを`AssumeRole`のイベントと比べる。比べるのは監査サービスで、画面は比べない。
    記録ごとに、項目ごとの結果（「一致」「不一致」「未着」）と、比べた2つの値を返す。記録全体の結果は、1つでも違えば「不一致」、未着の項目が残れば「AWSの記録が未着」とする。
    あわせて、それぞれの情報源を返す。アプリの記録はそのホップのロググループ名、AWSの記録は、対応づけた`GetWebIdentityToken`（と目的を取り出した`AssumeRole`）の
    イベント名、イベントID（`eventID`）、時刻と、`webIdentityTokenId`である。CloudTrailのイベント履歴で、イベントIDから同じイベントを引ける。
  - **画面**：取引の一覧（左）と、選んだ取引の突き合わせ（右）を並べる。突き合わせでは、記録ごとに、比べた項目をアプリの記録とAWSの記録の2列で並べ、
    情報源と、対応づけに使った`jti`・`webIdentityTokenId`を全体で示す。不一致の項目は、2つの値で違いを示す。
  - CloudTrailのイベントが届くまで数分〜15分ほどかかるので、直後の取引は「未着」になる。各chainのセッション名はIAMがリクエストIDに縛るので（§7）、
    途中のホップは、自分のイベントをリクエストIDで引けなくすることはできない。
- **繰り返し**：解除は口座の状態を変える。デモを繰り返すときは、READMEのコマンドで口座を凍結し直す。
- **保証の範囲**：示せるのは「エージェントの取引からは解除できない」ことで、「人間が操作したことの証明」ではない。bffは目的を決める信頼の起点で、
  bffが侵害されれば、どの目的でも刻める。
### エージェントとMCPサーバー

- **エージェント**：fraud-agentは、Claude Agent SDK（版を固定する）でClaude Code（linux-arm64の実行ファイル、関数に同梱）を子プロセスとして動かす
  （[Claude Agent SDKのADR](../adr/20261001040729-fraud-agent-on-claude-agent-sdk.md)）。
  - **プロセスの分担**：親（Node.jsのハンドラー）は、受信の検証、中継、子プロセスの起動を行い、認証情報を持つ。子（Claude Code）は、
    エージェントのループを回し、Bedrockを呼び、中継をMCPサーバーとして呼ぶ。
  - **中継**：分析のたびに、親が`startMcpRelay`（§6）で`127.0.0.1`の中継を立て、Claude Codeには`fraud`という名前のHTTPのMCPサーバーとして渡す。
    中継は、受けたメッセージを送信時の手順（§4）でfraud-mcpへ転送する。分析が終わったら閉じる。
  - **子プロセスに渡すもの**：環境変数は引き継がず、次のものだけを渡す。モデル用のroleの認証情報（§5）、リージョン、`PATH`と`LANG`、
    書き込める場所（`HOME`と`CLAUDE_CONFIG_DIR`を`/tmp`の下に）、Bedrockを使う設定とモデル、必須でない通信と自動更新を止める設定、
    クライアントの名前、トレースの設定（§7）。受け取ったJWT、受け渡されたセッション、chainのセッション、実行roleの認証情報は渡さない。
    モデル用のroleは、セッション名を`fraud-agent-model`、期間を3600秒として引き受け、実行環境ごとに使い回し、期限の10分前に引き受け直す。
  - **子プロセスの制限**：組み込みのツール（Bash、Readなど）は無効にし、中継のツール（`mcp__fraud__*`）だけを許可なしで使わせる（それ以外は拒否）。
    設定ファイルを読まず、セッションを保存しない。Anthropicへの必須でない通信と自動更新を止める。
  - **モデル**：Claude Haiku 4.5を、日本国内の推論プロファイル（`jp.anthropic.claude-haiku-4-5-20251001-v1:0`、東京・大阪）で呼ぶ。
    補助的な処理に使う小さいモデルも同じにする。1回の分析のターンは最大8回。
  - **応答**：分析の結果と、ツールの呼び出しの記録（ツール名、引数、呼び出し先のHTTPステータス）を返す。記録は中継が知らせるメッセージから取る。
    エージェントが最後まで終わらなかったら502を返す。Claude Codeが異常終了したら、例外のメッセージをログに出し、500を返す。
  - **ログ**：分析が終わったら、ツールの呼び出しの記録のうち、ツール名とHTTPステータスだけをログに出す。引数はモデルが作る値で、注入された文言が入りうるので、
    応答にだけ返す（トレースにツールの入出力を入れないのと同じ扱い。§7）。Claude Codeの標準エラー出力は、中身をClaude Codeが決め、プロンプトや
    ツールの入出力が入らないとは保証できないので、既定ではログに出さない。失敗の原因（Bedrockの権限やモデルの利用の申請など）を調べるときだけ、
    `cdk deploy -c agentLogStderr=true`でデプロイすると、環境変数`AGENT_LOG_STDERR=1`が付き、異常終了したときに末尾（2,000文字）をログに出す。
    有効にしている間は、Claude Codeが書く内容がそのままログに入る。調べ終えたら、付けずにデプロイし直す。
  - **関数**：メモリは1024MB。成果物（展開後）は約246MBで、そのうち実行ファイルが約241MB。合成のときに大きさを確かめ、255,000,000バイトを
    超えたら失敗させる（関数とレイヤーを合わせた展開後の上限は250MiB）。超えたら、コンテナイメージに切り替える。
- **MCPの実装**：fraud-mcpはStreamable HTTPのステートレスなサーバーで、SSEを使わずJSONで応答する。ツールは`get_case`（case-service、`case:read`）、
  `get_account`（account-service、`account:read`）、`unfreeze_account`（account-serviceに解除を依頼する。付けられるscopeは`account:read`だけなので、常に拒否される）の3つで、
  呼び出し先のホップの結果（HTTPステータスを含む）をそのまま返す。認可の判断はしない。`unfreeze_account`は、ツールの一覧ではなく委任の範囲が境界であることを
  見せるためのデモ用のツールである。
  プロトコルの版は`2026-07-28`・`2025-11-25`・`2025-06-18`に応じる。`ping`にも応え、通知には本文なしの202を返す。
- **タイムアウト**：CloudFrontのオリジンの応答待ちは既定の上限の60秒で、bffのLambdaも60秒、fraud-agentは55秒とする。
  他のホップは30秒。
- **MCPの認可についての注記**：MCPの仕様では認可は任意で、HTTPではOAuthに従うことが推奨される。この参照実装のfraud-mcpはOAuthではなく、
  他のホップと同じ入口（実行roleとJWT）で守る。

## 9. CDKの構成

npmのワークスペース（`infra`、`packages/*`、`services/*`、`web`、`tests`）で次のように分ける。

| ディレクトリ | 内容 |
|---|---|
| `infra/` | CDKアプリ（単一のスタック`Gekko08App`。リージョンはap-northeast-1に固定する）と、`Hop`のテンプレートの単体テスト（`infra/test/`。§10） |
| `packages/authz-context/` | 受信側・送信側の共通部品、MCPの部品、トレース（§6、§7） |
| `services/<名前>/` | 各Lambdaのハンドラー（bff、case-service、account-service、entitlement-service、fraud-agent、fraud-mcp、audit-service、pretoken）と、委任の範囲の定義（`authz.ts`。§4） |
| `web/` | デモの画面（ReactとViteの静的なSPA。§3） |
| `tests/` | シナリオテスト（§10） |
| `experiments/` | 実機の検証（検証記録とその構成。本体からは参照しない） |

Lambdaの関数の既定値（`NodeFunction`）は、Node.js 24、arm64、メモリ512MB、タイムアウト30秒、ログの保持1週間、ログの形式はJSON（アプリのログのレベルはINFO）、
esbuildでESMの1ファイルにまとめ、AWS SDKも同梱し、ソースマップを付ける。`Gekko08AppStack`は、検証で構成を足せるように、`issuer`・`bff`・`fraudMcp`・
`bedrockResources`を公開する。

主なConstruct：

| Construct | 作るもの |
|---|---|
| `AuthFoundation` | Cognito User Pool（Essentials、マネージドログイン）、アプリクライアント、Pre Token Generation V2のLambda、OIDC provider、federated role。アプリクライアントには属性の書き込みを許さない |
| `Hop` | `NodejsFunction`（関数ごとの実行role）、Function URL（`AWS_IAM`）、入口のresource policy、必要ならchain用role。メモリ量とバンドルの設定を変えられる（fraud-agentは実行ファイルを同梱する） |
| `connectHops(purposes, definitions, hops)` | 委任の範囲の定義（§4）を突き合わせ、整合しなければ合成を失敗させる。整合していれば、利用側と提供側の組ごとに`Hop#allowCaller`を呼び、提供側の受信時の照合の設定を渡す |
| `Hop#allowCaller(caller, scopes)` | 呼び出し元と呼び出し先をつなぐ。入口のresource policyへの追加、chain用roleの信頼とchain権限、JWTの発行の権限（宛先、scope、目的の制限）、`sub`の対応表、呼び出し元の設定（URL、aud、付けられるscope） |
| `Bff` | bffの`NodejsFunction`とFunction URL、目的用のrole、セッションのテーブル、SSMのパラメータ（設定とシークレット）。`Bff#asCaller`で目的用のroleをchain用roleとして渡す |
| `WebFrontend` | CloudFront、S3（静的なフロントエンド）、bffのFunction URLへのOAC。合成のときに`web/`をビルドして（`vite build`）、出力をS3に置く |
| `DemoData` | DynamoDBのテーブル（案件、口座、人事データ、権限マスタ）とデモ用データ |
| `OutboundFederationCheck` | デプロイ時の前提条件の確認と、JWTの発行者URLの取得（§11） |

Cognito User Poolのカスタム属性`custom:branch`は使わない。User Poolのスキーマから属性を消せないため、既存の環境との互換のために定義だけを残す。

## 10. テスト

振る舞いを確かめるシナリオテストは、デプロイしたスタックに対して実行し、要件のIDにひも付ける。

テストは、デモのユーザーとは別の専用のユーザー（`test-tokyo-manager`はtokyo・支店長、`test-osaka-officer`はosaka・担当者、`test-auditor`はhonbu・監査担当）を使い、Cognitoのユーザーと人事データの行を
テストの実行ごとに用意する。パスワードは実行のたびにランダムな値にし、異動のテストもこの人事データだけを書き換える。
案件と口座も、テスト専用のもの（`TC-`、`TA-`で始まるもの。デモのデータと同じ形）を実行ごとに凍結した状態で用意し、デモのデータには触れない。
凍結の解除のテストは、解除のテストだけが使う案件と口座を、テストごとに凍結し直して使う。

マネージドログインはブラウザを必要とするので、テストでは`ADMIN_USER_PASSWORD_AUTH`でIDトークンを得て、bffの`/api/callback`と同じ形の
セッションをテーブルに書き、そのcookieでCloudFrontからbffを呼ぶ。`ADMIN_USER_PASSWORD_AUTH`はIAMの権限
（`cognito-idp:AdminInitiateAuth`）がなければ呼べず、ブラウザからは使えない。

| 要件 | テストの内容 |
|---|---|
| FR-1 | 各ホップの共通部品が、正しいsubject・actor・目的・scopeを検証する。宛先の違うJWT、改ざんしたJWT、JWTなし、期限切れのJWT、呼び出し元と`sub`の合わないJWT、scopeのないJWTは401（目的のないJWTは共通部品の単体テストで確かめる）。不正なJWTは入口を通して送れないため、STSが実際に発行したJWTを改変し、ホップと同じ共通部品の検証に発行者の実際のJWKSで通して確かめる |
| FR-2 | 業務的なアクセス権のない案件や口座は拒否される。自己申告のヘッダーや引数で別のユーザーを名乗っても、結果が変わらない |
| FR-3 | chainの途中でSourceIdentityや目的を変えられない。定めていない目的を刻めない。新しいtagのキーを加えられない。宣言していないscopeを発行できない。目的の制限があるscopeを、許していない目的の取引では発行できない（案件を開く取引とエージェントの取引のcase-serviceのセッションから、account-service宛ての`account:unfreeze`）。許した目的の取引なら発行できる |
| FR-4 | 途中のホップを飛ばした呼び出しが403 |
| FR-5 | ブラウザに返す応答とcookieに、トークンも認証情報も含まれない |
| FR-6 | 1回のリクエストを、各ホップのログとCloudTrailでリクエストIDとユーザーから追える。リクエストIDは途中で変えられない（刻んだ値と違うセッション名では目的用のroleもchain用roleも引き受けられず、chainでtagを上書きできず、JWTに刻まれた値と違うリクエストIDで届いた呼び出しは401で、拒否のログに刻まれていた値が残る（共通部品の単体テスト））。マイクロサービスとエージェントの経路が、それぞれ1つのトレースにつながり（各ホップの受信のスパンが直前のホップの送信のスパンの子になる）、受信のスパンに検証した呼び出し元・目的・scope・ユーザーが入る。DynamoDBの呼び出しが各ホップの受信のスパンの子になる。Claude Codeのスパンがfraud-agentの受信の子になり、`tools/call`の送信が`claude_code.tool.execution`の子になる。ブラウザから届いた`traceparent`は引き継がない |
| FR-7 | エージェントが誘導されて解除を試みても、口座は解除されない（`unfreeze_account`はaccount-serviceが拒否する）。他の支店の口座は参照も拒否される。人間の解除の取引では、支店長は自分の支店の口座を解除でき、担当者は解除できない。モデルの判断は毎回変わりうるので、誘導されたかどうかではなく、誘導されても口座が凍結されたままで、他の支店のデータが応答に現れないことを確かめる。監査担当は、取引の一覧と、各ホップの記録（呼び出し元・ユーザー・目的・scope・`jti`）を、比べる項目のアプリの記録の値と情報源（ロググループ）とあわせて引ける。各ホップの記録は呼び出しの順に並び、一覧では同じログインのセッションの操作が1つのまとまりとして時刻の順に並ぶ。CloudTrailが届くと、bffと各ホップの記録がすべてAWSの記録と一致し、項目ごとにAWSの記録の値とイベントIDが出て、`jti`と同じ`webIdentityTokenId`のイベントが対応づけられ、応答に認証情報とARNが含まれない（`npm run test:scenario:cloudtrail`のときだけ）。監査の操作も、監査した取引のリクエストIDとともに一覧に出て、その操作の各ホップの記録を引ける。支店長は監査できず、監査担当は案件を開けず解除もできない |
| FR-8 | 人事データで所属を変えると、次のリクエストから結果が変わる |
| NFR-3 | 各ホップの処理時間（chain、JWTの発行、検証）を集計して公開する |
| SR-1 | 受け渡したchainのセッションで、どのホップも呼べない。内部のホップ以外を宛先に含むJWTを作れない |
| SR-2 | 許可していない主体（広い権限を持つroleを含む）が各ホップを呼ぶと403 |
| SR-3 | 各ホップのログとトレースのスパンに、認証情報・JWT・cookieが含まれない。スパン（Claude Codeのものを含む）に、プロンプト・業務データ・ツールの結果・注入された文言が含まれない |

FR-6・SR-3・NFR-3のテストは、各ホップの構造化ログをCloudWatch Logsから読んで確かめる。トレースは、Transaction Searchのロググループ
`aws/spans`をトレースID（bffのログにある）で引いて確かめる。スパンが届くまでに数十秒〜数分かかる。FR-6のうちCloudTrailの確認は、イベントが届くまでに
最大15分ほどかかるため、`npm run test:scenario:cloudtrail`のときだけ実行する。CloudTrailのイベントは、`Username`（＝`RoleSessionName`＝リクエストID）で引ける。
NFR-3のテストは、集計結果を`tests/out-latency.json`（git管理外）に書く。

共通部品の単体テストと、`Hop`のテンプレートの単体テスト（`infra/test/`、`npm test`）は、要件のIDにはひも付けない。

`Hop`のテンプレートの単体テストは、デモの配線に依存しない試験用の小さなスタックを合成し、§5のIAMの条件を確かめる。確かめるのは、
入口のresource policy（Function URLが`AWS_IAM`であること、許可した呼び出し元の実行role以外へのDeny、許可の相手）、呼び出し元の実行roleのDeny
（`lambda:SourceFunctionArn`）、JWTの発行の条件（宛先の`ForAllValues`＋`Null`、`ES384`、300秒以下、scopeのキーと値、目的の制限があるscopeの目的）、chain用roleが
chainとJWTの発行のほかに権限を持たないこと、chain用roleの信頼（相手とtagのキー）、`sub`の対応表である。文は（Effect, Principal, Action,
Resource, Condition）の組に分けて比べるので、文のまとめ方が変わっても結果は変わらない。あわせて、条件をわざと壊したテンプレート
（`ForAnyValue`にする、Denyを消す、`aws:TagKeys`の制限を外す、目的の制限を外す、目的の制限があるscopeを制限のない文に混ぜる、`sub`を別のroleにするなど）を、
それぞれのチェックが見逃さないことを確かめる。委任の範囲の定義の突き合わせ（§4）は、整合しない定義で合成が失敗することを確かめる。

## 11. 前提条件と制約

### デプロイの前提条件

- **IAMのアウトバウンドIDフェデレーション**：`GetWebIdentityToken`を使うには、アカウント単位で有効にしておく必要がある。
  アカウント全体の設定なので、参照実装は自動で有効にしない。カスタムリソース`OutboundFederationCheck`がデプロイ時に
  `GetOutboundWebIdentityFederationInfo`を呼び、無効ならデプロイを失敗させて有効化の手順（`EnableOutboundWebIdentityFederation`）を示す。
  有効なら、アカウント固有の発行者URL（`IssuerIdentifier`）を取得して、各ホップにJWTの`iss`として渡す。
- **Amazon Bedrockのモデル**：アカウントによっては、Claudeのモデルを使う前に利用の申請が必要になる（Bedrockのコンソールのモデルカタログから行う）。
- **CloudWatch Transaction Search**：トレースの受け口を使うには、アカウント単位で有効にしておく必要がある（スパンの送り先をCloudWatch Logsにし、
  X-RayがロググループにPutLogEventsできるresource policyを置く）。アカウント全体の設定なので、参照実装は自動で有効にしない
  （[Enable Transaction Search](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Enable-TransactionSearch.html)）。
- **npmのレジストリ**：合成のときに、Claude Code（linux-arm64の実行ファイル）をnpmのレジストリから取得する。開発機の`node_modules`には、
  開発機のプラットフォーム向けしか入らないため。取得したものは一時ディレクトリに版ごとに置き、次からは使い回す。

### 呼び出し関係の制約

- ホップの呼び出し関係は循環させない。呼び出し元の環境変数が呼び出し先のFunction URLを参照するため、循環させるとCloudFormationで循環参照になる。
  循環が必要になった場合は、Function URLを環境変数ではなく実行時に解決する方式を検討する。

### 規模の上限

参照実装の規模（ホップ7つ）では、次のクォータには抵触しない。規模が大きくなったときに、どこが先に上限になるかの目安を示す（クォータは2026-09-30時点の文書による）。

| クォータ（既定値→上限） | 効く場所 | 上限の目安 |
|---|---|---|
| STSのリクエスト数：600件/秒（アカウント・リージョンごと。`AssumeRole`、`GetCallerIdentity`など6つの操作で共有。引き上げはサポートに依頼） | bffの目的の刻印と、各ホップのchain（`AssumeRole`） | 案件を開く取引と凍結を解除する取引では1リクエストで`AssumeRole`が3回（bffの目的の刻印、case-serviceとaccount-serviceのchain）で、アカウント全体でおよそ毎秒200リクエスト。エージェントの経路では「2＋2×ツールの呼び出し回数」（bffの目的の刻印、fraud-agentのchain、`tools/call`ごとにfraud-mcpと呼び出し先のchain）で、ツールの呼び出しが3回なら8回、およそ毎秒75リクエスト |
| CloudFormationのリソース数：1スタック500個 | 1ホップで約8〜10個 | 単一スタックで40〜50ホップ前後 |
| Lambdaの環境変数：合計4KB | 受信側の`sub`の対応表 | 呼び出し元が十数個を超えるホップ |
| roleの信頼ポリシー：2,048文字→8,192文字 | chain用roleの信頼ポリシーに呼び出し元を列挙 | 呼び出し元10個前後（引き上げて40個前後） |
| roleの数：1,000→10,000 | 1ホップで2つ | 数百ホップ |
| roleのインラインポリシー：合計10,240文字 | chain用roleの権限（呼び出し先ごとに、JWTの発行の文と、scopeを付ける許可の文。§5） | 呼び出し先が十数個 |
| Lambdaのresource policy：20KB | 入口のresource policy | 呼び出し元50個前後 |

`AssumeRoleWithWebIdentity`と`GetWebIdentityToken`は、600件/秒を共有する操作の一覧に入っていない。両者のリクエスト数のクォータは、文書にもService Quotasにも
記載がない（2026-10-01に確認。Service QuotasにはSTSの項目がない）。参照実装での1リクエストあたりの回数は次のとおり（2026-10-01のトレースで数えた）。

| 経路 | `AssumeRoleWithWebIdentity` | `AssumeRole` | `GetWebIdentityToken` |
|---|---|---|---|
| 本人の表示 | 1 | 1 | 1 |
| 案件を開く、凍結を解除する | 1 | 3 | 4（各ホップの呼び出し先ごとに1回） |
| エージェントの分析（ツールの呼び出しn回） | 1 | 2＋2n | 5＋3n（MCPのメッセージごとに1回。ツールの呼び出しのほかに、接続の処理で4回前後） |

`GetWebIdentityToken`は、ホップへの呼び出しのたびに発行するので、`AssumeRole`より回数が多い。上限が文書にない以上、`AssumeRole`の上限から求めた
目安より先に、`GetWebIdentityToken`のスロットリングが起きる可能性は否定できない。
