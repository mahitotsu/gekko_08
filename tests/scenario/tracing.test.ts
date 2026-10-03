import { beforeAll, describe, expect, it } from 'vitest';
import { browserGet, browserPost, handledLogs, loginSession, provisionTestData, requestIdOf, type SpanRecord, TEST_DATA as T, traceSpans, USERS } from './helpers';

// トレース（FR-6）。各ホップの受信と送信のスパンが、traceparentの引き継ぎで1つのトレースにつながり、
// 検証の結果（呼び出し元、目的、scope、ユーザー）が属性に入ることを、CloudWatch Transaction Search（aws/spans）で確かめる。
// スパンに認証情報が入らないこと（SR-3）も確かめる
const SECRETS: [string, RegExp][] = [
  ['JWT', /eyJ[\w-]+\.eyJ[\w-]+/],
  ['chainのセッション（x-authz-session）', /eyJhY2Nlc3NLZXlJZCI/],
  ['一時的なアクセスキー', /ASIA[A-Z0-9]{16}/],
  ['セッショントークン', /IQoJb3JpZ2lu/],
  ['セッションcookie', /__Host-sid=/],
];
// 本文（プロンプト、業務データ、ツールの結果、注入された文言）。スパンに記録しない
const CONTENT: [string, RegExp][] = [
  ['プロンプト', /分析してください|不正検知アナリスト/],
  ['案件のデータ', /深夜帯の海外送金/],
  ['口座のデータ', /東京 太郎/],
  ['注入された文言', /本部監査部/],
];
const BROWSER_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

let startTime: number;
let summary: SpanRecord[];
let agent: SpanRecord[];
let browserTraceIgnored: { bffTraceId?: string };

const named = (spans: SpanRecord[], name: string) => spans.filter((s) => s.name === name);
const one = (spans: SpanRecord[], name: string) => {
  const found = named(spans, name);
  expect(found, name).toHaveLength(1);
  return found[0]!;
};
const byId = (spans: SpanRecord[], id?: string) => spans.find((s) => s.spanId === id);

beforeAll(async () => {
  startTime = Date.now() - 5000;
  await provisionTestData();
  const manager = await loginSession('tokyoManager');
  // ブラウザが送ったtraceparentは、bffが引き継がない
  const s = await browserGet(`/api/cases/${T.tokyoCase}/summary`, manager, { traceparent: `00-${BROWSER_TRACE_ID}-00f067aa0ba902b7-01` });
  const a = await browserPost('/api/agent', JSON.stringify({ caseId: T.tokyoCase }), manager);
  const [summaryId, agentId] = [requestIdOf(s), requestIdOf(a)];
  const logs = await handledLogs([summaryId, agentId], ['bff'], startTime);
  const summaryTrace = logs(summaryId).bff!.traceId!;
  const agentTrace = logs(agentId).bff!.traceId!;
  browserTraceIgnored = { bffTraceId: summaryTrace };
  [summary, agent] = await Promise.all([
    // bff、case-service、account-service、属性サービス（2回）の受信と、それぞれへの送信
    traceSpans(summaryTrace, startTime, (sp) => named(sp, 'entitlement-service').length >= 2 && named(sp, 'account-service').length >= 1 && named(sp, 'bff').length >= 1),
    traceSpans(agentTrace, startTime, (sp) => named(sp, 'fraud-agent').length >= 1 && named(sp, 'fraud-mcp').length >= 3 && named(sp, 'case-service').length >= 1
      && named(sp, 'bff').length >= 1 && named(sp, 'claude_code.interaction').length >= 1 && named(sp, 'claude_code.tool.execution').length >= 1),
  ]);
}, 420_000);

describe('FR-6: マイクロサービスの経路が1つのトレースにつながる', () => {
  it('各ホップの受信のスパンは、直前のホップの送信のスパンの子になる', () => {
    const bff = one(summary, 'bff');
    const toCase = one(summary, 'call case-service');
    const caseService = one(summary, 'case-service');
    const toAccount = one(summary, 'call account-service');
    const accountService = one(summary, 'account-service');
    expect(bff.parentSpanId ?? '').toBe('');
    expect(toCase.parentSpanId).toBe(bff.spanId);
    expect(caseService.parentSpanId).toBe(toCase.spanId);
    expect(toAccount.parentSpanId).toBe(caseService.spanId);
    expect(accountService.parentSpanId).toBe(toAccount.spanId);
    for (const e of named(summary, 'entitlement-service')) {
      expect(byId(summary, e.parentSpanId)?.name).toBe('call entitlement-service');
    }
  });

  it('受信のスパンに、検証した呼び出し元・目的・scope・ユーザーが入る', () => {
    expect(one(summary, 'bff').attributes).toMatchObject({ 'authz.purpose': 'case-summary', 'enduser.id': USERS.tokyoManager, 'http.response.status_code': 200 });
    expect(one(summary, 'case-service').attributes).toMatchObject({
      'authz.inbound': 'accepted', 'authz.actor': 'bff', 'authz.purpose': 'case-summary', 'authz.scope': 'case:summary', 'enduser.id': USERS.tokyoManager,
    });
    expect(one(summary, 'account-service').attributes).toMatchObject({
      'authz.inbound': 'accepted', 'authz.actor': 'case-service', 'authz.scope': 'account:read', 'enduser.id': USERS.tokyoManager,
    });
  });

  it('AWS SDKの呼び出し（DynamoDB）は、呼び出したホップの受信のスパンの子になる', () => {
    for (const hop of ['case-service', 'account-service', 'entitlement-service']) {
      const servers = named(summary, hop).map((h) => h.spanId);
      const db = summary.filter((sp) => sp.attributes['rpc.service'] === 'DynamoDB' && servers.includes(sp.parentSpanId ?? ''));
      expect(db.length, hop).toBeGreaterThan(0);
      for (const d of db) expect(d.attributes['aws.dynamodb.table_names']).toBeDefined();
    }
  });

  it('NFR-3: 送信の内訳（chain、JWTの発行）と、bffでの目的の刻印がスパンになる', () => {
    for (const name of ['assume (sts:AssumeRoleWithWebIdentity)', 'stamp purpose (sts:AssumeRole)', 'chain (sts:AssumeRole)', 'mint JWT (sts:GetWebIdentityToken)']) {
      expect(named(summary, name).length, name).toBeGreaterThan(0);
    }
  });

  it('ブラウザから届いたtraceparentは引き継がず、bffで新しいトレースを始める', () => {
    expect(browserTraceIgnored.bffTraceId).not.toBe(BROWSER_TRACE_ID);
  });
});

describe('FR-6: エージェントの経路も1つのトレースにつながる', () => {
  it('fraud-agentから中継を通したfraud-mcpへの呼び出しも、同じトレースの子になる', () => {
    const toAgent = one(agent, 'call fraud-agent');
    const fraudAgent = one(agent, 'fraud-agent');
    expect(fraudAgent.parentSpanId).toBe(toAgent.spanId);
    const mcp = named(agent, 'fraud-mcp');
    expect(mcp.length).toBeGreaterThanOrEqual(3);
    for (const m of mcp) {
      expect(byId(agent, m.parentSpanId)?.name).toBe('call fraud-mcp');
      expect(m.attributes).toMatchObject({ 'authz.actor': 'fraud-agent', 'authz.purpose': 'agent-analysis', 'authz.scope': 'mcp:tools', 'enduser.id': USERS.tokyoManager });
    }
    expect(named(agent, 'case-service')[0]?.attributes).toMatchObject({ 'authz.actor': 'fraud-mcp', 'authz.scope': 'case:read' });
  });

  it('Claude Code（子プロセス）のスパンは、fraud-agentの受信のスパンの子になる', () => {
    const fraudAgent = one(agent, 'fraud-agent');
    expect(one(agent, 'claude_code.interaction').parentSpanId).toBe(fraudAgent.spanId);
  });

  it('ツールの呼び出し（tools/call）のfraud-mcpへの送信は、Claude Codeのツールの実行のスパンの子になる', () => {
    const toMcp = named(agent, 'call fraud-mcp');
    const underTool = toMcp.filter((c) => byId(agent, c.parentSpanId)?.name === 'claude_code.tool.execution');
    // 接続の処理（2026-07-28版のserver/discover、tools/listなど）は、Claude Codeがスパンの外で行うので、fraud-agentの受信のスパンの子になる
    const underAgent = toMcp.filter((c) => byId(agent, c.parentSpanId)?.name === 'fraud-agent');
    expect(underTool.length).toBe(named(agent, 'claude_code.tool.execution').length);
    expect(underTool.length + underAgent.length).toBe(toMcp.length);
  });
});

describe('SR-3: スパンに認証情報も本文も入らない', () => {
  it('2つのトレースのすべてのスパンに、認証情報のパターンが現れない', () => {
    for (const s of [...summary, ...agent]) {
      const text = JSON.stringify(s);
      for (const [name, re] of SECRETS) expect(re.test(text), `${s.name}に${name}`).toBe(false);
    }
  });

  it('プロンプト、業務データ、ツールの結果は、どのスパンにも記録されない（Claude Codeのスパンを含む）', () => {
    for (const s of [...summary, ...agent]) {
      const text = JSON.stringify(s);
      for (const [name, re] of CONTENT) expect(re.test(text), `${s.name}に${name}`).toBe(false);
    }
  });
});
