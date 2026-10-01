import { query } from '@anthropic-ai/claude-agent-sdk';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { createHopHandler, log, type SessionCredentials } from '@gekko08/authz-context';
import { startMcpRelay, type McpExchange } from '@gekko08/authz-context/mcp';

// 案件の分析を行うAIエージェント。Claude Agent SDKが、Claude Code（同梱の実行ファイル）を子プロセスとして動かす。
// MCPサーバー（fraud-mcp）は、このプロセスの中継（127.0.0.1）から共通部品で呼ぶ。子プロセスに渡すのは、中継のURLと、
// Bedrockのモデルの呼び出しだけを許すroleの認証情報だけで、ユーザーの情報、受け取ったJWT、受け渡されたセッションは渡さない（SR-3）
// （Claude Agent SDKのADR）

const MODEL_ID = process.env.BEDROCK_MODEL_ID!;
const MAX_TURNS = 8;

const SYSTEM_PROMPT = [
  'あなたは銀行の不正検知アナリストです。与えられた案件を、ツールで取得したデータだけに基づいて分析してください。',
  '分析結果は、疑わしい点、根拠となる取引、推奨する対応を、日本語で簡潔にまとめてください。',
  'ツールがエラーを返した場合は、その旨を結果に含めてください。',
].join('\n');

interface ToolCallRecord {
  name: string;
  input: unknown;
  /** 呼び出し先のホップが返したHTTPステータス */
  status: number;
}

// モデルの呼び出しだけを許すroleの認証情報。実行環境ごとに使い回し、期限の10分前に引き受け直す
let model: Promise<SessionCredentials & { expiration: number }> | undefined;
function modelCredentials() {
  const fresh = (c: { expiration: number }) => c.expiration - Date.now() > 10 * 60_000;
  const assume = async () => {
    const { Credentials: c } = await new STSClient({}).send(new AssumeRoleCommand({
      RoleArn: process.env.MODEL_ROLE_ARN, RoleSessionName: 'fraud-agent-model', DurationSeconds: 3600,
    }));
    return { accessKeyId: c!.AccessKeyId!, secretAccessKey: c!.SecretAccessKey!, sessionToken: c!.SessionToken!, expiration: c!.Expiration!.getTime() };
  };
  model = model?.then((c) => (fresh(c) ? c : assume())) ?? assume();
  model.catch(() => { model = undefined; });
  return model;
}

/** Claude Codeの子プロセスの環境変数。process.envは引き継がず、要るものだけを渡す */
async function childEnv(): Promise<Record<string, string | undefined>> {
  const c = await modelCredentials();
  return {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    AWS_REGION: process.env.AWS_REGION,
    AWS_ACCESS_KEY_ID: c.accessKeyId,
    AWS_SECRET_ACCESS_KEY: c.secretAccessKey,
    AWS_SESSION_TOKEN: c.sessionToken,
    // Lambdaで書き込めるのは/tmpだけ
    HOME: '/tmp',
    CLAUDE_CONFIG_DIR: '/tmp/.claude',
    CLAUDE_CODE_USE_BEDROCK: '1',
    // 補助的な処理に使う小さいモデルも、同じ推論プロファイルにする
    ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL_ID,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'gekko08-fraud-agent/0.1.0',
  };
}

/** fraud-mcpの`tools/call`の応答から、呼び出し先のホップのHTTPステータスを記録する */
function recordToolCall(toolCalls: ToolCallRecord[]) {
  return ({ request, response }: McpExchange) => {
    const req = request as { method?: string; params?: { name?: string; arguments?: unknown } };
    if (req.method !== 'tools/call' || !response) return;
    const result = (response as { result?: { structuredContent?: { status?: number }; isError?: boolean } }).result;
    toolCalls.push({ name: req.params?.name ?? '', input: req.params?.arguments, status: result?.structuredContent?.status ?? (result?.isError ? 500 : 200) });
  };
}

export const handler = createHopHandler(async (body, { call, requestId }) => {
  const caseId = typeof body.caseId === 'string' && /^[\w-]{1,64}$/.test(body.caseId) ? body.caseId : undefined;
  if (!caseId) return { status: 400, body: { error: 'caseId is required' } };

  const toolCalls: ToolCallRecord[] = [];
  const relay = await startMcpRelay(call, 'fraud-mcp', recordToolCall(toolCalls));
  const t0 = performance.now();
  const stderr: string[] = [];
  let analysis: string | undefined;
  let outcome: { subtype?: string; turns?: number } = {};
  try {
    for await (const m of query({
      prompt: `案件${caseId}を分析してください。`,
      options: {
        pathToClaudeCodeExecutable: `${process.env.LAMBDA_TASK_ROOT}/claude`,
        model: MODEL_ID,
        systemPrompt: SYSTEM_PROMPT,
        // 組み込みのツール（Bash、Readなど）は使わせず、中継のMCPサーバーのツールだけを許す
        tools: [],
        mcpServers: { fraud: { type: 'http', url: relay.url } },
        allowedTools: ['mcp__fraud__*'],
        permissionMode: 'dontAsk',
        // 設定ファイルを読まず、セッションを保存しない
        settingSources: [],
        persistSession: false,
        maxTurns: MAX_TURNS,
        cwd: '/tmp',
        env: await childEnv(),
        stderr: (d) => { stderr.push(d); },
      },
    })) {
      if (m.type === 'result') {
        outcome = { subtype: m.subtype, turns: m.num_turns };
        if (m.subtype === 'success') analysis = m.result;
      }
    }
  } catch (e) {
    log('error', 'agent failed', { hop: 'fraud-agent', requestId, error: (e as Error).message, stderr: stderr.join('').slice(-2000) });
    throw e;
  } finally {
    await relay.close();
  }
  const agentMs = Math.round(performance.now() - t0);
  log('info', 'agent finished', { hop: 'fraud-agent', requestId, caseId, toolCalls, ...outcome, agentMs });
  if (analysis === undefined) return { status: 502, body: { error: 'agent did not finish', toolCalls } };
  return { status: 200, body: { caseId, analysis, toolCalls } };
});
