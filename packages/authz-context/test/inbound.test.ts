import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuthzError, roleNameFromAssumedRoleArn, verifyInbound, type VerifyOptions } from '../src/inbound';

const ISSUER = 'https://example.tokens.sts.global.api.aws';
const CHAIN = 'arn:aws:iam::123456789012:role/case-chain';
const CALLER_ARN = 'arn:aws:sts::123456789012:assumed-role/case-exec/case-fn';
const RID = 'req-0001';

let opts: VerifyOptions;
let sign: (payload: JWTPayload, over?: { alg?: string; aud?: string; exp?: string; iss?: string }) => Promise<string>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES384');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES384' };
  opts = {
    issuer: ISSUER, audience: 'aud-account', callers: { 'case-exec': { hop: 'case-service', sub: CHAIN } },
    provides: { 'account:read': {}, 'account:unfreeze': { purposes: ['account-unfreeze'], callers: ['case-service'] } },
    keys: createLocalJWKSet({ keys: [jwk] }),
  };
  sign = (payload, over = {}) => new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES384', kid: 'k1' })
    .setIssuer(over.iss ?? ISSUER)
    .setAudience(over.aud ?? 'aud-account')
    .setSubject(CHAIN)
    .setIssuedAt()
    .setExpirationTime(over.exp ?? '5m')
    .sign(privateKey);
});

const ns = (over: Record<string, unknown> = {}) => ({
  'https://sts.amazonaws.com/': {
    source_identity: 'yamada', principal_tags: { purpose: 'case-summary', requestId: RID, project: 'x' }, request_tags: { scope: 'account:read' }, ...over,
  },
});
const claims = ns();

async function rejected(p: Promise<unknown>, status: number) {
  const e = await p.then(() => undefined, (err) => err);
  expect(e).toBeInstanceOf(AuthzError);
  expect(e.status).toBe(status);
}

describe('verifyInbound', () => {
  it('検証済みのsubjectとactorを返す', async () => {
    const v = await verifyInbound(await sign(claims), CALLER_ARN, opts, RID);
    expect(v).toEqual({ subject: { id: 'yamada' }, purpose: 'case-summary', scope: 'account:read', actor: 'case-service', actorRole: 'case-exec', tokenSub: CHAIN });
  });

  it('JWTの`jti`を、AWSの記録と突き合わせるための識別子として返す', async () => {
    const v = await verifyInbound(await sign({ ...claims, jti: 'b6f0c2de-0000-4000-8000-000000000001' }), CALLER_ARN, opts, RID);
    expect(v.tokenId).toBe('b6f0c2de-0000-4000-8000-000000000001');
  });

  it('tagの値が配列でも読める', async () => {
    const t = await sign(ns({ principal_tags: { purpose: ['case-summary'], requestId: RID } }));
    expect((await verifyInbound(t, CALLER_ARN, opts, RID)).purpose).toBe('case-summary');
  });

  it('宛先の違うJWTを拒否する', async () => rejected(verifyInbound(await sign(claims, { aud: 'aud-case' }), CALLER_ARN, opts, RID), 401));
  it('発行者の違うJWTを拒否する', async () => rejected(verifyInbound(await sign(claims, { iss: 'https://evil' }), CALLER_ARN, opts, RID), 401));
  it('期限切れのJWTを拒否する', async () => rejected(verifyInbound(await sign(claims, { exp: '-1m' }), CALLER_ARN, opts, RID), 401));
  it('改ざんしたJWTを拒否する', async () => {
    const t = await sign(claims);
    const [h, p, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), ...ns({ source_identity: 'tanaka' }) })).toString('base64url');
    await rejected(verifyInbound(`${h}.${forged}.${s}`, CALLER_ARN, opts, RID), 401);
  });
  it('JWTなしを拒否する', async () => rejected(verifyInbound(undefined, CALLER_ARN, opts, RID), 401));

  it('呼び出し元のchain用roleと`sub`が一致しなければ拒否する', async () => {
    const other = { ...opts, callers: { 'case-exec': { hop: 'case-service', sub: 'arn:aws:iam::123456789012:role/other-chain' } } };
    await rejected(verifyInbound(await sign(claims), CALLER_ARN, other, RID), 401);
  });

  it('対応表にない呼び出し元を拒否する', async () => {
    await rejected(verifyInbound(await sign(claims), 'arn:aws:sts::123456789012:assumed-role/admin/x', opts, RID), 403);
    await rejected(verifyInbound(await sign(claims), undefined, opts, RID), 403);
  });

  it('subjectが欠けたJWTを拒否する', async () => {
    await rejected(verifyInbound(await sign(ns({ source_identity: undefined })), CALLER_ARN, opts, RID), 401);
    await rejected(verifyInbound(await sign({}), CALLER_ARN, opts, RID), 401);
  });

  it('委任の範囲（目的かscope）が欠けたJWTを拒否する', async () => {
    await rejected(verifyInbound(await sign(ns({ principal_tags: { requestId: RID } })), CALLER_ARN, opts, RID), 401);
    await rejected(verifyInbound(await sign(ns({ request_tags: undefined })), CALLER_ARN, opts, RID), 401);
  });

  it('JWTに刻まれたリクエストIDと、届いたリクエストIDが違えば拒否する', async () => {
    await rejected(verifyInbound(await sign(claims), CALLER_ARN, opts, 'req-0002'), 401);
    await rejected(verifyInbound(await sign(claims), CALLER_ARN, opts, undefined), 401);
  });

  it('リクエストIDが刻まれていないJWTを拒否する', async () => {
    await rejected(verifyInbound(await sign(ns({ principal_tags: { purpose: 'case-summary' } })), CALLER_ARN, opts, RID), 401);
  });

  it('提供側の定義にないscopeを拒否する', async () => {
    await rejected(verifyInbound(await sign(ns({ request_tags: { scope: 'account:delete' } })), CALLER_ARN, opts, RID), 403);
  });

  it('目的の制限があるscopeは、許された目的と呼び出し元のときだけ受け付ける', async () => {
    const unfreeze = (purpose: string) => ns({ principal_tags: { purpose, requestId: RID }, request_tags: { scope: 'account:unfreeze' } });
    expect((await verifyInbound(await sign(unfreeze('account-unfreeze')), CALLER_ARN, opts, RID)).scope).toBe('account:unfreeze');
    await rejected(verifyInbound(await sign(unfreeze('case-summary')), CALLER_ARN, opts, RID), 403);
    const otherCaller = { ...opts, callers: { 'case-exec': { hop: 'fraud-mcp', sub: CHAIN } } };
    await rejected(verifyInbound(await sign(unfreeze('account-unfreeze')), CALLER_ARN, otherCaller, RID), 403);
  });
});

describe('roleNameFromAssumedRoleArn', () => {
  it('assumed-roleのARNからrole名を取り出す', () => {
    expect(roleNameFromAssumedRoleArn(CALLER_ARN)).toBe('case-exec');
    expect(roleNameFromAssumedRoleArn('arn:aws:iam::123456789012:role/case-exec')).toBeUndefined();
    expect(roleNameFromAssumedRoleArn('arn:aws:sts::123456789012:assumed-role/a/b/c')).toBeUndefined();
  });
});
