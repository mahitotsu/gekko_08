import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserGet, loginSession, provisionTestData, setStaffBranch, TEST_DATA as T } from './helpers';

// FR-8：業務上のアクセス権は属性サービスが判定のたびに人事データから得るので、変更（異動）は次のリクエストから反映される。
// トークンやセッションには所属を入れていないので、ログインし直す必要はない
let manager: string;

beforeAll(async () => {
  await provisionTestData();
  manager = await loginSession('tokyoManager');
});

afterAll(async () => {
  await setStaffBranch('tokyoManager', 'tokyo');
});

describe('FR-8: 業務上のアクセス権の変更は、次のリクエストから反映される', () => {
  it('支店長をtokyoからosakaへ異動させると、同じセッションのまま、次のリクエストから結果が変わる', async () => {
    expect((await browserGet(`/api/cases/${T.tokyoCase}/summary`, manager)).status).toBe(200);
    expect((await browserGet(`/api/cases/${T.osakaCase}/summary`, manager)).status).toBe(403);

    await setStaffBranch('tokyoManager', 'osaka');
    expect((await browserGet('/api/me', manager)).body).toMatchObject({ branch: 'osaka' });
    expect((await browserGet(`/api/cases/${T.tokyoCase}/summary`, manager)).status).toBe(403);
    const osaka = await browserGet(`/api/cases/${T.osakaCase}/summary`, manager);
    expect(osaka.status).toBe(200);
    expect(osaka.body.account).toMatchObject({ accountId: T.osakaAccount });

    await setStaffBranch('tokyoManager', 'tokyo');
    expect((await browserGet(`/api/cases/${T.tokyoCase}/summary`, manager)).status).toBe(200);
  });
});
