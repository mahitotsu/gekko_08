import { AssumeRoleCommand, GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity } from '@smithy/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserGet, browserPost, federatedSession, loginSession, signedPost, stackOutputs, type Outputs } from './helpers';

// マイクロサービスの経路（bff → case-service → account-service）のシナリオテスト。
// デプロイしたスタックに対して実行し、各テストは要件のIDにひも付ける（設計書§10）
let o: Outputs;
let yamada: string;
let tanaka: string;

beforeAll(async () => {
  o = await stackOutputs();
  [yamada, tanaka] = await Promise.all([loginSession('yamada'), loginSession('tanaka')]);
});

const stsWith = (credentials: AwsCredentialIdentity) => new STSClient({ credentials });
const mint = async (credentials: AwsCredentialIdentity, audience: string) =>
  (await stsWith(credentials).send(new GetWebIdentityTokenCommand({ Audience: [audience], SigningAlgorithm: 'ES384', DurationSeconds: 300 }))).WebIdentityToken!;
const chainToCase = async (fed: AwsCredentialIdentity, extra: Partial<ConstructorParameters<typeof AssumeRoleCommand>[0]> = {}) => {
  const { Credentials: c } = await stsWith(fed).send(new AssumeRoleCommand({
    RoleArn: o.CaseServiceChainRoleArn, RoleSessionName: `test-${Date.now()}`, DurationSeconds: 900, ...extra,
  }));
  return { accessKeyId: c!.AccessKeyId!, secretAccessKey: c!.SecretAccessKey!, sessionToken: c!.SessionToken! };
};

describe('FR-1, FR-2: 各ホップが検証済みのsubjectでABACを行う', () => {
  it('yamada（tokyo）は自分の支店の案件の要約を開ける。口座はaccount-serviceから届く', async () => {
    const r = await browserGet('/api/cases/C-1001/summary', yamada);
    expect(r.status).toBe(200);
    expect(r.body.case.caseId).toBe('C-1001');
    expect(r.body.account).toMatchObject({ accountId: 'A-101', branch: 'tokyo' });
  });

  it('他の支店の案件はcase-serviceのABACで拒否される', async () => {
    expect((await browserGet('/api/cases/C-1001/summary', tanaka)).status).toBe(403);
    expect((await browserGet('/api/cases/C-2001/summary', yamada)).status).toBe(403);
  });

  it('FR-2: ブラウザが別のユーザーを自己申告しても結果は変わらない', async () => {
    const r = await browserGet('/api/cases/C-2001/summary', yamada, {
      'x-authz-context': 'forged', 'x-user': 'tanaka', 'x-branch': 'osaka',
    });
    expect(r.status).toBe(403);
  });
});

describe('FR-3: ログイン時に確定したユーザーと業務属性は途中で変えられない', () => {
  it('chainでSourceIdentityを変えられない', async () => {
    const fed = await federatedSession('yamada');
    await expect(chainToCase(fed, { SourceIdentity: 'tanaka' })).rejects.toThrow(/source identity is already set/);
  });

  it('chainでbranchを上書きできない', async () => {
    const fed = await federatedSession('yamada');
    await expect(chainToCase(fed, { Tags: [{ Key: 'branch', Value: 'osaka' }] })).rejects.toThrow(/conflicts with a transitive tag key/);
  });

  it('chainで新しいtagのキーを加えられない', async () => {
    const fed = await federatedSession('yamada');
    await expect(chainToCase(fed, { Tags: [{ Key: 'role', Value: 'admin' }] })).rejects.toThrow(/not authorized to perform: sts:TagSession/);
  });
});

describe('FR-4, SR-1, SR-2: 入口は直前のホップの実行roleだけを許可する', () => {
  it('SR-1: 受け渡したchainのセッションで署名しても、どのホップも呼べない', async () => {
    const fed = await federatedSession('yamada');
    const toCase = await mint(fed, o.CaseServiceAudience);
    expect((await signedPost(o.CaseServiceUrl, { action: 'summary', caseId: 'C-1001' }, { 'x-authz-context': toCase }, fed)).status).toBe(403);
    const chained = await chainToCase(fed);
    const toAccount = await mint(chained, o.AccountServiceAudience);
    expect((await signedPost(o.AccountServiceUrl, { accountId: 'A-101' }, { 'x-authz-context': toAccount }, chained)).status).toBe(403);
  });

  it('SR-1: 受け渡したchainのセッションで、内部のホップ以外を宛先に含むJWTを作れない', async () => {
    const fed = await federatedSession('yamada');
    await expect(stsWith(fed).send(new GetWebIdentityTokenCommand({
      Audience: [o.CaseServiceAudience, 'https://external.example'], SigningAlgorithm: 'ES384', DurationSeconds: 300,
    }))).rejects.toThrow(/not authorized to perform: sts:GetWebIdentityToken/);
  });

  it('FR-4・SR-2: 正しい宛先のJWTを持っていても、直前のホップ以外（テストを実行する主体）はcase-serviceを飛ばしてaccount-serviceを呼べない', async () => {
    const fed = await federatedSession('yamada');
    const toAccount = await mint(await chainToCase(fed), o.AccountServiceAudience);
    expect((await signedPost(o.AccountServiceUrl, { accountId: 'A-101' }, { 'x-authz-context': toAccount })).status).toBe(403);
  });

  it('SR-2: 許可していない主体はcase-serviceを呼べない', async () => {
    const fed = await federatedSession('yamada');
    const toCase = await mint(fed, o.CaseServiceAudience);
    expect((await signedPost(o.CaseServiceUrl, { action: 'summary', caseId: 'C-1001' }, { 'x-authz-context': toCase })).status).toBe(403);
  });

  it('SR-2: 署名のない呼び出しは拒否される', async () => {
    const r = await fetch(o.AccountServiceUrl, { method: 'POST', body: '{}' });
    expect(r.status).toBe(403);
  });
});

describe('FR-5: ブラウザには認証情報を持たせない', () => {
  it('/api/meはユーザー名と支店だけを返し、トークンもAWSの認証情報も含まない', async () => {
    const r = await browserGet('/api/me', yamada);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ username: 'yamada', branch: 'tokyo' });
  });

  it('要約の応答にトークンもAWSの認証情報も含まない', async () => {
    const r = await browserGet('/api/cases/C-1001/summary', yamada);
    expect(r.text).not.toMatch(/eyJ[\w-]+\.eyJ/); // JWT
    expect(r.text).not.toMatch(/ASIA[A-Z0-9]{12,}/); // 一時的なアクセスキー
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  it('ログインのリダイレクトで付くcookieはHttpOnlyで、トークンを含まない', async () => {
    const r = await browserGet('/api/login');
    expect(r.status).toBe(302);
    const setCookie = r.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/__Host-login=[\w-]+; Path=\/; Secure; HttpOnly; SameSite=Lax/);
    expect(setCookie).not.toMatch(/eyJ/);
  });

  it('ログアウトするとセッションが無効になり、cookieが消える', async () => {
    const session = await loginSession('yamada');
    const r = await browserPost('/api/logout', '', session);
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/__Host-sid=; .*Max-Age=0/);
    expect((await browserGet('/api/me', session)).status).toBe(401);
  });

  it('セッションcookieがなければ401', async () => {
    expect((await browserGet('/api/me')).status).toBe(401);
  });
});
