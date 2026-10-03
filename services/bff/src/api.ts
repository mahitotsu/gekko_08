// bffがブラウザに返す本文の型。画面（web）とシナリオテストもこの型を参照する。
// ホップの応答に、bffが`requestId`と`purpose`を加える（表示用。ブラウザから目的は受け取らない）

/** `/api/me`の本文 */
export interface Me {
  username: string;
  /** 所属と役職は属性サービス（人事データ）から得たもの。トークンには入れていない */
  branch?: string;
  title?: string;
}

/** `/api/logout`の本文 */
export interface LogoutBody {
  loggedOut: true;
  /** Cognitoのマネージドログインのログアウト。ブラウザをここに送り、Cognitoのログインの状態も消す */
  logoutUrl: string;
}

/** 案件の取引 */
export interface CaseTransaction {
  date: string;
  amount: number;
  memo: string;
}

/** 案件（case-serviceの応答） */
export interface Case {
  caseId: string;
  branch: string;
  accountId: string;
  title: string;
  transactions: CaseTransaction[];
}

/** 口座（account-serviceの応答） */
export interface Account {
  accountId: string;
  branch: string;
  holder: string;
  status: string;
  frozenReason?: string;
  /** 凍結を解除したユーザー、日時、リクエストID（account-serviceが解除のときに記録する） */
  unfrozenBy?: string;
  unfrozenAt?: string;
  unfreezeRequestId?: string;
}

/** エージェントのツールの呼び出しの記録（fraud-agentの応答） */
export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  /** 呼び出し先のホップが返したHTTPステータス */
  status: number;
  /** 呼び出し先のホップが拒否したときの理由 */
  reason?: string;
}

/** 拒否や失敗の本文 */
export interface ErrorBody {
  error?: string;
  /** ホップが拒否したときの理由（ホップのコードが決める固定の文字列） */
  reason?: string;
}

/** bffが、ホップの応答に加える項目 */
export interface Stamped {
  /** bffがこのリクエストに付けたリクエストID */
  requestId: string;
  /** bffが刻んだリクエストの目的 */
  purpose: string;
}

/** 案件、凍結の解除、エージェントの経路の本文 */
export interface HopBody extends ErrorBody, Partial<Stamped> {
  case?: Case;
  account?: Account & ErrorBody;
  caseId?: string;
  analysis?: string;
  toolCalls?: ToolCall[];
}
