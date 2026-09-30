import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createHopHandler } from '@gekko08/authz-context';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.ACCOUNTS_TABLE!;

// 口座の参照（終端）。ABACは共通部品が渡した検証済みのsubjectだけで判定する
export const handler = createHopHandler(async (body, { subject }) => {
  const accountId = typeof body.accountId === 'string' ? body.accountId : undefined;
  if (!accountId) return { status: 400, body: { error: 'accountId is required' } };
  const { Item } = await db.send(new GetCommand({ TableName: TABLE, Key: { accountId } }));
  if (!Item) return { status: 404, body: { error: 'not found' } };
  if (Item.branch !== subject.branch) return { status: 403, body: { error: 'forbidden', reason: 'branch mismatch' } };
  return { status: 200, body: { account: Item } };
});
