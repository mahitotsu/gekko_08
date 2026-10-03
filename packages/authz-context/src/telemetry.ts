import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Context, type TextMapGetter } from '@opentelemetry/api';
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

let signer: SignatureV4 | undefined;
/** X-RayのOTLPの受け口（`/v1/traces`）へ、OTLP/HTTPの本文を実行roleで署名して送る。要る権限は`xray:PutTraceSegments` */
async function postTraces(body: Uint8Array | string, contentType: string): Promise<void> {
  const host = `xray.${region()}.amazonaws.com`;
  signer ??= new SignatureV4({ service: 'xray', region: region(), credentials: defaultProvider(), sha256: Sha256 });
  const req = await signer.sign({ method: 'POST', protocol: 'https:', hostname: host, path: '/v1/traces', headers: { host, 'content-type': contentType }, body });
  const res = await fetch(`https://${host}/v1/traces`, { method: 'POST', headers: req.headers, body: body as BodyInit });
  await res.arrayBuffer();
  if (!res.ok) throw new Error(`xray: HTTP ${res.status}`);
}

/** このプロセスのスパンを、X-RayのOTLPの受け口へprotobufで送る */
export class XrayOtlpSpanExporter implements SpanExporter {

  export(spans: ReadableSpan[], done: (r: ExportResult) => void): void {
    this.send(spans).then(
      () => done({ code: ExportResultCode.SUCCESS }),
      (e) => {
        log('warn', 'telemetry export failed', { error: (e as Error).message });
        done({ code: ExportResultCode.FAILED });
      },
    );
  }

  private send(spans: ReadableSpan[]) {
    return postTraces(ProtobufTraceSerializer.serializeRequest(spans)!, 'application/x-protobuf');
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

/** 子プロセスのテレメトリの転送のうち、まだ終わっていないもの */
const forwarding = new Set<Promise<void>>();

/** 応答を返す前に送り切る。送れなくても、ホップの処理は失敗させない */
export async function flushTelemetry(timeoutMs = 2000): Promise<void> {
  if (!provider) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all([provider.forceFlush().catch(() => {}), ...forwarding]),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  clearTimeout(timer);
}

const headerGetter: TextMapGetter<Record<string, string | undefined>> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => carrier[key] ?? Object.entries(carrier).find(([k]) => k.toLowerCase() === key)?.[1],
};

/**
 * 受信した呼び出しの親のコンテキスト。`traceparent`を引き継ぐのは、入口のIAMで呼び出し元を確かめたホップの間だけで、
 * ブラウザから届いたものは引き継がない（bffは`ROOT_CONTEXT`から始める）
 */
export function inboundContext(headers: Record<string, string | undefined>): Context {
  return propagation.extract(ROOT_CONTEXT, headers, headerGetter);
}

/** 送信する呼び出しのヘッダーに、その時点のスパンの`traceparent`を付ける */
export function injectTraceContext(headers: Record<string, string>): void {
  propagation.inject(context.active(), headers);
}

export interface OtlpTraceRelay {
  /** 子プロセスに渡すOTLP/HTTPの送り先（`OTEL_EXPORTER_OTLP_ENDPOINT`）。`/v1/traces`だけを受ける */
  endpoint: string;
  /**
   * 子プロセスが送り終えるのを待つ。最後に受けてから`idleMs`のあいだ何も来なくなるか、`maxMs`たったら戻る。
   * 子プロセスは終了するときに残りを送るので、子プロセスが終わったあとに呼ぶ
   */
  settle(idleMs?: number, maxMs?: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * 子プロセス（Claude Codeなど）のOTLPのトレースを127.0.0.1で受け、署名してX-RayのOTLPの受け口に転送する。
 * 子プロセスは署名に要る認証情報を持たない（送り方のADR）。トレースが無効なら何もせず、undefinedを返す
 */
export async function startOtlpTraceRelay(): Promise<OtlpTraceRelay | undefined> {
  if (!provider) return undefined;
  let last = Date.now();
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/traces') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      last = Date.now();
      const contentType = (req.headers['content-type'] ?? 'application/x-protobuf').split(';')[0];
      const p: Promise<void> = postTraces(new Uint8Array(Buffer.concat(chunks)), contentType)
        .catch((e) => log('warn', 'telemetry relay failed', { error: (e as Error).message }))
        .finally(() => forwarding.delete(p));
      forwarding.add(p);
      // 子プロセスを待たせない。転送の結果は、応答を返す前にflushTelemetryが待つ
      res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'application/x-protobuf' }).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    settle: async (idleMs = 300, maxMs = 2000) => {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline && Date.now() - last < idleMs) await new Promise((r) => setTimeout(r, 50));
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type AwsClient = {
  middlewareStack: {
    add(
      mw: (next: (args: any) => Promise<any>, ctx: { clientName?: string; commandName?: string }) => (args: any) => Promise<any>,
      options: { step: 'initialize'; name: string },
    ): void;
  };
};

/**
 * AWS SDKのクライアントの呼び出しごとに、CLIENTのスパンを作る。esbuildで1ファイルにまとめた関数では、AWS SDKの自動計装が効かないため。
 * 属性はサービス名・操作名・テーブル名・リクエストIDだけで、キーや本文は入れない
 */
export function traceAwsClient<T extends AwsClient>(client: T): T {
  client.middlewareStack.add((next, ctx) => (args) => {
    const service = (ctx.clientName ?? 'AWS').replace(/Client$/, '');
    const method = (ctx.commandName ?? 'Unknown').replace(/Command$/, '');
    const table = (args.input as { TableName?: unknown } | undefined)?.TableName;
    return tracer().startActiveSpan(`${service}.${method}`, {
      kind: SpanKind.CLIENT,
      attributes: { 'rpc.system': 'aws-api', 'rpc.service': service, 'rpc.method': method, ...(typeof table === 'string' ? { 'aws.dynamodb.table_names': [table] } : {}) },
    }, async (span) => {
      try {
        const r = await next(args);
        const meta = (r.output as { $metadata?: { requestId?: string; httpStatusCode?: number } } | undefined)?.$metadata;
        if (meta?.requestId) span.setAttribute('aws.request_id', meta.requestId);
        if (meta?.httpStatusCode) span.setAttribute(ATTR.status, meta.httpStatusCode);
        return r;
      } catch (e) {
        const meta = (e as { $metadata?: { requestId?: string; httpStatusCode?: number } }).$metadata;
        if (meta?.requestId) span.setAttribute('aws.request_id', meta.requestId);
        if (meta?.httpStatusCode) span.setAttribute(ATTR.status, meta.httpStatusCode);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw e;
      } finally {
        span.end();
      }
    });
  }, { step: 'initialize', name: 'gekko08TraceSpan' });
  return client;
}
