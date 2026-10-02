import type { AwsRecord, Check, EventRef, Field, HopRecord, Reconciled, Transaction } from './api';

// 突き合わせのロジック。AWSを呼ばない純粋な関数だけを置き、単体テストで確かめる。
// AWSから読む部分（Logs Insights、CloudTrailの`LookupEvents`）は`index.ts`にある

/** Logs Insightsの結果の1行（フィールド名→値） */
export type Row = Record<string, string>;

/** CDKが渡す対応表 */
export interface Directory {
  /** ホップ名→ロググループ名 */
  logGroups: Record<string, string>;
  /** role名→表示名（ホップ名とroleの種類）。ARNとアカウントIDを画面に出さない */
  principals: Record<string, string>;
  /** ホップのJWTの宛先の接頭辞（`<スタック名>:`） */
  audiencePrefix: string;
}

/** 突き合わせにだけ使う項目（JWTを発行したroleの名前）を加えたもの。応答には含めない */
export type TrailRecord = AwsRecord & { issuerRole?: string };

export const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));

/** Logs Insightsの`@timestamp`（UTC、空白区切り）をミリ秒にする */
export const logTime = (t: string) => new Date(`${t.replace(' ', 'T')}Z`).getTime();

export function roleName(arn: string | undefined): string | undefined {
  if (!arn) return undefined;
  const assumed = arn.match(/:assumed-role\/([^/]+)\//);
  if (assumed) return assumed[1];
  return arn.match(/:role\/(?:.*\/)?([^/]+)$/)?.[1];
}

const label = (dir: Directory, name: string | undefined) => (name ? dir.principals[name] ?? 'このスタックの外のrole' : '不明');
const principal = (dir: Directory, arn: string | undefined) => label(dir, roleName(arn));

function tag(tags: unknown, key: string): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  const t = tags.find((x) => (x as { key?: string }).key === key) as { value?: unknown } | undefined;
  return typeof t?.value === 'string' ? t.value : undefined;
}

/**
 * CloudTrailのイベント（`CloudTrailEvent`のJSON）から、突き合わせに使う項目だけを名前を決めて取り出す。
 * イベントをそのまま返さない。`AssumeRole`の`responseElements`には認証情報の一部が入るので、`credentials`は読まない（SR-3）
 */
export function toAwsRecord(cloudTrailEvent: string | undefined, dir: Directory): TrailRecord | undefined {
  if (!cloudTrailEvent) return undefined;
  const d = JSON.parse(cloudTrailEvent);
  const name: string = d.eventName;
  if (!['AssumeRole', 'AssumeRoleWithWebIdentity', 'GetWebIdentityToken'].includes(name)) return undefined;
  const req = d.requestParameters ?? {};
  const rec: AwsRecord = {
    time: d.eventTime,
    event: name,
    eventId: d.eventID,
    caller: name === 'AssumeRoleWithWebIdentity' ? 'Cognitoのユーザー（IDトークン）' : principal(dir, d.userIdentity?.arn),
    sourceIdentity: d.userIdentity?.sessionContext?.sourceIdentity ?? d.responseElements?.sourceIdentity,
    ...(d.errorCode ? { error: String(d.errorCode) } : {}),
  };
  if (name !== 'GetWebIdentityToken') return { ...rec, role: principal(dir, req.roleArn), purpose: tag(req.tags, 'purpose') };
  const audiences: string[] = Array.isArray(req.audience) ? req.audience : [req.audience].filter(Boolean);
  const audienceHop = (aud: string) => (aud.startsWith(dir.audiencePrefix) ? aud.slice(dir.audiencePrefix.length) : '（参照実装の外の宛先）');
  return {
    ...rec,
    audience: audiences.map(audienceHop).join(', '),
    scope: tag(req.tags, 'scope'),
    tokenId: d.responseElements?.webIdentityTokenId,
    issuerRole: roleName(d.userIdentity?.sessionContext?.sessionIssuer?.arn),
  };
}

/**
 * bffの記録から、最近のリクエストの一覧を作る。1回の操作（リクエスト）を1件とし、ログインのセッションの新しい順、セッションの中は時刻の順に並べる
 */
export function transactionsFrom(rows: Row[]): Transaction[] {
  const items: Transaction[] = rows.map((r) => ({
    time: r['@timestamp'], requestId: r.requestId, route: r.route, purpose: r.purpose, user: r.user, status: num(r.status),
    sessionRef: r.sessionRef || undefined, loggedInAt: num(r.loggedInAt), caseId: r.caseId || undefined, auditTarget: r.auditTarget || undefined,
  }));
  // セッションの識別子がない記録（識別子を記録する前のセッション）は、ユーザーごとに1つにまとめる
  const key = (t: Transaction) => t.sessionRef ?? `user:${t.user}`;
  const latest = new Map<string, string>();
  for (const t of items) if ((latest.get(key(t)) ?? '') < t.time) latest.set(key(t), t.time);
  const started = (t: Transaction) => (t.loggedInAt ? new Date(t.loggedInAt * 1000).toISOString() : latest.get(key(t))!);
  return items.sort((a, b) => started(b).localeCompare(started(a)) || key(a).localeCompare(key(b)) || a.time.localeCompare(b.time));
}

/**
 * このリクエストの記録だけを残す。拒否の記録は、ヘッダーのリクエストID（自己申告）ではなく、JWTに刻まれていた値（`stampedRequestId`）でも引くので、
 * 刻まれた値が別のリクエストのものなら除く。ヘッダーを偽った呼び出しは、刻まれた値のリクエストにだけ出る
 */
export function ownRows(requestId: string, rows: Row[]): Row[] {
  return rows.filter((r) => (r.requestId === requestId || r.stampedRequestId === requestId) && (!r.stampedRequestId || r.stampedRequestId === requestId));
}

/**
 * ログは各ホップが処理を終えたときに書くので、そのままでは下流のホップが先に並ぶ。処理時間から各ホップの処理の区間を求め、
 * 呼び出し元（actor）のホップの区間のうち、その区間を含む最も短いものを親とみなして、呼び出しの順（深さ優先）に並べる。
 * `hops`と`hopRows`は同じ順の、同じ記録である
 */
export function callOrder(hops: HopRecord[], hopRows: Row[]): HopRecord[] {
  const span = (r: Row) => {
    const end = logTime(r['@timestamp']);
    const ms = num(r['timings.totalMs']);
    return { start: ms === undefined ? end : end - ms, end };
  };
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

const eventRef = (r: AwsRecord): EventRef => ({ event: r.event, eventId: r.eventId, time: r.time });

/** 1つの項目を、アプリの記録の値とAWSの記録の値で比べる。AWSの記録が未着なら`pending` */
export function compare(name: string, app: string | undefined, aws: { value: string | undefined; event: AwsRecord } | undefined): Field {
  if (!aws) return { name, app, result: 'pending' };
  return { name, app, aws: aws.value, awsEvent: eventRef(aws.event), result: aws.value === app ? 'match' : 'mismatch' };
}

/** 項目ごとの結果をまとめる。1つでも違えば不一致、未着の項目が残れば未着 */
export function summarize(fields: Field[]): Check {
  const mismatched = fields.filter((f) => f.result === 'mismatch').map((f) => f.name);
  if (mismatched.length) return { result: 'mismatch', fields: mismatched };
  return fields.some((f) => f.result === 'pending') ? { result: 'pending' } : { result: 'match' };
}

/**
 * 1回のリクエストの、ホップの記録（`ownRows`で絞ったもの）とAWSの記録を突き合わせる。
 * ホップの記録の`jti`と`webIdentityTokenId`が一致する`GetWebIdentityToken`について、JWTを発行したrole、宛先、scope、ユーザーを比べ、
 * bffの`AssumeRole`の目的のtagと各ホップの記録の目的を比べる。bffの記録は、目的とユーザーを`AssumeRole`のイベントと比べる
 */
export function reconcileRecords(rows: Row[], records: TrailRecord[], dir: Directory): Reconciled {
  const bffRow = rows.find((r) => r.hop === 'bff' && r.message === 'handled');
  const stamped = records.find((r) => r.event === 'AssumeRole' && r.purpose);
  const byToken = new Map(records.filter((r) => r.tokenId).map((r) => [r.tokenId!, r]));
  const purposeField = (app: string | undefined): Field => compare('目的', app, stamped && { value: stamped.purpose, event: stamped });

  const hopRows = rows.filter((r) => r.hop !== 'bff');
  const hops: HopRecord[] = hopRows.map((r): HopRecord => {
    const base = {
      time: r['@timestamp'], hop: r.hop, status: num(r.status), reason: r.reason || undefined, depth: 1, logGroup: dir.logGroups[r.hop],
    };
    if (r.message === 'rejected') {
      return { ...base, outcome: 'rejected', ...(r.stampedRequestId ? { claimedRequestId: r.requestId } : {}), check: { result: 'n/a' } };
    }
    const tokenId = r.tokenId || undefined;
    const ev = tokenId ? byToken.get(tokenId) : undefined;
    const fromToken = (value: string | undefined) => ev && { value, event: ev };
    // JWTを発行したroleは、role名で比べ、表示名で示す
    const issuer = compare('JWTを発行したrole', principal(dir, r.tokenSub), ev && { value: label(dir, ev.issuerRole), event: ev });
    if (ev && ev.issuerRole !== roleName(r.tokenSub)) issuer.result = 'mismatch';
    const fields = [
      issuer,
      compare('宛先', r.hop, fromToken(ev?.audience)),
      compare('scope', r.scope, fromToken(ev?.scope)),
      compare('ユーザー', r['subject.id'], fromToken(ev?.sourceIdentity)),
      purposeField(r.purpose),
    ];
    return {
      ...base, outcome: 'handled', actor: r.actor, tokenIssuer: principal(dir, r.tokenSub), tokenId,
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
    hops: callOrder(hops, hopRows),
    transaction: bffRow ? {
      time: bffRow['@timestamp'], user: bffRow.user, route: bffRow.route, purpose: bffRow.purpose, status: num(bffRow.status),
      logGroup: dir.logGroups.bff, fields: entryFields, check: summarize(entryFields),
    } : null,
    awsRecords: records.map(({ issuerRole: _, ...r }) => r),
  };
}
