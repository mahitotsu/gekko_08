import { Sha256 } from '@aws-crypto/sha256-js';
import { AssumeRoleCommand, GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';
import { HEADER_CONTEXT, HEADER_REQUEST_ID, HEADER_SESSION, type CallResult, type SessionCredentials, type Target } from './types';

const region = () => process.env.AWS_REGION!;

// 実行roleの認証情報とSigV4の署名器は、実行環境ごとに使い回す
let signer: SignatureV4 | undefined;
function execSigner(): SignatureV4 {
  signer ??= new SignatureV4({ service: 'lambda', region: region(), credentials: defaultProvider(), sha256: Sha256 });
  return signer;
}

function stsWith(creds: SessionCredentials): STSClient {
  return new STSClient({ region: region(), credentials: creds });
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
  /** 受け取ったchainのセッション（bffではfederated roleのセッション） */
  session: SessionCredentials;
  /** 自分のchain用role。bffのようにsessionをそのまま使う場合は省く */
  chainRoleArn?: string;
  requestId: string;
  targets: Record<string, Target>;
  timings: Timings;
}

export interface CallOptions {
  /** 追加のヘッダー（MCPの`Accept`など）。認可に関わるヘッダーは上書きできない */
  headers?: Record<string, string>;
}

export type Call = (target: string, body: unknown, options?: CallOptions) => Promise<CallResult>;

async function timed<T>(timings: Timings, key: string, f: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await f();
  } finally {
    timings[key] = (timings[key] ?? 0) + Math.round(performance.now() - t0);
  }
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
    });
    return chained;
  };

  return async (name, body, options = {}) => {
    const target = opts.targets[name];
    if (!target) throw new Error(`unknown target: ${name}`);
    const session = await chain();
    const token = await timed(opts.timings, 'mintMs', async () => {
      const r = await stsWith(session).send(new GetWebIdentityTokenCommand({
        Audience: [target.audience],
        SigningAlgorithm: 'ES384',
        DurationSeconds: 300,
      }));
      return r.WebIdentityToken!;
    });

    const url = new URL(target.url);
    const payload = JSON.stringify(body ?? {});
    const headers: Record<string, string> = {
      ...options.headers,
      host: url.host,
      'content-type': 'application/json',
      [HEADER_CONTEXT]: token,
      [HEADER_REQUEST_ID]: opts.requestId,
    };
    if (target.forwardSession) headers[HEADER_SESSION] = encodeSession(session);
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
  };
}
