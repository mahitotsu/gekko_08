# ADR: LambdaからのOTelは、関数の中のSDKが署名して直接送る

## Status

Proposed (2026-10-01)

## Context

トレースとメトリクスはOTLPで出し、CloudWatchに集める（[収集先のADR](20261001020115-telemetry-destination-cloudwatch.md)）。
Lambdaからの送り方を決める必要がある。Lambdaは応答を返すと実行環境が止まるので、止まる前に送り切るか、拡張機能（Extension）に任せる必要がある。
fraud-agentのClaude Code（子プロセス）もOTLPで送るが、SigV4の署名はできない
（[フレームワークへの当てはめの検証](../../experiments/agent-frameworks/RESULTS.md)）。

[送り方の検証](../../experiments/otel-export/RESULTS.md)で、同じ処理をする関数（512MB）を4通りの送り方で比べ、次のことを確かめた。

| | ADOTのレイヤー | 直接送信 | コレクターのレイヤー |
|---|---|---|---|
| 初期化の増分（基準との差） | 約300〜550ms | 約150〜250ms | 約300〜350ms |
| ウォームの増分 | 約2ms | 約40ms | 約50ms（応答のあとも拡張機能が平均57ms動く） |
| 最大メモリ | 150MB | 164MB | 197MB |
| 子プロセスのOTLP | 受けられない | 親が受けて転送できた | 受けられた |
| メトリクス | 既定で出ない | 送れた | 送れた |

あわせて、トレースの受け口は`xray:PutTraceSegments`で、メトリクスの受け口は`cloudwatch:PutMetricData`で認可されることを確かめた。

## Decision

**関数の中のOTel SDKが、SigV4で署名して、CloudWatchのOTLPの受け口に直接送る。ホップの呼び出しの終わりに送り切る。**

1. 共通部品が、トレースとメトリクスのエクスポーター（OTLP/HTTPのprotobufを、実行roleの認証情報で署名して送る）を提供する。
   受け口は`https://xray.<region>.amazonaws.com/v1/traces`と`https://monitoring.<region>.amazonaws.com/v1/metrics`。
2. 共通部品が、ホップの呼び出しの終わりに、応答を返す前に送り切る（`forceFlush`）。
3. 子プロセス（Claude Code）のOTLPは、親のプロセスが`127.0.0.1`で受け、署名して転送する。子プロセスに認証情報は渡さない。
4. 各ホップの実行roleに、`xray:PutTraceSegments`と`cloudwatch:PutMetricData`だけを許す。
5. Lambdaのレイヤーと拡張機能は使わない。

## 採用しなかった選択肢

- **ADOTのレイヤー（`AWSOpenTelemetryDistroJs`、CloudWatch Application Signalsの方式）**：呼び出しごとの増分が最も小さい（送信はUDPで、
  関数の外で行われる）。ただし、OTLPの受け口がないので子プロセスのテレメトリを受けられず、メトリクスも既定で出ない。esbuildでまとめた関数で、
  ライブラリの自動計装が効くかも定かでない。
- **コレクターのレイヤー（opentelemetry-lambda）**：関数と子プロセスが同じ経路（`localhost:4318`）で送れ、decoupleで応答を待たせない。
  ただし、計測では直接送信より遅く（コールドでコレクターの起動を待つ。ウォームでも関数からコレクターへの送信が残る）、メモリも多く、
  応答のあとの拡張機能の時間も課金された。AWSが出しているコレクターのレイヤーは「非推奨」の扱いで、上流のものを使うことになる。
- **メトリクスだけEmbedded Metric Format（ログ）で出す**：送信の時間はかからないが、CloudWatchがOTLPのメトリクスを直接受け付け、
  直接送信の増分も小さい（並行して約17ms）ので、形式を2つに分けない。

## Consequences

### よくなること

- レイヤーも拡張機能も要らず、関数の作りが他のホップと同じで済む。依存はOTelのSDKと、すでに使っている署名の部品だけ。
- トレース、メトリクス、子プロセスのテレメトリを、1つの仕組みで送れる。
- IAMの権限を、確かめた最小のアクションに絞れる。

### 引き受けること

- **呼び出しごとに約40〜50ms（ウォーム）、コールドでは受け口とのTLSの接続が加わって約200ms、応答が遅れる**。ホップが多段になると、ホップの数だけ加わる。
  NFR-3に沿って実測を公開する。
- **署名して送るエクスポーターは自作になる**。ADOTの中にある署名付きのエクスポーターは、公開のAPIではない。
- **送り切れなかったテレメトリは失われる**。送信に失敗しても、ホップの処理は失敗させない。
- 512MBで測った結果で、CPUが多いとコレクターの不利は小さくなる可能性がある。
