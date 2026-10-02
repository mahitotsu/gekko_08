// 画面の表示用の対応表。判定には使わない（判定は各ホップが、検証済みの値と属性サービスの値だけで行う）

export const PURPOSE_LABELS: Record<string, string> = {
  profile: '本人の表示',
  audit: 'リクエストの監査',
  'case-summary': '案件を開く',
  'account-unfreeze': '凍結を解除する',
  'agent-analysis': 'エージェントによる分析',
};

export type Layer = 'delegation' | 'entitlement' | 'state';

export const LAYER_LABELS: Record<Layer, string> = {
  delegation: '委任の範囲',
  entitlement: '業務的なアクセス権',
  state: '業務の状態',
};

/** ホップが返す拒否の理由と、それを判定した層 */
export const REASONS: Record<string, { layer: Layer; text: string }> = {
  'scope does not allow the action': {
    layer: 'delegation',
    text: 'このリクエストで、この呼び出し元に許されたscopeに、この操作が含まれていない。scopeはIAMが強制し、リクエストの目的で上限が決まる',
  },
  'no entitlement': {
    layer: 'entitlement',
    text: '役職の権限に、この操作が含まれていない（属性サービスの権限マスタ）',
  },
  'branch mismatch': {
    layer: 'entitlement',
    text: '所属の支店と、データの支店が違う（属性サービスの人事データ）',
  },
  'unknown user': {
    layer: 'entitlement',
    text: '人事データに、このユーザーがいない（属性サービスの人事データ）',
  },
  'account is not frozen': {
    layer: 'state',
    text: '口座はすでに凍結されていない',
  },
};

export const BRANCH_LABELS: Record<string, string> = { tokyo: '東京支店', osaka: '大阪支店', honbu: '本部' };

/** bffの経路の名前 */
export const ROUTE_LABELS: Record<string, string> = {
  'case-summary': '案件を開く',
  'case-unfreeze': '凍結を解除',
  agent: 'エージェントに分析させる',
  'audit-list': '監査の一覧を開く',
  'audit-reconcile': 'リクエストを監査',
};

export const TOOL_LABELS: Record<string, string> = {
  get_case: '案件を取得',
  get_account: '口座を取得',
  unfreeze_account: '凍結を解除',
};
