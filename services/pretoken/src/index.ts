import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';

// Pre Token Generation V2：IDトークンに、AssumeRoleWithWebIdentityがSourceIdentityとして読むユーザー識別子を入れる。
// ユーザー識別子はここで一度だけ確定する（FR-3）。業務属性はトークンに入れない（属性サービスが持つ）
export const handler = async (event: PreTokenGenerationV2TriggerEvent) => {
  event.response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: {
        claimsToAddOrOverride: { 'https://aws.amazon.com/source_identity': event.userName },
      },
    },
  };
  return event;
};
