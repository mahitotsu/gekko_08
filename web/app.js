// ブラウザは認証情報を持たない。bffとはHttpOnlyのセッションcookieだけで結ぶ（FR-5）
const $ = (id) => document.getElementById(id);

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// CloudFrontのOACでLambdaを呼ぶため、POSTには本文のSHA-256を付ける
async function post(path, body = '') {
  return fetch(path, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-amz-content-sha256': await sha256Hex(body) } });
}

async function show() {
  const res = await fetch('/api/me');
  const signedIn = res.ok;
  $('signed-in').hidden = !signedIn;
  $('signed-out').hidden = signedIn;
  if (signedIn) {
    const me = await res.json();
    // 所属と役職は属性サービス（人事データ）から得たもの
    $('who').textContent = me.branch ? `${me.username}（${me.branch}・${me.title}）` : me.username;
  }
}

$('logout').addEventListener('click', async () => {
  await post('/api/logout');
  await show();
});

$('agent-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('result').textContent = '分析中…';
  const res = await post('/api/agent', JSON.stringify({ caseId: $('agent-case-id').value }));
  $('result').textContent = `${res.status}\n${JSON.stringify(await res.json(), null, 2)}`;
});

$('summary-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch(`/api/cases/${encodeURIComponent($('case-id').value)}/summary`);
  $('result').textContent = `${res.status}\n${JSON.stringify(await res.json(), null, 2)}`;
});

// 凍結の解除。bffはこの操作でだけ、目的「凍結を解除する」（account-unfreeze）を刻む
$('unfreeze').addEventListener('click', async () => {
  const caseId = $('case-id').value;
  if (!$('summary-form').reportValidity() || !confirm(`案件${caseId}の口座の凍結を解除しますか`)) return;
  const res = await post(`/api/cases/${encodeURIComponent(caseId)}/unfreeze`);
  $('result').textContent = `${res.status}\n${JSON.stringify(await res.json(), null, 2)}`;
});

show();
