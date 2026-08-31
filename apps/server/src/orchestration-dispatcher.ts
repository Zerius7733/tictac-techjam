import type { AgentStore } from "./agent-store.js";
import type {
  AgentCommand,
  DelegateAgentCommand,
  ResourceRequestCommand,
} from "./orchestration-protocol.js";
import {
  AgentProtocolError,
  agentResumeEnvelopeSchema,
  parseAgentCommand,
} from "./orchestration-protocol.js";
import type {
  AgentStatus,
  AgentRunner,
  RunUsage,
  RunnerResult,
} from "./types.js";
import type {
  AuthContext,
  Authorizer,
  OrchestrationLogger,
  OrchestrationJob,
  OrchestrationRepository,
  OrchestrationRun,
} from "./orchestration-contracts.js";
import type { ResourceProvider } from "./orchestration-resource-provider.js";

export interface OrchestrationAgentDirectory {
  getAgentById(agentId: string): OrchestrationAgentDescriptor | null;
  getAgentByKey(agentKey: string): OrchestrationAgentDescriptor | null;
  /** Returns Agents visible to the current orchestration user, when supported. */
  listAgents?(context: AuthContext): OrchestrationAgentDescriptor[];
}

export interface OrchestrationProjectAccess {
  canUseAgent(projectId: string, userId: string, agentId: string): boolean;
  listAgents(projectId: string, userId: string): OrchestrationAgentDescriptor[];
  workspacePath(projectId: string): string;
}

export interface OrchestrationAgentDescriptor {
  id: string;
  agentKey: string;
  ownerUserId?: string | null;
  principalId?: string | null;
  /** Display label used to make the delegation roster understandable to the model. */
  name?: string;
  workspacePath: string;
  status: AgentStatus;
}

/** Allows the dispatcher to resolve server-owned Agent records from a store. */
export class AgentStoreDirectory implements OrchestrationAgentDirectory {
  constructor(private readonly store: AgentStore) {}

  getAgentById(agentId: string): OrchestrationAgentDescriptor | null {
    const directory = this.store as AgentStore & {
      getAgentById?: (id: string) => {
      id: string;
      agentKey: string;
      name: string;
      ownerUserId?: string | null;
      principalId?: string | null;
      workspacePath: string;
        status: AgentStatus;
      } | null;
    };
    const stored = directory.getAgentById?.(agentId);
    if (stored) return stored;
    const agent = this.store.snapshot().agents.find((item) => item.id === agentId);
    return agent ? toDescriptor(agent) : null;
  }

  getAgentByKey(agentKey: string): OrchestrationAgentDescriptor | null {
    const directory = this.store as AgentStore & {
      getAgentByKey?: (key: string) => {
      id: string;
      agentKey: string;
      name: string;
      ownerUserId?: string | null;
      principalId?: string | null;
      workspacePath: string;
        status: AgentStatus;
      } | null;
    };
    const stored = directory.getAgentByKey?.(agentKey);
    if (stored) return stored;
    const agent = this.store
      .snapshot()
      .agents.find(
        (item) =>
          (item.agentKey || `legacy-${item.id}`).toLocaleLowerCase() ===
            agentKey.toLocaleLowerCase() ||
          item.id === agentKey,
      );
    return agent ? toDescriptor(agent) : null;
  }

  listAgents(context: AuthContext): OrchestrationAgentDescriptor[] {
    const includeAll = context.roleNames.some(
      (role) => role.toLocaleLowerCase() === "admin",
    );
    return this.store
      .snapshot()
      .agents.filter(
        (agent) =>
          agent.status !== "archived" &&
          (includeAll || agent.ownerUserId === null || agent.ownerUserId === context.userId),
      )
      .map(toDescriptor);
  }
}

export interface DispatchRootInput {
  jobId: string;
  rootRunId: string;
  authContext: AuthContext;
}

export interface ResumeWaitingRunInput {
  runId: string;
  authContext: AuthContext;
  envelope: ReturnType<typeof agentResumeEnvelopeSchema.parse>;
}

export interface OrchestrationDispatcherOptions {
  maxDepth?: number;
  maxRuns?: number;
  /** Maximum wall-clock time for one Agent turn; null disables this limit. */
  runTimeoutMs?: number | null;
  /** Maximum wall-clock time for the whole job; null disables this limit. */
  jobTimeoutMs?: number | null;
  /** Optional allowlisted provider for protected resource requests. */
  resourceProvider?: ResourceProvider;
  /** Optional project boundary for cross-account Agent participation. */
  projectAccess?: OrchestrationProjectAccess;
  logger?: OrchestrationLogger;
}

type ExecutionOutcome = {
  ok: boolean;
  content: string;
  run: OrchestrationRun;
};

/**
 * Sequential orchestration state machine. It deliberately depends on the
 * Authorizer and AgentRunner interfaces, so the real auth/runtime adapters can
 * be added without changing delegation behavior.
 */
export class OrchestrationDispatcher {
  private readonly maxDepth: number;
  private readonly maxRuns: number;
  private readonly runTimeoutMs: number | null;
  private readonly jobTimeoutMs: number | null;
  private readonly resourceProvider: ResourceProvider | null;
  private readonly projectAccess: OrchestrationProjectAccess | null;
  private readonly logger: OrchestrationLogger;
  private readonly activeJobs = new Map<string, Map<string, string>>();

  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly agents: OrchestrationAgentDirectory,
    private readonly authorizer: Authorizer,
    private readonly runner: AgentRunner,
    options: OrchestrationDispatcherOptions = {},
  ) {
    this.maxDepth = options.maxDepth ?? 8;
    this.maxRuns = options.maxRuns ?? 32;
    this.runTimeoutMs = timeoutOption(options.runTimeoutMs, 600_000);
    this.jobTimeoutMs = timeoutOption(options.jobTimeoutMs, 1_800_000);
    this.resourceProvider = options.resourceProvider ?? null;
    this.projectAccess = options.projectAccess ?? null;
    this.logger = options.logger ?? noopLogger;
  }

  async dispatchRoot(input: DispatchRootInput): Promise<OrchestrationJob> {
    const job = this.repository.getJob(input.jobId);
    const root = this.repository.getRun(input.rootRunId);
    if (!job || !root || root.jobId !== job.id || root.parentRunId !== null) {
      throw new Error("Root run does not belong to the job");
    }
    const jobDeadlineAt =
      this.jobTimeoutMs === null ? null : Date.now() + this.jobTimeoutMs;
    this.logger.info(
      logFields(input.authContext, job.id, root.id, root.agentId),
      "orchestration_dispatch_started",
    );
    const rootAgent = this.agents.getAgentById(root.agentId);
    if (!rootAgent) {
      await this.failRoot(job.id, root, "agent_not_found");
      return this.requireJob(job.id);
    }
    if (
      job.projectId &&
      (!this.projectAccess ||
        !this.projectAccess.canUseAgent(job.projectId, input.authContext.userId, rootAgent.id))
    ) {
      await this.failRoot(job.id, root, "agent_not_in_project");
      return this.requireJob(job.id);
    }
    const decision = await this.authorizer.authorize(
      input.authContext,
      "invoke",
      "agent",
      rootAgent.agentKey,
    );
    if (!decision.allowed) {
      await this.failRoot(job.id, root, decision.reasonCode);
      return this.requireJob(job.id);
    }

    const outcome = await this.executeRun(
      root,
      input.authContext,
      0,
      new Set([root.agentId]),
      jobDeadlineAt,
    );
    const currentRoot = this.repository.getRun(root.id) ?? outcome.run;
    const currentJob = this.repository.getJob(job.id) ?? job;
    if (currentJob.status === "cancelled") {
      this.logger.info(
        logFields(input.authContext, job.id, root.id, root.agentId),
        "orchestration_dispatch_cancelled",
      );
      this.activeJobs.delete(job.id);
      return currentJob;
    }
    if (currentRoot.status === "completed") {
      await this.repository.completeJob({
        jobId: job.id,
        status: "completed",
        outputText: outcome.content,
      });
    } else if (currentRoot.status === "failed" || currentRoot.status === "cancelled") {
      await this.repository.completeJob({
        jobId: job.id,
        status: currentRoot.status,
        errorText: currentRoot.errorText ?? outcome.content,
      });
    } else {
      await this.repository.completeJob({
        jobId: job.id,
        status: "failed",
        errorText: "Root run did not reach a terminal state",
      });
    }
    this.logger.info(
      logFields(input.authContext, job.id, root.id, root.agentId, {
        status: currentRoot.status,
      }),
      "orchestration_dispatch_finished",
    );
    this.activeJobs.delete(job.id);
    return this.requireJob(job.id);
  }

  /** Resume one persisted waiting run after a worker reconstructs its context. */
  async resumeWaitingRun(input: ResumeWaitingRunInput): Promise<OrchestrationJob> {
    const run = this.repository.getRun(input.runId);
    if (!run || run.status !== "waiting") throw new Error("Run is not waiting");
    const agent = this.agents.getAgentById(run.agentId);
    if (!agent) {
      await this.failRun(run, "Agent is not registered");
      return this.requireJob(run.jobId);
    }
    const ancestry = new Set<string>();
    let cursor: OrchestrationRun | null = run;
    let depth = 0;
    while (cursor) {
      ancestry.add(cursor.agentId);
      if (!cursor.parentRunId) break;
      cursor = this.repository.getRun(cursor.parentRunId);
      depth += 1;
    }
    const job = this.repository.getJob(run.jobId);
    const startedAt = job?.startedAt ?? job?.createdAt;
    const jobDeadlineAt =
      this.jobTimeoutMs === null || !startedAt
        ? null
        : new Date(startedAt).getTime() + this.jobTimeoutMs;
    const outcome = await this.resumeWithEnvelope(
      run,
      input.envelope,
      input.authContext,
      depth,
      ancestry,
      agent,
      jobDeadlineAt,
    );
    const root = this.repository
      .listRuns(run.jobId)
      .find((candidate) => candidate.parentRunId === null);
    const currentJob = this.repository.getJob(run.jobId);
    if (root && currentJob && (currentJob.status === "queued" || currentJob.status === "running")) {
      if (root.status === "completed") {
        await this.repository.completeJob({
          jobId: run.jobId,
          status: "completed",
          outputText: outcome.content,
        });
      } else if (root.status === "failed" || root.status === "cancelled") {
        await this.repository.completeJob({
          jobId: run.jobId,
          status: root.status,
          errorText: root.errorText ?? outcome.content,
        });
      }
    }
    return this.requireJob(run.jobId);
  }

  /** Cancel a job and interrupt any Agent turns currently owned by this dispatcher. */
  async cancelJob(jobId: string, reason = "client_cancelled"): Promise<OrchestrationJob> {
    const activeAgents = new Set(this.activeJobs.get(jobId)?.values() ?? []);
    const safeReason = redactDiagnostic(reason);
    const job = await this.repository.cancelJob({ jobId, reason: safeReason });
    await Promise.all(
      [...activeAgents].map(async (agentId) => {
        try {
          await this.runner.cancel(agentId);
        } catch (error) {
          this.logger.warn(
            { jobId, agentId, error: errorMessage(error) },
            "orchestration_runner_cancel_failed",
          );
        }
      }),
    );
    this.logger.info(
      { jobId, reason: safeReason, status: job.status },
      "orchestration_job_cancelled",
    );
    return job;
  }

  /** Apply the conservative startup policy to any active persisted work. */
  async reconcileAfterRestart() {
    const result = await this.repository.reconcileAfterRestart();
    this.logger.warn(
      {
        cancelledJobs: result.cancelledJobIds.length,
        cancelledRuns: result.cancelledRunIds.length,
      },
      "orchestration_restart_reconciled",
    );
    return result;
  }

  private async executeRun(
    initialRun: OrchestrationRun,
    authContext: AuthContext,
    depth: number,
    ancestry: Set<string>,
    jobDeadlineAt: number | null,
  ): Promise<ExecutionOutcome> {
    let run = initialRun;
    const agent = this.agents.getAgentById(run.agentId);
    if (!agent) return this.failRun(run, "Agent is not registered");
    if (run.status === "queued") {
      try {
        run = await this.repository.startRun({ runId: run.id });
      } catch (error) {
        return this.failRun(run, errorMessage(error));
      }
    }
    if (run.status !== "running") return this.failRun(run, "Run is not executable");

    try {
      const result = await this.runAgentTurn(
        agent,
        run,
        run.prompt,
        run.codexThreadId,
        authContext,
        jobDeadlineAt,
      );
      return this.processResult(
        run,
        agent,
        result,
        authContext,
        depth,
        ancestry,
        jobDeadlineAt,
      );
    } catch (error) {
      return this.failRun(run, errorMessage(error));
    }
  }

  private async processResult(
    run: OrchestrationRun,
    agent: OrchestrationAgentDescriptor,
    result: RunnerResult,
    authContext: AuthContext,
    depth: number,
    ancestry: Set<string>,
    jobDeadlineAt: number | null,
  ): Promise<ExecutionOutcome> {
    let command: AgentCommand;
    try {
      command = parseAgentCommand(result.output);
    } catch (error) {
      const reason = error instanceof AgentProtocolError ? error.message : errorMessage(error);
      return this.failRun(run, reason);
    }

    if (command.type === "final") {
      try {
        const completed = await this.repository.completeRun({
          runId: run.id,
          outputText: command.content,
          outputJson: command,
          codexThreadId: result.threadId ?? run.codexThreadId,
          usage: addUsage(run.usage, result.usage),
        });
        return { ok: true, content: command.content, run: completed };
      } catch (error) {
        return this.failRun(run, errorMessage(error));
      }
    }

    const threadId = result.threadId ?? run.codexThreadId;
    const accumulatedUsage = addUsage(run.usage, result.usage);
    try {
      // Persist waiting before checking/dispatching any child work.
      run = await this.repository.waitRun({
        runId: run.id,
        codexThreadId: threadId,
        usage: accumulatedUsage,
      });
    } catch (error) {
      return this.failRun(run, errorMessage(error));
    }

    const targetKey = command.targetAgentKey;
    const target = this.agents.getAgentByKey(targetKey);
    if (command.type === "resource_request") {
      try {
        await this.repository.appendMessage({
          jobId: run.jobId,
          runId: run.id,
          role: "tool",
          senderKind: "orchestrator",
          senderKey: "orchestration-middleware",
          recipientKind: "agent",
          recipientKey: agent.agentKey,
          messageType: "tool_call",
          content: JSON.stringify(command),
          payload: command,
        });
      } catch (error) {
        return this.failRun(run, errorMessage(error));
      }
    }
    const denial = await this.delegationDenial(
      command,
      target,
      run,
      authContext,
      depth,
      ancestry,
      this.repository.getJob(run.jobId)?.projectId ?? null,
    );
    if (denial) {
      return this.resumeWithEnvelope(
        run,
        denial,
        authContext,
        depth,
        ancestry,
        agent,
        jobDeadlineAt,
      );
    }

    if (command.type === "resource_request" && this.resourceProvider) {
      try {
        const provided = await this.resourceProvider.provide({
          requestId: authContext.requestId,
          jobId: run.jobId,
          runId: run.id,
          agentId: target!.id,
          authContext,
          agent: target!,
          action: command.action,
          resourceType: command.resourceType,
          resourceKey: command.resourceKey,
          purpose: command.purpose,
        });
        const content = sanitizeResourceContent(provided.content);
        const envelope = agentResumeEnvelopeSchema.parse({
          type: "child_result",
          sourceAgentKey: targetKey,
          content,
        });
        return this.resumeWithEnvelope(
          run,
          envelope,
          authContext,
          depth,
          ancestry,
          agent,
          jobDeadlineAt,
        );
      } catch (error) {
        const unavailable = agentResumeEnvelopeSchema.parse({
          type: "authorization_denied",
          action: command.action,
          resourceType: command.resourceType,
          resourceKey: command.resourceKey,
          reasonCode: safeResourceReason(error),
        });
        return this.resumeWithEnvelope(
          run,
          unavailable,
          authContext,
          depth,
          ancestry,
          agent,
          jobDeadlineAt,
        );
      }
    }

    let child: Awaited<ReturnType<OrchestrationRepository["createChildRun"]>>;
    try {
      child = await this.repository.createChildRun({
        jobId: run.jobId,
        parentRunId: run.id,
        agentId: target!.id,
        prompt: childPrompt(command),
      });
    } catch {
      const unavailable = agentResumeEnvelopeSchema.parse({
        type: "authorization_denied",
        action: command.type === "delegate" ? "invoke" : command.action,
        resourceType: command.type === "delegate" ? "agent" : command.resourceType,
        resourceKey: command.type === "delegate" ? targetKey : command.resourceKey,
        reasonCode: "agent_unavailable",
      });
      return this.resumeWithEnvelope(
        run,
        unavailable,
        authContext,
        depth,
        ancestry,
        agent,
        jobDeadlineAt,
      );
    }
    const childOutcome = await this.executeRun(
      child.run,
      authContext,
      depth + 1,
      new Set([...ancestry, target!.id]),
      jobDeadlineAt,
    );
    const childAgent = this.agents.getAgentById(target!.id);
    const childKey = childAgent?.agentKey ?? targetKey;
    const envelope = agentResumeEnvelopeSchema.parse({
      type: "child_result",
      sourceAgentKey: childKey,
      content: childOutcome.ok ? childOutcome.content : "Child run failed safely.",
    });
    return this.resumeWithEnvelope(
      run,
      envelope,
      authContext,
      depth,
      ancestry,
      agent,
      jobDeadlineAt,
    );
  }

  private async delegationDenial(
    command: DelegateAgentCommand | ResourceRequestCommand,
    target: OrchestrationAgentDescriptor | null,
    run: OrchestrationRun,
    authContext: AuthContext,
    depth: number,
    ancestry: Set<string>,
    projectId: string | null,
  ) {
    let reasonCode: string | null = null;
    if (!target) reasonCode = "agent_not_found";
    else if (target.status !== "ready") reasonCode = "agent_unavailable";
    else if (target.id === run.agentId || ancestry.has(target.id)) {
      reasonCode = "delegation_cycle";
    } else if (depth >= this.maxDepth) {
      reasonCode = "delegation_depth_exceeded";
    } else if (this.repository.listRuns(run.jobId).length >= this.maxRuns) {
      reasonCode = "run_limit_exceeded";
    } else if (
      projectId &&
      (!this.projectAccess ||
        !this.projectAccess.canUseAgent(projectId, authContext.userId, target!.id))
    ) {
      reasonCode = "agent_not_in_project";
    }

    const decision =
      reasonCode === null
        ? await this.authorizer.authorize(
            authContext,
            command.type === "delegate" ? "invoke" : command.action,
            command.type === "delegate" ? "agent" : command.resourceType,
            command.type === "delegate" ? command.targetAgentKey : command.resourceKey,
          )
        : null;
    if (decision && !decision.allowed) {
      reasonCode = decision.reasonCode || "authorization_denied";
    }
    if (!reasonCode) return null;
    if (command.type === "delegate") {
      return agentResumeEnvelopeSchema.parse({
        type: "authorization_denied",
        action: "invoke",
        resourceType: "agent",
        resourceKey: command.targetAgentKey,
        reasonCode,
      });
    }
    return agentResumeEnvelopeSchema.parse({
      type: "authorization_denied",
      action: command.action,
      resourceType: command.resourceType,
      resourceKey: command.resourceKey,
      reasonCode,
    });
  }

  private async resumeWithEnvelope(
    parent: OrchestrationRun,
    envelope: ReturnType<typeof agentResumeEnvelopeSchema.parse>,
    authContext: AuthContext,
    depth: number,
    ancestry: Set<string>,
    agent: OrchestrationAgentDescriptor,
    jobDeadlineAt: number | null,
  ): Promise<ExecutionOutcome> {
    const content = JSON.stringify(envelope);
    try {
      await this.repository.appendMessage({
        jobId: parent.jobId,
        runId: parent.id,
        role: "tool",
        senderKind: "orchestrator",
        senderKey: "orchestration-middleware",
        recipientKind: "agent",
        recipientKey: agent.agentKey,
        messageType: "tool_result",
        content,
        payload: envelope,
      });
    } catch (error) {
      return this.failRun(parent, errorMessage(error));
    }
    let resumed: OrchestrationRun;
    try {
      resumed = await this.repository.resumeRun({ runId: parent.id });
    } catch (error) {
      return this.failRun(parent, errorMessage(error));
    }
    try {
      const result = await this.runAgentTurn(
        agent,
        resumed,
        content,
        resumed.codexThreadId,
        authContext,
        jobDeadlineAt,
      );
      return this.processResult(
        resumed,
        agent,
        result,
        authContext,
        depth,
        ancestry,
        jobDeadlineAt,
      );
    } catch (error) {
      return this.failRun(resumed, errorMessage(error));
    }
  }

  private async runAgentTurn(
    agent: OrchestrationAgentDescriptor,
    run: OrchestrationRun,
    prompt: string,
    threadId: string | null,
    authContext: AuthContext,
    jobDeadlineAt: number | null,
  ): Promise<RunnerResult> {
    this.registerActive(run.jobId, run.id, agent.id);
    this.logger.info(
      logFields(authContext, run.jobId, run.id, agent.id),
      "orchestration_agent_turn_started",
    );
    try {
      const result = await this.runWithTimeout(
        {
          agentId: agent.id,
          workspacePath: this.workspaceForRun(run),
          prompt: structuredPrompt(
            prompt,
            this.availableAgentsForRun(run, authContext, agent.id),
          ),
          threadId,
          requestId: authContext.requestId,
          jobId: run.jobId,
          runId: run.id,
        },
        agent,
        jobDeadlineAt,
      );
      this.logger.info(
        logFields(authContext, run.jobId, run.id, agent.id),
        "orchestration_agent_turn_finished",
      );
      return result;
    } catch (error) {
      this.logger.error(
        logFields(authContext, run.jobId, run.id, agent.id, {
          error: errorMessage(error),
        }),
        "orchestration_agent_turn_failed",
      );
      throw error;
    } finally {
      this.unregisterActive(run.jobId, run.id);
    }
  }

  private workspaceForRun(run: OrchestrationRun): string {
    const projectId = this.repository.getJob(run.jobId)?.projectId;
    return projectId && this.projectAccess
      ? this.projectAccess.workspacePath(projectId)
      : this.agents.getAgentById(run.agentId)?.workspacePath ?? "";
  }

  private availableAgentsForRun(
    run: OrchestrationRun,
    context: AuthContext,
    currentAgentId: string,
  ): OrchestrationAgentDescriptor[] {
    const projectId = this.repository.getJob(run.jobId)?.projectId;
    const available = projectId && this.projectAccess
      ? this.projectAccess.listAgents(projectId, context.userId)
      : this.agents.listAgents?.(context) ?? [];
    return available.filter((candidate) => candidate.id !== currentAgentId);
  }

  private async runWithTimeout(
    request: Parameters<AgentRunner["run"]>[0],
    agent: OrchestrationAgentDescriptor,
    jobDeadlineAt: number | null,
  ): Promise<RunnerResult> {
    const limits: Array<{
      duration: number;
      code: "run_timeout" | "job_timeout";
    }> = [];
    if (this.runTimeoutMs !== null) {
      limits.push({ duration: this.runTimeoutMs, code: "run_timeout" });
    }
    if (jobDeadlineAt !== null) {
      limits.push({ duration: jobDeadlineAt - Date.now(), code: "job_timeout" });
    }
    if (limits.length === 0) return this.runner.run(request);

    const limit = limits.reduce((shortest, current) =>
      current.duration < shortest.duration ? current : shortest,
    );
    if (limit.duration <= 0) throw new OrchestrationTimeoutError(limit.code);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        void this.runner.cancel(agent.id).catch(() => undefined);
        reject(new OrchestrationTimeoutError(limit.code));
      }, limit.duration);
    });
    try {
      return await Promise.race([this.runner.run(request), timeout]);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  private registerActive(jobId: string, runId: string, agentId: string): void {
    const active = this.activeJobs.get(jobId) ?? new Map<string, string>();
    active.set(runId, agentId);
    this.activeJobs.set(jobId, active);
  }

  private unregisterActive(jobId: string, runId: string): void {
    const active = this.activeJobs.get(jobId);
    if (!active) return;
    active.delete(runId);
    if (active.size === 0) this.activeJobs.delete(jobId);
  }

  private async failRun(run: OrchestrationRun, error: string): Promise<ExecutionOutcome> {
    const safeError = redactDiagnostic(error);
    this.logger.error(
      { jobId: run.jobId, runId: run.id, agentId: run.agentId, error: safeError },
      "orchestration_run_failed",
    );
    try {
      const failed = await this.repository.failRun({ runId: run.id, errorText: safeError });
      return { ok: false, content: safeError, run: failed };
    } catch {
      return { ok: false, content: safeError, run };
    }
  }

  private async failRoot(jobId: string, run: OrchestrationRun, reasonCode: string) {
    const errorText = "Authorization denied: " + reasonCode;
    try {
      await this.repository.failRun({ runId: run.id, errorText });
    } catch {
      // A concurrent terminal transition is already the safer outcome.
    }
    try {
      await this.repository.completeJob({ jobId, status: "failed", errorText });
    } catch {
      // Preserve the original denial result for an already-terminal job.
    }
  }

  private requireJob(jobId: string): OrchestrationJob {
    const job = this.repository.getJob(jobId);
    if (!job) throw new Error("Job not found");
    return job;
  }
}

class OrchestrationTimeoutError extends Error {
  constructor(readonly code: "run_timeout" | "job_timeout") {
    super(code);
    this.name = "OrchestrationTimeoutError";
  }
}

const noopLogger: OrchestrationLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function timeoutOption(value: number | null | undefined, fallback: number): number | null {
  if (value === null) return null;
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Timeout values must be positive or null");
  }
  return value;
}

function redactDiagnostic(value: string): string {
  return value
    .replace(
      /(api[_-]?key|token|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .slice(0, 500);
}

function sanitizeResourceContent(value: string): string {
  return value
    .replace(
      /(api[_-]?key|token|password|authorization|secret)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .slice(0, 50_000);
}

function structuredPrompt(
  prompt: string,
  availableAgents: OrchestrationAgentDescriptor[] = [],
): string {
  const roster = availableAgents.length
    ? [
        "Available Agents (use the exact delegation key in parentheses):",
        ...availableAgents.map((agent) =>
          `- ${agent.name ? agent.name + " " : ""}(${agent.agentKey}) — ${agent.status}`,
        ),
      ]
    : [
        "No other available Agents were provided. If you need to delegate, use an exact targetAgentKey from the request context.",
      ];
  return [
    "You are participating in a multi-Agent orchestration.",
    "Return exactly one JSON object and no markdown.",
    'For a final response use {"type":"final","summary":"Short plain-language summary of what you did.","content":"Full result, including any structured data."}.',
    'To delegate use {"type":"delegate","targetAgentKey":"...","task":"..."}.',
    'To request protected data use {"type":"resource_request","targetAgentKey":"...","action":"read","resourceType":"data_asset","resourceKey":"...","purpose":"..."}.',
    "Treat authorization denial messages as final policy; never retry a denied request with different wording.",
    "The summary is shown on the run card. Keep it human-readable, concise, and free of JSON or code; keep the complete result in content.",
    ...roster,
    "Task or orchestration result:",
    prompt,
  ].join("\n");
}

function safeResourceReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message === "resource_not_allowlisted" || message === "resource_not_available"
    ? message
    : "resource_provider_failed";
}

function logFields(
  context: AuthContext,
  jobId: string,
  runId: string,
  agentId: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requestId: context.requestId,
    userId: context.userId,
    jobId,
    runId,
    agentId,
    ...fields,
  };
}

function toDescriptor(agent: {
  id: string;
  agentKey?: string;
  name?: string;
  ownerUserId?: string | null;
  principalId?: string | null;
  workspacePath: string;
  status: AgentStatus;
}): OrchestrationAgentDescriptor {
  return {
    id: agent.id,
    agentKey: agent.agentKey || `legacy-${agent.id}`,
    ...(agent.name ? { name: agent.name } : {}),
    ...(agent.ownerUserId !== undefined ? { ownerUserId: agent.ownerUserId } : {}),
    ...(agent.principalId !== undefined ? { principalId: agent.principalId } : {}),
    workspacePath: agent.workspacePath,
    status: agent.status,
  };
}

function childPrompt(command: DelegateAgentCommand | ResourceRequestCommand): string {
  if (command.type === "delegate") return command.task;
  return [
    `Authorized ${command.action} request for ${command.resourceType}:${command.resourceKey}.`,
    `Purpose: ${command.purpose}`,
  ].join("\n");
}

function addUsage(left: RunUsage | null, right: RunUsage | null): RunUsage | null {
  if (!left && !right) return null;
  return {
    ...(left?.inputTokens !== undefined || right?.inputTokens !== undefined
      ? { inputTokens: (left?.inputTokens ?? 0) + (right?.inputTokens ?? 0) }
      : {}),
    ...(left?.cachedInputTokens !== undefined || right?.cachedInputTokens !== undefined
      ? {
          cachedInputTokens:
            (left?.cachedInputTokens ?? 0) + (right?.cachedInputTokens ?? 0),
        }
      : {}),
    ...(left?.outputTokens !== undefined || right?.outputTokens !== undefined
      ? { outputTokens: (left?.outputTokens ?? 0) + (right?.outputTokens ?? 0) }
      : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
