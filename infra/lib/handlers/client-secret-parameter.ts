import { CognitoIdentityProviderClient, DescribeUserPoolClientCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DeleteParameterCommand, ParameterNotFound, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

const cognito = new CognitoIdentityProviderClient({});
const ssm = new SSMClient({});

// アプリクライアントのシークレットをSSM Parameter StoreのSecureStringに書く。
// CloudFormationはSecureStringを作れず、テンプレートやログにシークレットを出さないため、カスタムリソースで行う
export const handler = async (event: CloudFormationCustomResourceEvent) => {
  const { UserPoolId, ClientId, ParameterName } = event.ResourceProperties as unknown as Record<string, string>;
  if (event.RequestType === 'Delete') {
    await ssm.send(new DeleteParameterCommand({ Name: ParameterName })).catch((e) => {
      if (!(e instanceof ParameterNotFound)) throw e;
    });
    return { PhysicalResourceId: event.PhysicalResourceId };
  }
  const { UserPoolClient } = await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId, ClientId }));
  await ssm.send(new PutParameterCommand({
    Name: ParameterName, Type: 'SecureString', Value: UserPoolClient!.ClientSecret!, Overwrite: true,
  }));
  return { PhysicalResourceId: ParameterName };
};
