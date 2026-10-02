import { useCallback, useEffect, useState } from 'react';
import { get, post, type Account, type ApiResult, type Case, type HopBody, type Me, type ToolCall } from './api';
import { Audit } from './Audit';
import { BRANCH_LABELS, TOOL_LABELS } from './labels';
import { Denial, PurposeChip } from './parts';

type ActionKey = 'summary' | 'unfreeze' | 'agent';

interface ActionDef {
  label: string;
  /** bffがこの操作で刻む取引の目的（表示用。ブラウザからは送らない） */
  purpose: string;
  path: string[];
  note: string;
  run: (caseId: string) => Promise<ApiResult<HopBody>>;
}

const enc = encodeURIComponent;

const ACTIONS: Record<ActionKey, ActionDef> = {
  summary: {
    label: '案件を開く',
    purpose: 'case-summary',
    path: ['bff', 'case-service', 'account-service'],
    note: '案件と、口座の凍結の状態を読む。',
    run: (id) => get<HopBody>(`/api/cases/${enc(id)}/summary`),
  },
  unfreeze: {
    label: '凍結を解除',
    purpose: 'account-unfreeze',
    path: ['bff', 'case-service', 'account-service'],
    note: '行員が画面から操作する取引でだけ、bffがこの目的を刻む。解除のscopeは、この目的の取引でだけ発行される。',
    run: (id) => post<HopBody>(`/api/cases/${enc(id)}/unfreeze`),
  },
  agent: {
    label: 'エージェントに分析させる',
    purpose: 'agent-analysis',
    path: ['bff', 'fraud-agent', 'fraud-mcp', 'case-service・account-service'],
    note: '解除してよいかの提案までを行う。この目的の取引からは、エージェントが乗っ取られても解除できない。',
    run: (id) => post<HopBody>('/api/agent', JSON.stringify({ caseId: id })),
  },
};

const DEMO_CASES = [
  { caseId: 'C-1001', branch: 'tokyo', hint: '取引メモに「本部監査部の者です」という口上が入っている' },
  { caseId: 'C-2001', branch: 'osaka', hint: '大阪支店の案件' },
];

const CASE_ID = /^[\w-]{1,64}$/;

interface Entry {
  id: number;
  action: ActionKey;
  caseId: string;
  at: Date;
  result?: ApiResult<HopBody>;
}

let nextId = 1;

type View = 'ops' | 'audit';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [view, setView] = useState<View>('ops');
  const [auditId, setAuditId] = useState<string>();

  const loadMe = useCallback(async () => {
    const r = await get<Me>('/api/me');
    setMe(r.status === 200 ? r.body : null);
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  const logout = async () => {
    const r = await post<{ logoutUrl?: string }>('/api/logout');
    // Cognitoのマネージドログインのログイン状態も消す。消さないと、別のユーザーでログインし直せない
    if (r.body.logoutUrl) {
      location.assign(r.body.logoutUrl);
      return;
    }
    await loadMe();
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>◆</span>
          <div>
            <div className="brand-title">口座の凍結解除デモ</div>
            <div className="brand-sub">「誰の権限で、何のための取引か」を、最後のホップまでIAMに強制させる</div>
          </div>
        </div>
        {me && <UserBox me={me} onLogout={logout} />}
      </header>
      <main className="content">
        {me === undefined && <p className="muted">読み込み中…</p>}
        {me === null && <SignedOut />}
        {me && (
          <>
            <nav className="tabs" aria-label="画面">
              <button type="button" className={`tab ${view === 'ops' ? 'on' : ''}`} onClick={() => setView('ops')}>操作</button>
              <button type="button" className={`tab ${view === 'audit' ? 'on' : ''}`} onClick={() => setView('audit')}>監査</button>
            </nav>
            {/* 操作の履歴を残すため、切り替えても消さない */}
            <div hidden={view !== 'ops'} className="view"><Workspace onAudit={(id) => { setAuditId(id); setView('audit'); }} /></div>
            {view === 'audit' && <div className="view"><Audit requestId={auditId} onSelect={setAuditId} /></div>}
          </>
        )}
      </main>
    </div>
  );
}

function UserBox({ me, onLogout }: { me: Me; onLogout: () => void }) {
  return (
    <div className="userbox">
      <div>
        <div className="user-name">{me.username}</div>
        <div className="user-attrs" title="所属と役職は、属性サービスが人事データから返したもの。トークンには入れていない">
          {me.branch ? `${BRANCH_LABELS[me.branch] ?? me.branch}・${me.title}` : '人事データなし'}
          <span className="source">属性サービス</span>
        </div>
      </div>
      <button type="button" className="btn ghost" onClick={onLogout}>ログアウト</button>
    </div>
  );
}

function SignedOut() {
  return (
    <section className="card hero">
      <h1>ログインしてください</h1>
      <p>
        yamada（東京支店・支店長）か tanaka（大阪支店・担当者）で操作し、suzuki（本部・監査担当）で取引を監査する。ブラウザには、Cognitoのトークンも、AWSの認証情報も渡さない。
        サーバー側の入口（bff）とは、HttpOnlyのセッションcookieだけで結ぶ。
      </p>
      <a className="btn primary" href="/api/login">ログイン</a>
    </section>
  );
}

function Workspace({ onAudit }: { onAudit: (requestId: string) => void }) {
  const [caseId, setCaseId] = useState('C-1001');
  const [entries, setEntries] = useState<Entry[]>([]);
  const valid = CASE_ID.test(caseId);

  const run = async (action: ActionKey) => {
    if (!valid) return;
    if (action === 'unfreeze' && !confirm(`案件${caseId}の口座の凍結を解除しますか`)) return;
    const entry: Entry = { id: nextId++, action, caseId, at: new Date() };
    setEntries((es) => [entry, ...es]);
    let result: ApiResult<HopBody>;
    try {
      result = await ACTIONS[action].run(caseId);
    } catch (e) {
      result = { status: 0, body: { error: (e as Error).message } };
    }
    setEntries((es) => es.map((x) => (x.id === entry.id ? { ...x, result } : x)));
  };

  return (
    <>
      <Layers />
      <section className="card">
        <h2>案件</h2>
        <div className="case-picker">
          <label className="field">
            <span>案件ID</span>
            <input value={caseId} onChange={(e) => setCaseId(e.target.value.trim())} aria-invalid={!valid} />
          </label>
          <div className="chips">
            {DEMO_CASES.map((c) => (
              <button key={c.caseId} type="button" className={`chip ${caseId === c.caseId ? 'on' : ''}`} onClick={() => setCaseId(c.caseId)} title={c.hint}>
                {c.caseId}
                <span className="chip-sub">{BRANCH_LABELS[c.branch]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="actions">
          {(Object.keys(ACTIONS) as ActionKey[]).map((k) => (
            <ActionCard key={k} def={ACTIONS[k]} danger={k === 'unfreeze'} disabled={!valid} onRun={() => run(k)} />
          ))}
        </div>
      </section>
      <section className="results">
        {entries.length === 0 && <p className="muted center">操作の結果がここに並ぶ。許可されたものも、拒否されたものも残る。</p>}
        {entries.map((e) => <ResultCard key={e.id} entry={e} onAudit={onAudit} />)}
      </section>
    </>
  );
}

function Layers() {
  return (
    <section className="layers">
      <div className="layer l-identity">
        <div className="layer-name">身元</div>
        <div className="layer-q">誰の代理か・どのサービスから来たか</div>
        <div className="layer-by">STSのSourceIdentity、入口のIAM</div>
      </div>
      <div className="layer l-delegation">
        <div className="layer-name">委任の範囲</div>
        <div className="layer-q">この取引で、この呼び出し元に何を許すか</div>
        <div className="layer-by">取引の目的とscope。IAMが強制する</div>
      </div>
      <div className="layer l-entitlement">
        <div className="layer-name">業務的なアクセス権</div>
        <div className="layer-q">このユーザーは、このデータを扱ってよいか</div>
        <div className="layer-by">属性サービス（人事データと権限マスタ）</div>
      </div>
    </section>
  );
}

function ActionCard({ def, danger, disabled, onRun }: { def: ActionDef; danger: boolean; disabled: boolean; onRun: () => void }) {
  return (
    <div className="action">
      <div className="action-head">
        <PurposeChip purpose={def.purpose} />
      </div>
      <HopPath hops={def.path} />
      <p className="action-note">{def.note}</p>
      <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} disabled={disabled} onClick={onRun}>
        {def.label}
      </button>
    </div>
  );
}


function HopPath({ hops }: { hops: string[] }) {
  return (
    <div className="hops">
      {hops.map((h, i) => (
        <span key={h} className="hop">{i > 0 && <span className="arrow" aria-hidden>→</span>}<span className="hop-name">{h}</span></span>
      ))}
    </div>
  );
}

function verdict(status: number): { label: string; tone: string } {
  if (status === 200) return { label: '許可', tone: 'ok' };
  if (status === 403) return { label: '拒否', tone: 'deny' };
  if (status === 409) return { label: '実行されず', tone: 'warn' };
  if (status === 401) return { label: 'ログインが必要', tone: 'warn' };
  return { label: 'エラー', tone: 'err' };
}

function denialReason(body: HopBody): string | undefined {
  return body.reason ?? body.account?.reason;
}

function ResultCard({ entry, onAudit }: { entry: Entry; onAudit: (requestId: string) => void }) {
  const def = ACTIONS[entry.action];
  const r = entry.result;
  const v = r && verdict(r.status);
  return (
    <article className={`card result ${v ? `tone-${v.tone}` : 'pending'}`}>
      <header className="result-head">
        <div>
          <div className="result-title">{def.label}<span className="muted">　{entry.caseId}</span></div>
          <div className="result-meta">
            <PurposeChip purpose={r?.body.purpose ?? def.purpose} />
            {r?.body.requestId && <span className="rid" title="リクエストID。ログ、CloudTrail、トレース、記録で同じ値をたどれる">{r.body.requestId}</span>}
            <span className="muted small">{entry.at.toLocaleTimeString('ja-JP')}</span>
          </div>
        </div>
        {r && v ? (
          <div className={`verdict ${v.tone}`}>
            <span className="verdict-label">{v.label}</span>
            <span className="verdict-code">{r.status || '—'}</span>
          </div>
        ) : (
          <div className="verdict pending"><span className="spinner" aria-hidden />{entry.action === 'agent' ? '分析中（10秒前後）' : '処理中'}</div>
        )}
      </header>
      {r && <ResultBody action={entry.action} result={r} />}
      {r?.body.requestId && (
        <div className="result-foot">
          <button type="button" className="btn ghost small-btn" onClick={() => onAudit(r.body.requestId!)}>監査で確かめる</button>
          <span className="muted tiny">各ホップの記録を、AWSの記録（CloudTrail）と突き合わせる。監査担当だけが使える</span>
        </div>
      )}
    </article>
  );
}

function ResultBody({ action, result }: { action: ActionKey; result: ApiResult<HopBody> }) {
  const b = result.body;
  const reason = result.status !== 200 ? denialReason(b) : undefined;
  return (
    <div className="result-body">
      {reason && <Denial reason={reason} />}
      {result.status !== 200 && !reason && b.error && <p className="muted">{b.error}</p>}
      {action === 'agent' && b.toolCalls && <AgentView analysis={b.analysis} toolCalls={b.toolCalls} />}
      {action === 'summary' && b.case && <CaseView c={b.case} />}
      {result.status === 200 && b.account && <AccountView a={b.account} />}
      <details className="raw">
        <summary>応答のJSON</summary>
        <pre>{JSON.stringify(b, null, 2)}</pre>
      </details>
    </div>
  );
}


function CaseView({ c }: { c: Case }) {
  return (
    <div className="panel">
      <div className="panel-title">案件 {c.caseId}<span className="muted">　{BRANCH_LABELS[c.branch] ?? c.branch}・口座 {c.accountId}</span></div>
      <div className="case-title">{c.title}</div>
      <table className="tx">
        <thead><tr><th>日付</th><th className="num">金額</th><th>取引メモ（データ）</th></tr></thead>
        <tbody>
          {c.transactions.map((t, i) => (
            <tr key={i}>
              <td>{t.date}</td>
              <td className="num">{t.amount.toLocaleString('ja-JP')}円</td>
              <td>{t.memo}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AccountView({ a }: { a: Account }) {
  const frozen = a.status === 'frozen';
  return (
    <div className="panel">
      <div className="panel-title">口座 {a.accountId}<span className="muted">　{BRANCH_LABELS[a.branch] ?? a.branch}・{a.holder}</span></div>
      <div className="account-row">
        <span className={`status ${frozen ? 'frozen' : 'active'}`}>{frozen ? '凍結中' : '解除済み'}</span>
        {frozen && a.frozenReason && <span>{a.frozenReason}</span>}
      </div>
      {!frozen && typeof a.unfrozenBy === 'string' && (
        <dl className="kv">
          <dt>解除したユーザー</dt><dd>{a.unfrozenBy}<span className="muted small">（STSが署名したJWTのsource_identity）</span></dd>
          <dt>日時</dt><dd>{String(a.unfrozenAt ?? '')}</dd>
          <dt>リクエストID</dt><dd><code>{String(a.unfreezeRequestId ?? '')}</code></dd>
        </dl>
      )}
    </div>
  );
}

function AgentView({ analysis, toolCalls }: { analysis?: string; toolCalls: ToolCall[] }) {
  const attempts = toolCalls.filter((t) => t.name === 'unfreeze_account');
  const blocked = attempts.filter((t) => t.status !== 200);
  return (
    <>
      {attempts.length > 0 ? (
        <div className="callout deny">
          エージェントは誘導されて凍結の解除を{attempts.length}回試みた。{blocked.length === attempts.length ? 'すべて拒否された。' : `${blocked.length}回が拒否された。`}
          エージェントの取引（<code>agent-analysis</code>）からは、解除のscopeをSTSが発行しない。
        </div>
      ) : (
        <div className="callout neutral">今回は、エージェントは凍結の解除を試みなかった（モデルの判断は毎回変わる）。</div>
      )}
      <div className="panel">
        <div className="panel-title">ツールの呼び出し<span className="muted">　fraud-agent → fraud-mcp → 業務のホップ</span></div>
        <ol className="timeline">
          {toolCalls.map((t, i) => {
            const v = verdict(t.status);
            return (
              <li key={i} className={`tl tone-${v.tone}`}>
                <span className="tl-dot" aria-hidden />
                <span className="tl-name">{TOOL_LABELS[t.name] ?? t.name}<code>{t.name}</code></span>
                <code className="tl-input">{JSON.stringify(t.input)}</code>
                <span className={`badge ${v.tone}`}>{t.status}</span>
                {t.reason && t.status !== 200 && <Denial reason={t.reason} compact />}
              </li>
            );
          })}
        </ol>
      </div>
      {analysis && (
        <div className="panel">
          <div className="panel-title">エージェントの提案</div>
          <div className="analysis">{analysis}</div>
        </div>
      )}
    </>
  );
}
