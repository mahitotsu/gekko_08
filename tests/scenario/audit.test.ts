import { beforeAll, describe, expect, it } from 'vitest';
import type { HopRecord, Reconciled as AuditResponse } from '../../services/audit-service/src/api';
import { browserGet, browserPost, eventually, loginSession, provisionTestData, TEST_DATA as T, USERS } from './helpers';

// FR-7(d)：監査の画面で、1回のリクエストについて、各ホップの記録をAWSの記録と突き合わせて示す。監査は、監査の権限を持つユーザーだけが使える
/** bffは、監査サービスの応答に、この監査の操作のリクエストIDと目的を加える */
type Reconciled = AuditResponse & { requestId: string; purpose: string };

let manager: string;
let auditor: string;
let requestId: string;
let unfreezeId: string;

beforeAll(async () => {
  await provisionTestData();
  [manager, auditor] = await Promise.all([loginSession('tokyoManager'), loginSession('auditor')]);
  const r = await browserGet(`/api/cases/${T.tokyoCase}/summary`, manager);
  expect(r.status).toBe(200);
  requestId = r.body.requestId;
  // 同じログインのセッションで、続けて他の支店の案件の凍結の解除を試みる（一連の操作）。拒否されるので、口座の状態は変わらない
  const u = await browserPost(`/api/cases/${T.osakaCase}/unfreeze`, '', manager);
  expect(u.status).toBe(403);
  unfreezeId = u.body.requestId;
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

describe('FR-7(d): 監査担当は、リクエストごとに各ホップの記録をAWSの記録と突き合わせられる', () => {
  it('ホップの記録に、各ホップが検証した呼び出し元・ユーザー・目的・scopeと、JWTの`jti`が出る', async () => {
    const r = await reconciled((x) => !!x.transaction && HOPS.every((h) => x.hops.some((y) => y.hop === h)), 120_000);
    expect(r.transaction).toMatchObject({ user: USERS.tokyoManager, route: 'case-summary', purpose: 'case-summary', status: 200 });
    const hop = (h: string) => r.hops.find((x) => x.hop === h)!;
    expect(hop('case-service')).toMatchObject({ outcome: 'handled', actor: 'bff', subject: USERS.tokyoManager, purpose: 'case-summary', scope: 'case:summary' });
    expect(hop('account-service')).toMatchObject({ actor: 'case-service', subject: USERS.tokyoManager, purpose: 'case-summary', scope: 'account:read' });
    for (const h of r.hops.filter((x) => x.outcome === 'handled')) expect(h.tokenId).toMatch(/^[0-9a-f-]{36}$/);
    // 呼び出しの順：case-service → （属性サービス、account-service → 属性サービス）
    expect(r.hops.map((h) => `${h.depth}:${h.hop}`)).toEqual(['1:case-service', '2:entitlement-service', '2:account-service', '3:entitlement-service']);
  }, 130_000);

  it('ホップの記録ごとに、比べる項目のアプリの記録の値と、その情報源（ロググループ）が出る', async () => {
    const r = await reconciled((x) => !!x.transaction && HOPS.every((h) => x.hops.some((y) => y.hop === h)), 120_000);
    expect(r.transaction!.logGroup).toBeTypeOf('string');
    expect(r.transaction!.fields.map((f) => f.name)).toEqual(['目的', 'ユーザー']);
    const hop = r.hops.find((x) => x.hop === 'account-service')!;
    expect(hop.logGroup).toBeTypeOf('string');
    expect(hop.logGroup).not.toBe(r.transaction!.logGroup);
    const app = Object.fromEntries(hop.fields!.map((f) => [f.name, f.app]));
    expect(app).toMatchObject({ 宛先: 'account-service', scope: 'account:read', ユーザー: USERS.tokyoManager, 目的: 'case-summary' });
    expect(Object.keys(app)).toContain('JWTを発行したrole');
  }, 130_000);

  it('最近のリクエストの一覧に、そのリクエストが出る', async () => {
    const list = await eventually(async () => {
      const r = await browserGet('/api/audit/requests', auditor);
      expect(r.status).toBe(200);
      return r.body.transactions.some((t: { requestId: string }) => t.requestId === requestId) ? r.body.transactions : undefined;
    }, 120_000, 5000);
    expect(list.find((t: { requestId: string }) => t.requestId === requestId)).toMatchObject({ user: USERS.tokyoManager, purpose: 'case-summary', caseId: T.tokyoCase });
  }, 130_000);

  it('監査の操作もリクエストとして一覧に出る。監査対象のリクエストIDと、監査サービスを通った記録を引ける', async () => {
    const own = await browserGet(`/api/audit/requests/${requestId}`, auditor);
    expect(own.status).toBe(200);
    // 応答のリクエストIDと目的は、bffがこの監査の操作に刻んだもの。監査サービスの本文の値では上書きされない
    const auditId: string = own.body.requestId;
    expect(auditId).not.toBe(requestId);
    expect(own.body.purpose).toBe('audit');
    const list = await eventually(async () => {
      const r = await browserGet('/api/audit/requests', auditor);
      return r.body.transactions?.find((t: { requestId: string }) => t.requestId === auditId);
    }, 120_000, 5000);
    expect(list).toMatchObject({ route: 'audit-reconcile', auditTarget: requestId, user: USERS.auditor, purpose: 'audit', status: 200 });
    // 監査の操作も、他のリクエストと同じく、各ホップがbffの刻んだリクエストIDで記録している
    const r = await eventually(async () => {
      const x = await browserGet(`/api/audit/requests/${list.requestId}`, auditor);
      return x.body.hops?.some((h: HopRecord) => h.hop === 'entitlement-service') ? (x.body as Reconciled) : undefined;
    }, 120_000, 5000);
    expect(r.transaction).toMatchObject({ route: 'audit-reconcile', purpose: 'audit', user: USERS.auditor });
    expect(r.hops.map((h) => `${h.depth}:${h.hop}`)).toEqual(['1:audit-service', '2:entitlement-service']);
    expect(r.hops[0]).toMatchObject({ outcome: 'handled', actor: 'bff', purpose: 'audit', scope: 'audit:read' });
  }, 250_000);

  it('同じログインのセッションの操作は、1つのまとまりとして時刻の順に並ぶ', async () => {
    const list = await eventually(async () => {
      const r = await browserGet('/api/audit/requests', auditor);
      return r.body.transactions?.some((t: { requestId: string }) => t.requestId === unfreezeId) ? r.body.transactions : undefined;
    }, 120_000, 5000);
    const ids = list.map((t: { requestId: string }) => t.requestId);
    const a = list[ids.indexOf(requestId)];
    const b = list[ids.indexOf(unfreezeId)];
    expect(a.sessionRef).toBeTypeOf('string');
    expect(b.sessionRef).toBe(a.sessionRef);
    expect(b).toMatchObject({ purpose: 'account-unfreeze', caseId: T.osakaCase, status: 403 });
    // 案件を開く → 凍結を解除の順で、間に別のセッションの操作が挟まらない
    const i = ids.indexOf(requestId);
    const j = ids.indexOf(unfreezeId);
    expect(j).toBeGreaterThan(i);
    expect(list.slice(i, j + 1).every((t: { sessionRef?: string }) => t.sessionRef === a.sessionRef)).toBe(true);
  }, 130_000);

  // CloudTrailは届くまでに最大15分ほどかかるため、CHECK_CLOUDTRAIL=1のときだけ実行する
  it.runIf(process.env.CHECK_CLOUDTRAIL)('CloudTrailが届くと、bffと各ホップの記録がすべてAWSの記録と一致する', async () => {
    const r = await reconciled((x) => !!x.transaction && x.transaction.check.result !== 'pending' && x.hops.every((h) => h.check.result !== 'pending'), 20 * 60_000, 30_000);
    expect(r.transaction!.check).toEqual({ result: 'match' });
    for (const h of r.hops) expect(h.check, `${h.hop}`).toEqual({ result: 'match' });
    // 比べた2つの値と、AWSの記録の情報源（イベントID）が出る。`jti`と同じ`webIdentityTokenId`のイベントを対応づけている
    for (const h of [r.transaction!, ...r.hops.filter((x) => x.outcome === 'handled')]) {
      for (const f of h.fields!) {
        expect(f, `${h.logGroup} ${f.name}`).toMatchObject({ result: 'match', aws: f.app });
        expect(f.awsEvent?.eventId).toBeTypeOf('string');
      }
    }
    for (const h of r.hops.filter((x) => x.outcome === 'handled')) {
      expect(h.tokenEvent).toMatchObject({ event: 'GetWebIdentityToken', tokenId: h.tokenId });
      expect(h.tokenEvent!.eventId).toBeTypeOf('string');
    }
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
