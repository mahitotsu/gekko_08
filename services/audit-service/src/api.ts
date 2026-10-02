// 監査サービスの応答の型。画面（web）とシナリオテストもこの型を参照する。
// bffは、応答に自分の`requestId`（この監査の操作のリクエストID）と`purpose`を加える

/** 監査サービスが記録ごとに2つの記録を比べた結果 */
export type Check =
  | { result: 'match' }
  | { result: 'mismatch'; fields: string[] }
  | { result: 'pending' }
  | { result: 'n/a' };

/** 比べたAWSの記録（CloudTrailのイベント） */
export interface EventRef {
  event: string;
  /** CloudTrailのイベントID。CloudTrailのイベント履歴で同じイベントを引ける */
  eventId?: string;
  time: string;
}

/** 1つの項目について、アプリの記録の値とAWSの記録の値を比べた結果 */
export interface Field {
  name: string;
  app?: string;
  aws?: string;
  /** AWSの値を取り出したイベント。未着ならない */
  awsEvent?: EventRef;
  result: 'match' | 'mismatch' | 'pending';
}

/** 一覧の1件（bffが最初のホップを呼んだ1回の操作） */
export interface Transaction {
  time: string;
  requestId: string;
  route: string;
  purpose: string;
  user: string;
  status?: number;
  /** ログインのセッションの識別子（bffが作る。cookieとしては使えない） */
  sessionRef?: string;
  /** ログインした時刻（UNIX秒） */
  loggedInAt?: number;
  caseId?: string;
  /** 監査の操作なら、監査対象のリクエストID */
  auditTarget?: string;
}

export interface HopRecord {
  time: string;
  /** 処理を始めた時刻（ログを書いた時刻から処理時間を引いたもの） */
  startedAt?: string;
  /** 呼び出しの深さ（bffの呼び出し先が1） */
  depth: number;
  hop: string;
  outcome: 'handled' | 'rejected';
  actor?: string;
  /** JWTを発行した主体（JWTの`sub`のrole）の表示名 */
  tokenIssuer?: string;
  tokenId?: string;
  subject?: string;
  purpose?: string;
  scope?: string;
  status?: number;
  reason?: string;
  /** 拒否した呼び出しが、ヘッダーで名乗ったリクエストID。このリクエストのIDと違うときだけ持つ（JWTに刻まれた値はこのリクエストのもの） */
  claimedRequestId?: string;
  /** アプリの記録の情報源（このホップのロググループ） */
  logGroup?: string;
  /** `jti`と`webIdentityTokenId`で対応づけたAWSの記録（`GetWebIdentityToken`） */
  tokenEvent?: EventRef & { tokenId?: string };
  /** 項目ごとに、アプリの記録の値とAWSの記録の値を並べて比べた結果 */
  fields?: Field[];
  check: Check;
}

/** CloudTrailのイベントから、突き合わせに使う項目だけを取り出したもの */
export interface AwsRecord {
  time: string;
  event: string;
  eventId?: string;
  /** 呼んだ主体の表示名 */
  caller: string;
  sourceIdentity?: string;
  /** `AssumeRole`の引き受け先 */
  role?: string;
  /** `AssumeRole`で刻んだ目的 */
  purpose?: string;
  /** `GetWebIdentityToken`の宛先（ホップ名） */
  audience?: string;
  scope?: string;
  tokenId?: string;
  error?: string;
}

/** 入口（bff）の記録 */
export interface EntryRecord {
  time: string;
  user: string;
  route: string;
  purpose: string;
  status?: number;
  logGroup?: string;
  fields: Field[];
  check: Check;
}

/** 一覧の応答 */
export interface TransactionList {
  transactions: Transaction[];
}

/** 1回のリクエストの突き合わせの応答 */
export interface Reconciled {
  transaction: EntryRecord | null;
  hops: HopRecord[];
  awsRecords: AwsRecord[];
}
