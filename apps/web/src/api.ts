import type {
  Agent,
  AgentActionLog,
  AgentCapability,
  AgentCredential,
  AgentPolicyResult,
  AgentRun,
  ChatMode,
  Message,
  MockResource,
  PolicyAction,
  SystemInfo,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown = null,
  ) {
    super(message);
  }
}

let appAuthToken = "";
let sessionToken = "";

export function setAppAuthToken(token: string): void {
  appAuthToken = token.trim();
}

export function setSessionToken(token: string): void {
  sessionToken = token.trim();
}

export function clearSessionToken(): void {
  sessionToken = "";
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(appAuthToken ? { "X-App-Auth-Token": appAuthToken } : {}),
    ...(sessionToken ? { Authorization: "Bearer " + sessionToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    message?: string;
    details?: Array<{ message?: string }>;
  };
  if (!response.ok) {
    const detail = data.details?.map((item) => item.message).filter(Boolean).join("; ");
    throw new ApiError(
      data.error && data.error !== "Bad Request"
        ? data.error
        : detail || data.message || data.error || "Request failed",
      response.status,
      data,
    );
  }
  return data;
}

async function requestAsAgent<T>(
  url: string,
  agentToken: string,
  options?: RequestInit,
): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(appAuthToken ? { "X-App-Auth-Token": appAuthToken } : {}),
    "X-Agent-Principal-Token": agentToken,
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status, data);
  }
  return data;
}

export const api = {
  auth: () =>
    request<{
      required: boolean;
      sharedTokenRequired: boolean;
      loginRequired: boolean;
      authenticated: boolean;
      user: {
        id: string;
        username: string;
        displayName: string | null;
        roleNames: string[];
      } | null;
    }>("/api/auth"),
  authAccess: () => request<{ ok: boolean }>("/api/auth/access"),
  login: (body: { username: string; password: string }) =>
    request<{
      sessionToken: string;
      expiresAt: string;
      user: {
        id: string;
        username: string;
        displayName: string | null;
        roleNames: string[];
      };
    }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  logout: () =>
    request<{ ok: boolean }>("/api/auth/logout", {
      method: "POST",
    }),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string, agentToken = "", mode: ChatMode = "agent") =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content, mode }),
        ...(agentToken
          ? { headers: { "X-Agent-Principal-Token": agentToken } }
          : {}),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  listResources: () =>
    request<{ resources: MockResource[] }>("/api/security/mock-resources"),
  listCapabilities: (id: string) =>
    request<{ capabilities: AgentCapability[] }>(
      "/api/agents/" + id + "/capabilities",
    ),
  grantCapability: (
    id: string,
    body: {
      resourceType: string;
      resourceKey: string;
      action: PolicyAction;
      expiresInSeconds: number;
    },
  ) =>
    request<{ capability: AgentCapability }>(
      "/api/agents/" + id + "/capabilities",
      { method: "POST", body: JSON.stringify(body) },
    ),
  revokeCapability: (agentId: string, capabilityId: string) =>
    request<{ capability: AgentCapability }>(
      "/api/agents/" + agentId + "/capabilities/" + capabilityId + "/revoke",
      { method: "POST" },
    ),
  listCredentials: (id: string) =>
    request<{ credentials: AgentCredential[] }>(
      "/api/agents/" + id + "/credentials",
    ),
  issueCredential: (id: string, expiresInSeconds: number) =>
    request<{ credential: AgentCredential & { token: string } }>(
      "/api/agents/" + id + "/credentials",
      {
        method: "POST",
        body: JSON.stringify({ expiresInSeconds }),
      },
    ),
  revokeCredential: (agentId: string, credentialId: string) =>
    request<{ credential: AgentCredential }>(
      "/api/agents/" + agentId + "/credentials/" + credentialId + "/revoke",
      { method: "POST" },
    ),
  agentToolCall: (
    agentToken: string,
    body: {
      resourceType: string;
      resourceKey: string;
      action: PolicyAction;
      inputText?: string;
    },
  ) =>
    requestAsAgent<AgentPolicyResult>("/api/agent/tool-calls", agentToken, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listActionLogs: (id: string) =>
    request<{ actions: AgentActionLog[] }>(
      "/api/agents/" + id + "/action-logs",
    ),
};
