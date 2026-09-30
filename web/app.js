// ブラウザは認証情報を持たない。bffとはHttpOnlyのセッションcookieだけで結ぶ（FR-5）
const $ = (id) => document.getElementById(id);

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// CloudFrontのOACでLambdaを呼ぶため、POSTには本文のSHA-256を付ける
async function post(path, body = '') {
  return fetch(path, { method: 'POST', body, headers: { 'x-amz-content-sha256': await sha256Hex(body) } });
}

async function show() {
  const res = await fetch('/api/me');
  const signedIn = res.ok;
  $('signed-in').hidden = !signedIn;
  $('signed-out').hidden = signedIn;
  if (signedIn) {
    const me = await res.json();
    $('who').textContent = `${me.username}（${me.branch}）`;
  }
}

$('logout').addEventListener('click', async () => {
  await post('/api/logout');
  await show();
});

$('summary-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch(`/api/cases/${encodeURIComponent($('case-id').value)}/summary`);
  $('result').textContent = `${res.status}\n${JSON.stringify(await res.json(), null, 2)}`;
});

show();
