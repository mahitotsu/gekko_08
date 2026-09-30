import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { NodeFunction } from './node-function';

/** JWTに刻まれ、chainで引き継ぐ業務属性のキー */
export const TAG_KEYS = ['branch'];

/** 初期の信頼ポリシーに何も加えないprincipal */
class TrustAddedLater extends iam.ArnPrincipal {
  constructor() {
    super('*');
  }

  addToAssumeRolePolicy(_doc: iam.PolicyDocument): void {}
}

export interface HopTarget {
  url: string;
  audience: string;
  forwardSession: boolean;
}

/** 他のホップを呼ぶ側。bffも、federated roleをchain用roleとして同じ形で扱う */
export interface HopCaller {
  readonly hopName: string;
  readonly execRole: iam.IRole;
  readonly fn: lambda.IFunction;
  /** 次のホップ宛てのJWTを作るセッションのrole（bffではfederated role） */
  readonly chainRole: iam.Role;
  addTarget(name: string, target: HopTarget): void;
}

export interface HopProps {
  hopName: string;
  entry: string;
  issuer: string;
  /** 他のホップを呼ぶか。呼ぶならchain用roleを持つ */
  callsOthers: boolean;
  environment?: Record<string, string>;
  timeout?: cdk.Duration;
}

/**
 * ホップ1つ分：Lambda関数（専用の実行role）、Function URL（AWS_IAM）、入口のresource policy、必要ならchain用role。
 * 呼び出し関係は`allowCaller`でつなぐ。
 */
export class Hop extends Construct {
  readonly hopName: string;
  readonly fn: NodeFunction;
  readonly url: lambda.FunctionUrl;
  readonly audience: string;
  readonly execRole: iam.IRole;
  readonly chainRole?: iam.Role;

  private readonly callerRoles: iam.IRole[] = [];
  private readonly callerFunctions: lambda.IFunction[] = [];
  private readonly expectedSubs: Record<string, string> = {};
  private readonly targets: Record<string, HopTarget> = {};

  constructor(scope: Construct, id: string, props: HopProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    this.hopName = props.hopName;
    this.audience = `${stack.stackName}:${props.hopName}`;

    if (props.callsOthers) {
      // chainと、許された宛先のJWTの発行だけを持つ。ホップの呼び出し権限もデータの権限も持たない
      // 信頼は空で作り、allowCallerで呼び出し元のchain用roleを加える
      this.chainRole = new iam.Role(this, 'ChainRole', {
        assumedBy: new TrustAddedLater(),
        description: `${props.hopName}: chain role (issues JWTs for next hops only)`,
      });
    }

    this.fn = new NodeFunction(this, 'Function', {
      entry: props.entry,
      description: `${props.hopName} hop`,
      timeout: props.timeout,
      environment: {
        HOP_NAME: props.hopName,
        HOP_AUDIENCE: this.audience,
        AUTHZ_ISSUER: props.issuer,
        AUTHZ_CALLERS: cdk.Lazy.string({ produce: () => stack.toJsonString(this.expectedSubs) }),
        AUTHZ_TARGETS: cdk.Lazy.string({ produce: () => stack.toJsonString(this.targets) }),
        ...(this.chainRole ? { AUTHZ_CHAIN_ROLE: this.chainRole.roleArn } : {}),
        ...props.environment,
      },
    });
    this.execRole = this.fn.role!;
    this.url = this.fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    const actions = ['lambda:InvokeFunctionUrl', 'lambda:InvokeFunction'];
    const roleArns = cdk.Lazy.list({ produce: () => this.callerRoles.map((r) => r.roleArn) });
    const fnArns = cdk.Lazy.list({ produce: () => this.callerFunctions.map((f) => f.functionArn) });
    new lambda.CfnResourcePolicy(this, 'EntryPolicy', {
      resourceArn: this.fn.functionArn,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          // 同じアカウントの広いidentity policyによる呼び出しを塞ぐ（SR-2）
          {
            Sid: 'DenyOtherPrincipals', Effect: 'Deny', Principal: '*', Action: actions, Resource: this.fn.functionArn,
            Condition: { ArnNotEquals: { 'aws:PrincipalArn': roleArns } },
          },
          // 同じ実行roleを持つ別の関数からの呼び出しを塞ぐ
          {
            Sid: 'DenyOtherFunctions', Effect: 'Deny', Principal: '*', Action: actions, Resource: this.fn.functionArn,
            Condition: { ArnNotEquals: { 'lambda:SourceFunctionArn': fnArns } },
          },
          {
            Sid: 'AllowUrl', Effect: 'Allow', Principal: { AWS: roleArns }, Action: 'lambda:InvokeFunctionUrl', Resource: this.fn.functionArn,
            Condition: { StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } },
          },
          {
            Sid: 'AllowInvoke', Effect: 'Allow', Principal: { AWS: roleArns }, Action: 'lambda:InvokeFunction', Resource: this.fn.functionArn,
            Condition: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
          },
        ],
      },
    });

    this.node.addValidation({
      validate: () => (this.callerRoles.length === 0 ? [`${props.hopName} has no callers`] : []),
    });
  }

  /** このホップを、他のホップの呼び出し元として扱う */
  asCaller(): HopCaller {
    if (!this.chainRole) throw new Error(`${this.hopName} does not call other hops`);
    return {
      hopName: this.hopName,
      execRole: this.execRole,
      fn: this.fn,
      chainRole: this.chainRole,
      addTarget: (name, target) => { this.targets[name] = target; },
    };
  }

  /** callerからこのホップへの呼び出しを許す。入口、JWTの`sub`の対応、chainとJWTの発行の権限をまとめて設定する */
  allowCaller(caller: HopCaller): void {
    this.callerRoles.push(caller.execRole);
    this.callerFunctions.push(caller.fn);
    this.expectedSubs[caller.execRole.roleName] = caller.chainRole.roleArn;

    // callerのchain用roleは、このホップ宛てのJWTだけを発行できる
    caller.chainRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['sts:GetWebIdentityToken'],
      resources: ['*'],
      conditions: {
        'ForAnyValue:StringEquals': { 'sts:IdentityTokenAudience': [this.audience] },
        StringEquals: { 'sts:SigningAlgorithm': 'ES384' },
      },
    }));

    if (this.chainRole) {
      const principal = new iam.ArnPrincipal(caller.chainRole.roleArn);
      this.chainRole.assumeRolePolicy!.addStatements(
        new iam.PolicyStatement({ actions: ['sts:AssumeRole', 'sts:SetSourceIdentity'], principals: [principal] }),
        // 新しいtagのキーは加えられない（FR-3）
        new iam.PolicyStatement({
          actions: ['sts:TagSession'], principals: [principal],
          conditions: { 'ForAllValues:StringEquals': { 'aws:TagKeys': TAG_KEYS } },
        }),
      );
      caller.chainRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'],
        resources: [this.chainRole.roleArn],
      }));
    }

    caller.addTarget(this.hopName, { url: this.url.url, audience: this.audience, forwardSession: !!this.chainRole });
  }
}
