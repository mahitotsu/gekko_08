import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuthzError, roleNameFromAssumedRoleArn, verifyInbound, type VerifyOptions } from '../src/inbound';

const ISSUER = 'https://example.tokens.sts.global.api.aws';
const CHAIN = 'arn:aws:iam::123456789012:role/case-chain';
const CALLER_ARN = 'arn:aws:sts::123456789012:assumed-role/case-exec/case-fn';

let opts: VerifyOptions;
let sign: (payload: JWTPayload, over?: { alg?: string; aud?: string; exp?: string; iss?: string }) => Promise<string>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES384');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES384' };
  opts = { issuer: ISSUER, audience: 'aud-account', callers: { 'case-exec': CHAIN }, keys: createLocalJWKSet({ keys: [jwk] }) };
  sign = (payload, over = {}) => new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES384', kid: 'k1' })
    .setIssuer(over.iss ?? ISSUER)
    .setAudience(over.aud ?? 'aud-account')
    .setSubject(CHAIN)
    .setIssuedAt()
    .setExpirationTime(over.exp ?? '5m')
    .sign(privateKey);
});

const claims = { 'https://sts.amazonaws.com/': { source_identity: 'yamada', principal_tags: { branch: 'tokyo', stack: 'x' } } };

async function rejected(p: Promise<unknown>, status: number) {
  const e = await p.then(() => undefined, (err) => err);
  expect(e).toBeInstanceOf(AuthzError);
  expect(e.status).toBe(status);
}

describe('verifyInbound', () => {
  it('検証済みのsubjectとactorを返す', async () => {
    const v = await verifyInbound(await sign(claims), CALLER_ARN, opts);
    expect(v).toEqual({ subject: { id: 'yamada', branch: 'tokyo' }, actor: 'case-exec', tokenSub: CHAIN });
  });

  it('tagの値が配列でも読める', async () => {
    const t = await sign({ 'https://sts.amazonaws.com/': { source_identity: 'yamada', principal_tags: { branch: ['tokyo'] } } });
    expect((await verifyInbound(t, CALLER_ARN, opts)).subject.branch).toBe('tokyo');
  });

  it('宛先の違うJWTを拒否する', async () => rejected(verifyInbound(await sign(claims, { aud: 'aud-case' }), CALLER_ARN, opts), 401));
  it('発行者の違うJWTを拒否する', async () => rejected(verifyInbound(await sign(claims, { iss: 'https://evil' }), CALLER_ARN, opts), 401));
  it('期限切れのJWTを拒否する', async () => rejected(verifyInbound(await sign(claims, { exp: '-1m' }), CALLER_ARN, opts), 401));
  it('改ざんしたJWTを拒否する', async () => {
    const t = await sign(claims);
    const [h, p, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), 'https://sts.amazonaws.com/': { source_identity: 'tanaka', principal_tags: { branch: 'osaka' } } })).toString('base64url');
    await rejected(verifyInbound(`${h}.${forged}.${s}`, CALLER_ARN, opts), 401);
  });
  it('JWTなしを拒否する', async () => rejected(verifyInbound(undefined, CALLER_ARN, opts), 401));

  it('呼び出し元のchain用roleと`sub`が一致しなければ拒否する', async () => {
    const other = { ...opts, callers: { 'case-exec': 'arn:aws:iam::123456789012:role/other-chain' } };
    await rejected(verifyInbound(await sign(claims), CALLER_ARN, other), 401);
  });

  it('対応表にない呼び出し元を拒否する', async () => {
    await rejected(verifyInbound(await sign(claims), 'arn:aws:sts::123456789012:assumed-role/admin/x', opts), 403);
    await rejected(verifyInbound(await sign(claims), undefined, opts), 403);
  });

  it('subjectが欠けたJWTを拒否する', async () => {
    await rejected(verifyInbound(await sign({ 'https://sts.amazonaws.com/': { source_identity: 'yamada' } }), CALLER_ARN, opts), 401);
    await rejected(verifyInbound(await sign({}), CALLER_ARN, opts), 401);
  });
});

describe('roleNameFromAssumedRoleArn', () => {
  it('assumed-roleのARNからrole名を取り出す', () => {
    expect(roleNameFromAssumedRoleArn(CALLER_ARN)).toBe('case-exec');
    expect(roleNameFromAssumedRoleArn('arn:aws:iam::123456789012:role/case-exec')).toBeUndefined();
    expect(roleNameFromAssumedRoleArn('arn:aws:sts::123456789012:assumed-role/a/b/c')).toBeUndefined();
  });
});
