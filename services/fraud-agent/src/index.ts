import { BedrockRuntimeClient, ConverseCommand, type ContentBlock, type Message, type Tool } from '@aws-sdk/client-bedrock-runtime';
import { createHopHandler, log, type Call } from '@gekko08/authz-context';

const bedrock = new BedrockRuntimeClient({});
const MODEL_ID = process.env.BEDROCK_MODEL_ID!;
const MAX_TURNS = 8;
const PROTOCOL_VERSION = '2026-07-28';

const SYSTEM = [
  'あなたは銀行の不正検知アナリストです。与えられた案件を、ツールで取得したデータだけに基づいて分析してください。',
  '分析結果は、疑わしい点、根拠となる取引、推奨する対応を、日本語で簡潔にまとめてください。',
  'ツールがエラーを返した場合は、その旨を結果に含めてください。',
].join('\n');

/** MCPクライアント。fraud-mcpへの呼び出しは、共通部品を通して他のホップと同じ入口を通る */
function mcpClient(call: Call) {
  let nextId = 1;
  const headers = { accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION };
  const rpc = async (method: string, params?: unknown) => {
    const r = await call('fraud-mcp', { jsonrpc: '2.0', id: nextId++, method, params }, { headers });
    const body = r.body as { result?: any; error?: { message: string } };
    if (r.status !== 200 || body.error) throw new Error(`mcp ${method}: ${r.status} ${body.error?.message ?? ''}`);
    return body.result;
  };
  const notify = (method: string) => call('fraud-mcp', { jsonrpc: '2.0', method }, { headers });
  return { rpc, notify };
}

interface ToolCallRecord {
  name: string;
  input: unknown;
  /** 呼び出し先のホップが返したHTTPステータス */
  status: number;
}

// 案件の分析を行うAIエージェント。モデルに渡すのは案件IDとツールの結果だけで、
// ユーザーの情報、ヘッダー、認証情報は渡さない（SR-3）
export const handler = createHopHandler(async (body, { call, requestId }) => {
  const caseId = typeof body.caseId === 'string' && /^[\w-]{1,64}$/.test(body.caseId) ? body.caseId : undefined;
  if (!caseId) return { status: 400, body: { error: 'caseId is required' } };

  const mcp = mcpClient(call);
  await mcp.rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'fraud-agent', version: '0.1.0' } });
  await mcp.notify('notifications/initialized');
  const { tools } = await mcp.rpc('tools/list');
  const toolConfig = {
    tools: (tools as { name: string; description: string; inputSchema: any }[]).map((t): Tool => ({
      toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema } },
    })),
  };

  const messages: Message[] = [{ role: 'user', content: [{ text: `案件${caseId}を分析してください。` }] }];
  const toolCalls: ToolCallRecord[] = [];
  let analysis = '';
  const modelMs: number[] = [];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const t0 = performance.now();
    const res = await bedrock.send(new ConverseCommand({
      modelId: MODEL_ID, system: [{ text: SYSTEM }], messages, toolConfig, inferenceConfig: { maxTokens: 1024 },
    }));
    modelMs.push(Math.round(performance.now() - t0));
    const out = res.output!.message!;
    messages.push(out);
    if (res.stopReason !== 'tool_use') {
      analysis = (out.content ?? []).map((c) => c.text ?? '').join('');
      break;
    }
    const results: ContentBlock[] = [];
    for (const block of out.content ?? []) {
      if (!block.toolUse) continue;
      const { toolUseId, name, input } = block.toolUse;
      const r = await mcp.rpc('tools/call', { name, arguments: input });
      toolCalls.push({ name: name!, input, status: r.structuredContent?.status ?? (r.isError ? 500 : 200) });
      results.push({
        toolResult: { toolUseId, content: (r.content ?? []).map((c: { text: string }) => ({ text: c.text })), status: r.isError ? 'error' : 'success' },
      });
    }
    messages.push({ role: 'user', content: results });
  }
  log('info', 'agent finished', { hop: 'fraud-agent', requestId, caseId, toolCalls, modelMs });
  return { status: 200, body: { caseId, analysis, toolCalls } };
});
