import type {
  Agent,
  AgentRun,
  Message,
  OrchestrationJob,
  OrchestrationMessage,
  OrchestrationRun,
  SystemInfo,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
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
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
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
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  createOrchestration: (body: { agentId: string; prompt: string }) =>
    request<{
      requestId: string;
      job: OrchestrationJob;
      run: OrchestrationRun;
      message: OrchestrationMessage;
    }>("/api/orchestrations", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  orchestration: (id: string) =>
    request<{ job: OrchestrationJob; runs: OrchestrationRun[] }>(
      "/api/orchestrations/" + id,
    ),
  orchestrationMessages: (id: string) =>
    request<{ messages: OrchestrationMessage[] }>(
      "/api/orchestrations/" + id + "/messages",
    ),
  cancelOrchestration: (id: string, reason?: string) =>
    request<{ job: OrchestrationJob }>(
      "/api/orchestrations/" + id + "/cancel",
      {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {}),
      },
    ),
};
