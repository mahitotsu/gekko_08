import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * fraud-mcpの単体テスト。MCPの公式SDKで、ステートレスに、JSONで応答することと、ツールが受け取った委任（`call`）で業務のホップを呼ぶことを確かめる。
 * 入口の検証は共通部品のテストが確かめるので、業務の関数を取り出して呼ぶ
 */

type Call = (target: string, body: unknown, options?: unknown) => Promise<{ status: number; body: unknown }>;
/** JSON-RPCの応答のうち、テストが読む項目 */
interface RpcResponse {
  result?: { tools?: { name: string; inputSchema: { required?: string[] } }[]; isError?: boolean };
  error?: unknown;
}
type Business = (body: Record<string, unknown>, ctx: { headers: Record<string, string>; call: Call }) => Promise<{ status: number; body?: RpcResponse }>;
const captured: { fn?: Business } = {};

vi.mock('@gekko08/authz-context', () => ({
  createHopHandler: (fn: Business) => { captured.fn = fn; return fn; },
}));

const VERSION = '2025-06-18';
const HEADERS = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
const calls: { target: string; body: unknown }[] = [];
const call: Call = async (target, body) => {
  calls.push({ target, body });
  const action = (body as { action: string }).action;
  if (action === 'unfreeze') return { status: 403, body: { error: 'forbidden', reason: 'scope does not allow the action' } };
  return { status: 200, body: { account: { accountId: 'A-101' } } };
};
const rpc = (body: Record<string, unknown>, headers: Record<string, string> = { ...HEADERS, 'mcp-protocol-version': VERSION }) =>
  captured.fn!(body, { headers, call });

beforeAll(async () => {
  await import('../src/index');
});

describe('fraud-mcp（2025年の版、ステートレス）', () => {
  it('initializeに、要求された版で応える', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0' } } }, HEADERS);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: VERSION, serverInfo: { name: 'fraud-mcp' } } });
  });

  it('通知には本文なしの202で応える', async () => {
    const r = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(r.status).toBe(202);
    expect(r.body).toBeUndefined();
  });

  it('ツールの一覧に、3つのツールと入力のスキーマを返す', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = r.body?.result?.tools ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual(['get_account', 'get_case', 'unfreeze_account']);
    expect(tools.find((t) => t.name === 'get_case')?.inputSchema.required).toEqual(['caseId']);
  });

  it('ツールは、受け取った委任で業務のホップを呼び、拒否はツールのエラーとして返す', async () => {
    calls.length = 0;
    const ok = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_account', arguments: { accountId: 'A-101' } } });
    expect(ok.body?.result).toMatchObject({ isError: false, structuredContent: { status: 200 } });
    const denied = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'unfreeze_account', arguments: { accountId: 'A-999' } } });
    expect(denied.body?.result).toMatchObject({ isError: true, structuredContent: { status: 403, body: { reason: 'scope does not allow the action' } } });
    expect(calls).toEqual([
      { target: 'account-service', body: { action: 'get', accountId: 'A-101' } },
      { target: 'account-service', body: { action: 'unfreeze', accountId: 'A-999' } },
    ]);
  });

  it('入力のスキーマに合わない引数では、業務のホップを呼ばない', async () => {
    calls.length = 0;
    const r = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_case', arguments: { caseId: 1001 } } });
    expect(r.body?.result?.isError ?? r.body?.error).toBeTruthy();
    expect(calls).toEqual([]);
  });
});
