import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { NodeFunction } from './node-function';

/** デプロイ時にIAMのアウトバウンドIDフェデレーションが有効かを確かめ、JWTの発行者URLを取得する（設計書§11） */
export class OutboundFederationCheck extends Construct {
  readonly issuer: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    const onEvent = new NodeFunction(this, 'Handler', {
      entry: 'infra/lib/handlers/outbound-federation-check.ts',
      memorySize: 256,
      timeout: cdk.Duration.minutes(1),
    });
    onEvent.addToRolePolicy(new iam.PolicyStatement({ actions: ['iam:GetOutboundWebIdentityFederationInfo'], resources: ['*'] }));
    const resource = new cdk.CustomResource(this, 'Resource', {
      serviceToken: new cr.Provider(this, 'Provider', { onEventHandler: onEvent }).serviceToken,
    });
    this.issuer = resource.getAttString('Issuer');
  }
}
