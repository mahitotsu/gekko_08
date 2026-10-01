import { trace } from '@opentelemetry/api';

// 構造化ログ。認証情報、JWT、cookieは渡さないこと（SR-3）。
// 1件を1行のJSONで標準出力に書く。Lambdaのログの形式をJSONにすると、そのまま1件のログになり（二重に包まれない）、
// `timestamp`と`level`でレベルによる絞り込みができる。その時点のスパンがあれば、トレースIDを加えて、ログとトレースを行き来できるようにする
export type LogFields = Record<string, unknown>;

export function log(level: 'info' | 'warn' | 'error', message: string, fields: LogFields = {}): void {
  const sc = trace.getActiveSpan()?.spanContext();
  const traceId = sc && sc.traceFlags & 1 ? sc.traceId : undefined;
  const line = { timestamp: new Date().toISOString(), level: level.toUpperCase(), message, ...(traceId ? { traceId } : {}), ...fields };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
