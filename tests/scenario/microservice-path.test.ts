import { AssumeRoleWithWebIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  browserGet, browserPost, chainTo, federatedSession, loginSession, mintJwt, type Outputs, provisionTestData, purposeSession, readAccount, signedPost, stackOutputs,
  TEST_DATA as T, USERS,
} from './helpers';

// マイクロサービスの経路（bff → case-service → account-service）のうち、案件を開くリクエストのシナリオテスト。凍結の解除はunfreeze.test.ts。
// デプロイしたスタックに対して実行し、各テストは要件のIDにひも付ける（設計書§10）
let o: Outputs;
let manager: string;
let officer: string;

beforeAll(async () => {
  o = await stackOutputs();
  await provisionTestData();
  [manager, officer] = await Promise.all([loginSession('tokyoManager'), loginSession('osakaOfficer')]);
});

describe('FR-1, FR-2: 委任の範囲と業務上のアクセス権の両方で判定する', () => {
  it('支店長（tokyo）は自分の支店の案件を開ける。口座の凍結の状態と理由はaccount-serviceから届く', async () => {
    const r = await browserGet(`/api/cases/${T.tokyoCase}/summary`, manager);
    expect(r.status).toBe(200);
    expect(r.body.case.caseId).toBe(T.tokyoCase);
    expect(r.body.account).toMatchObject({ accountId: T.tokyoAccount, branch: 'tokyo', status: 'frozen', frozenReason: expect.any(String) });
  });

  it('担当者（osaka）も自分の支店の案件を開ける', async () => {
    const r = await browserGet(`/api/cases/${T.osakaCase}/summary`, officer);
    expect(r.status).toBe(200);
    expect(r.body.account).toMatchObject({ accountId: T.osakaAccount, branch: 'osaka' });
  });

  it('他の支店の案件は、case-serviceが業務上のアクセス権で拒否する', async () => {
    expect((await browserGet(`/api/cases/${T.tokyoCase}/summary`, officer)).status).toBe(403);
    expect((await browserGet(`/api/cases/${T.osakaCase}/summary`, manager)).status).toBe(403);
  });

  it('FR-2: ブラウザが別のユーザーや目的を自己申告しても結果は変わらない', async () => {
    const r = await browserGet(`/api/cases/${T.osakaCase}/summary`, manager, {
      'x-authz-context': 'forged', 'x-user': USERS.osakaOfficer, 'x-branch': 'osaka', 'x-purpose': 'account-unfreeze',
    });
    expect(r.status).toBe(403);
  });
});

describe('FR-6: リクエストIDは入口で確定し、途中のホップは変えられない', () => {
  it('目的を刻むroleは、刻んだリクエストIDと違うセッション名では引き受けられない', async () => {
    await expect(purposeSession('tokyoManager', 'case-summary', [], { sessionName: 'other-request' }))
      .rejects.toThrow(/not authorized to perform: sts:AssumeRole/);
  });

  it('chainのセッション名を、刻まれたリクエストIDと違う値にできない', async () => {
    const s = await purposeSession('tokyoManager', 'case-summary');
    await expect(chainTo(s, o.CaseServiceChainRoleArn, { RoleSessionName: 'other-request' }))
      .rejects.toThrow(/not authorized to perform: sts:AssumeRole/);
    // 刻まれたリクエストIDなら引き受けられる
    await expect(chainTo(s, o.CaseServiceChainRoleArn)).resolves.toMatchObject({ requestId: s.requestId });
  });

  it('chainでリクエストIDのtagを上書きできない', async () => {
    const s = await purposeSession('tokyoManager', 'case-summary');
    await expect(chainTo(s, o.CaseServiceChainRoleArn, { Tags: [{ Key: 'requestId', Value: 'other-request' }], RoleSessionName: 'other-request' }))
      .rejects.toThrow(/conflicts with a transitive tag key|not authorized to perform: sts:AssumeRole/);
  });
});

describe('FR-3: ユーザーとリクエストの目的は入口で確定し、途中で変更も拡大もできない', () => {
  it('Cognitoが署名していないIDトークン（User Poolの発行者を名乗り、自分の鍵で署名）では、federated roleを引き受けられない', async () => {
    // BFFが乗っ取られても、ログインしていないユーザーにはなりすませない（脅威の総点検 A-10）
    const { privateKey } = await generateKeyPair('RS256');
    const forged = await new SignJWT({ 'https://aws.amazon.com/source_identity': USERS.tokyoManager, token_use: 'id' })
      .setProtectedHeader({ alg: 'RS256', kid: 'forged' })
      .setIssuer(`https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${o.UserPoolId}`)
      .setAudience(o.UserPoolClientId).setSubject('forged').setIssuedAt().setExpirationTime('5m')
      .sign(privateKey);
    await expect(new STSClient({}).send(new AssumeRoleWithWebIdentityCommand({
      RoleArn: o.FederatedRoleArn, RoleSessionName: 'forged', WebIdentityToken: forged, DurationSeconds: 900,
    }))).rejects.toThrow(/InvalidIdentityToken|signature|key/i);
  });

  it('chainでSourceIdentityを変えられない', async () => {
    const s = await purposeSession('tokyoManager', 'case-summary');
    await expect(chainTo(s, o.CaseServiceChainRoleArn, { SourceIdentity: USERS.osakaOfficer })).rejects.toThrow(/source identity is already set/);
  });

  it('chainで目的を上書きできない', async () => {
    const s = await purposeSession('tokyoManager', 'agent-analysis');
    await expect(chainTo(s, o.CaseServiceChainRoleArn, { Tags: [{ Key: 'purpose', Value: 'case-summary' }] }))
      .rejects.toThrow(/conflicts with a transitive tag key/);
  });

  it('定めていない目的は刻めない', async () => {
    await expect(purposeSession('tokyoManager', 'admin')).rejects.toThrow(/not authorized to perform: sts:TagSession/);
  });

  it('chainで新しいtagのキーを加えられない', async () => {
    const s = await purposeSession('tokyoManager', 'case-summary');
    await expect(chainTo(s, o.CaseServiceChainRoleArn, { Tags: [{ Key: 'role', Value: 'admin' }] }))
      .rejects.toThrow(/not authorized to perform: sts:TagSession/);
  });

  it('目的の制限があるscope（解除）は、案件を開くリクエストのcase-serviceのセッションでは発行できない', async () => {
    const s = await chainTo(await purposeSession('tokyoManager', 'case-summary'), o.CaseServiceChainRoleArn);
    await expect(mintJwt(s, o.AccountServiceAudience, 'account:unfreeze')).rejects.toThrow(/not authorized to perform: sts:TagGetWebIdentityToken/);
    // 同じセッションで、目的の制限がないscope（参照）は発行できる
    await expect(mintJwt(s, o.AccountServiceAudience, 'account:read')).resolves.toBeTypeOf('string');
  });

  it('凍結を解除するリクエストのcase-serviceのセッションなら、解除のscopeを発行できる', async () => {
    const s = await chainTo(await purposeSession('tokyoManager', 'account-unfreeze'), o.CaseServiceChainRoleArn);
    await expect(mintJwt(s, o.AccountServiceAudience, 'account:unfreeze')).resolves.toBeTypeOf('string');
  });

  it('bffの目的を刻むroleでも、解除の依頼のscopeは凍結を解除するリクエストでだけ発行できる', async () => {
    await expect(mintJwt(await purposeSession('tokyoManager', 'case-summary'), o.CaseServiceAudience, 'case:unfreeze'))
      .rejects.toThrow(/not authorized to perform: sts:TagGetWebIdentityToken/);
    await expect(mintJwt(await purposeSession('tokyoManager', 'account-unfreeze'), o.CaseServiceAudience, 'case:unfreeze')).resolves.toBeTypeOf('string');
  });

  it('宣言していないscopeは付けられない', async () => {
    const s = await purposeSession('tokyoManager', 'case-summary');
    await expect(mintJwt(s, o.CaseServiceAudience, 'case:read')).rejects.toThrow(/not authorized to perform: sts:TagGetWebIdentityToken/);
  });
});

describe('FR-4, SR-1, SR-2: 入口は直前のホップの実行roleだけを許可する', () => {
  it('SR-1: 受け渡したchainのセッションで署名しても、どのホップも呼べない', async () => {
    const s = await purposeSession('tokyoManager', 'case-summary');
    const toCase = await mintJwt(s, o.CaseServiceAudience, 'case:summary');
    expect((await signedPost(o.CaseServiceUrl, { action: 'summary', caseId: T.tokyoCase }, { 'x-authz-context': toCase }, s)).status).toBe(403);
    const chained = await chainTo(s, o.CaseServiceChainRoleArn);
    const toAccount = await mintJwt(chained, o.AccountServiceAudience, 'account:read');
    expect((await signedPost(o.AccountServiceUrl, { action: 'get', accountId: T.tokyoAccount }, { 'x-authz-context': toAccount }, chained)).status).toBe(403);
  });

  it('SR-1: 受け渡したchainのセッションで、内部のホップ以外を宛先に含むJWTを作れない', async () => {
    const s = await purposeSession('tokyoManager', 'case-summary');
    await expect(mintJwt(s, [o.CaseServiceAudience, 'https://external.example'], 'case:summary'))
      .rejects.toThrow(/not authorized to perform: sts:(TagG|G)etWebIdentityToken/);
    await expect(mintJwt(s, [o.CaseServiceAudience, 'https://external.example']))
      .rejects.toThrow(/not authorized to perform: sts:GetWebIdentityToken/);
  });

  it('SR-1: federated roleのセッションだけでは、どのホップ宛てのJWTも作れない', async () => {
    const fed = await federatedSession('tokyoManager');
    await expect(mintJwt(fed, o.CaseServiceAudience, 'case:summary')).rejects.toThrow(/not authorized to perform/);
  });

  it('FR-4・SR-2: 正しい宛先のJWTを持っていても、直前のホップ以外（テストを実行する主体）はcase-serviceを飛ばしてaccount-serviceを呼べない', async () => {
    const chained = await chainTo(await purposeSession('tokyoManager', 'case-summary'), o.CaseServiceChainRoleArn);
    const toAccount = await mintJwt(chained, o.AccountServiceAudience, 'account:read');
    expect((await signedPost(o.AccountServiceUrl, { action: 'get', accountId: T.tokyoAccount }, { 'x-authz-context': toAccount })).status).toBe(403);
  });

  it('SR-2: 許可していない主体はcase-serviceと属性サービスを呼べない', async () => {
    const s = await purposeSession('tokyoManager', 'case-summary');
    const toCase = await mintJwt(s, o.CaseServiceAudience, 'case:summary');
    expect((await signedPost(o.CaseServiceUrl, { action: 'summary', caseId: T.tokyoCase }, { 'x-authz-context': toCase })).status).toBe(403);
    expect((await signedPost(o.EntitlementServiceUrl, {}, {})).status).toBe(403);
  });

  it('SR-2: 署名のない呼び出しは拒否される', async () => {
    const r = await fetch(o.AccountServiceUrl, { method: 'POST', body: '{}' });
    expect(r.status).toBe(403);
  });
});

describe('FR-5: ブラウザには認証情報を持たせない', () => {
  it('/api/meはユーザー名と、属性サービスから得た所属・役職だけを返し、トークンもAWSの認証情報も含まない', async () => {
    const r = await browserGet('/api/me', manager);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ username: USERS.tokyoManager, branch: 'tokyo', title: '支店長' });
  });

  it('案件を開いた応答にトークンもAWSの認証情報も含まない', async () => {
    const r = await browserGet(`/api/cases/${T.tokyoCase}/summary`, manager);
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
    const session = await loginSession('tokyoManager');
    const r = await browserPost('/api/logout', '', session);
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/__Host-sid=; .*Max-Age=0/);
    expect((await browserGet('/api/me', session)).status).toBe(401);
    // マネージドログインのログイン状態も消すため、ブラウザをCognitoのログアウトに送る（戻り先は画面）
    const url = new URL(r.body.logoutUrl);
    expect(url.pathname).toBe('/logout');
    expect(url.searchParams.get('client_id')).toBe(o.UserPoolClientId);
    expect(url.searchParams.get('logout_uri')).toBe(`${o.WebUrl}/`);
  });

  it('セッションcookieがなければ401', async () => {
    expect((await browserGet('/api/me')).status).toBe(401);
  });

  it('攻撃者が選んだセッションID（存在しない値）のcookieは401で、セッションとして使われない', async () => {
    // bffはブラウザが送ったセッションIDを採用せず、ログインのたびに自分で作る（脅威の総点検 G-5）
    expect((await browserGet('/api/me', '__Host-sid=attacker-chosen-session-id')).status).toBe(401);
  });

  it('本文のハッシュのヘッダーがないPOST（別のサイトのフォームから送られる形）は、bffに届かず、口座は凍結されたまま', async () => {
    // セッションのcookieはSameSite=Strictで、別のサイトからは付かない。加えて、CloudFrontのOACは本文のハッシュを求めるので、
    // フォームのように任意のヘッダーを付けられない送信はbffに届かない（脅威の総点検 G-2）
    const body = JSON.stringify({});
    const res = await fetch(`${o.WebUrl}/api/cases/${T.tokyoCase}/unfreeze`, {
      method: 'POST', body, redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: manager },
    });
    expect(res.status).toBe(403);
    expect((await readAccount(T.tokyoAccount))?.status).toBe('frozen');
  });

  it('ログインのstateがcookieと違えば拒否し、一度使ったstateは二度と使えない', async () => {
    // ログインCSRFとstateの使い回しを防ぐ（脅威の総点検 G-3）
    const login = await browserGet('/api/login');
    const state = /__Host-login=([\w-]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1];
    if (!state) throw new Error('no login state cookie');
    const cb = (qs: string, cookieState: string) => browserGet(`/api/callback?${qs}`, `__Host-login=${cookieState}`);
    expect((await cb(`code=x&state=${state}`, 'other-state')).body).toEqual({ error: 'invalid login state' });
    // 1回目：stateは消費される（認可コードは偽物なので、トークンの交換は失敗する）
    expect((await cb(`code=x&state=${state}`, state)).status).not.toBe(302);
    // 2回目：同じstateはもう使えない
    const again = await cb(`code=x&state=${state}`, state);
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ error: 'login expired' });
  });
});
