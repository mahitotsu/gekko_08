import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';

// ブラウザとのHTTPの応答とcookie

export function json(status: number, body: unknown, cookies?: string[]): LambdaFunctionURLResult {
  return { statusCode: status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body), cookies };
}

export function redirect(location: string, cookies?: string[]): LambdaFunctionURLResult {
  return { statusCode: 302, headers: { location, 'cache-control': 'no-store' }, cookies };
}

export function cookie(name: string, value: string, maxAge: number, sameSite: 'Strict' | 'Lax'): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}`;
}

export function readCookie(event: LambdaFunctionURLEvent, name: string): string | undefined {
  for (const c of event.cookies ?? []) {
    const i = c.indexOf('=');
    if (i > 0 && c.slice(0, i).trim() === name) return c.slice(i + 1).trim();
  }
  return undefined;
}
