import { Agent, McpClient } from '@strands-agents/sdk';
import { BedrockModel } from '@strands-agents/sdk/models/bedrock';
import { createHopHandler, log } from '@gekko08/authz-context';
import { HopTransport, type ToolCallRecord } from './hop-transport';
import { dedupe, withRootSpan } from './otel-probe';
import { CASE_ID, SYSTEM_PROMPT, userPrompt } from './prompt';

// Strands Agents（TypeScript）で作ったfraud-agent。MCPクライアントに、共通部品の`call`で送る通信路を渡す（直接型）。
// 入出力はfraud-agentと同じ
export const handler = createHopHandler(async (body, { call, requestId }) => {
  const caseId = typeof body.caseId === 'string' && CASE_ID.test(body.caseId) ? body.caseId : undefined;
  if (!caseId) return { status: 400, body: { error: 'caseId is required' } };

  const toolCalls: ToolCallRecord[] = [];
  const transport = new HopTransport(call, 'fraud-mcp', toolCalls);
  const mcp = new McpClient({
    transport,
    applicationName: 'fraud-agent-strands',
  });
  const agent = new Agent({
    model: new BedrockModel({ modelId: process.env.BEDROCK_MODEL_ID!, maxTokens: 1024 }),
    systemPrompt: SYSTEM_PROMPT,
    tools: [mcp],
    printer: false,
  });
  const t0 = performance.now();
  try {
    // ホップのスパンの代わりの、仮のルートのスパンの中で動かし、Strandsが出すスパンを観測する
    const { result, traceId, spans } = await withRootSpan('fraud-agent-strands invoke', () => agent.invoke(userPrompt(caseId), { limits: { turns: 8 } }));
    const analysis = result.toString();
    log('info', 'agent finished', {
      hop: 'fraud-agent-strands', requestId, caseId, toolCalls, stopReason: result.stopReason, agentMs: Math.round(performance.now() - t0),
    });
    log('info', 'otel probe', { hop: 'fraud-agent-strands', requestId, traceId, spans: dedupe(spans), mcpSent: transport.sent });
    return { status: 200, body: { caseId, analysis, toolCalls } };
  } finally {
    await mcp.disconnect();
  }
});
