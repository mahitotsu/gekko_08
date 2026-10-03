import type { DelegationDefinition } from '@gekko08/authz-context/types';

// 委任の範囲の定義（設計書§4）
export const authz: DelegationDefinition = {
  hop: 'fraud-agent',
  provides: { 'agent:analyze': {} },
  consumes: { 'fraud-mcp': ['mcp:tools'] },
};
