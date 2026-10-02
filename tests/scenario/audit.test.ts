import { beforeAll, describe, expect, it } from 'vitest';
import { browserGet, browserPost, eventually, loginSession, provisionTestData, TEST_DATA as T, USERS } from './helpers';

// FR-7(d)：監査の画面で、1回の取引について、各ホップの記録をAWSの記録と突き合わせて示す。監査は、監査の権限を持つユーザーだけが使える
interface Check { result: 'match' | 'mismatch' | 'pending' | 'n/a'; fields?: string[] }
interface HopRecord { hop: string; outcome: string; actor?: string; subject?: string; purpose?: string; scope?: string; status?: number; tokenId?: string; check: Check }
interface Reconciled {
  requestId: string;
  transaction: { user: string; route: string; purpose: string; status: number; check: Check } | null;
  hops: HopRecord[];
  awsRecords: Record<string, unknown>[];
}

let manager: string;
let auditor: string;
let requestId: string;

beforeAll(async () => {
  await provisionTestData();
  [manager, auditor] = await Promise.all([loginSession('tokyoManager'), loginSession('auditor')]);
  const r = await browserGet(`/api/cases/${T.tokyoCase}/summary`, manager);
  expect(r.status).toBe(200);
  requestId = r.body.requestId;
}, 60_000);

/** ログが届くまで待って、突き合わせの結果を得る */
async function reconciled(ready: (r: Reconciled) => boolean, timeoutMs: number, intervalMs = 5000): Promise<Reconciled> {
  return eventually(async () => {
    const r = await browserGet(`/api/audit/requests/${requestId}`, auditor);
    expect(r.status).toBe(200);
    return ready(r.body) ? (r.body as Reconciled) : undefined;
  }, timeoutMs, intervalMs);
}

const HOPS = ['case-service', 'account-service', 'entitlement-service'];

describe('FR-7(d): 監査担当は、取引ごとに各ホップの記録をAWSの記録と突き合わせられる', () => {
  it('ホップの記録に、各ホップが検証した呼び出し元・ユーザー・目的・scopeと、JWTの`jti`が出る', async () => {
    const r = await reconciled((x) => !!x.transaction && HOPS.every((h) => x.hops.some((y) => y.hop === h)), 120_000);
    expect(r.transaction).toMatchObject({ user: USERS.tokyoManager, route: 'case-summary', purpose: 'case-summary', status: 200 });
    const hop = (h: string) => r.hops.find((x) => x.hop === h)!;
    expect(hop('case-service')).toMatchObject({ outcome: 'handled', actor: 'bff', subject: USERS.tokyoManager, purpose: 'case-summary', scope: 'case:summary' });
    expect(hop('account-service')).toMatchObject({ actor: 'case-service', subject: USERS.tokyoManager, purpose: 'case-summary', scope: 'account:read' });
    for (const h of r.hops.filter((x) => x.outcome === 'handled')) expect(h.tokenId).toMatch(/^[0-9a-f-]{36}$/);
  }, 130_000);

  it('最近の取引の一覧に、その取引が出る', async () => {
    const list = await eventually(async () => {
      const r = await browserGet('/api/audit/requests', auditor);
      expect(r.status).toBe(200);
      return r.body.transactions.some((t: { requestId: string }) => t.requestId === requestId) ? r.body.transactions : undefined;
    }, 120_000, 5000);
    expect(list.find((t: { requestId: string }) => t.requestId === requestId)).toMatchObject({ user: USERS.tokyoManager, purpose: 'case-summary' });
  }, 130_000);

  // CloudTrailは届くまでに最大15分ほどかかるため、CHECK_CLOUDTRAIL=1のときだけ実行する
  it.runIf(process.env.CHECK_CLOUDTRAIL)('CloudTrailが届くと、bffと各ホップの記録がすべてAWSの記録と一致する', async () => {
    const r = await reconciled((x) => !!x.transaction && x.transaction.check.result !== 'pending' && x.hops.every((h) => h.check.result !== 'pending'), 20 * 60_000, 30_000);
    expect(r.transaction!.check).toEqual({ result: 'match' });
    for (const h of r.hops) expect(h.check, `${h.hop}`).toEqual({ result: 'match' });
    const events = new Set(r.awsRecords.map((a) => a.event));
    expect(events).toContain('AssumeRole');
    expect(events).toContain('GetWebIdentityToken');
    // SR-3：CloudTrailのイベントにある認証情報（AssumeRoleのresponseElements）を返さない
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/ASIA[A-Z0-9]{16}/);
    expect(text).not.toMatch(/IQoJb3JpZ2lu/);
    // roleのARN（アカウントIDを含む）も返さず、表示名に置き換える
    expect(text).not.toMatch(/arn:aws:/);
  }, 21 * 60_000);
});

describe('FR-7(d): 監査の権限は、業務的なアクセス権で分かれる', () => {
  it('支店長は監査できない（業務的なアクセス権で拒否）', async () => {
    const list = await browserGet('/api/audit/requests', manager);
    expect(list.status).toBe(403);
    expect(list.body).toMatchObject({ purpose: 'audit', reason: 'no entitlement' });
    const one = await browserGet(`/api/audit/requests/${requestId}`, manager);
    expect(one.status).toBe(403);
  });

  it('監査担当は案件を開けず、凍結も解除できない', async () => {
    const summary = await browserGet(`/api/cases/${T.tokyoCase}/summary`, auditor);
    expect(summary.status).toBe(403);
    expect(summary.body).toMatchObject({ reason: 'no entitlement' });
    const unfreeze = await browserPost(`/api/cases/${T.tokyoCase}/unfreeze`, '', auditor);
    expect(unfreeze.status).toBe(403);
  });
});
