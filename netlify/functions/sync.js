// netlify/functions/sync.js
// Sincroniza SOMENTE os boards em TRELLO_ALLOWED_BOARD_IDS
// Retorna { rows: [...] } no formato exato esperado pelo frontend (data.rows)



// ── Helpers de normalização (espelham DL._n e DL._pickCF do frontend) ────────

function norm(s) {
  return String(s || '').trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function pickCF(cf, exactKeys, regex) {
  for (const k of exactKeys) {
    const v = cf[k];
    if (v != null && v !== '') return String(v);
  }
  if (regex) {
    for (const [key, val] of Object.entries(cf)) {
      if (regex.test(key) && val != null && val !== '') return String(val);
    }
  }
  return '';
}

function mapCard(card, listMap, cfMap, optMap, boardName) {
  const cf = {};
  (card.customFieldItems || []).forEach(item => {
    const rawName  = cfMap[item.idCustomField] || item.idCustomField;
    const normName = norm(rawName);
    let val = '';
    if (item.value) {
      val = item.value.text ?? item.value.number ?? item.value.date ?? item.value.checked ?? '';
    } else if (item.idValue) {
      val = optMap[item.idValue] || '';
    }
    if (cf[normName] == null) cf[normName] = String(val);
  });

  const labels = (card.labels || []).map(l => ({ name: l.name || l.color }));

  const urgencia   = pickCF(cf, ['URGENCIA','URGENCIA (CRIACAO)','PRIORIDADE','PRIORIDADE ARTE','NIVEL URGENCIA'], /URGENCIA|PRIOR/);
  const tipo       = pickCF(cf, ['TIPO DE PEDIDO','TIPO DO PEDIDO','TIPO PEDIDO','TIPO'], /TIPO.*PEDIDO|TIPO/);
  const designer   = pickCF(cf, ['DESIGNER','CRIADOR','RESPONSAVEL','RESP DESIGN'], /DESIGNER|CRIADOR|RESPONSAVEL/);
  const vendedor   = pickCF(cf, ['VENDEDOR','SOLICITANTE','COMERCIAL'], /VENDEDOR|SOLICIT/);
  const segmento   = pickCF(cf, ['SEGMENTO','SEGMENTO CLIENTE'], /SEGMENTO/);
  const iniCriacao = pickCF(cf, ['INICIO CRIACAO','INICIO DA CRIACAO','INI CRIACAO','DATA INICIO','INICIO'], /INICIO.*CRIA|INI.*CRIA/);
  const fimCriacao = pickCF(cf, ['FIM CRIACAO','FIM DA CRIACAO','DATA FIM','FIM'], /FIM.*CRIA/);
  const qtdeAlt    = pickCF(cf, ['QTDE ALTERACOES','QTDE DE ALTERACOES','NUM ALTERACOES','ALTERACOES','QTD ALTERACOES','QTDE ALT'], /QTDE.*ALTER|QTD.*ALTER|NUM.*ALTER|ALTER/) || '0';
  const qtdePecas  = pickCF(cf, ['QTDE DE PECAS','QTDE PECAS','QTD PECAS','NUM PECAS','PECAS'], /QTDE.*PECA|QTD.*PECA|PECA/) || '0';

  return {
    'Title':           card.name || '',
    'List':            listMap[card.idList] || '',
    'Created':         card.dateLastActivity || '',
    'Due':             card.due || '',
    'Labels':          labels,
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
    _cfKeys:           Object.keys(cf),
    _attachments:      Array.isArray(card.attachments) ? card.attachments : [],
  };
}

// ── Helper: fetch com retry para rate-limit ──────────────────────────────────

async function trelloGet(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (res.status === 429) {
      const wait = attempt * 1000;
      console.warn(`[sync] Rate-limit, aguardando ${wait}ms (tentativa ${attempt})`);
      await new Promise(r => setTimeout(r, wait));
    } else {
      throw new Error(`Trello API error ${res.status} — ${url}`);
    }
  }
  throw new Error(`Trello API falhou após ${retries} tentativas`);
}

// ── Handler principal ────────────────────────────────────────────────────────

exports.handler = async (event, context) => {

  // 1. Validar TRELLO_ALLOWED_BOARD_IDS
  const allowedEnv = process.env.TRELLO_ALLOWED_BOARD_IDS;
  if (!allowedEnv || !allowedEnv.trim()) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Missing TRELLO_ALLOWED_BOARD_IDS env var' }),
    };
  }

  const allowedIds = allowedEnv.split(',').map(id => id.trim()).filter(Boolean);
  if (allowedIds.length === 0) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'TRELLO_ALLOWED_BOARD_IDS is empty after parsing' }),
    };
  }

  // 2. Validar credenciais (aceita TRELLO_API_KEY ou TRELLO_KEY)
  const TRELLO_KEY   = process.env.TRELLO_API_KEY || process.env.TRELLO_KEY;
  const TRELLO_TOKEN = process.env.TRELLO_TOKEN;

  if (!TRELLO_KEY || !TRELLO_TOKEN) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Missing TRELLO_KEY/TRELLO_API_KEY or TRELLO_TOKEN env var' }),
    };
  }

  const base = `key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;

  // 3. Ler colMapping enviado pelo frontend (opcional)
  let colMapping = {};
  try {
    const body = JSON.parse(event.body || '{}');
    colMapping = body.colMapping || {};
  } catch (_) {}

  try {
    const allRows = [];

    // 4. Iterar apenas pelos boards da allowlist
    for (const boardId of allowedIds) {
      console.log(`[sync] Processando board: ${boardId}`);

      const [boardInfo, lists, cards, cfdefs] = await Promise.all([
        trelloGet(`https://api.trello.com/1/boards/${boardId}?fields=id,name&${base}`),
        trelloGet(`https://api.trello.com/1/boards/${boardId}/lists?fields=id,name&${base}`),
        trelloGet(
          `https://api.trello.com/1/boards/${boardId}/cards?` +
          `fields=id,name,idList,labels,due,dateLastActivity,url,shortLink&` +
          `attachments=true&attachment_fields=name,url&` +
          `customFieldItems=true&limit=1000&${base}`
        ),
        trelloGet(`https://api.trello.com/1/boards/${boardId}/customFields?${base}`)
          .catch(() => []),
      ]);

      const boardName = boardInfo.name || '';

      const listMap = {};
      lists.forEach(l => { listMap[l.id] = colMapping[l.id] || l.name; });

      const cfMap  = {};
      const optMap = {};
      cfdefs.forEach(cf => {
        cfMap[cf.id] = norm(cf.name);
        if (Array.isArray(cf.options)) {
          cf.options.forEach(opt => {
            const txt = opt?.value?.text || opt?.value || '';
            optMap[opt.id] = String(txt);
          });
        }
      });

      const rows = cards.map(card => mapCard(card, listMap, cfMap, optMap, boardName));
      allRows.push(...rows);

      console.log(`[sync] Board "${boardName}": ${rows.length} cards`);
    }

    // 5. Retorna { rows } — formato exato que o frontend consome em data.rows
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows:       allRows,
        syncedAt:   new Date().toISOString(),
        boardCount: allowedIds.length,
      }),
    };

  } catch (err) {
    console.error('[sync] Error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
