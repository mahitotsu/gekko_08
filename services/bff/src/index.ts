import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { AssumeRoleCommand, AssumeRoleWithWebIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { ATTR, createCaller, flushTelemetry, initTelemetry, log, tracer, type Call, type Target, type Timings } from '@gekko08/authz-context';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';

initTelemetry('bff');
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const sts = new STSClient({});
const SESSIONS = process.env.SESSIONS_TABLE!;

const SESSION_COOKIE = '__Host-sid';
const LOGIN_COOKIE = '__Host-login';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOGIN_TTL_SECONDS = 10 * 60;

/** デプロイ時にSSM Parameter Storeへ書く設定。CloudFrontとCognitoの循環参照を避けるため、環境変数ではなく実行時に読む */
interface BffConfig {
  clientId: string;
  /** Cognitoのマネージドログインのドメイン（https://...） */
  authDomain: string;
  redirectUri: string;
  federatedRoleArn: string;
  /** 取引の目的を刻むrole */
  purposeRoleArn: string;
  targets: Record<string, Target>;
}

let loaded: Promise<{ config: BffConfig; secret: string }> | undefined;
function settings() {
  loaded ??= (async () => {
    const [c, s] = await Promise.all([
      ssm.send(new GetParameterCommand({ Name: process.env.BFF_CONFIG_PARAM })),
      ssm.send(new GetParameterCommand({ Name: process.env.BFF_SECRET_PARAM, WithDecryption: true })),
    ]);
    return { config: JSON.parse(c.Parameter!.Value!) as BffConfig, secret: s.Parameter!.Value! };
  })();
  loaded.catch(() => { loaded = undefined; });
  return loaded;
}

interface Session {
  pk: string;
  username: string;
  idToken: string;
  idTokenExp: number;
  refreshToken: string;
  ttl: number;
}

const now = () => Math.floor(Date.now() / 1000);
// セッションIDはハッシュにして保存する。テーブルを読めても、cookieとして使える値は得られない
const sessionKey = (sid: string) => `sid#${createHash('sha256').update(sid).digest('base64url')}`;

function json(status: number, body: unknown, cookies?: string[]): LambdaFunctionURLResult {
  return { statusCode: status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body), cookies };
}

function redirect(location: string, cookies?: string[]): LambdaFunctionURLResult {
  return { statusCode: 302, headers: { location, 'cache-control': 'no-store' }, cookies };
}

function cookie(name: string, value: string, maxAge: number, sameSite: 'Strict' | 'Lax'): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}`;
}

function readCookie(event: LambdaFunctionURLEvent, name: string): string | undefined {
  for (const c of event.cookies ?? []) {
    const i = c.indexOf('=');
    if (c.slice(0, i).trim() === name) return c.slice(i + 1).trim();
  }
  return undefined;
}

function claimsOf(idToken: string): Record<string, any> {
  // トークンエンドポイントからTLSで直接受け取った値なので、ここでは署名を検証しない。
  // 信頼の判断はAssumeRoleWithWebIdentityでSTSが行う
  return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
}

async function tokenRequest(params: Record<string, string>) {
  const { config, secret } = await settings();
  const res = await fetch(`${config.authDomain}/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${config.clientId}:${secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ client_id: config.clientId, ...params }),
  });
  if (!res.ok) throw new Error(`token endpoint: ${res.status}`);
  return (await res.json()) as { id_token: string; refresh_token?: string };
}

async function login(): Promise<LambdaFunctionURLResult> {
  const { config } = await settings();
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  await db.send(new PutCommand({ TableName: SESSIONS, Item: { pk: `login#${state}`, verifier, ttl: now() + LOGIN_TTL_SECONDS } }));
  const url = new URL(`${config.authDomain}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'openid',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  return redirect(url.toString(), [cookie(LOGIN_COOKIE, state, LOGIN_TTL_SECONDS, 'Lax')]);
}

async function callback(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const { config } = await settings();
  const q = event.queryStringParameters ?? {};
  const state = readCookie(event, LOGIN_COOKIE);
  if (!q.code || !q.state || q.state !== state) return json(400, { error: 'invalid login state' });
  const { Attributes: pending } = await db.send(new DeleteCommand({ TableName: SESSIONS, Key: { pk: `login#${state}` }, ReturnValues: 'ALL_OLD' }));
  if (!pending || pending.ttl < now()) return json(400, { error: 'login expired' });

  const tokens = await tokenRequest({ grant_type: 'authorization_code', code: q.code, redirect_uri: config.redirectUri, code_verifier: pending.verifier });
  const sid = randomBytes(32).toString('base64url');
  await putSession(sid, tokens.id_token, tokens.refresh_token!);
  return redirect('/', [
    cookie(SESSION_COOKIE, sid, SESSION_TTL_SECONDS, 'Strict'),
    cookie(LOGIN_COOKIE, '', 0, 'Lax'),
  ]);
}

async function putSession(sid: string, idToken: string, refreshToken: string) {
  const c = claimsOf(idToken);
  const item: Session = {
    pk: sessionKey(sid),
    username: c['cognito:username'],
    idToken,
    idTokenExp: c.exp,
    refreshToken,
    ttl: now() + SESSION_TTL_SECONDS,
  };
  await db.send(new PutCommand({ TableName: SESSIONS, Item: item }));
}

async function loadSession(event: LambdaFunctionURLEvent): Promise<Session | undefined> {
  const sid = readCookie(event, SESSION_COOKIE);
  if (!sid) return undefined;
  const { Item } = await db.send(new GetCommand({ TableName: SESSIONS, Key: { pk: sessionKey(sid) } }));
  const s = Item as Session | undefined;
  if (!s || s.ttl < now()) return undefined;
  if (s.idTokenExp - 60 > now()) return s;
  // IDトークンの期限が近ければ、リフレッシュトークンで更新する
  try {
    const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refreshToken });
    const c = claimsOf(tokens.id_token);
    await db.send(new UpdateCommand({
      TableName: SESSIONS, Key: { pk: s.pk },
      UpdateExpression: 'SET idToken = :t, idTokenExp = :e',
      ExpressionAttributeValues: { ':t': tokens.id_token, ':e': c.exp },
    }));
    return { ...s, idToken: tokens.id_token, idTokenExp: c.exp };
  } catch (e) {
    log('warn', 'refresh failed', { error: (e as Error).message });
    await db.send(new DeleteCommand({ TableName: SESSIONS, Key: { pk: s.pk } }));
    return undefined;
  }
}

async function logout(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const sid = readCookie(event, SESSION_COOKIE);
  if (sid) {
    const { Attributes } = await db.send(new DeleteCommand({ TableName: SESSIONS, Key: { pk: sessionKey(sid) }, ReturnValues: 'ALL_OLD' }));
    if (Attributes?.refreshToken) {
      const { config, secret } = await settings();
      await fetch(`${config.authDomain}/oauth2/revoke`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${config.clientId}:${secret}`).toString('base64')}`,
        },
        body: new URLSearchParams({ token: Attributes.refreshToken, client_id: config.clientId }),
      }).catch((e) => log('warn', 'revoke failed', { error: (e as Error).message }));
    }
  }
  return json(200, { loggedOut: true }, [cookie(SESSION_COOKIE, '', 0, 'Strict')]);
}

/**
 * ログイン中のユーザーの代理で、取引の目的を刻んだセッションを作り、最初のホップを呼ぶ。STSの認証情報はどこにも保存しない
 * 1. IDトークンでfederated roleのセッションを得る（SourceIdentity＝ユーザー識別子）
 * 2. 目的用のroleへchainし、目的をtransitive session tagとして刻む。以降のホップは目的を変えられない
 */
/** 時間を測り、同じ区切りでスパンを作る（NFR-3） */
function step<T>(timings: Timings, key: string, name: string, f: () => Promise<T>): Promise<T> {
  return tracer().startActiveSpan(name, async (span) => {
    const t0 = performance.now();
    try {
      return await f();
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw e;
    } finally {
      timings[key] = Math.round(performance.now() - t0);
      span.end();
    }
  });
}

async function withChain<T>(s: Session, requestId: string, purpose: string, timings: Timings, f: (call: Call) => Promise<T>): Promise<T> {
  const { config } = await settings();
  const { Credentials: fed } = await step(timings, 'assumeMs', 'assume (sts:AssumeRoleWithWebIdentity)', () => sts.send(new AssumeRoleWithWebIdentityCommand({
    RoleArn: config.federatedRoleArn,
    RoleSessionName: requestId,
    WebIdentityToken: s.idToken,
    DurationSeconds: 900,
  })));
  const { Credentials: c } = await step(timings, 'purposeMs', 'stamp purpose (sts:AssumeRole)', () => new STSClient({
    credentials: { accessKeyId: fed!.AccessKeyId!, secretAccessKey: fed!.SecretAccessKey!, sessionToken: fed!.SessionToken! },
  }).send(new AssumeRoleCommand({
    RoleArn: config.purposeRoleArn,
    RoleSessionName: requestId,
    DurationSeconds: 900,
    Tags: [{ Key: 'purpose', Value: purpose }],
    TransitiveTagKeys: ['purpose'],
  })));
  const session = { accessKeyId: c!.AccessKeyId!, secretAccessKey: c!.SecretAccessKey!, sessionToken: c!.SessionToken! };
  return f(createCaller({ session, requestId, targets: config.targets, timings }));
}

const CASE_SUMMARY = /^\/api\/cases\/([\w-]{1,64})\/summary$/;

interface HopRoute {
  name: string;
  /** 取引の目的。bffが経路ごとに決める */
  purpose: string;
  target: string;
  body: unknown;
}

/** ホップを呼ぶ経路。ブラウザから受け取るのは案件IDだけで、ユーザーの情報も目的も受け取らない */
function hopRoute(event: LambdaFunctionURLEvent): HopRoute | undefined {
  const method = event.requestContext.http.method;
  if (method === 'GET' && event.rawPath === '/api/me') return { name: 'me', purpose: 'profile', target: 'entitlement-service', body: {} };
  const m = method === 'GET' ? event.rawPath.match(CASE_SUMMARY) : null;
  if (m) return { name: 'case-summary', purpose: 'case-summary', target: 'case-service', body: { action: 'summary', caseId: m[1] } };
  if (method === 'POST' && event.rawPath === '/api/agent') {
    let caseId: unknown;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body;
      caseId = JSON.parse(raw || '{}').caseId;
    } catch {
      return undefined;
    }
    if (typeof caseId === 'string' && /^[\w-]{1,64}$/.test(caseId)) return { name: 'agent', purpose: 'agent-analysis', target: 'fraud-agent', body: { caseId } };
  }
  return undefined;
}

// ブラウザから届いたtraceparentは引き継がず、bffで新しいトレースを始める。ブラウザは呼び出し元として確かめられない
export const handler = (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> =>
  tracer().startActiveSpan('bff', { kind: SpanKind.SERVER, attributes: { [ATTR.hop]: 'bff' } }, ROOT_CONTEXT, async (span) => {
    try {
      const res = await handle(event, span);
      const status = typeof res === 'object' ? res.statusCode ?? 200 : 200;
      span.setAttribute(ATTR.status, status);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      return res;
    } finally {
      span.end();
      await flushTelemetry();
    }
  });

async function handle(event: LambdaFunctionURLEvent, span: Span): Promise<LambdaFunctionURLResult> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  try {
    if (method === 'GET' && path === '/api/login') return await login();
    if (method === 'GET' && path === '/api/callback') return await callback(event);
    if (method === 'POST' && path === '/api/logout') return await logout(event);

    const s = await loadSession(event);
    if (!s) return json(401, { error: 'not logged in' });
    const route = hopRoute(event);
    if (!route) return json(404, { error: 'not found' });

    const requestId = randomUUID();
    span.setAttributes({ [ATTR.requestId]: requestId, [ATTR.purpose]: route.purpose, [ATTR.enduser]: s.username, 'authz.route': route.name });
    const t0 = performance.now();
    const timings: Timings = {};
    const r = await withChain(s, requestId, route.purpose, timings, (call) => call(route.target, route.body));
    log('info', 'handled', {
      hop: 'bff', requestId, route: route.name, purpose: route.purpose, user: s.username, status: r.status,
      timings: { ...timings, totalMs: Math.round(performance.now() - t0) },
    });
    if (route.name === 'me') {
      // 表示用。所属と役職は属性サービスから得る（トークンには入れていない）
      const e = r.body as { branch?: string; title?: string };
      return r.status === 200 ? json(200, { username: s.username, branch: e.branch, title: e.title }) : json(r.status, { username: s.username });
    }
    return json(r.status, { requestId, ...(typeof r.body === 'object' ? r.body : { detail: r.body }) });
  } catch (e) {
    log('error', 'handler failed', { path, error: (e as Error).name, detail: (e as Error).message });
    return json(500, { error: 'internal error' });
  }
}
