import { query } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHopHandler, log, type Call } from '@gekko08/authz-context';
import { trace } from '@opentelemetry/api';
import { HopTransport, type ToolCallRecord } from './hop-transport';
import { dedupe, otlpReceiver, withRootSpan } from './otel-probe';
import { CASE_ID, SYSTEM_PROMPT, userPrompt } from './prompt';

// Claude Agent SDKで作ったfraud-agent。SDKのHTTPのMCPにはリクエストごとの署名とJWTを付けられないので、
// プロセス内のMCPサーバーを置き、それがfraud-mcpへ中継する（中継型）。中継のMCPクライアントは、共通部品の`call`で送る通信路を使う。
// 認証情報（受け渡されたセッション、JWT）はこのプロセスにとどまり、Claude Codeの子プロセスには渡らない
async function relayServer(call: Call, toolCalls: ToolCallRecord[]) {
  const upstream = new Client({ name: 'fraud-agent-claude', version: '0.1.0' });
  const transport = new HopTransport(call, 'fraud-mcp', toolCalls);
  await upstream.connect(transport);
  const relay = new McpServer({ name: 'fraud', version: '0.1.0' }, { capabilities: { tools: {} } });
  relay.server.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools());
  relay.server.setRequestHandler(CallToolRequestSchema, (req) => upstream.callTool(req.params));
  return { relay, upstream, transport };
}

// Claude Codeの子プロセスに渡す環境変数。Bedrockを呼ぶための実行roleの認証情報と、書き込める場所だけを渡す
function childEnv(otlpEndpoint: string): Record<string, string | undefined> {
  const pick = ['PATH', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'LANG'];
  return {
    ...Object.fromEntries(pick.map((k) => [k, process.env[k]])),
    HOME: '/tmp',
    CLAUDE_CONFIG_DIR: '/tmp/.claude',
    CLAUDE_CODE_USE_BEDROCK: '1',
    // 補助的な処理に使う小さいモデルも、同じ推論プロファイルにする
    ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.BEDROCK_MODEL_ID,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'gekko08-fraud-agent-claude/0.1.0',
    // テレメトリ（実験の観測用）。送り先は関数の中の受け口で、外へは送らない
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: otlpEndpoint,
    OTEL_METRIC_EXPORT_INTERVAL: '1000',
    OTEL_LOGS_EXPORT_INTERVAL: '1000',
    OTEL_BSP_SCHEDULE_DELAY: '500',
  };
}

export const handler = createHopHandler(async (body, { call, requestId }) => {
  const caseId = typeof body.caseId === 'string' && CASE_ID.test(body.caseId) ? body.caseId : undefined;
  if (!caseId) return { status: 400, body: { error: 'caseId is required' } };

  const toolCalls: ToolCallRecord[] = [];
  const { relay, upstream, transport } = await relayServer(call, toolCalls);
  const otlp = await otlpReceiver();
  const t0 = performance.now();
  const stderr: string[] = [];
  let analysis = '';
  let turns: number | undefined;
  let subtype: string | undefined;
  const run = async () => {
    const rc = trace.getActiveSpan()!.spanContext();
    otlp.setRoot(rc.traceId, rc.spanId);
    for await (const m of query({
      prompt: userPrompt(caseId),
      options: {
        pathToClaudeCodeExecutable: `${process.env.LAMBDA_TASK_ROOT}/claude`,
        model: process.env.BEDROCK_MODEL_ID,
        systemPrompt: SYSTEM_PROMPT,
        // 組み込みのツール（Bash、Readなど）は使わせず、中継のMCPサーバーのツールだけを許す
        tools: [],
        mcpServers: { fraud: { type: 'sdk', name: 'fraud', instance: relay } },
        allowedTools: ['mcp__fraud__*'],
        permissionMode: 'dontAsk',
        settingSources: [],
        persistSession: false,
        maxTurns: 8,
        cwd: '/tmp',
        env: childEnv(otlp.endpoint),
        stderr: (d) => { stderr.push(d); },
      },
    })) {
      if (m.type === 'result') {
        subtype = m.subtype;
        turns = m.num_turns;
        if (m.subtype === 'success') analysis = m.result;
      }
    }
  };
  let probe;
  let agentMs: number;
  try {
    // ホップのスパンの代わりの、仮のルートのスパンの中で動かす。SDKは有効なコンテキストを子プロセスのTRACEPARENTに入れる
    probe = await withRootSpan('fraud-agent-claude invoke', run);
    agentMs = Math.round(performance.now() - t0);
    // 子プロセスは終了時にテレメトリを送り切る。届くのを少し待つ
    await new Promise((r) => setTimeout(r, 2000));
  } catch (e) {
    log('error', 'agent failed', { hop: 'fraud-agent-claude', requestId, error: (e as Error).message, stderr: stderr.join('').slice(-2000) });
    throw e;
  } finally {
    await upstream.close();
    await otlp.close();
  }
  log('info', 'agent finished', { hop: 'fraud-agent-claude', requestId, caseId, toolCalls, subtype, turns, agentMs });
  const got = otlp.received;
  log('info', 'otel probe', {
    hop: 'fraud-agent-claude', requestId, traceId: probe?.traceId, inProcessSpans: dedupe(probe?.spans ?? []),
    child: { resource: got.resource, traces: dedupe(got.traces), metrics: dedupe(got.metrics), logs: dedupe(got.logs) },
    mcpSent: transport.sent,
  });
  return { status: 200, body: { caseId, analysis, toolCalls } };
});
