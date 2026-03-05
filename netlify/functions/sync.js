// netlify/functions/sync.js
// Sincroniza cards, listas e dados SOMENTE dos boards em TRELLO_ALLOWED_BOARD_IDS

const fetch = require('node-fetch');

// ── Helper: fetch com retry simples ─────────────────────────────────────────
async function trelloGet(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (res.status === 429) {
      // Rate-limit: aguarda antes de tentar novamente
      const wait = attempt * 1000;
      console.warn(`[sync] Rate-limit hit, waiting ${wait}ms (attempt ${attempt})`);
      await new Promise(r => setTimeout(r, wait));
    } else {
      throw new Error(`Trello API error ${res.status} for ${url}`);
    }
  }
  throw new Error(`Trello API failed after ${retries} retries: ${url}`);
}

exports.handler = async (event, context) => {
  // ── 1. Validar variável de ambiente ──────────────────────────────────────
  const allowedEnv = process.env.TRELLO_ALLOWED_BOARD_IDS;

  if (!allowedEnv || !allowedEnv.trim()) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Missing TRELLO_ALLOWED_BOARD_IDS env var' }),
    };
  }

  // ── 2. Montar array de IDs permitidos ────────────────────────────────────
  const allowedIds = allowedEnv
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

  if (allowedIds.length === 0) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'TRELLO_ALLOWED_BOARD_IDS is empty after parsing' }),
    };
  }

  // ── 3. Credenciais do Trello ─────────────────────────────────────────────
  const TRELLO_KEY   = process.env.TRELLO_API_KEY;
  const TRELLO_TOKEN = process.env.TRELLO_TOKEN;

  if (!TRELLO_KEY || !TRELLO_TOKEN) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Missing TRELLO_API_KEY or TRELLO_TOKEN env var' }),
    };
  }

  const base = `key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;

  try {
    // ── 4. Sincronizar SOMENTE os boards da allowlist ─────────────────────
    const results = [];

    for (const boardId of allowedIds) {
      console.log(`[sync] Processing board: ${boardId}`);

      // 4a. Dados básicos do board
      const board = await trelloGet(
        `https://api.trello.com/1/boards/${boardId}?fields=id,name,url,prefs,dateLastActivity&${base}`
      );

      // 4b. Listas do board
      const lists = await trelloGet(
        `https://api.trello.com/1/boards/${boardId}/lists?fields=id,name,pos,closed&${base}`
      );

      // 4c. Cards do board (campos relevantes para o painel)
      const cards = await trelloGet(
        `https://api.trello.com/1/boards/${boardId}/cards?` +
        `fields=id,name,idList,idMembers,labels,due,dueComplete,dateLastActivity,` +
        `desc,url,pos,closed,customFieldItems&` +
        `customFieldItems=true&${base}`
      );

      // 4d. Custom Fields definidos no board
      const customFields = await trelloGet(
        `https://api.trello.com/1/boards/${boardId}/customFields?${base}`
      );

      // 4e. Membros do board
      const members = await trelloGet(
        `https://api.trello.com/1/boards/${boardId}/members?fields=id,fullName,username&${base}`
      );

      results.push({
        board,
        lists,
        cards,
        customFields,
        members,
      });
    }

    // ── 5. Retornar payload consolidado ──────────────────────────────────
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        syncedAt:     new Date().toISOString(),
        boardCount:   results.length,
        allowedIds,            // útil para debug no cliente
        data:         results,
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
