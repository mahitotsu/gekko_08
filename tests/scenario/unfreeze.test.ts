import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  browserPost, chainTo, handledLogs, loginSession, mintJwt, type Outputs, provisionTestData, purposeSession, readAccount, stackOutputs,
  TEST_DATA as T, USERS,
} from './helpers';

// 凍結の解除（bff → case-service → account-service、目的`account-unfreeze`）と、ホップが侵害された場合のシナリオテスト（FR-2、FR-3、FR-7）。
// 解除は口座の状態を変えるので、テスト専用の案件と口座（TC-1002、TA-102）を使い、テストごとに凍結し直す
let o: Outputs;
let manager: string;
let officer: string;
let startTime: number;

beforeAll(async () => {
  o = await stackOutputs();
  startTime = Date.now() - 5000;
  [manager, officer] = await Promise.all([loginSession('tokyoManager'), loginSession('osakaOfficer')]);
});

beforeEach(async () => {
  await provisionTestData();
});

const unfreeze = (caseId: string, cookie: string) => browserPost(`/api/cases/${caseId}/unfreeze`, '', cookie);

describe('FR-7, FR-2: 凍結の解除は、人間の解除のリクエストで、権限のある人だけができる', () => {
  it('支店長（tokyo）は自分の支店の口座の凍結を解除できる。誰がどのリクエストで解除したかが口座に残る', async () => {
    const r = await unfreeze(T.unfreezeCase, manager);
    expect(r.status).toBe(200);
    expect(r.body.account).toMatchObject({ accountId: T.unfreezeAccount, status: 'active', unfrozenBy: USERS.tokyoManager, unfreezeRequestId: r.body.requestId });
    expect(await readAccount(T.unfreezeAccount)).toMatchObject({ status: 'active' });
  });

  it('解除済みの口座をもう一度解除すると409', async () => {
    expect((await unfreeze(T.unfreezeCase, manager)).status).toBe(200);
    expect((await unfreeze(T.unfreezeCase, manager)).status).toBe(409);
  });

  it('担当者（osaka）は、自分の支店の口座でも、解除の権限がないので解除できない', async () => {
    const r = await unfreeze(T.osakaCase, officer);
    expect(r.status).toBe(403);
    expect(await readAccount(T.osakaAccount)).toMatchObject({ status: 'frozen' });
  });

  it('支店長でも、他の支店の案件の口座は解除できない', async () => {
    expect((await unfreeze(T.osakaCase, manager)).status).toBe(403);
    expect(await readAccount(T.osakaAccount)).toMatchObject({ status: 'frozen' });
  });

  it('FR-6: 解除のリクエストのログに、目的と解除のscopeが残る', async () => {
    const r = await unfreeze(T.unfreezeCase, manager);
    const l = (await handledLogs([r.body.requestId], ['bff', 'case-service', 'account-service'], startTime))[r.body.requestId];
    expect(l.bff).toMatchObject({ user: USERS.tokyoManager, route: 'case-unfreeze', purpose: 'account-unfreeze', status: 200 });
    expect(l['case-service']).toMatchObject({ actor: 'bff', purpose: 'account-unfreeze', scope: 'case:unfreeze' });
    expect(l['account-service']).toMatchObject({ actor: 'case-service', purpose: 'account-unfreeze', scope: 'account:unfreeze', subject: { id: USERS.tokyoManager } });
  });
});

describe('FR-3, FR-7: ホップが侵害されても、エージェントのリクエストから解除のscopeは発行できない', () => {
  it('エージェントのリクエストで、共有のホップ（fraud-mcpから呼ばれたcase-service）のセッションは、account-service宛ての解除のJWTを発行できない', async () => {
    // bff → fraud-agent → fraud-mcp → case-serviceと、実際のエージェントの経路のとおりにchainする
    const agent = await chainTo(await purposeSession('tokyoManager', 'agent-analysis'), o.FraudAgentChainRoleArn);
    const mcp = await chainTo(agent, o.FraudMcpChainRoleArn);
    const caseService = await chainTo(mcp, o.CaseServiceChainRoleArn);
    await expect(mintJwt(caseService, o.AccountServiceAudience, 'account:unfreeze')).rejects.toThrow(/not authorized to perform: sts:TagGetWebIdentityToken/);
  });

  it('エージェントのリクエストのfraud-mcpのセッションは、account-service宛ての解除のJWTを発行できない', async () => {
    const agent = await chainTo(await purposeSession('tokyoManager', 'agent-analysis'), o.FraudAgentChainRoleArn);
    const mcp = await chainTo(agent, o.FraudMcpChainRoleArn);
    await expect(mintJwt(mcp, o.AccountServiceAudience, 'account:unfreeze')).rejects.toThrow(/not authorized to perform: sts:TagGetWebIdentityToken/);
    await expect(mintJwt(mcp, o.AccountServiceAudience, 'account:read')).resolves.toBeTypeOf('string');
  });

  it('エージェントのリクエストの途中で、目的を解除のリクエストに変えられない', async () => {
    const agent = await chainTo(await purposeSession('tokyoManager', 'agent-analysis'), o.FraudAgentChainRoleArn);
    await expect(chainTo(agent, o.FraudMcpChainRoleArn, { Tags: [{ Key: 'purpose', Value: 'account-unfreeze' }] }))
      .rejects.toThrow(/conflicts with a transitive tag key/);
  });
});
