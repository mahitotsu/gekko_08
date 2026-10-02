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

/**
 * 最近の取引（bffが最初のホップを呼んだもの）。表示の経路は除く。監査の操作も取引として含め、誰がどの取引を監査したかを追えるようにする。
 * 1回の操作（リクエスト）を1件とし、ログインのセッションの新しい順、セッションの中は時刻の順に並べる
 */
async function listTransactions() {
  const rows = await insights([LOG_GROUPS.bff], `fields @timestamp, requestId, route, purpose, user, status, sessionRef, loggedInAt, caseId, auditTarget
| filter message = "handled" and hop = "bff" and route != "me"
| sort @timestamp desc
| limit 500`, Date.now() - LIST_HOURS * 3600_000);
  const items = rows.map((r) => ({
    time: r['@timestamp'], requestId: r.requestId, route: r.route, purpose: r.purpose, user: r.user, status: num(r.status),
    sessionRef: r.sessionRef || undefined, loggedInAt: num(r.loggedInAt), caseId: r.caseId || undefined, auditTarget: r.auditTarget || undefined,
  }));
  // セッションの識別子がない記録（識別子を記録する前のセッション）は、ユーザーごとに1つにまとめる
  const key = (t: (typeof items)[number]) => t.sessionRef ?? `user:${t.user}`;
  const latest = new Map<string, string>();
  for (const t of items) if ((latest.get(key(t)) ?? '') < t.time) latest.set(key(t), t.time);
  const started = (t: (typeof items)[number]) => (t.loggedInAt ? new Date(t.loggedInAt * 1000).toISOString() : latest.get(key(t))!);
  return items.sort((a, b) => started(b).localeCompare(started(a)) || key(a).localeCompare(key(b)) || a.time.localeCompare(b.time));
}

interface HopRecord {
  time: string;
  /** 処理を始めた時刻（ログを書いた時刻から処理時間を引いたもの） */
  startedAt?: string;
  /** 呼び出しの深さ（bffの呼び出し先が1） */
  depth: number;
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
  /** 拒否した呼び出しが、ヘッダーで名乗ったリクエストID。この取引のリクエストIDと違うときだけ持つ（JWTに刻まれた値はこの取引のもの） */
  claimedRequestId?: string;
  /** アプリの記録の情報源（このホップのロググループ） */
  logGroup?: string;
  /** `jti`と`webIdentityTokenId`で対応づけたAWSの記録（`GetWebIdentityToken`） */
  tokenEvent?: EventRef & { tokenId?: string };
  /** 項目ごとに、アプリの記録の値とAWSの記録の値を並べて比べた結果 */
  fields?: Field[];
  check: Check;
}

/** 比べたAWSの記録（CloudTrailのイベント） */
interface EventRef {
  event: string;
  eventId?: string;
  time: string;
}

interface Field {
  name: string;
  app?: string;
  aws?: string;
  /** AWSの値を取り出したイベント。未着ならない */
  awsEvent?: EventRef;
  result: 'match' | 'mismatch' | 'pending';
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
  /** CloudTrailのイベントID。CloudTrailのイベント履歴で同じイベントを引ける */
  eventId?: string;
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
    eventId: d.eventID,
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

// --- 呼び出しの順 ---

const logTime = (t: string) => new Date(`${t.replace(' ', 'T')}Z`).getTime();

/**
 * ログは各ホップが処理を終えたときに書くので、そのままでは下流のホップが先に並ぶ。処理時間から各ホップの処理の区間を求め、
 * 呼び出し元（actor）のホップの区間のうち、その区間を含む最も短いものを親とみなして、呼び出しの順（深さ優先）に並べる
 */
function callOrder(hops: HopRecord[], rows: Row[]): HopRecord[] {
  const span = (r: Row) => {
    const end = logTime(r['@timestamp']);
    const ms = num(r['timings.totalMs']);
    return { start: ms === undefined ? end : end - ms, end };
  };
  const hopRows = rows.filter((r) => r.hop !== 'bff');
  const nodes = hops.map((h, i) => ({ h, ...span(hopRows[i]), children: [] as number[] }));
  for (const n of nodes) if (n.start !== n.end) n.h.startedAt = new Date(n.start).toISOString();
  const roots: number[] = [];
  const TOLERANCE_MS = 5;
  nodes.forEach((n, i) => {
    let parent = -1;
    nodes.forEach((p, j) => {
      if (j === i || p.h.hop !== n.h.actor) return;
      if (p.start - TOLERANCE_MS <= n.start && n.end <= p.end + TOLERANCE_MS && (parent < 0 || p.end - p.start < nodes[parent].end - nodes[parent].start)) parent = j;
    });
    (parent < 0 ? roots : nodes[parent].children).push(i);
  });
  const out: HopRecord[] = [];
  const visit = (i: number, depth: number) => {
    nodes[i].h.depth = depth;
    out.push(nodes[i].h);
    for (const c of nodes[i].children.sort((a, b) => nodes[a].start - nodes[b].start)) visit(c, depth + 1);
  };
  for (const r of roots.sort((a, b) => nodes[a].start - nodes[b].start)) visit(r, 1);
  return out;
}

// --- 突き合わせ ---

async function reconcile(requestId: string) {
  const groups = Object.values(LOG_GROUPS);
  // 拒否の記録は、ヘッダーのリクエストID（自己申告）ではなく、JWTに刻まれていた値でも引く。ヘッダーを偽った呼び出しは、刻まれた値の取引に出し、
  // 名乗られた取引には出さない
  const rows = (await insights(groups, `fields @timestamp, message, hop, requestId, route, user, actor, tokenSub, tokenId, subject.id, purpose, scope, status, reason, stampedRequestId, timings.totalMs
| filter (requestId = "${requestId}" or stampedRequestId = "${requestId}") and (message = "handled" or message = "rejected")
| sort @timestamp asc
| limit 1000`, Date.now() - RECONCILE_DAYS * 86400_000))
    .filter((r) => !r.stampedRequestId || r.stampedRequestId === requestId);

  const bffRow = rows.find((r) => r.hop === 'bff' && r.message === 'handled');
  const firstTime = rows[0]?.['@timestamp'];
  // CloudTrailは取引の少し前から引く（時刻はUTC）
  const since = firstTime ? new Date(new Date(`${firstTime.replace(' ', 'T')}Z`).getTime() - 5 * 60_000) : new Date(Date.now() - RECONCILE_DAYS * 86400_000);
  const records = rows.length ? await awsRecords(requestId, since) : [];

  const stamped = records.find((r) => r.event === 'AssumeRole' && r.purpose);
  const byToken = new Map(records.filter((r) => r.tokenId).map((r) => [r.tokenId!, r]));
  const purposeField = (app: string | undefined): Field => compare('目的', app, stamped && { value: stamped.purpose, event: stamped });

  const hops: HopRecord[] = rows.filter((r) => r.hop !== 'bff').map((r) => {
    const base = {
      time: r['@timestamp'], hop: r.hop, status: num(r.status), reason: r.reason || undefined, depth: 1, logGroup: LOG_GROUPS[r.hop],
    };
    if (r.message === 'rejected') {
      return { ...base, outcome: 'rejected', ...(r.stampedRequestId ? { claimedRequestId: r.requestId } : {}), check: { result: 'n/a' } };
    }
    const tokenId = r.tokenId || undefined;
    const ev = tokenId ? byToken.get(tokenId) : undefined;
    const fromToken = (value: string | undefined) => ev && { value, event: ev };
    // JWTを発行したroleは、role名で比べ、表示名で示す
    const issuer = compare('JWTを発行したrole', principal(r.tokenSub), ev && { value: ev.issuerRole ? PRINCIPALS[ev.issuerRole] ?? 'このスタックの外のrole' : '不明', event: ev });
    if (ev && ev.issuerRole !== roleName(r.tokenSub)) issuer.result = 'mismatch';
    const fields = [
      issuer,
      compare('宛先', r.hop, fromToken(ev?.audience)),
      compare('scope', r.scope, fromToken(ev?.scope)),
      compare('ユーザー', r['subject.id'], fromToken(ev?.sourceIdentity)),
      purposeField(r.purpose),
    ];
    return {
      ...base, outcome: 'handled', actor: r.actor, tokenIssuer: principal(r.tokenSub), tokenId,
      subject: r['subject.id'], purpose: r.purpose, scope: r.scope,
      ...(ev ? { tokenEvent: { ...eventRef(ev), tokenId: ev.tokenId } } : {}),
      fields, check: summarize(fields),
    };
  });

  const entryFields = bffRow ? [
    purposeField(bffRow.purpose),
    compare('ユーザー', bffRow.user, stamped && { value: stamped.sourceIdentity, event: stamped }),
  ] : [];

  return {
    hops: callOrder(hops, rows),
    transaction: bffRow ? {
      time: bffRow['@timestamp'], user: bffRow.user, route: bffRow.route, purpose: bffRow.purpose, status: num(bffRow.status),
      logGroup: LOG_GROUPS.bff, fields: entryFields, check: summarize(entryFields),
    } : null,
    awsRecords: records.map(({ issuerRole: _, ...r }) => r),
  };
}

const eventRef = (r: AwsRecord): EventRef => ({ event: r.event, eventId: r.eventId, time: r.time });

/** 1つの項目を、アプリの記録の値とAWSの記録の値で比べる。AWSの記録が未着なら`pending` */
function compare(name: string, app: string | undefined, aws: { value: string | undefined; event: AwsRecord } | undefined): Field {
  if (!aws) return { name, app, result: 'pending' };
  return { name, app, aws: aws.value, awsEvent: eventRef(aws.event), result: aws.value === app ? 'match' : 'mismatch' };
}

/** 項目ごとの結果をまとめる。1つでも違えば不一致、未着の項目が残れば未着 */
function summarize(fields: Field[]): Check {
  const mismatched = fields.filter((f) => f.result === 'mismatch').map((f) => f.name);
  if (mismatched.length) return { result: 'mismatch', fields: mismatched };
  return fields.some((f) => f.result === 'pending') ? { result: 'pending' } : { result: 'match' };
}
