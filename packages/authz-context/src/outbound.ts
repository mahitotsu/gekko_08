import { Sha256 } from '@aws-crypto/sha256-js';
import { AssumeRoleCommand, GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { SignatureV4 } from '@smithy/signature-v4';
import { ATTR, injectTraceContext, traceAwsClient, tracer } from './telemetry';
import { HEADER_CONTEXT, HEADER_REQUEST_ID, HEADER_SESSION, type CallResult, type SessionCredentials, type Target } from './types';

const region = () => process.env.AWS_REGION!;

// 実行roleの認証情報とSigV4の署名器は、実行環境ごとに使い回す
let signer: SignatureV4 | undefined;
function execSigner(): SignatureV4 {
  signer ??= new SignatureV4({ service: 'lambda', region: region(), credentials: defaultProvider(), sha256: Sha256 });
  return signer;
}

function stsWith(creds: SessionCredentials): STSClient {
  return traceAwsClient(new STSClient({ region: region(), credentials: creds }));
}

export function encodeSession(creds: SessionCredentials): string {
  return Buffer.from(JSON.stringify(creds)).toString('base64url');
}

export function decodeSession(header: string | undefined): SessionCredentials | undefined {
  if (!header) return undefined;
  try {
    const c = JSON.parse(Buffer.from(header, 'base64url').toString());
    if (typeof c.accessKeyId === 'string' && typeof c.secretAccessKey === 'string' && typeof c.sessionToken === 'string') {
      return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken };
    }
  } catch {
    // 不正な値は、セッションなしとして扱う
  }
  return undefined;
}

export type Timings = Record<string, number>;

export interface CallerOptions {
  /** 受け取ったchainのセッション（bffでは目的を刻むroleのセッション） */
  session: SessionCredentials;
  /** 自分のchain用role。bffのようにsessionをそのまま使う場合は省く */
  chainRoleArn?: string;
  requestId: string;
  targets: Record<string, Target>;
  timings: Timings;
}

export interface CallOptions {
  /** JWTに付けるscope。呼び出し先に付けられるscopeが1つだけなら省ける */
  scope?: string;
  /** 追加のヘッダー（MCPの`Accept`など）。認可・追跡・署名に使うヘッダーは、渡しても除く */
  headers?: Record<string, string>;
}

export type Call = (target: string, body: unknown, options?: CallOptions) => Promise<CallResult>;

/** 業務のコードが付けられないヘッダー。認可、追跡、署名に使う。HTTPのヘッダー名は大文字と小文字を区別しないので、小文字で比べる */
const RESERVED_HEADERS = new Set([
  HEADER_CONTEXT, HEADER_SESSION, HEADER_REQUEST_ID,
  'traceparent', 'tracestate', 'baggage',
  'host', 'content-type', 'authorization', 'x-amz-date', 'x-amz-security-token', 'x-amz-content-sha256',
]);

/** 業務のコードが渡した追加のヘッダーから、予約したヘッダーを除く */
export function extraHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !RESERVED_HEADERS.has(name.toLowerCase())));
}

/** 時間を測る（NFR-3）。spanNameがあれば、同じ区切りでスパンも作る */
export async function timed<T>(timings: Timings, key: string, f: () => Promise<T>, spanName?: string): Promise<T> {
  if (!spanName) {
    const t0 = performance.now();
    try {
      return await f();
    } finally {
      timings[key] = (timings[key] ?? 0) + Math.round(performance.now() - t0);
    }
  }
  return tracer().startActiveSpan(spanName, async (span) => {
    const t0 = performance.now();
    try {
      return await f();
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw e;
    } finally {
      timings[key] = (timings[key] ?? 0) + Math.round(performance.now() - t0);
      span.end();
    }
  });
}

/** 次のホップを呼ぶ関数を作る。chainは1回のリクエストで1度だけ行う。 */
export function createCaller(opts: CallerOptions): Call {
  let chained: Promise<SessionCredentials> | undefined;
  const chain = () => {
    if (!opts.chainRoleArn) return Promise.resolve(opts.session);
    chained ??= timed(opts.timings, 'chainMs', async () => {
      const { Credentials: c } = await stsWith(opts.session).send(new AssumeRoleCommand({
        RoleArn: opts.chainRoleArn,
        RoleSessionName: opts.requestId,
        DurationSeconds: 900,
      }));
      return { accessKeyId: c!.AccessKeyId!, secretAccessKey: c!.SecretAccessKey!, sessionToken: c!.SessionToken! };
    }, 'chain (sts:AssumeRole)');
    return chained;
  };

  return (name, body, options = {}) => tracer().startActiveSpan(`call ${name}`, {
    kind: SpanKind.CLIENT, attributes: { [ATTR.target]: name, [ATTR.requestId]: opts.requestId },
  }, async (span) => {
    try {
      const r = await send(name, body, options);
      span.setAttribute(ATTR.status, r.status);
      if (r.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      return r;
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw e;
    } finally {
      span.end();
    }
  });

  async function send(name: string, body: unknown, options: CallOptions): Promise<CallResult> {
    const target = opts.targets[name];
    if (!target) throw new Error(`unknown target: ${name}`);
    // 利用側の定義にないscopeは、STSを呼ばずに失敗させる。目的に合わないscopeはIAMが拒否する
    const scope = options.scope ?? (target.scopes.length === 1 ? target.scopes[0] : undefined);
    if (!scope || !target.scopes.includes(scope)) throw new Error(`scope ${options.scope ?? '(unspecified)'} is not declared for ${name}`);
    const session = await chain();
    const token = await timed(opts.timings, 'mintMs', async () => {
      const r = await stsWith(session).send(new GetWebIdentityTokenCommand({
        Audience: [target.audience],
        SigningAlgorithm: 'ES384',
        DurationSeconds: 300,
        Tags: [{ Key: 'scope', Value: scope }],
      }));
      return r.WebIdentityToken!;
    }, 'mint JWT (sts:GetWebIdentityToken)');

    const url = new URL(target.url);
    const payload = JSON.stringify(body ?? {});
    const headers: Record<string, string> = {
      ...extraHeaders(options.headers),
      host: url.host,
      'content-type': 'application/json',
      [HEADER_CONTEXT]: token,
      [HEADER_REQUEST_ID]: opts.requestId,
    };
    if (target.forwardSession) headers[HEADER_SESSION] = encodeSession(session);
    // 送信のスパンを、呼び出し先の受信のスパンの親にする
    injectTraceContext(headers);
    // 呼び出しは自分の実行roleで署名する。入口のIAMはこれで呼び出し元（actor）を確かめる
    const signed = await execSigner().sign({
      method: 'POST', protocol: url.protocol, hostname: url.hostname, path: url.pathname, headers, body: payload,
    });
    return timed(opts.timings, 'callMs', async () => {
      const res = await fetch(url, { method: 'POST', headers: signed.headers, body: payload });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // JSONでなければ文字列のまま返す
      }
      return { status: res.status, body: parsed };
    });
  }
}
