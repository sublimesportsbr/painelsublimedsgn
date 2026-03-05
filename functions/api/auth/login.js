/**
 * Cloudflare Pages Function — POST /api/auth/login
 *
 * Body   : { "username": "jonathas@sublime" }
 * Retorna: { ok: true, user, role }  +  cookie HttpOnly "session"
 *
 * Env vars obrigatórias:
 *   ALLOWED_USERS  — CSV: "jonathas@sublime,carlos@sublime"
 *   ADMIN_USERS    — CSV: "jonathas@sublime"
 *   SESSION_SECRET — string ≥32 chars
 */

// ── SESSION UTILS (inline em cada function) ──────────────────────────────────
// JWT mínimo assinado com HMAC-SHA-256. Sem dependências externas.
// Usa crypto.subtle, disponível nativamente no runtime do Cloudflare Workers.

const _SC  = 'session';                    // nome do cookie
const _MAX = 60 * 60 * 24 * 14;           // 14 dias em segundos

function _b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function _b64uDec(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
async function _hmacKey(secret, usage) {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, [usage]
  );
}
async function _signJWT(payload, secret) {
  const h   = _b64u(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const b   = _b64u(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await _hmacKey(secret, 'sign');
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h}.${b}`));
  return `${h}.${b}.${_b64u(sig)}`;
}
async function _verifyJWT(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const p = token.split('.');
  if (p.length !== 3) return null;
  try {
    const key   = await _hmacKey(secret, 'verify');
    const valid = await crypto.subtle.verify(
      'HMAC', key, _b64uDec(p[2]), new TextEncoder().encode(`${p[0]}.${p[1]}`)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(_b64uDec(p[1])));
    if (!payload.exp || Date.now() / 1000 > payload.exp) return null;
    return payload;          // { user, role, exp }
  } catch (_) { return null; }
}
function _cookies(req) {
  const out = {};
  for (const p of (req.headers.get('cookie') || '').split(';')) {
    const i = p.indexOf('=');
    if (i < 1) continue;
    try { out[decodeURIComponent(p.slice(0, i).trim())] = decodeURIComponent(p.slice(i + 1).trim()); }
    catch (_) {}
  }
  return out;
}
async function requireSession(request, env) {
  const secret = (env.SESSION_SECRET || '').trim();
  if (!secret) return null;
  return _verifyJWT(_cookies(request)[_SC] || '', secret);
}
function deny401() {
  return new Response(JSON.stringify({ error: 'Não autenticado.' }), {
    status: 401, headers: { 'Content-Type': 'application/json' },
  });
}
// ── END SESSION UTILS ─────────────────────────────────────────────────────────

function resp(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...extra },
  });
}

export const onRequest = async ({ request, env }) => {
  if (request.method !== 'POST') return resp({ error: 'Método não permitido.' }, 405);

  /* ── Env vars ────────────────────────────────────────────────────────────── */
  const secret = (env.SESSION_SECRET || '').trim();
  if (!secret || secret.length < 16)
    return resp({ error: 'SESSION_SECRET não configurada ou muito curta.' }, 500);

  const allowed = (env.ALLOWED_USERS || '').split(',')
    .map(u => u.trim().toLowerCase()).filter(Boolean);
  const admins  = (env.ADMIN_USERS   || '').split(',')
    .map(u => u.trim().toLowerCase()).filter(Boolean);

  if (!allowed.length) return resp({ error: 'ALLOWED_USERS não configurada.' }, 500);

  /* ── Body ────────────────────────────────────────────────────────────────── */
  let username = '';
  try { username = String((await request.json()).username || '').trim().toLowerCase(); }
  catch (_) { return resp({ error: 'Body inválido.' }, 400); }

  /* ── Validações ──────────────────────────────────────────────────────────── */
  if (!username)
    return resp({ error: 'Usuário é obrigatório.' }, 400);
  if (!username.endsWith('@sublime'))
    return resp({ error: 'Usuário não autorizado.' }, 403);
  if (!allowed.includes(username))
    return resp({ error: 'Usuário não autorizado.' }, 403);

  /* ── Cria token e cookie ─────────────────────────────────────────────────── */
  const role  = admins.includes(username) ? 'admin' : 'viewer';
  const exp   = Math.floor(Date.now() / 1000) + _MAX;
  const token = await _signJWT({ user: username, role, exp }, secret);
  const cookie = `${_SC}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${_MAX}`;

  return resp({ ok: true, user: username, role }, 200, { 'Set-Cookie': cookie });
};
