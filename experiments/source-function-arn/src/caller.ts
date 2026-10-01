import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';

// 呼び出し元。自分の実行roleでSigV4署名して、指定されたFunction URLを呼ぶ。
// dumpは検証専用：実行環境の外への持ち出しを再現するため、実行roleの認証情報を返す（このスタックは検証のあとに削除する）
const signer = new SignatureV4({ service: 'lambda', region: process.env.AWS_REGION!, credentials: defaultProvider(), sha256: Sha256 });

export const handler = async (event: { targets?: Record<string, string>; dump?: boolean }) => {
  if (event.dump) {
    return { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN };
  }
  const results: Record<string, number> = {};
  for (const [name, target] of Object.entries(event.targets ?? {})) {
    const url = new URL(target);
    const req = await signer.sign({ method: 'POST', protocol: url.protocol, hostname: url.hostname, path: url.pathname, headers: { host: url.host }, body: '{}' });
    results[name] = (await fetch(url, { method: 'POST', headers: req.headers, body: '{}' })).status;
  }
  return results;
};
