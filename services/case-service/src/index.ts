import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createHopHandler, requireEnv, traceAwsClient } from '@gekko08/authz-context';
import { fetchEntitlements } from '@gekko08/entitlement-service/api';

const db = DynamoDBDocumentClient.from(traceAwsClient(new DynamoDBClient({})));
const TABLE = requireEnv('CASES_TABLE');

// 操作ごとに必要なscope（委任の範囲）。目的との組み合わせはIAMと共通部品が守るので、ここではscopeだけを見る
const REQUIRED_SCOPE: Record<string, string> = {
  summary: 'case:summary', // 画面から案件を開く（口座の凍結の状態を含む）
  get: 'case:read', // エージェントのツールからの取得（案件だけ）
  unfreeze: 'case:unfreeze', // 画面からの凍結の解除の依頼
};

/** 案件のテーブルの項目のうち、判定に使う項目（ほかの項目は、そのまま応答に返す） */
interface CaseItem {
  caseId: string;
  branch: string;
  accountId: string;
}

// 凍結の見直しの案件。委任の範囲が操作を許し、かつ業務上のアクセス権が案件を許すときだけ行う
export const handler = createHopHandler(async (body, { scope, call }) => {
  const action = typeof body.action === 'string' && Object.hasOwn(REQUIRED_SCOPE, body.action) ? body.action : undefined;
  if (!action || REQUIRED_SCOPE[action] !== scope) {
    return { status: 403, body: { error: 'forbidden', reason: 'scope does not allow the action' } };
  }
  const caseId = typeof body.caseId === 'string' ? body.caseId : undefined;
  if (!caseId) return { status: 400, body: { error: 'caseId is required' } };

  const [{ Item }, ent] = await Promise.all([
    db.send(new GetCommand({ TableName: TABLE, Key: { caseId } })),
    fetchEntitlements(call),
  ]);
  if (!ent || !ent.permissions.includes('case:view')) return { status: 403, body: { error: 'forbidden', reason: 'no entitlement' } };
  const item = Item as CaseItem | undefined;
  if (!item) return { status: 404, body: { error: 'not found' } };
  if (item.branch !== ent.branch) return { status: 403, body: { error: 'forbidden', reason: 'branch mismatch' } };

  if (action === 'get') return { status: 200, body: { case: item } };
  if (action === 'summary') {
    const account = await call('account-service', { action: 'get', accountId: item.accountId }, { scope: 'account:read' });
    if (account.status !== 200) return { status: account.status, body: { error: 'account lookup failed', account: account.body } };
    return { status: 200, body: { case: item, account: (account.body as { account: unknown }).account } };
  }

  // 凍結の解除はaccount-serviceが判定する（解除の権限、支店、凍結中か）。解除の記録は口座にだけ残し、案件には書かない
  const account = await call('account-service', { action: 'unfreeze', accountId: item.accountId }, { scope: 'account:unfreeze' });
  if (account.status !== 200) return { status: account.status, body: { error: 'unfreeze failed', account: account.body } };
  return { status: 200, body: { case: item, account: (account.body as { account: unknown }).account } };
});
