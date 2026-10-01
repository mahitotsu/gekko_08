import type { DelegationDefinition } from '@gekko08/authz-context';

// 委任の範囲の定義（設計書§4）
export const authz: DelegationDefinition = {
  hop: 'case-service',
  provides: {
    'case:summary': {},
    'case:read': {},
    // 凍結の解除の依頼は、凍結を解除する取引でだけ
    'case:unfreeze': { purposes: ['account-unfreeze'] },
  },
  consumes: {
    'account-service': ['account:read', 'account:unfreeze'],
    'entitlement-service': ['entitlements:read'],
  },
};
