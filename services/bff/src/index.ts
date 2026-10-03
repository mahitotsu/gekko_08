import { randomUUID } from 'node:crypto';
import { ATTR, initTelemetry, log, parseJsonObject, readBody, serve, type Timings } from '@gekko08/authz-context';
import { ROOT_CONTEXT, type Span } from '@opentelemetry/api';
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { stampRequest } from './chain';
import { loadSettings } from './config';
import { json } from './http';
import { INVALID, resolveRoute } from './routes';
import { callback, loadSession, login, logout } from './session';

// 入口のBFF。ログインとセッション（session.ts）、経路（routes.ts）、目的を刻むchain（chain.ts）を組み合わせる

initTelemetry('bff');
// 設定は関数の初期化のときに読む。読めなければ初期化が失敗し、Lambdaが次の呼び出しで初期化し直す
const settings = await loadSettings();

// ブラウザから届いたtraceparentは引き継がず、bffで新しいトレースを始める。ブラウザは呼び出し元として確かめられない
export const handler = (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> =>
  serve('bff', ROOT_CONTEXT, (span) => handle(event, span));

async function handle(event: LambdaFunctionURLEvent, span: Span): Promise<LambdaFunctionURLResult> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  try {
    if (method === 'GET' && path === '/api/login') return await login(settings);
    if (method === 'GET' && path === '/api/callback') return await callback(settings, event);
    if (method === 'POST' && path === '/api/logout') return await logout(settings, event);

    const s = await loadSession(settings, event);
    if (!s) return json(401, { error: 'not logged in' });
    const route = resolveRoute(method, path, parseJsonObject(readBody(event)));
    if (route === INVALID) return json(400, { error: 'invalid request' });
    if (!route) return json(404, { error: 'not found' });

    const requestId = randomUUID();
    span.setAttributes({ [ATTR.requestId]: requestId, [ATTR.purpose]: route.purpose, [ATTR.enduser]: s.username, 'authz.route': route.name });
    const t0 = performance.now();
    const timings: Timings = {};
    const call = await stampRequest(settings.config, s.idToken, requestId, route.purpose, timings);
    const r = await call(route.target, route.body, { scope: route.scope });
    log('info', 'handled', {
      hop: 'bff', requestId, route: route.name, purpose: route.purpose, user: s.username, status: r.status,
      // 監査で、ログインのセッションごとに操作をまとめる。案件IDと監査対象のリクエストIDは表示用（経路のパスから得たもの）
      sessionRef: s.ref, loggedInAt: s.loggedInAt, caseId: route.caseId, auditTarget: route.auditTarget,
      timings: { ...timings, totalMs: Math.round(performance.now() - t0) },
    });
    if (route.name === 'me') {
      // 表示用。所属と役職は属性サービスから得る（トークンには入れていない）
      const e = r.body as { branch?: string; title?: string };
      return r.status === 200 ? json(200, { username: s.username, branch: e.branch, title: e.title }) : json(r.status, { username: s.username });
    }
    // 画面に、bffが刻んだリクエストの目的とリクエストIDを見せる（表示用。ブラウザから目的は受け取らない）。
    // ホップの本文に同じ名前の項目があっても、bffの値で上書きする。ホップに画面の目的やリクエストIDを偽らせない
    const body = typeof r.body === 'object' && r.body !== null ? r.body : { detail: r.body };
    return json(r.status, { ...body, requestId, purpose: route.purpose });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    log('error', 'handler failed', { path, error: error.name, detail: error.message });
    return json(500, { error: 'internal error' });
  }
}
