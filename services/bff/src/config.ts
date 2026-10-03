import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { requireEnv, traceAwsClient, type Target } from '@gekko08/authz-context';

/** デプロイ時にSSM Parameter Storeへ書く設定。CloudFrontとCognitoの循環参照を避けるため、環境変数ではなく実行時に読む */
export interface BffConfig {
  clientId: string;
  /** Cognitoのマネージドログインのドメイン（https://...） */
  authDomain: string;
  redirectUri: string;
  /** ログアウトのあとにCognitoが戻す先（アプリクライアントの`logoutUrls`） */
  logoutUri: string;
  federatedRoleArn: string;
  /** リクエストの目的を刻むrole */
  purposeRoleArn: string;
  targets: Record<string, Target>;
}

export interface Settings {
  config: BffConfig;
  /** アプリクライアントのシークレット */
  secret: string;
}

/** 設定とシークレットを読む。関数の初期化のときに1回だけ呼ぶ（index.tsのtop-level await） */
export async function loadSettings(): Promise<Settings> {
  const ssm = traceAwsClient(new SSMClient({}));
  const [c, s] = await Promise.all([
    ssm.send(new GetParameterCommand({ Name: requireEnv('BFF_CONFIG_PARAM') })),
    ssm.send(new GetParameterCommand({ Name: requireEnv('BFF_SECRET_PARAM'), WithDecryption: true })),
  ]);
  if (!c.Parameter?.Value || !s.Parameter?.Value) throw new Error('bff settings are empty');
  return { config: JSON.parse(c.Parameter.Value) as BffConfig, secret: s.Parameter.Value };
}
