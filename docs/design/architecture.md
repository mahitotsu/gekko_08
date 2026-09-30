# 設計書：参照実装の構成

参照実装の現在の構成を示す。判断の経緯と採用しなかった選択肢はADRに、満たすべきことは[要件定義](../requirements.md)にある。
実装やテストで問題が見つかったときの扱いは、[文書一覧の運用ルール](../README.md#運用ルール)に従う。

関連するADR：

- [多段伝播](../adr/20260930064314-multi-hop-authorization-context-propagation.md)：actorは実行role、subjectはSTSが署名したJWT
- [入口はBFF](../adr/20260930083437-entry-via-bff.md)
- [IdPはCognito User Pool](../adr/20260930091026-idp-cognito-user-pool.md)
- [ホップはLambdaとFunction URL、mTLSは使わない](../adr/20260930091257-lambda-function-url-without-mtls.md)
- [BFFの公開とセッション](../adr/20260930093744-bff-hosting-and-session.md)
- [実装言語はTypeScript](../adr/20260930093745-implementation-language-typescript.md)
- [エージェントとMCPサーバーもLambdaのホップ](../adr/20260930093746-agent-and-mcp-on-lambda.md)

## 1. 要件との対応

| 要件 | 満たす設計要素 |
|---|---|
| FR-1（subject・actor・audを確かめる） | 入口のresource policy（実行roleと関数）、JWTの検証（§4、§6） |
| FR-2（検証済みの値だけでABAC） | 受信側の共通部品のABAC。ヘッダーや引数、LLMの出力からユーザーを読まない（§6） |
| FR-3（ログイン時に確定し、変更できない） | Pre Token GenerationとSourceIdentity・transitive session tags、chain用roleの`aws:TagKeys`（§3、§5） |
| FR-4（ホップを飛ばせない） | 入口は直前のホップの実行roleだけを許可（§4、§5） |
| FR-5（パブリッククライアントに認証情報を持たせない） | BFFとセッションcookie（§3） |
| FR-6（処理を元のユーザーとリクエストに結びつけて追跡） | リクエストIDの引き継ぎ、構造化ログ、`RoleSessionName`（§7） |
| FR-7（デモ） | 不正検知シナリオ（§8） |
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
                                                  └──> fraud-agent ──> fraud-mcp
                                                          │
                                                          └──> Amazon Bedrock（Claude Haiku 4.5）
```

| 構成要素 | 役割 | 呼び出し元 | 呼び出し先 |
|---|---|---|---|
| bff | ログイン、セッション、最初のホップ | ブラウザ（CloudFront経由） | case-service、fraud-agent |
| case-service | 不正検知の案件と取引の参照 | bff、fraud-mcp | account-service |
| fraud-agent | 案件の分析を行うAIエージェント（MCPクライアント） | bff | fraud-mcp、Bedrock |
| fraud-mcp | エージェント向けのツールを提供するMCPサーバー | fraud-agent | case-service、account-service |
| account-service | 口座の参照（終端） | case-service、fraud-mcp | なし |

呼び出しの経路は2つある。

- **マイクロサービスの経路**：bff → case-service → account-service
- **エージェントの経路**：bff → fraud-agent → fraud-mcp → case-service または account-service

データはDynamoDBに置き、各サービスが自分の実行roleで読む（案件はcase-service、口座はaccount-service）。

## 3. ログインとセッション（bff）

### ログイン

1. ブラウザが`GET /api/login`を呼ぶ。bffは`state`とPKCEの`code_verifier`を作ってDynamoDBに保存し、`state`を結ぶcookie
   （`HttpOnly`・`Secure`・`SameSite=Lax`、短命）を付けて、Cognitoのマネージドログインへリダイレクトする。
2. Cognitoから`GET /api/callback`に戻る。bffは`state`をcookieと照合し、アプリクライアントのシークレット（SSM Parameter Store）を使って
   トークンエンドポイントでIDトークンとリフレッシュトークンを受け取る。
3. bffはセッションをDynamoDBに保存し、セッションID（256ビットの乱数）だけを入れたcookie（`HttpOnly`・`Secure`・`SameSite=Strict`）を返す。
   テーブルのキーはセッションIDのSHA-256にし、テーブルを読めてもcookieとして使える値が得られないようにする。
   cookieの名前には`__Host-`を付ける（`__Host-sid`、`__Host-login`）。

bffの設定（アプリクライアントのID、マネージドログインのドメイン、コールバックURL、federated roleのARN、呼び出し先）は、
SSM Parameter StoreのStringパラメータに置き、実行時に読む。環境変数にすると、bff→CloudFront→Cognitoのアプリクライアント
（コールバックURL）→federated role→case-serviceのchain用role→case-service→bffという循環参照になるため。
アプリクライアントのシークレットは、デプロイ時にカスタムリソースがSecureStringとして書く（CloudFormationはSecureStringを作れない）。

IDトークンには、Pre Token Generation V2トリガーが`https://aws.amazon.com/source_identity`（ユーザー識別子）と
`https://aws.amazon.com/tags`（`principal_tags`に`branch`、`transitive_tag_keys`に`branch`）を入れる。

### リクエストごとの処理

1. cookieのセッションIDでセッションを読む。IDトークンの期限が切れていれば、リフレッシュトークンで更新する。
2. リクエストIDを発行する（§7）。
3. IDトークンで`AssumeRoleWithWebIdentity`を呼び、bffのfederated roleのセッションを得る（`RoleSessionName`＝リクエストID）。
   このセッションにSourceIdentityと`branch`が刻まれる。
4. 共通部品で次のホップを呼ぶ（§4）。

### エンドポイント

| パス | 内容 |
|---|---|
| `GET /api/login`、`GET /api/callback`、`POST /api/logout` | ログインとログアウト |
| `GET /api/me` | ログイン中のユーザー（表示用。認証情報は含めない） |
| `GET /api/cases/{id}/summary` | マイクロサービスの経路 |
| `POST /api/agent` | エージェントの経路（案件IDを渡して分析させる） |

フロントエンドは、POSTの本文のSHA-256を`x-amz-content-sha256`ヘッダーに付ける（CloudFrontのOACの要件）。

## 4. ホップ間の呼び出し

呼び出し元は、1回の呼び出しで次のものを送る。

| 送るもの | 載せ方 | 受信側での使い道 |
|---|---|---|
| SigV4署名 | 呼び出し元の**実行role**で署名 | 入口のIAMが呼び出し元（actor）を確かめる |
| JWT | `x-authz-context`ヘッダー。`aud`は`<スタック名>:<ホップ名>` | アプリがsubject（誰の代理か、`branch`）とaud（自分宛てか）を確かめる |
| chainのセッション | `x-authz-session`ヘッダー（呼び出し先がchain用roleを持つ場合だけ）。認証情報のJSONをbase64urlにしたもの | 受信側が次のホップ宛てのJWTを作るために、自分のchain用roleへchainする |
| リクエストID | `x-request-id`ヘッダー | 追跡（§7） |

呼び出し元での手順：

1. 受け取ったchainのセッション（bffではfederated roleのセッション）で、自分のchain用roleにchainする（`DurationSeconds`＝900、
   `RoleSessionName`＝リクエストID）。bffはfederated roleのセッションをそのまま使う。
2. そのセッションで`GetWebIdentityToken`を呼び、`aud`＝呼び出し先のJWTを作る（`DurationSeconds`＝300、`SigningAlgorithm`＝`ES384`）。
3. 自分の実行roleの認証情報で署名して、呼び出し先のFunction URLを呼ぶ。

受信側での手順は§6の共通部品が行う。

### chain用role

| role | 使うホップ | chainを許す相手 | 発行できるJWTの宛先 |
|---|---|---|---|
| bffのfederated role | bff | Cognito（OIDC provider） | case-service、fraud-agent |
| fraud-agentのchain用role | fraud-agent | bffのfederated role | fraud-mcp |
| fraud-mcpのchain用role | fraud-mcp | fraud-agentのchain用role | case-service、account-service |
| case-serviceのchain用role | case-service | bffのfederated role、fraud-mcpのchain用role | account-service |

account-serviceは呼び出し先を持たないので、chain用roleを持たず、chainのセッションも受け取らない。

## 5. IAMの設計

### roleの一覧

| 種類 | 個数 | 権限 |
|---|---|---|
| 実行role | Lambda関数ごとに1つ | 自分のデータ（DynamoDB）へのアクセス、ログ出力。fraud-agentはBedrockの呼び出し、bffはセッションのテーブルとSSMのパラメータ。ホップの呼び出しには権限を付けない（呼び出し先のresource policyで許可する） |
| chain用role | §4の表のとおり | 次のchain用roleへの`sts:AssumeRole`・`sts:TagSession`・`sts:SetSourceIdentity`と、許された宛先への`sts:GetWebIdentityToken`だけ |

### chain用roleの信頼ポリシーのひな形

```json
{
  "Statement": [
    { "Effect": "Allow", "Principal": { "AWS": ["<呼び出し元のchain用role>"] }, "Action": ["sts:AssumeRole", "sts:SetSourceIdentity"] },
    {
      "Effect": "Allow", "Principal": { "AWS": ["<呼び出し元のchain用role>"] }, "Action": "sts:TagSession",
      "Condition": { "ForAllValues:StringEquals": { "aws:TagKeys": ["branch"] } }
    }
  ]
}
```

bffのfederated roleは、Cognitoを指すOIDC providerをPrincipalとし、`aud`＝アプリクライアントのIDで絞る。

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

## 6. 受信側の共通部品（`packages/authz-context`）

各ホップのLambdaは、共通部品を通して呼び出しを受け、次のホップを呼ぶ。業務のコードは認証情報もJWTも直接扱わない。

**受信時**

1. `x-authz-context`のJWTを検証する。`iss`＝自アカウントのSTS発行者、`aud`＝自分、`exp`、署名（JWKSはメモリにキャッシュし、未知の`kid`のときだけ取り直す）。
2. `sub`が「入口のIAMが確かめた呼び出し元の実行role」に対応するchain用roleであることを確かめる。対応表はデプロイ時に環境変数で渡す。
3. `https://sts.amazonaws.com/`名前空間の`source_identity`と`principal_tags`から、subject（ユーザー識別子と`branch`）を取り出して業務のコードに渡す。
   ヘッダーや引数に含まれるユーザー情報は使わない。
4. 検証に失敗したら401を返す。

**ABAC**：業務のコードは、共通部品が渡したsubjectだけを使って判定する（例：案件や口座の`branch`がsubjectの`branch`と一致するときだけ返す）。

**送信時**：§4の手順を行う。STSクライアントとJWKSはLambdaの実行環境ごとに使い回す。

**ログ**：リクエストID、ホップ名、呼び出し元の実行role（actor）、subject、JWTの`sub`、判定結果、処理時間を構造化ログに出す。
認証情報、JWT、cookieはログに出さない。

## 7. 追跡（FR-6）

- bffがリクエストごとにIDを発行し、`x-request-id`で全ホップに引き継ぐ。
- 各ホップの構造化ログに、リクエストIDとsubjectを出す（§6）。
- `AssumeRoleWithWebIdentity`と各chainの`RoleSessionName`をリクエストIDにする。CloudTrailの`AssumeRole`・`GetWebIdentityToken`のイベントには、
  セッション名（＝リクエストID）とSourceIdentity（＝ユーザー識別子）が記録される。
- ログとCloudTrailを、リクエストIDとユーザー識別子で突き合わせられる。

## 8. デモのシナリオ（FR-7）

記事「プロンプトインジェクションでAIエージェントは騙せたが、認可は揺るがなかった」の不正検知シナリオを流用する。

- **ユーザー**：yamada（`branch`＝tokyo）、tanaka（`branch`＝osaka）
- **データ**：案件と取引（case-service）、口座（account-service）。それぞれ`branch`を持つ。
- **マイクロサービスの経路**：yamadaが自分の支店の案件の要約を開くと、case-serviceが口座の情報をaccount-serviceから取得して返す。
  他の支店の案件は、case-serviceのABACで拒否される。
- **エージェントの経路**：yamadaが案件の分析をfraud-agentに依頼する。案件の取引メモには、他の支店の口座（999）の参照を促す文言を混ぜておく。
  エージェントがそれに誘導されてfraud-mcpのツールで口座999を要求しても、account-serviceのABACで拒否される。
- **エージェントとLLM**：fraud-agentはBedrockのConverse APIでClaude Haiku 4.5を呼び、ツールはfraud-mcpから取得する（MCPのtools/list・tools/call）。
  モデルに渡すのは業務データとツールの結果だけで、ヘッダーや認証情報は渡さない。
- **MCPの認可についての注記**：MCPの仕様では認可は任意で、HTTPではOAuthに従うことが推奨される。この参照実装のfraud-mcpはOAuthではなく、
  他のホップと同じ入口（実行roleとJWT）で守る。

## 9. CDKの構成

npmのワークスペースで次のように分ける。

| ディレクトリ | 内容 |
|---|---|
| `infra/` | CDKアプリ（単一のスタック`Gekko08App`） |
| `packages/authz-context/` | 受信側・送信側の共通部品（§6） |
| `services/<名前>/` | 各Lambdaのハンドラー（bff、case-service、account-service、fraud-agent、fraud-mcp、pretoken） |
| `web/` | 静的なフロントエンド |
| `tests/` | シナリオテスト（§10） |

主なConstruct：

| Construct | 作るもの |
|---|---|
| `AuthFoundation` | Cognito User Pool（Essentials、マネージドログイン）、アプリクライアント、Pre Token Generation V2のLambda、OIDC provider、bffのfederated role。アプリクライアントには属性の書き込みを許さない |
| `Hop` | `NodejsFunction`（関数ごとの実行role）、Function URL（`AWS_IAM`）、入口のresource policy、必要ならchain用role |
| `Hop#allowCaller(caller)` | 呼び出し元と呼び出し先をつなぐ。入口のresource policyへの追加、chain用roleの信頼とchain権限、JWTの宛先の許可、`sub`の対応表。bffは`Bff#asCaller`でfederated roleをchain用roleとして渡す |
| `Bff` | bffの`NodejsFunction`とFunction URL、セッションのテーブル、SSMのパラメータ（設定とシークレット） |
| `WebFrontend` | CloudFront、S3（静的なフロントエンド）、bffのFunction URLへのOAC |
| `DemoData` | DynamoDBのテーブルとデモ用データ |
| `OutboundFederationCheck` | デプロイ時の前提条件の確認と、JWTの発行者URLの取得（§11） |

## 10. テスト

振る舞いを確かめるシナリオテストは、デプロイしたスタックに対して実行し、要件のIDにひも付ける。

マネージドログインはブラウザを必要とするので、テストでは`ADMIN_USER_PASSWORD_AUTH`でIDトークンを得て、bffの`/api/callback`と同じ形の
セッションをテーブルに書き、そのcookieでCloudFrontからbffを呼ぶ。`ADMIN_USER_PASSWORD_AUTH`はIAMの権限
（`cognito-idp:AdminInitiateAuth`）がなければ呼べず、ブラウザからは使えない。

| 要件 | テストの内容 |
|---|---|
| FR-1 | 各ホップが正しいsubject・actorを受け取る。宛先の違うJWT、改ざんしたJWT、JWTなしは401 |
| FR-2 | 自己申告のヘッダーや引数で別のユーザーを名乗っても、結果が変わらない |
| FR-3 | chainの途中でSourceIdentityや`branch`を変えられない。新しいtagのキーを追加できない |
| FR-4 | 途中のホップを飛ばした呼び出しが403 |
| FR-5 | ブラウザに返す応答とcookieに、トークンも認証情報も含まれない |
| FR-6 | 1回のリクエストを、各ホップのログとCloudTrailでリクエストIDとユーザーから追える |
| FR-7 | エージェントが誘導されて他の支店の口座を要求しても拒否される。自分の支店の案件は分析できる |
| NFR-3 | 各ホップの処理時間（chain、JWTの発行、検証）を集計して公開する |
| SR-1 | 受け渡したchainのセッションで、どのホップも呼べない |
| SR-2 | 許可していない主体（広い権限を持つroleを含む）が各ホップを呼ぶと403 |
| SR-3 | 各ホップのログに、認証情報・JWT・cookieが含まれない |

共通部品の単体テストは、要件のIDにはひも付けない。

## 11. 前提条件と制約

### デプロイの前提条件

- **IAMのアウトバウンドIDフェデレーション**：`GetWebIdentityToken`を使うには、アカウント単位で有効にしておく必要がある。
  アカウント全体の設定なので、参照実装は自動で有効にしない。カスタムリソース`OutboundFederationCheck`がデプロイ時に
  `GetOutboundWebIdentityFederationInfo`を呼び、無効ならデプロイを失敗させて有効化の手順（`EnableOutboundWebIdentityFederation`）を示す。
  有効なら、アカウント固有の発行者URL（`IssuerIdentifier`）を取得して、各ホップにJWTの`iss`として渡す。
- **Amazon Bedrockのモデル**：アカウントによっては、Claudeのモデルを使う前に利用の申請が必要になる。手順はREADMEに書く。

### 呼び出し関係の制約

- ホップの呼び出し関係は循環させない。呼び出し元の環境変数が呼び出し先のFunction URLを参照するため、循環させるとCloudFormationで循環参照になる。
  循環が必要になった場合は、Function URLを環境変数ではなく実行時に解決する方式を検討する。

### 規模の上限

参照実装の規模（ホップ5つ）では、次のクォータには抵触しない。規模が大きくなったときに、どこが先に上限になるかの目安を示す（クォータは2026-09-30時点の文書による）。

| クォータ（既定値→上限） | 効く場所 | 上限の目安 |
|---|---|---|
| STSのリクエスト数：600件/秒（アカウント・リージョンごと、`AssumeRole`などで共有。引き上げはサポートに依頼） | 各ホップがリクエストごとにchainする | エージェントの経路では1リクエストで`AssumeRole`が3〜4回。アカウント全体でおよそ毎秒150〜200リクエスト |
| CloudFormationのリソース数：1スタック500個 | 1ホップで約8〜10個 | 単一スタックで40〜50ホップ前後 |
| Lambdaの環境変数：合計4KB | 受信側の`sub`の対応表 | 呼び出し元が十数個を超えるホップ |
| roleの信頼ポリシー：2,048文字→8,192文字 | chain用roleの信頼ポリシーに呼び出し元を列挙 | 呼び出し元10個前後（引き上げて40個前後） |
| roleの数：1,000→10,000 | 1ホップで2つ | 数百ホップ |
| roleのインラインポリシー：合計10,240文字 | chain用roleの権限 | 呼び出し先が数十個でも問題ない |
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
