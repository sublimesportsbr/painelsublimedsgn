/**
 * Cloudflare Pages Function — POST /api/ai
 *
 * Proxy Groq (OpenAI-compatible). Recebe { snapshot } ou { prompt, memory }.
 * Requer cookie de sessão HS256 válido.
 * Env vars: GROQ_API_KEY, SESSION_SECRET
 */

// ── SESSION UTILS (inline em cada function) ──────────────────────────────────
// JWT mínimo assinado com HMAC-SHA-256. Sem dependências externas.
// Usa crypto.subtle, disponível nativamente no runtime do Cloudflare Workers.

const _SC  = 'session';                    // nome do cookie
const _MAX = 60 * 60 * 24 * 14;           // 14 dias em segundos

function _b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function _b64uDec(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
async function _hmacKey(secret, usage) {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, [usage]
  );
}
async function _signJWT(payload, secret) {
  const h   = _b64u(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const b   = _b64u(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await _hmacKey(secret, 'sign');
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h}.${b}`));
  return `${h}.${b}.${_b64u(sig)}`;
}
async function _verifyJWT(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const p = token.split('.');
  if (p.length !== 3) return null;
  try {
    const key   = await _hmacKey(secret, 'verify');
    const valid = await crypto.subtle.verify(
      'HMAC', key, _b64uDec(p[2]), new TextEncoder().encode(`${p[0]}.${p[1]}`)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(_b64uDec(p[1])));
    if (!payload.exp || Date.now() / 1000 > payload.exp) return null;
    return payload;          // { user, role, exp }
  } catch (_) { return null; }
}
function _cookies(req) {
  const out = {};
  for (const p of (req.headers.get('cookie') || '').split(';')) {
    const i = p.indexOf('=');
    if (i < 1) continue;
    try { out[decodeURIComponent(p.slice(0, i).trim())] = decodeURIComponent(p.slice(i + 1).trim()); }
    catch (_) {}
  }
  return out;
}
async function requireSession(request, env) {
  const secret = (env.SESSION_SECRET || '').trim();
  if (!secret) return null;
  return _verifyJWT(_cookies(request)[_SC] || '', secret);
}
function deny401() {
  return new Response(JSON.stringify({ error: 'Não autenticado.' }), {
    status: 401, headers: { 'Content-Type': 'application/json' },
  });
}
// ── END SESSION UTILS ─────────────────────────────────────────────────────────

const GROQ_URL       = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL_PRIMARY  = 'llama-3.3-70b-versatile';
const MODEL_FALLBACK = 'llama-3.1-8b-instant';

function resp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
async function callGroq(apiKey, model, sys, usr) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role:'system', content:sys }, { role:'user', content:usr }], temperature:0.3, max_tokens:2000 }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message || `Groq HTTP ${res.status}`); }
  const d = await res.json();
  return { text: d?.choices?.[0]?.message?.content || '', meta: { model: d?.model || model, tokens: d?.usage?.total_tokens || 0 } };
}
async function groq(apiKey, sys, usr) {
  try { return await callGroq(apiKey, MODEL_PRIMARY,  sys, usr); }
  catch (e) { console.warn('[ai] fallback:', e.message); return callGroq(apiKey, MODEL_FALLBACK, sys, usr); }
}
function cleanJSON(r) { return r.replace(/```json\s*/g,'').replace(/```\s*/g,'').trim(); }

function buildPrompt(s) {
  const pl = Object.entries(s.byPhase   ||{}).map(([ph,d])=>`  ${ph}: ${d.count} cards | mediana ${(+d.medianHours).toFixed(1)}h | p90 ${(+d.p90Hours).toFixed(1)}h`).join('\n');
  const sl = (s.topStuckCards||[]).slice(0,10).map(c=>`  "${c.title}" — ${(+c.hoursStuck).toFixed(1)}h | fase:${c.phase} | designer:${c.designer||'?'} | urgência:${c.urgency||'?'} | ${c.revisions} alt.`).join('\n');
  const dl = Object.entries(s.byDesigner||{}).slice(0,8).map(([n,d])=>`  ${n}: ${d.cards} cards | mediana ${(+d.medianCycleHours).toFixed(1)}h | ${(+d.revisionsAvg).toFixed(2)} alt/arte | ${d.stuckHigh} urgAlta parados`).join('\n');
  const vl = Object.entries(s.byVendor  ||{}).slice(0,8).map(([n,d])=>`  ${n}: ${d.cards} cards | ${d.highUrgency} urgAlta | ${(+d.revisionsAvg).toFixed(2)} alt/arte`).join('\n');
  const rk = s.riskSummary||{};
  const inactive = (s.inactiveFiltered||[]).join(', ') || 'nenhum';

  return `Você é Diretor de Operações analisando a equipe de criação da Sublime Sports (artes para uniformes esportivos).

Seu papel: agir como gestor experiente que interpreta dados, identifica padrões, diagnostica causas, prevê riscos e sugere decisões gerenciais. Nunca apenas descreva métricas — ligue dado → causa → impacto → ação.

## SNAPSHOT DO PAINEL
Total de pedidos (membros ativos): ${s.totals?.total||0}
Em criação: ${s.totals?.criacao||0} | Aprovados: ${s.totals?.aprovados||0}
Score médio de risco: ${(+(s.totals?.avgRisk||0)).toFixed(1)} | Críticos: ${rk.high||0} | Atenção: ${rk.medium||0}
Membros inativos excluídos da análise: ${inactive}

## POR FASE (count | mediana h | p90 h)
${pl||'  sem dados'}

## TOP CARDS TRAVADOS
${sl||'  sem dados'}

## DESIGNERS (cards | mediana ciclo h | alt/arte | urgAlta parados)
${dl||'  sem dados'}

## VENDEDORES (cards | urgAlta | alt/arte)
${vl||'  sem dados'}

## INSTRUÇÕES DE ANÁLISE
- Identifique gargalos, concentração de problemas, padrões vendedor×designer
- Diferencie problemas pontuais de sistêmicos
- Reconheça sinais positivos também
- Quando houver poucos dados, declare explicitamente
- Quando houver padrão forte, seja assertivo

Retorne APENAS JSON válido sem markdown, schema exato:
{"resumo_executivo":{"visao_geral":"string","principal_risco":"string","principal_oportunidade":"string","nivel_operacao":"estavel|atencao|critico"},"diagnostico_operacional":[{"area":"string","titulo":"string","descricao":"string","tipo":"critica|alta|media|baixa"}],"alertas_criticos":[{"titulo":"string","evidencia":"string","impacto":"string","prioridade":"critica|alta|media|baixa"}],"causas_provaveis":[{"causa":"string","evidencia":"string"}],"acoes_recomendadas":{"imediata":["string"],"curto_prazo":["string"],"estrutural":["string"]},"tendencias":[{"area":"string","titulo":"string","descricao":"string","direcao":"melhora|piora|estavel"}],"perguntas_gestao":["string"]}`;
}

export const onRequest = async ({ request, env }) => {
  /* ── 1. Auth ─────────────────────────────────────────────────────────────── */
  const auth = await requireSession(request, env);
  if (!auth) return deny401();

  if (request.method !== 'POST') return resp({ error: 'Método não permitido.' }, 405);

  /* ── 2. Env vars ─────────────────────────────────────────────────────────── */
  const apiKey = (env.GROQ_API_KEY || '').trim();
  if (!apiKey) return resp({ error: 'GROQ_API_KEY não configurada.' }, 500);

  /* ── 3. Body ─────────────────────────────────────────────────────────────── */
  let body = {};
  try { body = await request.json(); } catch (_) { return resp({ error: 'Body inválido.' }, 400); }

  const sys = 'Você é especialista em gestão de design operacional. Responda SOMENTE em JSON válido, sem markdown.';

  /* ── Modo 1: snapshot ────────────────────────────────────────────────────── */
  if (body.snapshot) {
    try {
      const r = await groq(apiKey, sys, buildPrompt(body.snapshot));
      const c = cleanJSON(r.text);
      try { JSON.parse(c); } catch (_) { return resp({ error: 'Resposta fora do formato JSON.', raw: c.slice(0,400) }, 502); }
      return resp({ text: c, meta: r.meta });
    } catch (err) { return resp({ error: 'Erro ao chamar Groq: ' + err.message }, 502); }
  }

  /* ── Modo 2: prompt livre ────────────────────────────────────────────────── */
  const prompt = (body.prompt || '').slice(0, 30000);
  if (!prompt) return resp({ error: 'Prompt vazio.' }, 400);
  const mem = body.memory || null;
  let ctx = '';
  if (mem) {
    const recent = (mem.feedback||[]).slice(-10);
    if (recent.length) ctx += `## Histórico:\n` + recent.map(f=>`[${f.type==='good'?'👍':'👎'} ${new Date(f.ts).toLocaleDateString('pt-BR')}] ${f.note||'(sem nota)'}`).join('\n') + '\n\n';
    if (mem.promptAdditions?.trim()) ctx += `## Instruções extras:\n${mem.promptAdditions.trim()}\n\n`;
  }
  try {
    const r = await groq(apiKey, sys, ctx ? `${ctx}---\n\n${prompt}` : prompt);
    const c = cleanJSON(r.text);
    try { JSON.parse(c); } catch (_) { return resp({ error: 'Resposta fora do formato JSON.', raw: c.slice(0,400) }, 502); }
    return new Response(c, { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) { return resp({ error: 'Erro ao chamar Groq: ' + err.message }, 502); }
};
