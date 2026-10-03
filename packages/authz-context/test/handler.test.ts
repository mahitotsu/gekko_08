import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHopHandler, type HopConfig, type HopContext } from '../src/handler';

const ISSUER = 'https://example.tokens.sts.global.api.aws';
const CHAIN = 'arn:aws:iam::123456789012:role/bff-federated';

let config: HopConfig;
let token: string;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES384');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES384' };
  config = {
    hop: 'case-service', audience: 'aud-case', issuer: ISSUER, targets: {},
    callers: { 'bff-exec': { hop: 'bff', sub: CHAIN } },
    provides: { 'case:summary': {} },
    keys: createLocalJWKSet({ keys: [jwk] }),
  };
  token = await new SignJWT({ 'https://sts.amazonaws.com/': { source_identity: 'yamada', principal_tags: { purpose: 'case-summary', requestId: 'req-1' }, request_tags: { scope: 'case:summary' } } })
    .setProtectedHeader({ alg: 'ES384', kid: 'k1' }).setIssuer(ISSUER).setAudience('aud-case').setSubject(CHAIN)
    .setIssuedAt().setExpirationTime('5m').sign(privateKey);
});

const event = (headers: Record<string, string>, userArn = 'arn:aws:sts::123456789012:assumed-role/bff-exec/bff-fn') => ({
  headers, body: '{"caseId":"C-1001"}', isBase64Encoded: false,
  requestContext: { authorizer: { iam: { userArn } } },
}) as unknown as LambdaFunctionURLEvent;

// ハンドラーは常にオブジェクトの形で応答を返す
const statusOf = (r: LambdaFunctionURLResult) => (r as { statusCode: number }).statusCode;

describe('createHopHandler', () => {
  it('業務のコードに、検証済みのsubject・呼び出し元のホップ名・scopeだけを渡す。リクエストの目的は渡さない', async () => {
    let got: Record<string, unknown> | undefined;
    const handler = createHopHandler(async (body, ctx: HopContext) => {
      const { call: _call, headers: _headers, ...rest } = ctx;
      got = rest;
      return { status: 200, body: { caseId: body.caseId } };
    }, config);
    const r = await handler(event({ 'x-authz-context': token, 'x-request-id': 'req-1', 'x-user': 'tanaka' }));
    expect(statusOf(r)).toBe(200);
    expect(got).toEqual({ subject: { id: 'yamada' }, actor: 'bff', scope: 'case:summary', requestId: 'req-1' });
  });

  it('SR-3: 業務のコードに渡すヘッダーから、JWT、受け渡されたセッション、署名を除く', async () => {
    let headers: Readonly<Record<string, string>> = {};
    const handler = createHopHandler(async (_body, ctx) => { headers = ctx.headers; return { status: 200, body: {} }; }, config);
    await handler(event({
      'x-authz-context': token, 'x-authz-session': 'session', 'x-request-id': 'req-1', authorization: 'AWS4-HMAC-SHA256 ...',
      'x-amz-security-token': 'secret', 'mcp-protocol-version': '2025-06-18',
    }));
    expect(headers).toEqual({ 'x-request-id': 'req-1', 'mcp-protocol-version': '2025-06-18' });
  });

  it('本文がJSONのオブジェクトでなければ400で、業務のコードを呼ばない', async () => {
    let called = false;
    const handler = createHopHandler(async () => { called = true; return { status: 200, body: {} }; }, config);
    for (const body of ['{', '[1]', '"text"']) {
      const e = { ...event({ 'x-authz-context': token, 'x-request-id': 'req-1' }), body } as LambdaFunctionURLEvent;
      expect(statusOf(await handler(e))).toBe(400);
    }
    expect(called).toBe(false);
  });

  it('検証に失敗したら、業務のコードを呼ばない', async () => {
    let called = false;
    const handler = createHopHandler(async () => { called = true; return { status: 200, body: {} }; }, config);
    expect(statusOf(await handler(event({ 'x-request-id': 'req-2' })))).toBe(401);
    expect(statusOf(await handler(event({ 'x-authz-context': token, 'x-request-id': 'req-3' }, 'arn:aws:sts::123456789012:assumed-role/other/x')))).toBe(403);
    expect(statusOf(await handler(event({ 'x-authz-context': token })))).toBe(400);
    expect(called).toBe(false);
  });

  it('JWTに刻まれたリクエストIDと違うリクエストIDで届いたら401。拒否のログに、刻まれていた値も残す', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((l) => { lines.push(String(l)); return true; });
    let called = false;
    const handler = createHopHandler(async () => { called = true; return { status: 200, body: {} }; }, config);
    expect(statusOf(await handler(event({ 'x-authz-context': token, 'x-request-id': 'forged-1' })))).toBe(401);
    expect(called).toBe(false);
    const rejected = lines.map((l) => JSON.parse(l)).find((l) => l.message === 'rejected');
    expect(rejected).toMatchObject({ requestId: 'forged-1', stampedRequestId: 'req-1', status: 401 });
  });
});

afterEach(() => vi.restoreAllMocks());
