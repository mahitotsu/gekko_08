import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * fraud-agentが、Claude Codeの子プロセスに渡す設定の単体テスト（設計書§8、脅威の総点検 F-4）。
 * 子プロセスとの境界は、認証情報の隔離ではなく能力の隔離（任意のコードを実行させない）なので、
 * 組み込みのツールを無効にし、中継のツールだけを使わせること、委任に使う認証情報を渡さないことを確かめる
 */

type Business = (body: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;
const captured: { fn?: Business; options?: Record<string, any> } = {};
const MODEL_CREDS = { AccessKeyId: 'MODELKEY', SecretAccessKey: 'model-secret', SessionToken: 'model-token', Expiration: new Date(Date.now() + 3_600_000) };

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    captured.options = options;
    return (async function* () { yield { type: 'result', subtype: 'success', result: '提案', num_turns: 1 }; })();
  },
}));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class { send = async () => ({ Credentials: MODEL_CREDS }); },
  AssumeRoleCommand: class { constructor(readonly input: unknown) {} },
}));
vi.mock('@gekko08/authz-context', () => ({
  createHopHandler: (fn: Business) => { captured.fn = fn; return fn; },
  log: () => {},
  traceAwsClient: <T>(c: T) => c,
  startOtlpTraceRelay: async () => ({ endpoint: 'http://127.0.0.1:4318', settle: async () => {}, close: async () => {} }),
}));
vi.mock('@gekko08/authz-context/mcp', () => ({
  startMcpRelay: async () => ({ url: 'http://127.0.0.1:9999/mcp', close: async () => {} }),
}));

// 実行roleの認証情報と、受信で使う設定。いずれも子プロセスに渡ってはならない
const PARENT_ENV = {
  AWS_ACCESS_KEY_ID: 'EXECKEY', AWS_SECRET_ACCESS_KEY: 'exec-secret', AWS_SESSION_TOKEN: 'exec-token',
  AUTHZ_CALLERS: '{"bff-exec":{}}', AUTHZ_ISSUER: 'https://issuer.example', MODEL_ROLE_ARN: 'arn:aws:iam::111111111111:role/model',
  BEDROCK_MODEL_ID: 'jp.anthropic.claude-haiku-4-5-20251001-v1:0', AWS_REGION: 'ap-northeast-1', LAMBDA_TASK_ROOT: '/var/task',
};

beforeAll(async () => {
  Object.assign(process.env, PARENT_ENV);
  await import('../src/index');
  const r = await captured.fn!({ caseId: 'C-1001' }, { call: async () => ({ status: 200, body: {} }), requestId: 'req-1' });
  expect(r.status).toBe(200);
});

describe('Claude Codeの子プロセスに渡す設定', () => {
  it('組み込みのツール（Bash、Readなど）を無効にし、中継のMCPサーバーのツールだけを許す', () => {
    const o = captured.options!;
    expect(o.tools).toEqual([]);
    expect(o.allowedTools).toEqual(['mcp__fraud__*']);
    // 許したツール以外は、確認を求めずに拒否する
    expect(o.permissionMode).toBe('dontAsk');
    expect(Object.keys(o.mcpServers)).toEqual(['fraud']);
    expect(o.mcpServers.fraud).toEqual({ type: 'http', url: 'http://127.0.0.1:9999/mcp' });
  });

  it('設定ファイルを読まず、セッションを保存せず、ターン数を限る', () => {
    const o = captured.options!;
    expect(o.settingSources).toEqual([]);
    expect(o.persistSession).toBe(false);
    expect(o.maxTurns).toBe(8);
  });

  it('環境変数は引き継がず、決めたものだけを渡す', () => {
    expect(Object.keys(captured.options!.env).sort()).toEqual([
      'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'AWS_ACCESS_KEY_ID', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
      'CLAUDE_AGENT_SDK_CLIENT_APP', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_ENABLE_TELEMETRY', 'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'HOME', 'LANG', 'OTEL_BSP_SCHEDULE_DELAY',
      'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_LOGS_EXPORTER', 'OTEL_METRICS_EXPORTER', 'OTEL_TRACES_EXPORTER', 'PATH',
    ].sort());
  });

  it('AWSの認証情報は、モデルの呼び出しだけを許すroleのもので、実行roleのものではない', () => {
    const env = captured.options!.env;
    expect([env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.AWS_SESSION_TOKEN]).toEqual(['MODELKEY', 'model-secret', 'model-token']);
    const text = JSON.stringify(captured.options);
    for (const v of ['EXECKEY', 'exec-secret', 'exec-token', 'AUTHZ_', 'issuer.example']) expect(text).not.toContain(v);
  });

  it('プロンプトに、ユーザーの情報や認証情報を入れない（案件IDだけ）', () => {
    expect(captured.options!.systemPrompt).not.toMatch(/yamada|token|secret/i);
  });
});
