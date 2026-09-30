import { AssumeRoleCommand, GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts';
import { AuthzError, verifyInbound, type VerifyOptions } from '@gekko08/authz-context';
import type { AwsCredentialIdentity } from '@smithy/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { federatedSession, stackOutputs, type Outputs } from './helpers';

// FR-1：各ホップの受信側の検証を、STSが実際に発行したJWTと発行者の実際のJWKSで確かめる。
// デプロイしたホップの入口は直前のホップしか通れないため、不正なJWTはホップと同じ共通部品（verifyInbound）に直接渡す
let o: Outputs;
let fed: AwsCredentialIdentity;
let chained: AwsCredentialIdentity;

// 入口のIAMが確かめた呼び出し元に相当する値。対応表（callers）はデプロイ時の環境変数と同じ形で渡す
const callerArn = (role: string) => `arn:aws:sts::123456789012:assumed-role/${role}/fn`;
// 対応表は「実行role名 → chain用roleのARN」で書き、ホップ名は実行role名で代える
const optsFor = (audience: string, callers: Record<string, string>): VerifyOptions => ({
  issuer: o.Issuer, audience, callers: Object.fromEntries(Object.entries(callers).map(([role, sub]) => [role, { hop: role, sub }])),
});

const mint = async (credentials: AwsCredentialIdentity, audience: string, durationSeconds = 300) =>
  (await new STSClient({ credentials }).send(new GetWebIdentityTokenCommand({
    Audience: [audience], SigningAlgorithm: 'ES384', DurationSeconds: durationSeconds,
  }))).WebIdentityToken!;

async function rejectedWith(p: Promise<unknown>, status: number) {
  const e = await p.then(() => undefined, (err) => err);
  expect(e).toBeInstanceOf(AuthzError);
  expect(e.status).toBe(status);
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const parts = (token: string) => token.split('.');
const payloadOf = (token: string) => JSON.parse(Buffer.from(parts(token)[1], 'base64url').toString());

beforeAll(async () => {
  o = await stackOutputs();
  fed = await federatedSession('yamada');
  const { Credentials: c } = await new STSClient({ credentials: fed }).send(new AssumeRoleCommand({
    RoleArn: o.CaseServiceChainRoleArn, RoleSessionName: `test-${Date.now()}`, DurationSeconds: 900,
  }));
  chained = { accessKeyId: c!.AccessKeyId!, secretAccessKey: c!.SecretAccessKey!, sessionToken: c!.SessionToken! };
});

describe('FR-1: 各ホップは、STSが署名したJWTでsubjectと宛先を確かめる', () => {
  it('bffのセッションが作ったcase-service宛てのJWTから、subjectを取り出せる', async () => {
    const v = await verifyInbound(await mint(fed, o.CaseServiceAudience), callerArn('bff-exec'),
      optsFor(o.CaseServiceAudience, { 'bff-exec': o.FederatedRoleArn }));
    expect(v).toEqual({ subject: { id: 'yamada', branch: 'tokyo' }, actor: 'bff-exec', actorRole: 'bff-exec', tokenSub: o.FederatedRoleArn });
  });

  it('chainしたセッションが作ったJWTにも、同じsubjectが引き継がれる', async () => {
    const v = await verifyInbound(await mint(chained, o.AccountServiceAudience), callerArn('case-exec'),
      optsFor(o.AccountServiceAudience, { 'case-exec': o.CaseServiceChainRoleArn }));
    expect(v.subject).toEqual({ id: 'yamada', branch: 'tokyo' });
    expect(v.tokenSub).toBe(o.CaseServiceChainRoleArn);
  });

  it('宛先の違うJWT（case-service宛てをaccount-serviceに渡す）は401', async () => {
    await rejectedWith(verifyInbound(await mint(fed, o.CaseServiceAudience), callerArn('case-exec'),
      optsFor(o.AccountServiceAudience, { 'case-exec': o.FederatedRoleArn })), 401);
  });

  it('JWTを作ったroleが、入口を通った呼び出し元のchain用roleと違えば401', async () => {
    // 正しい宛先・正しい署名でも、fraud-mcpの実行roleから届いたなら、subはfraud-mcpのchain用roleでなければならない
    await rejectedWith(verifyInbound(await mint(chained, o.AccountServiceAudience), callerArn('mcp-exec'),
      optsFor(o.AccountServiceAudience, { 'mcp-exec': o.FraudMcpChainRoleArn })), 401);
  });

  it('本文を改ざんしたJWT（別のユーザーと支店に書き換え）は401', async () => {
    const token = await mint(fed, o.CaseServiceAudience);
    const p = payloadOf(token);
    p['https://sts.amazonaws.com/'].source_identity = 'tanaka';
    p['https://sts.amazonaws.com/'].principal_tags.branch = 'osaka';
    const [h, , s] = parts(token);
    await rejectedWith(verifyInbound(`${h}.${b64(p)}.${s}`, callerArn('bff-exec'),
      optsFor(o.CaseServiceAudience, { 'bff-exec': o.FederatedRoleArn })), 401);
  });

  it('署名を改ざんしたJWTは401', async () => {
    const [h, p, s] = parts(await mint(fed, o.CaseServiceAudience));
    const forged = `${s.slice(0, -4)}${s.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
    await rejectedWith(verifyInbound(`${h}.${p}.${forged}`, callerArn('bff-exec'),
      optsFor(o.CaseServiceAudience, { 'bff-exec': o.FederatedRoleArn })), 401);
  });

  it('署名なし（alg=none）に書き換えたJWTは401', async () => {
    const token = await mint(fed, o.CaseServiceAudience);
    const header = { ...JSON.parse(Buffer.from(parts(token)[0], 'base64url').toString()), alg: 'none' };
    await rejectedWith(verifyInbound(`${b64(header)}.${parts(token)[1]}.`, callerArn('bff-exec'),
      optsFor(o.CaseServiceAudience, { 'bff-exec': o.FederatedRoleArn })), 401);
  });

  it('JWTなしは401', async () => {
    await rejectedWith(verifyInbound(undefined, callerArn('bff-exec'),
      optsFor(o.CaseServiceAudience, { 'bff-exec': o.FederatedRoleArn })), 401);
  });

  it('期限の切れたJWTは401', async () => {
    const token = await mint(fed, o.CaseServiceAudience, 60); // GetWebIdentityTokenの最短の有効期間
    expect(payloadOf(token).exp - payloadOf(token).iat).toBe(60);
    await new Promise((r) => setTimeout(r, 62_000));
    await rejectedWith(verifyInbound(token, callerArn('bff-exec'),
      optsFor(o.CaseServiceAudience, { 'bff-exec': o.FederatedRoleArn })), 401);
  }, 90_000);
});
