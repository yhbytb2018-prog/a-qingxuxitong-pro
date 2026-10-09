const TOKEN = process.env.GH_TOKEN;
const API = 'https://api.github.com';
const OWNER = 'sjc19950404', REPO = 'a-sentiment-pro';
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
// 1) 开启 Pages（main / root）
const pages = await api(`/repos/${OWNER}/${REPO}/pages`, 'POST', { source: { branch: 'main', path: '/' } });
console.log('Pages enable status:', pages.status, pages.j && pages.j.html_url ? '-> ' + pages.j.html_url : pages.text.slice(0, 120));
// 2) 触发一次 Actions 工作流（live 模式跑数据）
const disp = await api(`/repos/${OWNER}/${REPO}/actions/workflows/daily.yml/dispatches`, 'POST', { ref: 'main' });
console.log('Workflow dispatch status:', disp.status);
