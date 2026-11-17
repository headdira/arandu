// Arandu — tools (porte modificado de tools/decorator.py, tools/function.py, tools/toolkit.py).
// Em TS não há type hints/docstring: o schema JSON é explícito. Injeção por nome do Agno vira um
// 2º argumento { runContext, agent } na função.
import { createHash } from "node:crypto";
import type { RunContext, ToolExecution } from "./tipos.ts";

export type JsonSchema = { type: "object"; properties: Record<string, any>; required?: string[]; additionalProperties?: boolean; [k: string]: unknown };
export type Injetados = { runContext: RunContext; agent: unknown };
export type Entrypoint = (args: any, ctx: Injetados) => unknown | Promise<unknown>;

export type FunctionOpts = {
  name: string;
  description?: string;
  parameters?: JsonSchema;
  strict?: boolean;
  instructions?: string;
  addInstructions?: boolean; // default true (tools/decorator.py)
  showResult?: boolean;
  stopAfterToolCall?: boolean;
  preHook?: (ctx: { name: string; args: any; runContext: RunContext }) => unknown;
  postHook?: (ctx: { name: string; args: any; runContext: RunContext; result?: string; error?: string }) => unknown;
  cacheResults?: boolean;
  cacheTtl?: number; // segundos, default 3600
  entrypoint: Entrypoint;
};

export class Function {
  name: string;
  description?: string;
  parameters: JsonSchema;
  strict?: boolean;
  instructions?: string;
  addInstructions: boolean;
  showResult: boolean;
  stopAfterToolCall: boolean;
  preHook?: FunctionOpts["preHook"];
  postHook?: FunctionOpts["postHook"];
  cacheResults: boolean;
  cacheTtl: number;
  entrypoint: Entrypoint;
  // tools/function.py:1215-1325
  constructor(o: FunctionOpts) {
    this.name = o.name;
    this.description = o.description;
    this.parameters = o.parameters ?? { type: "object", properties: {}, required: [] };
    this.strict = o.strict;
    this.instructions = o.instructions;
    this.addInstructions = o.addInstructions ?? true;
    this.stopAfterToolCall = o.stopAfterToolCall ?? false;
    // decorator.py:292-294: stop_after_tool_call sem show_result explícito → show_result=True
    this.showResult = o.showResult ?? this.stopAfterToolCall;
    this.preHook = o.preHook;
    this.postHook = o.postHook;
    this.cacheResults = o.cacheResults ?? false;
    this.cacheTtl = o.cacheTtl ?? 3600;
    this.entrypoint = o.entrypoint;
  }

  // to_dict(): name/description/parameters/strict (sem None).
  paraModelo(strictForcado = false): { type: "function"; function: Record<string, unknown> } {
    const strict = this.strict ?? strictForcado;
    const parameters = strict ? schemaStrict(this.parameters) : schemaNormal(this.parameters);
    const f: Record<string, unknown> = { name: this.name, parameters };
    if (this.description) f.description = this.description;
    if (strict) f.strict = true;
    return { type: "function", function: f };
  }
}

// @tool → tool({...}). Retorna Function, como no Agno.
export const tool = (o: FunctionOpts) => new Function(o);

// function.py:1693-1709 — schema à mão: additionalProperties false; required mantido do autor.
function schemaNormal(s: JsonSchema): JsonSchema {
  return { ...s, type: "object", properties: s.properties ?? {}, required: (s.required ?? []).filter((r) => r in (s.properties ?? {})), additionalProperties: false };
}

// function.py:1831-1887 — strict: todo objeto fecha e todas as properties viram required.
export function schemaStrict(s: any): any {
  if (Array.isArray(s)) return s.map(schemaStrict);
  if (!s || typeof s !== "object") return s;
  const o: any = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, schemaStrict(v)]));
  if (o.properties && !o.type) o.type = "object";
  if (o.type === "object") {
    o.properties = o.properties ?? {};
    o.required = Object.keys(o.properties);
    o.additionalProperties = false;
  }
  return o;
}

// tools/toolkit.py:115-325
export type ToolkitOpts = {
  name?: string;
  tools: Function[];
  instructions?: string;
  addInstructions?: boolean; // default false (difere do @tool)
  includeTools?: string[];
  excludeTools?: string[];
  stopAfterToolCallTools?: string[];
  showResultTools?: string[];
  cacheResults?: boolean;
  cacheTtl?: number;
};

export class Toolkit {
  name: string;
  instructions?: string;
  addInstructions: boolean;
  functions: Function[];
  constructor(o: ToolkitOpts) {
    this.name = o.name ?? "toolkit";
    this.instructions = o.instructions;
    this.addInstructions = o.addInstructions ?? false;
    const nomes = new Set(o.tools.map((t) => t.name));
    for (const n of [...(o.includeTools ?? []), ...(o.excludeTools ?? [])])
      if (!nomes.has(n)) throw new Error(`Tool "${n}" não existe no toolkit ${this.name}`);
    this.functions = o.tools
      .filter((t) => (!o.includeTools || o.includeTools.includes(t.name)) && !(o.excludeTools ?? []).includes(t.name))
      .map((t) => {
        const stop = t.stopAfterToolCall || !!o.stopAfterToolCallTools?.includes(t.name);
        return new Function({
          ...t,
          stopAfterToolCall: stop,
          showResult: t.showResult || stop || !!o.showResultTools?.includes(t.name),
          cacheResults: t.cacheResults || !!o.cacheResults,
          cacheTtl: o.cacheTtl ?? t.cacheTtl,
        });
      });
  }
}

export type CacheStore = {
  getCache(chave: string): Promise<{ valor: string; em: number } | null>;
  setCache(chave: string, valor: string): Promise<void>;
};

// utils/functions.py:10-75 — parse dos argumentos com as mensagens literais do Agno.
export function parseArgs(raw: string | null | undefined): { ok: true; args: Record<string, unknown> } | { ok: false; erro: string } {
  const txt = raw && raw.trim() ? raw : "{}";
  let v: unknown;
  try {
    v = JSON.parse(txt);
  } catch (e) {
    return { ok: false, erro: `Error while decoding function arguments: ${e}\n\nPlease make sure we can json.loads() the arguments and retry.` };
  }
  if (Array.isArray(v) && v.length === 0) return { ok: true, args: {} };
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, erro: "Function arguments are not a valid JSON object.\n\n Please fix and retry." };
  const args: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") {
      const s = val.trim().toLowerCase();
      args[k] = s === "none" || s === "null" ? null : s === "true" ? true : s === "false" ? false : val;
    } else args[k] = val;
  }
  return { ok: true, args };
}

// models/base.py:2347-2365 — DESVIO: não-string vira JSON (o Agno faz str() do Python).
export const stringificar = (r: unknown): string => (typeof r === "string" ? r : r === undefined ? "None" : JSON.stringify(r));

// function.py:1890-1949 — chave do cache: nome + identidade (user/sessão) + args ordenados.
function chaveCache(f: Function, args: Record<string, unknown>, ctx: RunContext) {
  const ordenado = JSON.stringify(Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))));
  const identidade = JSON.stringify({ user_id: ctx.userId ?? null, session_id: ctx.sessionId });
  return "tool:" + createHash("md5").update(`${f.name}:${identidade}:${ordenado}`).digest("hex");
}

// tools/function.py:2618-2731 + models/base.py:2169-2207 — executa e devolve a mensagem tool.
export async function executarFuncao(
  f: Function,
  call: { id: string; argumentos: Record<string, unknown> },
  inj: Injetados,
  cache?: CacheStore,
): Promise<ToolExecution> {
  const t0 = Date.now();
  const base = { toolCallId: call.id, toolName: f.name, toolArgs: call.argumentos, stopAfterToolCall: f.stopAfterToolCall, createdAt: Math.floor(t0 / 1000) };
  let chave: string | null = null;
  try {
    await f.preHook?.({ name: f.name, args: call.argumentos, runContext: inj.runContext });
    if (f.cacheResults && cache) {
      chave = chaveCache(f, call.argumentos, inj.runContext);
      const hit = await cache.getCache(chave).catch(() => null);
      if (hit && Date.now() / 1000 - hit.em <= f.cacheTtl) {
        await f.postHook?.({ name: f.name, args: call.argumentos, runContext: inj.runContext, result: hit.valor });
        return { ...base, toolCallError: false, result: hit.valor, durationMs: Date.now() - t0, cached: true };
      }
    }
    const result = stringificar(await f.entrypoint(call.argumentos, inj));
    if (chave && cache) await cache.setCache(chave, result).catch(() => {});
    await f.postHook?.({ name: f.name, args: call.argumentos, runContext: inj.runContext, result });
    return { ...base, toolCallError: false, result, durationMs: Date.now() - t0 };
  } catch (e: any) {
    // Exceção comum: o modelo recebe só str(e), com tool_call_error=True.
    const erro = String(e?.message ?? e);
    await Promise.resolve(f.postHook?.({ name: f.name, args: call.argumentos, runContext: inj.runContext, error: erro })).catch(() => {});
    return { ...base, toolCallError: true, result: erro, durationMs: Date.now() - t0 };
  }
}

// Instruções das tools no system message (agent/_tools.py:483-665).
export function instrucoesDasTools(itens: (Function | Toolkit)[]): string[] {
  const out: string[] = [];
  for (const i of itens) {
    if (i instanceof Toolkit) {
      if (i.addInstructions && i.instructions) out.push(i.instructions);
      for (const f of i.functions) if (f.addInstructions && f.instructions) out.push(f.instructions);
    } else if (i.addInstructions && i.instructions) out.push(i.instructions);
  }
  return out;
}

// parse_tools: achata toolkits; nome duplicado é descartado (o primeiro vence).
export function achatarTools(itens: (Function | Toolkit)[]): Map<string, Function> {
  const m = new Map<string, Function>();
  for (const i of itens)
    for (const f of i instanceof Toolkit ? i.functions : [i]) {
      if (m.has(f.name)) console.warn(`[arandu] tool duplicada ignorada: ${f.name}`);
      else m.set(f.name, f);
    }
  return m;
}
