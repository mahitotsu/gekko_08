import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { NodeFunction } from './node-function';

/** 取引の目的を運ぶtransitive session tagのキー。chainで引き継ぎ、途中で変えられない */
export const PURPOSE_TAG = 'purpose';

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
  scope: string;
  forwardSession: boolean;
}

/** 呼び出し元に許す委任の範囲 */
export interface Delegation {
  /** 呼び出し元がこのホップ宛てのJWTに付けるscope */
  scope: string;
  /** このホップ宛てのJWTを発行できる取引の目的 */
  purposes: string[];
}

/** 他のホップを呼ぶ側。bffも、目的用のroleをchain用roleとして同じ形で扱う */
export interface HopCaller {
  readonly hopName: string;
  readonly execRole: iam.IRole;
  readonly fn: lambda.IFunction;
  /** 次のホップ宛てのJWTを作るセッションのrole（bffでは目的用のrole） */
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
  private readonly callers: Record<string, { hop: string; sub: string }> = {};
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
      ...(props.timeout ? { timeout: props.timeout } : {}),
      environment: {
        HOP_NAME: props.hopName,
        HOP_AUDIENCE: this.audience,
        AUTHZ_ISSUER: props.issuer,
        AUTHZ_CALLERS: cdk.Lazy.string({ produce: () => stack.toJsonString(this.callers) }),
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

  /**
   * callerからこのホップへの呼び出しを許す。入口、JWTの`sub`の対応、chainとJWTの発行の権限、委任の範囲（scopeと目的）を
   * まとめて設定する
   */
  allowCaller(caller: HopCaller, delegation: Delegation): void {
    this.callerRoles.push(caller.execRole);
    this.callerFunctions.push(caller.fn);
    this.callers[caller.execRole.roleName] = { hop: caller.hopName, sub: caller.chainRole.roleArn };

    // ForAnyValueでは、許した宛先に外部の宛先を混ぜたJWTを発行できる（experiments/scope-tagsのE1-7）
    const onlyThisAudience = {
      'ForAllValues:StringEquals': { 'sts:IdentityTokenAudience': [this.audience] },
      Null: { 'sts:IdentityTokenAudience': 'false' },
    };
    // callerのchain用roleは、許された目的の取引でだけ、このホップ宛てのJWTを、共通部品が発行する形（ES384、有効期間300秒以下）で発行できる
    caller.chainRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['sts:GetWebIdentityToken'],
      resources: ['*'],
      conditions: {
        ...onlyThisAudience,
        StringEquals: { 'sts:SigningAlgorithm': 'ES384', [`aws:PrincipalTag/${PURPOSE_TAG}`]: delegation.purposes },
        NumericLessThanEquals: { 'sts:DurationSeconds': 300 },
      },
    }));
    // このホップ宛てのJWTに付けられるのは、宣言したscopeだけ
    caller.chainRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['sts:TagGetWebIdentityToken'],
      resources: ['*'],
      conditions: {
        'ForAllValues:StringEquals': { ...onlyThisAudience['ForAllValues:StringEquals'], 'aws:TagKeys': ['scope'] },
        Null: onlyThisAudience.Null,
        StringEquals: { 'aws:RequestTag/scope': delegation.scope },
      },
    }));

    if (this.chainRole) {
      const principal = new iam.ArnPrincipal(caller.chainRole.roleArn);
      this.chainRole.assumeRolePolicy!.addStatements(
        new iam.PolicyStatement({ actions: ['sts:AssumeRole', 'sts:SetSourceIdentity'], principals: [principal] }),
        // 新しいtagのキーは加えられない（FR-3）
        new iam.PolicyStatement({
          actions: ['sts:TagSession'], principals: [principal],
          conditions: { 'ForAllValues:StringEquals': { 'aws:TagKeys': [PURPOSE_TAG] } },
        }),
      );
      caller.chainRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'],
        resources: [this.chainRole.roleArn],
      }));
    }

    caller.addTarget(this.hopName, { url: this.url.url, audience: this.audience, scope: delegation.scope, forwardSession: !!this.chainRole });
  }
}
