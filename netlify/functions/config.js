// netlify/functions/config.js
// Retorna dados do usuário logado e apenas os boards permitidos via TRELLO_ALLOWED_BOARD_IDS

const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  // ── 1. Validar variável de ambiente ──────────────────────────────────────
  const allowedEnv = process.env.TRELLO_ALLOWED_BOARD_IDS;

  if (!allowedEnv || !allowedEnv.trim()) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Missing TRELLO_ALLOWED_BOARD_IDS env var' }),
    };
  }

  // ── 2. Montar array de IDs permitidos (trim para evitar espaços acidentais) ──
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

  try {
    // ── 4. Buscar dados do usuário logado ──────────────────────────────────
    const meRes = await fetch(
      `https://api.trello.com/1/members/me?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
    );
    if (!meRes.ok) throw new Error(`Trello /members/me error: ${meRes.status}`);
    const me = await meRes.json();

    // ── 5. Buscar todos os boards do usuário (apenas id e name) ───────────
    const boardsRes = await fetch(
      `https://api.trello.com/1/members/me/boards?fields=id,name&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`
    );
    if (!boardsRes.ok) throw new Error(`Trello /members/me/boards error: ${boardsRes.status}`);
    const allBoards = await boardsRes.json();

    // ── 6. Filtrar apenas os boards permitidos (por ID) ───────────────────
    const filteredBoards = allBoards.filter(board => allowedIds.includes(board.id));

    // ── 7. Retornar resposta ───────────────────────────────────────────────
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: {
          id:       me.id,
          fullName: me.fullName,
          username: me.username,
          email:    me.email || null,
        },
        boards: filteredBoards,  // ← apenas os boards da allowlist
      }),
    };

  } catch (err) {
    console.error('[config] Error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
