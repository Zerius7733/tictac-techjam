import { randomUUID } from "node:crypto";
import type { AgentStore } from "./agent-store.js";
import type { AgentRuntimeIdentity, AuthStore } from "./auth-store.js";
import { AgentPolicyGateway } from "./agent-policy-gateway.js";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  HumanIdentity,
  Message,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { developmentAgentSeeds } from "./development-agents.js";
import {
  type ChatMode,
  type ProtectedResourceIntent,
  isProtectedCapabilityGrantRequest,
  parseProtectedResourceIntent,
} from "./protected-resource-intent.js";

const now = () => new Date().toISOString();

function assertUniqueAgentName(
  agents: Agent[],
  name: string,
  excludeAgentId?: string,
): void {
  const normalizedName = name.toLocaleLowerCase();
  const duplicate = agents.find(
    (agent) =>
      agent.id !== excludeAgentId &&
      agent.status !== "archived" &&
      agent.name.trim().toLocaleLowerCase() === normalizedName,
  );
  if (duplicate) {
    throw new HttpError(409, `Agent name "${name}" is already in use`);
  }
}

function createAgentKey(name: string, agents: Agent[]): string {
  const base = slugifyAgentName(name);
  const usedKeys = new Set(
    agents.map((agent) => (agent.agentKey || `legacy-${agent.id}`).toLocaleLowerCase()),
  );
  let key = base;
  let suffix = 2;
  while (usedKeys.has(key.toLocaleLowerCase())) {
    key = `${base}-${suffix}`;
    suffix += 1;
  }
  return key;
}

function slugifyAgentName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLocaleLowerCase()
    .slice(0, 72)
    .replace(/-+$/g, "");
  return slug || "agent";
}

type ProtectedChatOperation =
  | { kind: "resource"; intent: ProtectedResourceIntent };

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: AgentStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly authStore?: AuthStore,
    private readonly policyGateway?: AgentPolicyGateway,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.seedDevelopmentAgents();
    await this.ensureAgentPrincipals();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (
          run.status === "queued" ||
          run.status === "running" ||
          run.status === "waiting"
        ) {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(ownerUserId?: string, includeAll = false): Agent[] {
    const agents = this.store.snapshot().agents;
    return agents
      .filter(
        (agent) =>
          (includeAll || agent.status !== "archived") &&
          this.canAccess(agent, ownerUserId, includeAll),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string, ownerUserId?: string, includeAll = false): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent || !this.canAccess(agent, ownerUserId, includeAll)) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput, ownerUserId?: string): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const name = input.name.trim();
    const agent: Agent = {
      id,
      agentKey: "",
      ownerUserId: ownerUserId ?? null,
      principalId: null,
      name,
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const principal =
      ownerUserId && this.authStore
        ? this.authStore.createAgentPrincipal(id, ownerUserId)
        : null;
    agent.principalId = principal?.id ?? null;
    try {
      await this.store.mutate(async (database) => {
        assertUniqueAgentName(database.agents, name);
        agent.agentKey = createAgentKey(name, database.agents);
        await this.workspaces.create(agent);
        database.agents.push(agent);
      });
    } catch (error) {
      if (principal) this.authStore?.revokeAgentPrincipal(id);
      throw error;
    }
    return agent;
  }

  async updateAgent(
    id: string,
    input: UpdateAgentInput,
    ownerUserId?: string,
    includeAll = false,
  ): Promise<Agent> {
    const current = this.getAgent(id, ownerUserId, includeAll);
    if (current.status === "archived") {
      throw new HttpError(409, "Archived Agents cannot be edited");
    }
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (!this.canAccess(agent, ownerUserId, includeAll)) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (name.toLocaleLowerCase() !== agent.name.toLocaleLowerCase()) {
          assertUniqueAgentName(database.agents, name, id);
        }
        agent.name = name;
      }
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(
    id: string,
    ownerUserId?: string,
    includeAll = false,
  ): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id, ownerUserId, includeAll);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === id);
      if (!storedAgent || !this.canAccess(storedAgent, ownerUserId, includeAll)) {
        throw new HttpError(404, "Agent not found");
      }
      storedAgent.status = "archived";
      storedAgent.lastError = null;
      storedAgent.updatedAt = now();
    });
    this.authStore?.revokeAgentPrincipal(id);
    return { archivedWorkspace };
  }

  async startAgent(id: string, ownerUserId?: string, includeAll = false): Promise<Agent> {
    const agent = this.getAgent(id, ownerUserId, includeAll);
    if (agent.status === "archived") {
      throw new HttpError(409, "Archived Agents cannot be started");
    }
    return this.setStatus(id, "ready", ownerUserId, includeAll);
  }

  async stopAgent(id: string, ownerUserId?: string, includeAll = false): Promise<Agent> {
    this.getAgent(id, ownerUserId, includeAll);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped", ownerUserId, includeAll);
  }

  getMessages(agentId: string, ownerUserId?: string, includeAll = false): Message[] {
    this.getAgent(agentId, ownerUserId, includeAll);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string, ownerUserId?: string, includeAll = false): AgentRun {
    const database = this.store.snapshot();
    const run = database.runs.find((item) => item.id === runId);
    const agent = run ? database.agents.find((item) => item.id === run.agentId) : null;
    if (!run || !agent || !this.canAccess(agent, ownerUserId, includeAll)) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string, ownerUserId?: string, includeAll = false): AgentRun[] {
    this.getAgent(agentId, ownerUserId, includeAll);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    ownerUserId?: string,
    includeAll = false,
    agentIdentity?: AgentRuntimeIdentity,
    mode: ChatMode = "agent",
    humanIdentity?: HumanIdentity,
  ): Promise<{ run: AgentRun; message: Message }> {
    const agent = this.getAgent(agentId, ownerUserId, includeAll);
    const commandRequested = /^\s*\/data\b/i.test(prompt);
    const policyPrompt = commandRequested
      ? prompt.replace(/^\s*\/data\s*/i, "").trim()
      : prompt;
    const protectedMode = mode === "protected-data" || commandRequested;
    const protectedIntent = protectedMode ? parseProtectedResourceIntent(policyPrompt) : null;
    const protectedOperation: ProtectedChatOperation | null = protectedIntent
      ? { kind: "resource", intent: protectedIntent }
      : null;
    const protectedRequestError =
      protectedMode && !protectedOperation
        ? isProtectedCapabilityGrantRequest(policyPrompt)
          ? "Access can only be granted from Security & Policy. Open that panel, choose the resource and action, then click Grant access."
          : "I couldn’t understand that protected-data request. Try ‘read Alice’s private notes’, ‘write Alice’s private notes to ...’, ‘read Bob’s private notes’, or ‘read shared-status’."
        : null;
    if (!protectedOperation && !protectedRequestError && !isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      codexThreadId: null,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent || !this.canAccess(storedAgent, ownerUserId, includeAll)) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "archived") {
        throw new HttpError(409, "Archived Agents cannot receive messages");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(
      agentAtStart,
      run,
      agentIdentity,
      protectedOperation,
      protectedRequestError,
      humanIdentity,
    );
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    agentIdentity?: AgentRuntimeIdentity,
    protectedOperation: ProtectedChatOperation | null = null,
    protectedRequestError: string | null = null,
    humanIdentity?: HumanIdentity,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = protectedRequestError
        ? {
            output: protectedRequestError,
            threadId: run.codexThreadId,
            usage: null,
          }
        : protectedOperation
          ? this.runProtectedResourceRequest(
              agentAtStart,
              protectedOperation.intent,
              agentIdentity,
              run.codexThreadId,
            )
          : await this.runner.run({
              agentId: agentAtStart.id,
              workspacePath: agentAtStart.workspacePath,
              prompt: run.prompt,
              // A run owns its Codex context. The Agent-level field is only a
              // compatibility mirror for the legacy single-Agent UI.
              threadId: run.codexThreadId,
              runId: run.id,
              ...(humanIdentity ? { humanIdentity } : {}),
            });
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.codexThreadId = result.threadId;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        // Keep this for the legacy UI; orchestration never reads it to resume.
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    }
  }

  private runProtectedResourceRequest(
    agent: Agent,
    intent: ProtectedResourceIntent,
    identity?: AgentRuntimeIdentity,
    threadId: string | null = null,
  ) {
    if (!identity) {
      return {
        output:
          "I couldn’t access that protected record because this conversation did not provide the Agent’s credential. Issue an Agent credential, then try again.",
        threadId,
        usage: null,
      };
    }
    if (!this.policyGateway) {
      throw new HttpError(503, "Agent policy is not configured");
    }

    const decision = this.policyGateway.executeAsAgent(identity, agent, intent);
    if (decision.status === "allowed") {
      const isRead = intent.action === "read";
      return {
        output: [
          isRead
            ? `I accessed ${decision.resource.resourceKey} through the protected resource gateway.`
            : `I updated ${decision.resource.resourceKey} through the protected resource gateway.`,
          ...(isRead ? ["", decision.resource.value ?? "", ""] : [""]),
          `Policy decision: ${decision.reasonCode}`,
        ].join("\n"),
        threadId,
        usage: null,
      };
    }

    const verb = intent.action === "read" ? "access" : "update";
    const requirement =
      decision.reasonCode === "write_input_required"
        ? "Include the new note text in the write request."
        : "The Agent needs an active capability for this exact resource and action.";
    return {
      output: [
        `I couldn’t ${verb} ${intent.resourceKey}. The backend policy gateway denied the Agent request.`,
        "",
        `Policy decision: ${decision.reasonCode}`,
        requirement,
      ].join("\n"),
      threadId,
      usage: null,
    };
  }

  private async setStatus(
    id: string,
    status: Agent["status"],
    ownerUserId?: string,
    includeAll = false,
  ): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent || !this.canAccess(agent, ownerUserId, includeAll)) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      if (agent.status === "archived") {
        throw new HttpError(409, "Archived Agents cannot be reactivated");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private canAccess(
    agent: Agent,
    ownerUserId: string | undefined,
    includeAll: boolean,
  ): boolean {
    if (ownerUserId === undefined || includeAll) return true;
    if (agent.ownerUserId !== ownerUserId) return false;
    if (!this.authStore || !agent.principalId) return true;
    const principal = this.authStore.getAgentPrincipal(agent.id);
    return (
      principal?.status === "active" &&
      principal.ownerUserId === agent.ownerUserId
    );
  }

  private async ensureAgentPrincipals(): Promise<void> {
    if (!this.authStore) return;
    for (const agent of this.store.snapshot().agents) {
      if (!agent.ownerUserId) continue;
      const principal =
        this.authStore.getAgentPrincipal(agent.id) ??
        this.authStore.createAgentPrincipal(agent.id, agent.ownerUserId);
      if (principal.ownerUserId !== agent.ownerUserId) {
        throw new Error("Agent principal owner does not match the Agent owner");
      }
      if (agent.principalId === principal.id) continue;
      await this.store.mutate((database) => {
        const storedAgent = database.agents.find((item) => item.id === agent.id);
        if (storedAgent) storedAgent.principalId = principal.id;
      });
    }
  }

  private async seedDevelopmentAgents(): Promise<void> {
    if (!this.config.seedDevelopmentData || !this.authStore) return;

    for (const seed of developmentAgentSeeds) {
      const existing = this.store.snapshot().agents;
      if (
        existing.some(
          (agent) =>
            agent.id === seed.id ||
            (agent.status !== "archived" &&
              (agent.agentKey.toLocaleLowerCase() ===
                seed.agentKey.toLocaleLowerCase() ||
                agent.name.toLocaleLowerCase() === seed.name.toLocaleLowerCase())),
        )
      ) {
        continue;
      }
      if (!this.authStore.hasActiveUser(seed.ownerUserId)) continue;

      const timestamp = now();
      const principal = this.authStore.createAgentPrincipal(
        seed.id,
        seed.ownerUserId,
      );
      const agent: Agent = {
        id: seed.id,
        agentKey: seed.agentKey,
        ownerUserId: seed.ownerUserId,
        principalId: principal.id,
        name: seed.name,
        description: seed.description,
        instructions: seed.instructions,
        status: "ready",
        workspacePath: this.workspaces.workspacePath(seed.id),
        codexThreadId: null,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      let inserted = false;
      try {
        await this.store.mutate(async (database) => {
          if (
            database.agents.some(
              (item) =>
                item.id === seed.id ||
                (item.status !== "archived" &&
                  (item.agentKey.toLocaleLowerCase() ===
                    seed.agentKey.toLocaleLowerCase() ||
                    item.name.toLocaleLowerCase() === seed.name.toLocaleLowerCase())),
            )
          ) {
            return;
          }
          await this.workspaces.ensure(agent);
          database.agents.push(agent);
          inserted = true;
        });
      } catch (error) {
        this.authStore.revokeAgentPrincipal(seed.id);
        throw error;
      }
      if (!inserted) this.authStore.revokeAgentPrincipal(seed.id);
    }
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
