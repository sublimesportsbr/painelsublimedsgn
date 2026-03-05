/**
 * /.netlify/functions/ai
 * Proxy para Groq (OpenAI-compatible). Recebe { snapshot } ou { prompt, memory }.
 * POST body: { snapshot?: object } | { prompt?: string, memory?: object }
 * Requer: Authorization: Bearer <netlify-identity-jwt>
 * Env vars: GROQ_API_KEY
 */

const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL_PRIMARY  = 'llama-3.3-70b-versatile';
const MODEL_FALLBACK = 'llama-3.1-8b-instant';

function getUserRole(context) {
  const user = context?.clientContext?.user;
  if (!user) return null;
  const email = (user.email || '').toLowerCase();
  const admins = (process.env.ADMIN_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return admins.includes(email) ? 'admin' : 'viewer';
}

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

async function callGroq(apiKey, model, systemMsg, userMsg) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user',   content: userMsg   },
      ],
      temperature: 0.3,
      max_tokens: 700,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Groq HTTP ${res.status}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return {
    text,
    meta: {
      model:  data?.model || model,
      tokens: data?.usage?.total_tokens || 0,
    },
  };
}

// ── Build prompt from snapshot ────────────────────────────────────────────────
function buildPromptFromSnapshot(snapshot) {
  const s = snapshot;

  const phaseLines = Object.entries(s.byPhase || {})
    .map(([phase, d]) =>
      `  ${phase}: ${d.count} cards | mediana ${d.medianHours.toFixed(1)}h | p90 ${d.p90Hours.toFixed(1)}h`
    ).join('\n');

  const stuckLines = (s.topStuckCards || []).slice(0, 10)
    .map(c => `  "${c.title}" — ${c.hoursStuck.toFixed(1)}h | fase: ${c.phase} | designer: ${c.designer || '?'} | urgência: ${c.urgency || '?'}`)
    .join('\n');

  const designerLines = Object.entries(s.byDesigner || {}).slice(0, 8)
    .map(([n, d]) =>
      `  ${n}: ${d.cards} cards | mediana ${d.medianCycleHours.toFixed(1)}h | ${d.revisionsAvg.toFixed(2)} alt/arte | ${d.stuckHigh} urgência-alta-parados`
    ).join('\n');

  const vendorLines = Object.entries(s.byVendor || {}).slice(0, 8)
    .map(([n, d]) =>
      `  ${n}: ${d.cards} cards | ${d.highUrgency} urgência-alta | ${d.revisionsAvg.toFixed(2)} alt/arte média`
    ).join('\n');

  const risk = s.riskSummary || {};

  return `Você é consultor sênior de operações criativas para Sublime Sports (artes para uniformes esportivos).

## SNAPSHOT DO PAINEL
Total de cards: ${s.totals?.total || 0}
Em criação: ${s.totals?.criacao || 0} | Aprovados: ${s.totals?.aprovados || 0}
Score médio de risco: ${(s.totals?.avgRisk || 0).toFixed(1)}
Críticos (score ≥6): ${risk.high || 0} | Atenção (score 3–5): ${risk.medium || 0}

## POR FASE (count | mediana h | p90 h)
${phaseLines || '  sem dados'}

## TOP CARDS MAIS TRAVADOS
${stuckLines || '  sem dados'}

## DESIGNERS (cards | mediana ciclo h | alt/arte | urgAlta parados)
${designerLines || '  sem dados'}

## VENDEDORES (cards | urgAlta | alt/arte)
${vendorLines || '  sem dados'}

## INSTRUÇÕES
Retorne APENAS JSON válido sem markdown nem texto extra, usando EXATAMENTE este schema:
{"resumo":"string","gargalos":[{"fase":"string","problema":"string","acao":"string"}],"designers":[{"nome":"string","status":"ok|atencao|critico","obs":"string"}],"vendedores":[{"nome":"string","status":"ok|atencao|critico","obs":"string"}],"proximos_passos":["string"]}`;
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Método não permitido.' });
  }

  const role = getUserRole(context);
  if (!role) return json(401, { error: 'Não autenticado.' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return json(500, { error: 'GROQ_API_KEY não configurada.' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return json(400, { error: 'Body inválido.' }); }

  // ── Modo 1: snapshot (novo fluxo de análise inteligente) ──────────────────
  if (body.snapshot) {
    const userMsg = buildPromptFromSnapshot(body.snapshot);
    const systemMsg = 'Você é um especialista em gestão de design operacional. Responda SOMENTE em JSON válido, sem markdown.';

    try {
      let result;
      try {
        result = await callGroq(apiKey, MODEL_PRIMARY, systemMsg, userMsg);
      } catch (e) {
        console.warn('[ai] Primary model failed, trying fallback:', e.message);
        result = await callGroq(apiKey, MODEL_FALLBACK, systemMsg, userMsg);
      }

      const cleaned = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      try { JSON.parse(cleaned); } catch (_) {
        return json(502, { error: 'Resposta fora do formato JSON.', raw: cleaned.slice(0, 400) });
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        body: JSON.stringify({ text: cleaned, meta: result.meta }),
      };

    } catch (err) {
      console.error('[ai] Groq error:', err.message);
      return json(502, { error: 'Erro ao chamar Groq: ' + err.message });
    }
  }

  // ── Modo 2: prompt livre (compatibilidade com fluxo anterior) ─────────────
  let prompt = (body.prompt || '').slice(0, 30000);
  const memory = body.memory || null;
  if (!prompt) return json(400, { error: 'Prompt vazio.' });

  // Injeta memória do usuário no prompt
  let memCtx = '';
  if (memory) {
    const recent = (memory.feedback || []).slice(-10);
    if (recent.length) {
      memCtx += `## Histórico de feedback (últimos ${recent.length}):\n`;
      memCtx += recent.map(f =>
        `[${f.type === 'good' ? '👍' : '👎'} ${new Date(f.ts).toLocaleDateString('pt-BR')}] ${f.note || '(sem nota)'}`
      ).join('\n') + '\n\n';
    }
    if (memory.promptAdditions?.trim()) {
      memCtx += `## Instruções extras:\n${memory.promptAdditions.trim()}\n\n`;
    }
  }
  const fullPrompt = memCtx ? `${memCtx}---\n\n${prompt}` : prompt;
  const systemMsg2 = 'Você é consultor sênior em gestão de design operacional. Responda SOMENTE em JSON válido, sem markdown.';

  try {
    let result;
    try {
      result = await callGroq(apiKey, MODEL_PRIMARY, systemMsg2, fullPrompt);
    } catch (e) {
      console.warn('[ai] Primary model failed, trying fallback:', e.message);
      result = await callGroq(apiKey, MODEL_FALLBACK, systemMsg2, fullPrompt);
    }

    const cleaned = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try { JSON.parse(cleaned); } catch (_) {
      return json(502, { error: 'Resposta fora do formato JSON.', raw: cleaned.slice(0, 400) });
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      body: cleaned,
    };

  } catch (err) {
    console.error('[ai] Groq error:', err.message);
    return json(502, { error: 'Erro ao chamar Groq: ' + err.message });
  }
};
