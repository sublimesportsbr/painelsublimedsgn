/**
 * Cloudflare Pages Function — POST /api/card-comments
 *
 * Busca TODOS os comentários de uma lista de card IDs do Trello.
 * Usado pelo módulo de Motivos de Alteração para classificação por IA.
 *
 * Body: { cardIds: string[] }
 * Response: { comments: [{ cardId, text, author, date }] }
 *
 * Env vars: TRELLO_API_KEY, TRELLO_TOKEN, SESSION_SECRET
 */

// ── SESSION UTILS (inline — mesmo padrão dos outros endpoints) ────────────────
const _SC  = 'session';
const _MAX = 60 * 60 * 24 * 14;

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
    return payload;
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

function resp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function trelloGet(url, attempt = 1) {
  const res = await fetch(url);
  if (res.ok) return res.json();
  if (res.status === 429 && attempt < 4) {
    await new Promise(r => setTimeout(r, attempt * 1200));
    return trelloGet(url, attempt + 1);
  }
  throw new Error(`Trello API ${res.status} — ${url}`);
}

export const onRequest = async ({ request, env }) => {
  /* ── 1. Auth ── */
  const auth = await requireSession(request, env);
  if (!auth) return deny401();

  if (request.method !== 'POST') return resp({ error: 'Método não permitido.' }, 405);

  /* ── 2. Env vars ── */
  const KEY   = (env.TRELLO_API_KEY || env.TRELLO_KEY || '').trim();
  const TOKEN = (env.TRELLO_TOKEN   || '').trim();
  if (!KEY || !TOKEN) return resp({ error: 'Env vars TRELLO_API_KEY e TRELLO_TOKEN são obrigatórias.' }, 500);
  const base = `key=${KEY}&token=${TOKEN}`;

  /* ── 3. Body ── */
  let cardIds = [];
  try {
    const body = await request.json();
    cardIds = Array.isArray(body.cardIds) ? body.cardIds : [];
  } catch (_) {
    return resp({ error: 'Body inválido. Esperado: { cardIds: string[] }' }, 400);
  }

  if (!cardIds.length) return resp({ comments: [] });

  // Limitar a 200 cards por chamada para não estourar tempo do Worker
  const ids = cardIds.slice(0, 200);

  /* ── 4. Buscar comentários em paralelo (lotes de 10) ── */
  const CONCURRENCY = 10;
  const allComments = [];

  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(cardId =>
        trelloGet(
          `https://api.trello.com/1/cards/${cardId}/actions?${base}&filter=commentCard&limit=50`
        ).then(actions => ({ cardId, actions }))
      )
    );

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { cardId, actions } = result.value;
      if (!Array.isArray(actions)) continue;

      for (const action of actions) {
        const text = (action.data?.text || '').trim();
        if (!text || text.length < 5) continue;

        // Filtrar comentários automáticos gerados pelo sistema
        const isAuto = /^(card (moved|archived|created|labeled)|checklist|attachment|due date)/i.test(text);
        if (isAuto) continue;

        allComments.push({
          cardId,
          text,
          author: action.memberCreator?.fullName || action.memberCreator?.username || '',
          date:   action.date || '',
        });
      }
    }
  }

  console.log(`[card-comments] ${ids.length} cards → ${allComments.length} comentários`);
  return resp({ comments: allComments });
};
