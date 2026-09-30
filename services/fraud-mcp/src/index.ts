import { createHopHandler, type CallResult, type HopContext } from '@gekko08/authz-context';

// エージェント向けのツールを提供するMCPサーバー（Streamable HTTP、ステートレス、JSONで応答）。
// 入口は他のホップと同じ（実行roleとJWT）で守り、MCPのOAuthの認可フローは使わない（エージェントとMCPのADR）。
// ツールは業務のホップを呼ぶだけで、認可の判断は呼び出し先のABACに任せる
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-06-18'];

const TOOLS = [
  {
    name: 'get_case',
    description: '不正検知の案件を取得する。案件の概要、対象の口座ID、取引の一覧を返す。',
    inputSchema: { type: 'object', properties: { caseId: { type: 'string', description: '案件ID（例：C-1001）' } }, required: ['caseId'] },
  },
  {
    name: 'get_account',
    description: '口座の情報（名義、残高）を取得する。',
    inputSchema: { type: 'object', properties: { accountId: { type: 'string', description: '口座ID（例：A-101）' } }, required: ['accountId'] },
  },
];

async function callTool(name: string, args: Record<string, unknown>, { call }: HopContext) {
  let r: CallResult;
  switch (name) {
    case 'get_case':
      r = await call('case-service', { action: 'get', caseId: args.caseId });
      break;
    case 'get_account':
      r = await call('account-service', { accountId: args.accountId });
      break;
    default:
      return undefined;
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({ status: r.status, ...(typeof r.body === 'object' ? r.body : { detail: r.body }) }) }],
    structuredContent: { status: r.status, body: r.body },
    isError: r.status !== 200,
  };
}

const ok = (id: unknown, result: unknown): CallResult => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
const fail = (id: unknown, code: number, message: string): CallResult => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

export const handler = createHopHandler(async (msg, ctx) => {
  if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  // 通知（idなし）には本文なしの202で応える
  if (msg.id === undefined) return { status: 202, body: undefined };

  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion;
      return ok(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fraud-mcp', version: '0.1.0' },
      });
    }
    case 'ping':
      return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, { tools: TOOLS });
    case 'tools/call': {
      const result = await callTool(msg.params?.name, msg.params?.arguments ?? {}, ctx);
      return result ? ok(msg.id, result) : fail(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
    }
    default:
      return fail(msg.id, -32601, 'Method not found');
  }
});
