import type { DelegationDefinition } from '@gekko08/authz-context';

// 委任の範囲の定義（設計書§4）。口座の解除のscopeは求めない（ツールの`unfreeze_account`は、account-serviceに拒否される）
export const authz: DelegationDefinition = {
  hop: 'fraud-mcp',
  provides: { 'mcp:tools': {} },
  consumes: {
    'case-service': ['case:read'],
    'account-service': ['account:read'],
  },
};
