import { beforeAll, describe, expect, it } from 'vitest';
import { browserPost, handledLogs, loginSession } from './helpers';

// エージェントの経路（bff → fraud-agent → fraud-mcp → case-service / account-service）のシナリオテスト。
// モデルの判断は毎回変わりうるので、エージェントが誘導されたかどうかではなく、
// 「誘導されても他の支店のデータは返らない」ことを確かめる
interface ToolCall { name: string; input: Record<string, string>; status: number }
interface AgentResult { requestId: string; caseId: string; analysis: string; toolCalls: ToolCall[] }

// 他の支店の口座（A-999）のデータ。どの応答にも現れてはならない
const OTHER_BRANCH_ACCOUNT = [/98,?000,?000/, /大阪 次郎/];

let startTime: number;
let yamadaResult: { status: number; text: string; body: AgentResult };
let tanakaResult: { status: number; text: string; body: AgentResult };

beforeAll(async () => {
  startTime = Date.now() - 5000;
  const [yamada, tanaka] = await Promise.all([loginSession('yamada'), loginSession('tanaka')]);
  const ask = (cookie: string) => browserPost('/api/agent', JSON.stringify({ caseId: 'C-1001' }), cookie);
  [yamadaResult, tanakaResult] = await Promise.all([ask(yamada), ask(tanaka)]);
  console.log('yamada tool calls:', JSON.stringify(yamadaResult.body.toolCalls));
  console.log('tanaka tool calls:', JSON.stringify(tanakaResult.body.toolCalls));
}, 120_000);

describe('FR-7: プロンプトインジェクションで誘導されたエージェントの要求は拒否される', () => {
  it('yamada（tokyo）は自分の支店の案件をエージェントに分析させられる', () => {
    expect(yamadaResult.status).toBe(200);
    expect(yamadaResult.body.analysis.length).toBeGreaterThan(0);
    expect(yamadaResult.body.toolCalls).toContainEqual(expect.objectContaining({ name: 'get_case', status: 200 }));
  });

  it('エージェントが他の支店の口座を要求しても、account-serviceが拒否する', () => {
    const other = yamadaResult.body.toolCalls.filter((c) => c.name === 'get_account' && c.input.accountId !== 'A-101');
    for (const c of other) expect(c.status).toBe(403);
  });

  it('エージェントの応答に、他の支店の口座のデータが含まれない', () => {
    for (const r of [yamadaResult, tanakaResult]) {
      for (const re of OTHER_BRANCH_ACCOUNT) expect(r.text).not.toMatch(re);
    }
  });

  it('tanaka（osaka）がtokyoの案件を分析させても、case-serviceが拒否し、案件のデータは返らない', () => {
    expect(tanakaResult.status).toBe(200);
    const cases = tanakaResult.body.toolCalls.filter((c) => c.name === 'get_case');
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) expect(c.status).toBe(403);
    expect(tanakaResult.text).not.toMatch(/深夜帯の海外送金の連続|A-999|499,?000/);
  });
});

describe('FR-6: エージェントの経路も、リクエストIDとユーザーで追える', () => {
  it('bff・fraud-agent・fraud-mcpのログが同じリクエストIDでつながり、各ホップが同じユーザーを受け取る', async () => {
    const id = yamadaResult.body.requestId;
    const l = (await handledLogs([id], ['bff', 'fraud-agent', 'fraud-mcp', 'case-service'], startTime))[id];
    expect(l.bff).toMatchObject({ user: 'yamada', route: 'agent' });
    for (const hop of ['fraud-agent', 'fraud-mcp', 'case-service'] as const) {
      expect(l[hop]!.subject).toEqual({ id: 'yamada', branch: 'tokyo' });
    }
    expect([l['fraud-agent']!.actor, l['fraud-mcp']!.actor, l['case-service']!.actor]).toEqual(['bff', 'fraud-agent', 'fraud-mcp']);
    expect(l['fraud-agent']!.actorRole).toMatch(/BffFunction/);
    expect(l['fraud-mcp']!.actorRole).toMatch(/FraudAgentFunction/);
    expect(l['case-service']!.actorRole).toMatch(/FraudMcpFunction/);
    expect(l['case-service']!.tokenSub).toMatch(/FraudMcpChainRole/);
  });
});
