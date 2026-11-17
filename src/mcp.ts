// Arandu — mcpTools: conecta num servidor MCP (Streamable HTTP) e expõe as tools dele ao agente.
// Contém código modificado de terceiros sob Apache-2.0; ver NOTICE.
import { Function, Toolkit } from "./ferramentas.ts";

export type Buscar = (url: string, init: RequestInit) => Promise<Response>;

export type MCPToolsOpts = {
  url: string;
  buscar?: Buscar; // padrão: fetch global
  cabecalhos?: () => Record<string, string>;
  name?: string;
  includeTools?: string[];
  excludeTools?: string[];
  instructions?: string;
  timeoutMs?: number;
};

export class ErroMcp extends Error {}

export async function mcpTools(o: MCPToolsOpts): Promise<Toolkit> {
  const buscar = o.buscar ?? ((u, i) => fetch(u, i));
  let seq = 0;
  async function rpc(method: string, params: object = {}): Promise<any> {
    const r = await buscar(o.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(o.cabecalhos?.() ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
    });
    const corpo: any = await r.json().catch(() => null);
    if (!r.ok || !corpo) throw new ErroMcp(`MCP ${method}: HTTP ${r.status}${corpo?.error?.message ? ` ${corpo.error.message}` : ""}`);
    if (corpo.error) throw new ErroMcp(`MCP ${method}: ${corpo.error.message}`);
    return corpo.result;
  }

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "arandu", version: "0.1.0" } });
  const { tools = [] } = await rpc("tools/list");
  const funcoes = (tools as any[])
    .filter((t) => (!o.includeTools || o.includeTools.includes(t.name)) && !(o.excludeTools ?? []).includes(t.name))
    .map(
      (t) =>
        new Function({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema ?? { type: "object", properties: {} },
          entrypoint: async (args) => {
            const r = await rpc("tools/call", { name: t.name, arguments: args ?? {} });
            const texto = (r?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
            const sc = r?.structuredContent;
            const saida = sc && typeof sc.mensagem === "string" ? sc.mensagem : texto;
            if (r?.isError) throw new ErroMcp(saida || "erro na ferramenta"); // vira tool_call_error para o modelo
            return saida;
          },
        }),
    );
  return new Toolkit({ name: o.name ?? init?.serverInfo?.name ?? "mcp", tools: funcoes, instructions: o.instructions ?? init?.instructions, addInstructions: !!(o.instructions ?? init?.instructions) });
}
