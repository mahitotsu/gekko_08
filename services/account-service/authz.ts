import type { DelegationDefinition } from '@gekko08/authz-context/types';

// 委任の範囲の定義（設計書§4）
export const authz: DelegationDefinition = {
  hop: 'account-service',
  provides: {
    'account:read': {},
    // 凍結の解除は、凍結を解除するリクエストで、case-serviceからだけ。案件を開くリクエストやエージェントのリクエストでは、case-serviceが侵害されても発行されない
    'account:unfreeze': { purposes: ['account-unfreeze'], callers: ['case-service'] },
  },
  consumes: {
    'entitlement-service': ['entitlements:read'],
  },
};
