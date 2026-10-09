const TOKEN = process.env.GH_TOKEN;
const API = 'https://api.github.com';
async function api(path, method = 'GET', body = null) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'deploy' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
}
const me = await api('/user');
console.log('login:', me.j && me.j.login, '| status', me.status);
if (me.status !== 200) { console.error('token 无效'); process.exit(1); }
const name = 'a-sentiment-pro';
const created = await api('/user/repos', 'POST', {
  name, description: 'A股 市场情绪系统（云端版）', private: false, auto_init: false, has_issues: true,
});
console.log('create status:', created.status);
if (created.status === 201) console.log('repo created:', created.j.html_url);
else if (created.status === 422) console.log('repo 已存在，继续推送');
else { console.error('create failed', created.status, created.text.slice(0, 200)); process.exit(1); }
