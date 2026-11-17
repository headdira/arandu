# Arandu

**Orquestração de agentes de IA para funções serverless, em TypeScript.**

> *arandu* (guarani): sabedoria — o conhecimento que vem da experiência e de saber ouvir.

Arandu é uma biblioteca para construir **agentes de IA** e **times de agentes** que rodam dentro de
funções serverless: sem processo ligado, com limite de tempo, cada execução começando do zero. O agente
recebe uma mensagem, decide, chama ferramentas, delega para outros agentes, grava a sessão e termina —
e na próxima execução continua de onde parou.

- **Zero dependências**, ~1.600 linhas de TypeScript.
- Roda o `.ts` direto no Node 22.6+, sem build.
- Qualquer modelo compatível com OpenAI Chat Completions.

[English below](#english)

## Conceitos

### Agent
Um agente é um modelo + instruções + ferramentas + memória da conversa. Cada `run()` é uma execução
completa: monta o contexto, chama o modelo, executa as tools que ele pedir, repete até ter a resposta,
grava tudo e devolve um `RunOutput`.

- **Instruções e contexto**: `instructions` (texto, lista ou função), `description`, `role`,
  `additionalContext`, `expectedOutput`, data/hora no fuso (`addDatetimeToContext` +
  `timezoneIdentifier`) e variáveis `{chave}` preenchidas pelo estado da sessão.
- **Nunca derruba a função**: `retries` com `exponentialBackoff`; se esgotar, o `run()` não lança —
  devolve `status: ERROR` com a mensagem, já salvo. Erro de cliente (4xx) não é re-tentado.
- **Hooks**: `preHooks`/`postHooks` para validar entrada e saída.

### Tools
Funções que o agente pode chamar, com schema JSON explícito.

- `tool({ name, description, parameters, entrypoint })` e `Toolkit` para agrupar.
- A tool recebe os argumentos e o `runContext` (sessão, usuário, estado, dependências injetadas pelo
  seu código — nunca pelo modelo).
- `toolCallLimit`, `stopAfterToolCall`, `showResult`, cache de resultado com TTL, hooks por tool.
- Erro dentro da tool vira resposta para o modelo, não exceção.
- **MCP**: `mcpTools()` conecta num servidor MCP (Streamable HTTP) e expõe as tools dele ao agente.

### Team (orquestração)
Um `Team` é um agente líder com membros especialistas. O líder decide quem atende e delega com a tool
`delegate_task_to_member`.

- **`route`**: o líder escolhe **um** membro; a resposta dele vai direto para o usuário.
- **`coordinate`**: o líder distribui tarefas para vários membros e junta as respostas.
- O estado da sessão vai do time para os membros e volta mesclado; cada execução de membro fica
  registrada em `memberRuns`, ligada à execução do líder.

### Sessão, estado e histórico
Serverless não guarda nada entre execuções — a sessão vive num banco que você escolhe.

- `sessionId` / `userId` por conversa.
- `sessionState`: estado da conversa (carrinho, etapa do fluxo…), mesclado a cada execução; com
  `enableAgenticState` o próprio agente pode atualizar.
- `addHistoryToContext` + `numHistoryRuns`: as últimas execuções entram no contexto (execuções com
  erro ficam de fora).
- **Bancos**: `InMemoryDb` (testes, scripts) e `BlobsDb` (qualquer store chave-valor com escrita
  condicional por etag — duas execuções simultâneas não se atropelam). Para outro banco, implemente
  `BaseDb`.

### Modelos
- `OpenAILike`: qualquer endpoint compatível com Chat Completions (OpenAI, OpenRouter, Groq, NVIDIA,
  Ollama, llama.cpp…), com cache de resposta opcional.
- Seu próprio roteador (fallback entre provedores, máscara de dados, etc.): estenda `Model` e
  implemente `invoke()`.
- **Saída estruturada**: `outputSchema` (JSON Schema) → `content` já vem como objeto.

### Eventos
`RunStarted`, `RunContent`, `RunCompleted`, `RunError`, `ToolCallStarted/Completed/Error`,
`ModelRequestStarted/Completed`, hooks… via `onEvent` no `run()` ou `runStream()`. Útil para log,
métricas e para mostrar "digitando…" enquanto o agente trabalha.

## Começo rápido

```bash
git clone https://github.com/headdira/arandu && cd arandu && npm install
npm test
OPENAI_BASE_URL=https://api.openai.com/v1 OPENAI_API_KEY=sk-... MODELO=gpt-4o-mini npm run exemplo
OPENAI_BASE_URL=https://api.openai.com/v1 OPENAI_API_KEY=sk-... MODELO=gpt-4o-mini npm run exemplo:time
```

### Um agente com tool

```ts
import { Agent, InMemoryDb, OpenAILike, tool } from "./src/index.ts";

const modelo = new OpenAILike({ id: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY });

const statusDoPedido = tool({
  name: "status_do_pedido",
  description: "Consulta o status de um pedido pelo número.",
  parameters: { type: "object", properties: { numero: { type: "string" } }, required: ["numero"] },
  entrypoint: async ({ numero }) => JSON.stringify({ numero, status: "em transporte", previsao: "amanhã" }),
});

const suporte = new Agent({
  name: "Suporte",
  model: modelo,
  instructions: ["Você é o suporte de uma loja online.", "Seja breve e use as tools."],
  tools: [statusDoPedido],
  db: new InMemoryDb(),
  addHistoryToContext: true,
  retries: 1,
  exponentialBackoff: true,
});

const r = await suporte.run("cadê meu pedido 4521?", { sessionId: "conversa-1", userId: "cliente-1" });
console.log(r.status, r.content, r.tools.map((t) => t.toolName));
```

### Um time de agentes

```ts
import { Agent, Team } from "./src/index.ts";

const financeiro = new Agent({ name: "Financeiro", role: "Faturas, boletos e pagamentos.", model: modelo, tools: [segundaVia] });
const tecnico = new Agent({ name: "Técnico", role: "Acesso, senha e uso do sistema.", model: modelo });

const atendimento = new Team({ name: "Atendimento", mode: "route", model: modelo, members: [financeiro, tecnico], db });

const r = await atendimento.run("esqueci minha senha", { sessionId: "c-2" });
console.log(r.memberRuns?.[0].agentName, r.content); // "Técnico", passos para redefinir a senha
```

### Numa função serverless

```ts
export default async (req: Request) => {
  const { conversa, texto } = await req.json();
  const r = await suporte.run(texto, { sessionId: conversa }); // sessão vem do banco, volta pro banco
  return Response.json({ resposta: r.content, status: r.status });
};
```

## O que ainda não tem

Streaming de tokens (o `runStream()` emite eventos, mas o texto chega inteiro), RAG/knowledge,
memória de longo prazo do usuário, human-in-the-loop, mídia, Team nos modos `broadcast`/`tasks`.
Tools rodam em sequência. Contribuições são bem-vindas.

Alguns nomes internos e comentários estão em português — o projeto nasceu no Brasil. 🇧🇷

## Licença

Apache-2.0 — veja [`LICENSE`](LICENSE) e [`NOTICE`](NOTICE).

---

## English

**AI agent orchestration for serverless functions, in TypeScript.**

> *arandu* (Guarani): wisdom — knowledge that comes from lived experience and from listening.

Arandu is a library for building **AI agents** and **agent teams** that run inside serverless
functions: no long-lived process, hard time limits, every invocation starting from scratch. The agent
receives a message, reasons, calls tools, delegates to other agents, stores the session and exits — and
the next invocation picks up where it left off.

- **Zero dependencies**, ~1,600 lines of TypeScript.
- Runs `.ts` directly on Node 22.6+, no build step.
- Any OpenAI Chat Completions–compatible model.

### Concepts

- **Agent** — model + instructions + tools + conversation memory. Each `run()` builds the context,
  calls the model, executes requested tools, loops until done, persists and returns a `RunOutput`.
  Retries with exponential backoff that **never throw** (on exhaustion you get `status: ERROR`); 4xx
  errors are not retried; pre/post hooks.
- **Tools** — `tool()` and `Toolkit` with explicit JSON Schema; tools receive the `runContext`
  (session, user, state, dependencies injected by your code, never by the model); call limits,
  stop-after-call, result caching, per-tool hooks; tool errors become model messages. **MCP** servers
  via `mcpTools()` (Streamable HTTP).
- **Team (orchestration)** — a leader agent delegating to specialist members via
  `delegate_task_to_member`. `route`: one member answers directly. `coordinate`: several members,
  leader merges. Session state flows to members and back; member runs are linked in `memberRuns`.
- **Session, state, history** — `sessionId`/`userId`, merged `sessionState` (optionally updated by the
  agent itself), recent runs added to context. Storage: `InMemoryDb` and `BlobsDb` (any key-value store
  with etag-conditional writes, safe under concurrent invocations), or implement `BaseDb`.
- **Models** — `OpenAILike` for any compatible endpoint (OpenAI, OpenRouter, Groq, NVIDIA, Ollama,
  llama.cpp…); extend `Model` and implement `invoke()` for your own router. Structured output via
  `outputSchema`.
- **Events** — run, content, tool-call, model-request and hook events through `onEvent` or
  `runStream()`.

### Quick start

```bash
git clone https://github.com/headdira/arandu && cd arandu && npm install
npm test
OPENAI_BASE_URL=https://api.openai.com/v1 OPENAI_API_KEY=sk-... MODELO=gpt-4o-mini npm run exemplo
OPENAI_BASE_URL=https://api.openai.com/v1 OPENAI_API_KEY=sk-... MODELO=gpt-4o-mini npm run exemplo:time
```

See the code samples above — the API is the same in any language.

### Not there yet

Token streaming, RAG/knowledge, long-term user memory, human-in-the-loop, media, Team
`broadcast`/`tasks` modes; tools run sequentially. Contributions welcome.

Some internal names and comments are in Portuguese — the project was born in Brazil. 🇧🇷

### License

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
