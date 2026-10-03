import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { TAG_PURPOSE as PURPOSE_TAG, TAG_REQUEST_ID as REQUEST_ID_TAG, TAG_SCOPE as SCOPE_TAG, type CallerEntry, type Provides, type Target } from '@gekko08/authz-context/types';
import { Construct } from 'constructs';
import { enableTelemetry, NodeFunction, type NodeFunctionProps } from './node-function';

// session tagのキーは、刻む側（bff）と読む側（共通部品の検証）と同じ値を使う
export { PURPOSE_TAG, REQUEST_ID_TAG };

/** 初期の信頼ポリシーに何も加えないprincipal */
class TrustAddedLater extends iam.ArnPrincipal {
  constructor() {
    super('*');
  }

  override addToAssumeRolePolicy(_doc: iam.PolicyDocument): void {}
}

/** 呼び出し先の設定。共通部品が読む形（`Target`）のまま、環境変数とbffの設定に書く */
export type HopTarget = Target;

/** 呼び出し元がこのホップ宛てのJWTに付けられるscope */
export interface DelegatedScope {
  scope: string;
  /** このscopeを付けられるリクエストの目的。省くと、どのリクエストでも付けられる */
  purposes?: string[];
}

/** 他のホップを呼ぶ側。bffも、目的を刻むroleをchain用roleとして同じ形で扱う */
export interface HopCaller {
  readonly hopName: string;
  readonly execRole: iam.IRole;
  readonly fn: lambda.IFunction;
  /** 次のホップ宛てのJWTを作るセッションのrole（bffでは目的を刻むrole） */
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
  memorySize?: number;
  bundling?: NodeFunctionProps['bundling'];
}

/**
 * ホップ1つ分：Lambda関数（専用の実行role）、Function URL（AWS_IAM）、入口のresource policy、必要ならchain用role。
 * 呼び出し関係は、`connectHops`が委任の範囲の定義を突き合わせてから、`allowCaller`でつなぐ。
 */
export class Hop extends Construct {
  readonly hopName: string;
  readonly fn: NodeFunction;
  readonly url: lambda.FunctionUrl;
  readonly audience: string;
  readonly execRole: iam.IRole;
  readonly chainRole?: iam.Role;

  private readonly callerRoles: iam.IRole[] = [];
  /** 呼び出し元の実行roleごとの、許可する呼び出し元の関数 */
  private readonly callerFunctions = new Map<iam.IRole, lambda.IFunction[]>();
  private readonly callers: Record<string, CallerEntry> = {};
  private readonly targets: Record<string, HopTarget> = {};
  private provides: Provides = {};

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
      ...(props.memorySize ? { memorySize: props.memorySize } : {}),
      ...(props.bundling ? { bundling: props.bundling } : {}),
      environment: {
        HOP_NAME: props.hopName,
        HOP_AUDIENCE: this.audience,
        AUTHZ_ISSUER: props.issuer,
        AUTHZ_CALLERS: cdk.Lazy.string({ produce: () => stack.toJsonString(this.callers) }),
        AUTHZ_PROVIDES: cdk.Lazy.string({ produce: () => stack.toJsonString(this.provides) }),
        AUTHZ_TARGETS: cdk.Lazy.string({ produce: () => stack.toJsonString(this.targets) }),
        ...(this.chainRole ? { AUTHZ_CHAIN_ROLE: this.chainRole.roleArn } : {}),
        ...props.environment,
      },
    });
    this.execRole = this.fn.role!;
    enableTelemetry(this.fn);
    this.url = this.fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    const actions = ['lambda:InvokeFunctionUrl', 'lambda:InvokeFunction'];
    const roleArns = cdk.Lazy.list({ produce: () => this.callerRoles.map((r) => r.roleArn) });
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
          // 同じ実行roleを持つ別の関数からの呼び出しは、呼び出し元の実行roleのDenyで塞ぐ（allowCaller）。
          // lambda:SourceFunctionArnはresource-based policyでは使えない（source-function-arnのADR）
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

  /** 提供側の定義を、受信時の照合に使う設定として渡す（設計書§6） */
  provide(provides: Provides): void {
    this.provides = provides;
  }

  /**
   * callerからこのホップへの呼び出しを許す。入口、JWTの`sub`の対応、chainとJWTの発行の権限、委任の範囲（scopeと、目的の制限）を
   * まとめて設定する。組ごとに1回だけ呼ぶ（`connectHops`が、委任の範囲の定義を突き合わせてから呼ぶ）
   */
  allowCaller(caller: HopCaller, scopes: DelegatedScope[]): void {
    if (this.callers[caller.execRole.roleName]) {
      throw new Error(`${caller.hopName} is already allowed to call ${this.hopName}`);
    }
    if (scopes.length === 0) throw new Error(`${caller.hopName} -> ${this.hopName}: no scopes`);
    this.callerRoles.push(caller.execRole);
    this.guardCallerFunction(caller);
    this.callers[caller.execRole.roleName] = { hop: caller.hopName, sub: caller.chainRole.roleArn };

    // ForAnyValueでは、許した宛先に外部の宛先を混ぜたJWTを発行できる（experiments/scope-tagsのE1-7）
    const onlyThisAudience = {
      'ForAllValues:StringEquals': { 'sts:IdentityTokenAudience': [this.audience] },
      Null: { 'sts:IdentityTokenAudience': 'false' },
    };
    const tagConditions = (stringEquals: Record<string, unknown>) => ({
      'ForAllValues:StringEquals': { ...onlyThisAudience['ForAllValues:StringEquals'], 'aws:TagKeys': [SCOPE_TAG] },
      Null: onlyThisAudience.Null,
      StringEquals: stringEquals,
    });
    // callerのchain用roleは、このホップ宛てのJWTを、共通部品が発行する形（ES384、有効期間300秒以下）で発行できる
    caller.chainRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['sts:GetWebIdentityToken'],
      resources: ['*'],
      conditions: {
        ...onlyThisAudience,
        StringEquals: { 'sts:SigningAlgorithm': 'ES384' },
        NumericLessThanEquals: { 'sts:DurationSeconds': 300 },
      },
    }));
    // 付けられるのは、宣言したscopeだけ。目的の制限がないscopeは1つの文に、目的の制限があるscopeは、許した目的のリクエストでだけ付けられる文にする
    // （experiments/scope-tagsのE4）
    const open = scopes.filter((s) => !s.purposes).map((s) => s.scope);
    if (open.length > 0) {
      caller.chainRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['sts:TagGetWebIdentityToken'], resources: ['*'], conditions: tagConditions({ [`aws:RequestTag/${SCOPE_TAG}`]: open }),
      }));
    }
    for (const s of scopes.filter((x) => x.purposes)) {
      caller.chainRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['sts:TagGetWebIdentityToken'], resources: ['*'],
        conditions: tagConditions({ [`aws:RequestTag/${SCOPE_TAG}`]: s.scope, [`aws:PrincipalTag/${PURPOSE_TAG}`]: s.purposes }),
      }));
    }

    if (this.chainRole) {
      const principal = new iam.ArnPrincipal(caller.chainRole.roleArn);
      this.chainRole.assumeRolePolicy!.addStatements(
        // セッション名は、bffが刻んだリクエストIDに限る。途中のホップは、CloudTrailで引くリクエストIDを変えられない（FR-6）
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'], principals: [principal],
          conditions: { StringEquals: { 'sts:RoleSessionName': `\${aws:PrincipalTag/${REQUEST_ID_TAG}}` } },
        }),
        new iam.PolicyStatement({ actions: ['sts:SetSourceIdentity'], principals: [principal] }),
        // 新しいtagのキーは加えられない（FR-3）
        new iam.PolicyStatement({
          actions: ['sts:TagSession'], principals: [principal],
          conditions: { 'ForAllValues:StringEquals': { 'aws:TagKeys': [PURPOSE_TAG, REQUEST_ID_TAG] } },
        }),
      );
      caller.chainRole.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity'],
        resources: [this.chainRole.roleArn],
      }));
    }

    caller.addTarget(this.hopName, { url: this.url.url, audience: this.audience, scopes: scopes.map((s) => s.scope), forwardSession: !!this.chainRole });
  }

  /**
   * 呼び出し元の実行roleに、「このホップを、許可した呼び出し元の関数以外から呼ぶ」ことをDenyする文を持たせる（SR-2）。
   * 同じアカウントでは入口のresource policyの許可だけで呼べるので、許可の条件ではなくDenyにする。実行roleを共有する関数は、まとめて条件に並べる。
   * roleの既定のポリシーとは別のポリシーにして、関数がこのポリシーに依存しないようにする（循環参照を避ける）
   */
  private guardCallerFunction(caller: HopCaller): void {
    const fns = this.callerFunctions.get(caller.execRole);
    if (fns) {
      fns.push(caller.fn);
      return;
    }
    const allowed = [caller.fn];
    this.callerFunctions.set(caller.execRole, allowed);
    new iam.Policy(this, `CallerFunctionGuard${this.callerFunctions.size}`, {
      roles: [caller.execRole],
      statements: [new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ['lambda:InvokeFunctionUrl', 'lambda:InvokeFunction'],
        resources: [this.fn.functionArn],
        conditions: { ArnNotEquals: { 'lambda:SourceFunctionArn': cdk.Lazy.list({ produce: () => allowed.map((f) => f.functionArn) }) } },
      })],
    });
  }

}
