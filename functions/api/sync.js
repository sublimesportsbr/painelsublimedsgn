/**
 * Cloudflare Pages Function — POST /api/sync
 *
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

/* ── Normalização (espelha DL.norm + DL.pickCF do frontend) ─────────────── */
function norm(s) {
  return String(s || '').trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function pickCF(cf, exactKeys, regex) {
  for (const k of exactKeys) { const v = cf[k]; if (v != null && v !== '') return String(v); }
  if (regex) for (const [k, v] of Object.entries(cf)) if (regex.test(k) && v != null && v !== '') return String(v);
  return '';
}
function mapCard(card, listMap, cfMap, optMap, boardName) {
  const cf = {};
  for (const item of (card.customFieldItems || [])) {
    const key = norm(cfMap[item.idCustomField] || item.idCustomField);
    let val = '';
    if (item.value) val = item.value.text ?? item.value.number ?? item.value.date ?? item.value.checked ?? '';
    else if (item.idValue) val = optMap[item.idValue] || '';
    if (cf[key] == null) cf[key] = String(val);
  }
  const labels = (card.labels || []).map(l => ({ name: l.name || l.color }));
  return {
    Title:             card.name             || '',
    List:              listMap[card.idList]  || '',
    Created:           card.dateLastActivity || '',
    Due:               card.due              || '',
    Labels:            labels,
    DESIGNER:          pickCF(cf, ['DESIGNER','CRIADOR','RESPONSAVEL','RESP DESIGN'],             /DESIGNER|CRIADOR|RESPONSAVEL/),
    VENDEDOR:          pickCF(cf, ['VENDEDOR','SOLICITANTE','COMERCIAL'],                          /VENDEDOR|SOLICIT/),
    'URGÊNCIA':        pickCF(cf, ['URGENCIA','URGENCIA (CRIACAO)','PRIORIDADE','NIVEL URGENCIA'], /URGENCIA|PRIOR/),
    'TIPO DE PEDIDO':  pickCF(cf, ['TIPO DE PEDIDO','TIPO DO PEDIDO','TIPO PEDIDO','TIPO'],        /TIPO.*PEDIDO|TIPO/),
    SEGMENTO:          pickCF(cf, ['SEGMENTO','SEGMENTO CLIENTE'],                                 /SEGMENTO/),
    'INÍCIO CRIAÇÃO':  pickCF(cf, ['INICIO CRIACAO','INICIO DA CRIACAO','INI CRIACAO','DATA INICIO'], /INICIO.*CRIA|INI.*CRIA/),
    'FIM CRIAÇÃO':     pickCF(cf, ['FIM CRIACAO','FIM DA CRIACAO','DATA FIM','FIM'],               /FIM.*CRIA/),
    'QTDE ALTERAÇÕES': pickCF(cf, ['QTDE ALTERACOES','QTDE DE ALTERACOES','NUM ALTERACOES','ALTERACOES','QTD ALTERACOES','QTDE ALT'], /QTDE.*ALTER|QTD.*ALTER|NUM.*ALTER|^ALTERACOES$/) || '0',
    'QTDE DE PEÇAS':   pickCF(cf, ['QTDE DE PECAS','QTDE PECAS','QTD PECAS','NUM PECAS','PECAS'], /QTDE.*PECA|QTD.*PECA|^PECAS$/) || '0',
    _trelloId:    card.id,
    _cardUrl:     card.url || (card.shortLink ? `https://trello.com/c/${card.shortLink}` : ''),
    _boardName:   boardName,
    _cfKeys:      Object.keys(cf),
    _attachments: Array.isArray(card.attachments) ? card.attachments : [],
  };
}
async function trelloGet(url, attempt = 1) {
  const res = await fetch(url);
  if (res.ok) return res.json();
  if (res.status === 429 && attempt < 4) { await new Promise(r => setTimeout(r, attempt * 1000)); return trelloGet(url, attempt + 1); }
  throw new Error(`Trello API ${res.status}`);
}
function resp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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
  if (!allowedIds.length) return resp({ error: 'TRELLO_ALLOWED_BOARD_IDS está vazia.' }, 500);
  const base = `key=${KEY}&token=${TOKEN}`;

  /* ── 3. colMapping opcional ──────────────────────────────────────────────── */
  let colMapping = {};
  try { ({ colMapping = {} } = await request.json()); } catch (_) {}

  /* ── 4. Sincroniza boards ────────────────────────────────────────────────── */
  try {
    const allRows = [];
    for (const boardId of allowedIds) {
      const [boardInfo, lists, cards, cfdefs] = await Promise.all([
        trelloGet(`https://api.trello.com/1/boards/${boardId}?fields=id,name&${base}`),
        trelloGet(`https://api.trello.com/1/boards/${boardId}/lists?fields=id,name&${base}`),
        trelloGet(`https://api.trello.com/1/boards/${boardId}/cards?fields=id,name,idList,labels,due,dateLastActivity,url,shortLink&attachments=true&attachment_fields=name,url&customFieldItems=true&limit=1000&${base}`),
        trelloGet(`https://api.trello.com/1/boards/${boardId}/customFields?${base}`).catch(() => []),
      ]);
      const boardName = boardInfo.name || boardId;
      const listMap = {};
      for (const l of lists) listMap[l.id] = colMapping[l.id] || l.name;
      const cfMap = {}, optMap = {};
      for (const cf of cfdefs) {
        cfMap[cf.id] = norm(cf.name);
        for (const opt of (cf.options || [])) optMap[opt.id] = String(opt?.value?.text || opt?.value || '');
      }
      const rows = cards.map(c => mapCard(c, listMap, cfMap, optMap, boardName));
      allRows.push(...rows);
      console.log(`[sync] "${boardName}": ${rows.length} cards`);
    }
    return resp({ rows: allRows, syncedAt: new Date().toISOString(), boardCount: allowedIds.length });
  } catch (err) {
    console.error('[sync]', err.message);
    return resp({ error: err.message }, 500);
  }
};
