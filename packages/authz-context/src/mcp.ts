import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { context, propagation } from '@opentelemetry/api';
import type { Call } from './outbound';
import type { CallResult } from './types';

// MCPサーバーのホップ（Streamable HTTP、ステートレス、JSONで応答）を、エージェントのフレームワークから共通部品の`call`で呼ぶための部品。
// MCPのメッセージは、すべて他のホップと同じ入口（実行roleの署名とJWT）を通る

const ACCEPT = 'application/json, text/event-stream';

/** MCPのメッセージ1つと、その応答（通知には応答がない）。業務のコードがツールの呼び出しを記録するのに使う */
export interface McpExchange {
  request: JSONRPCMessage;
  response?: JSONRPCMessage;
}
export type McpObserver = (exchange: McpExchange) => void;

async function send(call: Call, target: string, message: JSONRPCMessage, protocolVersion?: string): Promise<CallResult> {
  const headers: Record<string, string> = { accept: ACCEPT };
  if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
  return call(target, message, { headers });
}

/**
 * MCPの通信路（直接型）。MCPクライアントを差し替えられるフレームワーク（MCPのSDKの`Client`、Strands Agentsの`McpClient`など）に渡す。
 * 1つのメッセージを1回のPOSTで送り、応答をそのまま返す。
 */
export class HopMcpTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  private protocolVersion?: string;

  constructor(
    private readonly call: Call,
    private readonly target: string,
    private readonly observe?: McpObserver,
  ) {}

  async start(): Promise<void> {}

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const r = await send(this.call, this.target, message, this.protocolVersion);
    if (r.status === 202) {
      this.observe?.({ request: message });
      return;
    }
    if (r.status !== 200) throw new Error(`${this.target}: HTTP ${r.status}`);
    const response = r.body as JSONRPCMessage;
    this.observe?.({ request: message, response });
    // 応答は非同期に渡す。MCPクライアントには、send()が戻ってから応答を待ち始める実装がある
    queueMicrotask(() => this.onmessage?.(response));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

export interface McpRelay {
  /** 中継のURL（127.0.0.1）。MCPクライアントにはHTTPのMCPサーバーとして渡す */
  url: string;
  close(): Promise<void>;
}

const header = (headers: IncomingHttpHeaders, name: string) => {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * MCPの中継（中継型）。MCPクライアントを差し替えられず、固定のヘッダーしか付けられないフレームワーク（Claude Agent SDKなど）に使う。
 * 127.0.0.1で受けたMCPのメッセージを、`call`でそのまま`target`へ転送する。中継は認可の判断をしない。
 * 認証情報はこのプロセスにとどまり、中継を呼ぶ側（子プロセスなど）には渡らない。
 * 受け取った`traceparent`はその時点のコンテキストにして転送し、自分のスパンは作らない（Claude Agent SDKのADR）。
 */
export async function startMcpRelay(call: Call, target: string, observe?: McpObserver): Promise<McpRelay> {
  const server = createServer((req, res) => {
    const reply = (status: number, body?: unknown) => {
      res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    // ステートレスなので、SSEのストリーム（GET）やセッションの終了（DELETE）は受け付けない
    if (req.method !== 'POST') return reply(405);
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c; });
    req.on('end', async () => {
      let message: JSONRPCMessage;
      try {
        message = JSON.parse(raw);
      } catch {
        return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      if (typeof message !== 'object' || message === null || Array.isArray(message)) {
        return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      }
      try {
        const parent = propagation.extract(context.active(), req.headers);
        const r = await context.with(parent, () => send(call, target, message, header(req.headers, 'mcp-protocol-version')));
        if (r.status === 202) {
          observe?.({ request: message });
          return reply(202);
        }
        if (r.status === 200) observe?.({ request: message, response: r.body as JSONRPCMessage });
        return reply(r.status, r.body);
      } catch {
        return reply(502, { jsonrpc: '2.0', id: (message as { id?: unknown }).id ?? null, error: { code: -32603, message: 'relay failed' } });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
