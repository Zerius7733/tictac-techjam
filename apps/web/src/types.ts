export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type PolicyAction = "read" | "write";
export type ChatMode = "agent" | "protected-data";

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

export interface MockResource {
  id: string;
  resourceType: string;
  resourceKey: string;
  ownerUserId: string | null;
  sensitivity: "private" | "shared";
  value: string;
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

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "consumed";

export interface AgentApproval {
  id: string;
  agentPrincipalId: string;
  requestedByUserId: string;
  action: PolicyAction;
  resourceType: string;
  resourceKey: string;
  inputText: string;
  status: ApprovalStatus;
  expiresAt: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
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
  approvalId: string | null;
  action: PolicyAction;
  resourceType: string;
  resourceKey: string;
  decision: "allow" | "deny";
  resultCode: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AgentPolicyResult {
  status: "allowed" | "denied" | "approval_required";
  allowed: boolean;
  reasonCode: string;
  actionLogId?: string;
  resource?: {
    resourceType: string;
    resourceKey: string;
    value?: string;
    updated?: boolean;
  };
  approval?: AgentApproval;
}
