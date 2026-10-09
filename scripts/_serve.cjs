// 本地静态服务（仅供 _shot_newstock.mjs 核对用）
const http = require('http'), fs = require('fs'), path = require('path');
const T = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const PORT = Number(process.argv[2] || 8791);
http.createServer((q, s) => {
  let f = path.join(process.cwd(), decodeURIComponent(q.url.split('?')[0]));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(process.cwd(), 'index.html');
  s.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(s);
}).listen(PORT, '127.0.0.1', () => console.log('serving on ' + PORT));
