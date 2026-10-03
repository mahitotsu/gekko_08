import { AuthzError, verifyInbound, type VerifyOptions } from '@gekko08/authz-context';
import { beforeAll, describe, expect, it } from 'vitest';
import { chainTo, mintJwt, type Outputs, purposeSession, type RequestSession, stackOutputs, USERS } from './helpers';
import { authz as accountServiceAuthz } from '@gekko08/account-service/authz';
import { authz as caseServiceAuthz } from '@gekko08/case-service/authz';

// FR-1：各ホップの受信側の検証を、STSが実際に発行したJWTと発行者の実際のJWKSで確かめる。
// デプロイしたホップの入口は直前のホップしか通れないため、不正なJWTはホップと同じ共通部品（verifyInbound）に直接渡す
let o: Outputs;
let purpose: RequestSession;
let chained: RequestSession;

// 入口のIAMが確かめた呼び出し元に相当する値
const callerArn = (role: string) => `arn:aws:sts::123456789012:assumed-role/${role}/fn`;
// 対応表は「実行role名 → chain用roleのARN」で書き、ホップ名は実行role名で代える
// 提供側の定義は、ホップと同じもの（呼び出し元の制限は、ホップ名の代わりの実行role名では照合できないので外す）
const providesFor = (audience: string) => Object.fromEntries(Object.entries(
  (audience === o.CaseServiceAudience ? caseServiceAuthz : accountServiceAuthz).provides!,
).map(([scope, { purposes }]) => [scope, { purposes }]));
const optsFor = (audience: string, callers: Record<string, string>): VerifyOptions => ({
  issuer: o.Issuer, audience, callers: Object.fromEntries(Object.entries(callers).map(([role, sub]) => [role, { hop: role, sub }])),
  provides: providesFor(audience),
});

async function rejectedWith(p: Promise<unknown>, status: number) {
  const e = await p.then(() => undefined, (err) => err);
  expect(e).toBeInstanceOf(AuthzError);
  expect(e.status).toBe(status);
}

const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
const parts = (token: string) => token.split('.');
const payloadOf = (token: string) => JSON.parse(Buffer.from(parts(token)[1], 'base64url').toString());

beforeAll(async () => {
  o = await stackOutputs();
  purpose = await purposeSession('tokyoManager', 'case-summary');
  chained = await chainTo(purpose, o.CaseServiceChainRoleArn);
});

const toCase = () => mintJwt(purpose, o.CaseServiceAudience, 'case:summary');
const caseOpts = () => optsFor(o.CaseServiceAudience, { 'bff-exec': o.PurposeRoleArn });

describe('FR-1: 各ホップは、STSが署名したJWTでsubject・宛先・委任の範囲を確かめる', () => {
  it('bffが目的を刻んだセッションで作ったcase-service宛てのJWTから、subject・目的・scopeを取り出せる', async () => {
    const v = await verifyInbound(await toCase(), callerArn('bff-exec'), caseOpts(), purpose.requestId);
    expect(v).toEqual({
      subject: { id: USERS.tokyoManager }, purpose: 'case-summary', scope: 'case:summary', actor: 'bff-exec', actorRole: 'bff-exec', tokenSub: o.PurposeRoleArn,
      // JWTの`jti`。CloudTrailの`webIdentityTokenId`と一致し、監査で突き合わせる
      tokenId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('chainしたセッションが作ったJWTにも、同じsubjectと目的が引き継がれる', async () => {
    const v = await verifyInbound(await mintJwt(chained, o.AccountServiceAudience, 'account:read'), callerArn('case-exec'),
      optsFor(o.AccountServiceAudience, { 'case-exec': o.CaseServiceChainRoleArn }), purpose.requestId);
    expect(v).toMatchObject({ subject: { id: USERS.tokyoManager }, purpose: 'case-summary', scope: 'account:read', tokenSub: o.CaseServiceChainRoleArn });
  });

  it('scopeのないJWTは401（何も許さない）', async () => {
    await rejectedWith(verifyInbound(await mintJwt(purpose, o.CaseServiceAudience), callerArn('bff-exec'), caseOpts(), purpose.requestId), 401);
  });

  it('宛先の違うJWT（case-service宛てをaccount-serviceに渡す）は401', async () => {
    await rejectedWith(verifyInbound(await toCase(), callerArn('case-exec'),
      optsFor(o.AccountServiceAudience, { 'case-exec': o.PurposeRoleArn }), purpose.requestId), 401);
  });

  it('JWTを作ったroleが、入口を通った呼び出し元のchain用roleと違えば401', async () => {
    // 正しい宛先・正しい署名でも、fraud-mcpの実行roleから届いたなら、subはfraud-mcpのchain用roleでなければならない
    await rejectedWith(verifyInbound(await mintJwt(chained, o.AccountServiceAudience, 'account:read'), callerArn('mcp-exec'),
      optsFor(o.AccountServiceAudience, { 'mcp-exec': o.FraudMcpChainRoleArn }), purpose.requestId), 401);
  });

  it('本文を改ざんしたJWT（別のユーザー、目的、scopeに書き換え）は401', async () => {
    const token = await toCase();
    const p = payloadOf(token);
    const ns = p['https://sts.amazonaws.com/'];
    ns.source_identity = USERS.osakaOfficer;
    ns.principal_tags.purpose = 'agent-analysis';
    ns.request_tags.scope = 'case:read';
    const [h, , s] = parts(token);
    await rejectedWith(verifyInbound(`${h}.${b64(p)}.${s}`, callerArn('bff-exec'), caseOpts(), purpose.requestId), 401);
  });

  it('署名を改ざんしたJWTは401', async () => {
    const [h, p, s] = parts(await toCase());
    const forged = `${s.slice(0, -4)}${s.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
    await rejectedWith(verifyInbound(`${h}.${p}.${forged}`, callerArn('bff-exec'), caseOpts(), purpose.requestId), 401);
  });

  it('署名なし（alg=none）に書き換えたJWTは401', async () => {
    const token = await toCase();
    const header = { ...JSON.parse(Buffer.from(parts(token)[0], 'base64url').toString()), alg: 'none' };
    await rejectedWith(verifyInbound(`${b64(header)}.${parts(token)[1]}.`, callerArn('bff-exec'), caseOpts(), purpose.requestId), 401);
  });

  it('JWTに刻まれたリクエストIDと違うリクエストIDで届いたら401（FR-6）', async () => {
    await rejectedWith(verifyInbound(await toCase(), callerArn('bff-exec'), caseOpts(), 'forged-request-id'), 401);
    await rejectedWith(verifyInbound(await mintJwt(chained, o.AccountServiceAudience, 'account:read'), callerArn('case-exec'),
      optsFor(o.AccountServiceAudience, { 'case-exec': o.CaseServiceChainRoleArn }), 'forged-request-id'), 401);
  });

  it('JWTなしは401', async () => {
    await rejectedWith(verifyInbound(undefined, callerArn('bff-exec'), caseOpts(), purpose.requestId), 401);
  });

  it('期限の切れたJWTは401', async () => {
    const token = await mintJwt(purpose, o.CaseServiceAudience, 'case:summary', 60); // GetWebIdentityTokenの最短の有効期間
    expect(payloadOf(token).exp - payloadOf(token).iat).toBe(60);
    await new Promise((r) => setTimeout(r, 62_000));
    await rejectedWith(verifyInbound(token, callerArn('bff-exec'), caseOpts(), purpose.requestId), 401);
  }, 90_000);
});
