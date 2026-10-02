/** 業務のコードに渡す、検証済みのユーザー（誰の代理か）。業務上のアクセス権は含まない（属性サービスから得る） */
export interface Subject {
  /** ユーザー識別子（STSセッションのSourceIdentity） */
  id: string;
}

/** STSセッションの認証情報。ログや応答に出さない。 */
export interface SessionCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** 呼び出し先のホップ。 */
export interface Target {
  url: string;
  audience: string;
  /** JWTに付けられるscope（利用側の定義）。IAMがこれ以外を付けさせず、目的の制限があるscopeは許された目的のリクエストでだけ付けさせる */
  scopes: string[];
  /** 呼び出し先がchain用roleを持ち、chainのセッションを受け取るか */
  forwardSession: boolean;
}

/** 提供側の定義の、scopeごとの制限。制限のないscopeは、どのリクエストでも、許された呼び出し元なら使える */
export interface ScopeRule {
  /** このscopeを使ってよいリクエストの目的 */
  purposes?: string[];
  /** このscopeを使ってよい呼び出し元のホップ */
  callers?: string[];
}

/** 提供側の定義：提供するscopeと、その制限 */
export type Provides = Record<string, ScopeRule>;

/** サービスごとの委任の範囲の定義（`services/<名前>/authz.ts`。設計書§4） */
export interface DelegationDefinition {
  hop: string;
  /** 提供するscope */
  provides?: Provides;
  /** 呼び出し先ごとに、付けたいscope */
  consumes?: Record<string, string[]>;
}

export interface CallResult {
  status: number;
  body: unknown;
}

export const HEADER_CONTEXT = 'x-authz-context';
export const HEADER_SESSION = 'x-authz-session';
export const HEADER_REQUEST_ID = 'x-request-id';
