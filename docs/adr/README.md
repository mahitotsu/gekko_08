# ADRの索引

設計判断の記録。ファイル名は`YYYYMMDDHHMMSS-<slug>.md`（UTC）。置き換えや改訂の関係は、関係する両方のADRのStatusに書く。
置き換えたADRも削除せずに残す（[ADRの扱い](../../CLAUDE.md#adrの扱い)）。

| ADR | 決めたこと | 状態 |
|---|---|---|
| [多段伝播](20260930064314-multi-hop-authorization-context-propagation.md) | actorは呼び出し元の実行role、subjectはSTSが署名したJWTで伝える | 一部を[委任の範囲](20260930150529-delegation-scope-and-entitlements.md)で置き換え（業務属性→リクエストの目的）。`SourceFunctionArn`の置き場所を[置き場所のADR](20261001094443-source-function-arn-in-caller-identity-policy.md)で置き換え |
| [入口はBFF](20260930083437-entry-via-bff.md) | ブラウザには認証情報を持たせず、サーバー側の入口がログインとAWSのセッションを扱う | 有効 |
| [IdPはCognito User Pool](20260930091026-idp-cognito-user-pool.md) | Cognito User PoolとPre Token Generation V2。Identity Poolsは使わない | 一部を[委任の範囲](20260930150529-delegation-scope-and-entitlements.md)で置き換え（業務属性のtags） |
| [Function URLとIAM、mTLSなし](20260930091257-lambda-function-url-without-mtls.md) | ホップはLambda、ホップ間はFunction URLの`AWS_IAM`認証 | 有効 |
| [BFFの公開とセッション](20260930093744-bff-hosting-and-session.md) | CloudFront経由のFunction URL（OAC）、セッションはDynamoDB | 有効 |
| [TypeScript](20260930093745-implementation-language-typescript.md) | LambdaはTypeScript、AWS SDKを関数に同梱 | 有効 |
| [エージェントとMCPもホップ](20260930093746-agent-and-mcp-on-lambda.md) | エージェントとMCPサーバーもLambdaのホップ。MCPはOAuthではなく他のホップと同じ入口で守る | 決定1を[Claude Agent SDK](20261001040729-fraud-agent-on-claude-agent-sdk.md)で置き換え |
| [委任の範囲と業務的なアクセス権](20260930150529-delegation-scope-and-entitlements.md) | リクエストの目的とホップごとのscopeはSTSとIAMに強制させ、業務的なアクセス権は属性サービスから得る | 一部を[委任の範囲の定義](20261001130745-delegation-definitions.md)で置き換え（scopeの宣言、目的の使い方） |
| [トレースの収集先](20261001020115-telemetry-destination-cloudwatch.md) | トレースはOTLPでCloudWatch（Transaction Search）へ。メトリクスは出さず、ログから集計する | 有効（同日に改訂） |
| [エージェントはClaude Agent SDK](20261001040729-fraud-agent-on-claude-agent-sdk.md) | Claude Codeを子プロセスで動かし、MCPは関数の中の中継から共通部品で呼ぶ | 有効 |
| [トレースの送り方](20261001053646-telemetry-direct-export.md) | 関数の中のSDKが署名してX-RayのOTLPの受け口に直接送り、応答の前に送り切る | 有効（同日に改訂） |
| [`SourceFunctionArn`の置き場所](20261001094443-source-function-arn-in-caller-identity-policy.md) | 呼び出し元の関数の限定は、受信側のresource policyではなく、呼び出し元の実行roleのidentity policyのDenyで行う | 有効 |
| [デモは口座の凍結解除](20261001123029-demo-account-unfreeze.md) | デモの題材を凍結解除に置き換える。案件を開くリクエストと解除するリクエストが同じホップを通り、目的で許す操作が変わる。エージェントは提案まで | 有効（2026-10-02に改訂） |
| [委任の範囲の定義](20261001130745-delegation-definitions.md) | 委任の範囲を目的の一覧・提供側・利用側の定義に分けて突き合わせる。目的は影響の大きいscopeの発行を限るためだけに使い、業務のコードは目的を使わない | 有効 |
| [デモの画面はReactの静的なSPA](20261002065842-demo-ui-react-static.md) | 画面はReactとViteの静的なSPAにし、合成のときにビルドしてS3から配信する。SSRは使わない。目的と拒否した層を表示する | 有効 |
| [監査サービス](20261002074437-audit-service.md) | 監査サービスをホップとして加え、1回のリクエストについて、各ホップのログとCloudTrailの記録をリクエストIDで突き合わせて示す。監査は監査担当だけ | 有効。「リクエストIDはSTSもIAMも強制しない」を[リクエストIDのtag](20261002154129-request-id-transitive-tag.md)で改訂 |
| [リクエストIDのtag](20261002154129-request-id-transitive-tag.md) | リクエストIDをtransitive session tagとして刻み、各chainの`RoleSessionName`をその値に限る。受信側はJWTの値とヘッダーを照合する | 有効 |
