/**
 * 必須の環境変数を読む。CDKが設定する値なので、なければ設定の誤りとして、どの変数かがわかる形で失敗させる。
 * 関数の初期化のときに読めば、誤った設定の関数は最初の呼び出しの前に失敗する
 */
export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (!value) throw new Error(`environment variable ${name} is not set`);
  return value;
}
