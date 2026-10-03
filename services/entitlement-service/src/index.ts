import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createHopHandler, requireEnv, traceAwsClient } from '@gekko08/authz-context';
import type { Entitlements } from './api';

const db = DynamoDBDocumentClient.from(traceAwsClient(new DynamoDBClient({})));
const STAFF = requireEnv('STAFF_TABLE');
const TITLE_PERMISSIONS = requireEnv('TITLE_PERMISSIONS_TABLE');

/** 人事データの項目 */
interface StaffItem {
  userId: string;
  branch: string;
  title: string;
}

/** 権限マスタの項目（役職→権限） */
interface GrantItem {
  title: string;
  permissions: string[];
}

// 属性サービス。人事データと権限マスタから、JWTのsubject本人の業務上のアクセス権だけを返す。
// 照会する相手を引数に取らないので、誘導されたエージェントや侵害されたホップが他人のアクセス権を問い合わせることはできない。
// 判定のたびに読むので、人事データや権限マスタの変更は次のリクエストから効く（FR-8）
export const handler = createHopHandler(async (_body, { subject, scope }) => {
  if (scope !== 'entitlements:read') return { status: 403, body: { error: 'forbidden', reason: 'scope does not allow the action' } };
  const staff = (await db.send(new GetCommand({ TableName: STAFF, Key: { userId: subject.id }, ConsistentRead: true }))).Item as StaffItem | undefined;
  if (!staff) return { status: 403, body: { error: 'forbidden', reason: 'unknown user' } };
  const grant = (await db.send(new GetCommand({ TableName: TITLE_PERMISSIONS, Key: { title: staff.title }, ConsistentRead: true }))).Item as GrantItem | undefined;
  const body: Entitlements = { userId: subject.id, branch: staff.branch, title: staff.title, permissions: grant?.permissions ?? [] };
  return { status: 200, body };
});
