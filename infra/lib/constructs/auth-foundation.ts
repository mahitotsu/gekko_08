import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { acknowledgeNag } from '../nag';
import { NodeFunction } from './node-function';

export interface AuthFoundationProps {
  /** bffの`/api/callback`のURL */
  callbackUrl: string;
  /** ログアウト後に戻るURL */
  logoutUrl: string;
}

/**
 * Cognito User Pool（Essentials、マネージドログイン）、Pre Token Generation V2、IAM OIDC provider、bffのfederated role。
 * IDトークンにはユーザー識別子（SourceIdentity）だけを刻む。業務上のアクセス権はトークンに入れない（委任の範囲と業務上のアクセス権のADR）。
 */
export class AuthFoundation extends Construct {
  readonly userPool: cognito.UserPool;
  readonly client: cognito.UserPoolClient;
  readonly authDomain: string;
  readonly federatedRole: iam.Role;
  /**
   * IDトークンの発行者（`https://`を除いたもの）。federated roleのセッションが次のroleを引き受ける要求の`aws:FederatedProvider`は、
   * OIDC providerのARNではなく、この値になる（experiments/federated-provider）
   */
  readonly oidcIssuer: string;

  constructor(scope: Construct, id: string, props: AuthFoundationProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);

    const pretoken = new NodeFunction(this, 'PreToken', { entry: 'services/pretoken/src/index.ts', memorySize: 256 });

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      // 使わない（業務属性は属性サービスが持つ）。User Poolのスキーマから属性を消せないため、既存の環境との互換のために定義だけを残す
      customAttributes: { branch: new cognito.StringAttribute({ mutable: true, minLen: 1, maxLen: 32 }) },
      passwordPolicy: { minLength: 12 },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.userPool.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG, pretoken, cognito.LambdaVersion.V2_0);
    // 本番での利用は想定しない（README）。デモのユーザーはテストとデモの手順が作る
    acknowledgeNag(this.userPool, 'パスワードは長さ（12文字以上）で決め、文字種の組み合わせは求めない（NIST SP 800-63B）', 'COG1');
    acknowledgeNag(this.userPool, 'デモのユーザーにMFAは求めない。本番での利用は想定しない（README）', 'COG2');
    acknowledgeNag(this.userPool, 'Plusの機能（脅威の防御）は使わない。本番での利用は想定しない（README）', 'COG8');

    const domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: cdk.Fn.join('-', ['gekko08', cdk.Fn.select(2, cdk.Fn.split('/', stack.stackId))]) },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    this.authDomain = domain.baseUrl();

    this.client = this.userPool.addClient('BffClient', {
      generateSecret: true,
      // ADMIN_USER_PASSWORD_AUTHはシナリオテストのログインに使う。呼ぶにはIAMの権限が要る
      authFlows: { adminUserPassword: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID],
        callbackUrls: [props.callbackUrl],
        logoutUrls: [props.logoutUrl],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      writeAttributes: new cognito.ClientAttributes(),
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      idTokenValidity: cdk.Duration.minutes(60),
      accessTokenValidity: cdk.Duration.minutes(60),
      refreshTokenValidity: cdk.Duration.hours(8),
    });
    new cognito.CfnManagedLoginBranding(this, 'Branding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.client.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    const issuer = `cognito-idp.${stack.region}.amazonaws.com/${this.userPool.userPoolId}`;
    this.oidcIssuer = issuer;
    const provider = new iam.OidcProviderNative(this, 'OidcProvider', {
      url: `https://${issuer}`,
      clientIds: [this.client.userPoolClientId],
    });
    const principal = new iam.FederatedPrincipal(provider.oidcProviderArn, {
      StringEquals: new cdk.CfnJson(this, 'AudCondition', { value: { [`${issuer}:aud`]: this.client.userPoolClientId } }),
    }, 'sts:AssumeRoleWithWebIdentity');
    this.federatedRole = new iam.Role(this, 'FederatedRole', {
      assumedBy: principal,
      maxSessionDuration: cdk.Duration.hours(1),
      description: 'bff: federated role carrying the user identity (SourceIdentity)',
    });
    // IDトークンにtagはないので、sts:TagSessionは許さない
    this.federatedRole.assumeRolePolicy!.addStatements(
      new iam.PolicyStatement({ actions: ['sts:SetSourceIdentity'], principals: [principal] }),
    );
  }
}
