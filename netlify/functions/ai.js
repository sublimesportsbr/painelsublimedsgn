/**
 * /.netlify/functions/ai
 * Proxy para Gemini. Recebe prompt + memória, retorna JSON estruturado.
 * POST body: { prompt: string, memory?: { feedback:[], promptAdditions:string } }
 * Requer: Authorization: Bearer <netlify-identity-jwt>
 */

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-04-17:generateContent';

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

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Método não permitido.' });
  }

  const role = getUserRole(context);
  if (!role) return json(401, { error: 'Não autenticado.' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return json(500, { error: 'GEMINI_API_KEY não configurada.' });

  let prompt = '';
  let memory = null;
  try {
    const body = JSON.parse(event.body || '{}');
    prompt  = (body.prompt || '').slice(0, 30000); // safety limit
    memory  = body.memory || null;
  } catch (_) {
    return json(400, { error: 'Body inválido.' });
  }

  if (!prompt) return json(400, { error: 'Prompt vazio.' });

  // Build memory context to prepend
  let memCtx = '';
  if (memory) {
    const recent = (memory.feedback || []).slice(-10);
    if (recent.length) {
      const feedbackSummary = recent.map(f =>
        `[${f.type === 'good' ? '👍' : '👎'} ${new Date(f.ts).toLocaleDateString('pt-BR')}] ${f.note || '(sem nota)'}`
      ).join('\n');
      memCtx += `## Histórico de feedback do usuário (últimos ${recent.length}):\n${feedbackSummary}\n\n`;
    }
    if (memory.promptAdditions && memory.promptAdditions.trim()) {
      memCtx += `## Instruções extras do usuário:\n${memory.promptAdditions.trim()}\n\n`;
    }
  }

  const fullPrompt = memCtx ? `${memCtx}---\n\n${prompt}` : prompt;

  try {
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: fullPrompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Gemini HTTP ${res.status}`);
    }

    const data = await res.json();
    // Gemini returns: data.candidates[0].content.parts[0].text
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    // Validate it's parseable JSON before returning
    try { JSON.parse(cleaned); } catch (_) {
      return json(502, { error: 'Resposta da IA fora do formato esperado.', raw: cleaned.slice(0, 500) });
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      body: cleaned, // Return raw JSON string directly (already valid JSON)
    };

  } catch (err) {
    console.error('[ai] Gemini error:', err);
    return json(502, { error: 'Erro ao chamar Gemini: ' + err.message });
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
