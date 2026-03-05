# PAINEL SUBLIME — Guia de Deploy no Netlify

## Estrutura do projeto

```
/
├── PAINEL_SUBLIME_v20.html     ← app estático (página principal)
├── netlify.toml                ← configuração do Netlify
└── netlify/
    └── functions/
        ├── config.js           ← retorna role + lista de boards
        ├── sync.js             ← consolida dados de todos os boards
        └── ai.js               ← proxy para Gemini
```

---

## Passo a Passo

### 1. Criar o site no Netlify

- Suba este projeto para um repositório Git (GitHub, GitLab ou Bitbucket).
- No Netlify: **Add new site → Import an existing project**.
- Selecione o repositório. O `netlify.toml` já configura tudo automaticamente.
- **Publish directory:** `.` (raiz)
- **Build command:** deixe vazio (app estático, sem build)

---

### 2. Ativar Netlify Identity

No painel do site no Netlify:
- Vá em **Site settings → Identity → Enable Identity**
- Em **Registration preferences**, selecione **Invite only**
  - Isso impede auto-cadastro público.
- Em **External providers**, desative tudo (só email/senha).

---

### 3. Convidar usuários

- Acesse **Identity → Invite users**
- Informe o e-mail de cada usuário autorizado
- O usuário receberá um convite por email para definir senha

---

### 4. Configurar variáveis de ambiente

No Netlify: **Site settings → Environment variables → Add variable**

| Variável           | Valor                                                             |
|--------------------|-------------------------------------------------------------------|
| `TRELLO_KEY`       | Sua API Key do Trello (trello.com/app-key)                       |
| `TRELLO_TOKEN`     | Seu Token do Trello (mesmo página, clique em "Token")            |
| `GEMINI_API_KEY`   | Sua API Key do Google Gemini (aistudio.google.com/app/apikey)   |
| `ADMIN_EMAILS`     | E-mails de admin separados por vírgula: `joao@ex.com,maria@ex.com` |
| `ALLOWED_EMAILS`   | E-mails de viewer separados por vírgula: `viewer1@ex.com`        |

> **Nota:** Um email em `ADMIN_EMAILS` também precisa estar convidado via Identity.
> Emails em `ALLOWED_EMAILS` não precisam estar em `ADMIN_EMAILS` (são VIEWERs).
> Se o email não estiver em nenhuma das duas listas, o acesso é bloqueado mesmo que o login Identity funcione.

---

### 5. Deploy

- Faça push para o repositório. O Netlify fará o deploy automaticamente.
- Ou clique em **Trigger deploy → Deploy site** manualmente.

---

## Roles e Permissões

| Role     | Pode ver tudo | Botão ⚙️ Admin | Forçar resync | Mapeamento colunas |
|----------|:---:|:---:|:---:|:---:|
| ADMIN    | ✅  | ✅  | ✅  | ✅  |
| VIEWER   | ✅  | ❌  | ❌  | ❌  |

---

## Como funciona o fluxo

```
Usuário abre o painel
      │
      ├─ Não logado → tela de login (Netlify Identity widget)
      │
      └─ Logado → frontend chama /.netlify/functions/config
                        │
                        ├─ Email não autorizado → tela "Acesso negado"
                        │
                        └─ Autorizado → role + lista de boards retornada
                                │
                                └─ Frontend chama /.netlify/functions/sync
                                        │
                                        └─ Dados consolidados de todos os boards
                                               → painel carrega normalmente
```

---

## Sobre a IA (Gemini)

- A análise é gerada via `/.netlify/functions/ai` (Gemini 1.5 Flash).
- Nenhuma chave de API aparece no frontend.
- O sistema de memória/feedback é salvo no **localStorage do usuário** (chave `sb_ai_memory:<email>`).
- Quanto mais feedbacks o usuário der (👍/👎), melhor o prompt fica para ele.
- O `promptAdditions` (campo "Aperfeiçoar IA") permite instruções personalizadas persistentes.

---

## Manutenção

- **Adicionar usuário:** Netlify Identity → Invite users
- **Remover usuário:** Netlify Identity → lista de usuários → Delete
- **Promover a ADMIN:** adicionar email em `ADMIN_EMAILS` nas env vars + redeploy
- **Revogar VIEWER:** remover email de `ALLOWED_EMAILS` + redeploy (ou remover da Identity)
