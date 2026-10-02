import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import { createHopHandler, traceAwsClient, type Call, type CallResult } from '@gekko08/authz-context';
import type { Reconciled, TransactionList } from './api';
import { logTime, ownRows, reconcileRecords, toAwsRecord, transactionsFrom, type Directory, type Row, type TrailRecord } from './reconcile';

// 監査サービス。1回のリクエストについて、各ホップのログ（アプリの記録）と、CloudTrail（AWSの記録）を突き合わせる（監査サービスのADR）。
// 他のホップと同じ入口で守り、監査の権限（`audit:view`）を持つユーザーにだけ応じる。
// このファイルはAWSから読む部分だけを持ち、突き合わせは`reconcile.ts`の純粋な関数が行う
const trail = traceAwsClient(new CloudTrailClient({}));
const logs = traceAwsClient(new CloudWatchLogsClient({}));

const DIRECTORY: Directory = {
  logGroups: JSON.parse(process.env.AUDIT_LOG_GROUPS ?? '{}'),
  principals: JSON.parse(process.env.AUDIT_PRINCIPALS ?? '{}'),
  audiencePrefix: process.env.AUDIT_AUDIENCE_PREFIX ?? '',
};

/** bffが発行するリクエストID（UUID）。Logs Insightsの照会に埋め込むので、形を厳しく確かめる */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIST_HOURS = 24;
/** ログの保持期間（1週間）に合わせる */
const RECONCILE_DAYS = 7;

const forbidden = (reason: string): CallResult => ({ status: 403, body: { error: 'forbidden', reason } });

export const handler = createHopHandler(async (body, { scope, call }) => {
  if (scope !== 'audit:read') return forbidden('scope does not allow the action');
  if (!(await canAudit(call))) return forbidden('no entitlement');
  if (body.action === 'list') return { status: 200, body: await listTransactions() };
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

/** 最近のリクエスト（bffが最初のホップを呼んだもの）。表示の経路は除く。監査の操作もリクエストとして含め、誰がどのリクエストを監査したかを追えるようにする */
async function listTransactions(): Promise<TransactionList> {
  const rows = await insights([DIRECTORY.logGroups.bff], `fields @timestamp, requestId, route, purpose, user, status, sessionRef, loggedInAt, caseId, auditTarget
| filter message = "handled" and hop = "bff" and route != "me"
| sort @timestamp desc
| limit 500`, Date.now() - LIST_HOURS * 3600_000);
  return { transactions: transactionsFrom(rows) };
}

/** CloudTrailのイベントを、`Username`（＝chainとJWTの発行のセッション名＝リクエストID）で引く */
async function awsRecords(requestId: string, since: Date): Promise<TrailRecord[]> {
  const out: TrailRecord[] = [];
  let NextToken: string | undefined;
  do {
    const r = await trail.send(new LookupEventsCommand({
      LookupAttributes: [{ AttributeKey: 'Username', AttributeValue: requestId }], StartTime: since, MaxResults: 50, NextToken,
    }));
    for (const e of r.Events ?? []) {
      const rec = toAwsRecord(e.CloudTrailEvent, DIRECTORY);
      if (rec) out.push(rec);
    }
    NextToken = r.NextToken;
  } while (NextToken && out.length < 500);
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

async function reconcile(requestId: string): Promise<Reconciled> {
  // 拒否の記録は、ヘッダーのリクエストID（自己申告）ではなく、JWTに刻まれていた値（`stampedRequestId`）でも引く（ownRowsで振り分ける）
  const rows = ownRows(requestId, await insights(Object.values(DIRECTORY.logGroups), `fields @timestamp, message, hop, requestId, route, user, actor, tokenSub, tokenId, subject.id, purpose, scope, status, reason, stampedRequestId, timings.totalMs
| filter (requestId = "${requestId}" or stampedRequestId = "${requestId}") and (message = "handled" or message = "rejected")
| sort @timestamp asc
| limit 1000`, Date.now() - RECONCILE_DAYS * 86400_000));
  // CloudTrailはリクエストの少し前から引く（時刻はUTC）
  const since = rows.length ? new Date(logTime(rows[0]['@timestamp']) - 5 * 60_000) : undefined;
  const records = since ? await awsRecords(requestId, since) : [];
  return reconcileRecords(rows, records, DIRECTORY);
}
