import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createHopHandler, requireEnv, traceAwsClient } from '@gekko08/authz-context';
import { fetchEntitlements } from '@gekko08/entitlement-service/api';

const db = DynamoDBDocumentClient.from(traceAwsClient(new DynamoDBClient({})));
const TABLE = requireEnv('ACCOUNTS_TABLE');

// 操作ごとに必要なscope（委任の範囲）と業務上のアクセス権。目的との組み合わせはIAMと共通部品が守るので、ここではscopeだけを見る
const OPERATIONS: Record<string, { scope: string; permission: string }> = {
  get: { scope: 'account:read', permission: 'account:view' },
  unfreeze: { scope: 'account:unfreeze', permission: 'account:unfreeze' },
};

// 口座の参照と凍結の解除。委任の範囲が操作を許し、かつ業務上のアクセス権が口座を許すときだけ行う
export const handler = createHopHandler(async (body, { subject, scope, requestId, call }) => {
  const action = typeof body.action === 'string' ? body.action : 'get';
  const op = Object.hasOwn(OPERATIONS, action) ? OPERATIONS[action] : undefined;
  if (!op || op.scope !== scope) return { status: 403, body: { error: 'forbidden', reason: 'scope does not allow the action' } };
  const accountId = typeof body.accountId === 'string' ? body.accountId : undefined;
  if (!accountId) return { status: 400, body: { error: 'accountId is required' } };

  const [{ Item }, ent] = await Promise.all([
    db.send(new GetCommand({ TableName: TABLE, Key: { accountId } })),
    fetchEntitlements(call),
  ]);
  if (!ent || !ent.permissions.includes(op.permission)) return { status: 403, body: { error: 'forbidden', reason: 'no entitlement' } };
  if (!Item) return { status: 404, body: { error: 'not found' } };
  if (Item.branch !== ent.branch) return { status: 403, body: { error: 'forbidden', reason: 'branch mismatch' } };
  if (action === 'get') return { status: 200, body: { account: Item } };

  // 凍結を解除し、誰が（subject）、いつ、どのリクエストで解除したかを記録する
  try {
    const { Attributes } = await db.send(new UpdateCommand({
      TableName: TABLE,
      Key: { accountId },
      UpdateExpression: 'SET #status = :active, unfrozenBy = :by, unfrozenAt = :at, unfreezeRequestId = :rid',
      ConditionExpression: '#status = :frozen',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':active': 'active', ':frozen': 'frozen', ':by': subject.id, ':at': new Date().toISOString(), ':rid': requestId },
      ReturnValues: 'ALL_NEW',
    }));
    return { status: 200, body: { account: Attributes } };
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) return { status: 409, body: { error: 'conflict', reason: 'account is not frozen' } };
    throw e;
  }
});
