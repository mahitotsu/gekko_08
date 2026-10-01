import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SpanKind, trace, type Span } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

// OTelの出力を観測する（収集先へは送らない）。フレームワークが何をどの形式で出すか、
// ホップのスパン（ここでは仮のルートのスパン）と同じトレースにつながるか、本文や認証情報が属性に入るかを、ログに書き出す

const SECRETS: [string, RegExp][] = [
  ['jwt', /eyJ[\w-]+\.eyJ[\w-]+/],
  ['session', /eyJhY2Nlc3NLZXlJZCI/],
  ['accessKey', /(ASIA|AKIA)[A-Z0-9]{16}/],
  ['sessionToken', /IQoJb3JpZ2lu/],
];
// 業務データ（案件、口座）とプロンプトの断片。属性に本文が入っているかの目安にする
const CONTENT: [string, RegExp][] = [
  ['case', /深夜帯の海外送金|C-1001/],
  ['account', /東京 太郎|A-101/],
  ['injection', /本部監査部/],
  ['systemPrompt', /不正検知アナリスト/],
];

const matches = (text: string, table: [string, RegExp][]) => table.filter(([, re]) => re.test(text)).map(([n]) => n);

/** 1つのスパン（またはログのレコード、メトリクス）の要約。値は出さず、キーと、本文・認証情報が含まれるかだけを出す */
export interface Item {
  name: string;
  scope?: string;
  kind?: string;
  /** ルートのスパンと同じトレースか */
  sameTrace?: boolean;
  parent?: 'root' | 'other' | 'none';
  attributes: string[];
  events?: string[];
  /** 本文が含まれる属性のキーと、含まれる本文の種類 */
  content: Record<string, string[]>;
  secrets: string[];
}

function summarizeAttrs(attrs: Record<string, unknown>) {
  const content: Record<string, string[]> = {};
  const secrets = new Set<string>();
  for (const [k, v] of Object.entries(attrs)) {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    const c = matches(text, CONTENT);
    if (c.length) content[k] = c;
    for (const s of matches(text, SECRETS)) secrets.add(`${k}:${s}`);
  }
  return { content, secrets: [...secrets] };
}

// --- 同じプロセスのフレームワーク（Strands）：グローバルのTracerProviderに登録して、メモリに集める

const memory = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] });
provider.register();

function summarizeSpan(s: ReadableSpan, root: Span): Item {
  const rc = root.spanContext();
  const attrs = { ...s.attributes };
  const events = s.events.map((e) => e.name);
  for (const e of s.events) Object.assign(attrs, Object.fromEntries(Object.entries(e.attributes ?? {}).map(([k, v]) => [`event:${e.name}:${k}`, v])));
  const parentId = s.parentSpanContext?.spanId;
  return {
    name: s.name,
    scope: s.instrumentationScope.name,
    kind: SpanKind[s.kind],
    sameTrace: s.spanContext().traceId === rc.traceId,
    parent: !parentId ? 'none' : parentId === rc.spanId ? 'root' : 'other',
    attributes: Object.keys(s.attributes),
    events,
    ...summarizeAttrs(attrs),
  };
}

/** ホップのスパンの代わりに仮のルートのスパンを作り、その中でfを実行する。終わったら、集まったスパンを要約して返す */
export async function withRootSpan<T>(name: string, f: () => Promise<T>): Promise<{ result: T; traceId: string; spans: Item[] }> {
  memory.reset();
  const tracer = trace.getTracer('gekko08-probe');
  let root!: Span;
  const result = await tracer.startActiveSpan(name, { kind: SpanKind.SERVER }, async (span) => {
    root = span;
    try {
      return await f();
    } finally {
      span.end();
    }
  });
  await provider.forceFlush();
  const spans = memory.getFinishedSpans().filter((s) => s.spanContext().spanId !== root.spanContext().spanId).map((s) => summarizeSpan(s, root));
  return { result, traceId: root.spanContext().traceId, spans };
}

// --- 子プロセスのフレームワーク（Claude Code）：OTLP/HTTP（JSON）を受け取る

interface OtlpKV { key: string; value: Record<string, unknown> }
const kv = (list: OtlpKV[] = []) => Object.fromEntries(list.map((a) => [a.key, Object.values(a.value)[0]]));

export interface Received {
  traces: Item[];
  metrics: Item[];
  logs: Item[];
  resource: string[];
  /** スパン名ごとのスパンID。中継が受け取った`traceparent`の親を判定するのに使う */
  spanIds: Record<string, string[]>;
}

/** 127.0.0.1でOTLP/HTTP（JSON）を受け取る。rootTraceIdとrootSpanIdは、つながりを判定するために使う */
export async function otlpReceiver() {
  const got: Received = { traces: [], metrics: [], logs: [], resource: [], spanIds: {} };
  let root: { traceId: string; spanId: string } | undefined;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body || '{}');
        for (const r of [...(msg.resourceSpans ?? []), ...(msg.resourceMetrics ?? []), ...(msg.resourceLogs ?? [])]) {
          for (const k of Object.keys(kv(r.resource?.attributes))) if (!got.resource.includes(k)) got.resource.push(k);
        }
        for (const rs of msg.resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) for (const s of ss.spans ?? []) {
          const attrs = kv(s.attributes);
          (got.spanIds[s.name] ??= []).push(s.spanId);
          got.traces.push({
            name: s.name, scope: ss.scope?.name, kind: String(s.kind),
            sameTrace: root ? s.traceId === root.traceId : undefined,
            parent: !s.parentSpanId ? 'none' : root && s.parentSpanId === root.spanId ? 'root' : 'other',
            attributes: Object.keys(attrs), events: (s.events ?? []).map((e: { name: string }) => e.name), ...summarizeAttrs(attrs),
          });
        }
        for (const rm of msg.resourceMetrics ?? []) for (const sm of rm.scopeMetrics ?? []) for (const m of sm.metrics ?? []) {
          const points = Object.values(m).find((v): v is { dataPoints: { attributes: OtlpKV[] }[] } => typeof v === 'object' && v !== null && 'dataPoints' in v);
          const attrs = Object.assign({}, ...(points?.dataPoints ?? []).map((p) => kv(p.attributes)));
          got.metrics.push({ name: m.name, scope: sm.scope?.name, attributes: Object.keys(attrs), ...summarizeAttrs(attrs) });
        }
        for (const rl of msg.resourceLogs ?? []) for (const sl of rl.scopeLogs ?? []) for (const l of sl.logRecords ?? []) {
          const attrs = { ...kv(l.attributes), body: l.body ? Object.values(l.body)[0] : undefined };
          got.logs.push({
            name: String(kv(l.attributes)['event.name'] ?? l.body?.stringValue ?? 'log').slice(0, 80), scope: sl.scope?.name,
            sameTrace: root && l.traceId ? l.traceId === root.traceId : undefined,
            attributes: Object.keys(kv(l.attributes)), ...summarizeAttrs(attrs),
          });
        }
      } catch {
        // JSONでない（protobufなど）ものは数えない
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    setRoot: (traceId: string, spanId: string) => { root = { traceId, spanId }; },
    received: got,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 同じ名前とキーの要素をまとめる（ログを小さくする） */
export function dedupe(items: Item[]): (Item & { count: number })[] {
  const out = new Map<string, Item & { count: number }>();
  for (const i of items) {
    const key = JSON.stringify([i.name, i.scope, i.attributes, i.sameTrace, i.parent, i.content, i.secrets]);
    const e = out.get(key);
    if (e) e.count++;
    else out.set(key, { ...i, count: 1 });
  }
  return [...out.values()];
}
