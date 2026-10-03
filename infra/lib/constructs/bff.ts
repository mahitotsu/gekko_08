import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import type { AuthFoundation } from './auth-foundation';
import { PURPOSE_TAG, REQUEST_ID_TAG, type HopCaller, type HopTarget } from './hop';
import { enableTelemetry, NodeFunction } from './node-function';

/**
 * 入口のBFF：Lambda関数、Function URL（AWS_IAM、CloudFrontのOACからだけ呼ぶ）、セッションのテーブル。
 * 設定とシークレットはSSM Parameter Storeに置き、実行時に読む。
 */
export class Bff extends Construct {
  readonly fn: NodeFunction;
  readonly url: lambda.FunctionUrl;
  readonly sessions: dynamodb.Table;
  private readonly configParamName: string;
  private readonly secretParamName: string;
  private readonly targets: Record<string, HopTarget> = {};
  private purposeRole?: iam.Role;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    this.configParamName = `/${stack.stackName}/bff/config`;
    this.secretParamName = `/${stack.stackName}/bff/client-secret`;

    this.sessions = new dynamodb.Table(this, 'Sessions', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.fn = new NodeFunction(this, 'Function', {
      entry: 'services/bff/src/index.ts',
      description: 'bff: login, session, and the first hop',
      // エージェントの経路はモデルを複数回呼ぶ。CloudFrontのオリジンの応答待ち（60秒）に合わせる
      timeout: cdk.Duration.seconds(60),
      environment: {
        SESSIONS_TABLE: this.sessions.tableName,
        BFF_CONFIG_PARAM: this.configParamName,
        BFF_SECRET_PARAM: this.secretParamName,
      },
    });
    this.sessions.grantReadWriteData(this.fn);
    enableTelemetry(this.fn);
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [this.configParamName, this.secretParamName].map((n) => stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: n.slice(1) })),
    }));
    this.url = this.fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
  }

  /**
   * 目的を刻むroleを作り、federated roleとつなぐ。bffはリクエストごとにfederated roleのセッションからこのroleへchainし、
   * リクエストの目的とリクエストIDをtransitive session tagとして刻む。刻める目的はpurposesに限る。
   * セッション名はリクエストIDのtagと同じ値に限り、以降のchainもその値に縛る（FR-6）。
   * 引き受けられるのは、このUser PoolのIdPで認証されたfederated roleのセッションだけ（`aws:FederatedProvider`）。
   * JWTには元のIdPが残らないので、IdPを実行時に確かめられるのはここだけである
   */
  connect(auth: AuthFoundation, purposes: string[]): void {
    const principal = new iam.ArnPrincipal(auth.federatedRole.roleArn);
    this.purposeRole = new iam.Role(this, 'PurposeRole', {
      assumedBy: principal.withConditions({
        StringEquals: { 'sts:RoleSessionName': `\${aws:RequestTag/${REQUEST_ID_TAG}}`, 'aws:FederatedProvider': auth.oidcProviderArn },
      }),
      description: 'bff: stamps the transaction purpose and request ID as transitive session tags',
    });
    this.purposeRole.assumeRolePolicy!.addStatements(
      new iam.PolicyStatement({ actions: ['sts:SetSourceIdentity'], principals: [principal] }),
      new iam.PolicyStatement({
        actions: ['sts:TagSession'], principals: [principal],
        conditions: {
          'ForAllValues:StringEquals': { 'aws:TagKeys': [PURPOSE_TAG, REQUEST_ID_TAG] },
          StringEquals: { [`aws:RequestTag/${PURPOSE_TAG}`]: purposes },
        },
      }),
    );
    auth.federatedRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'],
      resources: [this.purposeRole.roleArn],
    }));
  }

  /** 目的を刻むroleを最初のホップ宛てのJWTを作るroleとして、bffをホップの呼び出し元として扱う */
  asCaller(): HopCaller {
    if (!this.purposeRole) throw new Error('call connect() first');
    return {
      hopName: 'bff',
      execRole: this.fn.role!,
      fn: this.fn,
      chainRole: this.purposeRole,
      addTarget: (name, target) => { this.targets[name] = target; },
    };
  }

  /** 設定とシークレットをSSM Parameter Storeに書く。CloudFront・Cognitoと循環参照にならないよう、関数とは別に作る */
  writeSettings(auth: AuthFoundation, redirectUri: string, logoutUri: string): void {
    const stack = cdk.Stack.of(this);
    new ssm.StringParameter(this, 'Config', {
      parameterName: this.configParamName,
      stringValue: cdk.Lazy.string({
        produce: () => stack.toJsonString({
          clientId: auth.client.userPoolClientId,
          authDomain: auth.authDomain,
          redirectUri,
          logoutUri,
          federatedRoleArn: auth.federatedRole.roleArn,
          purposeRoleArn: this.purposeRole!.roleArn,
          targets: this.targets,
        }),
      }),
    });

    const onEvent = new NodeFunction(this, 'ClientSecretHandler', {
      entry: 'infra/lib/handlers/client-secret-parameter.ts',
      memorySize: 256,
      timeout: cdk.Duration.minutes(1),
    });
    onEvent.addToRolePolicy(new iam.PolicyStatement({ actions: ['cognito-idp:DescribeUserPoolClient'], resources: [auth.userPool.userPoolArn] }));
    onEvent.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
      resources: [stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: this.secretParamName.slice(1) })],
    }));
    new cdk.CustomResource(this, 'ClientSecret', {
      serviceToken: new cr.Provider(this, 'ClientSecretProvider', { onEventHandler: onEvent }).serviceToken,
      properties: { UserPoolId: auth.userPool.userPoolId, ClientId: auth.client.userPoolClientId, ParameterName: this.secretParamName },
    });
  }
}
