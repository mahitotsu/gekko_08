import { useCallback, useEffect, useState } from 'react';
import { get, type ApiResult } from './api';
import { PURPOSE_LABELS, ROUTE_LABELS } from './labels';
import { Denial, PurposeChip } from './parts';

// 監査の画面。1回の取引について、各ホップのログ（アプリが書いた記録）と、CloudTrail（STSが書いた記録）を突き合わせる。
// 判定は監査サービスが行い、画面は表示だけを行う

type Check = { result: 'match' } | { result: 'mismatch'; fields: string[] } | { result: 'pending' } | { result: 'n/a' };

interface Transaction {
  time: string;
  requestId: string;
  route: string;
  purpose: string;
  user: string;
  status?: number;
}

interface HopRecord {
  time: string;
  hop: string;
  outcome: 'handled' | 'rejected';
  actor?: string;
  tokenIssuer?: string;
  tokenId?: string;
  subject?: string;
  purpose?: string;
  scope?: string;
  status?: number;
  reason?: string;
  check: Check;
}

interface AwsRecord {
  time: string;
  event: string;
  caller: string;
  sourceIdentity?: string;
  role?: string;
  purpose?: string;
  audience?: string;
  scope?: string;
  tokenId?: string;
  error?: string;
}

interface Reconciled {
  requestId: string;
  transaction: (Omit<Transaction, 'requestId'> & { check: Check }) | null;
  hops: HopRecord[];
  awsRecords: AwsRecord[];
}

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
  const [list, setList] = useState<ApiResult<{ transactions?: Transaction[] } & Denied>>();
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
            <h2>取引の監査</h2>
            <p className="muted small">
              各ホップのログ（アプリが書いた記録）を、CloudTrail（STSが書いた記録）とJWTの<code>jti</code>で突き合わせる。
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
        {list?.status === 200 && (
          <TransactionList items={list.body.transactions ?? []} selected={requestId} onSelect={onSelect} />
        )}
      </section>
      {requestId && !denied && <ReconcileView key={requestId} requestId={requestId} />}
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

function TransactionList({ items, selected, onSelect }: { items: Transaction[]; selected?: string; onSelect: (id: string) => void }) {
  if (items.length === 0) return <p className="muted">直近24時間の取引はない（ログが届くまで数秒〜数十秒かかる）。</p>;
  return (
    <div className="table-wrap">
      <table className="grid">
        <thead>
          <tr><th>時刻</th><th>ユーザー</th><th>操作</th><th>目的</th><th className="num">結果</th><th>リクエストID</th></tr>
        </thead>
        <tbody>
          {items.map((t) => (
            <tr key={t.requestId} className={`clickable ${selected === t.requestId ? 'selected' : ''}`} onClick={() => onSelect(t.requestId)}>
              <td className="nowrap">{day(t.time)} {clock(t.time)}</td>
              <td>{t.user}</td>
              <td>{ROUTE_LABELS[t.route] ?? t.route}</td>
              <td><code>{t.purpose}</code></td>
              <td className="num"><StatusBadge status={t.status} /></td>
              <td><code>{short(t.requestId)}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status?: number }) {
  const tone = status === 200 ? 'ok' : status === 403 ? 'deny' : status === 409 ? 'warn' : 'err';
  return <span className={`badge ${tone}`}>{status ?? '—'}</span>;
}

const CHECK_LABELS: Record<Check['result'], { label: string; tone: string }> = {
  match: { label: 'AWSの記録と一致', tone: 'ok' },
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
            {tx ? (ROUTE_LABELS[tx.route] ?? tx.route) : '取引'}<span className="muted">　{tx?.user}</span>
          </div>
          <div className="result-meta">
            {tx && <PurposeChip purpose={tx.purpose} />}
            <span className="rid">{requestId}</span>
            {tx && <span className="muted small">{day(tx.time)} {clock(tx.time)}</span>}
          </div>
        </div>
        <div className="tally">
          <span className="check ok">一致 {count('match')}</span>
          <span className="check deny">不一致 {count('mismatch')}</span>
          <span className="check warn">未着 {pending}</span>
        </div>
      </header>

      {!tx && <p className="muted">この取引のログが見つからない（ログが届くまで数秒〜数十秒かかる）。</p>}
      {pending > 0 && (
        <div className="callout neutral pending-note">
          CloudTrailのイベントは、届くまでに数分〜15分ほどかかる。未着のものは、あとで再確認する。
          <button type="button" className="btn ghost small-btn" onClick={load} disabled={loading}>{loading ? '再確認中…' : '再確認'}</button>
        </div>
      )}

      <h3 className="section-title">ホップの記録 <span className="muted small">各ホップの共通部品が検証してログに書いた値（アプリの記録）</span></h3>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr><th title="各ホップが処理を終えてログを書いた時刻。下流のホップが先に並ぶ">記録した時刻</th><th>ホップ</th><th>呼び出し元</th><th>誰の代理か</th><th>目的</th><th>scope</th><th className="num">結果</th><th>JWTの<code>jti</code></th><th>AWSの記録</th></tr>
          </thead>
          <tbody>
            {tx && (
              <tr className="entry-row">
                <td className="nowrap">{clock(tx.time)}</td>
                <td><code>bff</code><div className="muted tiny">入口。目的を刻む</div></td>
                <td className="muted">ブラウザ（cookie）</td>
                <td>{tx.user}</td>
                <td><code>{tx.purpose}</code></td>
                <td className="muted">—</td>
                <td className="num"><StatusBadge status={tx.status} /></td>
                <td className="muted">—</td>
                <td><CheckBadge check={tx.check} /></td>
              </tr>
            )}
            {hops.map((h, i) => (
              <tr key={i} className={h.outcome === 'rejected' ? 'rejected-row' : ''}>
                <td className="nowrap">{clock(h.time)}</td>
                <td><code>{h.hop}</code>{h.outcome === 'rejected' && <div className="tiny deny-text">受信の検証で拒否</div>}</td>
                <td>{h.actor ? <code>{h.actor}</code> : '—'}{h.tokenIssuer && <div className="muted tiny">JWT：{h.tokenIssuer}</div>}</td>
                <td>{h.subject ?? '—'}</td>
                <td>{h.purpose ? <code>{h.purpose}</code> : '—'}</td>
                <td>{h.scope ? <code className="scope">{h.scope}</code> : '—'}</td>
                <td className="num"><StatusBadge status={h.status} />{h.reason && <div className="muted tiny">{h.reason}</div>}</td>
                <td><code className="muted">{short(h.tokenId)}</code></td>
                <td><CheckBadge check={h.check} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="section-title">AWSの記録 <span className="muted small">CloudTrailのSTSのイベント（STSが書いた記録。ホップは書き換えられない）</span></h3>
      {awsRecords.length === 0 ? (
        <p className="muted">まだ届いていない。</p>
      ) : (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr><th>時刻</th><th>イベント</th><th>呼んだ主体</th><th>ユーザー（<code>sourceIdentity</code>）</th><th>内容</th><th><code>webIdentityTokenId</code></th></tr>
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
                  <td><code className="muted">{short(a.tokenId)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="muted tiny footnote">
        突き合わせられるのは、リクエストID（chainとJWTの発行のセッション名）で引けるAWSの記録の範囲である。リクエストIDはSTSもIAMも強制しないので、
        侵害されたホップが別の値を使えば、そのホップの記録は「未着」と区別できない。
      </p>
    </section>
  );
}
