import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createHopHandler, log, type Call } from '@gekko08/authz-context';
import { context, propagation, SpanKind, trace } from '@opentelemetry/api';
import { HopTransport, type ToolCallRecord } from './hop-transport';
import { dedupe, otlpReceiver, withRootSpan } from './otel-probe';
import { CASE_ID, SYSTEM_PROMPT, userPrompt } from './prompt';

// Claude Agent SDKで作ったfraud-agent。SDKのHTTPのMCPにはリクエストごとの署名とJWTを付けられないので、
// 127.0.0.1で受けるMCPサーバー（HTTP、ステートレス、JSONで応答）を置き、それがfraud-mcpへ中継する（中継型）。
// 中継のMCPクライアントは、共通部品の`call`で送る通信路を使う。認証情報（受け渡されたセッション、JWT）はこのプロセスにとどまり、
// Claude Codeの子プロセスには渡らない。Claude CodeはHTTPのMCPへのリクエストに`traceparent`を付けるので、中継はそれを引き継ぐ
async function relayServer(call: Call, toolCalls: ToolCallRecord[]) {
  const upstream = new Client({ name: 'fraud-agent-claude', version: '0.1.0' });
  const transport = new HopTransport(call, 'fraud-mcp', toolCalls);
  await upstream.connect(transport);
  /** 中継が受け取った`traceparent`（実験の観測用） */
  const received: { method?: string; traceparent?: string }[] = [];

  const handle = async (msg: { id?: unknown; method?: string; params?: any }) => {
    switch (msg.method) {
      case 'initialize':
        return { protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fraud', version: '0.1.0' } };
      case 'ping':
        return {};
      case 'tools/list':
        return upstream.listTools();
      case 'tools/call':
        // ホップの送信のスパンの代わり。Claude Codeのツールのスパンの子になるかを見る
        return trace.getTracer('gekko08-probe').startActiveSpan('relay tools/call', { kind: SpanKind.CLIENT }, async (span) => {
          try {
            return await upstream.callTool(msg.params);
          } finally {
            span.end();
          }
        });
      default:
        throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
    }
  };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      if (req.method !== 'POST') return res.writeHead(405).end();
      const msg = JSON.parse(raw || '{}');
      received.push({ method: msg.method, traceparent: req.headers.traceparent as string | undefined });
      if (msg.id === undefined) return res.writeHead(202).end();
      const ctx = propagation.extract(context.active(), req.headers);
      try {
        const result = await context.with(ctx, () => handle(msg));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      } catch (e) {
        const err = e as Error & { code?: number };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32603, message: err.message } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const close = async () => {
    await upstream.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { url, close, transport, received };
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
  const relay = await relayServer(call, toolCalls);
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
        mcpServers: { fraud: { type: 'http', url: relay.url } },
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
    await relay.close();
    await otlp.close();
  }
  log('info', 'agent finished', { hop: 'fraud-agent-claude', requestId, caseId, toolCalls, subtype, turns, agentMs });
  const got = otlp.received;
  log('info', 'otel probe', {
    hop: 'fraud-agent-claude', requestId, traceId: probe?.traceId, inProcessSpans: dedupe(probe?.spans ?? []),
    child: { resource: got.resource, traces: dedupe(got.traces), metrics: dedupe(got.metrics), logs: dedupe(got.logs) },
    mcpSent: relay.transport.sent,
    // 中継が受け取った`traceparent`の親が、Claude Codeのどのスパンか
    relayReceived: relay.received.map((r) => {
      const parent = r.traceparent?.split('-')[2];
      const parentName = parent ? Object.entries(got.spanIds).find(([, ids]) => ids.includes(parent))?.[0] : undefined;
      return { method: r.method, traceparent: !!r.traceparent, sameTrace: r.traceparent?.split('-')[1] === probe?.traceId, parentName };
    }),
  });
  return { status: 200, body: { caseId, analysis, toolCalls } };
});
