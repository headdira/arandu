// Arandu — tipos do núcleo (porte modificado do Agno 3.2.0: models/message.py, run/base.py,
// run/agent.py, session/agent.py). Nomes em camelCase; valores de enum iguais aos do Agno.

export type Role = "system" | "developer" | "user" | "assistant" | "tool";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

// models/message.py:56-127 — só role/content/name/tool_call_id/tool_calls vão para a API.
export type Message = {
  role: Role;
  content: string | any[] | null;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  // não enviados
  id?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolCallError?: boolean;
  stopAfterToolCall?: boolean;
  fromHistory?: boolean;
  addToAgentMemory?: boolean;
  reasoningContent?: string;
  createdAt?: number;
};

// run/base.py:378-392
export const RunStatus = {
  pending: "PENDING",
  running: "RUNNING",
  completed: "COMPLETED",
  paused: "PAUSED",
  cancelled: "CANCELLED",
  error: "ERROR",
  regenerated: "REGENERATED",
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];
// run/base.py:445-450
export const HISTORY_SKIP_STATUSES: RunStatus[] = [RunStatus.paused, RunStatus.cancelled, RunStatus.error, RunStatus.regenerated];

// run/agent.py:145-198 (recorte usado)
export const RunEvent = {
  runStarted: "RunStarted",
  runContent: "RunContent",
  runContentCompleted: "RunContentCompleted",
  runCompleted: "RunCompleted",
  runError: "RunError",
  preHookStarted: "PreHookStarted",
  preHookCompleted: "PreHookCompleted",
  postHookStarted: "PostHookStarted",
  postHookCompleted: "PostHookCompleted",
  toolCallStarted: "ToolCallStarted",
  toolCallCompleted: "ToolCallCompleted",
  toolCallError: "ToolCallError",
  modelRequestStarted: "ModelRequestStarted",
  modelRequestCompleted: "ModelRequestCompleted",
} as const;
export type RunEvent = (typeof RunEvent)[keyof typeof RunEvent];

// models/response.py:27-69 (sem campos de HITL)
export type ToolExecution = {
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallError: boolean;
  result: string;
  stopAfterToolCall: boolean;
  durationMs: number;
  cached?: boolean;
  createdAt: number;
};

export type RunMetrics = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  modelRequests: number;
  timeToFirstTokenMs?: number;
};

export const metricasVazias = (): RunMetrics => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 0, modelRequests: 0 });

// run/agent.py:650-735 (recorte)
export type RunOutput = {
  runId: string;
  agentId: string;
  agentName?: string;
  sessionId: string;
  userId?: string;
  parentRunId?: string;
  teamId?: string;
  input: { inputContent: unknown };
  content: unknown;
  contentType: string;
  model?: string;
  modelProvider?: string;
  messages: Message[];
  metrics: RunMetrics;
  tools: ToolExecution[];
  metadata?: Record<string, unknown>;
  sessionState?: Record<string, unknown>;
  status: RunStatus;
  createdAt: number;
  events?: RunEventData[];
  memberRuns?: RunOutput[];
};

export type RunEventData = {
  event: RunEvent;
  createdAt: number;
  agentId: string;
  agentName?: string;
  runId: string;
  sessionId: string;
  parentRunId?: string;
  content?: unknown;
  tool?: ToolExecution;
  error?: string;
  model?: string;
  modelProvider?: string;
  metrics?: RunMetrics;
  sessionState?: Record<string, unknown>;
};

// run/base.py:18-48 — o que a tool recebe (injetado, nunca vem do modelo).
export type RunContext = {
  runId: string;
  sessionId: string;
  userId?: string;
  dependencies: Record<string, unknown>;
  metadata: Record<string, unknown>;
  sessionState: Record<string, any>;
  messages: Message[];
  outputSchema?: unknown;
};

// session/agent.py:15-45
export type AgentSession = {
  sessionId: string;
  agentId?: string;
  teamId?: string;
  userId?: string;
  sessionData: { sessionState?: Record<string, any>; sessionMetrics?: RunMetrics; sessionName?: string; [k: string]: unknown };
  metadata?: Record<string, unknown>;
  agentData?: Record<string, unknown>;
  runs: RunOutput[];
  createdAt: number;
  updatedAt: number;
};

// exceptions.py — guardrails (não são re-tentados).
export class InputCheckError extends Error {}
export class OutputCheckError extends Error {}
export class ModelProviderError extends Error {
  readonly statusCode?: number;
  constructor(msg: string, statusCode?: number) {
    super(msg);
    this.statusCode = statusCode;
  }
}
// exceptions.py:134-147
export const NAO_RETENTAR_STATUS = new Set([400, 401, 403, 404, 413, 422]);
export const PADROES_JANELA = ["context_length_exceeded", "context window", "maximum context length", "token limit", "max_tokens", "too many tokens", "payload too large"];

export const uuid = () => globalThis.crypto.randomUUID();
export const agoraS = () => Math.floor(Date.now() / 1000);
export const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
