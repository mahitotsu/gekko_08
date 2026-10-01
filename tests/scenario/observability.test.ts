import { writeFileSync } from 'node:fs';
import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserGet, eventually, type HandledLog, handledLogs, hopLogGroups, type HopName, loginSession, provisionTestData, readLogs, TEST_DATA as T, USERS } from './helpers';

// 追跡（FR-6）、ログに認証情報を入れない（SR-3）、処理時間の実測（NFR-3）。
// ログはCloudWatch Logsから読む。到着に数秒〜数十秒かかる
const HOPS: HopName[] = ['bff', 'case-service', 'account-service', 'entitlement-service'];
const LATENCY_SAMPLES = 10;

let startTime: number;
let allowedId: string;
let deniedId: string;
let latencyIds: string[];
let logsById: Awaited<ReturnType<typeof handledLogs>>;

beforeAll(async () => {
  startTime = Date.now() - 5000;
  await provisionTestData();
  const manager = await loginSession('tokyoManager');
  const summary = async (caseId: string) => {
    const r = await browserGet(`/api/cases/${caseId}/summary`, manager);
    expect(r.body.requestId).toBeTypeOf('string');
    return r.body.requestId as string;
  };
  allowedId = await summary(T.tokyoCase);
  deniedId = await summary(T.osakaCase); // case-serviceが業務的なアクセス権で拒否する
  latencyIds = [];
  for (let i = 0; i < LATENCY_SAMPLES; i++) latencyIds.push(await summary(T.tokyoCase));
  logsById = await handledLogs([allowedId, ...latencyIds], HOPS, startTime);
}, 240_000);

describe('FR-6: 1回のリクエストを、各ホップのログでリクエストIDとユーザーから追える', () => {
  it('bff・case-service・account-service・属性サービスのログが同じリクエストIDでつながり、ユーザー・目的・呼び出し元が記録される', () => {
    const l = logsById[allowedId];
    expect(l.bff).toMatchObject({ user: USERS.tokyoManager, purpose: 'case-summary', status: 200 });
    expect(l['case-service']).toMatchObject({ subject: { id: USERS.tokyoManager }, purpose: 'case-summary', scope: 'case:summary', status: 200 });
    expect(l['account-service']).toMatchObject({ subject: { id: USERS.tokyoManager }, purpose: 'case-summary', scope: 'account:read', status: 200 });
    expect(l['entitlement-service']).toMatchObject({ subject: { id: USERS.tokyoManager }, scope: 'entitlements:read', status: 200 });
    // actorは直前のホップ（入口の実行role）、JWTの`sub`は直前のホップのchain用role（bffでは目的用のrole）
    expect(l['case-service']).toMatchObject({ actor: 'bff' });
    expect(l['case-service']!.actorRole).toMatch(/BffFunction/);
    expect(l['case-service']!.tokenSub).toMatch(/PurposeRole/);
    expect(l['account-service']).toMatchObject({ actor: 'case-service' });
    expect(l['account-service']!.actorRole).toMatch(/CaseServiceFunction/);
    expect(l['account-service']!.tokenSub).toMatch(/CaseServiceChainRole/);
  });

  it('拒否されたリクエストも、リクエストIDとユーザーで追える', async () => {
    const [l] = Object.values(await handledLogs([deniedId], ['bff', 'case-service'], startTime));
    expect(l.bff).toMatchObject({ user: USERS.tokyoManager, status: 403 });
    expect(l['case-service']).toMatchObject({ subject: { id: USERS.tokyoManager }, status: 403 });
  });

  // CloudTrailは届くまでに最大15分ほどかかるため、CHECK_CLOUDTRAIL=1のときだけ実行する
  it.runIf(process.env.CHECK_CLOUDTRAIL)('CloudTrailのchainとJWTの発行のイベントに、セッション名（リクエストID）とSourceIdentityが記録される', async () => {
    const trail = new CloudTrailClient({});
    const events = await eventually(async () => {
      const { Events } = await trail.send(new LookupEventsCommand({ LookupAttributes: [{ AttributeKey: 'Username', AttributeValue: allowedId }] }));
      const names = new Set(Events?.map((e) => e.EventName));
      return names.has('AssumeRole') && names.has('GetWebIdentityToken') ? Events! : undefined;
    }, 20 * 60_000, 30_000);
    for (const e of events.filter((x) => ['AssumeRole', 'GetWebIdentityToken'].includes(x.EventName!))) {
      const detail = JSON.parse(e.CloudTrailEvent!);
      expect(detail.userIdentity.sessionContext.sourceIdentity).toBe(USERS.tokyoManager);
      expect(detail.userIdentity.arn).toContain(`/${allowedId}`);
    }
  }, 21 * 60_000);
});

describe('SR-3: 各ホップのログに、認証情報・JWT・cookieが含まれない', () => {
  const SECRETS: [string, RegExp][] = [
    ['JWT', /eyJ[\w-]+\.eyJ[\w-]+/],
    ['chainのセッション（x-authz-session）', /eyJhY2Nlc3NLZXlJZCI/],
    ['一時的なアクセスキー', /ASIA[A-Z0-9]{16}/],
    ['セッショントークン', /IQoJb3JpZ2lu/],
    ['セッションcookie', /__Host-sid=/],
  ];

  it('テスト中に出たログのすべてに、認証情報のパターンが現れない', async () => {
    const groups = await hopLogGroups();
    let total = 0;
    for (const hop of Object.keys(groups) as HopName[]) {
      const messages = await readLogs(groups[hop], startTime);
      total += messages.length;
      for (const m of messages) {
        for (const [name, re] of SECRETS) expect(re.test(m), `${hop}のログに${name}: ${m.slice(0, 120)}`).toBe(false);
      }
    }
    expect(total).toBeGreaterThan(0);
  });
});

describe('NFR-3: ホップごとの追加時間を実測する', () => {
  it('各ホップの処理時間を集計する', () => {
    const pick = (hop: HopName, key: string) => latencyIds.map((id) => (logsById[id][hop] as HandledLog).timings[key]).filter((v) => v !== undefined);
    const stats = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return { n: s.length, median: s[Math.floor(s.length / 2)], p90: s[Math.min(s.length - 1, Math.floor(s.length * 0.9))], max: s[s.length - 1] };
    };
    const rows: Record<string, ReturnType<typeof stats>> = {};
    for (const [hop, keys] of [
      ['bff', ['assumeMs', 'purposeMs', 'mintMs', 'callMs', 'totalMs']],
      ['case-service', ['verifyMs', 'chainMs', 'mintMs', 'callMs', 'totalMs']],
      ['account-service', ['verifyMs', 'chainMs', 'mintMs', 'callMs', 'totalMs']],
      ['entitlement-service', ['verifyMs', 'totalMs']],
    ] as [HopName, string[]][]) {
      for (const key of keys) {
        const xs = pick(hop, key);
        expect(xs.length, `${hop}.${key}`).toBe(LATENCY_SAMPLES);
        rows[`${hop}.${key}`] = stats(xs);
      }
    }
    console.table(rows);
    writeFileSync(new URL('../out-latency.json', import.meta.url), JSON.stringify({ measuredAt: new Date().toISOString(), samples: LATENCY_SAMPLES, rows }, null, 2));
  });
});
