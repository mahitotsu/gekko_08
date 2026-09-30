import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { AuthzError, verifyInbound } from './inbound';
import { log } from './log';
import { createCaller, decodeSession, type Call, type Timings } from './outbound';
import { HEADER_CONTEXT, HEADER_REQUEST_ID, HEADER_SESSION, type CallResult, type Subject, type Target } from './types';

/** 環境変数で渡すホップの設定。CDKの`Hop`が設定する。 */
export interface HopConfig {
  hop: string;
  audience: string;
  issuer: string;
  callers: Record<string, string>;
  chainRoleArn?: string;
  targets: Record<string, Target>;
}

export function hopConfigFromEnv(env = process.env): HopConfig {
  return {
    hop: env.HOP_NAME!,
    audience: env.HOP_AUDIENCE!,
    issuer: env.AUTHZ_ISSUER!,
    callers: JSON.parse(env.AUTHZ_CALLERS ?? '{}'),
    chainRoleArn: env.AUTHZ_CHAIN_ROLE || undefined,
    targets: JSON.parse(env.AUTHZ_TARGETS ?? '{}'),
  };
}

export interface HopContext {
  subject: Subject;
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
 * ホップのLambdaハンドラーを作る。受信時の検証、次のホップの呼び出し、ログを共通部品が行い、
 * 業務のコードには検証済みのsubjectだけを渡す。
 */
export function createHopHandler(business: HopHandler, config: HopConfig = hopConfigFromEnv()) {
  return async (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> => {
    const t0 = performance.now();
    const timings: Timings = {};
    const headers = event.headers ?? {};
    const requestId = headers[HEADER_REQUEST_ID];
    // 入口のIAM（AWS_IAM認証）が確かめた呼び出し元。型定義にないため、形を明示して読む
    const actorArn = (event.requestContext as { authorizer?: { iam?: { userArn?: string } } }).authorizer?.iam?.userArn;
    const base = { hop: config.hop, requestId, actorArn };

    if (!requestId || !REQUEST_ID.test(requestId)) {
      log('warn', 'rejected', { ...base, status: 400, reason: 'invalid request id' });
      return respond(400, { error: 'invalid request id' });
    }

    let verified;
    const tv = performance.now();
    try {
      verified = await verifyInbound(headers[HEADER_CONTEXT], actorArn, config);
    } catch (e) {
      const status = e instanceof AuthzError ? e.status : 401;
      log('warn', 'rejected', { ...base, status, reason: (e as Error).message });
      return respond(status, { error: status === 403 ? 'forbidden' : 'unauthorized' });
    }
    timings.verifyMs = Math.round(performance.now() - tv);

    const session = decodeSession(headers[HEADER_SESSION]);
    const call: Call = config.chainRoleArn && session
      ? createCaller({ session, chainRoleArn: config.chainRoleArn, requestId, targets: config.targets, timings })
      : async () => { throw new Error('this hop cannot call other hops'); };

    let result: CallResult;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body;
      result = await business(raw ? JSON.parse(raw) : {}, { subject: verified.subject, requestId, call });
    } catch (e) {
      log('error', 'handler failed', { ...base, error: (e as Error).name, detail: (e as Error).message });
      result = { status: 500, body: { error: 'internal error' } };
    }
    log('info', 'handled', {
      ...base,
      actor: verified.actor,
      tokenSub: verified.tokenSub,
      subject: verified.subject,
      status: result.status,
      timings: { ...timings, totalMs: Math.round(performance.now() - t0) },
    });
    return respond(result.status, result.body);
  };
}
