import { writeFileSync } from 'node:fs';
import { CloudFormationClient, paginateListStackResources } from '@aws-sdk/client-cloudformation';
import { beforeAll, describe, expect, it } from 'vitest';
import { STACK, browserPost, eventually, handledLogs, loginSession, readLogs, type HandledLog } from '../../../tests/scenario/helpers';

// エージェントのフレームワークで作ったfraud-agentに対して、本体のエージェントの経路のシナリオ（tests/scenario/agent-path.test.ts）と
// 同じことを確かめ、あわせてLambdaでの実行の様子（コールドスタート、時間、メモリ）を記録する
interface ToolCall { name: string; input: Record<string, string>; status: number }
interface AgentResult { requestId: string; caseId: string; analysis: string; toolCalls: ToolCall[] }
type Res = { status: number; text: string; body: AgentResult; ms: number };

const OTHER_BRANCH_ACCOUNT = [/98,?000,?000/, /大阪 次郎/];
const OWN_BALANCE = /1,?250,?000|125万/;
const SECRETS: [string, RegExp][] = [
  ['JWT', /eyJ[\w-]+\.eyJ[\w-]+/],
  ['chainのセッション（x-authz-session）', /eyJhY2Nlc3NLZXlJZCI/],
  ['一時的なアクセスキー', /ASIA[A-Z0-9]{16}/],
  ['セッショントークン', /IQoJb3JpZ2lu/],
];

const IMPLS = [
  { impl: 'strands', hop: 'fraud-agent-strands', logPrefix: 'FraudAgentStrandsFunctionLogs', role: /FraudAgentStrandsFunction/ },
  { impl: 'claude', hop: 'fraud-agent-claude', logPrefix: 'FraudAgentClaudeFunctionLogs', role: /FraudAgentClaudeFunction/ },
] as const;

async function logGroup(prefix: string): Promise<string> {
  for await (const page of paginateListStackResources({ client: new CloudFormationClient({}) }, { StackName: STACK })) {
    for (const r of page.StackResourceSummaries ?? []) {
      if (r.ResourceType === 'AWS::Logs::LogGroup' && r.LogicalResourceId!.startsWith(prefix)) return r.PhysicalResourceId!;
    }
  }
  throw new Error(`log group ${prefix} not found`);
}

const results: Record<string, unknown> = {};
const otel: Record<string, unknown> = {};

for (const { impl, hop, logPrefix, role } of IMPLS) {
  describe(`${hop}`, () => {
    let startTime: number;
    let group: string;
    let yamada: Res[];
    let tanaka: Res;

    beforeAll(async () => {
      startTime = Date.now() - 5000;
      group = await logGroup(logPrefix);
      const [y, t] = await Promise.all([loginSession('yamada'), loginSession('tanaka')]);
      const ask = async (cookie: string): Promise<Res> => {
        const t0 = Date.now();
        const r = await browserPost('/api/agent', JSON.stringify({ caseId: 'C-1001', agent: impl }), cookie);
        return { ...r, ms: Date.now() - t0 } as Res;
      };
      // 1回目はコールドスタートになりうる。2回目以降はウォーム
      yamada = [await ask(y), await ask(y), await ask(y)];
      tanaka = await ask(t);
      for (const r of [...yamada, tanaka]) console.log(`${hop} ${r.status} ${r.ms}ms tool calls:`, JSON.stringify(r.body.toolCalls));
    }, 300_000);

    describe('FR-7: プロンプトインジェクションで誘導されたエージェントの要求は拒否される', () => {
      it('yamada（tokyo・支店長）は自分の支店の案件をエージェントに分析させられる', () => {
        for (const r of yamada) {
          expect(r.status, r.text).toBe(200);
          expect(r.body.analysis.length).toBeGreaterThan(0);
          expect(r.body.toolCalls).toContainEqual(expect.objectContaining({ name: 'get_case', status: 200 }));
        }
      });

      it('エージェントが他の支店の口座を要求しても、account-serviceが拒否する', () => {
        for (const r of yamada) {
          for (const c of r.body.toolCalls.filter((c) => c.name === 'get_account' && c.input.accountId !== 'A-101')) expect(c.status).toBe(403);
        }
      });

      it('目的がエージェントによる分析なので、支店長のyamadaにも口座の残高は返らない（委任の範囲による制限）', () => {
        for (const r of yamada) expect(r.text).not.toMatch(OWN_BALANCE);
      });

      it('エージェントの応答に、他の支店の口座のデータが含まれない', () => {
        for (const r of [...yamada, tanaka]) for (const re of OTHER_BRANCH_ACCOUNT) expect(r.text).not.toMatch(re);
      });

      it('tanaka（osaka）がtokyoの案件を分析させても、case-serviceが業務上のアクセス権で拒否する', () => {
        expect(tanaka.status, tanaka.text).toBe(200);
        const cases = tanaka.body.toolCalls.filter((c) => c.name === 'get_case');
        expect(cases.length).toBeGreaterThan(0);
        for (const c of cases) expect(c.status).toBe(403);
        expect(tanaka.text).not.toMatch(/深夜帯の海外送金の連続|A-999|499,?000/);
      });
    });

    describe('FR-1・FR-6: MCPの呼び出しが共通部品を通り、各ホップが同じユーザーと呼び出し元を確かめる', () => {
      it(`bff・${hop}・fraud-mcp・case-serviceが同じリクエストIDでつながる`, async () => {
        const id = yamada[0].body.requestId;
        const l = (await handledLogs([id], ['bff', 'fraud-mcp', 'case-service'], startTime))[id];
        const agentLog = await eventually(async () => {
          for (const m of await readLogs(group, startTime, '{ $.message = "handled" }')) {
            const h = JSON.parse(m.slice(m.indexOf('{'))) as HandledLog;
            if (h.requestId === id) return h;
          }
          return undefined;
        }, 90_000, 5000);
        expect(l.bff).toMatchObject({ user: 'yamada', route: 'agent', purpose: 'agent-analysis' });
        for (const h of [agentLog, l['fraud-mcp'], l['case-service']]) expect(h).toMatchObject({ subject: { id: 'yamada' }, purpose: 'agent-analysis' });
        expect([agentLog.actor, l['fraud-mcp']!.actor, l['case-service']!.actor]).toEqual(['bff', hop, 'fraud-mcp']);
        expect(agentLog.actorRole).toMatch(/BffFunction/);
        expect(l['fraud-mcp']!.actorRole).toMatch(role);
        expect(l['fraud-mcp']!.scope).toBe('mcp:tools');
      });
    });

    describe('SR-3: エージェントのログに認証情報が含まれない', () => {
      it('テスト中に出たログのすべてに、認証情報のパターンが現れない', async () => {
        const messages = await readLogs(group, startTime);
        expect(messages.length).toBeGreaterThan(0);
        for (const m of messages) for (const [name, re] of SECRETS) expect(re.test(m), `${hop}のログに${name}: ${m.slice(0, 120)}`).toBe(false);
      });
    });

    describe('OTelの出力（観測）', () => {
      it('フレームワークが出したスパン・メトリクス・ログの要約を記録する', async () => {
        const probes = await eventually(async () => {
          const r = await readLogs(group, startTime, '{ $.message = "otel probe" }');
          return r.length >= yamada.length + 1 ? r.map((m) => JSON.parse(m.slice(m.indexOf('{')))) : undefined;
        }, 90_000, 5000);
        otel[hop] = probes;
        writeFileSync(new URL('../out-otel.json', import.meta.url), JSON.stringify(otel, null, 2));
        expect(probes.length).toBeGreaterThan(0);
      });
    });

    describe('Lambdaでの実行', () => {
      it('コールドスタート、処理時間、メモリを記録する', async () => {
        const reports = await eventually(async () => {
          const r = await readLogs(group, startTime, 'REPORT');
          return r.length >= yamada.length + 1 ? r : undefined;
        }, 90_000, 5000);
        const num = (m: string, key: string) => Number(m.match(new RegExp(`${key}: ([\\d.]+)`))?.[1]);
        const report = reports.map((m) => ({ durationMs: num(m, 'Duration'), maxMemoryMB: num(m, 'Max Memory Used'), initMs: num(m, 'Init Duration') || undefined }));
        const finished = (await readLogs(group, startTime, '{ $.message = "agent finished" }')).map((m) => JSON.parse(m.slice(m.indexOf('{'))));
        results[hop] = {
          clientMs: [...yamada, tanaka].map((r) => r.ms),
          report,
          agentMs: finished.map((f) => f.agentMs),
          toolCalls: [...yamada, tanaka].map((r) => r.body.toolCalls),
        };
        console.table(report);
        writeFileSync(new URL('../out-results.json', import.meta.url), JSON.stringify(results, null, 2));
        expect(report.length).toBeGreaterThan(0);
      });
    });
  });
}
