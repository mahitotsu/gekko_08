# ADRの索引

設計判断の記録。ファイル名は`YYYYMMDDHHMMSS-<slug>.md`（UTC）。置き換えや改訂の関係は、関係する両方のADRのStatusに書く。
不要になったADRは削除する（[文書一覧](../README.md)）。

| ADR | 決めたこと | 状態 |
|---|---|---|
| [多段伝播](20260930064314-multi-hop-authorization-context-propagation.md) | actorは呼び出し元の実行role、subjectはSTSが署名したJWTで伝える | 一部を[委任の範囲](20260930150529-delegation-scope-and-entitlements.md)で置き換え（業務属性→取引の目的） |
| [入口はBFF](20260930083437-entry-via-bff.md) | ブラウザには認証情報を持たせず、サーバー側の入口がログインとAWSのセッションを扱う | 有効 |
| [IdPはCognito User Pool](20260930091026-idp-cognito-user-pool.md) | Cognito User PoolとPre Token Generation V2。Identity Poolsは使わない | 一部を[委任の範囲](20260930150529-delegation-scope-and-entitlements.md)で置き換え（業務属性のtags） |
| [Function URLとIAM、mTLSなし](20260930091257-lambda-function-url-without-mtls.md) | ホップはLambda、ホップ間はFunction URLの`AWS_IAM`認証 | 有効 |
| [BFFの公開とセッション](20260930093744-bff-hosting-and-session.md) | CloudFront経由のFunction URL（OAC）、セッションはDynamoDB | 有効 |
| [TypeScript](20260930093745-implementation-language-typescript.md) | LambdaはTypeScript、AWS SDKを関数に同梱 | 有効 |
| [エージェントとMCPもホップ](20260930093746-agent-and-mcp-on-lambda.md) | エージェントとMCPサーバーもLambdaのホップ。MCPはOAuthではなく他のホップと同じ入口で守る | 決定1を[Claude Agent SDK](20261001040729-fraud-agent-on-claude-agent-sdk.md)で置き換え |
| [委任の範囲と業務的なアクセス権](20260930150529-delegation-scope-and-entitlements.md) | 取引の目的とホップごとのscopeはSTSとIAMに強制させ、業務的なアクセス権は属性サービスから得る | 有効 |
| [トレースの収集先](20261001020115-telemetry-destination-cloudwatch.md) | トレースはOTLPでCloudWatch（Transaction Search）へ。メトリクスは出さず、ログから集計する | 有効（同日に改訂） |
| [エージェントはClaude Agent SDK](20261001040729-fraud-agent-on-claude-agent-sdk.md) | Claude Codeを子プロセスで動かし、MCPは関数の中の中継から共通部品で呼ぶ | 有効 |
| [トレースの送り方](20261001053646-telemetry-direct-export.md) | 関数の中のSDKが署名してX-RayのOTLPの受け口に直接送り、応答の前に送り切る | 有効（同日に改訂） |
