// Agente com uma tool e sessão em memória, em qualquer endpoint compatível com OpenAI Chat Completions.
//   OPENAI_BASE_URL=https://api.openai.com/v1 OPENAI_API_KEY=... MODELO=gpt-4o-mini npm run exemplo
import { Agent, InMemoryDb, OpenAILike, tool } from "../src/index.ts";

const modelo = new OpenAILike({
  id: process.env.MODELO ?? "gpt-4o-mini",
  baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY ?? "",
});

const statusDoPedido = tool({
  name: "status_do_pedido",
  description: "Consulta o status de um pedido pelo número.",
  parameters: { type: "object", properties: { numero: { type: "string" } }, required: ["numero"] },
  entrypoint: async ({ numero }) => JSON.stringify({ numero, status: "em transporte", previsao: "amanhã" }),
});

const agente = new Agent({
  name: "Suporte",
  model: modelo,
  instructions: ["Você é o suporte de uma loja online.", "Seja breve e use as tools para consultar pedidos."],
  tools: [statusDoPedido],
  db: new InMemoryDb(),
  addHistoryToContext: true,
  addDatetimeToContext: true,
  timezoneIdentifier: "America/Sao_Paulo",
  retries: 1,
  exponentialBackoff: true,
});

for (const msg of ["oi, cadê meu pedido 4521?", "e chega que horas mais ou menos?"]) {
  const r = await agente.run(msg, { sessionId: "demo", userId: "cliente-1" });
  console.log(`> ${msg}\n< ${r.content}  [${r.status}; tools: ${r.tools.map((t) => t.toolName).join(", ") || "-"}]`);
}
