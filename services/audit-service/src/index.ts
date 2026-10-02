import { CloudTrailClient, LookupEventsCommand, type Event } from '@aws-sdk/client-cloudtrail';
import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import { createHopHandler, traceAwsClient, type Call, type CallResult } from '@gekko08/authz-context';

// 監査サービス。1回の取引について、各ホップのログ（アプリの記録）と、CloudTrail（AWSの記録）を突き合わせる（監査サービスのADR）。
// 他のホップと同じ入口で守り、監査の権限（`audit:view`）を持つユーザーにだけ応じる。
// CloudTrailのイベントはそのまま返さない。`AssumeRole`の`responseElements`には認証情報の一部が入るので、突き合わせに使う項目だけを取り出す（SR-3）
const trail = traceAwsClient(new CloudTrailClient({}));
const logs = traceAwsClient(new CloudWatchLogsClient({}));

/** ホップ名→ロググループ名 */
const LOG_GROUPS: Record<string, string> = JSON.parse(process.env.AUDIT_LOG_GROUPS ?? '{}');
/** role名→表示名（ホップ名とroleの種類）。ARNとアカウントIDを画面に出さない */
const PRINCIPALS: Record<string, string> = JSON.parse(process.env.AUDIT_PRINCIPALS ?? '{}');
/** ホップのJWTの宛先の接頭辞（`<スタック名>:`） */
const AUDIENCE_PREFIX = process.env.AUDIT_AUDIENCE_PREFIX ?? '';

/** bffが発行するリクエストID（UUID）。Logs Insightsの照会に埋め込むので、形を厳しく確かめる */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIST_HOURS = 24;
/** ログの保持期間（1週間）に合わせる */
const RECONCILE_DAYS = 7;

const forbidden = (reason: string): CallResult => ({ status: 403, body: { error: 'forbidden', reason } });

export const handler = createHopHandler(async (body, { scope, call }) => {
  if (scope !== 'audit:read') return forbidden('scope does not allow the action');
  if (!(await canAudit(call))) return forbidden('no entitlement');
  if (body.action === 'list') return { status: 200, body: { transactions: await listTransactions() } };
  if (body.action === 'reconcile' && typeof body.requestId === 'string' && REQUEST_ID.test(body.requestId)) {
    return { status: 200, body: await reconcile(body.requestId) };
  }
  return { status: 400, body: { error: 'invalid request' } };
});

async function canAudit(call: Call): Promise<boolean> {
  const r = await call('entitlement-service', {}, { scope: 'entitlements:read' });
  return r.status === 200 && ((r.body as { permissions?: string[] }).permissions ?? []).includes('audit:view');
}

// --- ホップの記録（Logs Insights） ---

type Row = Record<string, string>;

async function insights(groups: string[], queryString: string, startMs: number): Promise<Row[]> {
  const { queryId } = await logs.send(new StartQueryCommand({
    logGroupNames: groups, queryString, startTime: Math.floor(startMs / 1000), endTime: Math.ceil(Date.now() / 1000) + 60,
  }));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const r = await logs.send(new GetQueryResultsCommand({ queryId }));
    if (r.status === 'Complete') {
      return (r.results ?? []).map((fields) => Object.fromEntries(fields.filter((f) => f.field && f.field !== '@ptr').map((f) => [f.field!, f.value ?? ''])));
    }
    if (r.status && !['Running', 'Scheduled'].includes(r.status)) throw new Error(`logs query ${r.status}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('logs query timed out');
}

const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));

/** 最近の取引（bffが最初のホップを呼んだもの）。表示と監査の経路は除く */
async function listTransactions() {
  const rows = await insights([LOG_GROUPS.bff], `fields @timestamp, requestId, route, purpose, user, status
| filter message = "handled" and hop = "bff" and route != "me" and route != "audit-list" and route != "audit-reconcile"
| sort @timestamp desc
| limit 50`, Date.now() - LIST_HOURS * 3600_000);
  return rows.map((r) => ({ time: r['@timestamp'], requestId: r.requestId, route: r.route, purpose: r.purpose, user: r.user, status: num(r.status) }));
}

interface HopRecord {
  time: string;
  hop: string;
  outcome: 'handled' | 'rejected';
  actor?: string;
  /** JWTを発行した主体（JWTの`sub`のrole）の表示名 */
  tokenIssuer?: string;
  tokenId?: string;
  subject?: string;
  purpose?: string;
  scope?: string;
  status?: number;
  reason?: string;
  check: Check;
}

type Check =
  | { result: 'match' }
  | { result: 'mismatch'; fields: string[] }
  | { result: 'pending' }
  | { result: 'n/a' };

// --- AWSの記録（CloudTrail） ---

interface AwsRecord {
  time: string;
  event: string;
  /** 呼んだ主体の表示名 */
  caller: string;
  sourceIdentity?: string;
  /** `AssumeRole`の引き受け先 */
  role?: string;
  /** `AssumeRole`で刻んだ目的 */
  purpose?: string;
  /** `GetWebIdentityToken`の宛先（ホップ名） */
  audience?: string;
  scope?: string;
  tokenId?: string;
  error?: string;
}

/** 突き合わせにだけ使う項目（JWTを発行したroleの名前）を加えたもの。応答には含めない */
type TrailRecord = AwsRecord & { issuerRole?: string };

function roleName(arn: string | undefined): string | undefined {
  if (!arn) return undefined;
  const assumed = arn.match(/:assumed-role\/([^/]+)\//);
  if (assumed) return assumed[1];
  return arn.match(/:role\/(?:.*\/)?([^/]+)$/)?.[1];
}

const principal = (arn: string | undefined) => {
  const name = roleName(arn);
  return name ? PRINCIPALS[name] ?? 'このスタックの外のrole' : '不明';
};

const audienceHop = (aud: string) => (aud.startsWith(AUDIENCE_PREFIX) ? aud.slice(AUDIENCE_PREFIX.length) : '（参照実装の外の宛先）');

function tag(tags: unknown, key: string): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  const t = tags.find((x) => (x as { key?: string }).key === key) as { value?: unknown } | undefined;
  return typeof t?.value === 'string' ? t.value : undefined;
}

/** イベントから、突き合わせに使う項目だけを取り出す。`responseElements`の`credentials`は読まない */
function toAwsRecord(e: Event): TrailRecord | undefined {
  if (!e.CloudTrailEvent) return undefined;
  const d = JSON.parse(e.CloudTrailEvent);
  const name: string = d.eventName;
  if (!['AssumeRole', 'AssumeRoleWithWebIdentity', 'GetWebIdentityToken'].includes(name)) return undefined;
  const req = d.requestParameters ?? {};
  const rec: AwsRecord = {
    time: d.eventTime,
    event: name,
    caller: name === 'AssumeRoleWithWebIdentity' ? 'Cognitoのユーザー（IDトークン）' : principal(d.userIdentity?.arn),
    sourceIdentity: d.userIdentity?.sessionContext?.sourceIdentity ?? d.responseElements?.sourceIdentity,
    ...(d.errorCode ? { error: String(d.errorCode) } : {}),
  };
  if (name !== 'GetWebIdentityToken') return { ...rec, role: principal(req.roleArn), purpose: tag(req.tags, 'purpose') };
  const audiences: string[] = Array.isArray(req.audience) ? req.audience : [req.audience].filter(Boolean);
  return {
    ...rec,
    audience: audiences.map(audienceHop).join(', '),
    scope: tag(req.tags, 'scope'),
    tokenId: d.responseElements?.webIdentityTokenId,
    issuerRole: roleName(d.userIdentity?.sessionContext?.sessionIssuer?.arn),
  };
}

async function awsRecords(requestId: string, since: Date): Promise<TrailRecord[]> {
  const out: TrailRecord[] = [];
  let NextToken: string | undefined;
  do {
    const r = await trail.send(new LookupEventsCommand({
      LookupAttributes: [{ AttributeKey: 'Username', AttributeValue: requestId }], StartTime: since, MaxResults: 50, NextToken,
    }));
    for (const e of r.Events ?? []) {
      const rec = toAwsRecord(e);
      if (rec) out.push(rec);
    }
    NextToken = r.NextToken;
  } while (NextToken && out.length < 500);
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

// --- 突き合わせ ---

async function reconcile(requestId: string) {
  const groups = Object.values(LOG_GROUPS);
  const rows = await insights(groups, `fields @timestamp, message, hop, route, user, actor, tokenSub, tokenId, subject.id, purpose, scope, status, reason
| filter requestId = "${requestId}" and (message = "handled" or message = "rejected")
| sort @timestamp asc
| limit 1000`, Date.now() - RECONCILE_DAYS * 86400_000);

  const bffRow = rows.find((r) => r.hop === 'bff' && r.message === 'handled');
  const firstTime = rows[0]?.['@timestamp'];
  // CloudTrailは取引の少し前から引く（時刻はUTC）
  const since = firstTime ? new Date(new Date(`${firstTime.replace(' ', 'T')}Z`).getTime() - 5 * 60_000) : new Date(Date.now() - RECONCILE_DAYS * 86400_000);
  const records = rows.length ? await awsRecords(requestId, since) : [];

  const stamped = records.find((r) => r.event === 'AssumeRole' && r.purpose);
  const byToken = new Map(records.filter((r) => r.tokenId).map((r) => [r.tokenId!, r]));

  const hops: HopRecord[] = rows.filter((r) => r.hop !== 'bff').map((r) => {
    const base = {
      time: r['@timestamp'], hop: r.hop, status: num(r.status), reason: r.reason || undefined,
    };
    if (r.message === 'rejected') return { ...base, outcome: 'rejected', check: { result: 'n/a' } };
    const rec: HopRecord = {
      ...base, outcome: 'handled', actor: r.actor, tokenIssuer: principal(r.tokenSub), tokenId: r.tokenId || undefined,
      subject: r['subject.id'], purpose: r.purpose, scope: r.scope, check: { result: 'pending' },
    };
    const ev = rec.tokenId ? byToken.get(rec.tokenId) : undefined;
    if (!ev) return rec;
    const fields: string[] = [];
    if (ev.issuerRole !== roleName(r.tokenSub)) fields.push('JWTを発行した主体');
    if (ev.audience !== r.hop) fields.push('宛先');
    if (ev.scope !== r.scope) fields.push('scope');
    if (ev.sourceIdentity !== r['subject.id']) fields.push('ユーザー');
    if (stamped && stamped.purpose !== r.purpose) fields.push('目的');
    rec.check = fields.length ? { result: 'mismatch', fields } : { result: 'match' };
    return rec;
  });

  let entry: Check = { result: 'pending' };
  if (bffRow && stamped) {
    const fields: string[] = [];
    if (stamped.purpose !== bffRow.purpose) fields.push('目的');
    if (stamped.sourceIdentity !== bffRow.user) fields.push('ユーザー');
    entry = fields.length ? { result: 'mismatch', fields } : { result: 'match' };
  }

  return {
    requestId,
    transaction: bffRow ? {
      time: bffRow['@timestamp'], user: bffRow.user, route: bffRow.route, purpose: bffRow.purpose, status: num(bffRow.status), check: entry,
    } : null,
    hops,
    awsRecords: records.map(({ issuerRole: _, ...r }) => r),
  };
}
