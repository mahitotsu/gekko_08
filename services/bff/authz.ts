import type { DelegationDefinition } from '@gekko08/authz-context';

/**
 * 取引の目的の一覧（設計書§4）。bffが経路ごとに決めて刻む。取引の種類として少数に保ち、画面を増やしても既存の目的で足りるなら増やさない。
 * 目的は、提供側が影響の大きいscopeの発行を限るためだけに使い、業務のコードは使わない
 */
export const PURPOSES = {
  /** ログイン中のユーザーの表示 */
  profile: 'profile',
  /** 案件を開く */
  caseSummary: 'case-summary',
  /** 凍結を解除する */
  accountUnfreeze: 'account-unfreeze',
  /** エージェントによる分析 */
  agentAnalysis: 'agent-analysis',
} as const;

export const authz: DelegationDefinition = {
  hop: 'bff',
  consumes: {
    'entitlement-service': ['entitlements:read'],
    'case-service': ['case:summary', 'case:unfreeze'],
    'fraud-agent': ['agent:analyze'],
  },
};
