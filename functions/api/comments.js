/**
 * Cloudflare Pages Function — POST /api/comments
 *
 * Busca comentários "alteração iniciada/concluída" nos boards do Trello.
 * Requer cookie de sessão HS256 válido.
 * Env vars: TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_ALLOWED_BOARD_IDS, SESSION_SECRET
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

const RE_CONCLUIDA = /altera[cç][aã]o\s+conclu[ií]da!?/i;
const RE_INICIADA  = /altera[cç][aã]o\s+iniciada/i;

function resp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
async function trelloGet(url, attempt = 1) {
  const res = await fetch(url);
  if (res.ok) return res.json();
  if (res.status === 429 && attempt < 4) { await new Promise(r => setTimeout(r, attempt * 1000)); return trelloGet(url, attempt + 1); }
  throw new Error(`Trello API ${res.status}`);
}

export const onRequest = async ({ request, env }) => {
  /* ── 1. Auth ─────────────────────────────────────────────────────────────── */
  const auth = await requireSession(request, env);
  if (!auth) return deny401();

  if (request.method !== 'POST') return resp({ error: 'Método não permitido.' }, 405);

  /* ── 2. Env vars ─────────────────────────────────────────────────────────── */
  const KEY   = (env.TRELLO_API_KEY || env.TRELLO_KEY || '').trim();
  const TOKEN = (env.TRELLO_TOKEN   || '').trim();
  if (!KEY || !TOKEN) return resp({ error: 'Env vars TRELLO_API_KEY e TRELLO_TOKEN são obrigatórias.' }, 500);
  const allowedEnv = (env.TRELLO_ALLOWED_BOARD_IDS || '').trim();
  if (!allowedEnv) return resp({ error: 'TRELLO_ALLOWED_BOARD_IDS é obrigatória.' }, 500);
  const allowedIds = allowedEnv.split(',').map(s => s.trim()).filter(Boolean);
  const base = `key=${KEY}&token=${TOKEN}`;

  /* ── 3. Body ─────────────────────────────────────────────────────────────── */
  let fromISO, toISO;
  try { ({ fromISO, toISO } = await request.json()); } catch (_) { return resp({ error: 'Body inválido.' }, 400); }
  if (!fromISO || !toISO) return resp({ error: 'fromISO e toISO são obrigatórios.' }, 400);

  /* ── 4. Busca ────────────────────────────────────────────────────────────── */
  try {
    const allActions = [];
    for (const boardId of allowedIds) {
      let lastId = null, go = true;
      while (go) {
        const url = `https://api.trello.com/1/boards/${boardId}/actions?${base}&filter=commentCard&limit=1000&since=${encodeURIComponent(fromISO)}${lastId?'&before='+lastId:''}`;
        let page;
        try { page = await trelloGet(url); } catch (_) { go = false; break; }
        if (!page?.length) { go = false; break; }
        for (const act of page) {
          const d = act.date || '';
          if (toISO && d > toISO) continue;
          const text   = act.data?.text    || '';
          const cardId = act.data?.card?.id || null;
          if (!cardId) continue;
          let type = null;
          if (RE_CONCLUIDA.test(text)) type = 'end';
          else if (RE_INICIADA.test(text)) type = 'start';
          if (type) allActions.push({ date: d, cardId, text, type });
        }
        if (page.length < 1000) go = false;
        else lastId = page[page.length - 1].id;
      }
      console.log(`[comments] board=${boardId} acc=${allActions.length}`);
    }
    return resp({ actions: allActions });
  } catch (err) {
    console.error('[comments]', err.message);
    return resp({ error: err.message }, 500);
  }
};
