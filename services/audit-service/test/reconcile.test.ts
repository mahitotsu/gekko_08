import { describe, expect, it } from 'vitest';
import { ownRows, reconcileRecords, toAwsRecord, transactionsFrom, type Directory, type Row, type TrailRecord } from '../src/reconcile';

// 突き合わせのロジックの単体テスト。部品の仕様を確かめるもので、要件のIDにはひも付けない

const ACCOUNT = '123456789012';
const RID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const dir: Directory = {
  logGroups: { bff: 'lg-bff', 'case-service': 'lg-case', 'account-service': 'lg-account', 'entitlement-service': 'lg-ent' },
  principals: {
    'purpose-role': 'bff（目的用のrole）',
    'case-chain': 'case-service（chain用role）',
    'account-chain': 'account-service（chain用role）',
  },
  audiencePrefix: 'Stack:',
};

const roleArn = (name: string) => `arn:aws:iam::${ACCOUNT}:role/${name}`;
const sessionArn = (name: string) => `arn:aws:sts::${ACCOUNT}:assumed-role/${name}/${RID}`;

/** CloudTrailの`GetWebIdentityToken`のイベント（`CloudTrailEvent`のJSON） */
function mintEvent(o: { eventId: string; time: string; issuer: string; audience: string; scope: string; user: string; jti: string }): string {
  return JSON.stringify({
    eventName: 'GetWebIdentityToken', eventTime: o.time, eventID: o.eventId,
    userIdentity: { arn: sessionArn(o.issuer), sessionContext: { sourceIdentity: o.user, sessionIssuer: { arn: roleArn(o.issuer) } } },
    requestParameters: { audience: [`Stack:${o.audience}`], tags: [{ key: 'scope', value: o.scope }] },
    responseElements: { webIdentityTokenId: o.jti },
  });
}

/** bffが目的を刻んだ`AssumeRole`のイベント。`responseElements`には認証情報が入る */
const stampEvent = JSON.stringify({
  eventName: 'AssumeRole', eventTime: '2026-10-03T01:00:00Z', eventID: 'ev-stamp',
  userIdentity: { arn: sessionArn('federated'), sessionContext: { sourceIdentity: 'yamada' } },
  requestParameters: { roleArn: roleArn('purpose-role'), roleSessionName: RID, tags: [{ key: 'purpose', value: 'case-summary' }, { key: 'requestId', value: RID }] },
  responseElements: {
    credentials: { accessKeyId: 'ASIAEXAMPLEEXAMPLE12', sessionToken: 'IQoJb3JpZ2luX2VjEXAMPLE', expiration: 'x' },
    assumedRoleUser: { arn: sessionArn('purpose-role') },
  },
});

const records = (): TrailRecord[] => [
  toAwsRecord(stampEvent, dir)!,
  toAwsRecord(mintEvent({ eventId: 'ev-1', time: '2026-10-03T01:00:00.1Z', issuer: 'purpose-role', audience: 'case-service', scope: 'case:summary', user: 'yamada', jti: 'jti-1' }), dir)!,
  toAwsRecord(mintEvent({ eventId: 'ev-2', time: '2026-10-03T01:00:00.2Z', issuer: 'case-chain', audience: 'account-service', scope: 'account:read', user: 'yamada', jti: 'jti-2' }), dir)!,
];

// ログは処理を終えたときに書くので、下流のホップが先に並ぶ
const rows = (): Row[] => [
  { '@timestamp': '2026-10-03 01:00:00.300', message: 'handled', hop: 'account-service', requestId: RID, actor: 'case-service', tokenSub: roleArn('case-chain'), tokenId: 'jti-2', 'subject.id': 'yamada', purpose: 'case-summary', scope: 'account:read', status: '200', 'timings.totalMs': '100' },
  { '@timestamp': '2026-10-03 01:00:00.400', message: 'handled', hop: 'case-service', requestId: RID, actor: 'bff', tokenSub: roleArn('purpose-role'), tokenId: 'jti-1', 'subject.id': 'yamada', purpose: 'case-summary', scope: 'case:summary', status: '200', 'timings.totalMs': '300' },
  { '@timestamp': '2026-10-03 01:00:00.500', message: 'handled', hop: 'bff', requestId: RID, route: 'case-summary', user: 'yamada', purpose: 'case-summary', status: '200' },
];

describe('toAwsRecord', () => {
  it('GetWebIdentityTokenから、宛先（ホップ名）、scope、ユーザー、jti、イベントIDを取り出す', () => {
    expect(records()[1]).toEqual({
      time: '2026-10-03T01:00:00.1Z', event: 'GetWebIdentityToken', eventId: 'ev-1', caller: 'bff（目的用のrole）', sourceIdentity: 'yamada',
      audience: 'case-service', scope: 'case:summary', tokenId: 'jti-1', issuerRole: 'purpose-role',
    });
  });

  it('SR-3: AssumeRoleの応答の認証情報もARNも取り出さない', () => {
    const r = toAwsRecord(stampEvent, dir);
    expect(r).toMatchObject({ event: 'AssumeRole', role: 'bff（目的用のrole）', purpose: 'case-summary', sourceIdentity: 'yamada', eventId: 'ev-stamp' });
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/ASIA|IQoJ|arn:aws:/);
  });

  it('このスタックの外の宛先とroleは、名前を出さずに示す', () => {
    const r = toAwsRecord(mintEvent({ eventId: 'e', time: 't', issuer: 'someone', audience: 'x', scope: 's', user: 'u', jti: 'j' }).replace('Stack:x', 'https://external.example'), dir);
    expect(r).toMatchObject({ caller: 'このスタックの外のrole', audience: '（参照実装の外の宛先）' });
  });

  it('突き合わせに使わないイベントは捨てる', () => {
    expect(toAwsRecord(JSON.stringify({ eventName: 'GetCallerIdentity' }), dir)).toBeUndefined();
    expect(toAwsRecord(undefined, dir)).toBeUndefined();
  });
});

describe('reconcileRecords', () => {
  it('jtiとwebIdentityTokenIdで対応づけ、項目ごとに2つの値と情報源を並べ、すべて一致なら一致', () => {
    const r = reconcileRecords(rows(), records(), dir);
    expect(r.transaction).toMatchObject({ route: 'case-summary', logGroup: 'lg-bff', check: { result: 'match' } });
    const account = r.hops.find((h) => h.hop === 'account-service')!;
    expect(account).toMatchObject({
      logGroup: 'lg-account', tokenId: 'jti-2', check: { result: 'match' },
      tokenEvent: { event: 'GetWebIdentityToken', eventId: 'ev-2', tokenId: 'jti-2' },
    });
    expect(account.fields!.map((f) => [f.name, f.app, f.aws, f.awsEvent?.eventId, f.result])).toEqual([
      ['JWTを発行したrole', 'case-service（chain用role）', 'case-service（chain用role）', 'ev-2', 'match'],
      ['宛先', 'account-service', 'account-service', 'ev-2', 'match'],
      ['scope', 'account:read', 'account:read', 'ev-2', 'match'],
      ['ユーザー', 'yamada', 'yamada', 'ev-2', 'match'],
      ['目的', 'case-summary', 'case-summary', 'ev-stamp', 'match'],
    ]);
  });

  it('ログに書かれた値がSTSの記録と違えば、どの項目がどう違うかを返す', () => {
    const forged = rows().map((r) => (r.hop === 'account-service' ? { ...r, scope: 'account:unfreeze' } : r));
    const account = reconcileRecords(forged, records(), dir).hops.find((h) => h.hop === 'account-service')!;
    expect(account.check).toEqual({ result: 'mismatch', fields: ['scope'] });
    expect(account.fields!.find((f) => f.name === 'scope')).toMatchObject({ app: 'account:unfreeze', aws: 'account:read', result: 'mismatch' });
  });

  it('JWTを発行したroleは、表示名ではなくrole名で比べる', () => {
    const other = rows().map((r) => (r.hop === 'account-service' ? { ...r, tokenSub: roleArn('unknown-a') } : r));
    const recs = records().map((r) => (r.tokenId === 'jti-2' ? { ...r, issuerRole: 'unknown-b' } : r));
    const account = reconcileRecords(other, recs, dir).hops.find((h) => h.hop === 'account-service')!;
    // どちらも「このスタックの外のrole」と表示されるが、role名が違うので不一致
    expect(account.fields![0]).toMatchObject({ app: 'このスタックの外のrole', aws: 'このスタックの外のrole', result: 'mismatch' });
  });

  it('対応するAWSの記録がなければ未着。目的を刻んだ記録だけがなくても未着', () => {
    expect(reconcileRecords(rows(), [], dir).hops.every((h) => h.check.result === 'pending')).toBe(true);
    const noStamp = reconcileRecords(rows(), records().filter((r) => r.event !== 'AssumeRole'), dir);
    expect(noStamp.transaction!.check).toEqual({ result: 'pending' });
    expect(noStamp.hops.find((h) => h.hop === 'case-service')!.check).toEqual({ result: 'pending' });
  });

  it('呼び出しの順（深さ優先）に並べ、処理を始めた時刻を求める', () => {
    const withEnt = [
      { '@timestamp': '2026-10-03 01:00:00.150', message: 'handled', hop: 'entitlement-service', requestId: RID, actor: 'case-service', status: '200', 'timings.totalMs': '20' },
      { '@timestamp': '2026-10-03 01:00:00.280', message: 'handled', hop: 'entitlement-service', requestId: RID, actor: 'account-service', status: '200', 'timings.totalMs': '20' },
      ...rows(),
    ];
    const r = reconcileRecords(withEnt, records(), dir);
    expect(r.hops.map((h) => `${h.depth}:${h.hop}`)).toEqual(['1:case-service', '2:entitlement-service', '2:account-service', '3:entitlement-service']);
    expect(r.hops[0].startedAt).toBe('2026-10-03T01:00:00.100Z');
  });

  it('応答に、突き合わせにだけ使う項目（JWTを発行したrole名）を含めない', () => {
    expect(JSON.stringify(reconcileRecords(rows(), records(), dir))).not.toMatch(/issuerRole|arn:aws:/);
  });
});

describe('ownRows（リクエストIDを偽った呼び出しの拒否の記録）', () => {
  // case-serviceがヘッダーだけOTHERに偽ってaccount-serviceを呼び、拒否された。JWTに刻まれていたのはRID
  const forgedCall: Row = {
    '@timestamp': '2026-10-03 01:00:00.250', message: 'rejected', hop: 'account-service', requestId: OTHER, stampedRequestId: RID,
    status: '401', reason: 'request id does not match authorization context',
  };

  it('本当の取引（刻まれた値）の下に、偽ったリクエストIDとともに出る', () => {
    const own = ownRows(RID, [...rows(), forgedCall]);
    const rejected = reconcileRecords(own, records(), dir).hops.find((h) => h.outcome === 'rejected');
    expect(rejected).toMatchObject({ hop: 'account-service', claimedRequestId: OTHER, status: 401, check: { result: 'n/a' } });
  });

  it('名乗られた取引の下には出ない', () => {
    expect(ownRows(OTHER, [forgedCall])).toEqual([]);
  });

  it('JWTを検証できなかった拒否（刻まれた値がない）は、名乗られたリクエストIDの下に出る', () => {
    const noJwt: Row = { '@timestamp': '2026-10-03 01:00:00.250', message: 'rejected', hop: 'account-service', requestId: RID, status: '401', reason: 'missing authorization context' };
    const rejected = reconcileRecords(ownRows(RID, [noJwt]), [], dir).hops[0];
    expect(rejected).toMatchObject({ outcome: 'rejected', check: { result: 'n/a' } });
    expect(rejected.claimedRequestId).toBeUndefined();
  });
});

describe('transactionsFrom', () => {
  it('ログインのセッションの新しい順、セッションの中は時刻の順に並べる', () => {
    const t = (time: string, requestId: string, sessionRef: string, loggedInAt: string): Row => ({ '@timestamp': time, requestId, route: 'case-summary', purpose: 'case-summary', user: 'u', status: '200', sessionRef, loggedInAt });
    const list = transactionsFrom([
      t('2026-10-03 02:00:00.000', 'b2', 'B', '1791000000'),
      t('2026-10-03 01:30:00.000', 'a2', 'A', '1790990000'),
      t('2026-10-03 01:50:00.000', 'b1', 'B', '1791000000'),
      t('2026-10-03 01:10:00.000', 'a1', 'A', '1790990000'),
    ]);
    expect(list.map((x) => x.requestId)).toEqual(['b1', 'b2', 'a1', 'a2']);
  });
});
