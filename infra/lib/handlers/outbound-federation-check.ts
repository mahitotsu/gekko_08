import { GetOutboundWebIdentityFederationInfoCommand, IAMClient } from '@aws-sdk/client-iam';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

const iam = new IAMClient({});

// デプロイ時に、IAMのアウトバウンドIDフェデレーションが有効かを確かめ、JWTの発行者URLを返す。
// アカウント全体の設定なので、自動では有効にしない
export const handler = async (event: CloudFormationCustomResourceEvent) => {
  if (event.RequestType === 'Delete') return { PhysicalResourceId: event.PhysicalResourceId };
  let info;
  try {
    info = await iam.send(new GetOutboundWebIdentityFederationInfoCommand({}));
  } catch (e) {
    throw new Error(`IAM outbound identity federation is not available (${(e as Error).name}). ` +
      'Enable it with `aws iam enable-outbound-web-identity-federation` and deploy again.');
  }
  if (!info.JwtVendingEnabled || !info.IssuerIdentifier) {
    throw new Error('IAM outbound identity federation is disabled for this account. ' +
      'Enable it with `aws iam enable-outbound-web-identity-federation` and deploy again.');
  }
  return { PhysicalResourceId: info.IssuerIdentifier, Data: { Issuer: info.IssuerIdentifier } };
};
