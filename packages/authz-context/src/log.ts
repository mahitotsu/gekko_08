// 構造化ログ。認証情報、JWT、cookieは渡さないこと（SR-3）。
export type LogFields = Record<string, unknown>;

export function log(level: 'info' | 'warn' | 'error', message: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ level, message, ...fields }));
}
