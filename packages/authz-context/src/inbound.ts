import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Subject } from './types';

const STS_NAMESPACE = 'https://sts.amazonaws.com/';

export class AuthzError extends Error {
  constructor(readonly status: 401 | 403, message: string) {
    super(message);
  }
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
  /** 入口のIAMが確かめた呼び出し元の実行role名 → JWTの`sub`として期待するchain用roleのARN */
  callers: Record<string, string>;
  /** 署名鍵の取得。テストでは差し替える */
  keys?: JWTVerifyGetKey;
}

export interface Verified {
  subject: Subject;
  /** 呼び出し元の実行role名（actor） */
  actor: string;
  /** JWTの`sub`（呼び出し元のchain用role） */
  tokenSub: string;
}

const jwksByIssuer = new Map<string, Promise<JWTVerifyGetKey>>();

// JWKSは実行環境ごとにキャッシュする。joseは未知のkidのときだけ取り直す
function remoteKeys(issuer: string): Promise<JWTVerifyGetKey> {
  let keys = jwksByIssuer.get(issuer);
  if (!keys) {
    keys = (async () => {
      const res = await fetch(`${issuer}/.well-known/openid-configuration`);
      if (!res.ok) throw new Error(`openid-configuration: ${res.status}`);
      const { jwks_uri } = (await res.json()) as { jwks_uri: string };
      return createRemoteJWKSet(new URL(jwks_uri));
    })();
    keys.catch(() => jwksByIssuer.delete(issuer));
    jwksByIssuer.set(issuer, keys);
  }
  return keys;
}

/** `arn:aws:sts::<account>:assumed-role/<role>/<session>`から実行role名を取り出す。 */
export function roleNameFromAssumedRoleArn(arn: string | undefined): string | undefined {
  const m = arn?.match(/^arn:aws[\w-]*:sts::\d{12}:assumed-role\/([\w+=,.@-]+)\/[\w+=,.@-]+$/);
  return m?.[1];
}

function tagValue(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length === 1 && typeof v[0] === 'string') return v[0];
  return undefined;
}

/**
 * 受け取ったJWTを検証し、subjectを返す。
 * actor（呼び出し元の実行role）は入口のIAMが確かめた値を渡す。ヘッダーや本文の自己申告は使わない（FR-2）。
 */
export async function verifyInbound(token: string | undefined, callerArn: string | undefined, opts: VerifyOptions): Promise<Verified> {
  const actor = roleNameFromAssumedRoleArn(callerArn);
  const expectedSub = actor && opts.callers[actor];
  // 入口のresource policyで拒否されるはずの呼び出し元。多層防御としてここでも拒否する
  if (!actor || !expectedSub) throw new AuthzError(403, 'caller not allowed');
  if (!token) throw new AuthzError(401, 'missing authorization context');

  const keys = opts.keys ?? (await remoteKeys(opts.issuer));
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      issuer: opts.issuer,
      audience: opts.audience,
      algorithms: ['ES384'],
      requiredClaims: ['exp', 'iat', 'sub'],
    }));
  } catch (e) {
    throw new AuthzError(401, `invalid authorization context: ${(e as Error).name}`);
  }
  // JWTを作ったのが、入口を通った呼び出し元のchain用roleであること
  if (payload.sub !== expectedSub) throw new AuthzError(401, 'token subject does not match caller');

  const ns = payload[STS_NAMESPACE] as { source_identity?: unknown; principal_tags?: Record<string, unknown> } | undefined;
  const id = ns?.source_identity;
  const branch = tagValue(ns?.principal_tags?.branch);
  if (typeof id !== 'string' || !id || !branch) throw new AuthzError(401, 'authorization context lacks subject');
  return { subject: { id, branch }, actor, tokenSub: payload.sub };
}
