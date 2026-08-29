import type { AgentRunner, RunUsage } from "./types.js";

export type AuthContext = {
  requestId: string;
  userId: string;
  roleNames: string[];
};

export type AuthorizationDecision = {
  allowed: boolean;
  reasonCode: string;
  auditLogId: string;
};

/**
 * The orchestration layer depends on this contract, not on auth tables or
 * bearer-token implementation details.
 */
export interface Authorizer {
  authorize(
    context: AuthContext,
    action: string,
    resourceType: string,
    resourceKey: string,
  ): Promise<AuthorizationDecision>;
}

export type OrchestrationJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type OrchestrationRunStatus = OrchestrationJobStatus;

export type OrchestrationMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool";

export type OrchestrationSenderKind =
  | "user"
  | "orchestrator"
  | "agent"
  | "system"
  | "tool";

export type OrchestrationMessageType =
  | "prompt"
  | "delegation"
  | "progress"
  | "result"
  | "error"
  | "tool_call"
  | "tool_result";

export type JsonObject = Record<string, unknown>;

export interface OrchestrationJob {
  id: string;
  requestId: string;
  userId: string | null;
  inputText: string;
  inputJson: JsonObject;
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
  inputJson: JsonObject;
  outputText: string | null;
  outputJson: JsonObject | null;
  errorText: string | null;
  codexThreadId: string | null;
  usage: RunUsage | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface OrchestrationMessage {
  id: string;
  jobId: string;
  runId: string | null;
  sequenceNo: number;
  role: OrchestrationMessageRole;
  senderKind: OrchestrationSenderKind;
  senderKey: string | null;
  recipientKind: OrchestrationSenderKind | null;
  recipientKey: string | null;
  messageType: OrchestrationMessageType;
  content: string;
  payload: JsonObject;
  createdAt: string;
}

export interface CreateRootJobInput {
  requestId: string;
  userId: string | null;
  inputText: string;
  inputJson?: JsonObject;
  agentId: string;
  prompt: string;
  runInputJson?: JsonObject;
  createdAt?: string;
}

export interface CreateChildRunInput {
  jobId: string;
  agentId: string;
  parentRunId: string;
  prompt: string;
  inputJson?: JsonObject;
  createdAt?: string;
}

export interface AppendMessageInput {
  jobId: string;
  runId?: string | null;
  role: OrchestrationMessageRole;
  senderKind: OrchestrationSenderKind;
  senderKey?: string | null;
  recipientKind?: OrchestrationSenderKind | null;
  recipientKey?: string | null;
  messageType: OrchestrationMessageType;
  content?: string;
  payload?: JsonObject;
  createdAt?: string;
}

export interface StartRunInput {
  runId: string;
  startedAt?: string;
}

export interface CompleteRunInput {
  runId: string;
  outputText: string;
  outputJson?: JsonObject | null;
  codexThreadId?: string | null;
  usage?: RunUsage | null;
  completedAt?: string;
}

export interface FailRunInput {
  runId: string;
  errorText: string;
  completedAt?: string;
}

export interface CompleteJobInput {
  jobId: string;
  outputText?: string | null;
  errorText?: string | null;
  status: Exclude<OrchestrationJobStatus, "queued" | "running">;
  completedAt?: string;
}

export interface OrchestrationRepository {
  createRootJob(input: CreateRootJobInput): Promise<{
    job: OrchestrationJob;
    run: OrchestrationRun;
    message: OrchestrationMessage;
  }>;
  createChildRun(input: CreateChildRunInput): Promise<{
    run: OrchestrationRun;
    message: OrchestrationMessage;
  }>;
  appendMessage(input: AppendMessageInput): Promise<OrchestrationMessage>;
  startRun(input: StartRunInput): Promise<OrchestrationRun>;
  completeRun(input: CompleteRunInput): Promise<OrchestrationRun>;
  failRun(input: FailRunInput): Promise<OrchestrationRun>;
  completeJob(input: CompleteJobInput): Promise<OrchestrationJob>;
  getJob(jobId: string): OrchestrationJob | null;
  getRun(runId: string): OrchestrationRun | null;
  listRuns(jobId: string): OrchestrationRun[];
  listMessages(jobId: string): OrchestrationMessage[];
}

export type OrchestrationRunner = AgentRunner;
