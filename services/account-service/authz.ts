import type { DelegationDefinition } from '@gekko08/authz-context';

// 委任の範囲の定義（設計書§4）
export const authz: DelegationDefinition = {
  hop: 'account-service',
  provides: {
    'account:read': {},
    // 凍結の解除は、凍結を解除する取引で、case-serviceからだけ。案件を開く取引やエージェントの取引では、case-serviceが侵害されても発行されない
    'account:unfreeze': { purposes: ['account-unfreeze'], callers: ['case-service'] },
  },
  consumes: {
    'entitlement-service': ['entitlements:read'],
  },
};
