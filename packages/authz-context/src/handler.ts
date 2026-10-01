import { SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { AuthzError, verifyInbound, type CallerEntry, type VerifyOptions } from './inbound';
import { log } from './log';
import { createCaller, decodeSession, type Call, type Timings } from './outbound';
import { ATTR, flushTelemetry, inboundContext, initTelemetry, tracer } from './telemetry';
import { HEADER_CONTEXT, HEADER_REQUEST_ID, HEADER_SESSION, type CallResult, type Provides, type Subject, type Target } from './types';

/** 環境変数で渡すホップの設定。CDKの`Hop`が設定する。 */
export interface HopConfig {
  hop: string;
  audience: string;
  issuer: string;
  callers: Record<string, CallerEntry>;
  /** 提供側の定義（受信時の照合に使う） */
  provides: Provides;
  chainRoleArn?: string;
  targets: Record<string, Target>;
  /** JWTの署名鍵の取得。テストでだけ差し替える */
  keys?: VerifyOptions['keys'];
}

export function hopConfigFromEnv(env = process.env): HopConfig {
  return {
    hop: env.HOP_NAME!,
    audience: env.HOP_AUDIENCE!,
    issuer: env.AUTHZ_ISSUER!,
    callers: JSON.parse(env.AUTHZ_CALLERS ?? '{}'),
    provides: JSON.parse(env.AUTHZ_PROVIDES ?? '{}'),
    chainRoleArn: env.AUTHZ_CHAIN_ROLE || undefined,
    targets: JSON.parse(env.AUTHZ_TARGETS ?? '{}'),
  };
}

export interface HopContext {
  subject: Subject;
  /** 呼び出し元のホップ名。入口のIAMが確かめた実行roleと、JWTを作ったroleの両方が一致している */
  actor: string;
  /**
   * 呼び出し元がこのホップに付けたscope。目的との組み合わせはIAMと共通部品が守るので、業務のコードはscopeだけで判断する。
   * 取引の目的は渡さない（業務のコードは目的を使わない。設計書§4）
   */
  scope: string;
  requestId: string;
  /** 次のホップを呼ぶ。呼び出し先がないホップでは使えない */
  call: Call;
}

export type HopHandler = (body: any, ctx: HopContext) => Promise<CallResult>;

// RoleSessionNameにも使うので、その文字種と長さに収まるものだけを受け付ける
const REQUEST_ID = /^[\w+=,.@-]{2,64}$/;

function respond(status: number, body: unknown): LambdaFunctionURLResult {
  return { statusCode: status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/**
 * ホップのLambdaハンドラーを作る。受信時の検証、次のホップの呼び出し、ログ、トレースを共通部品が行い、
 * 業務のコードには、検証済みのsubject、呼び出し元、scopeだけを渡す（取引の目的は渡さない）。
 */
export function createHopHandler(business: HopHandler, config: HopConfig = hopConfigFromEnv()) {
  initTelemetry(config.hop);
  const handle = createHandle(business, config);
  return (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> =>
    // 呼び出し元のtraceparentを親にする。このホップを呼べるのは、入口のIAMが確かめた呼び出し元だけ
    tracer().startActiveSpan(config.hop, { kind: SpanKind.SERVER, attributes: { [ATTR.hop]: config.hop } }, inboundContext(event.headers ?? {}), async (span) => {
      try {
        const res = await handle(event, span);
        const status = typeof res === 'object' ? res.statusCode ?? 200 : 200;
        span.setAttribute(ATTR.status, status);
        if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        return res;
      } finally {
        span.end();
        await flushTelemetry();
      }
    });
}

function createHandle(business: HopHandler, config: HopConfig) {
  return async (event: LambdaFunctionURLEvent, span: Span): Promise<LambdaFunctionURLResult> => {
    const t0 = performance.now();
    const timings: Timings = {};
    const headers = event.headers ?? {};
    const requestId = headers[HEADER_REQUEST_ID];
    // 入口のIAM（AWS_IAM認証）が確かめた呼び出し元。型定義にないため、形を明示して読む
    const actorArn = (event.requestContext as { authorizer?: { iam?: { userArn?: string } } }).authorizer?.iam?.userArn;
    const base = { hop: config.hop, requestId, actorArn };
    if (requestId) span.setAttribute(ATTR.requestId, requestId);
    const reject = (status: number, reason: string) => {
      span.setAttributes({ [ATTR.inbound]: 'rejected', [ATTR.rejectReason]: reason });
      log('warn', 'rejected', { ...base, status, reason });
    };

    if (!requestId || !REQUEST_ID.test(requestId)) {
      reject(400, 'invalid request id');
      return respond(400, { error: 'invalid request id' });
    }

    let verified;
    const tv = performance.now();
    try {
      verified = await verifyInbound(headers[HEADER_CONTEXT], actorArn, config);
    } catch (e) {
      const status = e instanceof AuthzError ? e.status : 401;
      reject(status, (e as Error).message);
      return respond(status, { error: status === 403 ? 'forbidden' : 'unauthorized' });
    }
    timings.verifyMs = Math.round(performance.now() - tv);
    span.setAttributes({
      [ATTR.inbound]: 'accepted', [ATTR.actor]: verified.actor, [ATTR.purpose]: verified.purpose, [ATTR.scope]: verified.scope,
      [ATTR.enduser]: verified.subject.id,
    });

    const session = decodeSession(headers[HEADER_SESSION]);
    const call: Call = config.chainRoleArn && session
      ? createCaller({ session, chainRoleArn: config.chainRoleArn, requestId, targets: config.targets, timings })
      : async () => { throw new Error('this hop cannot call other hops'); };

    let result: CallResult;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body;
      const { subject, actor, scope } = verified;
      result = await business(raw ? JSON.parse(raw) : {}, { subject, actor, scope, requestId, call });
    } catch (e) {
      log('error', 'handler failed', { ...base, error: (e as Error).name, detail: (e as Error).message });
      result = { status: 500, body: { error: 'internal error' } };
    }
    log('info', 'handled', {
      ...base,
      actor: verified.actor,
      actorRole: verified.actorRole,
      tokenSub: verified.tokenSub,
      subject: verified.subject,
      purpose: verified.purpose,
      scope: verified.scope,
      status: result.status,
      timings: { ...timings, totalMs: Math.round(performance.now() - t0) },
    });
    return respond(result.status, result.body);
  };
}
