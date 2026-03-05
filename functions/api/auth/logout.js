/**
 * Cloudflare Pages Function — POST /api/auth/logout
 *
 * Apaga o cookie "session" e retorna { ok: true }.
 * Não requer sessão válida (usuário pode estar com token expirado).
 */

const _SC = 'session';

function resp(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...extra },
  });
}

export const onRequest = async ({ request }) => {
  if (request.method !== 'POST') return resp({ error: 'Método não permitido.' }, 405);
  const clear = `${_SC}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  return resp({ ok: true }, 200, { 'Set-Cookie': clear });
};
