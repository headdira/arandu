// Arandu — montagem das mensagens (porte modificado de agent/_messages.py, utils/message.py,
// utils/prompts.py e session/agent.py:get_messages).
import { HISTORY_SKIP_STATUSES, type AgentSession, type Message } from "./tipos.ts";

// utils/message.py:375-392
export function renderInstructions(lista: string[]): string {
  const itens = lista.map((i) => i.trim()).filter(Boolean);
  if (itens.length === 1) return itens[0];
  if (itens.every((i) => !i.includes("\n"))) return itens.map((i) => `- ${i}`).join("\n");
  return itens.map((i) => (i.includes("\n") ? i : `- ${i}`)).join("\n\n");
}

// agent/_messages.py:885-929 — {chave} (e $chave) com session_state > dependencies > metadata > user_id.
// DESVIO: valores não-string viram JSON (o Agno usa str() do Python).
export function formatarComVariaveis(texto: string, fontes: Record<string, unknown>[]): string {
  if (!texto.includes("{") && !texto.includes("$")) return texto;
  const vars: Record<string, unknown> = {};
  for (const f of [...fontes].reverse()) Object.assign(vars, f ?? {});
  const val = (k: string) => {
    const v = vars[k];
    return typeof v === "string" ? v : JSON.stringify(v);
  };
  let t = texto;
  for (const k of Object.keys(vars)) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`\\{${esc}\\}`, "g"), () => val(k));
  }
  return t;
}

// utils/prompts.py:9-94 (schema dict/str; DESVIO: termina citando JSON.parse no lugar de json.loads)
export function promptJson(schema: unknown): string {
  let p = "Provide your output as a JSON containing the following fields:";
  p += typeof schema === "string" ? `\n<json_fields>\n${schema}\n</json_fields>` : `\n<json_fields>\n${JSON.stringify(schema)}\n</json_fields>`;
  p += "\nStart your response with `{` and end it with `}`.";
  p += "\nYour output will be passed to JSON.parse() to convert it to an object.";
  p += "\nMake sure it only contains valid JSON.";
  return p;
}

export type PartesSistema = {
  description?: string;
  role?: string;
  instructions: string[];
  useInstructionTags?: boolean;
  markdown?: boolean;
  temOutputSchema?: boolean;
  dataHora?: string; // já formatada
  name?: string;
  addNameToContext?: boolean;
  toolInstructions: string[];
  expectedOutput?: string;
  additionalContext?: string;
  jsonPrompt?: string;
  sessionState?: Record<string, unknown>;
  addSessionStateToContext?: boolean;
  variaveis?: Record<string, unknown>[] | null; // null = sem resolve_in_context
};

// agent/_messages.py:1017-1256 — ordem, tags e textos literais do Agno.
export function montarSistema(p: PartesSistema): string | null {
  const adicional: string[] = [];
  if (p.markdown && !p.temOutputSchema) adicional.push("Use markdown to format your answers.");
  if (p.dataHora) adicional.push(`The current time is ${p.dataHora}.`);
  if (p.name && p.addNameToContext) adicional.push(`Your name is: ${p.name}.`);

  let s = "";
  if (p.description) s += `${p.description}\n`;
  if (p.role) s += `\n<your_role>\n${p.role}\n</your_role>\n\n`;
  if (p.instructions.length) {
    const r = renderInstructions(p.instructions);
    s += p.useInstructionTags ? `<instructions>\n${r}\n</instructions>\n\n` : `${r}\n\n`;
  }
  if (adicional.length) s += `<additional_information>${adicional.map((a) => `\n- ${a}`).join("")}\n</additional_information>\n\n`;
  for (const ti of p.toolInstructions) s += `${ti}\n`;
  if (p.variaveis) s = formatarComVariaveis(s, p.variaveis); // só até as instruções de tools, como no Agno
  if (p.expectedOutput) s += `<expected_output>\n${p.expectedOutput.trim()}\n</expected_output>\n\n`;
  if (p.additionalContext) s += `${p.additionalContext}\n`;
  if (p.jsonPrompt) s += p.jsonPrompt;
  if (p.addSessionStateToContext && p.sessionState) s += `\n<session_state>\n${JSON.stringify(p.sessionState)}\n</session_state>\n\n`;
  s = s.trim();
  return s ? s : null;
}

// session/agent.py:141-262 + agent/_messages.py:247-293/2016-2045
export function historicoDaSessao(
  sessao: AgentSession | null,
  o: { numHistoryRuns?: number; numHistoryMessages?: number; skipRoles?: string[]; maxToolCallsFromHistory?: number },
): Message[] {
  if (!sessao?.runs?.length) return [];
  let runs = sessao.runs.filter((r) => !r.parentRunId && !HISTORY_SKIP_STATUSES.includes(r.status));
  if (o.numHistoryRuns !== undefined) {
    if (o.numHistoryRuns <= 0) return [];
    runs = runs.slice(-o.numHistoryRuns);
  }
  let msgs: Message[] = [];
  let sistema: Message | null = null;
  for (const r of runs)
    for (const m of r.messages ?? []) {
      if (m.fromHistory || o.skipRoles?.includes(m.role)) continue;
      if (m.role === "system") {
        if (!sistema) sistema = m;
        continue;
      }
      msgs.push(m);
    }
  if (o.numHistoryMessages !== undefined) {
    msgs = msgs.slice(-Math.max(0, o.numHistoryMessages - (sistema ? 1 : 0)));
    while (msgs[0]?.role === "tool") msgs.shift(); // tool órfão no começo da janela
  }
  if (o.maxToolCallsFromHistory !== undefined) msgs = limitarToolsDoHistorico(msgs, o.maxToolCallsFromHistory);
  const todas = sistema ? [sistema, ...msgs] : msgs;
  return todas.map((m) => ({ ...m, fromHistory: true }));
}

// utils/message.py:110-165
function limitarToolsDoHistorico(msgs: Message[], max: number): Message[] {
  const tools = msgs.filter((m) => m.role === "tool");
  if (tools.length <= max) return msgs;
  const manter = new Set(tools.slice(tools.length - max).map((m) => m.toolCallId));
  const out: Message[] = [];
  for (const m of msgs) {
    if (m.role === "tool") {
      if (manter.has(m.toolCallId)) out.push(m);
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      const tc = m.toolCalls.filter((t) => manter.has(t.id));
      if (tc.length) out.push({ ...m, toolCalls: tc });
      else if (m.content) out.push({ ...m, toolCalls: undefined });
    } else out.push(m);
  }
  return out;
}

// Python-ismo trocado por ISO local: "2026-11-16 10:00:00-03:00" no fuso dado.
export function dataHoraNoFuso(fuso?: string, agora = new Date()): string {
  const tz = fuso || "UTC";
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" })
        .formatToParts(agora)
        .map((x) => [x.type, x.value]),
    );
    const off = String(p.timeZoneName ?? "").replace("GMT", "") || "+00:00";
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}${off}`;
  } catch {
    return agora.toISOString();
  }
}
