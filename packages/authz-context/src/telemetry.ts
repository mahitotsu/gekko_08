import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { context, propagation, ROOT_CONTEXT, trace, type Context, type TextMapGetter } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SignatureV4 } from '@smithy/signature-v4';
import { log } from './log';

// トレース（設計書§7）。関数の中のSDKが、実行roleで署名して、CloudWatchのOTLPの受け口（X-Ray）に直接送り、
// ホップの呼び出しの終わりに送り切る（送り方のADR）。環境変数`AUTHZ_TELEMETRY`が`cloudwatch`のときだけ有効にし、
// それ以外ではOTelのAPIは何もしない

/** スパンの属性のキー。認証情報（JWT、受け渡すセッション）は属性に入れない（SR-3） */
export const ATTR = {
  hop: 'authz.hop',
  actor: 'authz.actor',
  purpose: 'authz.purpose',
  scope: 'authz.scope',
  requestId: 'authz.request_id',
  /** 共通部品の受信の検証の結果（`accepted`か`rejected`）。業務のコードの判定はHTTPのステータスに出る */
  inbound: 'authz.inbound',
  rejectReason: 'authz.reject_reason',
  target: 'authz.target',
  /** OTelの標準の属性。ユーザーの識別子（SourceIdentity） */
  enduser: 'enduser.id',
  status: 'http.response.status_code',
} as const;

const region = () => process.env.AWS_REGION!;

/** X-RayのOTLPの受け口（`/v1/traces`）へ、OTLP/HTTPのprotobufを実行roleで署名して送る。要る権限は`xray:PutTraceSegments` */
export class XrayOtlpSpanExporter implements SpanExporter {
  private signer?: SignatureV4;

  export(spans: ReadableSpan[], done: (r: ExportResult) => void): void {
    this.send(spans).then(
      () => done({ code: ExportResultCode.SUCCESS }),
      (e) => {
        log('warn', 'telemetry export failed', { error: (e as Error).message });
        done({ code: ExportResultCode.FAILED });
      },
    );
  }

  private async send(spans: ReadableSpan[]) {
    const host = `xray.${region()}.amazonaws.com`;
    const body = ProtobufTraceSerializer.serializeRequest(spans)!;
    this.signer ??= new SignatureV4({ service: 'xray', region: region(), credentials: defaultProvider(), sha256: Sha256 });
    const req = await this.signer.sign({
      method: 'POST', protocol: 'https:', hostname: host, path: '/v1/traces', headers: { host, 'content-type': 'application/x-protobuf' }, body,
    });
    const res = await fetch(`https://${host}/v1/traces`, { method: 'POST', headers: req.headers, body: body as BodyInit });
    await res.arrayBuffer();
    if (!res.ok) throw new Error(`xray: HTTP ${res.status}`);
  }

  async shutdown(): Promise<void> {}
}

let provider: NodeTracerProvider | undefined;

/** トレースを有効にする。実行環境ごとに1回だけ行う */
export function initTelemetry(serviceName: string): void {
  if (provider || process.env.AUTHZ_TELEMETRY !== 'cloudwatch') return;
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    spanProcessors: [new BatchSpanProcessor(new XrayOtlpSpanExporter())],
  });
  // W3C Trace Contextの伝播と、非同期のコンテキスト（AsyncLocalStorage）を登録する
  provider.register();
}

export const tracer = () => trace.getTracer('@gekko08/authz-context');

/** 応答を返す前に送り切る。送れなくても、ホップの処理は失敗させない */
export async function flushTelemetry(timeoutMs = 2000): Promise<void> {
  if (!provider) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    provider.forceFlush().catch(() => {}),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  clearTimeout(timer);
}

const headerGetter: TextMapGetter<Record<string, string | undefined>> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => carrier[key] ?? Object.entries(carrier).find(([k]) => k.toLowerCase() === key)?.[1],
};

/**
 * 受信したリクエストの親のコンテキスト。`traceparent`を引き継ぐのは、入口のIAMで呼び出し元を確かめたホップの間だけで、
 * ブラウザから届いたものは引き継がない（bffは`ROOT_CONTEXT`から始める）
 */
export function inboundContext(headers: Record<string, string | undefined>): Context {
  return propagation.extract(ROOT_CONTEXT, headers, headerGetter);
}

/** 送信するリクエストのヘッダーに、その時点のスパンの`traceparent`を付ける */
export function injectTraceContext(headers: Record<string, string>): void {
  propagation.inject(context.active(), headers);
}
