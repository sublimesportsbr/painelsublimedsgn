// netlify/functions/comments.js
// Busca comentários de alteração nos boards permitidos dentro de um range de datas.
// POST body: { fromISO: string, toISO: string }
// Retorna: { actions: [{ date, cardId, text, type }] }
// type: 'start' = "alteração iniciada" | 'end' = "alteração concluída"



const RE_CONCLUIDA = /altera[cç][aã]o\s+conclu[ií]da!?/i;
const RE_INICIADA  = /altera[cç][aã]o\s+iniciada/i;

async function trelloGet(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (res.status === 429) {
      const wait = attempt * 1000;
      console.warn(`[comments] Rate-limit, aguardando ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    } else {
      throw new Error(`Trello API error ${res.status} — ${url}`);
    }
  }
  throw new Error('Trello API falhou após retries');
}

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Método não permitido.' }) };
  }

  // ── Credenciais ────────────────────────────────────────────────────────────
  const TRELLO_KEY   = process.env.TRELLO_API_KEY || process.env.TRELLO_KEY;
  const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
  if (!TRELLO_KEY || !TRELLO_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing TRELLO_KEY or TRELLO_TOKEN env var' }) };
  }

  // ── Boards permitidos ──────────────────────────────────────────────────────
  const allowedEnv = process.env.TRELLO_ALLOWED_BOARD_IDS;
  if (!allowedEnv || !allowedEnv.trim()) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing TRELLO_ALLOWED_BOARD_IDS env var' }) };
  }
  const allowedIds = allowedEnv.split(',').map(id => id.trim()).filter(Boolean);

  // ── Body ───────────────────────────────────────────────────────────────────
  let fromISO, toISO;
  try {
    const body = JSON.parse(event.body || '{}');
    fromISO = body.fromISO;
    toISO   = body.toISO;
  } catch (_) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Body inválido.' }) };
  }
  if (!fromISO || !toISO) {
    return { statusCode: 400, body: JSON.stringify({ error: 'fromISO e toISO são obrigatórios.' }) };
  }

  const base = `key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
  const allActions = [];

  try {
    for (const boardId of allowedIds) {
      const pageSize = 1000;
      let lastId = null;
      let keepFetching = true;

      while (keepFetching) {
        const beforeParam = lastId ? `&before=${lastId}` : '';
        const url = `https://api.trello.com/1/boards/${boardId}/actions?${base}`
          + `&filter=commentCard&limit=${pageSize}`
          + `&since=${encodeURIComponent(fromISO)}`
          + beforeParam;

        let page;
        try { page = await trelloGet(url); } catch (_) { break; }
        if (!page || !page.length) { keepFetching = false; break; }

        for (const act of page) {
          const actDate = act.date || '';
          if (toISO && actDate > toISO) continue;
          const text   = act.data?.text || '';
          const cardId = act.data?.card?.id || null;
          if (!cardId) continue;

          let typ = null;
          if (RE_CONCLUIDA.test(text)) typ = 'end';
          else if (RE_INICIADA.test(text)) typ = 'start';
          if (typ) allActions.push({ date: actDate, cardId, text, type: typ });
        }

        if (page.length < pageSize) keepFetching = false;
        else lastId = page[page.length - 1].id;
      }

      console.log(`[comments] board=${boardId} found=${allActions.length} so far`);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: allActions }),
    };

  } catch (err) {
    console.error('[comments] Error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
