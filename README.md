# Arandu

> **arandu** (guarani): sabedoria — o conhecimento que vem da experiência e de saber ouvir.

Agentes de IA em **TypeScript**, feitos para rodar onde não tem servidor: Netlify/Vercel Functions,
Cloudflare Workers com Node, scripts. Agent com tools, times de agentes, sessão, histórico, retries e
eventos — **zero dependências**, ~1.600 linhas.

Arandu é um **porte em TypeScript do núcleo do [Agno](https://github.com/agno-agi/agno) 3.2.0**
(Apache-2.0). A API e o comportamento seguem o Agno onde importa — inclusive os textos da system
message —, para quem já conhece o Agno em Python se sentir em casa. Não é mantido nem endossado pela
Agno Inc.; veja [`NOTICE`](NOTICE).

[English below](#english)

## Por que existe

O Agno é ótimo, mas é Python. Em função serverless de Node (sem processo ligado, com limite de tempo)
ele não roda. O Arandu nasceu para colocar um **atendente de WhatsApp com IA rodando inteiro no plano
grátis do Netlify**: o agente acorda em turnos, responde, salva a sessão no Netlify Blobs e dorme.
Num teste em produção ele passou um dia inteiro atendendo conversas reais — marcar horário, tirar
dúvida, tratar objeção de venda — com modelos grátis e troca automática de provedor, sem custo.

## Começo rápido

Precisa de Node 22.6+ (roda o `.ts` direto, sem build).

```bash
git clone https://github.com/headdira/arandu && cd arandu && npm install
npm test
OPENAI_BASE_URL=https://api.openai.com/v1 OPENAI_API_KEY=sk-... MODELO=gpt-4o-mini npm run exemplo
```

Qualquer endpoint compatível com OpenAI Chat Completions serve (OpenAI, OpenRouter, NVIDIA, Groq,
OVH, Ollama, llama.cpp…).

```ts
import { Agent, InMemoryDb, OpenAILike, tool } from "./src/index.ts";

const horarios = tool({
  name: "ver_horarios_livres",
  description: "Lista horários livres de um dia (AAAA-MM-DD).",
  parameters: { type: "object", properties: { data: { type: "string" } }, required: ["data"] },
  entrypoint: async ({ data }, { runContext }) => JSON.stringify({ data, livres: ["10:00", "14:30"], cliente: runContext.userId }),
});

const agente = new Agent({
  model: new OpenAILike({ id: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
  instructions: ["Você atende uma barbearia pelo WhatsApp.", "Seja breve e use as tools."],
  tools: [horarios],
  db: new InMemoryDb(),            // ou BlobsDb(getStore("agentes")) no Netlify
  addHistoryToContext: true,
  addDatetimeToContext: true,
  timezoneIdentifier: "America/Sao_Paulo",
  retries: 1,
  exponentialBackoff: true,
});

const r = await agente.run("tem horário amanhã?", { sessionId: "conversa-1", userId: "5531999990000" });
console.log(r.content, r.status, r.tools.map((t) => t.toolName));
```

## O que tem (igual ao Agno 3.2.0)

- **Agent**: `description`, `role`, `instructions` (texto, lista ou função), `additionalContext`, `expectedOutput`, `markdown`, `addDatetimeToContext` + `timezoneIdentifier`, `addNameToContext`, `systemMessage`, `additionalInput`, substituição `{var}` (session_state > dependencies > metadata > user_id).
- **System message** com a mesma ordem, as mesmas tags e os mesmos textos (`<additional_information>`, `<expected_output>`, `<session_state>`…).
- **Run**: `retries` + `delayBetweenRetries` + `exponentialBackoff`. Esgotou: não lança; devolve `RunOutput` com `status=ERROR`, já salvo.
- **Tools**: `tool()` (= `@tool`), `Toolkit` (include/exclude, instructions, stop_after/show_result), `stopAfterToolCall`, `showResult`, `preHook`/`postHook`, `cacheResults` + `cacheTtl`. Tools recebem `{ runContext, agent }`; erro na tool vira mensagem para o modelo; `toolCallLimit`.
- **Model**: `OpenAILike` (Chat Completions), retry que não repete 4xx nem estouro de contexto, `cacheResponse`, `<think>` separado em `reasoningContent`. Para usar seu próprio roteador de modelos, estenda `Model` e implemente `invoke()`.
- **MCP**: `mcpTools()` conecta num servidor MCP (Streamable HTTP) e vira tools do agente.
- **Sessão**: `session_state` (semente em sessão nova, deep merge), `enableAgenticState`, `readChatHistory`, `introduction`.
- **Histórico**: `addHistoryToContext`, `numHistoryRuns` (padrão 3), `numHistoryMessages`, `maxToolCallsFromHistory`.
- **DB**: `InMemoryDb` e `BlobsDb` (Netlify Blobs ou qualquer store com escrita condicional por etag).
- **Eventos**: `RunStarted`, `RunContent`, `RunCompleted`, `RunError`, `ToolCall*`, `Pre/PostHook*`, `ModelRequest*`; `onEvent` ou `runStream()`.
- **Saída estruturada**: `outputSchema` (JSON Schema) → `response_format` strict (ou `useJsonMode`).
- **Team**: modos `route` e `coordinate` com `delegate_task_to_member`; estado do time vai e volta dos membros.

## Diferenças deliberadas em relação ao Agno

- Um único `run()` assíncrono (o Agno tem `run`/`arun`); tools rodam em sequência.
- Resultado de tool, `<session_state>` e `update_session_state` em **JSON** (o Agno usa repr do Python).
- Data/hora em `AAAA-MM-DD HH:MM:SS±HH:MM` no fuso dado.
- Schema das tools é explícito (TS não tem type hints em runtime).
- `runStream()` emite eventos, mas o texto do modelo chega inteiro (sem streaming de tokens).
- Fora (por enquanto): knowledge/RAG, memória de usuário, reasoning, HITL, compressão, mídia, telemetria, Team `broadcast`/`tasks`.

Alguns nomes internos e comentários estão em português — o projeto nasceu no Brasil. 🇧🇷

## Licença

Apache-2.0. Obra derivada do Agno (Copyright 2025-2026 Agno Inc.) — veja [`LICENSE`](LICENSE) e [`NOTICE`](NOTICE).

---

## English

> **arandu** (Guarani): wisdom — knowledge that comes from lived experience and from listening.

AI agents in **TypeScript**, built to run where there is no server: Netlify/Vercel Functions,
Node-compatible workers, scripts. Agents with tools, agent teams, sessions, history, retries and
events — **zero dependencies**, ~1,600 lines.

Arandu is a **TypeScript port of the [Agno](https://github.com/agno-agi/agno) 3.2.0 core** (Apache-2.0).
API and behavior follow Agno where it matters — down to the system message texts — so Agno users feel
at home. It is not maintained or endorsed by Agno Inc.; see [`NOTICE`](NOTICE).

### Why

Agno is great, but it is Python, and it does not run inside a Node serverless function (no long-lived
process, hard time limits). Arandu was built to run an **AI WhatsApp assistant entirely on Netlify's
free tier**: the agent wakes up in turns, replies, stores the session in Netlify Blobs and sleeps. In a
production test it spent a full day handling real conversations — booking, answering questions,
handling sales objections — on free models with automatic provider fallback, at zero cost.

### Quick start

Node 22.6+ (runs `.ts` directly, no build step).

```bash
git clone https://github.com/headdira/arandu && cd arandu && npm install
npm test
OPENAI_BASE_URL=https://api.openai.com/v1 OPENAI_API_KEY=sk-... MODELO=gpt-4o-mini npm run exemplo
```

Any OpenAI Chat Completions–compatible endpoint works (OpenAI, OpenRouter, NVIDIA, Groq, OVH, Ollama,
llama.cpp…). See the code sample above; the API is the same.

### What's in it

Agent (instructions, context, `{var}` templating, Agno-identical system message), retries with
exponential backoff that never throw, tools and Toolkits with hooks, caching and call limits, an
OpenAI-compatible model with safe provider retries, MCP tools (Streamable HTTP), session state,
history, `InMemoryDb`/`BlobsDb`, run events and streaming events, structured output, and Teams in
`route` and `coordinate` modes. The deliberate differences from Agno are listed in the Portuguese
section above (single async `run()`, JSON instead of Python repr, explicit tool schemas, no token
streaming, no RAG/memory/reasoning yet).

Some internal names and comments are in Portuguese — the project was born in Brazil. 🇧🇷

### License

Apache-2.0. Derived work of Agno (Copyright 2025-2026 Agno Inc.) — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
