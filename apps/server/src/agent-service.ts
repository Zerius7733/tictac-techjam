import { randomUUID } from "node:crypto";
import type { AuthStore } from "./auth-store.js";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly authStore?: AuthStore,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.ensureAgentPrincipals();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
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
        (agent) => this.canAccess(agent, ownerUserId, includeAll),
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
    const agent: Agent = {
      id,
      ownerUserId: ownerUserId ?? null,
      principalId: null,
      name: input.name.trim(),
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
      await this.workspaces.create(agent);
      await this.store.mutate((database) => database.agents.push(agent));
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
      if (input.name !== undefined) agent.name = input.name.trim();
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
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    this.authStore?.revokeAgentPrincipal(id);
    return { archivedWorkspace };
  }

  async startAgent(id: string, ownerUserId?: string, includeAll = false): Promise<Agent> {
    this.getAgent(id, ownerUserId, includeAll);
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
  ): Promise<{ run: AgentRun; message: Message }> {
    this.getAgent(agentId, ownerUserId, includeAll);
    if (!isArkConfigured(this.config)) {
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
    const execution = this.executeRun(agentAtStart, run);
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

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
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
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
      });
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
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
