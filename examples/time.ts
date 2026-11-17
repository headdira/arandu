// Orquestração: um líder recebe o pedido e encaminha para o especialista certo (modo "route").
//   OPENAI_BASE_URL=... OPENAI_API_KEY=... MODELO=... npm run exemplo:time
import { Agent, InMemoryDb, OpenAILike, Team, tool } from "../src/index.ts";

const modelo = new OpenAILike({
  id: process.env.MODELO ?? "gpt-4o-mini",
  baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY ?? "",
});

const financeiro = new Agent({
  name: "Financeiro",
  role: "Responde sobre faturas, boletos e pagamentos.",
  model: modelo,
  addDatetimeToContext: true,
  tools: [
    tool({
      name: "segunda_via",
      description: "Gera a segunda via do boleto do mês.",
      parameters: { type: "object", properties: { mes: { type: "string", description: "AAAA-MM" } }, required: ["mes"] },
      entrypoint: async ({ mes }) => JSON.stringify({ mes, linhaDigitavel: "00190.00009 01234.567890 12345.678901 1 99990000012345" }),
    }),
  ],
});

const tecnico = new Agent({
  name: "Técnico",
  role: "Resolve problemas de acesso, senha e uso do sistema.",
  model: modelo,
  instructions: ["Dê no máximo 3 passos curtos."],
});

const atendimento = new Team({
  name: "Atendimento",
  mode: "route", // "coordinate" faz o líder combinar as respostas de vários membros
  model: modelo,
  members: [financeiro, tecnico],
  db: new InMemoryDb(),
});

for (const msg of ["preciso da segunda via do boleto de novembro", "não consigo entrar, esqueci a senha"]) {
  const r = await atendimento.run(msg, { sessionId: `demo-${msg.length}` });
  const quem = r.memberRuns?.map((m) => m.agentName).join(", ") || "líder";
  console.log(`> ${msg}\n< [${quem}] ${r.content}`);
}
