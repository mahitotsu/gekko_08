import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';
import { requireEnv } from './env';

// 実行roleの認証情報と、サービスごとのSigV4の署名器。実行環境ごとに使い回す
const credentials = defaultProvider();
const signers = new Map<string, SignatureV4>();

/** 実行roleで署名する署名器（Function URLの呼び出しは`lambda`、トレースの送信は`xray`） */
export function execSigner(service: string): SignatureV4 {
  let signer = signers.get(service);
  if (!signer) {
    signer = new SignatureV4({ service, region: requireEnv('AWS_REGION'), credentials, sha256: Sha256 });
    signers.set(service, signer);
  }
  return signer;
}
