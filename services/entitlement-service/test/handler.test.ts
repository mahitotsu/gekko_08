import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 属性サービスの単体テスト。JWTのsubject本人の業務上のアクセス権だけを返し、照会する相手を引数に取らないこと（脅威の総点検 E-3）を確かめる。
 * 属性サービスを呼べるのは決まったホップの実行roleだけで、シナリオテストからは本文を細工して呼べないので、業務の関数を取り出して確かめる
 */

type Business = (body: unknown, ctx: { subject: { id: string }; scope: string }) => Promise<{ status: number; body: Record<string, unknown> }>;
const captured: { fn?: Business } = {};
const reads: Record<string, unknown>[] = [];

vi.mock('@gekko08/authz-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gekko08/authz-context')>()),
  createHopHandler: (fn: Business) => { captured.fn = fn; return fn; },
  traceAwsClient: <T>(c: T) => c,
}));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: async (cmd: { input: { TableName: string; Key: Record<string, unknown> } }) => {
        reads.push(cmd.input.Key);
        if ('userId' in cmd.input.Key) {
          const staff: Record<string, { branch: string; title: string }> = { yamada: { branch: 'tokyo', title: 'manager' }, tanaka: { branch: 'osaka', title: 'officer' } };
          const s = staff[cmd.input.Key.userId as string];
          return { Item: s ? { userId: cmd.input.Key.userId, ...s } : undefined };
        }
        return { Item: { title: cmd.input.Key.title, permissions: cmd.input.Key.title === 'manager' ? ['case:view', 'account:unfreeze'] : ['case:view'] } };
      },
    }),
  },
  GetCommand: class { constructor(readonly input: unknown) {} },
}));

beforeEach(async () => {
  reads.length = 0;
  // CDKが設定するテーブル名
  process.env.STAFF_TABLE = 'staff';
  process.env.TITLE_PERMISSIONS_TABLE = 'title-permissions';
  await import('../src/index');
});

describe('属性サービス', () => {
  it('JWTのsubject本人のアクセス権を返す', async () => {
    const r = await captured.fn!({}, { subject: { id: 'yamada' }, scope: 'entitlements:read' });
    expect(r).toEqual({ status: 200, body: { userId: 'yamada', branch: 'tokyo', title: 'manager', permissions: ['case:view', 'account:unfreeze'] } });
  });

  it('本文で別のユーザーを指定しても、subject本人の分だけを読んで返す（他人のアクセス権は問い合わせられない）', async () => {
    const r = await captured.fn!({ userId: 'tanaka', user: 'tanaka', subject: 'tanaka' }, { subject: { id: 'yamada' }, scope: 'entitlements:read' });
    expect(r.body.userId).toBe('yamada');
    expect(reads.filter((k) => 'userId' in k)).toEqual([{ userId: 'yamada' }]);
  });

  it('scopeが違えば読まずに拒否する', async () => {
    const r = await captured.fn!({}, { subject: { id: 'yamada' }, scope: 'case:read' });
    expect(r.status).toBe(403);
    expect(reads).toEqual([]);
  });

  it('人事データにないユーザーは403', async () => {
    const r = await captured.fn!({}, { subject: { id: 'nobody' }, scope: 'entitlements:read' });
    expect(r.status).toBe(403);
  });
});
