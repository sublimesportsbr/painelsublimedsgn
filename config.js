/**
 * /.netlify/functions/config
 * Retorna: { role, email, boards:[{id,name}], colMappingDefault:{} }
 * Requer: Authorization: Bearer <netlify-identity-jwt>
 */

const TRELLO_API = 'https://api.trello.com/1';

function getUser(event) {
  // Netlify Identity injeta clientContext no context, mas via Authorization header
  // também podemos checar o JWT manualmente ou confiar no clientContext
  const ctx = event.clientContext;
  if (ctx && ctx.user) return ctx.user;
  return null;
}

function getRole(email) {
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  const allowedEmails = (process.env.ALLOWED_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  const e = (email || '').toLowerCase();
  if (adminEmails.includes(e)) return 'ADMIN';
  if (allowedEmails.includes(e)) return 'VIEWER';
  return null;
}

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  const user = getUser(event);
  if (!user) {
    return json(401, { error: 'Não autenticado. Faça login para continuar.' });
  }

  const email = user.email || '';
  const role = getRole(email);
  if (!role) {
    return json(403, { error: 'Acesso não autorizado. Seu email não está na lista de acesso.' });
  }

  // Busca boards do Trello
  const key   = process.env.TRELLO_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) {
    return json(500, { error: 'Variáveis de ambiente TRELLO_KEY / TRELLO_TOKEN não configuradas.' });
  }

  let boards = [];
  try {
    const url = `${TRELLO_API}/members/me/boards?fields=id,name&filter=open&key=${key}&token=${token}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Trello HTTP ${res.status}`);
    boards = await res.json();
  } catch (err) {
    return json(502, { error: 'Falha ao buscar boards do Trello: ' + err.message });
  }

  return json(200, {
    role,
    email,
    name: user.user_metadata?.full_name || email,
    boards: boards.map(b => ({ id: b.id, name: b.name })),
    colMappingDefault: {}
  });
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
