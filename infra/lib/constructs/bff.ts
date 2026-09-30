import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import type { AuthFoundation } from './auth-foundation';
import type { HopCaller, HopTarget } from './hop';
import { NodeFunction } from './node-function';

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
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [this.configParamName, this.secretParamName].map((n) => stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: n.slice(1) })),
    }));
    this.url = this.fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
  }

  /** federated roleを最初のホップ宛てのJWTを作るroleとして、bffをホップの呼び出し元として扱う */
  asCaller(auth: AuthFoundation): HopCaller {
    return {
      hopName: 'bff',
      execRole: this.fn.role!,
      fn: this.fn,
      chainRole: auth.federatedRole,
      addTarget: (name, target) => { this.targets[name] = target; },
    };
  }

  /** 設定とシークレットをSSM Parameter Storeに書く。CloudFront・Cognitoと循環参照にならないよう、関数とは別に作る */
  writeSettings(auth: AuthFoundation, redirectUri: string): void {
    const stack = cdk.Stack.of(this);
    new ssm.StringParameter(this, 'Config', {
      parameterName: this.configParamName,
      stringValue: cdk.Lazy.string({
        produce: () => stack.toJsonString({
          clientId: auth.client.userPoolClientId,
          authDomain: auth.authDomain,
          redirectUri,
          federatedRoleArn: auth.federatedRole.roleArn,
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
