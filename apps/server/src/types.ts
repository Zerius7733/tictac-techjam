export type AgentStatus = "ready" | "busy" | "stopped" | "error" | "archived";
/** A run may pause while a delegated child or resource request is resolved. */
export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  /** Stable human-readable key used when one Agent delegates to another. */
  agentKey: string;
  /** The authenticated user who created this Agent; null for legacy/system Agents. */
  ownerUserId: string | null;
  /** Independent Agent identity; null for legacy/system Agents. */
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
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  /** Canonical Codex thread for this run; never inherit another run's thread. */
  codexThreadId: string | null;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface HumanIdentity {
  username: string;
  displayName: string | null;
  roleNames: string[];
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  /** Optional JSON Schema enforced by the Codex runtime for this turn. */
  outputSchemaPath?: string;
  /** Optional orchestration correlation IDs for runtime logs and safeguards. */
  requestId?: string;
  jobId?: string;
  runId?: string;
  humanIdentity?: HumanIdentity;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
