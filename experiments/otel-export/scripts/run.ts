import { writeFileSync } from 'node:fs';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CloudWatchLogsClient, FilterLogEventsCommand, GetQueryResultsCommand, StartQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import {
  GetFunctionConfigurationCommand, InvokeCommand, LambdaClient, UpdateFunctionConfigurationCommand, waitUntilFunctionUpdatedV2,
} from '@aws-sdk/client-lambda';

// 4つの関数を、コールドで3回、ウォームで20回ずつ呼び、時間とメモリを記録する。そのあと、トレースがaws/spansに届いたかを確かめる
const COLD = 3;
const WARM = 20;
const lambda = new LambdaClient({});
const logs = new CloudWatchLogsClient({});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { Stacks } = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: 'Gekko08ExpOtelExport' }));
const fns = Object.fromEntries(Stacks![0].Outputs!.map((o) => [o.OutputKey!.replace(/Function$/, ''), o.OutputValue!]));

interface Run { cold: boolean; clientMs: number; durationMs: number; billedMs: number; initMs?: number; maxMemoryMB: number; payload: any }
const num = (log: string, key: string) => {
  const m = log.match(new RegExp(`${key}: ([\\d.]+)`));
  return m ? Number(m[1]) : undefined;
};

async function invoke(name: string, cold: boolean): Promise<Run> {
  const t0 = performance.now();
  const r = await lambda.send(new InvokeCommand({ FunctionName: name, LogType: 'Tail' }));
  const clientMs = Math.round(performance.now() - t0);
  const log = Buffer.from(r.LogResult ?? '', 'base64').toString();
  const payload = JSON.parse(Buffer.from(r.Payload ?? []).toString() || 'null');
  if (r.FunctionError) console.error(name, r.FunctionError, JSON.stringify(payload).slice(0, 500));
  return {
    cold, clientMs, durationMs: num(log, 'Duration')!, billedMs: num(log, 'Billed Duration')!, initMs: num(log, 'Init Duration'),
    maxMemoryMB: num(log, 'Max Memory Used')!, payload,
  };
}

// 環境変数を変えて、次の呼び出しをコールドスタートにする
async function forceCold(name: string) {
  const c = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
  await lambda.send(new UpdateFunctionConfigurationCommand({
    FunctionName: name, Environment: { Variables: { ...c.Environment?.Variables, COLD_BUST: String(Date.now()) } },
  }));
  await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 120 }, { FunctionName: name });
}

const startTime = Date.now();
const results: Record<string, Run[]> = {};
for (const [variant, name] of Object.entries(fns)) {
  results[variant] = [];
  for (let i = 0; i < COLD; i++) {
    await forceCold(name);
    results[variant].push(await invoke(name, true));
  }
  for (let i = 0; i < WARM; i++) results[variant].push(await invoke(name, false));
  console.log(variant, 'done');
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};
const summary: Record<string, unknown> = {};
for (const [variant, runs] of Object.entries(results)) {
  const cold = runs.filter((r) => r.cold);
  const warm = runs.filter((r) => !r.cold);
  summary[variant] = {
    initMs: cold.map((r) => r.initMs),
    coldClientMs: cold.map((r) => r.clientMs),
    coldDurationMs: cold.map((r) => r.durationMs),
    warmClientMsMedian: median(warm.map((r) => r.clientMs)),
    warmDurationMsMedian: median(warm.map((r) => r.durationMs)),
    warmBilledMsMedian: median(warm.map((r) => r.billedMs)),
    warmFlushMsMedian: median(warm.map((r) => r.payload?.flushMs).filter((v) => v !== undefined)),
    warmChildMsMedian: median(warm.map((r) => r.payload?.child?.ms)),
    maxMemoryMB: Math.max(...runs.map((r) => r.maxMemoryMB)),
    sampled: runs.filter((r) => r.payload?.sampled).length,
    childExitCodes: [...new Set(runs.map((r) => r.payload?.child?.code))],
    sentStatuses: [...new Set(runs.flatMap((r) => (r.payload?.sent ?? []).map((s: { signal: string; status: number }) => `${s.signal}:${s.status}`)))],
  };
}
console.log(JSON.stringify(summary, null, 2));

// トレースがaws/spansに届いたか。X-Rayの形式のトレースID（1-xxxxxxxx-yyyy…）でも探す
console.log('waiting for spans to arrive...');
await sleep(180_000);
const ids = Object.values(results).flat().map((r) => r.payload?.traceId).filter(Boolean) as string[];
const xray = (id: string) => `1-${id.slice(0, 8)}-${id.slice(8)}`;
const quoted = ids.flatMap((id) => [id, xray(id)]).map((id) => `"${id}"`).join(',');
const { queryId } = await logs.send(new StartQueryCommand({
  logGroupName: 'aws/spans', startTime: Math.floor(startTime / 1000) - 60, endTime: Math.floor(Date.now() / 1000),
  queryString: `filter traceId in [${quoted}] | stats count(*) as spans, sum(name = "child work") as child by traceId | limit 1000`,
}));
let rows: { field?: string; value?: string }[][] = [];
for (;;) {
  await sleep(3000);
  const r = await logs.send(new GetQueryResultsCommand({ queryId }));
  if (r.status === 'Complete' || r.status === 'Failed') {
    rows = r.results ?? [];
    break;
  }
}
const arrived = Object.fromEntries(rows.map((row) => {
  const get = (f: string) => row.find((c) => c.field === f)?.value;
  return [get('traceId')!, { spans: Number(get('spans')), child: Number(get('child')) }];
}));
const arrival: Record<string, unknown> = {};
for (const [variant, runs] of Object.entries(results)) {
  const per = runs.map((r) => arrived[r.payload?.traceId] ?? arrived[xray(r.payload?.traceId ?? '')]);
  arrival[variant] = {
    invocations: runs.length,
    tracesArrived: per.filter(Boolean).length,
    spansPerTrace: [...new Set(per.filter(Boolean).map((p) => p.spans))],
    childArrived: per.filter((p) => p?.child > 0).length,
  };
}
console.log(JSON.stringify(arrival, null, 2));

// 関数のログに出たエラー（コレクターの送信の失敗など）
const errors: Record<string, string[]> = {};
for (const [variant, name] of Object.entries(fns)) {
  const c = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
  const r = await logs.send(new FilterLogEventsCommand({
    logGroupName: c.LoggingConfig?.LogGroup ?? `/aws/lambda/${name}`, startTime, filterPattern: '?error ?Error ?ERROR ?failed', limit: 20,
  })).catch(() => ({ events: [] }));
  errors[variant] = (r.events ?? []).map((e) => e.message!.slice(0, 300));
}
console.log(JSON.stringify(errors, null, 2));
writeFileSync(new URL('../out-results.json', import.meta.url), JSON.stringify({ summary, arrival, errors, results }, null, 2));
