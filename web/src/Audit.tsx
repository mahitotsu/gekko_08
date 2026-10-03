import { useCallback, useEffect, useState } from 'react';
import { get, type ApiResult } from './api';
import type { Check, EventRef, Field, Reconciled as AuditResponse, Transaction, TransactionList } from '../../services/audit-service/src/api';
import { PURPOSE_LABELS, ROUTE_LABELS } from './labels';
import { Denial, PurposeChip } from './parts';

// 監査の画面。1回のリクエストについて、各ホップのログ（アプリが書いた記録）と、CloudTrail（AWSが記録したSTSの呼び出し）を突き合わせる。
// 判定は監査サービスが行い、画面は表示だけを行う

/** bffは、監査サービスの応答に、この監査の操作のリクエストIDと目的を加える（監査したリクエストのものではない） */
type Reconciled = AuditResponse & { requestId: string; purpose: string };

interface Denied {
  error?: string;
  reason?: string;
}

/** Logs Insightsの`@timestamp`（UTC、空白区切り）とCloudTrailの時刻を、手元の時刻で表示する */
function clock(t: string): string {
  const d = new Date(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? t : d.toLocaleTimeString('ja-JP');
}

function day(t: string): string {
  const d = new Date(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
}

const short = (id?: string) => (id ? `${id.slice(0, 8)}…` : '—');

export function Audit({ requestId, onSelect }: { requestId?: string; onSelect: (id: string) => void }) {
  const [list, setList] = useState<ApiResult<Partial<TransactionList> & Denied>>();
  const [loadingList, setLoadingList] = useState(false);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    try {
      setList(await get('/api/audit/requests'));
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const denied = list && list.status !== 200;

  return (
    <>
      <section className="card">
        <div className="audit-intro">
          <div>
            <h2>リクエストの監査</h2>
            <p className="muted small">
              各ホップのログ（アプリが書いた記録）を、CloudTrail（AWSが記録したSTSの呼び出し）とJWTの<code>jti</code>で突き合わせる。
              監査サービスも他のホップと同じ仕組みで守られ、監査の権限（<code>audit:view</code>）を持つユーザーだけが使える。
            </p>
          </div>
          <button type="button" className="btn ghost" onClick={loadList} disabled={loadingList}>{loadingList ? '読み込み中…' : '一覧を更新'}</button>
        </div>
        {denied && (
          <div className="result-body">
            <AuditDenied result={list} />
          </div>
        )}
      </section>
      {!denied && (
        <div className="audit-split">
          <section className="card audit-list" aria-label="リクエストの一覧">
            <h3 className="pane-title">リクエストの一覧 <span className="muted small">直近24時間</span></h3>
            {list?.status === 200 ? (
              <TransactionList items={list.body.transactions ?? []} selected={requestId} onSelect={onSelect} />
            ) : (
              <p className="muted"><span className="spinner inline-spinner" aria-hidden /> 読み込み中…</p>
            )}
          </section>
          <div className="audit-detail">
            {requestId ? (
              <ReconcileView key={requestId} requestId={requestId} />
            ) : (
              <section className="card"><p className="muted">左の一覧からリクエストを選ぶと、ここに突き合わせの結果が出る。</p></section>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function AuditDenied({ result }: { result: ApiResult<Denied> }) {
  return (
    <>
      <div className="verdict deny inline"><span className="verdict-label">拒否</span><span className="verdict-code">{result.status}</span></div>
      {result.body.reason ? <Denial reason={result.body.reason} /> : <p className="muted">{result.body.error}</p>}
      <p className="muted small">監査できるのは、監査担当（suzuki、本部）だけ。支店長も担当者も監査できず、監査担当は案件の参照も解除もできない。</p>
    </>
  );
}

interface SessionGroup {
  key: string;
  user: string;
  sessionRef?: string;
  loggedInAt?: number;
  items: Transaction[];
}

/** 監査サービスが並べた順（セッションの新しい順、セッションの中は時刻の順）のまま、セッションごとにまとめる */
function bySession(items: Transaction[]): SessionGroup[] {
  const groups: SessionGroup[] = [];
  for (const t of items) {
    const key = t.sessionRef ?? `user:${t.user}`;
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(t);
    else groups.push({ key, user: t.user, sessionRef: t.sessionRef, loggedInAt: t.loggedInAt, items: [t] });
  }
  return groups;
}

function TransactionList({ items, selected, onSelect }: { items: Transaction[]; selected?: string; onSelect: (id: string) => void }) {
  if (items.length === 0) return <p className="muted">直近24時間のリクエストはない（ログが届くまで数秒〜数十秒かかる）。</p>;
  return (
    <div className="table-wrap">
      <table className="grid">
        <thead>
          <tr><th>時刻</th><th>操作</th><th className="num">結果</th><th>リクエストID</th></tr>
        </thead>
        {bySession(items).map((g) => (
          <tbody key={g.key} className="session-group">
            <tr className="session-row">
              <td colSpan={4}>
                <span className="session-user">{g.user}</span>
                <span className="muted small">
                  {g.loggedInAt ? `${day(new Date(g.loggedInAt * 1000).toISOString())} ${clock(new Date(g.loggedInAt * 1000).toISOString())}にログイン` : 'ログインのセッションは不明'}
                  ・操作{g.items.length}件
                </span>
                {g.sessionRef && <code className="muted tiny" title="ログインのセッションの識別子（bffが作る。cookieとしては使えない）">{g.sessionRef.slice(0, 8)}</code>}
              </td>
            </tr>
            {g.items.map((t) => (
              <tr key={t.requestId} className={`clickable ${selected === t.requestId ? 'selected' : ''}`} onClick={() => onSelect(t.requestId)}>
                <td className="nowrap">{clock(t.time)}</td>
                <td>
                  {ROUTE_LABELS[t.route] ?? t.route}
                  <div className="muted tiny">
                    {t.auditTarget ? <>対象 <code title={t.auditTarget}>{short(t.auditTarget)}</code></> : t.caseId ?? '案件なし'}・目的 <code>{t.purpose}</code>
                  </div>
                </td>
                <td className="num"><StatusBadge status={t.status} /></td>
                <td><code title={t.requestId}>{short(t.requestId)}</code></td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status?: number }) {
  const tone = status === 200 ? 'ok' : status === 403 ? 'deny' : status === 409 ? 'warn' : 'err';
  return <span className={`badge ${tone}`}>{status ?? '—'}</span>;
}

const CHECK_LABELS: Record<Check['result'], { label: string; tone: string }> = {
  match: { label: '一致', tone: 'ok' },
  mismatch: { label: '不一致', tone: 'deny' },
  pending: { label: 'AWSの記録が未着', tone: 'warn' },
  'n/a': { label: '照合しない', tone: 'neutral' },
};

function CheckBadge({ check }: { check: Check }) {
  const c = CHECK_LABELS[check.result];
  return (
    <span className={`check ${c.tone}`}>
      {c.label}
      {check.result === 'mismatch' && <span className="check-fields">（{check.fields.join('、')}）</span>}
    </span>
  );
}

function ReconcileView({ requestId }: { requestId: string }) {
  const [r, setR] = useState<ApiResult<Reconciled & Denied>>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setR(await get(`/api/audit/requests/${encodeURIComponent(requestId)}`));
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!r) return <section className="card"><p className="muted"><span className="spinner inline-spinner" aria-hidden /> 突き合わせ中…（ログとCloudTrailを読む。数秒かかる）</p></section>;
  if (r.status !== 200) return <section className="card"><AuditDenied result={r} /></section>;

  const { transaction: tx, hops, awsRecords } = r.body;
  const checks = [...(tx ? [tx.check] : []), ...hops.map((h) => h.check)].filter((c) => c.result !== 'n/a');
  const count = (k: Check['result']) => checks.filter((c) => c.result === k).length;
  const pending = count('pending');

  return (
    <section className="card">
      <header className="result-head">
        <div>
          <div className="result-title">
            {tx ? (ROUTE_LABELS[tx.route] ?? tx.route) : 'リクエスト'}<span className="muted">　{tx?.user}</span>
          </div>
          <div className="result-meta">
            {tx && <PurposeChip purpose={tx.purpose} />}
            {tx && <span className="muted small">{day(tx.time)} {clock(tx.time)}</span>}
          </div>
          <div className="labeled">
            <span className="label">リクエストID</span><code>{requestId}</code>
          </div>
        </div>
        <div className="tally" title="監査サービスが、ホップの記録ごとに2つの記録を比べた結果">
          <span className="check ok">一致 {count('match')}</span>
          <span className="check deny">不一致 {count('mismatch')}</span>
          <span className="check warn">未着 {pending}</span>
        </div>
      </header>

      <div className="callout neutral legend">
        <p>
          記録ごとに、同じ項目を2つの情報源から並べる。「一致」「不一致」は、<strong>監査サービスが2つの値を比べた結果</strong>で、画面は比べていない。
        </p>
        <dl className="sources">
          <dt><span className="src app">アプリの記録</span></dt>
          <dd>CloudWatch Logs：各ホップが検証してログに書いた値（自己申告）</dd>
          <dt><span className="src aws">AWSの記録</span></dt>
          <dd>CloudTrail：AWSが記録したSTSの呼び出しのイベント（ホップは書き換えられない）。イベントIDで、CloudTrailのイベント履歴から同じイベントを引ける</dd>
        </dl>
      </div>

      {!tx && <p className="muted">このリクエストのログが見つからない（ログが届くまで数秒〜数十秒かかる）。</p>}
      {pending > 0 && (
        <div className="callout neutral pending-note">
          CloudTrailのイベントは、届くまでに数分〜15分ほどかかる。未着のものは、あとで再確認する。
          <button type="button" className="btn ghost small-btn" onClick={load} disabled={loading}>{loading ? '再確認中…' : '再確認'}</button>
        </div>
      )}

      <h3 className="section-title">ホップの記録 <span className="muted small">呼び出しの順</span></h3>
      <ol className="hop-records">
        {tx && (
          <li className="hop-record entry">
            <RecordHead time={tx.time} depth={0} name="bff" note="入口。目的を刻む" actor="ブラウザ（cookie）" status={tx.status} check={tx.check} />
            <Comparison logGroup={tx.logGroup} fields={tx.fields} />
          </li>
        )}
        {hops.map((h, i) => (
          <li key={i} className={`hop-record ${h.outcome === 'rejected' ? 'rejected' : ''}`}>
            <RecordHead
              time={h.startedAt ?? h.time} depth={h.depth} name={h.hop} actor={h.actor} status={h.status} reason={h.reason} check={h.check}
              note={h.outcome === 'rejected'
                ? h.claimedRequestId
                  ? `受信の検証で拒否。ヘッダーのリクエストIDを ${h.claimedRequestId} と偽っていた（JWTに刻まれていたのはこのリクエストのID）`
                  : '受信の検証で拒否。JWTを受け付けなかったので照合しない'
                : undefined}
            />
            {h.outcome === 'handled' && <Comparison logGroup={h.logGroup} fields={h.fields ?? []} token={{ app: h.tokenId, aws: h.tokenEvent }} />}
          </li>
        ))}
      </ol>

      <details className="raw aws-all">
        <summary>CloudTrailから取り出したイベント（全{awsRecords.length}件）</summary>
        {awsRecords.length === 0 ? (
          <p className="muted">まだ届いていない。</p>
        ) : (
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr><th>時刻</th><th>イベント</th><th>呼んだ主体</th><th>ユーザー（<code>sourceIdentity</code>）</th><th>内容</th><th><code>webIdentityTokenId</code></th><th>イベントID</th></tr>
              </thead>
              <tbody>
                {awsRecords.map((a, i) => (
                  <tr key={i}>
                    <td className="nowrap">{clock(a.time)}</td>
                    <td><code>{a.event}</code>{a.error && <div className="tiny deny-text">{a.error}</div>}</td>
                    <td>{a.caller}</td>
                    <td>{a.sourceIdentity ?? '—'}</td>
                    <td>
                      {a.event === 'GetWebIdentityToken' ? (
                        <>宛先 <code>{a.audience}</code>・scope <code className="scope">{a.scope ?? '—'}</code></>
                      ) : (
                        <>{a.role}{a.purpose && <>・目的 <code>{a.purpose}</code>（{PURPOSE_LABELS[a.purpose] ?? a.purpose}）</>}</>
                      )}
                    </td>
                    <td><code className="muted">{a.tokenId ?? '—'}</code></td>
                    <td><code className="muted">{a.eventId ?? '—'}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>

      <p className="muted tiny footnote">
        AWSの記録は、リクエストID（chainとJWTの発行のセッション名）で引く。リクエストIDはbffがリクエストの目的と同じく刻み、各chainのセッション名をIAMがその値に限るので、
        途中のホップは自分の記録をリクエストIDで引けなくすることはできない。
      </p>
    </section>
  );
}

function RecordHead(props: {
  time: string; depth: number; name: string; note?: string; actor?: string; status?: number; reason?: string; check: Check;
}) {
  return (
    <div className="record-head" style={{ paddingLeft: `${Math.max(props.depth - 1, 0) * 18}px` }}>
      <span className="nowrap muted small">{clock(props.time)}</span>
      <span className="record-name">
        {props.depth > 0 && <span className="muted" aria-hidden>└ </span>}<code>{props.name}</code>
        {props.actor && <span className="muted small">　呼び出し元 {props.depth > 0 ? <code>{props.actor}</code> : props.actor}</span>}
      </span>
      <span className="record-result">
        <StatusBadge status={props.status} />
        {props.reason && <span className="muted tiny">{props.reason}</span>}
        <CheckBadge check={props.check} />
      </span>
      {props.note && <div className={`tiny record-note ${props.check.result === 'n/a' ? 'deny-text' : 'muted'}`}>{props.note}</div>}
    </div>
  );
}

const FIELD_RESULT: Record<Field['result'], { label: string; tone: string }> = {
  match: { label: '一致', tone: 'ok' },
  mismatch: { label: '不一致', tone: 'deny' },
  pending: { label: '未着', tone: 'warn' },
};

const sameEvent = (a: EventRef, b: EventRef) => (a.eventId ?? `${a.event}@${a.time}`) === (b.eventId ?? `${b.event}@${b.time}`);

function EventSource({ e }: { e: EventRef }) {
  return (
    <div className="event-src">
      CloudTrail：<code>{e.event}</code>
      <span className="muted">　{day(e.time)} {clock(e.time)}</span>
      <div><span className="label">イベントID</span><code>{e.eventId ?? '—'}</code></div>
    </div>
  );
}

/** 1つの記録について、比べた項目を、アプリの記録とAWSの記録の2列で並べる */
function Comparison({ logGroup, fields, token }: {
  logGroup?: string; fields: Field[]; token?: { app?: string; aws?: EventRef & { tokenId?: string } };
}) {
  const events: EventRef[] = [];
  for (const e of [token?.aws, ...fields.map((f) => f.awsEvent)]) if (e && !events.some((x) => sameEvent(x, e))) events.push(e);
  return (
    <div className="table-wrap">
      <table className="grid compare">
        <thead>
          <tr><th>項目</th><th><span className="src app">アプリの記録</span></th><th><span className="src aws">AWSの記録</span></th><th>監査サービスの判定</th></tr>
        </thead>
        <tbody>
          <tr className="source-row">
            <th scope="row">情報源</th>
            <td>CloudWatch Logs：<code>{logGroup ?? '—'}</code></td>
            <td>{events.length ? events.map((e) => <EventSource key={e.eventId ?? e.time} e={e} />) : <span className="muted">未着</span>}</td>
            <td />
          </tr>
          {token && (
            <tr className="key-row">
              <th scope="row">JWTの識別子<div className="muted tiny">対応づけの鍵</div></th>
              <td><span className="label"><code>jti</code></span><code>{token.app ?? '—'}</code></td>
              <td>
                {token.aws ? <><span className="label"><code>webIdentityTokenId</code></span><code>{token.aws.tokenId}</code></> : <span className="muted">未着</span>}
              </td>
              <td className="muted tiny">{token.aws ? '同じ値のイベントを対応づけた' : '同じ値のイベントがまだない'}</td>
            </tr>
          )}
          {fields.map((f) => {
            const r = FIELD_RESULT[f.result];
            return (
              <tr key={f.name} className={f.result === 'mismatch' ? 'diff' : ''}>
                <th scope="row">{f.name}</th>
                <td><code>{f.app ?? '（なし）'}</code></td>
                <td>
                  {f.result === 'pending' ? <span className="muted">未着</span> : <code>{f.aws ?? '（なし）'}</code>}
                  {f.awsEvent && events.length > 1 && <div className="muted tiny"><code>{f.awsEvent.event}</code>から</div>}
                </td>
                <td><span className={`check ${r.tone}`}>{r.label}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
