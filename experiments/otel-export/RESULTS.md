# 検証結果：LambdaからCloudWatchへOTelを送る方式

実施：2026-10-01（UTC）、ap-northeast-1。本体とは別のスタック`Gekko08ExpOtelExport`（[bin/app.ts](bin/app.ts)）で、
同じ処理をする4つの関数を比べた（[scripts/run.ts](scripts/run.ts)）。あわせて、受け口が要るIAMのアクションを確かめた（[scripts/probe-iam.ts](scripts/probe-iam.ts)）。

目的：トレースとメトリクスをOTLPで出し、CloudWatchに集める（[収集先のADR](../../docs/adr/20261001020115-telemetry-destination-cloudwatch.md)）。
Lambdaからの送り方を、コールドスタート、呼び出しごとの増分、メモリ、届くかどうかで比べて決める。fraud-agentのClaude Code（子プロセス）の
OTLPも受けられる必要がある。

生データ：`out-results.json`（git管理外）。

## 前提として確かめたこと

- CloudWatchは、3つの信号をOTLP/HTTPで直接受け付ける。トレースは`https://xray.<region>.amazonaws.com/v1/traces`（SigV4のサービス名は`xray`）、
  メトリクスは`https://monitoring.<region>.amazonaws.com/v1/metrics`（`monitoring`）、ログは`https://logs.<region>.amazonaws.com/v1/logs`（`logs`）。
  トレースはTransaction Searchを有効にしておく必要があり、スパンはロググループ`aws/spans`に入る（[CloudWatchのOTLPの受け口](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html)、
  [OTLPのメトリクス](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/metrics-otel-send.html)）。
- このアカウントでは、Transaction Searchはすでに有効だった（送り先`CloudWatchLogs`、`ACTIVE`）。インデックスの対象はスパンの100%（2026-07-01に設定）。

## 構成

Node.js 24、arm64、512MB、esbuildでESMの1ファイルにまとめた関数（本体と同じ`NodeFunction`）。処理は共通で（[workload.ts](src/workload.ts)）、
スパンを11個（ルートと10個）、カウンターを1つ出し、子プロセスにOTLP/HTTP（JSON）でスパンを1つ送らせる。子プロセスは`TRACEPARENT`を親にする。

| 関数 | 送り方 |
|---|---|
| Baseline | 送らない（`@opentelemetry/api`だけで、SDKを入れない）。子プロセスは起動するが送らない |
| A. Direct | 関数の中のSDKが、自作のエクスポーター（protobufを`@smithy/signature-v4`で署名）で受け口に直接送る。呼び出しの終わりに`forceFlush`で送り切る。子プロセスのOTLPは親が`127.0.0.1:4318`で受け、署名して転送する（[direct.ts](src/direct.ts)） |
| B. Adot | ADOTのレイヤー`AWSOpenTelemetryDistroJs:16`（`AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-instrument`、Active tracing）。トレースはUDPでLambdaのX-Rayのデーモンへ送る。子プロセスを受ける口はない（[adot.ts](src/adot.ts)） |
| C. Collector | 上流のコレクターのレイヤー`opentelemetry-collector-arm64-0_23_0:1`。関数と子プロセスは`localhost:4318`へ送り、コレクターが`sigv4auth`で署名して送る。`decouple`で関数の応答を送信の完了まで待たせない（[collector.ts](src/collector.ts)、[collector.yaml](src/collector.yaml)） |

各関数を、コールドで3回（環境変数を変えて実行環境を作り直す）、ウォームで20回呼んだ。3分後に`aws/spans`をトレースIDで照会した。

## 結論

**A（直接送信）が最も適する。** コールドでもウォームでもC（コレクター）より速く、メモリも少なく、子プロセスのOTLPも親が受けて転送できた。
Cのdecoupleによる利点は、この規模では出なかった。B（ADOT）は最も軽いが、子プロセスのOTLPを受けられず、メトリクスも既定で出ない。

トレースの受け口が要るIAMのアクションは`xray:PutTraceSegments`、メトリクスは`cloudwatch:PutMetricData`だった。

## 観測した事実

### 時間とメモリ

子プロセスの時間（A・Cで約420〜445ms、基準で80ms）は、実験用の子プロセスがNode.jsの`fetch`を初めて使う時間が大半で、送り方の差ではない。
処理の増分は、関数の時間から子プロセスの時間を引いて比べた。

| | Baseline | B. Adot | A. Direct | C. Collector |
|---|---|---|---|---|
| 初期化（コールド3回） | 125〜170ms | 476〜725ms | 289〜399ms | 453〜515ms |
| 応答まで（コールド3回、呼び出し側で計測） | 468〜558ms | 829〜1,121ms | 1,363〜1,616ms | 2,026〜2,163ms |
| 関数の時間から子プロセスを除いた値（ウォーム、中央値） | 17ms | 19ms | 55ms | 66ms |
| 送り切る時間（ウォーム中央値／コールド） | — | — | 48ms／217〜239ms | 19ms／501〜582ms |
| 応答のあとの拡張機能の時間（`PostRuntimeExtensionsDuration`） | — | — | — | 平均57ms、最大274ms |
| 最大メモリ | 102MB | 150MB | 164MB | 197MB |

- Aの送り切る時間の内訳（ウォーム中央値）：トレース46ms、メトリクス17ms、子プロセスのトレースの転送50ms（並行して送る）。
  コールドでは、受け口とのTLSの接続が加わり、トレース約200ms、メトリクス約145ms。
- Cは、関数からコレクターへ送り切るのに、ウォームで19ms、コールドで500ms以上かかった（コレクターの起動を待つ）。応答のあとも拡張機能が送信を続け、
  その時間は課金される。
- Bの増分は2ms程度で、送信はUDPで、関数の外で行われる。

### 届いたか

| | B. Adot | A. Direct | C. Collector |
|---|---|---|---|
| トレース（23回） | 23（1トレースあたり17〜18スパン。レイヤーの自動計装のスパンが加わる） | 23（12スパン） | 23（12スパン） |
| 子プロセスのスパン | 0（受け口がない） | 23 | 23 |
| メトリクス | 出さない（既定でオフ） | 受け口が200を返した | 関数のログにコレクターのエラーはなかった |

メトリクスがCloudWatchで照会できるかは、PromQLでは確かめていない。

### 受け口のIAMのアクション

送信のAPIはCloudTrailに記録されなかった（記録されたのは`GetTraceSegmentDestination`などの読み取りだけ）。そこで、1つのアクションだけを持つroleで、
OTLP（JSON）を1件ずつ送った。

| roleが持つアクション | トレースの受け口 | メトリクスの受け口 |
|---|---|---|
| `xray:PutTraceSegments` | **200** | 403 |
| `xray:PutSpans` | 403（「`xray:PutTraceSegments`の権限がない」） | 403 |
| `xray:PutSpansForIndexing` | 403（同上） | 403 |
| `cloudwatch:PutMetricData` | 403 | **200** |
| なし | 403 | 403 |

## 設計への示唆

1. **送り方は直接送信にする。** 共通部品に、署名して送るエクスポーター（トレースとメトリクス）を置き、ホップの呼び出しの終わりに送り切る。
   ウォームで約40〜50msの増分を引き受ける。レイヤーも拡張機能も要らない。
2. **子プロセス（Claude Code）のOTLPは、親のプロセスが`127.0.0.1`で受けて転送する。** MCPの中継と同じく、署名に要る認証情報は親にとどまる。
3. **IAMは`xray:PutTraceSegments`と`cloudwatch:PutMetricData`だけを許す。**
4. **メトリクスを毎回送るかは、ステップ3で決める。** 今回はトレースと一緒に毎回送った（約17ms、並行）。実行環境が止まる前に送り切る必要があるので、
   送る間隔をあけると失う分が出る。

## 確かめていないこと

- メモリの割り当てを変えたときの差（今回は512MB。fraud-agentは1024MB）。CPUが増えると、Cのコレクターの不利は小さくなる可能性がある。
- 実際のClaude Code（子プロセス）が、親の受け口に送るときの時間と量。
- メトリクスがCloudWatchで照会できること。
- インデックスの割合（100%）による費用。
