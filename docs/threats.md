# 脅威の総点検

既知の攻撃を一覧にし、この参照実装がそれぞれをどの層で止めるか、その証拠（テスト、検証記録）は何か、止めないものは何かを示す。
侵害された要素ごとの影響の要約は[設計ガイド§5](guide.md#5-この構成が守らないもの)に、構成の詳細は[設計書](design/architecture.md)にある。

> 下書き（2026-10-03（UTC））。攻撃の範囲と、「防ぐ（テストなし）」の行にテストを足す順番は、これから決める。

## 読み方

| 列 | 内容 |
|---|---|
| ID | 攻撃の識別子。分類の頭文字と番号 |
| 攻撃 | 攻撃者がしようとすること |
| 攻撃者の前提 | 攻撃者が持っている能力。「外部」はインターネットから、「アカウント内」は同じAWSアカウントの、許可していない主体 |
| 止める層 | 入口のIAM、STS（IAMの発行条件）、受信側の検証（共通部品）、業務のコード、BFF、止めない |
| 証拠 | 止めることを確かめるテスト（ファイルとテストの名前）か検証記録 |
| 状態 | **防ぐ（テストあり）**、**防ぐ（テストなし）**（設計とコードでは止めるが、確かめるテストがない）、**防がない**（設計上の範囲外） |
| 出典 | 攻撃を拾った外部の分類（[出典](#出典)） |

テストのファイルは、`scenario/`が[tests/scenario/](../tests/scenario/)のシナリオテスト（デプロイしたスタックに対して実行する）、`inbound`などが
[packages/authz-context/test/](../packages/authz-context/test/)、`hop`と`purpose-role`が[infra/test/](../infra/test/)、`reconcile`が
[services/audit-service/test/](../services/audit-service/test/)の単体テストである。

## 集計

| 状態 | 件数 |
|---|---|
| 防ぐ（テストあり） | 42 |
| 防ぐ（テストなし） | 9 |
| 防がない | 11 |
| 計 | 62 |

## A. ユーザーのなりすまし（誰の代理か）

| ID | 攻撃 | 攻撃者の前提 | 止める層 | 証拠 | 状態 | 出典 |
|---|---|---|---|---|---|---|
| A-1 | ヘッダーや引数、本文で別のユーザーを名乗る | 外部（ログイン済み）、途中のホップ | 受信側の検証：ユーザーはJWTの`source_identity`だけから取り、ヘッダーや引数は使わない | `scenario/microservice-path`「FR-2: ブラウザが別のユーザーや目的を自己申告しても結果は変わらない」 | 防ぐ（テストあり） | API2、ASI03 |
| A-2 | プロンプトインジェクションで、LLMにユーザー名や「本部」を名乗らせる | データに文言を混ぜられる | 受信側の検証：LLMの出力からユーザーを読まない | `scenario/agent-path`「エージェントが他の支店の口座を要求しても、account-serviceが拒否する」 | 防ぐ（テストあり） | ASI01、ASI03 |
| A-3 | JWTの本文（ユーザー、目的、scope）を書き換える | JWTを手に入れた | 受信側の検証：STSの署名 | `scenario/token-verification`「本文を改ざんしたJWT（別のユーザー、目的、scopeに書き換え）は401」、`inbound`「改ざんしたJWTを拒否する」 | 防ぐ（テストあり） | RFC 9700 |
| A-4 | 署名を外す（`alg=none`）、署名を書き換える | JWTを手に入れた | 受信側の検証：ES384の署名だけを受け付ける | `scenario/token-verification`「署名なし（alg=none）に書き換えたJWTは401」「署名を改ざんしたJWTは401」 | 防ぐ（テストあり） | RFC 8725 |
| A-5 | 別の発行者（自分の鍵）で署名したJWTを渡す | 外部 | 受信側の検証：`iss`を自アカウントのSTSに限り、その発行者の鍵だけで検証する | `inbound`「発行者の違うJWTを拒否する」 | 防ぐ（テストあり） | RFC 8725 |
| A-6 | 鍵の種類の取り違え（公開鍵をHMACの鍵として使うなど）で署名を偽る | 外部 | 受信側の検証：アルゴリズムをES384に固定する | （なし） | 防ぐ（テストなし） | RFC 8725 |
| A-7 | chainの途中でSourceIdentityを別のユーザーに変える | 途中のホップ | STS：SourceIdentityは一度刻むと変えられない | `scenario/microservice-path`「chainでSourceIdentityを変えられない」 | 防ぐ（テストあり） | ASI03 |
| A-8 | 別のIdP（別のUser Pool、外部のOIDC、同じUser Poolの別のアプリクライアント）のトークンで、同じSourceIdentityを持つfederated roleのセッションを作る | 別のIdPを持つ | STS：federated roleの信頼ポリシーが、このUser PoolのOIDC providerと`aud`だけを許す | （なし。信頼ポリシーの単体テストがない） | 防ぐ（テストなし） | RFC 9700（mix-up） |
| A-9 | 別のIdPを信頼する自分のroleでSourceIdentityを刻み、そのセッションでJWTを作って渡す | アカウント内でroleを作れる | 受信側の検証：JWTの`sub`が、入口を通った呼び出し元のchain用roleと一致すること。STS：目的を刻むroleとchain用roleは、決まったroleだけを信頼する | `scenario/token-verification`「JWTを作ったroleが、入口を通った呼び出し元のchain用roleと違えば401」 | 防ぐ（テストあり） | ASI03 |
| A-10 | ログインしていないユーザーになりすます | BFFを乗っ取った | STS：federated roleは、Cognitoが署名したIDトークンでしか引き受けられない | （なし） | 防ぐ（テストなし） | — |
| A-11 | ログイン中のユーザーとして振る舞う | BFFを乗っ取った | 止めない（BFFは信頼の起点。guide §5） | — | 防がない | — |
| A-12 | Pre Token Generationの関数やUser Poolの設定を改ざんし、任意のSourceIdentityを入れる | 設定を変えられる | 止めない（AWSは値の正しさを検証しない） | — | 防がない | — |
| A-13 | IAMの信頼ポリシーを書き換え、別のIdPや自分のroleを信頼させる | アカウントの管理者 | 止めない（各ホップのJWTには元のIdPが残らない。境界はアカウントの分離やSCPで作る） | — | 防がない | — |

## B. 呼び出し元のなりすまし（どのサービスから来たか）

| ID | 攻撃 | 攻撃者の前提 | 止める層 | 証拠 | 状態 | 出典 |
|---|---|---|---|---|---|---|
| B-1 | 署名なしでホップのFunction URLを呼ぶ | 外部 | 入口のIAM：`AWS_IAM`認証 | `scenario/microservice-path`「SR-2: 署名のない呼び出しは拒否される」 | 防ぐ（テストあり） | API2 |
| B-2 | 許可していない主体（広い権限を持つroleを含む）で署名して呼ぶ | アカウント内 | 入口のIAM：許可した実行role以外をDenyする | `scenario/microservice-path`「SR-2: 許可していない主体はcase-serviceと属性サービスを呼べない」、`hop`「入口：Function URLはAWS_IAMで、許可した呼び出し元の実行role以外をDenyする」 | 防ぐ（テストあり） | API5 |
| B-3 | 許可された実行roleを持つ、別の関数から呼ぶ | 同じ実行roleを使う関数を置ける | 入口のIAM：呼び出し元の実行roleのDeny（`lambda:SourceFunctionArn`） | `hop`「呼び出し元の実行role：許可した呼び出し元の関数以外からの呼び出しをDenyする」、[検証](../experiments/source-function-arn/RESULTS.md) | 防ぐ（テストあり） | — |
| B-4 | 途中のホップを飛ばして、奥のホップを直接呼ぶ | 正しい宛先のJWTを持つ | 入口のIAM：直前のホップの実行roleだけを許可する | `scenario/microservice-path`「FR-4・SR-2: 正しい宛先のJWTを持っていても、直前のホップ以外（テストを実行する主体）はcase-serviceを飛ばしてaccount-serviceを呼べない」 | 防ぐ（テストあり） | ASI03 |
| B-5 | 受け渡されたchainのセッションで署名して呼ぶ | セッションが漏れた | 入口のIAM：chain用roleには呼び出しの許可がない | `scenario/microservice-path`「SR-1: 受け渡したchainのセッションで署名しても、どのホップも呼べない」 | 防ぐ（テストあり） | RFC 9700 |
| B-6 | 実行roleの認証情報と受け渡されたセッションの両方を持ち出し、別の場所から呼ぶ | 実行環境を乗っ取った | 止めない（関数のARNは認証情報に刻まれ、持ち出しても同じ関数として扱われる） | [検証](../experiments/source-function-arn/RESULTS.md) | 防がない | RFC 9700 |
| B-7 | 通信路で署名済みの呼び出しを盗み見て、署名の許容時間（約5分）の中で再送する | 通信路を盗み見られる | 止めない（HTTPSの保護に任せる） | — | 防がない | RFC 9700 |

## C. トークンの使い回しと持ち出し

| ID | 攻撃 | 攻撃者の前提 | 止める層 | 証拠 | 状態 | 出典 |
|---|---|---|---|---|---|---|
| C-1 | あるホップ宛てのJWTを、別のホップに渡す（宛先の取り違え、トークンの素通し） | 途中のホップ | 受信側の検証：`aud`が自分であること | `scenario/token-verification`「宛先の違うJWT（case-service宛てをaccount-serviceに渡す）は401」、`inbound`「宛先の違うJWTを拒否する」 | 防ぐ（テストあり） | RFC 8693、MCP |
| C-2 | 内部のホップと外部の宛先を混ぜたJWTを作り、外部に持ち出す | セッションが漏れた | STS：宛先を`ForAllValues`＋`Null`で内部のホップに限る | `scenario/microservice-path`「SR-1: 受け渡したchainのセッションで、内部のホップ以外を宛先に含むJWTを作れない」、`hop`、[検証](../experiments/scope-tags/RESULTS.md)（E1-7） | 防ぐ（テストあり） | RFC 8693 |
| C-3 | 期限の切れたJWTを使う | JWTを手に入れた | 受信側の検証：`exp` | `scenario/token-verification`「期限の切れたJWTは401」 | 防ぐ（テストあり） | RFC 9700 |
| C-4 | 有効期限内（5分）のJWTを、同じ宛先に再送する | JWTと、直前のホップの実行roleの署名を持つ | 止めない（`jti`の使用済みの記録は持たない） | — | 防がない | RFC 9700 |
| C-5 | 別のリクエストのJWTを、このリクエストIDで送る | 途中のホップ | 受信側の検証：JWTに刻まれたリクエストIDとヘッダーの照合 | `scenario/token-verification`「JWTに刻まれたリクエストIDと違うリクエストIDで届いたら401（FR-6）」、`inbound` | 防ぐ（テストあり） | RFC 8693 |
| C-6 | JWTや受け渡すセッションを、ログやトレースから盗む | ログやトレースを読める | 共通部品：認証情報をログにもスパンにも出さない | `scenario/observability`「テスト中に出たログのすべてに、認証情報のパターンが現れない」、`scenario/tracing`「2つのトレースのすべてのスパンに、認証情報のパターンが現れない」 | 防ぐ（テストあり） | RFC 9700 |
| C-7 | 監査の応答から認証情報を得る（`AssumeRole`の応答にはアクセスキーが入る） | 監査担当 | 監査サービス：突き合わせの項目だけを取り出す | `reconcile`「SR-3: AssumeRoleの応答の認証情報もARNも取り出さない」 | 防ぐ（テストあり） | — |

## D. 委任の範囲の拡大

| ID | 攻撃 | 攻撃者の前提 | 止める層 | 証拠 | 状態 | 出典 |
|---|---|---|---|---|---|---|
| D-1 | 宣言していないscopeを付けたJWTを作る | 途中のホップ | STS：宣言したscopeだけを許す | `scenario/microservice-path`「宣言していないscopeは付けられない」 | 防ぐ（テストあり） | API5、ASI03 |
| D-2 | 案件を開くだけのリクエストの途中で、下流に凍結の解除を頼む（キャッシュカード詐欺盗） | 途中のホップ | STS：目的の制限があるscopeは、許した目的のリクエストでだけ発行する | `scenario/microservice-path`「目的の制限があるscope（解除）は、案件を開くリクエストのcase-serviceのセッションでは発行できない」 | 防ぐ（テストあり） | ASI03 |
| D-3 | エージェントのリクエストの途中で、共有のホップに凍結の解除を頼ませる | エージェントか途中のホップ | STS：同上 | `scenario/unfreeze`「エージェントのリクエストで、共有のホップ（fraud-mcpから呼ばれたcase-service）のセッションは、account-service宛ての解除のJWTを発行できない」 | 防ぐ（テストあり） | ASI02、ASI03 |
| D-4 | chainで目的を上書きする | 途中のホップ | STS：transitive tagは上書きできない | `scenario/microservice-path`「chainで目的を上書きできない」、`scenario/unfreeze`「エージェントのリクエストの途中で、目的を解除のリクエストに変えられない」 | 防ぐ（テストあり） | ASI03 |
| D-5 | 定めていない目的を刻む | BFFを乗っ取った | STS：目的を刻むroleが、目的の値を一覧に限る | `scenario/microservice-path`「定めていない目的は刻めない」、`purpose-role` | 防ぐ（テストあり） | — |
| D-6 | chainで新しいtagのキー（`role`など）を加え、受信側に権限と誤解させる | 途中のホップ | STS：chain用roleの信頼が、tagのキーを`purpose`と`requestId`に限る | `scenario/microservice-path`「chainで新しいtagのキーを加えられない」 | 防ぐ（テストあり） | — |
| D-7 | リクエストIDを変え、監査で自分の操作を追えなくする | 途中のホップ | STS：chainのセッション名を刻まれたリクエストIDに限る。受信側の検証：ヘッダーとJWTの照合 | `scenario/microservice-path`「chainのセッション名を、刻まれたリクエストIDと違う値にできない」「chainでリクエストIDのtagを上書きできない」 | 防ぐ（テストあり） | — |
| D-8 | IAMの設定の誤りで発行された、許していないscopeを受け付けさせる | IAMの設定が誤っている | 受信側の検証：提供側の定義との照合 | `inbound`「提供側の定義にないscopeを拒否する」「目的の制限があるscopeは、許された目的と呼び出し元のときだけ受け付ける」 | 防ぐ（テストあり） | — |
| D-9 | IAMの条件の書き方の誤り（`ForAnyValue`、Denyの欠落、tagのキーの制限の欠落など）を突く | IAMの設定が誤っている | 単体テスト：条件を壊したテンプレートを見逃さない | `hop`「条件を壊したテンプレートを見逃さない」、`purpose-role`「条件を壊したテンプレートを見逃さない」 | 防ぐ（テストあり） | — |

## E. 業務上のアクセス権（オブジェクト単位の認可）

| ID | 攻撃 | 攻撃者の前提 | 止める層 | 証拠 | 状態 | 出典 |
|---|---|---|---|---|---|---|
| E-1 | 他の支店の案件や口座のIDを指定して読む | 外部（ログイン済み） | 業務のコード：属性サービスの所属と比べる | `scenario/microservice-path`「他の支店の案件は、case-serviceが業務上のアクセス権で拒否する」 | 防ぐ（テストあり） | API1 |
| E-2 | 権限のない役職で、影響の大きい操作をする | 外部（ログイン済み） | 業務のコード：権限マスタ | `scenario/unfreeze`「担当者（osaka）は、自分の支店の口座でも、解除の権限がないので解除できない」 | 防ぐ（テストあり） | API5 |
| E-3 | 他人のアクセス権を属性サービスに問い合わせる | 途中のホップ、エージェント | 属性サービス：JWTのsubject本人の分だけを返し、相手を引数に取らない | （なし） | 防ぐ（テストなし） | API1 |
| E-4 | 異動や権限の剥奪のあとも、古い権限で操作する | 外部（ログイン済み） | 属性サービス：判定のたびに読む | `scenario/entitlements`「支店長をtokyoからosakaへ異動させると、同じセッションのまま、次のリクエストから結果が変わる」 | 防ぐ（テストあり） | — |
| E-5 | 属性サービスのデータを書き換え、自分に権限を与える | データを書き換えられる | 止めない。ただし委任の範囲は広がらない（エージェントのリクエストで解除はできない） | — | 防がない | — |
| E-6 | 業務のコードの判定の誤り（口座や金額の単位）を突く | 外部（ログイン済み） | 止めない（IAMが強制するのは、呼び出し元・呼び出し先・scope・目的の組み合わせまで） | — | 防がない | API1 |

## F. エージェントとMCP

| ID | 攻撃 | 攻撃者の前提 | 止める層 | 証拠 | 状態 | 出典 |
|---|---|---|---|---|---|---|
| F-1 | プロンプトインジェクションで、エージェントに凍結を解除させる | データに文言を混ぜられる | STS：fraud-mcpはaccount-serviceに`account:read`しか付けられない | `scenario/agent-path`「エージェントが凍結の解除を試みても、account-serviceが拒否し、口座は凍結されたまま」 | 防ぐ（テストあり） | ASI01、ASI02 |
| F-2 | プロンプトインジェクションで、他の支店のデータを応答に出させる | データに文言を混ぜられる | 業務のコード | `scenario/agent-path`「エージェントの応答に、他の支店の口座のデータが含まれない」 | 防ぐ（テストあり） | ASI01 |
| F-3 | MCPサーバーに、受け取ったトークンをそのまま下流へ渡させる（トークンの素通し） | エージェントか途中のホップ | 受信側の検証：JWTは宛先ごとに作り直し、`aud`を確かめる（C-1） | `scenario/token-verification`「宛先の違うJWT（case-service宛てをaccount-serviceに渡す）は401」 | 防ぐ（テストあり） | MCP |
| F-4 | 子プロセス（Claude Code）に任意のコードを実行させ、親の認証情報を読む | データに文言を混ぜられる | fraud-agent：組み込みのツールを無効にし、中継のツールだけを許す。委任に使う認証情報を子プロセスに渡さない | （なし） | 防ぐ（テストなし） | ASI05 |
| F-5 | プロンプトや業務データ、注入された文言をトレースに残させる | データに文言を混ぜられる | fraud-agent：本文を記録させない設定 | `scenario/tracing`「プロンプト、業務データ、ツールの結果は、どのスパンにも記録されない（Claude Codeのスパンを含む）」 | 防ぐ（テストあり） | — |
| F-6 | 子プロセスから、トレースの受け口に偽のスパンを書き込む | 子プロセスで任意のコードを実行できる | 止めない（guide §5） | — | 防がない | — |
| F-7 | ユーザーの権限と委任の範囲の中で、エージェントに誤った操作をさせる（還付金詐欺） | データに文言を混ぜられる | 止めない。目的とscopeで範囲を狭めておく | — | 防がない | ASI01 |

## G. BFFとブラウザ

| ID | 攻撃 | 攻撃者の前提 | 止める層 | 証拠 | 状態 | 出典 |
|---|---|---|---|---|---|---|
| G-1 | XSSなどで、ブラウザからトークンやAWSの認証情報を盗む | ブラウザで任意のスクリプトを動かせる | BFF：ブラウザにはセッションIDの`HttpOnly`のcookieだけを渡す | `scenario/microservice-path`「/api/meはユーザー名と、属性サービスから得た所属・役職だけを返し、トークンもAWSの認証情報も含まない」「ログインのリダイレクトで付くcookieはHttpOnlyで、トークンを含まない」 | 防ぐ（テストあり） | RFC 9700 |
| G-2 | 別のサイトから、ログイン中のユーザーに操作させる（CSRF） | ユーザーに別のサイトを開かせる | BFF：セッションのcookieは`SameSite=Strict`。CloudFrontのOACが、POSTに本文のハッシュのヘッダーを求める | （なし） | 防ぐ（テストなし） | API2 |
| G-3 | ログインの`state`を偽る、使い回す（ログインCSRF） | ユーザーに細工したリンクを開かせる | BFF：`state`をcookieと照合し、1回で消す | （なし） | 防ぐ（テストなし） | RFC 9700 |
| G-4 | 認可コードを横取りして交換する | リダイレクトのURLを盗み見る | BFF：PKCEとクライアントシークレット | （なし） | 防ぐ（テストなし） | RFC 9700 |
| G-5 | 攻撃者が用意したセッションIDを使わせる（セッションの固定） | ユーザーのcookieを設定できる | BFF：ログインのたびに新しいセッションIDを作る | （なし） | 防ぐ（テストなし） | — |
| G-6 | セッションなしで、bffに最初のホップを呼ばせる | 外部 | BFF | `scenario/microservice-path`「セッションcookieがなければ401」 | 防ぐ（テストあり） | API2 |
| G-7 | ログアウトしたあとのセッションを使う | cookieを盗んだ | BFF：ログアウトでセッションを消す | `scenario/microservice-path`「ログアウトするとセッションが無効になり、cookieが消える」 | 防ぐ（テストあり） | — |
| G-8 | ブラウザから`traceparent`を送り、他人のトレースに紛れ込ませる | 外部（ログイン済み） | BFF：ブラウザの`traceparent`を使わない | `scenario/tracing`「ブラウザから届いたtraceparentは引き継がず、bffで新しいトレースを始める」 | 防ぐ（テストあり） | — |
| G-9 | ブラウザから目的を指定して、許されていない操作の目的を刻ませる | 外部（ログイン済み） | BFF：目的は経路から決め、ブラウザから受け取らない | `scenario/microservice-path`「FR-2: ブラウザが別のユーザーや目的を自己申告しても結果は変わらない」 | 防ぐ（テストあり） | — |

## H. 監査と追跡

| ID | 攻撃 | 攻撃者の前提 | 止める層 | 証拠 | 状態 | 出典 |
|---|---|---|---|---|---|---|
| H-1 | ホップのログに、実際と違う目的やscopeを書く | 途中のホップ | 監査サービス：CloudTrail（AWSの記録）と突き合わせる | `reconcile`「ログに書かれた値がSTSの記録と違えば、どの項目がどう違うかを返す」、`scenario/audit`「CloudTrailが届くと、bffと各ホップの記録がすべてAWSの記録と一致する」 | 防ぐ（テストあり） | — |
| H-2 | ヘッダーのリクエストIDを偽り、拒否された呼び出しを別のリクエストの記録に紛れ込ませる | 途中のホップ | 監査サービス：JWTに刻まれた値で振り分ける | `reconcile`「本当のリクエスト（刻まれた値）の下に、偽ったリクエストIDとともに出る」「名乗られたリクエストの下には出ない」 | 防ぐ（テストあり） | — |
| H-3 | 監査の権限なしで、他人のリクエストの記録を読む | 外部（ログイン済み） | 業務のコード：`audit:view`の権限 | `scenario/audit`「支店長は監査できない（業務上のアクセス権で拒否）」 | 防ぐ（テストあり） | API1 |
| H-4 | 入口のIAMで拒否された呼び出しを、関数のログから追う | — | 止めない（関数に届かないのでログに出ない。Lambdaのデータイベントを記録すれば残る） | — | 防がない | — |

## 範囲外

次は、この総点検の対象にしない。理由は[要件定義](requirements.md)の範囲とスコープ外による。

- サービス拒否（大量の呼び出し、STSのスロットリングを狙う攻撃）。レート制限や異常検知は別の仕組みで扱う。
- AWS自体（STS、IAM、Lambda）の脆弱性。
- 依存するソフトウェアの脆弱性（サプライチェーン）。

## 出典

| 略号 | 出典 |
|---|---|
| RFC 9700 | [Best Current Practice for OAuth 2.0 Security](https://www.rfc-editor.org/rfc/rfc9700) |
| RFC 8693 | [OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)（§5 Security Considerations） |
| RFC 8725 | [JSON Web Token Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725) |
| API1〜API10 | [OWASP API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)（API1：オブジェクト単位の認可の不備、API2：認証の不備、API5：機能単位の認可の不備） |
| ASI01〜ASI10 | [OWASP Top 10 for Agentic Applications](https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/)（ASI01：目的の乗っ取り、ASI02：ツールの悪用、ASI03：IDと権限の悪用、ASI05：想定外のコードの実行） |
| MCP | [MCP Security Best Practices（2026-07-28）](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)（トークンの素通し、confused deputy） |
