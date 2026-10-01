import { trace } from '@opentelemetry/api';

// 構造化ログ。認証情報、JWT、cookieは渡さないこと（SR-3）。
// その時点のスパンがあれば、トレースIDを加えて、ログとトレースを行き来できるようにする
export type LogFields = Record<string, unknown>;

export function log(level: 'info' | 'warn' | 'error', message: string, fields: LogFields = {}): void {
  const sc = trace.getActiveSpan()?.spanContext();
  const traceId = sc && sc.traceFlags & 1 ? sc.traceId : undefined;
  console.log(JSON.stringify({ level, message, ...(traceId ? { traceId } : {}), ...fields }));
}
