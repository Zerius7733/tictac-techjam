export type AgentStatus = "ready" | "busy" | "stopped" | "error" | "archived";
export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface Agent {
  id: string;
  ownerUserId: string | null;
  principalId: string | null;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}

export type OrchestrationJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type OrchestrationRunStatus = OrchestrationJobStatus | "waiting";

export interface OrchestrationJob {
  id: string;
  requestId: string;
  userId: string | null;
  inputText: string;
  status: OrchestrationJobStatus;
  outputText: string | null;
  errorText: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface OrchestrationRun {
  id: string;
  jobId: string;
  agentId: string;
  parentRunId: string | null;
  attempt: number;
  status: OrchestrationRunStatus;
  prompt: string;
  outputText: string | null;
  errorText: string | null;
  codexThreadId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface OrchestrationMessage {
  id: string;
  jobId: string;
  runId: string | null;
  sequenceNo: number;
  role: "user" | "assistant" | "system" | "tool";
  senderKind: "user" | "orchestrator" | "agent" | "system" | "tool";
  senderKey: string | null;
  recipientKind: "user" | "orchestrator" | "agent" | "system" | "tool" | null;
  recipientKey: string | null;
  messageType:
    | "prompt"
    | "delegation"
    | "progress"
    | "result"
    | "error"
    | "tool_call"
    | "tool_result";
  content: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
