import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createHopHandler, traceAwsClient, type Call } from '@gekko08/authz-context';

const db = DynamoDBDocumentClient.from(traceAwsClient(new DynamoDBClient({})));
const TABLE = process.env.CASES_TABLE!;

// 操作ごとに必要なscope（委任の範囲）。scopeは呼び出し元と宛先の組ごとにIAMが限る
const REQUIRED_SCOPE: Record<string, string> = {
  summary: 'case:summary', // 画面からの要約（口座の情報を含む）
  get: 'case:read', // エージェントのツールからの取得（案件だけ）
};

interface Entitlements { branch: string; title: string; permissions: string[] }

// 業務的なアクセス権は属性サービスから得る。得られなければ拒否する（fail closed）
async function entitlementsOf(call: Call): Promise<Entitlements | undefined> {
  const r = await call('entitlement-service', {});
  return r.status === 200 ? (r.body as Entitlements) : undefined;
}

// 不正検知の案件と取引の参照。委任の範囲が操作を許し、かつ業務的なアクセス権が案件を許すときだけ返す
export const handler = createHopHandler(async (body, { scope, call }) => {
  if (!REQUIRED_SCOPE[body.action] || REQUIRED_SCOPE[body.action] !== scope) {
    return { status: 403, body: { error: 'forbidden', reason: 'scope does not allow the action' } };
  }
  const caseId = typeof body.caseId === 'string' ? body.caseId : undefined;
  if (!caseId) return { status: 400, body: { error: 'caseId is required' } };

  const [{ Item }, ent] = await Promise.all([
    db.send(new GetCommand({ TableName: TABLE, Key: { caseId } })),
    entitlementsOf(call),
  ]);
  if (!ent || !ent.permissions.includes('case:view')) return { status: 403, body: { error: 'forbidden', reason: 'no entitlement' } };
  if (!Item) return { status: 404, body: { error: 'not found' } };
  if (Item.branch !== ent.branch) return { status: 403, body: { error: 'forbidden', reason: 'branch mismatch' } };

  if (body.action === 'get') return { status: 200, body: { case: Item } };
  const account = await call('account-service', { accountId: Item.accountId });
  if (account.status !== 200) return { status: account.status, body: { error: 'account lookup failed', account: account.body } };
  return { status: 200, body: { case: Item, account: (account.body as { account: unknown }).account } };
});
