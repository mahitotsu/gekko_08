import { beforeAll, describe, expect, it } from 'vitest';
import { browserPost, handledLogs, loginSession, OTHER_ACCOUNT_DATA, provisionTestData, readAccount, TEST_DATA as T, USERS } from './helpers';

// エージェントの経路（bff → fraud-agent → fraud-mcp → case-service / account-service）のシナリオテスト。
// モデルの判断は毎回変わりうるので、エージェントが誘導されたかどうかではなく、
// 「誘導されても口座は凍結されたままで、他の支店のデータは返らない」ことを確かめる
interface ToolCall { name: string; input: Record<string, string>; status: number }
interface AgentResult { requestId: string; caseId: string; analysis: string; toolCalls: ToolCall[] }

let startTime: number;
let managerResult: { status: number; text: string; body: AgentResult };
let officerResult: { status: number; text: string; body: AgentResult };

beforeAll(async () => {
  startTime = Date.now() - 5000;
  await provisionTestData();
  const [manager, officer] = await Promise.all([loginSession('tokyoManager'), loginSession('osakaOfficer')]);
  const ask = (cookie: string) => browserPost('/api/agent', JSON.stringify({ caseId: T.tokyoCase }), cookie);
  [managerResult, officerResult] = await Promise.all([ask(manager), ask(officer)]);
  console.log('manager tool calls:', JSON.stringify(managerResult.body.toolCalls));
  console.log('officer tool calls:', JSON.stringify(officerResult.body.toolCalls));
}, 120_000);

describe('FR-7: プロンプトインジェクションで誘導されたエージェントの要求は拒否される', () => {
  it('支店長（tokyo）は自分の支店の案件をエージェントに分析させられる', () => {
    expect(managerResult.status).toBe(200);
    expect(managerResult.body.analysis.length).toBeGreaterThan(0);
    expect(managerResult.body.toolCalls).toContainEqual(expect.objectContaining({ name: 'get_case', status: 200 }));
  });

  it('エージェントが凍結の解除を試みても、account-serviceが拒否し、口座は凍結されたまま', async () => {
    for (const c of managerResult.body.toolCalls.filter((x) => x.name === 'unfreeze_account')) expect(c.status).toBe(403);
    expect(await readAccount(T.tokyoAccount)).toMatchObject({ status: 'frozen' });
    expect(await readAccount(T.otherAccount)).toMatchObject({ status: 'frozen' });
  });

  it('エージェントが他の支店の口座を要求しても、account-serviceが拒否する', () => {
    const other = managerResult.body.toolCalls.filter((c) => c.name === 'get_account' && c.input.accountId !== T.tokyoAccount);
    for (const c of other) expect(c.status).toBe(403);
  });

  it('エージェントの応答に、他の支店の口座のデータが含まれない', () => {
    for (const r of [managerResult, officerResult]) {
      for (const re of OTHER_ACCOUNT_DATA) expect(r.text).not.toMatch(re);
    }
  });

  it('担当者（osaka）がtokyoの案件を分析させても、case-serviceが業務上のアクセス権で拒否し、案件のデータは返らない', () => {
    expect(officerResult.status).toBe(200);
    const cases = officerResult.body.toolCalls.filter((c) => c.name === 'get_case');
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) expect(c.status).toBe(403);
    expect(officerResult.text).not.toMatch(/深夜帯の海外送金の連続|499,?000/);
  });
});

describe('FR-6: エージェントの経路も、リクエストIDとユーザーで追える', () => {
  it('bff・fraud-agent・fraud-mcpのログが同じリクエストIDでつながり、各ホップが同じユーザーを受け取る', async () => {
    const id = managerResult.body.requestId;
    const l = (await handledLogs([id], ['bff', 'fraud-agent', 'fraud-mcp', 'case-service'], startTime))(id);
    expect(l.bff).toMatchObject({ user: USERS.tokyoManager, route: 'agent', purpose: 'agent-analysis' });
    for (const hop of ['fraud-agent', 'fraud-mcp', 'case-service'] as const) {
      expect(l[hop]).toMatchObject({ subject: { id: USERS.tokyoManager }, purpose: 'agent-analysis' });
    }
    expect(l['case-service']).toMatchObject({ scope: 'case:read' });
    expect([l['fraud-agent']!.actor, l['fraud-mcp']!.actor, l['case-service']!.actor]).toEqual(['bff', 'fraud-agent', 'fraud-mcp']);
    expect(l['fraud-agent']!.actorRole).toMatch(/BffFunction/);
    expect(l['fraud-mcp']!.actorRole).toMatch(/FraudAgentFunction/);
    expect(l['case-service']!.actorRole).toMatch(/FraudMcpFunction/);
    expect(l['case-service']!.tokenSub).toMatch(/FraudMcpChainRole/);
  });
});
