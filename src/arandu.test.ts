import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, InMemoryDb, Model, ModelProviderError, RunEvent, RunStatus, Team, Toolkit, tool, type Invocacao, type RespostaInvocacao } from "./index.ts";
import { montarSistema, renderInstructions } from "./mensagens.ts";

// Modelo falso: devolve, em ordem, as respostas roteirizadas; guarda o que recebeu.
class Falso extends Model {
  pedidos: Invocacao[] = [];
  roteiro: (RespostaInvocacao | Error | ((r: Invocacao) => RespostaInvocacao))[];
  constructor(roteiro: (RespostaInvocacao | Error | ((r: Invocacao) => RespostaInvocacao))[]) {
    super({ id: "falso" });
    this.roteiro = roteiro;
  }
  async invoke(r: Invocacao) {
    this.pedidos.push(structuredClone(r));
    const p = this.roteiro.shift();
    if (!p) throw new Error("roteiro acabou");
    if (p instanceof Error) throw p;
    return typeof p === "function" ? p(r) : p;
  }
}
const txt = (content: string): RespostaInvocacao => ({ message: { content } });
const chama = (...cs: [string, object][]): RespostaInvocacao => ({
  message: { content: null, toolCalls: cs.map(([n, a], i) => ({ id: `call_${i}${n}`, type: "function" as const, function: { name: n, arguments: JSON.stringify(a) } })) },
});

test("system message: ordem e textos", () => {
  assert.equal(renderInstructions(["a"]), "a");
  assert.equal(renderInstructions(["a", "b"]), "- a\n- b");
  const s = montarSistema({
    description: "Você é a Ana.",
    instructions: ["Seja breve.", "Use as tools."],
    markdown: true,
    dataHora: "2026-11-16 10:00:00-03:00",
    name: "Ana",
    addNameToContext: true,
    toolInstructions: ["Use agendar para marcar."],
    expectedOutput: "Resposta curta",
    additionalContext: "Contexto X",
    sessionState: { plano: "basic" },
    addSessionStateToContext: true,
    variaveis: [{ plano: "basic" }],
  });
  assert.equal(
    s,
    "Você é a Ana.\n- Seja breve.\n- Use as tools.\n\n<additional_information>\n- Use markdown to format your answers.\n- The current time is 2026-11-16 10:00:00-03:00.\n- Your name is: Ana.\n</additional_information>\n\nUse agendar para marcar.\n<expected_output>\nResposta curta\n</expected_output>\n\nContexto X\n\n<session_state>\n{\"plano\":\"basic\"}\n</session_state>",
  );
});

test("loop de tools: injeção de runContext, session_state, limite que não para o loop, erro vira str(e)", async () => {
  const visto: any[] = [];
  const somar = tool({
    name: "somar",
    description: "soma",
    parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
    entrypoint: ({ a, b }, { runContext }) => {
      visto.push(runContext.userId);
      runContext.sessionState.somas = (runContext.sessionState.somas ?? 0) + 1;
      return { total: a + b };
    },
  });
  const quebra = tool({ name: "quebra", entrypoint: () => { throw new Error("deu ruim"); } });
  const m = new Falso([chama(["somar", { a: 1, b: 2 }], ["quebra", {}], ["somar", { a: 5, b: 5 }], ["nao_existe", {}]), txt("Total 3.")]);
  const db = new InMemoryDb();
  const ag = new Agent({ model: m, name: "Calc", tools: [new Toolkit({ tools: [somar, quebra] })], toolCallLimit: 2, db, sessionState: { somas: 0 } });
  const r = await ag.run("soma", { userId: "u1", sessionId: "s1" });
  assert.equal(r.status, RunStatus.completed);
  assert.equal(r.content, "Total 3.");
  assert.deepEqual(visto, ["u1"]);
  const tools = m.pedidos[1].messages.filter((x) => x.role === "tool").map((x) => x.content);
  assert.deepEqual(tools, [
    '{"total":3}',
    "deu ruim",
    "Tool call limit reached. Tool call somar not executed. Don't try to execute it again.",
    "Error: The requested tool does not exist or is not available.",
  ]);
  // tools vão ordenadas por nome
  assert.deepEqual(m.pedidos[0].tools!.map((t) => t.function.name), ["quebra", "somar"]);
  const s = await db.getSession("s1");
  assert.deepEqual(s!.sessionData.sessionState, { somas: 1 }); // sem current_*
  assert.equal(s!.runs.length, 1);
});

test("stop_after_tool_call + show_result encerram sem nova chamada ao modelo", async () => {
  const fim = tool({ name: "responder_direto", stopAfterToolCall: true, entrypoint: () => "resposta da tool" });
  const m = new Falso([chama(["responder_direto", {}])]);
  const r = await new Agent({ model: m, tools: [fim] }).run("x");
  assert.equal(r.content, "resposta da tool");
  assert.equal(m.pedidos.length, 1);
});

test("retries com backoff: erro final não lança, vira RunOutput ERROR com str(e); retry de modelo respeita 4xx", async () => {
  const m = new Falso([new Error("falhou 1"), new Error("falhou 2")]);
  const ev: string[] = [];
  const r = await new Agent({ model: m, retries: 1, delayBetweenRetries: 0 }).run("oi", { onEvent: (e) => ev.push(e.event) });
  assert.equal(r.status, RunStatus.error);
  assert.equal(r.content, "falhou 2");
  assert.ok(ev.includes(RunEvent.runError));

  const m2 = new Falso([new ModelProviderError("429 lento", 429), txt("ok")]);
  m2.retries = 1;
  m2.delayBetweenRetries = 0;
  assert.equal((await new Agent({ model: m2 }).run("oi")).content, "ok");
  const m3 = new Falso([new ModelProviderError("400 ruim", 400), txt("nunca")]);
  m3.retries = 3;
  assert.equal((await new Agent({ model: m3 }).run("oi")).status, RunStatus.error);
});

test("histórico: últimos 3 runs, pula ERROR, sem system, mensagens marcadas from_history", async () => {
  const db = new InMemoryDb();
  const respostas = ["r1", "r2", "r3", "r4"].map(txt);
  // m3 dá erro (run ERROR); no m5 o histórico = últimos 3 runs válidos: m1, m2, m4
  const m = new Falso([...respostas.slice(0, 2), new Error("x"), ...respostas.slice(2)]);
  const ag = new Agent({ model: m, db, addHistoryToContext: true, instructions: "Seja breve." });
  for (const i of ["m1", "m2", "m3", "m4", "m5"]) await ag.run(i, { sessionId: "h" });
  const ultimo = m.pedidos.at(-1)!.messages;
  assert.equal(ultimo.filter((x) => x.role === "system").length, 1);
  assert.deepEqual(ultimo.filter((x) => x.fromHistory).map((x) => x.content), ["m1", "r1", "m2", "r2", "m4", "r3"]);
});

test("Team route: líder delega, resposta do membro vai direto, estado volta ao time", async () => {
  const membroModel = new Falso([txt("Agendado para terça.")]);
  const membro = new Agent({ model: membroModel, name: "Agenda", role: "Cuida da agenda", tools: [tool({ name: "x", entrypoint: () => "" })] });
  const lider = new Falso([chama(["delegate_task_to_member", { member_id: "agenda", task: "marcar terça" }])]);
  const t = new Team({ model: lider, name: "Recepção", members: [membro], mode: "route", db: new InMemoryDb() });
  const r = await t.run("quero marcar", { sessionId: "t1" });
  assert.equal(r.content, "Agendado para terça.");
  assert.equal(lider.pedidos.length, 1);
  assert.match(String(lider.pedidos[0].messages[0].content), /<member id="agenda" name="Agenda">\n {2}Role: Cuida da agenda/);
  assert.equal(r.memberRuns!.length, 1);
  assert.equal(r.memberRuns![0].parentRunId, r.runId);
});
