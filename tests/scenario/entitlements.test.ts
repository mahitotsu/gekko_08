import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserGet, loginSession, setStaffBranch } from './helpers';

// FR-8：業務的なアクセス権は属性サービスが判定のたびに人事データから得るので、変更（異動）は次のリクエストから反映される。
// トークンやセッションには所属を入れていないので、ログインし直す必要はない
let yamada: string;

beforeAll(async () => {
  yamada = await loginSession('yamada');
});

afterAll(async () => {
  await setStaffBranch('yamada', 'tokyo');
});

describe('FR-8: 業務的なアクセス権の変更は、次のリクエストから反映される', () => {
  it('yamadaをtokyoからosakaへ異動させると、同じセッションのまま、次のリクエストから結果が変わる', async () => {
    expect((await browserGet('/api/cases/C-1001/summary', yamada)).status).toBe(200);
    expect((await browserGet('/api/cases/C-2001/summary', yamada)).status).toBe(403);

    await setStaffBranch('yamada', 'osaka');
    expect((await browserGet('/api/me', yamada)).body).toMatchObject({ branch: 'osaka' });
    expect((await browserGet('/api/cases/C-1001/summary', yamada)).status).toBe(403);
    const osaka = await browserGet('/api/cases/C-2001/summary', yamada);
    expect(osaka.status).toBe(200);
    expect(osaka.body.account).toMatchObject({ accountId: 'A-201', balance: 830000 }); // 役職（支店長）はそのまま

    await setStaffBranch('yamada', 'tokyo');
    expect((await browserGet('/api/cases/C-1001/summary', yamada)).status).toBe(200);
  });
});
