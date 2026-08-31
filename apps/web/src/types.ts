export type AgentStatus = "ready" | "busy" | "stopped" | "error" | "archived";
export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";
export type PolicyAction = "read" | "write";
export type ChatMode = "agent" | "protected-data";

export interface Agent {
  id: string;
  /** Stable human-readable key used when one Agent delegates to another. */
  agentKey: string;
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
  codexThreadId: string | null;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  startedAt: string | null;
  completedAt: string | null;
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
  projectId: string | null;
  inputText: string;
  status: OrchestrationJobStatus;
  outputText: string | null;
  errorText: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type ProjectRole = "owner" | "editor" | "viewer";

export interface Project {
  id: string;
  name: string;
  description: string;
  ownerUserId: string;
  workspacePath: string;
  orchestratorAgentId: string;
  orchestratorSystemPrompt: string;
  currentRole: ProjectRole;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectOrchestrator {
  id: string;
  agentKey: string;
  name: string;
  workspacePath: string;
  status: AgentStatus;
  systemPrompt: string;
}

export interface ProjectMember {
  projectId: string;
  userId: string;
  username: string;
  displayName: string | null;
  role: ProjectRole;
  invitedByUserId: string | null;
  createdAt: string;
}

export interface ProjectUserCandidate {
  id: string;
  username: string;
  displayName: string | null;
}

export interface ProjectInvitation {
  id: string;
  projectId: string;
  projectName: string;
  projectDescription: string;
  userId: string;
  username: string;
  displayName: string | null;
  role: Exclude<ProjectRole, "owner">;
  invitedByUserId: string;
  invitedByUsername: string;
  invitedByDisplayName: string | null;
  status: "pending" | "accepted" | "declined" | "revoked";
  createdAt: string;
  respondedAt: string | null;
}

export interface ProjectAgent {
  projectId: string;
  agentId: string;
  agentKey: string;
  name: string;
  description: string;
  ownerUserId: string | null;
  ownerUsername: string | null;
  status: AgentStatus;
  addedByUserId: string;
  createdAt: string;
}

export interface ProjectAgentCandidate {
  agentId: string;
  agentKey: string;
  name: string;
  description: string;
  ownerUserId: string | null;
  ownerUsername: string | null;
  principalId: string | null;
  workspacePath: string;
  status: AgentStatus;
}

export interface ProjectSummary extends Project {
  memberCount: number;
  agentCount: number;
}

export interface ProjectDetails extends Project {
  orchestrator: ProjectOrchestrator;
  members: ProjectMember[];
  agents: ProjectAgent[];
  availableAgents: ProjectAgentCandidate[];
  pendingInvitations: ProjectInvitation[];
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
  outputJson: Record<string, unknown> | null;
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

export interface MockResource {
  id: string;
  resourceType: string;
  resourceKey: string;
  label: string;
  description: string;
  ownerUserId: string | null;
  sensitivity: "private" | "shared";
  /** Resource listings intentionally omit protected values. */
  value?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentCapability {
  id: string;
  agentPrincipalId: string;
  resourceType: string;
  resourceKey: string;
  action: PolicyAction;
  grantedByUserId: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface AgentCredential {
  id: string;
  agentPrincipalId: string;
  agentId: string;
  issuedByUserId: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface AgentActionLog {
  id: string;
  auditLogId: string;
  agentPrincipalId: string;
  capabilityId: string | null;
  action: PolicyAction;
  resourceType: string;
  resourceKey: string;
  decision: "allow" | "deny";
  resultCode: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AgentPolicyResult {
  status: "allowed" | "denied";
  allowed: boolean;
  reasonCode: string;
  actionLogId?: string;
  resource?: {
    resourceType: string;
    resourceKey: string;
    value?: string;
    updated?: boolean;
  };
}
