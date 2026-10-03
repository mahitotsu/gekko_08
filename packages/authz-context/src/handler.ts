import type { Span } from '@opentelemetry/api';
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { requireEnv } from './env';
import { AuthzError, verifyInbound, type VerifyOptions } from './inbound';
import { log } from './log';
import { createCaller, decodeSession, type Call, type Timings } from './outbound';
import { ATTR, inboundContext, initTelemetry, serve } from './telemetry';
import { HEADER_CONTEXT, HEADER_REQUEST_ID, HEADER_SESSION, type CallerEntry, type CallResult, type Provides, type Subject, type Target } from './types';

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

export function hopConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HopConfig {
  // callers、provides、targetsは、CDKが委任の範囲の定義から生成したJSON
  return {
    hop: requireEnv('HOP_NAME', env),
    audience: requireEnv('HOP_AUDIENCE', env),
    issuer: requireEnv('AUTHZ_ISSUER', env),
    callers: JSON.parse(requireEnv('AUTHZ_CALLERS', env)) as Record<string, CallerEntry>,
    provides: JSON.parse(requireEnv('AUTHZ_PROVIDES', env)) as Provides,
    chainRoleArn: env.AUTHZ_CHAIN_ROLE || undefined,
    targets: JSON.parse(requireEnv('AUTHZ_TARGETS', env)) as Record<string, Target>,
  };
}

export interface HopContext {
  subject: Subject;
  /** 呼び出し元のホップ名。入口のIAMが確かめた実行roleと、JWTを作ったroleの両方が一致している */
  actor: string;
  /**
   * 呼び出し元がこのホップに付けたscope。目的との組み合わせはIAMと共通部品が守るので、業務のコードはscopeだけで判断する。
   * リクエストの目的は渡さない（業務のコードは目的を使わない。設計書§4）
   */
  scope: string;
  requestId: string;
  /** 受信したヘッダー（名前は小文字）。JWT、受け渡されたセッション、署名のヘッダーは除く（SR-3） */
  headers: Readonly<Record<string, string>>;
  /** 次のホップを呼ぶ。呼び出し先がないホップでは使えない */
  call: Call;
}

/**
 * 業務のコード。bodyは、JSONのオブジェクトであることだけを共通部品が確かめた本文で、項目の形は業務のコードが確かめる
 */
export type HopHandler = (body: Record<string, unknown>, ctx: HopContext) => Promise<CallResult>;

// RoleSessionNameにも使うので、その文字種と長さに収まるものだけを受け付ける
const REQUEST_ID = /^[\w+=,.@-]{2,64}$/;

function respond(status: number, body: unknown): LambdaFunctionURLResult {
  // 本文のない応答（MCPの通知への202など）は、本文を付けない
  if (body === undefined) return { statusCode: status };
  return { statusCode: status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** Function URLのイベントの本文を、文字列で取り出す */
export function readBody(event: LambdaFunctionURLEvent): string {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body;
}

/** 本文をJSONのオブジェクトとして読む。空ならから（`{}`）、JSONのオブジェクトでなければundefined */
export function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// 業務のコードに渡さないヘッダー。JWTと受け渡されたセッションは認証情報で、署名のヘッダーは業務に関係がない（SR-3）
const isCredentialHeader = (name: string) => name.startsWith('x-authz-') || name.startsWith('x-amz-') || name === 'authorization';

function businessHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).flatMap(([k, v]) => {
    const name = k.toLowerCase();
    return v === undefined || isCredentialHeader(name) ? [] : [[name, v]];
  }));
}

/**
 * ホップのLambdaハンドラーを作る。受信時の検証、次のホップの呼び出し、ログ、トレースを共通部品が行い、
 * 業務のコードには、検証済みのsubject、呼び出し元、scopeだけを渡す（リクエストの目的は渡さない）。
 */
export function createHopHandler(business: HopHandler, config: HopConfig = hopConfigFromEnv()) {
  initTelemetry(config.hop);
  const handle = createHandle(business, config);
  // 呼び出し元のtraceparentを親にする。このホップを呼べるのは、入口のIAMが確かめた呼び出し元だけ
  return (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> =>
    serve(config.hop, inboundContext(event.headers ?? {}), (span) => handle(event, span));
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
    // ヘッダーのリクエストIDは、検証するまで呼び出し元の自己申告。JWTに刻まれた値と食い違ったときは、刻まれた値も残す
    const reject = (status: number, reason: string, stampedRequestId?: string) => {
      span.setAttributes({ [ATTR.inbound]: 'rejected', [ATTR.rejectReason]: reason });
      log('warn', 'rejected', { ...base, status, reason, ...(stampedRequestId ? { stampedRequestId } : {}) });
    };

    if (!requestId || !REQUEST_ID.test(requestId)) {
      reject(400, 'invalid request id');
      return respond(400, { error: 'invalid request id' });
    }

    let verified;
    const tv = performance.now();
    try {
      verified = await verifyInbound(headers[HEADER_CONTEXT], actorArn, config, requestId);
    } catch (e) {
      // 検証の拒否ではない失敗（発行者の公開鍵を取得できないなど）は、呼び出し元の誤りではないので500にする
      if (!(e instanceof AuthzError)) {
        log('error', 'verification failed', { ...base, error: e instanceof Error ? e.message : String(e) });
        return respond(500, { error: 'internal error' });
      }
      reject(e.status, e.message, e.stampedRequestId);
      return respond(e.status, { error: e.status === 403 ? 'forbidden' : 'unauthorized' });
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
    const body = parseJsonObject(readBody(event));
    if (!body) {
      result = { status: 400, body: { error: 'invalid request body' } };
    } else {
      try {
        const { subject, actor, scope } = verified;
        result = await business(body, { subject, actor, scope, requestId, headers: businessHeaders(headers), call });
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        log('error', 'handler failed', { ...base, error: error.name, detail: error.message });
        result = { status: 500, body: { error: 'internal error' } };
      }
    }
    log('info', 'handled', {
      ...base,
      actor: verified.actor,
      actorRole: verified.actorRole,
      tokenSub: verified.tokenSub,
      tokenId: verified.tokenId,
      subject: verified.subject,
      purpose: verified.purpose,
      scope: verified.scope,
      status: result.status,
      timings: { ...timings, totalMs: Math.round(performance.now() - t0) },
    });
    return respond(result.status, result.body);
  };
}
