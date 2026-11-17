// Arandu — Team: orquestração de agentes nos modos route e coordinate (o líder delega com delegate_task_to_member).
// Contém código modificado de terceiros sob Apache-2.0; ver NOTICE.
import { Agent, type AgentOpts, mergeDictionaries, type RunOpts } from "./agente.ts";
import { tool } from "./ferramentas.ts";
import type { RunOutput } from "./tipos.ts";

export type TeamMode = "coordinate" | "route";

const idDoMembro = (a: Agent) => a.o.id ?? (a.name ?? a.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Bloco <team> da system message do líder: membros e regra de delegação por modo.
function blocoTime(membros: Agent[], mode: TeamMode): string {
  const lista = membros
    .map((m) => [`<member id="${idDoMembro(m)}" name="${m.name ?? idDoMembro(m)}">`, m.o.role ? `  Role: ${m.o.role}` : "", m.o.description ? `  Description: ${m.o.description}` : "", "</member>"].filter(Boolean).join("\n"))
    .join("\n");
  const regra =
    mode === "route"
      ? "Hand the request to exactly one member with `delegate_task_to_member`, choosing the member whose expertise best fits. The member's answer goes straight to the user. Write no text of your own in the turn you hand over."
      : "Delegate to members with `delegate_task_to_member` when their expertise or tools are needed, writing a clear, self-contained task for each. Then combine what they return into the final answer for the user.";
  return `<team>\nYou coordinate this team to fulfill the user's request. You have a team of specialists, listed below. Delegate to members when their expertise or tools are needed; answer directly — including with your own tools — when they are not.\n<team_members>\n${lista}\n</team_members>\n<delegation>\n${regra}\nUse the member id exactly as listed.\n</delegation>\n</team>`;
}

export class Team extends Agent {
  members: Agent[];
  mode: TeamMode;
  memberRuns: RunOutput[] = [];
  constructor(o: AgentOpts & { members: Agent[]; mode?: TeamMode }) {
    const mode = o.mode ?? "coordinate";
    const membros = o.members;
    const self: { t?: Team } = {};
    const delegar = tool({
      name: "delegate_task_to_member",
      description: "Use this function to delegate a task to the selected team member. You must provide a clear and concise description of the task the member should achieve AND the expected output.",
      parameters: {
        type: "object",
        properties: {
          member_id: { type: "string", description: "The ID of the member to delegate the task to. Use only the ID of the member, for example `market-analyst`." },
          task: { type: "string", description: "A clear and concise description of the task the member should achieve." },
        },
        required: ["member_id", "task"],
      },
      stopAfterToolCall: mode === "route", // route: resposta do membro vai direto (show_result + stop)
      entrypoint: async ({ member_id, task }, { runContext }) => {
        const m = membros.find((x) => idDoMembro(x) === member_id);
        if (!m)
          return `Member with ID ${member_id} not found in the team or any subteams. Please choose the correct member from the list of members:\n\n${membros.map((x) => `- ${idDoMembro(x)}: ${x.name ?? ""}`).join("\n")}`;
        const copia = { ...runContext.sessionState };
        const r = await m.run(String(task), {
          sessionId: runContext.sessionId,
          userId: runContext.userId,
          sessionState: copia,
          dependencies: runContext.dependencies,
          metadata: runContext.metadata,
          parentRunId: runContext.runId,
        });
        self.t?.memberRuns.push(r);
        mergeDictionaries(runContext.sessionState, r.sessionState ?? {});
        if (r.content === null || r.content === undefined) return r.tools.length ? r.tools.map((t) => t.result).join(", ") : "No response from the member agent.";
        return typeof r.content === "string" ? r.content.trim() : JSON.stringify(r.content, null, 2);
      },
    });
    const instr = o.instructions;
    super({
      ...o,
      tools: [delegar, ...(o.tools ?? [])],
      instructions: async (a) => {
        const base = typeof instr === "function" ? await instr(a) : instr;
        return [...(base === undefined ? [] : Array.isArray(base) ? base : [base]), blocoTime(membros, mode)];
      },
    });
    for (const m of membros) m.o.teamId = this.id; // membro não lê nem grava sessão própria
    this.members = membros;
    this.mode = mode;
    self.t = this;
  }

  override async run(input: Parameters<Agent["run"]>[0], opts: RunOpts = {}): Promise<RunOutput> {
    this.memberRuns = [];
    const r = await super.run(input, opts);
    r.memberRuns = this.memberRuns;
    return r;
  }
}
