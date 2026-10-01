import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { context, metrics, propagation, trace } from '@opentelemetry/api';

// 4つの関数で同じ処理をする。スパンを10個、メトリクスを1つ出し、子プロセス（Claude Codeの代わり）にOTLPでスパンを1つ送らせる

// 子プロセスのスクリプト。TRACEPARENTを親にしたスパンを1つ、OTLP/HTTP（JSON）で送る。送り先がなければ何もしない
const CHILD = `
const endpoint = process.env.OTLP_ENDPOINT;
const tp = process.env.TRACEPARENT;
if (!endpoint || !tp) process.exit(0);
const [, traceId, parentSpanId] = tp.split('-');
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const now = BigInt(Date.now()) * 1000000n;
const body = { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'gekko08-exp-child' } }] },
  scopeSpans: [{ scope: { name: 'gekko08-exp-child' }, spans: [{ traceId, spanId: hex(8), parentSpanId, name: 'child work', kind: 1,
    startTimeUnixNano: String(now - 1000000n), endTimeUnixNano: String(now) }] }] }] };
const res = await fetch(endpoint + '/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
process.exit(res.ok ? 0 : 1);
`;
const CHILD_PATH = '/tmp/gekko08-exp-child.mjs';
let childWritten = false;

function runChild(endpoint: string | undefined): Promise<{ ms: number; code: number | null }> {
  if (!childWritten) {
    writeFileSync(CHILD_PATH, CHILD);
    childWritten = true;
  }
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const t0 = performance.now();
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CHILD_PATH], {
      env: { PATH: process.env.PATH, ...(endpoint ? { OTLP_ENDPOINT: endpoint } : {}), ...(carrier.traceparent ? { TRACEPARENT: carrier.traceparent } : {}) },
      stdio: 'ignore',
    });
    p.on('exit', (code) => resolve({ ms: Math.round(performance.now() - t0), code }));
  });
}

export async function workload(variant: string, childEndpoint?: string) {
  const tracer = trace.getTracer('gekko08-exp');
  const counter = metrics.getMeter('gekko08-exp').createCounter('gekko08_exp_invocations');
  return tracer.startActiveSpan('workload', async (root) => {
    for (let i = 0; i < 10; i++) tracer.startSpan(`step ${i}`, { attributes: { 'exp.step': i } }).end();
    counter.add(1, { variant });
    const child = await runChild(childEndpoint);
    const sampled = (root.spanContext().traceFlags & 1) === 1;
    root.end();
    return { traceId: root.spanContext().traceId, sampled, child };
  });
}
