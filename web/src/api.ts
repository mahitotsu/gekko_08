// ブラウザは認証情報を持たない。bffとはHttpOnlyのセッションcookieだけで結ぶ（FR-5）

export interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function toResult<T>(res: Response): Promise<ApiResult<T>> {
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { detail: text };
  }
  return { status: res.status, body: body as T };
}

export async function get<T = Record<string, unknown>>(path: string): Promise<ApiResult<T>> {
  return toResult<T>(await fetch(path));
}

// CloudFrontのOACでLambdaを呼ぶため、POSTには本文のSHA-256を付ける
export async function post<T = Record<string, unknown>>(path: string, body = ''): Promise<ApiResult<T>> {
  const res = await fetch(path, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-amz-content-sha256': await sha256Hex(body) } });
  return toResult<T>(res);
}

// bffの本文の型は、bffのパッケージが定義する
export type { Account, Case, CaseTransaction, HopBody, LogoutBody, Me, ToolCall } from '@gekko08/bff/api';
