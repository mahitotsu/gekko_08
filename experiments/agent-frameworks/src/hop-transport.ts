import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { trace } from '@opentelemetry/api';
import type { Call } from '@gekko08/authz-context';

/** fraud-agentの応答と同じ形の、ツール呼び出しの記録 */
export interface ToolCallRecord {
  name: string;
  input: unknown;
  /** 呼び出し先のホップが返したHTTPステータス */
  status: number;
}

/** 送ったMCPのメッセージごとの、トレースの引き継ぎの様子（実験の観測用） */
export interface SentRecord {
  method?: string;
  /** メッセージの`_meta`（paramsか、tools/callのarguments）にW3Cの`traceparent`があるか */
  metaTraceparent: boolean;
  /** 送るときに有効だったスパンのトレースID */
  activeTraceId?: string;
}

/**
 * MCPの通信路を、共通部品の`call`（chain、JWTの発行、実行roleでの署名）で実装する。
 * MCPクライアントの送るメッセージは、すべて他のホップと同じ入口を通る。
 * fraud-mcpはステートレスでJSONで応答するので、1つのメッセージを1回のPOSTで送り、応答をそのまま返す。
 */
export class HopTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  private protocolVersion?: string;
  private readonly pending = new Map<string | number, { name: string; input: unknown }>();

  constructor(
    private readonly call: Call,
    private readonly target: string,
    /** ツール呼び出しを記録する先。フレームワークに依らず、通信路で記録する */
    private readonly toolCalls: ToolCallRecord[] = [],
    readonly sent: SentRecord[] = [],
  ) {}

  async start(): Promise<void> {}

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const m = message as { id?: string | number; method?: string; params?: { name?: string; arguments?: unknown } };
    if (m.method === 'tools/call' && m.id !== undefined) this.pending.set(m.id, { name: m.params?.name ?? '', input: m.params?.arguments });
    const p = m.params as { _meta?: { traceparent?: string }; arguments?: { _meta?: { traceparent?: string } } } | undefined;
    this.sent.push({
      method: m.method,
      metaTraceparent: !!(p?._meta?.traceparent ?? p?.arguments?._meta?.traceparent),
      activeTraceId: trace.getActiveSpan()?.spanContext().traceId,
    });

    const headers: Record<string, string> = { accept: 'application/json, text/event-stream' };
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;
    const r = await this.call(this.target, message, { headers });
    if (r.status === 202) return; // 通知への応答
    if (r.status !== 200) throw new Error(`${this.target}: HTTP ${r.status}`);

    const res = r.body as JSONRPCMessage & { id?: string | number; result?: { structuredContent?: { status?: number }; isError?: boolean } };
    const req = res.id !== undefined ? this.pending.get(res.id) : undefined;
    if (req) {
      this.pending.delete(res.id!);
      this.toolCalls.push({ ...req, status: res.result?.structuredContent?.status ?? (res.result?.isError ? 500 : 200) });
    }
    // 応答は非同期に渡す。MCPクライアントは、send()が戻ってから応答を待ち始める実装がある
    queueMicrotask(() => this.onmessage?.(res));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}
