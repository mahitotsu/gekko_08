import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserGet, loginSession, setStaffBranch } from './helpers';

// FR-8：業務的なアクセス権は属性サービスが判定のたびに人事データから得るので、変更（異動）は次のリクエストから反映される。
// トークンやセッションには所属を入れていないので、ログインし直す必要はない
let manager: string;

beforeAll(async () => {
  manager = await loginSession('tokyoManager');
});

afterAll(async () => {
  await setStaffBranch('tokyoManager', 'tokyo');
});

describe('FR-8: 業務的なアクセス権の変更は、次のリクエストから反映される', () => {
  it('支店長をtokyoからosakaへ異動させると、同じセッションのまま、次のリクエストから結果が変わる', async () => {
    expect((await browserGet('/api/cases/C-1001/summary', manager)).status).toBe(200);
    expect((await browserGet('/api/cases/C-2001/summary', manager)).status).toBe(403);

    await setStaffBranch('tokyoManager', 'osaka');
    expect((await browserGet('/api/me', manager)).body).toMatchObject({ branch: 'osaka' });
    expect((await browserGet('/api/cases/C-1001/summary', manager)).status).toBe(403);
    const osaka = await browserGet('/api/cases/C-2001/summary', manager);
    expect(osaka.status).toBe(200);
    expect(osaka.body.account).toMatchObject({ accountId: 'A-201', balance: 830000 }); // 役職（支店長）はそのまま

    await setStaffBranch('tokyoManager', 'tokyo');
    expect((await browserGet('/api/cases/C-1001/summary', manager)).status).toBe(200);
  });
});
