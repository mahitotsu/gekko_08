import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HopMcpTransport, startMcpRelay, type McpExchange, type McpRelay } from '../src/mcp';
import type { Call, CallOptions } from '../src/outbound';

// 呼び出し先のホップの代わり。送られたメッセージと、そのときのコンテキストを記録する
function fakeCall(respond: (body: any) => { status: number; body: unknown }) {
  const sent: { target: string; body: any; options?: CallOptions; traceId?: string; parentSpanId?: string }[] = [];
  const call: Call = async (target, body, options) => {
    const sc = trace.getSpanContext(context.active());
    sent.push({ target, body, options, traceId: sc?.traceId, parentSpanId: sc?.spanId });
    return respond(body);
  };
  return { call, sent };
}

const echo = (body: any) => (body.id === undefined ? { status: 202, body: undefined } : { status: 200, body: { jsonrpc: '2.0', id: body.id, result: { ok: body.method } } });

describe('HopMcpTransport', () => {
  it('メッセージを1つずつ呼び出し先のホップへ送り、応答をMCPクライアントに渡す', async () => {
    const { call, sent } = fakeCall(echo);
    const seen: McpExchange[] = [];
    const t = new HopMcpTransport(call, 'fraud-mcp', (e) => seen.push(e));
    const got: unknown[] = [];
    t.onmessage = (m) => got.push(m);
    t.setProtocolVersion('2025-11-25');
    await t.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await t.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.map((s) => s.target)).toEqual(['fraud-mcp', 'fraud-mcp']);
    expect(sent[0]?.options?.headers).toMatchObject({ accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' });
    expect(got).toEqual([{ jsonrpc: '2.0', id: 1, result: { ok: 'tools/list' } }]);
    expect(seen).toEqual([
      { request: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, response: { jsonrpc: '2.0', id: 1, result: { ok: 'tools/list' } } },
      { request: { jsonrpc: '2.0', method: 'notifications/initialized' } },
    ]);
  });

  it('呼び出し先が拒否したら、エラーにする', async () => {
    const t = new HopMcpTransport(fakeCall(() => ({ status: 403, body: { error: 'forbidden' } })).call, 'fraud-mcp');
    await expect(t.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).rejects.toThrow('HTTP 403');
  });
});

describe('startMcpRelay', () => {
  let relay: McpRelay;
  const fake = fakeCall(echo);
  const seen: McpExchange[] = [];

  beforeAll(async () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    relay = await startMcpRelay(fake.call, 'fraud-mcp', (e) => seen.push(e));
  });
  afterAll(async () => {
    await relay.close();
    context.disable();
    propagation.disable();
  });

  const post = (body: string, headers: Record<string, string> = {}) =>
    fetch(relay.url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

  it('127.0.0.1だけで受ける', () => {
    expect(new URL(relay.url).hostname).toBe('127.0.0.1');
  });

  it('受けたメッセージをそのまま呼び出し先へ転送し、応答を返す', async () => {
    const res = await post(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_case' } }), { 'mcp-protocol-version': '2025-11-25' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: 'tools/call' } });
    const last = fake.sent.at(-1)!;
    expect(last).toMatchObject({ target: 'fraud-mcp', body: { method: 'tools/call', params: { name: 'get_case' } } });
    expect(last.options?.headers).toMatchObject({ 'mcp-protocol-version': '2025-11-25' });
    expect(seen.at(-1)).toMatchObject({ request: { id: 7 }, response: { id: 7 } });
  });

  it('通知には、本文なしの202で応える', async () => {
    const res = await post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('受け取ったtraceparentを、転送するときのコンテキストにする', async () => {
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const spanId = 'b7ad6b7169203331';
    await post(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call' }), { traceparent: `00-${traceId}-${spanId}-01` });
    expect(fake.sent.at(-1)).toMatchObject({ traceId, parentSpanId: spanId });
  });

  it('呼び出し先の拒否は、そのままのステータスで返す', async () => {
    const r = await startMcpRelay(fakeCall(() => ({ status: 403, body: { error: 'forbidden' } })).call, 'fraud-mcp');
    try {
      const res = await fetch(r.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      expect(res.status).toBe(403);
    } finally {
      await r.close();
    }
  });

  it('POST以外と、JSON-RPCでない本文は受け付けない', async () => {
    expect((await fetch(relay.url)).status).toBe(405);
    expect((await post('not json')).status).toBe(400);
    expect((await post('[{"jsonrpc":"2.0","id":1,"method":"ping"}]')).status).toBe(400);
  });
});
