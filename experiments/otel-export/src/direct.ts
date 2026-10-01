import { createServer } from 'node:http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { ProtobufMetricsSerializer, ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { AggregationTemporality, MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { metrics } from '@opentelemetry/api';
import { SignatureV4 } from '@smithy/signature-v4';
import { workload } from './workload';

// A. 直接送信：関数の中のSDKが、SigV4で署名してCloudWatchのOTLPの受け口に送る。呼び出しの終わりに送り切る。
// 子プロセスの分は、127.0.0.1で受けて、署名して転送する
const region = process.env.AWS_REGION!;
const credentials = defaultProvider();
const signers: Record<string, SignatureV4> = {};
/** 送った結果（実験の観測用） */
const sent: { signal: string; status: number; ms: number }[] = [];

async function signedPost(service: 'xray' | 'monitoring', path: string, body: Uint8Array | string, contentType: string, signal: string) {
  const host = `${service}.${region}.amazonaws.com`;
  signers[service] ??= new SignatureV4({ service, region, credentials, sha256: Sha256 });
  const req = await signers[service].sign({ method: 'POST', protocol: 'https:', hostname: host, path, headers: { host, 'content-type': contentType }, body });
  const t0 = performance.now();
  const res = await fetch(`https://${host}${path}`, { method: 'POST', headers: req.headers, body: body as BodyInit });
  await res.arrayBuffer();
  sent.push({ signal, status: res.status, ms: Math.round(performance.now() - t0) });
  return res.ok;
}

const done = (ok: boolean): ExportResult => ({ code: ok ? ExportResultCode.SUCCESS : ExportResultCode.FAILED });

class SignedSpanExporter implements SpanExporter {
  export(spans: ReadableSpan[], cb: (r: ExportResult) => void) {
    signedPost('xray', '/v1/traces', ProtobufTraceSerializer.serializeRequest(spans)!, 'application/x-protobuf', 'traces')
      .then((ok) => cb(done(ok)), () => cb(done(false)));
  }
  async shutdown() {}
}

class SignedMetricExporter implements PushMetricExporter {
  export(m: ResourceMetrics, cb: (r: ExportResult) => void) {
    signedPost('monitoring', '/v1/metrics', ProtobufMetricsSerializer.serializeRequest(m)!, 'application/x-protobuf', 'metrics')
      .then((ok) => cb(done(ok)), () => cb(done(false)));
  }
  async forceFlush() {}
  async shutdown() {}
  selectAggregationTemporality() {
    return AggregationTemporality.DELTA;
  }
}

const resource = resourceFromAttributes({ 'service.name': 'gekko08-exp-direct' });
const tracerProvider = new NodeTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(new SignedSpanExporter())] });
tracerProvider.register();
const meterProvider = new MeterProvider({
  resource, readers: [new PeriodicExportingMetricReader({ exporter: new SignedMetricExporter(), exportIntervalMillis: 60_000 })],
});
metrics.setGlobalMeterProvider(meterProvider);

// 子プロセスのOTLP（JSON）を受けて、署名して転送する
const pending = new Set<Promise<unknown>>();
const receiver = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const p = signedPost('xray', '/v1/traces', raw, 'application/json', 'child-traces').finally(() => pending.delete(p));
    pending.add(p);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
});
const listening = new Promise<void>((resolve) => receiver.listen(4318, '127.0.0.1', resolve));

export const handler = async () => {
  await listening;
  sent.length = 0;
  const t0 = performance.now();
  const r = await workload('direct', 'http://127.0.0.1:4318');
  const workMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  await Promise.all([tracerProvider.forceFlush(), meterProvider.forceFlush(), ...pending]);
  const flushMs = Math.round(performance.now() - t1);
  return { variant: 'direct', ...r, workMs, flushMs, sent: [...sent] };
};
