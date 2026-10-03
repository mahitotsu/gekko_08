import { createHash, randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { log, requireEnv, traceAwsClient } from '@gekko08/authz-context';
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import type { LogoutBody } from './api';
import type { Settings } from './config';
import { cookie, json, readCookie, redirect } from './http';

// ログイン（Cognitoの認可コードフローとPKCE）と、ブラウザとのセッション。ブラウザにはトークンを渡さず、HttpOnlyのcookieだけで結ぶ（FR-5）

const db = DynamoDBDocumentClient.from(traceAwsClient(new DynamoDBClient({})));
const SESSIONS = requireEnv('SESSIONS_TABLE');

const SESSION_COOKIE = '__Host-sid';
const LOGIN_COOKIE = '__Host-login';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOGIN_TTL_SECONDS = 10 * 60;

export interface Session {
  pk: string;
  username: string;
  idToken: string;
  idTokenExp: number;
  refreshToken: string;
  ttl: number;
  /**
   * ログインのセッションを監査で1つにまとめるための識別子。セッションIDとは別の乱数で、cookieとしては使えない。
   * ログイン（`/api/callback`）のときに作り、ログに出す
   */
  ref?: string;
  /** ログインした時刻（UNIX秒） */
  loggedInAt?: number;
}

const now = () => Math.floor(Date.now() / 1000);
// セッションIDはハッシュにして保存する。テーブルを読めても、cookieとして使える値は得られない
const sessionKey = (sid: string) => `sid#${createHash('sha256').update(sid).digest('base64url')}`;

/** IDトークンから、セッションに使うクレームを読む */
function claimsOf(idToken: string): { username: string; exp: number } {
  // トークンエンドポイントからTLSで直接受け取った値なので、ここでは署名を検証しない。
  // 信頼の判断はAssumeRoleWithWebIdentityでSTSが行う
  const payload = idToken.split('.')[1];
  const c = payload ? (JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>) : {};
  const username = c['cognito:username'];
  if (typeof username !== 'string' || typeof c.exp !== 'number') throw new Error('id token lacks username or exp');
  return { username, exp: c.exp };
}

const basicAuth = ({ config, secret }: Settings) => `Basic ${Buffer.from(`${config.clientId}:${secret}`).toString('base64')}`;

async function tokenRequest(settings: Settings, params: Record<string, string>) {
  const res = await fetch(`${settings.config.authDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basicAuth(settings) },
    body: new URLSearchParams({ client_id: settings.config.clientId, ...params }),
  });
  if (!res.ok) throw new Error(`token endpoint: ${res.status}`);
  return (await res.json()) as { id_token: string; refresh_token?: string };
}

export async function login({ config }: Settings): Promise<LambdaFunctionURLResult> {
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

export async function callback(settings: Settings, event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const q = event.queryStringParameters ?? {};
  const state = readCookie(event, LOGIN_COOKIE);
  if (!q.code || !q.state || q.state !== state) return json(400, { error: 'invalid login state' });
  const { Attributes: pending } = await db.send(new DeleteCommand({ TableName: SESSIONS, Key: { pk: `login#${state}` }, ReturnValues: 'ALL_OLD' }));
  if (!pending || typeof pending.verifier !== 'string' || Number(pending.ttl) < now()) return json(400, { error: 'login expired' });

  const tokens = await tokenRequest(settings, {
    grant_type: 'authorization_code', code: q.code, redirect_uri: settings.config.redirectUri, code_verifier: pending.verifier,
  });
  if (!tokens.refresh_token) throw new Error('token endpoint returned no refresh token');
  const sid = randomBytes(32).toString('base64url');
  const { username, exp } = claimsOf(tokens.id_token);
  const item: Session = {
    pk: sessionKey(sid),
    username,
    idToken: tokens.id_token,
    idTokenExp: exp,
    refreshToken: tokens.refresh_token,
    ttl: now() + SESSION_TTL_SECONDS,
    ref: randomBytes(12).toString('base64url'),
    loggedInAt: now(),
  };
  await db.send(new PutCommand({ TableName: SESSIONS, Item: item }));
  return redirect('/', [
    cookie(SESSION_COOKIE, sid, SESSION_TTL_SECONDS, 'Strict'),
    cookie(LOGIN_COOKIE, '', 0, 'Lax'),
  ]);
}

/** cookieのセッションを読む。IDトークンの期限が近ければ、リフレッシュトークンで更新する */
export async function loadSession(settings: Settings, event: LambdaFunctionURLEvent): Promise<Session | undefined> {
  const sid = readCookie(event, SESSION_COOKIE);
  if (!sid) return undefined;
  const { Item } = await db.send(new GetCommand({ TableName: SESSIONS, Key: { pk: sessionKey(sid) } }));
  const s = Item as Session | undefined;
  if (!s || s.ttl < now()) return undefined;
  if (s.idTokenExp - 60 > now()) return s;
  try {
    const tokens = await tokenRequest(settings, { grant_type: 'refresh_token', refresh_token: s.refreshToken });
    const { exp } = claimsOf(tokens.id_token);
    await db.send(new UpdateCommand({
      TableName: SESSIONS, Key: { pk: s.pk },
      UpdateExpression: 'SET idToken = :t, idTokenExp = :e',
      ExpressionAttributeValues: { ':t': tokens.id_token, ':e': exp },
    }));
    return { ...s, idToken: tokens.id_token, idTokenExp: exp };
  } catch (e) {
    log('warn', 'refresh failed', { error: e instanceof Error ? e.message : String(e) });
    await db.send(new DeleteCommand({ TableName: SESSIONS, Key: { pk: s.pk } }));
    return undefined;
  }
}

export async function logout(settings: Settings, event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const { config } = settings;
  const sid = readCookie(event, SESSION_COOKIE);
  if (sid) {
    const { Attributes } = await db.send(new DeleteCommand({ TableName: SESSIONS, Key: { pk: sessionKey(sid) }, ReturnValues: 'ALL_OLD' }));
    if (typeof Attributes?.refreshToken === 'string') {
      await fetch(`${config.authDomain}/oauth2/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basicAuth(settings) },
        body: new URLSearchParams({ token: Attributes.refreshToken, client_id: config.clientId }),
      }).catch((e: unknown) => log('warn', 'revoke failed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }
  // マネージドログインにもログインの状態（Cognitoのcookie）が残るので、ブラウザをCognitoのログアウトに送って消す。
  // 消さないと、次のログインで、ユーザー名とパスワードを聞かれずに同じユーザーでログインする
  const cognitoLogout = new URL(`${config.authDomain}/logout`);
  cognitoLogout.search = new URLSearchParams({ client_id: config.clientId, logout_uri: config.logoutUri }).toString();
  const body: LogoutBody = { loggedOut: true, logoutUrl: cognitoLogout.toString() };
  return json(200, body, [cookie(SESSION_COOKIE, '', 0, 'Strict')]);
}
