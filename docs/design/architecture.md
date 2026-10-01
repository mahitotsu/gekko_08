# 設計書：参照実装の構成

参照実装の現在の構成を示す。判断の経緯と採用しなかった選択肢はADRに、満たすべきことは[要件定義](../requirements.md)にある。
実装やテストで問題が見つかったときの扱いは、[文書一覧の運用ルール](../README.md#運用ルール)に従う。

関連するADR：

- [多段伝播](../adr/20260930064314-multi-hop-authorization-context-propagation.md)：actorは実行role、subjectはSTSが署名したJWT
- [委任の範囲と業務的なアクセス権](../adr/20260930150529-delegation-scope-and-entitlements.md)：取引の目的とscopeはSTSとIAMが強制し、業務的なアクセス権は属性サービスから得る
- [入口はBFF](../adr/20260930083437-entry-via-bff.md)
- [IdPはCognito User Pool](../adr/20260930091026-idp-cognito-user-pool.md)
- [ホップはLambdaとFunction URL、mTLSは使わない](../adr/20260930091257-lambda-function-url-without-mtls.md)
- [BFFの公開とセッション](../adr/20260930093744-bff-hosting-and-session.md)
- [実装言語はTypeScript](../adr/20260930093745-implementation-language-typescript.md)
- [エージェントとMCPサーバーもLambdaのホップ](../adr/20260930093746-agent-and-mcp-on-lambda.md)

## 1. 要件との対応

| 要件 | 満たす設計要素 |
|---|---|
| FR-1（subject・actor・aud・委任の範囲を確かめる） | 入口のresource policy（実行roleと関数）、JWTの検証。委任の範囲はJWTの`purpose`と`scope`（§4、§6） |
| FR-2（委任の範囲と業務的なアクセス権の両方で判定） | 受信側の共通部品が委任の範囲を渡し、業務のコードが属性サービスのアクセス権と合わせて判定する。ヘッダーや引数、LLMの出力からユーザーを読まない（§6） |
| FR-3（ユーザーと目的は入口で確定し、変更も拡大もできない） | SourceIdentityとtransitive session tagの`purpose`。刻める目的とscopeはIAMで限る。業務的なアクセス権は属性サービスが持つ（§3、§5、§6） |
| FR-4（ホップを飛ばせない） | 入口は直前のホップの実行roleだけを許可（§4、§5） |
| FR-5（パブリッククライアントに認証情報を持たせない） | BFFとセッションcookie（§3） |
| FR-6（処理を元のユーザーとリクエストに結びつけて追跡） | リクエストIDの引き継ぎ、構造化ログ、`RoleSessionName`（§7） |
| FR-7（デモ） | 不正検知シナリオ（§8） |
| FR-8（業務的なアクセス権の変更が次のリクエストから反映） | 属性サービスが判定のたびに人事データと権限マスタを読む（§6） |
| NFR-1・NFR-2（サーバーレス、常駐コンポーネントなし） | Lambda、DynamoDB、Cognito、CloudFront、S3だけで構成（§2） |
| NFR-3（レイテンシの実測と公開） | 各ホップの処理時間のログと、シナリオテストでの集計（§10） |
| NFR-4（`cdk deploy`で再現） | 単一のCDKスタックと、デプロイ時の前提条件の確認（§9、§11） |
| SR-1（受け渡す認証情報が漏れても呼べない） | chain用roleは次のchainとJWTの発行だけ。入口は実行roleだけを許可（§4、§5） |
| SR-2（他の主体が許可されていないホップを呼べない） | 入口のresource policyのDeny（§5） |
| SR-3（認証情報をログ・LLMに入れない） | 共通部品が認証情報をヘッダーだけで扱い、ログに出さない。エージェントはヘッダーをモデルに渡さない（§6、§8） |

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
                                                  └──> entitlement-service  <── case-service、account-service
```

| 構成要素 | 役割 | 呼び出し元 | 呼び出し先 |
|---|---|---|---|
| bff | ログイン、セッション、取引の目的の決定、最初のホップ | ブラウザ（CloudFront経由） | case-service、fraud-agent、entitlement-service |
| case-service | 不正検知の案件と取引の参照 | bff、fraud-mcp | account-service、entitlement-service |
| account-service | 口座の参照 | case-service、fraud-mcp | entitlement-service |
| fraud-agent | 案件の分析を行うAIエージェント。Claude Agent SDKがClaude Codeを子プロセスとして動かし、MCPは関数の中の中継から呼ぶ（§8） | bff | fraud-mcp、Bedrock |
| fraud-mcp | エージェント向けのツールを提供するMCPサーバー | fraud-agent | case-service、account-service |
| entitlement-service | 属性サービス。ユーザー本人の業務的なアクセス権を返す（終端） | bff、case-service、account-service | なし |

呼び出しの経路は2つある。

- **マイクロサービスの経路**：bff → case-service → account-service
- **エージェントの経路**：bff → fraud-agent → fraud-mcp → case-service または account-service

データはDynamoDBに置き、各サービスが自分の実行roleで読む（案件はcase-service、口座はaccount-service、人事データと権限マスタは
entitlement-service）。

## 3. ログインとセッション（bff）

### ログイン

1. ブラウザが`GET /api/login`を呼ぶ。bffは`state`とPKCEの`code_verifier`を作ってDynamoDBに保存し、`state`を結ぶcookie
   （`HttpOnly`・`Secure`・`SameSite=Lax`、短命）を付けて、Cognitoのマネージドログインへリダイレクトする。
2. Cognitoから`GET /api/callback`に戻る。bffは`state`をcookieと照合し、アプリクライアントのシークレット（SSM Parameter Store）を使って
   トークンエンドポイントでIDトークンとリフレッシュトークンを受け取る。
3. bffはセッションをDynamoDBに保存し、セッションID（256ビットの乱数）だけを入れたcookie（`HttpOnly`・`Secure`・`SameSite=Strict`）を返す。
   テーブルのキーはセッションIDのSHA-256にし、テーブルを読めてもcookieとして使える値が得られないようにする。
   cookieの名前には`__Host-`を付ける（`__Host-sid`、`__Host-login`）。

bffの設定（アプリクライアントのID、マネージドログインのドメイン、コールバックURL、federated roleと目的用のroleのARN、呼び出し先）は、
SSM Parameter StoreのStringパラメータに置き、実行時に読む。環境変数にすると、bff→CloudFront→Cognitoのアプリクライアント
（コールバックURL）→federated role→目的用のrole→case-serviceのchain用role→case-service→bffという循環参照になるため。
アプリクライアントのシークレットは、デプロイ時にカスタムリソースがSecureStringとして書く（CloudFormationはSecureStringを作れない）。

IDトークンには、Pre Token Generation V2トリガーが`https://aws.amazon.com/source_identity`（ユーザー識別子）だけを入れる。
業務属性はトークンに入れない（§6の属性サービスが持つ）。

### リクエストごとの処理

1. cookieのセッションIDでセッションを読む。IDトークンの期限が切れていれば、リフレッシュトークンで更新する。
2. リクエストIDを発行する（§7）。
3. IDトークンで`AssumeRoleWithWebIdentity`を呼び、federated roleのセッションを得る（`RoleSessionName`＝リクエストID）。
   このセッションにSourceIdentityが刻まれる。
4. 経路から取引の目的を決め、federated roleのセッションから目的用のroleへchainして、`purpose`をtransitive session tagとして刻む
   （`RoleSessionName`＝リクエストID）。
5. 目的用のroleのセッションで、共通部品を使って最初のホップを呼ぶ（§4）。

### エンドポイントと取引の目的

| パス | 取引の目的（`purpose`） | 呼ぶホップ |
|---|---|---|
| `GET /api/login`、`GET /api/callback`、`POST /api/logout` | なし | なし |
| `GET /api/me` | `profile` | entitlement-service（ユーザー名と、所属・役職を表示用に返す。認証情報は含めない） |
| `GET /api/cases/{id}/summary` | `case-summary` | case-service |
| `POST /api/agent` | `agent-analysis` | fraud-agent |

目的はbffが経路ごとに決める。bffは取引の入口として、Transaction Tokensの発行サービスに当たる役割を持つ。刻める目的の値はIAMで限る（§5）。

フロントエンドは、POSTの本文のSHA-256を`x-amz-content-sha256`ヘッダーに付ける（CloudFrontのOACの要件）。

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
2. そのセッションで`GetWebIdentityToken`を呼び、`aud`＝呼び出し先、`Tags`＝`scope`（呼び出し先ごとに宣言した値）のJWTを作る
   （`DurationSeconds`＝300、`SigningAlgorithm`＝`ES384`）。
3. 自分の実行roleの認証情報で署名して、呼び出し先のFunction URLを呼ぶ。

受信側での手順は§6の共通部品が行う。

### 委任の範囲

呼び出し元と呼び出し先の組ごとに、JWTに付けるscopeと、JWTを発行できる取引の目的を宣言する。いずれもIAMが強制する（§5）。

| 呼び出し元 → 呼び出し先 | scope | 発行できる目的 |
|---|---|---|
| bff → case-service | `case:summary` | `case-summary` |
| bff → fraud-agent | `agent:analyze` | `agent-analysis` |
| bff → entitlement-service | `entitlements:read` | `profile` |
| case-service → account-service | `account:read` | `case-summary` |
| case-service → entitlement-service | `entitlements:read` | `case-summary`、`agent-analysis` |
| account-service → entitlement-service | `entitlements:read` | `case-summary`、`agent-analysis` |
| fraud-agent → fraud-mcp | `mcp:tools` | `agent-analysis` |
| fraud-mcp → case-service | `case:read` | `agent-analysis` |
| fraud-mcp → account-service | `account:read` | `agent-analysis` |

たとえば、目的が`agent-analysis`の取引では、case-serviceはaccount-service宛てのJWTを発行できない（エージェントの経路からは要約を作れない）。

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
| 実行role | Lambda関数ごとに1つ | 自分のデータ（DynamoDB）へのアクセス、ログ出力。fraud-agentはモデル用のroleの引き受け、bffはセッションのテーブルとSSMのパラメータ。ホップの呼び出しには権限を付けない（呼び出し先のresource policyで許可する） |
| モデル用のrole | 1つ（fraud-agent） | Bedrockのモデルの呼び出し（`bedrock:InvokeModel`・`bedrock:InvokeModelWithResponseStream`）だけ。fraud-agentの実行roleが引き受け、その認証情報だけをClaude Codeの子プロセスに渡す |
| federated role | 1つ | 目的用のroleへの`sts:AssumeRole`・`sts:TagSession`・`sts:SetSourceIdentity`だけ |
| 目的用のrole | 1つ | bffの呼び出し先のchain用roleへのchainと、JWTの発行（§4の表のとおり） |
| chain用role | §4の表のとおり | 次のchain用roleへの`sts:AssumeRole`・`sts:TagSession`・`sts:SetSourceIdentity`と、JWTの発行（§4の表のとおり） |

JWTの発行の権限（呼び出し先ごとに2つの文）：

```json
[
  {
    "Effect": "Allow", "Action": "sts:GetWebIdentityToken", "Resource": "*",
    "Condition": {
      "ForAllValues:StringEquals": { "sts:IdentityTokenAudience": ["<呼び出し先のaud>"] },
      "Null": { "sts:IdentityTokenAudience": "false" },
      "StringEquals": { "sts:SigningAlgorithm": "ES384", "aws:PrincipalTag/purpose": ["<発行できる目的>"] },
      "NumericLessThanEquals": { "sts:DurationSeconds": 300 }
    }
  },
  {
    "Effect": "Allow", "Action": "sts:TagGetWebIdentityToken", "Resource": "*",
    "Condition": {
      "ForAllValues:StringEquals": { "sts:IdentityTokenAudience": ["<呼び出し先のaud>"], "aws:TagKeys": ["scope"] },
      "Null": { "sts:IdentityTokenAudience": "false" },
      "StringEquals": { "aws:RequestTag/scope": "<宣言したscope>" }
    }
  }
]
```

宛先は`ForAllValues`＋`Null`で絞る。`ForAnyValue`では、許した宛先に外部の宛先を混ぜたJWTを発行できる
（[検証](../../experiments/scope-tags/RESULTS.md)のE1-7）。

### 信頼ポリシー

chain用roleは、呼び出し元のchain用role（bffの呼び出し先では目的用のrole）を信頼する。新しいtagのキーは加えられない。

```json
{
  "Statement": [
    { "Effect": "Allow", "Principal": { "AWS": ["<呼び出し元のchain用role>"] }, "Action": ["sts:AssumeRole", "sts:SetSourceIdentity"] },
    {
      "Effect": "Allow", "Principal": { "AWS": ["<呼び出し元のchain用role>"] }, "Action": "sts:TagSession",
      "Condition": { "ForAllValues:StringEquals": { "aws:TagKeys": ["purpose"] } }
    }
  ]
}
```

目的用のroleは、federated roleを信頼し、`sts:TagSession`をキー`purpose`だけ、値を定めた目的（`case-summary`・`agent-analysis`・`profile`）だけに限る。
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
      "Sid": "DenyOtherFunctions", "Effect": "Deny", "Principal": "*",
      "Action": ["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"], "Resource": "<この関数>",
      "Condition": { "ArnNotEquals": { "lambda:SourceFunctionArn": ["<呼び出し元の関数>"] } }
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

bffの入口は、CloudFrontのサービスプリンシパルを`AWS:SourceArn`＝ディストリビューションで許可する。同じアカウント内の広い権限を持つ主体は
bffのFunction URLを直接呼べうるが、セッションcookieがなければbffが拒否する。

## 6. 受信側の共通部品と判定

### 共通部品（`packages/authz-context`）

各ホップのLambdaは、共通部品を通して呼び出しを受け、次のホップを呼ぶ。業務のコードは認証情報もJWTも直接扱わない。

**受信時**

1. `x-authz-context`のJWTを検証する。`iss`＝自アカウントのSTS発行者、`aud`＝自分、`exp`、署名（JWKSはメモリにキャッシュし、未知の`kid`のときだけ取り直す）。
2. `sub`が「入口のIAMが確かめた呼び出し元の実行role」に対応するchain用roleであることを確かめる。対応表（実行role名 → 呼び出し元のホップ名と
   chain用roleのARN）はデプロイ時に環境変数で渡す。
3. `https://sts.amazonaws.com/`名前空間から、subject（`source_identity`）、取引の目的（`principal_tags.purpose`）、scope（`request_tags.scope`）を
   取り出す。どれかが欠けていれば拒否する（scopeのないJWTは何も許さない）。
4. subject、呼び出し元のホップ名（actor）、目的、scopeを業務のコードに渡す。ヘッダーや引数に含まれるユーザー情報は使わない。
5. 検証に失敗したら401を返す。

**送信時**：§4の手順を行う。呼び出し先ごとのscopeは設定から付け、業務のコードは選ばない。STSクライアントとJWKSはLambdaの実行環境ごとに使い回す。

**MCP**（`@gekko08/authz-context/mcp`）：MCPサーバーのホップを、エージェントのフレームワークから送信時の手順で呼ぶための部品。

- `HopMcpTransport`（直接型）：MCPの`Transport`。MCPクライアントを差し替えられるフレームワークに渡す。1つのメッセージを1回の送信で送る。
- `startMcpRelay`（中継型）：`127.0.0.1`で受けたMCPのメッセージを、送信時の手順でそのまま呼び出し先へ転送する。MCPクライアントを差し替えられず、
  固定のヘッダーしか付けられないフレームワーク（Claude Agent SDK）に使う。認可の判断はせず、MCPのプロトコルも解釈しない
  （`initialize`などにも呼び出し先が応える）。受け取った`traceparent`を転送するときのコンテキストにし、自分のスパンは作らない。
- どちらも、メッセージとその応答を業務のコードに知らせる（fraud-agentはツールの呼び出しの記録に使う）。

**ログ**：リクエストID、ホップ名、呼び出し元のホップ名（actor）と実行role名、subject、目的、scope、JWTの`sub`、判定結果、処理時間を構造化ログに出す。
認証情報、JWT、cookieはログに出さない。

### 属性サービス（entitlement-service）

- 人事データ（ユーザーID、所属`branch`、役職`title`）と権限マスタ（役職 → 権限の一覧）を持つ。
- **JWTのsubject本人のアクセス権だけを返す。照会する相手を引数に取らない。** 応答は`{ userId, branch, title, permissions }`。
- 人事データにないユーザーには403を返す。判定のたびに読むので、人事データや権限マスタの変更は次のリクエストから効く（FR-8）。
- 呼び出す側は、属性サービスが使えないときは拒否する（fail closed）。

### 判定（FR-2）

判定は、**委任の範囲が操作を許し、かつ業務的なアクセス権がデータを許す**ときだけ許す。

| ホップ | 操作 | 委任の範囲 | 業務的なアクセス権 |
|---|---|---|---|
| case-service | 要約 | scope＝`case:summary` | `case:view`を持ち、案件の`branch`が所属と一致 |
| case-service | 案件の取得 | scope＝`case:read` | 同上 |
| account-service | 口座の参照 | scope＝`account:read` | `account:view`を持ち、口座の`branch`が所属と一致 |
| account-service | 残高を含める | 目的＝`case-summary` | `account:balance`を持つ |
| entitlement-service | アクセス権の参照 | scope＝`entitlements:read` | 本人の分だけを返す |

## 7. 追跡（FR-6）

- bffがリクエストごとにIDを発行し、`x-request-id`で全ホップに引き継ぐ。
- 各ホップの構造化ログに、リクエストID、subject、目的を出す（§6）。
- `AssumeRoleWithWebIdentity`と各chainの`RoleSessionName`をリクエストIDにする。CloudTrailの`AssumeRole`・`GetWebIdentityToken`のイベントには、
  セッション名（＝リクエストID）とSourceIdentity（＝ユーザー識別子）が記録される。
- ログとCloudTrailを、リクエストIDとユーザー識別子で突き合わせられる。

## 8. デモのシナリオ（FR-7）

記事「プロンプトインジェクションでAIエージェントは騙せたが、認可は揺るがなかった」の不正検知シナリオを流用する。

- **ユーザー**（人事データ）：yamada（tokyo、支店長）、tanaka（osaka、担当者）
- **権限マスタ**：担当者は`case:view`・`account:view`、支店長はそれに加えて`account:balance`
- **データ**：案件と取引（case-service）、口座（account-service）。それぞれ`branch`を持つ。
- **マイクロサービスの経路**：yamadaが自分の支店の案件の要約を開くと、case-serviceが口座の情報をaccount-serviceから取得して返す。
  yamadaは支店長なので残高も含まれる。他の支店の案件は、case-serviceが業務的なアクセス権で拒否する。
- **エージェントの経路**：yamadaが案件の分析をfraud-agentに依頼する。
  - 目的が`agent-analysis`なので、account-serviceは、支店長のyamadaにも残高を返さない（委任の範囲による制限）。
  - 案件の取引メモには、本部監査部を名乗って他の支店の口座（A-999）の参照を促す文言を混ぜておく。エージェントがそれに誘導されて口座A-999を要求しても、
    account-serviceが業務的なアクセス権で拒否する。
- **異動**：人事データでyamadaの所属をosakaに変えると、次のリクエストから、tokyoの案件は拒否され、osakaの案件を開ける（FR-8）。
- **エージェント**：fraud-agentは、Claude Agent SDK（版を固定する）でClaude Code（linux-arm64の実行ファイル、関数に同梱）を子プロセスとして動かす
  （[Claude Agent SDKのADR](../adr/20261001040729-fraud-agent-on-claude-agent-sdk.md)）。
  - **プロセスの分担**：親（Node.jsのハンドラー）は、受信の検証、中継、子プロセスの起動を行い、認証情報を持つ。子（Claude Code）は、
    エージェントのループを回し、Bedrockを呼び、中継をMCPサーバーとして呼ぶ。
  - **中継**：分析のたびに、親が`startMcpRelay`（§6）で`127.0.0.1`の中継を立て、Claude Codeには`fraud`という名前のHTTPのMCPサーバーとして渡す。
    中継は、受けたメッセージを送信時の手順（§4）でfraud-mcpへ転送する。分析が終わったら閉じる。
  - **子プロセスに渡すもの**：環境変数は引き継がず、モデル用のroleの認証情報（§5）、リージョン、書き込める場所（`/tmp`）、Bedrockを使う設定だけを渡す。
    受け取ったJWT、受け渡されたセッション、chainのセッション、実行roleの認証情報は渡さない。モデル用のroleの認証情報は実行環境ごとに使い回し、
    期限の10分前に引き受け直す。
  - **子プロセスの制限**：組み込みのツール（Bash、Readなど）は無効にし、中継のツール（`mcp__fraud__*`）だけを許可なしで使わせる（それ以外は拒否）。
    設定ファイルを読まず、セッションを保存しない。Anthropicへの必須でない通信と自動更新を止める。
  - **モデル**：Claude Haiku 4.5を、日本国内の推論プロファイル（`jp.anthropic.claude-haiku-4-5-20251001-v1:0`、東京・大阪）で呼ぶ。
    補助的な処理に使う小さいモデルも同じにする。1回の分析のターンは最大8回。
  - **応答**：分析の結果と、ツールの呼び出しの記録（ツール名、引数、呼び出し先のHTTPステータス）を返す。記録は中継が知らせるメッセージから取る。
    エージェントが最後まで終わらなかったら502を返す。
  - **関数**：メモリは1024MB。成果物（展開後）は約246MBで、そのうち実行ファイルが約241MB。合成のときに大きさを確かめ、255,000,000バイトを
    超えたら失敗させる（zipの上限は250MiB）。超えたら、コンテナイメージに切り替える。
- **MCPの実装**：fraud-mcpはStreamable HTTPのステートレスなサーバーで、SSEを使わずJSONで応答する。ツールは`get_case`（case-service）と
  `get_account`（account-service）の2つで、呼び出し先のホップの結果（HTTPステータスを含む）をそのまま返す。認可の判断はしない。
  プロトコルの版は`2026-07-28`・`2025-11-25`・`2025-06-18`に応じる。
- **タイムアウト**：CloudFrontのオリジンの応答待ちは既定の上限の60秒で、bffのLambdaも60秒、fraud-agentは55秒とする。
  他のホップは30秒。
- **MCPの認可についての注記**：MCPの仕様では認可は任意で、HTTPではOAuthに従うことが推奨される。この参照実装のfraud-mcpはOAuthではなく、
  他のホップと同じ入口（実行roleとJWT）で守る。

## 9. CDKの構成

npmのワークスペースで次のように分ける。

| ディレクトリ | 内容 |
|---|---|
| `infra/` | CDKアプリ（単一のスタック`Gekko08App`） |
| `packages/authz-context/` | 受信側・送信側の共通部品（§6） |
| `services/<名前>/` | 各Lambdaのハンドラー（bff、case-service、account-service、entitlement-service、fraud-agent、fraud-mcp、pretoken） |
| `web/` | 静的なフロントエンド |
| `tests/` | シナリオテスト（§10） |

主なConstruct：

| Construct | 作るもの |
|---|---|
| `AuthFoundation` | Cognito User Pool（Essentials、マネージドログイン）、アプリクライアント、Pre Token Generation V2のLambda、OIDC provider、federated role。アプリクライアントには属性の書き込みを許さない |
| `Hop` | `NodejsFunction`（関数ごとの実行role）、Function URL（`AWS_IAM`）、入口のresource policy、必要ならchain用role。メモリ量とバンドルの設定を変えられる（fraud-agentは実行ファイルを同梱する） |
| `Hop#allowCaller(caller, { scope, purposes })` | 呼び出し元と呼び出し先をつなぐ。入口のresource policyへの追加、chain用roleの信頼とchain権限、JWTの発行の権限（宛先、scope、目的）、`sub`の対応表、呼び出し元の設定（URL、aud、scope） |
| `Bff` | bffの`NodejsFunction`とFunction URL、目的用のrole、セッションのテーブル、SSMのパラメータ（設定とシークレット）。`Bff#asCaller`で目的用のroleをchain用roleとして渡す |
| `WebFrontend` | CloudFront、S3（静的なフロントエンド）、bffのFunction URLへのOAC |
| `DemoData` | DynamoDBのテーブル（案件、口座、人事データ、権限マスタ）とデモ用データ |
| `OutboundFederationCheck` | デプロイ時の前提条件の確認と、JWTの発行者URLの取得（§11） |

Cognito User Poolのカスタム属性`custom:branch`は使わない。User Poolのスキーマから属性を消せないため、既存の環境との互換のために定義だけを残す。

## 10. テスト

振る舞いを確かめるシナリオテストは、デプロイしたスタックに対して実行し、要件のIDにひも付ける。

マネージドログインはブラウザを必要とするので、テストでは`ADMIN_USER_PASSWORD_AUTH`でIDトークンを得て、bffの`/api/callback`と同じ形の
セッションをテーブルに書き、そのcookieでCloudFrontからbffを呼ぶ。`ADMIN_USER_PASSWORD_AUTH`はIAMの権限
（`cognito-idp:AdminInitiateAuth`）がなければ呼べず、ブラウザからは使えない。

| 要件 | テストの内容 |
|---|---|
| FR-1 | 各ホップが正しいsubject・actor・目的・scopeを受け取る。宛先の違うJWT、改ざんしたJWT、JWTなし、期限切れのJWT、呼び出し元と`sub`の合わないJWT、目的やscopeのないJWTは401。不正なJWTは入口を通して送れないため、STSが実際に発行したJWTを改変し、ホップと同じ共通部品の検証に発行者の実際のJWKSで通して確かめる |
| FR-2 | 業務的なアクセス権のない案件や口座は拒否される。自己申告のヘッダーや引数で別のユーザーを名乗っても、結果が変わらない |
| FR-3 | chainの途中でSourceIdentityや目的を変えられない。定めていない目的を刻めない。新しいtagのキーを加えられない。目的に合わない下流のJWTや、宣言していないscopeを発行できない |
| FR-4 | 途中のホップを飛ばした呼び出しが403 |
| FR-5 | ブラウザに返す応答とcookieに、トークンも認証情報も含まれない |
| FR-6 | 1回のリクエストを、各ホップのログとCloudTrailでリクエストIDとユーザーから追える |
| FR-7 | エージェントが誘導されて他の支店の口座を要求しても拒否される。エージェントの分析では、支店長にも残高が返らない。自分の支店の案件は分析できる。モデルの判断は毎回変わりうるので、誘導されたかどうかではなく、誘導されても他の支店のデータや残高が応答に現れないことを確かめる |
| FR-8 | 人事データで所属を変えると、次のリクエストから結果が変わる |
| NFR-3 | 各ホップの処理時間（chain、JWTの発行、検証）を集計して公開する |
| SR-1 | 受け渡したchainのセッションで、どのホップも呼べない。内部のホップ以外を宛先に含むJWTを作れない |
| SR-2 | 許可していない主体（広い権限を持つroleを含む）が各ホップを呼ぶと403 |
| SR-3 | 各ホップのログに、認証情報・JWT・cookieが含まれない |

FR-6・SR-3・NFR-3のテストは、各ホップの構造化ログをCloudWatch Logsから読んで確かめる。FR-6のうちCloudTrailの確認は、イベントが届くまでに
最大15分ほどかかるため、`npm run test:scenario:cloudtrail`のときだけ実行する。CloudTrailのイベントは、`Username`（＝`RoleSessionName`＝リクエストID）で引ける。
NFR-3のテストは、集計結果を`tests/out-latency.json`（git管理外）に書く。

共通部品の単体テストは、要件のIDにはひも付けない。

## 11. 前提条件と制約

### デプロイの前提条件

- **IAMのアウトバウンドIDフェデレーション**：`GetWebIdentityToken`を使うには、アカウント単位で有効にしておく必要がある。
  アカウント全体の設定なので、参照実装は自動で有効にしない。カスタムリソース`OutboundFederationCheck`がデプロイ時に
  `GetOutboundWebIdentityFederationInfo`を呼び、無効ならデプロイを失敗させて有効化の手順（`EnableOutboundWebIdentityFederation`）を示す。
  有効なら、アカウント固有の発行者URL（`IssuerIdentifier`）を取得して、各ホップにJWTの`iss`として渡す。
- **Amazon Bedrockのモデル**：アカウントによっては、Claudeのモデルを使う前に利用の申請が必要になる。手順はREADMEに書く。
- **npmのレジストリ**：合成のときに、Claude Code（linux-arm64の実行ファイル）をnpmのレジストリから取得する。開発機の`node_modules`には、
  開発機のプラットフォーム向けしか入らないため。取得したものは一時ディレクトリに版ごとに置き、次からは使い回す。

### 呼び出し関係の制約

- ホップの呼び出し関係は循環させない。呼び出し元の環境変数が呼び出し先のFunction URLを参照するため、循環させるとCloudFormationで循環参照になる。
  循環が必要になった場合は、Function URLを環境変数ではなく実行時に解決する方式を検討する。

### 規模の上限

参照実装の規模（ホップ6つ）では、次のクォータには抵触しない。規模が大きくなったときに、どこが先に上限になるかの目安を示す（クォータは2026-09-30時点の文書による）。

| クォータ（既定値→上限） | 効く場所 | 上限の目安 |
|---|---|---|
| STSのリクエスト数：600件/秒（アカウント・リージョンごと、`AssumeRole`などで共有。引き上げはサポートに依頼） | bffの目的の刻印と、各ホップのchain | エージェントの経路では1リクエストで`AssumeRole`が5〜6回。アカウント全体でおよそ毎秒100〜120リクエスト |
| CloudFormationのリソース数：1スタック500個 | 1ホップで約8〜10個 | 単一スタックで40〜50ホップ前後 |
| Lambdaの環境変数：合計4KB | 受信側の`sub`の対応表 | 呼び出し元が十数個を超えるホップ |
| roleの信頼ポリシー：2,048文字→8,192文字 | chain用roleの信頼ポリシーに呼び出し元を列挙 | 呼び出し元10個前後（引き上げて40個前後） |
| roleの数：1,000→10,000 | 1ホップで2つ | 数百ホップ |
| roleのインラインポリシー：合計10,240文字 | chain用roleの権限（呼び出し先ごとに2つの文） | 呼び出し先が十数個 |
| Lambdaのresource policy：20KB | 入口のresource policy | 呼び出し元50個前後 |

`GetWebIdentityToken`のリクエスト数のクォータは文書に記載がない。

上限に近づいたときの対処の方向：

- STSのリクエスト数のクォータの引き上げを依頼する。それでも足りない規模では、複数のアカウントに分ける（要件定義では将来の拡張）。
- スタックを分ける。
- 受信側の`sub`の対応表を、命名規則による導出や、起動時に読む設定（SSM Parameter Storeなど）に置き換える。
- 信頼ポリシーで、呼び出し元の列挙を1つの文にまとめる。

この設計はroleと関数をARNで厳格に一致させている。ポリシーの大きさを抑えるために、次の書き方に切り替える選択肢もあるが、いずれもなりすましを防ぐ別の統制が必要になる。

| 書き方 | 代償 |
|---|---|
| 名前のパターンで一致させる（`ArnLike`） | そのパターンに合う名前のroleを作れる人は誰でも一致する。roleの作成をSCPやPermissions Boundaryで縛る必要がある。ARNを`Principal`に直接書く場合と違い、同じ名前での作り直しによるなりすましも防げない |
| roleのタグで一致させる（`aws:PrincipalTag`） | セッションタグが同じキーのroleのタグを上書きするため、`sts:TagSession`のキーの制限を誤ると呼び出し元が身元を偽れる。`iam:TagRole`の統制も必要 |
| 入口を関数のARNだけで一致させる（Principalを`*`とし、`lambda:SourceFunctionArn`とアカウントで絞る） | resource policyが公開と判定されうる。Lambdaの公開を制限する設定との関係は未確認 |
