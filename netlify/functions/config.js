/**
 * /.netlify/functions/config
 * Retorna: { role, email, name, boards:[{id,name}], colMappingDefault:{} }
 * Requer: Authorization: Bearer <netlify-identity-jwt>
 *
 * Qualquer usuário autenticado tem acesso (role = "viewer" por padrão).
 * Se o email estiver em ADMIN_EMAILS → role = "admin".
 * ALLOWED_EMAILS removida — qualquer usuário autenticado acessa (viewer por padrão).
 */

const TRELLO_API = 'https://api.trello.com/1';

function getUserRole(context) {
  const user = context?.clientContext?.user;
  if (!user) return null;
  const email = (user.email || '').toLowerCase();
  const admins = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email) ? 'admin' : 'viewer';
}

exports.handler = async (event, context) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  const role = getUserRole(context);
  if (!role) {
    return json(401, { error: 'Não autenticado. Faça login para continuar.' });
  }

  const user  = context.clientContext.user;
  const email = user.email || '';
  const name  = user.user_metadata?.full_name || user.user_metadata?.name || email;

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
    name,
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
