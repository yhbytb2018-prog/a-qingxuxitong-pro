// ── Worker 入口（fetch 路由；scheduled 见 P2 计划）─────────────────────────
// 路由：GET /healthz · POST /push（其余 404）。
//   部署：wrangler deploy（见 wrangler.toml 头注释）；本地：wrangler dev。
import { handlePush, handleHealth, corsHeaders } from './push_proxy.js';

const notFound = () => new Response(JSON.stringify({ ok: false, reason: 'not found' }), {
  status: 404,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
    if (pathname === '/healthz') return handleHealth();
    if (pathname === '/push' || pathname === '/api/push') return handlePush(request, env);
    return notFound();
  },
};
