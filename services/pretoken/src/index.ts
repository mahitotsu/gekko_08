import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';

// Pre Token Generation V2：IDトークンに、AssumeRoleWithWebIdentityが読む2つのクレームを入れる。
// ユーザー識別子（SourceIdentity）と業務属性（transitive session tag）は、ここで一度だけ確定する（FR-3）
export const handler = async (event: PreTokenGenerationV2TriggerEvent) => {
  const branch = event.request.userAttributes['custom:branch'];
  if (!branch) throw new Error('user has no branch');
  event.response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: {
        // 型定義は値を文字列に限るが、tagsのクレームはネストしたJSONで渡す
        claimsToAddOrOverride: {
          'https://aws.amazon.com/source_identity': event.userName,
          'https://aws.amazon.com/tags': { principal_tags: { branch: [branch] }, transitive_tag_keys: ['branch'] },
        } as unknown as Record<string, string>,
      },
    },
  };
  return event;
};
