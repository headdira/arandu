// Exemplo mínimo: agente com uma tool, sessão em memória, qualquer endpoint compatível com OpenAI.
//   OPENAI_BASE_URL=https://api.openai.com/v1 OPENAI_API_KEY=... MODELO=gpt-4o-mini npm run exemplo
import { Agent, InMemoryDb, OpenAILike, tool } from "../src/index.ts";

const horarios = tool({
  name: "ver_horarios_livres",
  description: "Lista horários livres de um dia (AAAA-MM-DD).",
  parameters: { type: "object", properties: { data: { type: "string" } }, required: ["data"] },
  entrypoint: async ({ data }, { runContext }) => JSON.stringify({ data, livres: ["10:00", "14:30", "17:00"], cliente: runContext.userId }),
});

const agente = new Agent({
  name: "Atendente",
  model: new OpenAILike({
    id: process.env.MODELO ?? "gpt-4o-mini",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY ?? "",
  }),
  instructions: ["Você atende uma barbearia pelo WhatsApp.", "Seja breve e use as tools para ver horários."],
  tools: [horarios],
  db: new InMemoryDb(),
  addHistoryToContext: true,
  addDatetimeToContext: true,
  timezoneIdentifier: "America/Sao_Paulo",
  retries: 1,
  exponentialBackoff: true,
});

for (const msg of ["oi, tem horário amanhã?", "pode ser 14:30"]) {
  const r = await agente.run(msg, { sessionId: "demo", userId: "5531999990000" });
  console.log(`> ${msg}\n< ${r.content}  [${r.status}; tools: ${r.tools.map((t) => t.toolName).join(", ") || "-"}]`);
}
