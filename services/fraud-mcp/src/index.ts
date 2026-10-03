import { createHopHandler, type Call, type CallResult } from '@gekko08/authz-context';
import { createMcpHandler, isLegacyRequest, McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod';

// エージェント向けのツールを提供するMCPサーバー。MCPの公式SDKで、ステートレスに、JSONで応答する（MCPの公式SDKのADR）。
// 入口は他のホップと同じ（実行roleとJWT）で守り、MCPのOAuthの認可フローは使わない（エージェントとMCPのADR）。
// ツールは業務のホップを呼ぶだけで、認可の判断は呼び出し先に任せる

const accountId = z.string().describe('口座ID（例：A-101）');

/** 呼び出し先のホップの応答を、ツールの結果にする。拒否もツールのエラーとしてそのまま返し、モデルと記録に見せる */
function toolResult(r: CallResult) {
  const body = typeof r.body === 'object' && r.body !== null ? r.body : { detail: r.body };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ status: r.status, ...body }) }],
    structuredContent: { status: r.status, body: r.body },
    isError: r.status !== 200,
  };
}

/** 1回の呼び出しに応えるMCPサーバー。ツールは、この呼び出しで受け取った委任（`call`）で業務のホップを呼ぶ */
function buildServer(call: Call): McpServer {
  const server = new McpServer({ name: 'fraud-mcp', version: '0.1.0' });
  server.registerTool('get_case', {
    description: '凍結の見直しの案件を取得する。案件の概要、対象の口座ID、取引の一覧を返す。',
    inputSchema: z.object({ caseId: z.string().describe('案件ID（例：C-1001）') }),
  }, async ({ caseId }) => toolResult(await call('case-service', { action: 'get', caseId })));
  server.registerTool('get_account', {
    description: '口座の情報（名義、凍結の状態と理由）を取得する。',
    inputSchema: z.object({ accountId }),
  }, async (args) => toolResult(await call('account-service', { action: 'get', accountId: args.accountId })));
  // デモ用のツール。fraud-mcpがaccount-serviceに付けられるscopeは`account:read`だけなので、常に拒否される。
  // ツールの一覧ではなく、委任の範囲が境界であることを見せる（デモのADR）
  server.registerTool('unfreeze_account', {
    description: '口座の凍結を解除する。',
    inputSchema: z.object({ accountId }),
  }, async (args) => toolResult(await call('account-service', { action: 'unfreeze', accountId: args.accountId })));
  return server;
}

/**
 * MCPのリクエスト1つに応える。2025年の版（`initialize`で始める版）はステートレスなトランスポートで、
 * 2026-07-28版は`createMcpHandler`で、どちらもストリームにせずJSONで応答する
 */
async function serveMcp(request: Request, call: Call): Promise<Response> {
  if (await isLegacyRequest(request)) {
    const server = buildServer(call);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  }
  const mcp = createMcpHandler(() => buildServer(call), { legacy: 'reject', responseMode: 'json' });
  try {
    return await mcp.fetch(request);
  } finally {
    await mcp.close();
  }
}

export const handler = createHopHandler(async (body, { headers, call }) => {
  // 共通部品が検証した本文とヘッダー（認証情報を除いたもの）から、MCPのSDKに渡すHTTPのリクエストを組み立て直す
  const request = new Request('https://fraud-mcp.internal/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
  const res = await serveMcp(request, call);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : undefined };
});
