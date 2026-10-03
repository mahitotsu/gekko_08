import { AssumeRoleCommand, AssumeRoleWithWebIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { createCaller, sessionFromSts, stsWith, timed, traceAwsClient, type Call, type Timings } from '@gekko08/authz-context';
import { TAG_PURPOSE, TAG_REQUEST_ID } from '@gekko08/authz-context';
import type { BffConfig } from './config';

const sts = traceAwsClient(new STSClient({}));

/**
 * ログイン中のユーザーの代理で、リクエストの目的を刻んだセッションを作り、最初のホップを呼ぶ関数を返す。STSの認証情報はどこにも保存しない
 * 1. IDトークンでfederated roleのセッションを得る（SourceIdentity＝ユーザー識別子）
 * 2. 目的を刻むroleへchainし、目的とリクエストIDをtransitive session tagとして刻む。以降のホップは目的もリクエストIDも変えられない（FR-6）
 */
export async function stampRequest(config: BffConfig, idToken: string, requestId: string, purpose: string, timings: Timings): Promise<Call> {
  const fed = await timed(timings, 'assumeMs', () => sts.send(new AssumeRoleWithWebIdentityCommand({
    RoleArn: config.federatedRoleArn,
    RoleSessionName: requestId,
    WebIdentityToken: idToken,
    DurationSeconds: 900,
  })), 'assume (sts:AssumeRoleWithWebIdentity)');
  const stamped = await timed(timings, 'purposeMs', () => stsWith(sessionFromSts(fed.Credentials)).send(new AssumeRoleCommand({
    RoleArn: config.purposeRoleArn,
    RoleSessionName: requestId,
    DurationSeconds: 900,
    Tags: [{ Key: TAG_PURPOSE, Value: purpose }, { Key: TAG_REQUEST_ID, Value: requestId }],
    TransitiveTagKeys: [TAG_PURPOSE, TAG_REQUEST_ID],
  })), 'stamp purpose (sts:AssumeRole)');
  return createCaller({ session: sessionFromSts(stamped.Credentials), requestId, targets: config.targets, timings });
}
