// Arandu — Agent: run com retries, hooks, tools, sessão, histórico e eventos.
// Contém código modificado de terceiros sob Apache-2.0; ver NOTICE.
import type { BaseDb } from "./db.ts";
import { achatarTools, type Function, instrucoesDasTools, type Injetados, schemaStrict, tool, type Toolkit } from "./ferramentas.ts";
import { dataHoraNoFuso, formatarComVariaveis, historicoDaSessao, montarSistema, promptJson } from "./mensagens.ts";
import { type Model, responder } from "./modelo.ts";
import {
  type AgentSession,
  InputCheckError,
  type Message,
  OutputCheckError,
  type RunContext,
  RunEvent,
  type RunEventData,
  type RunOutput,
  RunStatus,
  agoraS,
  dormir,
  metricasVazias,
  uuid,
} from "./tipos.ts";

export type Hook = (a: { runInput: { inputContent: unknown }; runOutput?: RunOutput; runContext: RunContext; agent: Agent; session: AgentSession }) => unknown;

export type AgentOpts = {
  model: Model;
  name?: string;
  id?: string;
  description?: string;
  role?: string;
  instructions?: string | string[] | ((a: { agent: Agent; sessionState: Record<string, any>; runContext: RunContext }) => string | string[] | Promise<string | string[]>);
  useInstructionTags?: boolean;
  additionalContext?: string;
  expectedOutput?: string;
  markdown?: boolean;
  addDatetimeToContext?: boolean;
  timezoneIdentifier?: string;
  addNameToContext?: boolean;
  resolveInContext?: boolean; // default true
  systemMessage?: string | ((a: { agent: Agent }) => string);
  additionalInput?: Message[];
  tools?: (Function | Toolkit)[];
  toolCallLimit?: number;
  toolChoice?: unknown;
  db?: BaseDb;
  sessionId?: string;
  userId?: string;
  sessionState?: Record<string, any>;
  addSessionStateToContext?: boolean;
  overwriteDbSessionState?: boolean;
  enableAgenticState?: boolean;
  addHistoryToContext?: boolean;
  numHistoryRuns?: number;
  numHistoryMessages?: number;
  maxToolCallsFromHistory?: number;
  readChatHistory?: boolean;
  storeToolMessages?: boolean; // default true
  storeHistoryMessages?: boolean; // default false
  retries?: number; // default 0
  delayBetweenRetries?: number; // s, default 1
  exponentialBackoff?: boolean;
  outputSchema?: Record<string, unknown>; // JSON Schema
  useJsonMode?: boolean;
  preHooks?: Hook[];
  postHooks?: Hook[];
  dependencies?: Record<string, unknown>;
  addDependenciesToContext?: boolean;
  metadata?: Record<string, unknown>;
  introduction?: string;
  storeEvents?: boolean;
  debugMode?: boolean;
  teamId?: string; // setado pelo Team nos membros
};

export type RunOpts = {
  sessionId?: string;
  userId?: string;
  runId?: string;
  sessionState?: Record<string, any>;
  dependencies?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  parentRunId?: string;
  onEvent?: (e: RunEventData) => void;
};

const CURRENT = ["current_user_id", "current_session_id", "current_run_id"];

// deep merge, b vence.
export function mergeDictionaries(a: Record<string, any>, b: Record<string, any>) {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) mergeDictionaries(a[k], v);
    else a[k] = v;
  }
  return a;
}

export class Agent {
  o: AgentOpts;
  model: Model;
  name?: string;
  id: string;
  sessionId?: string;
  constructor(o: AgentOpts) {
    this.o = { resolveInContext: true, storeToolMessages: true, storeHistoryMessages: false, retries: 0, delayBetweenRetries: 1, ...o };
    // sem nenhum dos dois, num_history_runs = 3
    if (this.o.numHistoryRuns === undefined && this.o.numHistoryMessages === undefined) this.o.numHistoryRuns = 3;
    else if (this.o.numHistoryRuns !== undefined && this.o.numHistoryMessages !== undefined) this.o.numHistoryMessages = undefined;
    this.model = o.model;
    this.name = o.name;
    this.id = o.id ?? (o.name ? o.name.toLowerCase().replace(/[ _]/g, "-") : `agent-${uuid().slice(0, 8)}`);
    this.sessionId = o.sessionId;
  }

  // ---------- sessão ----------
  private async lerOuCriarSessao(sessionId: string, userId?: string): Promise<AgentSession> {
    if (this.o.db && !this.o.teamId) {
      const s = await this.o.db.getSession(sessionId, userId); // erro de leitura propaga, de propósito
      if (s) return s;
    }
    const agora = agoraS();
    const s: AgentSession = {
      sessionId,
      agentId: this.id,
      userId,
      agentData: { agent_id: this.id, name: this.name, model: { id: this.model.id, provider: this.model.provider } },
      sessionData: this.o.sessionState ? { sessionState: structuredClone(this.o.sessionState) } : {},
      metadata: this.o.metadata ? structuredClone(this.o.metadata) : undefined,
      runs: [],
      createdAt: agora,
      updatedAt: agora,
    };
    if (this.o.introduction)
      s.runs.push({
        runId: uuid(), agentId: this.id, agentName: this.name, sessionId, userId, input: { inputContent: null }, content: this.o.introduction, contentType: "str",
        messages: [{ role: "assistant", content: this.o.introduction }], metrics: metricasVazias(), tools: [], status: RunStatus.completed, createdAt: agora,
      });
    return s;
  }

  private carregarEstado(s: AgentSession, doRun: Record<string, any>): Record<string, any> {
    const doDb = s.sessionData?.sessionState;
    let estado = doRun;
    if (doDb && Object.keys(doDb).length && !this.o.overwriteDbSessionState) {
      const merged = mergeDictionaries(structuredClone(doDb), doRun);
      for (const k of Object.keys(doRun)) delete doRun[k];
      Object.assign(doRun, merged); // mesma referência
      estado = doRun;
    }
    s.sessionData = { ...(s.sessionData ?? {}), sessionState: estado };
    return estado;
  }

  // ---------- tools padrão ----------
  private toolsDoRun(sessao: AgentSession): (Function | Toolkit)[] {
    const t: (Function | Toolkit)[] = [...(this.o.tools ?? [])];
    if (this.o.readChatHistory)
      t.push(
        tool({
          name: "get_chat_history",
          description: "Use this function to get the chat history between the user and agent.",
          parameters: { type: "object", properties: { num_chats: { type: "integer", description: "The number of chats to return." } } },
          entrypoint: ({ num_chats }) => {
            const h = historicoDaSessao(sessao, {}).map(({ role, content }) => ({ role, content }));
            return JSON.stringify(num_chats ? h.slice(-num_chats) : h);
          },
        }),
      );
    if (this.o.enableAgenticState)
      t.push(
        tool({
          name: "update_session_state",
          description: "Update the shared session state. Provide any updates as a dictionary of key-value pairs.",
          parameters: { type: "object", properties: { session_state_updates: { type: "object", description: "The updates to apply to the shared session state." } }, required: ["session_state_updates"] },
          entrypoint: ({ session_state_updates }, { runContext }) => {
            Object.assign(runContext.sessionState, session_state_updates ?? {}); // atribuição rasa
            return `Updated session state: ${JSON.stringify(runContext.sessionState)}`;
          },
        }),
      );
    return t;
  }

  private async instrucoes(ctx: RunContext): Promise<string[]> {
    const i = this.o.instructions;
    const v = typeof i === "function" ? await i({ agent: this, sessionState: ctx.sessionState, runContext: ctx }) : i;
    return [...(v === undefined ? [] : Array.isArray(v) ? v : [v]), ...(this.model.instructions ?? [])];
  }

  // ---------- run ----------
  async run(input: string | Message[], opts: RunOpts = {}): Promise<RunOutput> {
    const runId = opts.runId ?? uuid();
    const sessionId = opts.sessionId ?? this.sessionId ?? uuid();
    if (!opts.sessionId && !this.sessionId) this.sessionId = sessionId; // sticky
    const userId = opts.userId || this.o.userId;
    const deps = { ...(this.o.dependencies ?? {}), ...(opts.dependencies ?? {}) };
    const metadata = { ...(this.o.metadata ?? {}), ...(opts.metadata ?? {}) };
    const eventos: RunEventData[] = [];
    const emitir = (e: Omit<RunEventData, "createdAt" | "agentId" | "agentName" | "runId" | "sessionId" | "parentRunId">) => {
      const ev: RunEventData = { createdAt: agoraS(), agentId: this.id, agentName: this.name, runId, sessionId, parentRunId: opts.parentRunId, ...e };
      if (this.o.storeEvents && ev.event !== RunEvent.runContent) eventos.push(ev);
      try {
        opts.onEvent?.(ev);
      } catch {}
    };
    const t0 = Date.now();
    const out: RunOutput = {
      runId, agentId: this.id, agentName: this.name, sessionId, userId, parentRunId: opts.parentRunId, teamId: this.o.teamId,
      input: { inputContent: input }, content: null, contentType: "str", model: this.model.id, modelProvider: this.model.provider,
      messages: [], metrics: metricasVazias(), tools: [], metadata, status: RunStatus.running, createdAt: agoraS(),
    };
    const ctx: RunContext = { runId, sessionId, userId, dependencies: deps, metadata, sessionState: opts.sessionState ?? {}, messages: [], outputSchema: this.o.outputSchema };
    let sessao = await this.lerOuCriarSessao(sessionId, userId);
    emitir({ event: RunEvent.runStarted, model: this.model.id, modelProvider: this.model.provider });
    const tentativas = (this.o.retries ?? 0) + 1;

    for (let tentativa = 0; tentativa < tentativas; tentativa++) {
      let msgs: Message[] = [];
      try {
        if (tentativa > 0) sessao = await this.lerOuCriarSessao(sessionId, userId);
        ctx.sessionState = this.carregarEstado(sessao, ctx.sessionState);
        if (userId) ctx.sessionState.current_user_id = userId;
        ctx.sessionState.current_session_id = sessionId;
        ctx.sessionState.current_run_id = runId;

        const runInput = { inputContent: input };
        for (const h of this.o.preHooks ?? []) {
          emitir({ event: RunEvent.preHookStarted });
          await this.rodarHook(h, { runInput, runContext: ctx, agent: this, session: sessao });
          emitir({ event: RunEvent.preHookCompleted });
        }

        const itens = this.toolsDoRun(sessao);
        const functions = achatarTools(itens);
        const strictForcado = !!this.o.outputSchema && !this.o.useJsonMode;
        const toolsParaModelo = [...functions.values()].sort((a, b) => a.name.localeCompare(b.name)).map((f) => f.paraModelo(strictForcado));
        msgs = await this.montarMensagens(runInput.inputContent as string | Message[], sessao, ctx, instrucoesDasTools(itens), deps, metadata);
        ctx.messages = msgs;

        const responseFormat = this.o.outputSchema
          ? this.o.useJsonMode
            ? { type: "json_object" }
            : { type: "json_schema", json_schema: { name: "output", schema: schemaStrict(this.o.outputSchema), strict: true } }
          : undefined;
        const injetados: Injetados = { runContext: ctx, agent: this };
        const r = await responder(this.model, {
          messages: msgs,
          functions,
          toolsParaModelo,
          toolChoice: this.o.toolChoice,
          toolCallLimit: this.o.toolCallLimit,
          responseFormat,
          injetados,
          toolCache: this.o.db,
          emitir: (e) => emitir(e),
        });

        out.content = r.content;
        out.model = r.model ?? this.model.id;
        out.tools = r.toolExecutions;
        out.messages = msgs.filter((m) => m.addToAgentMemory !== false);
        out.metrics = { ...out.metrics, inputTokens: r.metrics.inputTokens, outputTokens: r.metrics.outputTokens, totalTokens: r.metrics.inputTokens + r.metrics.outputTokens, modelRequests: r.metrics.modelRequests };
        if (this.o.outputSchema && typeof out.content === "string") {
          try {
            out.content = JSON.parse(out.content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
            out.contentType = "dict";
          } catch {
            console.warn("[arandu] saída estruturada não é JSON válido; content fica string");
          }
        }
        if (out.content !== null) emitir({ event: RunEvent.runContent, content: out.content });

        for (const h of this.o.postHooks ?? []) {
          emitir({ event: RunEvent.postHookStarted });
          await this.rodarHook(h, { runInput, runOutput: out, runContext: ctx, agent: this, session: sessao });
          emitir({ event: RunEvent.postHookCompleted });
        }
        out.status = RunStatus.completed;
        out.metrics.durationMs = Date.now() - t0;
        emitir({ event: RunEvent.runContentCompleted });
        emitir({ event: RunEvent.runCompleted, content: out.content, metrics: out.metrics, sessionState: this.estadoLimpo(ctx.sessionState) });
        await this.persistir(out, sessao, ctx, eventos);
        return out;
      } catch (e: any) {
        if (e instanceof InputCheckError || e instanceof OutputCheckError) {
          out.status = RunStatus.error;
          out.content ??= String(e.message ?? e);
          emitir({ event: RunEvent.runError, error: String(e.message ?? e) });
          await this.persistir(out, sessao, ctx, eventos);
          return out;
        }
        if (tentativa < tentativas - 1) {
          const atraso = this.o.exponentialBackoff ? (this.o.delayBetweenRetries ?? 1) * 2 ** tentativa : (this.o.delayBetweenRetries ?? 1);
          if (this.o.debugMode) console.warn(`[arandu] Attempt ${tentativa + 1}/${tentativas} failed. Retrying in ${atraso}s...: ${e?.message ?? e}`);
          await dormir(atraso * 1000);
          continue;
        }
        // Esgotou: não lança. Status ERROR, content = String(e), persiste e devolve.
        out.status = RunStatus.error;
        if (!out.messages.length) out.messages = msgs;
        out.content ??= String(e?.message ?? e);
        out.metrics.durationMs = Date.now() - t0;
        emitir({ event: RunEvent.runError, error: String(e?.message ?? e) });
        await this.persistir(out, sessao, ctx, eventos).catch(() => {});
        return out;
      }
    }
    throw new Error("inalcançável");
  }

  // Stream de eventos (sem streaming de tokens do provedor: o RunContent sai inteiro).
  async *runStream(input: string | Message[], opts: RunOpts = {}): AsyncGenerator<RunEventData | RunOutput> {
    const fila: (RunEventData | RunOutput)[] = [];
    let acordar: (() => void) | null = null;
    let fim = false;
    const p = this.run(input, { ...opts, onEvent: (e) => (fila.push(e), acordar?.(), opts.onEvent?.(e)) }).then((r) => {
      fila.push(r);
      fim = true;
      acordar?.();
    });
    while (!fim || fila.length) {
      if (!fila.length) await new Promise<void>((r) => (acordar = r));
      acordar = null;
      while (fila.length) yield fila.shift()!;
    }
    await p;
  }

  private async rodarHook(h: Hook, a: Parameters<Hook>[0]) {
    try {
      await h(a);
    } catch (e) {
      if (e instanceof InputCheckError || e instanceof OutputCheckError) throw e;
      console.warn("[arandu] hook falhou (ignorado):", e);
    }
  }

  private async montarMensagens(input: string | Message[], sessao: AgentSession, ctx: RunContext, toolInstr: string[], deps: Record<string, unknown>, metadata: Record<string, unknown>): Promise<Message[]> {
    const vars = this.o.resolveInContext ? [ctx.sessionState, deps, metadata, { user_id: ctx.userId }] : null;
    const msgs: Message[] = [];
    let sistema: string | null;
    if (this.o.systemMessage !== undefined) {
      const s = typeof this.o.systemMessage === "function" ? this.o.systemMessage({ agent: this }) : this.o.systemMessage;
      sistema = vars ? formatarComVariaveis(s, vars) : s;
    } else
      sistema = montarSistema({
        description: this.o.description,
        role: this.o.role,
        instructions: await this.instrucoes(ctx),
        useInstructionTags: this.o.useInstructionTags,
        markdown: this.o.markdown,
        temOutputSchema: !!this.o.outputSchema,
        dataHora: this.o.addDatetimeToContext ? dataHoraNoFuso(this.o.timezoneIdentifier) : undefined,
        name: this.name,
        addNameToContext: this.o.addNameToContext,
        toolInstructions: toolInstr,
        expectedOutput: this.o.expectedOutput,
        additionalContext: this.o.additionalContext,
        jsonPrompt: this.o.outputSchema && this.o.useJsonMode ? promptJson(this.o.outputSchema) : undefined,
        sessionState: ctx.sessionState,
        addSessionStateToContext: this.o.addSessionStateToContext,
        variaveis: vars,
      });
    if (sistema) msgs.push({ role: "system", content: sistema });
    msgs.push(...(this.o.additionalInput ?? []));
    if (this.o.addHistoryToContext)
      msgs.push(...historicoDaSessao(sessao, { numHistoryRuns: this.o.numHistoryRuns, numHistoryMessages: this.o.numHistoryMessages, skipRoles: ["system"], maxToolCallsFromHistory: this.o.maxToolCallsFromHistory }));
    if (Array.isArray(input)) msgs.push(...input);
    else {
      let txt = vars ? formatarComVariaveis(input, vars) : input;
      if (this.o.addDependenciesToContext && Object.keys(deps).length) txt += `\n\n<additional context>\n${JSON.stringify(deps, null, 2)}\n</additional context>`;
      msgs.push({ role: "user", content: txt });
    }
    return msgs;
  }

  private estadoLimpo(s: Record<string, any>) {
    const c = { ...s };
    for (const k of CURRENT) delete c[k];
    return c;
  }

  // scrub, métricas somadas, estado sem current_*, sessão e depois run.
  private async persistir(out: RunOutput, sessao: AgentSession, ctx: RunContext, eventos: RunEventData[]) {
    out.sessionState = this.estadoLimpo(ctx.sessionState);
    if (this.o.storeEvents) out.events = eventos;
    let msgs = out.messages;
    if (!this.o.storeHistoryMessages) msgs = msgs.filter((m) => !m.fromHistory);
    if (!this.o.storeToolMessages) msgs = msgs.filter((m) => m.role !== "tool" && !(m.role === "assistant" && m.toolCalls?.length));
    const copia: RunOutput = { ...out, messages: msgs };
    const i = sessao.runs.findIndex((r) => r.runId === copia.runId);
    if (i >= 0) sessao.runs[i] = copia;
    else sessao.runs.push(copia);
    const soma = metricasVazias();
    for (const r of sessao.runs) for (const k of Object.keys(soma) as (keyof typeof soma)[]) (soma as any)[k] = ((soma as any)[k] ?? 0) + ((r.metrics as any)?.[k] ?? 0);
    sessao.sessionData = { ...(sessao.sessionData ?? {}), sessionState: out.sessionState, sessionMetrics: soma };
    if (!this.o.db || this.o.teamId) return;
    try {
      await this.o.db.upsertSession({ ...sessao, runs: [] });
    } catch (e) {
      console.warn("[arandu] upsert_session falhou:", e);
    }
    try {
      for (const r of sessao.runs.filter((r) => r.runId === copia.runId || (r.content === this.o.introduction && sessao.runs.indexOf(r) === 0)))
        await this.o.db.upsertRun(r, sessao.sessionId, sessao.userId);
    } catch (e) {
      console.warn("[arandu] upsert_run falhou:", e);
    }
  }
}
