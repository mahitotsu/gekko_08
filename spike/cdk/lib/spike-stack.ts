import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

// 検証1: Lambda からの GetWebIdentityToken / 検証2: Function URL AWS_IAM + resource-based policy
export class SpikeStack extends cdk.Stack {
  public readonly receiver: lambda.Function;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    cdk.Tags.of(this).add('spike', 'gekko08');

    const runtime = lambda.Runtime.PYTHON_3_13;

    const receiver = new lambda.Function(this, 'Receiver', {
      runtime,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/receiver'),
    });
    this.receiver = receiver;
    const url = receiver.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    const mkCaller = (name: string) => {
      const fn = new lambda.Function(this, name, {
        runtime,
        handler: 'index.handler',
        code: lambda.Code.fromAsset('lambda/caller'),
        timeout: cdk.Duration.seconds(30),
      });
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['sts:GetWebIdentityToken'],
        resources: ['*'],
        conditions: { 'ForAnyValue:StringEquals': { 'sts:IdentityTokenAudience': ['https://spike.example'] } },
      }));
      return fn;
    };
    const allowed = mkCaller('CallerAllowed');
    const denied = mkCaller('CallerDenied');

    // 受信側 resource-based policy のみで許可（呼び出し元の identity policy には何も付けない）
    receiver.addPermission('AllowCaller', {
      principal: allowed.role!,
      action: 'lambda:InvokeFunctionUrl',
      functionUrlAuthType: lambda.FunctionUrlAuthType.AWS_IAM,
    });
    receiver.addPermission('AllowCallerInvoke', {
      principal: allowed.role!,
      action: 'lambda:InvokeFunction',
      invokedViaFunctionUrl: true,
    });

    new cdk.CfnOutput(this, 'ReceiverUrl', { value: url.url });
    new cdk.CfnOutput(this, 'AllowedFn', { value: allowed.functionName });
    new cdk.CfnOutput(this, 'DeniedFn', { value: denied.functionName });
  }
}
