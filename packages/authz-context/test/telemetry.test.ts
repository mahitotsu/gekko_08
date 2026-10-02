import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHopHandler, type HopConfig } from '../src/handler';
import { ATTR, inboundContext, injectTraceContext, startOtlpTraceRelay, traceAwsClient } from '../src/telemetry';

const ISSUER = 'https://example.tokens.sts.global.api.aws';
const CHAIN = 'arn:aws:iam::123456789012:role/bff-federated';
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const PARENT = 'b7ad6b7169203331';

const memory = new InMemorySpanExporter();
let config: HopConfig;
let token: string;

beforeAll(async () => {
  new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] }).register();
  const { privateKey, publicKey } = await generateKeyPair('ES384');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES384' };
  config = {
    hop: 'case-service', audience: 'aud-case', issuer: ISSUER, targets: {},
    callers: { 'bff-exec': { hop: 'bff', sub: CHAIN } },
    provides: { 'case:summary': {} },
    keys: createLocalJWKSet({ keys: [jwk] }),
  };
  token = await new SignJWT({ 'https://sts.amazonaws.com/': { source_identity: 'yamada', principal_tags: { purpose: 'case-summary', requestId: 'req-1' }, request_tags: { scope: 'case:summary' } } })
    .setProtectedHeader({ alg: 'ES384', kid: 'k1' }).setIssuer(ISSUER).setAudience('aud-case').setSubject(CHAIN)
    .setIssuedAt().setExpirationTime('5m').sign(privateKey);
});
beforeEach(() => memory.reset());

const event = (headers: Record<string, string>, userArn = 'arn:aws:sts::123456789012:assumed-role/bff-exec/bff-fn') => ({
  headers, body: '{}', isBase64Encoded: false, requestContext: { authorizer: { iam: { userArn } } },
}) as unknown as LambdaFunctionURLEvent;

describe('受信のスパン', () => {
  it('呼び出し元のtraceparentを親にし、検証の結果（actor、目的、scope、ユーザー）を属性に入れる', async () => {
    const handler = createHopHandler(async () => ({ status: 200, body: {} }), config);
    await handler(event({ 'x-authz-context': token, 'x-request-id': 'req-1', traceparent: `00-${TRACE_ID}-${PARENT}-01` }));
    const [span] = memory.getFinishedSpans();
    expect(span.name).toBe('case-service');
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.parentSpanContext?.spanId).toBe(PARENT);
    expect(span.attributes).toMatchObject({
      [ATTR.hop]: 'case-service', [ATTR.inbound]: 'accepted', [ATTR.actor]: 'bff', [ATTR.purpose]: 'case-summary',
      [ATTR.scope]: 'case:summary', [ATTR.enduser]: 'yamada', [ATTR.requestId]: 'req-1', [ATTR.status]: 200,
    });
  });

  it('拒否したときは、拒否の理由を属性に入れる', async () => {
    const handler = createHopHandler(async () => ({ status: 200, body: {} }), config);
    await handler(event({ 'x-authz-context': token, 'x-request-id': 'req-2' }, 'arn:aws:sts::123456789012:assumed-role/other/x'));
    const [span] = memory.getFinishedSpans();
    expect(span.attributes).toMatchObject({ [ATTR.inbound]: 'rejected', [ATTR.rejectReason]: 'caller not allowed', [ATTR.status]: 403 });
    expect(span.attributes[ATTR.enduser]).toBeUndefined();
  });

  it('SR-3: JWTも受け渡すセッションも、スパンに入らない', async () => {
    const handler = createHopHandler(async () => ({ status: 200, body: {} }), config);
    await handler(event({ 'x-authz-context': token, 'x-authz-session': 'eyJhY2Nlc3NLZXlJZCI6IkFTSUEifQ', 'x-request-id': 'req-3' }));
    const text = JSON.stringify(memory.getFinishedSpans().map((s) => ({ attributes: s.attributes, events: s.events })));
    expect(text).not.toContain(token);
    expect(text).not.toContain('eyJhY2Nlc3NLZXlJZCI');
  });
});

describe('traceparentの引き継ぎ', () => {
  it('送信するヘッダーに、その時点のスパンのtraceparentを付ける', () => {
    trace.getTracer('test').startActiveSpan('call x', (span) => {
      const headers: Record<string, string> = {};
      injectTraceContext(headers);
      expect(headers.traceparent).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
      span.end();
    });
  });

  it('大文字のヘッダー名でも、受信のtraceparentを読める', () => {
    const ctx = inboundContext({ Traceparent: `00-${TRACE_ID}-${PARENT}-01` });
    expect(trace.getSpanContext(ctx)?.traceId).toBe(TRACE_ID);
  });
});

describe('AWS SDKの呼び出しのスパン', () => {
  // AWS SDKのクライアントの代わり。登録されたミドルウェアで、1回の呼び出しを再現する
  function fakeClient() {
    let mw: any;
    const client = { middlewareStack: { add: (m: any) => { mw = m; } } };
    traceAwsClient(client);
    return (input: unknown, output: unknown) => mw(async () => output, { clientName: 'DynamoDBClient', commandName: 'GetItemCommand' })({ input });
  }

  it('サービス名・操作名・テーブル名・リクエストIDを属性に入れ、キーは入れない', async () => {
    await fakeClient()({ TableName: 'cases', Key: { caseId: 'C-1001' } }, { output: { $metadata: { requestId: 'r-1', httpStatusCode: 200 } } });
    const [span] = memory.getFinishedSpans();
    expect(span.name).toBe('DynamoDB.GetItem');
    expect(span.attributes).toMatchObject({
      'rpc.system': 'aws-api', 'rpc.service': 'DynamoDB', 'rpc.method': 'GetItem', 'aws.dynamodb.table_names': ['cases'], 'aws.request_id': 'r-1',
    });
    expect(JSON.stringify(span.attributes)).not.toContain('C-1001');
  });
});

describe('子プロセスのトレースの中継', () => {
  it('トレースが無効なら、中継を立てない', async () => {
    expect(await startOtlpTraceRelay()).toBeUndefined();
  });
});
