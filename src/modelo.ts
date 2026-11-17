// Arandu — Camada de modelo: Model (base) e OpenAILike (Chat Completions), com retry seguro e cache.
// Contém código modificado de terceiros sob Apache-2.0; ver NOTICE.
import { createHash } from "node:crypto";
import { type CacheStore, executarFuncao, type Function, type Injetados, parseArgs } from "./ferramentas.ts";
import {
  type Message,
  ModelProviderError,
  NAO_RETENTAR_STATUS,
  PADROES_JANELA,
  RunEvent,
  type RunMetrics,
  type ToolCall,
  type ToolExecution,
  dormir,
  uuid,
} from "./tipos.ts";

export type Invocacao = {
  messages: Message[];
  tools?: { type: "function"; function: Record<string, unknown> }[];
  toolChoice?: unknown;
  responseFormat?: unknown;
};
export type RespostaInvocacao = {
  message: { content: string | null; toolCalls?: ToolCall[]; reasoningContent?: string };
  usage?: { inputTokens?: number; outputTokens?: number };
  model?: string; // quem respondeu de fato (útil com roteador/gateway)
};

export type ModelOpts = {
  id: string;
  provider?: string;
  retries?: number; // default 0
  delayBetweenRetries?: number; // s, default 1
  exponentialBackoff?: boolean;
  cacheResponse?: boolean; // default false
  cacheTtl?: number; // s; undefined = não expira
  cache?: CacheStore;
  systemMessageRole?: "system" | "developer";
  instructions?: string[];
};

export function retentavel(e: unknown): boolean {
  if (!(e instanceof ModelProviderError)) return false;
  if (e.statusCode !== undefined && NAO_RETENTAR_STATUS.has(e.statusCode)) return false;
  const m = e.message.toLowerCase();
  return !PADROES_JANELA.some((p) => m.includes(p));
}

export abstract class Model {
  id: string;
  provider: string;
  retries: number;
  delayBetweenRetries: number;
  exponentialBackoff: boolean;
  cacheResponse: boolean;
  cacheTtl?: number;
  cache?: CacheStore;
  systemMessageRole: "system" | "developer";
  instructions?: string[];

  constructor(o: ModelOpts) {
    this.id = o.id;
    this.provider = o.provider ?? "OpenAILike";
    this.retries = o.retries ?? 0;
    this.delayBetweenRetries = o.delayBetweenRetries ?? 1;
    this.exponentialBackoff = o.exponentialBackoff ?? false;
    this.cacheResponse = o.cacheResponse ?? false;
    this.cacheTtl = o.cacheTtl;
    this.cache = o.cache;
    this.systemMessageRole = o.systemMessageRole ?? "system";
    this.instructions = o.instructions;
  }

  // Uma chamada ao provedor. Erros de provedor devem virar ModelProviderError(msg, status).
  abstract invoke(req: Invocacao): Promise<RespostaInvocacao>;

  async invokeComRetry(req: Invocacao): Promise<RespostaInvocacao> {
    for (let tentativa = 0; ; tentativa++) {
      try {
        return await this.invoke(req);
      } catch (e) {
        if (tentativa >= this.retries || !retentavel(e)) throw e;
        await dormir(1000 * (this.exponentialBackoff ? this.delayBetweenRetries * 2 ** tentativa : this.delayBetweenRetries));
      }
    }
  }
}

// formato enviado; ids de tool call remapeados p/ "call_" (≤ 40).
export function formatarMensagens(msgs: Message[], roleSistema: "system" | "developer"): any[] {
  const mapa = new Map<string, string>();
  let n = 0;
  const id = (x: string) => {
    if (x.startsWith("call_") && x.length <= 40) return x;
    if (!mapa.has(x)) mapa.set(x, `call_${(n++).toString(16).padStart(35, "0")}`);
    return mapa.get(x)!;
  };
  return msgs.map((m) => {
    const o: any = { role: m.role === "system" ? roleSistema : m.role, content: m.content ?? "" };
    if (m.name) o.name = m.name;
    if (m.toolCallId) o.tool_call_id = id(m.toolCallId);
    if (m.toolCalls?.length) o.tool_calls = m.toolCalls.map((t) => ({ ...t, id: id(t.id) }));
    return o;
  });
}

// qualquer API Chat Completions compatível.
export class OpenAILike extends Model {
  baseUrl: string;
  apiKey?: string;
  requestParams: Record<string, unknown>;
  timeoutMs: number;
  constructor(o: ModelOpts & { baseUrl: string; apiKey?: string; requestParams?: Record<string, unknown>; timeoutMs?: number }) {
    super({ provider: "OpenAILike", ...o });
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.apiKey = o.apiKey;
    this.requestParams = o.requestParams ?? {};
    this.timeoutMs = o.timeoutMs ?? 60_000;
  }
  async invoke(req: Invocacao): Promise<RespostaInvocacao> {
    const body: any = { model: this.id, messages: formatarMensagens(req.messages, this.systemMessageRole) };
    if (req.tools?.length) {
      body.tools = req.tools;
      if (req.toolChoice !== undefined) body.tool_choice = req.toolChoice;
    }
    if (req.responseFormat) body.response_format = req.responseFormat;
    Object.assign(body, this.requestParams);
    let r: Response;
    try {
      r = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e: any) {
      throw new ModelProviderError(`conexão: ${e?.message ?? e}`); // sem status = retentável
    }
    if (!r.ok) throw new ModelProviderError(`${r.status} ${(await r.text().catch(() => "")).slice(0, 300)}`, r.status);
    const j: any = await r.json();
    return lerRespostaOpenAI(j);
  }
}

export function lerRespostaOpenAI(j: any): RespostaInvocacao {
  const m = j?.choices?.[0]?.message ?? {};
  let content: string | null = typeof m.content === "string" ? m.content : null;
  let reasoningContent: string | undefined = m.reasoning_content ?? m.reasoning;
  // <think> vai para reasoning_content.
  if (content?.includes("</think>")) {
    const i = content.indexOf("</think>");
    reasoningContent = content.slice(0, i).replace(/^[\s\S]*?<think>/, "").trim();
    content = content.slice(i + 8).trim();
  }
  return {
    message: {
      content,
      reasoningContent,
      toolCalls: (m.tool_calls ?? []).map((t: any) => ({ id: t.id || uuid(), type: "function", function: { name: t.function?.name, arguments: t.function?.arguments ?? "" } })),
    },
    usage: { inputTokens: j?.usage?.prompt_tokens, outputTokens: j?.usage?.completion_tokens },
    model: j?.model,
  };
}

// chave do cache de resposta.
function chaveResposta(model: Model, msgs: Message[], temTools: boolean, responseFormat: unknown) {
  const base = JSON.stringify({ model_id: model.id, messages: msgs.map((m) => ({ role: m.role, content: m.content })), has_tools: temTools, response_format: responseFormat ?? null, stream: false });
  return "model:" + createHash("md5").update(base).digest("hex");
}

export type ResultadoLoop = {
  content: string | null;
  reasoningContent?: string;
  toolExecutions: ToolExecution[];
  model?: string;
  metrics: Pick<RunMetrics, "inputTokens" | "outputTokens" | "modelRequests">;
};

export type Emissor = (ev: { event: RunEvent; tool?: ToolExecution; content?: unknown; model?: string }) => void;

// loop: chama o modelo, executa tools (em sequência), repete.
export async function responder(
  model: Model,
  a: {
    messages: Message[]; // mutada in place (assistant/tool anexados)
    functions: Map<string, Function>;
    toolsParaModelo: Invocacao["tools"];
    toolChoice?: unknown;
    toolCallLimit?: number;
    responseFormat?: unknown;
    injetados: Injetados;
    toolCache?: CacheStore;
    emitir?: Emissor;
  },
): Promise<ResultadoLoop> {
  const metrics = { inputTokens: 0, outputTokens: 0, modelRequests: 0 };
  const execs: ToolExecution[] = [];
  let content: string | null = null;
  let reasoning: string | undefined;
  let quem: string | undefined;
  const temTools = !!a.toolsParaModelo?.length;

  if (model.cacheResponse && model.cache) {
    const hit = await model.cache.getCache(chaveResposta(model, a.messages, temTools, a.responseFormat)).catch(() => null);
    if (hit && (model.cacheTtl === undefined || Date.now() / 1000 - hit.em <= model.cacheTtl)) {
      const r = JSON.parse(hit.valor) as ResultadoLoop;
      return r;
    }
  }
  const chaveInicial = model.cacheResponse ? chaveResposta(model, a.messages, temTools, a.responseFormat) : null;

  let chamadas = 0;
  while (true) {
    a.emitir?.({ event: RunEvent.modelRequestStarted, model: model.id });
    const r = await model.invokeComRetry({ messages: a.messages, tools: a.toolsParaModelo, toolChoice: a.toolChoice, responseFormat: a.responseFormat });
    metrics.modelRequests++;
    metrics.inputTokens += r.usage?.inputTokens ?? 0;
    metrics.outputTokens += r.usage?.outputTokens ?? 0;
    quem = r.model ?? quem;
    a.emitir?.({ event: RunEvent.modelRequestCompleted, model: r.model ?? model.id });
    const assistant: Message = { role: "assistant", content: r.message.content, toolCalls: r.message.toolCalls?.length ? r.message.toolCalls : undefined, reasoningContent: r.message.reasoningContent, id: uuid(), createdAt: Math.floor(Date.now() / 1000) };
    // content acumula o texto de todas as assistants, sem separador.
    if (r.message.content) content = (content ?? "") + r.message.content;
    if (r.message.reasoningContent) reasoning = (reasoning ?? "") + r.message.reasoningContent;
    a.messages.push(assistant);
    if (!assistant.toolCalls?.length) break;

    let parar = false;
    for (const tc of assistant.toolCalls) {
      const f = a.functions.get(tc.function.name);
      const msgTool = (txt: string, erro: boolean, extra: Partial<Message> = {}): Message => ({ role: "tool", content: txt, toolCallId: tc.id, toolName: tc.function.name, toolCallError: erro, ...extra });
      if (!f) {
        a.messages.push(msgTool("Error: The requested tool does not exist or is not available.", true));
        continue;
      }
      const p = parseArgs(tc.function.arguments);
      if (!p.ok) {
        a.messages.push(msgTool(p.erro, true));
        continue;
      }
      chamadas++;
      // acima do limite: recusa, mas o loop continua.
      if (a.toolCallLimit !== undefined && chamadas > a.toolCallLimit) {
        a.messages.push(msgTool(`Tool call limit reached. Tool call ${f.name} not executed. Don't try to execute it again.`, true));
        continue;
      }
      a.emitir?.({ event: RunEvent.toolCallStarted, tool: { toolCallId: tc.id, toolName: f.name, toolArgs: p.args, toolCallError: false, result: "", stopAfterToolCall: f.stopAfterToolCall, durationMs: 0, createdAt: Math.floor(Date.now() / 1000) } });
      const ex = await executarFuncao(f, { id: tc.id, argumentos: p.args }, a.injetados, a.toolCache);
      execs.push(ex);
      a.emitir?.({ event: ex.toolCallError ? RunEvent.toolCallError : RunEvent.toolCallCompleted, tool: ex });
      a.messages.push(msgTool(ex.result, ex.toolCallError, { toolArgs: p.args, stopAfterToolCall: f.stopAfterToolCall }));
      if (f.showResult && !ex.toolCallError) content = (content ?? "") + ex.result;
      if (f.stopAfterToolCall) parar = true;
    }
    if (parar) break;
  }

  const res: ResultadoLoop = { content, reasoningContent: reasoning, toolExecutions: execs, model: quem, metrics };
  if (chaveInicial && model.cache) await model.cache.setCache(chaveInicial, JSON.stringify(res)).catch(() => {});
  return res;
}
