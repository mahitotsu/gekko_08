import { beforeAll, describe, expect, it } from 'vitest';
import {
  browserGet, browserPost, chainTo, federatedSession, loginSession, mintJwt, purposeSession, signedPost, stackOutputs, type Outputs,
} from './helpers';

// マイクロサービスの経路（bff → case-service → account-service）のシナリオテスト。
// デプロイしたスタックに対して実行し、各テストは要件のIDにひも付ける（設計書§10）
let o: Outputs;
let yamada: string;
let tanaka: string;

beforeAll(async () => {
  o = await stackOutputs();
  [yamada, tanaka] = await Promise.all([loginSession('yamada'), loginSession('tanaka')]);
});

describe('FR-1, FR-2: 委任の範囲と業務的なアクセス権の両方で判定する', () => {
  it('yamada（tokyo・支店長）は自分の支店の案件の要約を開ける。口座と残高はaccount-serviceから届く', async () => {
    const r = await browserGet('/api/cases/C-1001/summary', yamada);
    expect(r.status).toBe(200);
    expect(r.body.case.caseId).toBe('C-1001');
    expect(r.body.account).toMatchObject({ accountId: 'A-101', branch: 'tokyo', balance: 1250000 });
  });

  it('担当者には残高を見る権限がないので、要約の口座に残高が含まれない', async () => {
    const r = await browserGet('/api/cases/C-2001/summary', tanaka);
    expect(r.status).toBe(200);
    expect(r.body.account).toMatchObject({ accountId: 'A-201', branch: 'osaka' });
    expect(r.body.account).not.toHaveProperty('balance');
  });

  it('他の支店の案件は、case-serviceが業務的なアクセス権で拒否する', async () => {
    expect((await browserGet('/api/cases/C-1001/summary', tanaka)).status).toBe(403);
    expect((await browserGet('/api/cases/C-2001/summary', yamada)).status).toBe(403);
  });

  it('FR-2: ブラウザが別のユーザーや目的を自己申告しても結果は変わらない', async () => {
    const r = await browserGet('/api/cases/C-2001/summary', yamada, {
      'x-authz-context': 'forged', 'x-user': 'tanaka', 'x-branch': 'osaka', 'x-purpose': 'agent-analysis',
    });
    expect(r.status).toBe(403);
  });
});

describe('FR-3: ユーザーと取引の目的は入口で確定し、途中で変更も拡大もできない', () => {
  it('chainでSourceIdentityを変えられない', async () => {
    const s = await purposeSession('yamada', 'case-summary');
    await expect(chainTo(s, o.CaseServiceChainRoleArn, { SourceIdentity: 'tanaka' })).rejects.toThrow(/source identity is already set/);
  });

  it('chainで目的を上書きできない', async () => {
    const s = await purposeSession('yamada', 'agent-analysis');
    await expect(chainTo(s, o.CaseServiceChainRoleArn, { Tags: [{ Key: 'purpose', Value: 'case-summary' }] }))
      .rejects.toThrow(/conflicts with a transitive tag key/);
  });

  it('定めていない目的は刻めない', async () => {
    await expect(purposeSession('yamada', 'admin')).rejects.toThrow(/not authorized to perform: sts:TagSession/);
  });

  it('chainで新しいtagのキーを加えられない', async () => {
    const s = await purposeSession('yamada', 'case-summary');
    await expect(chainTo(s, o.CaseServiceChainRoleArn, { Tags: [{ Key: 'role', Value: 'admin' }] }))
      .rejects.toThrow(/not authorized to perform: sts:TagSession/);
  });

  it('目的に合わない下流のJWTは発行できない（エージェントの分析の取引では、case-serviceはaccount-service宛てのJWTを作れない）', async () => {
    const s = await chainTo(await purposeSession('yamada', 'agent-analysis'), o.CaseServiceChainRoleArn);
    await expect(mintJwt(s, o.AccountServiceAudience, 'account:read')).rejects.toThrow(/not authorized to perform: sts:GetWebIdentityToken/);
  });

  it('宣言していないscopeは付けられない', async () => {
    const s = await purposeSession('yamada', 'case-summary');
    await expect(mintJwt(s, o.CaseServiceAudience, 'case:read')).rejects.toThrow(/not authorized to perform: sts:TagGetWebIdentityToken/);
  });
});

describe('FR-4, SR-1, SR-2: 入口は直前のホップの実行roleだけを許可する', () => {
  it('SR-1: 受け渡したchainのセッションで署名しても、どのホップも呼べない', async () => {
    const s = await purposeSession('yamada', 'case-summary');
    const toCase = await mintJwt(s, o.CaseServiceAudience, 'case:summary');
    expect((await signedPost(o.CaseServiceUrl, { action: 'summary', caseId: 'C-1001' }, { 'x-authz-context': toCase }, s)).status).toBe(403);
    const chained = await chainTo(s, o.CaseServiceChainRoleArn);
    const toAccount = await mintJwt(chained, o.AccountServiceAudience, 'account:read');
    expect((await signedPost(o.AccountServiceUrl, { accountId: 'A-101' }, { 'x-authz-context': toAccount }, chained)).status).toBe(403);
  });

  it('SR-1: 受け渡したchainのセッションで、内部のホップ以外を宛先に含むJWTを作れない', async () => {
    const s = await purposeSession('yamada', 'case-summary');
    await expect(mintJwt(s, [o.CaseServiceAudience, 'https://external.example'], 'case:summary'))
      .rejects.toThrow(/not authorized to perform: sts:(TagG|G)etWebIdentityToken/);
    await expect(mintJwt(s, [o.CaseServiceAudience, 'https://external.example']))
      .rejects.toThrow(/not authorized to perform: sts:GetWebIdentityToken/);
  });

  it('SR-1: federated roleのセッションだけでは、どのホップ宛てのJWTも作れない', async () => {
    const fed = await federatedSession('yamada');
    await expect(mintJwt(fed, o.CaseServiceAudience, 'case:summary')).rejects.toThrow(/not authorized to perform/);
  });

  it('FR-4・SR-2: 正しい宛先のJWTを持っていても、直前のホップ以外（テストを実行する主体）はcase-serviceを飛ばしてaccount-serviceを呼べない', async () => {
    const chained = await chainTo(await purposeSession('yamada', 'case-summary'), o.CaseServiceChainRoleArn);
    const toAccount = await mintJwt(chained, o.AccountServiceAudience, 'account:read');
    expect((await signedPost(o.AccountServiceUrl, { accountId: 'A-101' }, { 'x-authz-context': toAccount })).status).toBe(403);
  });

  it('SR-2: 許可していない主体はcase-serviceと属性サービスを呼べない', async () => {
    const s = await purposeSession('yamada', 'case-summary');
    const toCase = await mintJwt(s, o.CaseServiceAudience, 'case:summary');
    expect((await signedPost(o.CaseServiceUrl, { action: 'summary', caseId: 'C-1001' }, { 'x-authz-context': toCase })).status).toBe(403);
    expect((await signedPost(o.EntitlementServiceUrl, {}, {})).status).toBe(403);
  });

  it('SR-2: 署名のない呼び出しは拒否される', async () => {
    const r = await fetch(o.AccountServiceUrl, { method: 'POST', body: '{}' });
    expect(r.status).toBe(403);
  });
});

describe('FR-5: ブラウザには認証情報を持たせない', () => {
  it('/api/meはユーザー名と、属性サービスから得た所属・役職だけを返し、トークンもAWSの認証情報も含まない', async () => {
    const r = await browserGet('/api/me', yamada);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ username: 'yamada', branch: 'tokyo', title: '支店長' });
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
