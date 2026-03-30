# Macunaíma — Bot Anti-Spam para Telegram

Bot de moderação para grupos do Telegram que usa a IA do Google Gemini para detectar e remover mensagens de spam automaticamente. Hospedado na Cloudflare Workers (serverless, sem custo fixo).

## Funcionalidades

- Analisa cada mensagem de membros comuns com o Gemini AI
- Remove automaticamente mensagens identificadas como spam
- Sistema de avisos por usuário (persistido no Cloudflare KV)
- Bane automaticamente o usuário ao atingir o limite de avisos
- Extrai e analisa links presentes nas mensagens
- Administradores e o criador do grupo são isentos da verificação

---

## Pré-requisitos

- Conta na [Cloudflare](https://dash.cloudflare.com) (plano gratuito suficiente)
- [Node.js](https://nodejs.org) >= 18
- [pnpm](https://pnpm.io) >= 9 — `npm install -g pnpm`
- Conta no [Google AI Studio](https://aistudio.google.com) para obter a API key

---

## 1. Criar o bot no Telegram

1. Abra o Telegram e inicie uma conversa com [@BotFather](https://t.me/BotFather)
2. Envie `/newbot` e siga as instruções
3. Guarde o **token** gerado (formato `123456789:ABCdef...`)
4. **Importante:** desative o modo de privacidade do bot para que ele possa ler todas as mensagens do grupo:
   ```
   /setprivacy → Selecione seu bot → Disable
   ```

---

## 2. Obter a chave da API do Google AI

1. Acesse [Google AI Studio](https://aistudio.google.com/apikey)
2. Clique em **Create API key**
3. Guarde a chave gerada

---

## 3. Instalar dependências

```bash
pnpm install
```

---

## 4. Configurar o Cloudflare KV

O bot usa o KV da Cloudflare para armazenar o contador de avisos de cada usuário.

```bash
# Faça login na Cloudflare (abre o navegador)
pnpm wrangler login

# Crie o namespace de produção
pnpm wrangler kv namespace create SPAM_KV

# Crie o namespace de preview (para desenvolvimento local)
pnpm wrangler kv namespace create SPAM_KV --preview
```

Cada comando retorna um objeto com o `id`. Abra o `wrangler.toml` e substitua:

```toml
[[kv_namespaces]]
binding = "SPAM_KV"
id = "COLE_O_ID_DE_PRODUÇÃO_AQUI"
preview_id = "COLE_O_PREVIEW_ID_AQUI"
```

---

## 5. Configurar as variáveis de ambiente

As variáveis sensíveis são armazenadas como **secrets** no Cloudflare (nunca ficam no código).

```bash
# Token do bot do Telegram
pnpm wrangler secret put BOT_TOKEN

# Chave da API do Google AI
pnpm wrangler secret put GOOGLE_AI_API_KEY
```

Cada comando pedirá que você cole o valor no terminal.

### Variáveis públicas (wrangler.toml)

Edite o `wrangler.toml` para ajustar os parâmetros do bot:

| Variável | Padrão | Descrição |
|---|---|---|
| `SPAM_THRESHOLD` | `0.80` | Confiança mínima (0–1) para considerar spam |
| `MAX_WARNINGS` | `3` | Avisos antes do ban automático |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Modelo Gemini a utilizar |

---

## 6. Desenvolvimento local com ngrok

O Wrangler sobe o worker em `localhost:8787`, mas o Telegram precisa de uma URL HTTPS pública para entregar os webhooks. O ngrok cria um túnel temporário que resolve isso.

### 6.1 Instalar o ngrok

```bash
# macOS
brew install ngrok

# Linux (snap)
sudo snap install ngrok

# Ou baixe diretamente em https://ngrok.com/download
```

Crie uma conta gratuita em [ngrok.com](https://ngrok.com) e autentique:

```bash
ngrok config add-authtoken SEU_NGROK_TOKEN
```

### 6.2 Criar o arquivo de variáveis locais

Crie `.dev.vars` na raiz do projeto (já incluído no `.gitignore` — nunca suba esse arquivo):

```ini
BOT_TOKEN=seu_token_aqui
GOOGLE_AI_API_KEY=sua_chave_aqui
```

### 6.3 Iniciar o servidor local

Em um terminal, suba o worker:

```bash
pnpm dev
```

O Wrangler ficará escutando em `http://localhost:8787`.

### 6.4 Abrir o túnel ngrok

Em **outro terminal**, exponha a porta 8787:

```bash
ngrok http 8787
```

O ngrok exibirá algo como:

```
Forwarding  https://a1b2-203-0-113-42.ngrok-free.app -> http://localhost:8787
```

Copie a URL `https://...ngrok-free.app`.

### 6.5 Registrar o webhook temporário

```bash
curl "https://api.telegram.org/botSEU_TOKEN/setWebhook?url=https://a1b2-203-0-113-42.ngrok-free.app"
```

Resposta esperada:

```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

Agora envie mensagens ao grupo — os updates chegam pelo ngrok ao Wrangler local e você vê os logs no primeiro terminal em tempo real.

### 6.6 Remover o webhook ao terminar

Cada vez que o ngrok reinicia, a URL muda. Antes de encerrar a sessão, limpe o webhook para não deixar o Telegram tentando entregar updates para uma URL morta:

```bash
curl "https://api.telegram.org/botSEU_TOKEN/deleteWebhook"
```

Após o deploy em produção, registre a URL definitiva do Worker conforme o passo 8.

---

## 7. Deploy

```bash
pnpm deploy
```

O comando retorna a URL do worker, no formato:
```
https://macunaima.<seu-subdomínio>.workers.dev
```

---

## 8. Registrar o Webhook no Telegram

Após o deploy, registre a URL do worker como webhook do bot. Substitua `SEU_TOKEN` e `SUA_URL`:

```bash
curl "https://api.telegram.org/botSEU_TOKEN/setWebhook?url=SUA_URL"
```

Exemplo:

```bash
curl "https://api.telegram.org/bot123456789:ABCdef.../setWebhook?url=https://macunaima.seu-subdominio.workers.dev"
```

Resposta esperada:

```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

Para verificar o status do webhook a qualquer momento:

```bash
curl "https://api.telegram.org/botSEU_TOKEN/getWebhookInfo"
```

---

## 9. Adicionar o bot ao grupo

1. Adicione o bot ao grupo do Telegram
2. **Promova o bot a administrador** com as seguintes permissões:
   - ✅ Deletar mensagens
   - ✅ Banir usuários
3. O bot começará a monitorar as mensagens automaticamente

---

## Estrutura do projeto

```
macunaima/
├── src/
│   ├── index.ts          # Entry point do Cloudflare Worker
│   └── spam-detector.ts  # Integração com Gemini AI
├── wrangler.toml         # Configuração do Cloudflare Workers
├── package.json
├── tsconfig.json
└── README.md
```

---

## Solução de problemas

**O bot não remove mensagens:**
Verifique se ele foi promovido a administrador com permissão de deletar mensagens.

**O bot não bane usuários:**
Verifique se ele tem permissão de banir membros.

**Erros de análise no log:**
Confirme que a `GOOGLE_AI_API_KEY` está correta com `pnpm wrangler secret list`.

**Webhook não recebe atualizações:**
Execute `getWebhookInfo` para checar o status e possíveis erros de SSL ou timeout.
