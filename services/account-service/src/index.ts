import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createHopHandler, traceAwsClient, type Call } from '@gekko08/authz-context';

const db = DynamoDBDocumentClient.from(traceAwsClient(new DynamoDBClient({})));
const TABLE = process.env.ACCOUNTS_TABLE!;

interface Entitlements { branch: string; title: string; permissions: string[] }

// 業務的なアクセス権は属性サービスから得る。得られなければ拒否する（fail closed）
async function entitlementsOf(call: Call): Promise<Entitlements | undefined> {
  const r = await call('entitlement-service', {});
  return r.status === 200 ? (r.body as Entitlements) : undefined;
}

// 口座の参照。委任の範囲が操作を許し、かつ業務的なアクセス権が口座を許すときだけ返す。
// 残高は、取引の目的が画面での要約で、かつ残高を見る権限があるときだけ含める
export const handler = createHopHandler(async (body, { scope, purpose, call }) => {
  if (scope !== 'account:read') return { status: 403, body: { error: 'forbidden', reason: 'scope does not allow the action' } };
  const accountId = typeof body.accountId === 'string' ? body.accountId : undefined;
  if (!accountId) return { status: 400, body: { error: 'accountId is required' } };

  const [{ Item }, ent] = await Promise.all([
    db.send(new GetCommand({ TableName: TABLE, Key: { accountId } })),
    entitlementsOf(call),
  ]);
  if (!ent || !ent.permissions.includes('account:view')) return { status: 403, body: { error: 'forbidden', reason: 'no entitlement' } };
  if (!Item) return { status: 404, body: { error: 'not found' } };
  if (Item.branch !== ent.branch) return { status: 403, body: { error: 'forbidden', reason: 'branch mismatch' } };

  const { balance, ...account } = Item;
  const showBalance = purpose === 'case-summary' && ent.permissions.includes('account:balance');
  return { status: 200, body: { account: showBalance ? { ...account, balance } : account } };
});
