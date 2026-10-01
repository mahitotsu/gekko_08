import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { AggregationTemporality, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { workload } from './workload';

// C. コレクターのレイヤー：関数と子プロセスは、同じ実行環境のコレクター（localhost:4318）に送る。
// コレクターが署名してCloudWatchのOTLPの受け口に送る（collector.yaml）。関数は呼び出しの終わりにコレクターへ送り切る
const resource = resourceFromAttributes({ 'service.name': 'gekko08-exp-collector' });
const tracerProvider = new NodeTracerProvider({
  resource, spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' }))],
});
tracerProvider.register();
const meterProvider = new MeterProvider({
  resource,
  readers: [new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: 'http://localhost:4318/v1/metrics', temporalityPreference: AggregationTemporality.DELTA }),
    exportIntervalMillis: 60_000,
  })],
});
metrics.setGlobalMeterProvider(meterProvider);

export const handler = async () => {
  const t0 = performance.now();
  const r = await workload('collector', 'http://localhost:4318');
  const workMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  await Promise.all([tracerProvider.forceFlush(), meterProvider.forceFlush()]);
  const flushMs = Math.round(performance.now() - t1);
  return { variant: 'collector', ...r, workMs, flushMs };
};
