/**
 * /.netlify/functions/sync
 * Retorna dataset consolidado de TODOS os boards no formato que o front espera.
 * POST body: { colMapping?: {listId: "NOME_STATUS"} }
 * Requer: Authorization: Bearer <netlify-identity-jwt>
 */

const TRELLO_API = 'https://api.trello.com/1';
const FIELDS     = 'id,name,idList,labels,due,dateLastActivity,url,shortLink';

// Qualquer usuário autenticado tem acesso. ALLOWED_EMAILS removida.
// role = "admin" se email estiver em ADMIN_EMAILS, senão "viewer".
function getUserRole(context) {
  const user = context?.clientContext?.user;
  if (!user) return null;
  const email = (user.email || '').toLowerCase();
  const admins = (process.env.ADMIN_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return admins.includes(email) ? 'admin' : 'viewer';
}

async function trelloGet(path) {
  const key   = process.env.TRELLO_KEY;
  const token = process.env.TRELLO_TOKEN;
  const sep   = path.includes('?') ? '&' : '?';
  const url   = `${TRELLO_API}${path}${sep}key=${key}&token=${token}`;
  const res   = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Trello ${path} → HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchBoardData(boardId, colMapping) {
  const [boardInfo, lists, cards, cfdefs] = await Promise.all([
    trelloGet(`/boards/${boardId}?fields=id,name`),
    trelloGet(`/boards/${boardId}/lists?fields=id,name`),
    trelloGet(`/boards/${boardId}/cards?fields=${FIELDS}&attachments=true&attachment_fields=name,url&customFieldItems=true&limit=1000`),
    trelloGet(`/boards/${boardId}/customFields`).catch(() => []),
  ]);

  const boardName = boardInfo.name || '';

  // Build list map: id → display name (via colMapping or original name)
  const listMap = {};
  lists.forEach(l => {
    listMap[l.id] = colMapping?.[l.id] || l.name;
  });

  // Build CF maps
  const cfMap  = {}; // cfId → normalized name
  const optMap = {}; // optionId → text
  cfdefs.forEach(cf => {
    cfMap[cf.id] = normStr(cf.name);
    if (cf.options) cf.options.forEach(o => { optMap[o.id] = o.value?.text || ''; });
  });

  // Map each card to a row
  const rows = cards.map(card => mapCard(card, listMap, cfMap, optMap, boardName));
  return rows.filter(Boolean);
}

function normStr(s) {
  if (!s) return '';
  return String(s).trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function getCFValue(card, cfMap, optMap, ...keys) {
  const items = card.customFieldItems || [];
  const normalizedKeys = keys.map(normStr);
  for (const item of items) {
    const name = cfMap[item.idCustomField] || '';
    if (normalizedKeys.some(k => name.includes(k))) {
      if (item.value?.text)   return item.value.text;
      if (item.value?.date)   return item.value.date;
      if (item.value?.number) return String(item.value.number);
      if (item.idValue)       return optMap[item.idValue] || '';
    }
  }
  return '';
}

function mapCard(card, listMap, cfMap, optMap, boardName) {
  if (!card || !card.id) return null;

  const labels = (card.labels || []).map(l => l.name || l.color).filter(Boolean);

  const designer   = getCFValue(card, cfMap, optMap, 'DESIGNER', 'RESPONSAVEL');
  const vendedor   = getCFValue(card, cfMap, optMap, 'VENDEDOR', 'CLIENTE');
  const urgencia   = getCFValue(card, cfMap, optMap, 'URGENCIA', 'URGÊNCIA', 'PRIORIDADE');
  const tipo       = getCFValue(card, cfMap, optMap, 'TIPO DE PEDIDO', 'TIPO PEDIDO', 'TIPO');
  const segmento   = getCFValue(card, cfMap, optMap, 'SEGMENTO', 'CATEGORIA');
  const iniCriacao = getCFValue(card, cfMap, optMap, 'INICIO CRIACAO', 'INÍCIO CRIAÇÃO', 'INICIO');
  const fimCriacao = getCFValue(card, cfMap, optMap, 'FIM CRIACAO', 'FIM CRIAÇÃO', 'FIM');
  const qtdeAlt    = getCFValue(card, cfMap, optMap, 'QTDE ALTERACOES', 'QTDE ALTERAÇÕES', 'ALTERACOES', 'ALTERAÇÕES');
  const qtdePecas  = getCFValue(card, cfMap, optMap, 'QTDE DE PECAS', 'QTDE PECAS', 'QTD PECAS', 'PECAS');

  return {
    'Title':           card.name || '',
    'List':            listMap[card.idList] || '',
    'Created':         card.dateLastActivity || '',
    'Due':             card.due || '',
    'Labels':          labels.join(', '),
    'DESIGNER':        designer,
    'VENDEDOR':        vendedor,
    'URGÊNCIA':        urgencia,
    'TIPO DE PEDIDO':  tipo,
    'SEGMENTO':        segmento,
    'INÍCIO CRIAÇÃO':  iniCriacao,
    'FIM CRIAÇÃO':     fimCriacao,
    'QTDE ALTERAÇÕES': qtdeAlt,
    'QTDE DE PEÇAS':   qtdePecas,
    _trelloId:         card.id,
    _cardUrl:          card.url || (card.shortLink ? 'https://trello.com/c/' + card.shortLink : ''),
    _boardName:        boardName,
    _cfKeys:           Object.keys(cfMap),
    _attachments:      Array.isArray(card.attachments) ? card.attachments : [],
  };
}

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  const role = getUserRole(context);
  if (!role) return json(401, { error: 'Não autenticado.' });

  const key   = process.env.TRELLO_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) return json(500, { error: 'TRELLO_KEY / TRELLO_TOKEN não configurados.' });

  // Parse optional colMapping from body
  let colMapping = {};
  try {
    if (event.body) {
      const body = JSON.parse(event.body);
      colMapping = body.colMapping || {};
    }
  } catch (_) {}

  try {
    // Fetch all accessible boards
    const boards = await trelloGet('/members/me/boards?fields=id,name&filter=open');

    // Fetch all boards in parallel (with concurrency guard)
    const CHUNK = 3;
    let allRows = [];
    for (let i = 0; i < boards.length; i += CHUNK) {
      const chunk = boards.slice(i, i + CHUNK);
      const results = await Promise.all(
        chunk.map(b => fetchBoardData(b.id, colMapping).catch(err => {
          console.warn(`[sync] board ${b.id} error:`, err.message);
          return [];
        }))
      );
      results.forEach(r => allRows.push(...r));
    }

    return json(200, {
      rows:      allRows,
      fetchedAt: new Date().toISOString(),
      boards:    boards.map(b => ({ id: b.id, name: b.name })),
      total:     allRows.length,
    });

  } catch (err) {
    console.error('[sync] error:', err);
    return json(502, { error: 'Erro ao sincronizar dados: ' + err.message });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(body),
  };
}
