import type { DelegationDefinition } from '@gekko08/authz-context';

// 委任の範囲の定義（設計書§4）
export const authz: DelegationDefinition = {
  hop: 'audit-service',
  provides: { 'audit:read': {} },
  consumes: { 'entitlement-service': ['entitlements:read'] },
};
