import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createHopHandler } from '@gekko08/authz-context';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.CASES_TABLE!;

// 代理で何を許すかは受信側が決める。呼び出し元のホップ（actor）ごとに、受け付ける操作を絞る
const ALLOWED_CALLERS: Record<string, string[]> = {
  summary: ['bff'], // 画面からの要約（口座の情報を含む）
  get: ['fraud-mcp'], // エージェントのツールからの取得（案件だけ）
};

// 不正検知の案件と取引の参照。ABACは共通部品が渡した検証済みのsubjectだけで判定する
export const handler = createHopHandler(async (body, { subject, actor, call }) => {
  if (!ALLOWED_CALLERS[body.action]?.includes(actor)) return { status: 403, body: { error: 'forbidden', reason: 'action not allowed for caller' } };
  const caseId = typeof body.caseId === 'string' ? body.caseId : undefined;
  if (!caseId) return { status: 400, body: { error: 'caseId is required' } };
  const { Item } = await db.send(new GetCommand({ TableName: TABLE, Key: { caseId } }));
  if (!Item) return { status: 404, body: { error: 'not found' } };
  if (Item.branch !== subject.branch) return { status: 403, body: { error: 'forbidden', reason: 'branch mismatch' } };

  switch (body.action) {
    case 'get':
      return { status: 200, body: { case: Item } };
    case 'summary': {
      const account = await call('account-service', { accountId: Item.accountId });
      if (account.status !== 200) return { status: account.status, body: { error: 'account lookup failed', account: account.body } };
      return { status: 200, body: { case: Item, account: (account.body as { account: unknown }).account } };
    }
    default:
      return { status: 400, body: { error: 'unknown action' } };  // ALLOWED_CALLERSにない操作は、上で拒否される
  }
});
