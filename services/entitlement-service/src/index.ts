import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createHopHandler } from '@gekko08/authz-context';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const STAFF = process.env.STAFF_TABLE!;
const TITLE_PERMISSIONS = process.env.TITLE_PERMISSIONS_TABLE!;

// 属性サービス。人事データと権限マスタから、JWTのsubject本人の業務的なアクセス権だけを返す。
// 照会する相手を引数に取らないので、誘導されたエージェントや侵害されたホップが他人のアクセス権を問い合わせることはできない。
// 判定のたびに読むので、人事データや権限マスタの変更は次のリクエストから効く（FR-8）
export const handler = createHopHandler(async (_body, { subject, scope }) => {
  if (scope !== 'entitlements:read') return { status: 403, body: { error: 'forbidden', reason: 'scope' } };
  const { Item: staff } = await db.send(new GetCommand({ TableName: STAFF, Key: { userId: subject.id }, ConsistentRead: true }));
  if (!staff) return { status: 403, body: { error: 'forbidden', reason: 'unknown user' } };
  const { Item: grant } = await db.send(new GetCommand({ TableName: TITLE_PERMISSIONS, Key: { title: staff.title }, ConsistentRead: true }));
  return {
    status: 200,
    body: { userId: subject.id, branch: staff.branch, title: staff.title, permissions: (grant?.permissions as string[] | undefined) ?? [] },
  };
});
