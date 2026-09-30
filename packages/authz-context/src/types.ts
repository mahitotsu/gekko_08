/** 業務のコードに渡す、検証済みのユーザー（誰の代理か）。業務的なアクセス権は含まない（属性サービスから得る） */
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
  /** JWTに付けるscope。IAMが、呼び出し元と呼び出し先の組ごとに宣言した値だけを付けさせる */
  scope: string;
  /** 呼び出し先がchain用roleを持ち、chainのセッションを受け取るか */
  forwardSession: boolean;
}

export interface CallResult {
  status: number;
  body: unknown;
}

export const HEADER_CONTEXT = 'x-authz-context';
export const HEADER_SESSION = 'x-authz-session';
export const HEADER_REQUEST_ID = 'x-request-id';
