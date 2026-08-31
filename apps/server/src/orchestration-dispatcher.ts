import type { AgentStore } from "./agent-store.js";
import type {
  AgentCommand,
  DelegateAgentCommand,
  ParallelDelegateAgentCommand,
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
  RunnerProgress,
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
  getOrchestrator?(
    projectId: string,
    userId: string,
    includeAll?: boolean,
  ): ProjectOrchestratorDescriptor;
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

export interface ProjectOrchestratorDescriptor extends OrchestrationAgentDescriptor {
  name: string;
  systemPrompt: string;
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
  /** Number of bounded repair turns for recoverable Agent failures. */
  maxRecoveryAttempts?: number;
  /** Maximum wall-clock time for one Agent turn; null disables this limit. */
  runTimeoutMs?: number | null;
  /** Maximum wall-clock time for the whole job; null disables this limit. */
  jobTimeoutMs?: number | null;
  /** Optional allowlisted provider for protected resource requests. */
  resourceProvider?: ResourceProvider;
  /** Optional project boundary for cross-account Agent participation. */
  projectAccess?: OrchestrationProjectAccess;
  /** Host path to the schema enforced for collaborative project turns. */
  collaborativeOutputSchemaPath?: string | null;
  logger?: OrchestrationLogger;
}

type ExecutionOutcome = {
  ok: boolean;
  content: string;
  run: OrchestrationRun;
};

/**
 * Orchestration state machine. Delegation is sequential by default; the
 * orchestrator can explicitly request a bounded batch for independent work.
 * It deliberately depends on the Authorizer and AgentRunner interfaces, so
 * the real auth/runtime adapters can be added without changing delegation
 * behavior.
 */
export class OrchestrationDispatcher {
  private readonly maxDepth: number;
  private readonly maxRuns: number;
  private readonly maxRecoveryAttempts: number;
  private readonly runTimeoutMs: number | null;
  private readonly jobTimeoutMs: number | null;
  private readonly resourceProvider: ResourceProvider | null;
  private readonly projectAccess: OrchestrationProjectAccess | null;
  private readonly collaborativeOutputSchemaPath: string | null;
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
    this.maxRecoveryAttempts = recoveryAttemptsOption(options.maxRecoveryAttempts);
    this.runTimeoutMs = timeoutOption(options.runTimeoutMs, 600_000);
    this.jobTimeoutMs = timeoutOption(options.jobTimeoutMs, 1_800_000);
    this.resourceProvider = options.resourceProvider ?? null;
    this.projectAccess = options.projectAccess ?? null;
    this.collaborativeOutputSchemaPath =
      options.collaborativeOutputSchemaPath ?? null;
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
    if (job.projectId) {
      let projectOrchestrator: ProjectOrchestratorDescriptor | null = null;
      try {
        projectOrchestrator =
          this.projectAccess?.getOrchestrator?.(
            job.projectId,
            input.authContext.userId,
            isAdminContext(input.authContext),
          ) ?? null;
      } catch {
        projectOrchestrator = null;
      }
      const legacyProjectRootAllowed =
        !this.projectAccess?.getOrchestrator &&
        Boolean(
          this.projectAccess?.canUseAgent(
            job.projectId,
            input.authContext.userId,
            rootAgent.id,
          ),
        );
      if (
        (!projectOrchestrator || projectOrchestrator.id !== rootAgent.id) &&
        !legacyProjectRootAllowed
      ) {
        await this.failRoot(job.id, root, "project_orchestrator_not_available");
        return this.requireJob(job.id);
      }
    } else {
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
      return this.recoverOrFail(
        run,
        agent,
        error,
        authContext,
        depth,
        ancestry,
        jobDeadlineAt,
      );
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
      return this.recoverOrFail(
        run,
        agent,
        error,
        authContext,
        depth,
        ancestry,
        jobDeadlineAt,
      );
    }

    const projectTurn = this.projectTurnContext(run, authContext);
    if (projectTurn?.role === "worker" && command.type !== "final") {
      return this.recoverOrFail(
        run,
        agent,
        new AgentProtocolError(
          "Project participant responses must use the final collaboration template; the project orchestrator owns delegation and resource requests",
        ),
        authContext,
        depth,
        ancestry,
        jobDeadlineAt,
      );
    }

    if (command.type === "final") {
      try {
        const outputText = finalContentText(command.content);
        const completed = await this.repository.completeRun({
          runId: run.id,
          outputText,
          outputJson: command,
          codexThreadId: result.threadId ?? run.codexThreadId,
          usage: addUsage(run.usage, result.usage),
        });
        return { ok: true, content: outputText, run: completed };
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

    if (command.type === "delegate_parallel") {
      return this.processParallelDelegation(
        command,
        run,
        agent,
        authContext,
        depth,
        ancestry,
        jobDeadlineAt,
      );
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
          ...(command.query === undefined ? {} : { query: command.query }),
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

  private async processParallelDelegation(
    command: ParallelDelegateAgentCommand,
    run: OrchestrationRun,
    agent: OrchestrationAgentDescriptor,
    authContext: AuthContext,
    depth: number,
    ancestry: Set<string>,
    jobDeadlineAt: number | null,
  ): Promise<ExecutionOutcome> {
    const projectId = this.repository.getJob(run.jobId)?.projectId ?? null;
    const targetKeys = command.delegations.map((delegation) => delegation.targetAgentKey);
    const uniqueTargetKeys = new Set(targetKeys.map((key) => key.toLocaleLowerCase()));
    if (uniqueTargetKeys.size !== targetKeys.length) {
      return this.resumeWithEnvelope(
        run,
        deniedDelegationEnvelope(targetKeys[0] ?? "parallel-results", "duplicate_parallel_target"),
        authContext,
        depth,
        ancestry,
        agent,
        jobDeadlineAt,
      );
    }

    if (this.repository.listRuns(run.jobId).length + command.delegations.length > this.maxRuns) {
      return this.resumeWithEnvelope(
        run,
        deniedDelegationEnvelope(targetKeys[0] ?? "parallel-results", "run_limit_exceeded"),
        authContext,
        depth,
        ancestry,
        agent,
        jobDeadlineAt,
      );
    }

    const targets: OrchestrationAgentDescriptor[] = [];
    for (const delegation of command.delegations) {
      const target = this.agents.getAgentByKey(delegation.targetAgentKey);
      const singleDelegation: DelegateAgentCommand = {
        type: "delegate",
        targetAgentKey: delegation.targetAgentKey,
        task: delegation.task,
      };
      const denial = await this.delegationDenial(
        singleDelegation,
        target,
        run,
        authContext,
        depth,
        ancestry,
        projectId,
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
      targets.push(target!);
    }

    const children: Array<Awaited<ReturnType<OrchestrationRepository["createChildRun"]>>> = [];
    try {
      for (const [index, delegation] of command.delegations.entries()) {
        children.push(
          await this.repository.createChildRun({
            jobId: run.jobId,
            parentRunId: run.id,
            agentId: targets[index]!.id,
            prompt: delegation.task,
          }),
        );
      }
    } catch {
      return this.resumeWithEnvelope(
        run,
        deniedDelegationEnvelope(targetKeys[0] ?? "parallel-results", "agent_unavailable"),
        authContext,
        depth,
        ancestry,
        agent,
        jobDeadlineAt,
      );
    }

    const childOutcomes = await Promise.all(
      children.map((child, index) =>
        this.executeRun(
          child.run,
          authContext,
          depth + 1,
          new Set([...ancestry, targets[index]!.id]),
          jobDeadlineAt,
        ),
      ),
    );
    const combined = childOutcomes
      .map((outcome, index) => {
        const target = targets[index]!;
        const content = outcome.ok ? outcome.content : "Child run failed safely.";
        const label = target.name ? `${target.name} (${target.agentKey})` : target.agentKey;
        return `${label}:\n${content}`;
      })
      .join("\n\n")
      .slice(0, 50_000);
    const envelope = agentResumeEnvelopeSchema.parse({
      type: "child_result",
      sourceAgentKey: "parallel-results",
      content: combined || "Parallel delegated work returned no content.",
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
    // Resource providers do not create or run a target Agent child. A target
    // may therefore be busy with its own turn while its capability is used
    // for a protected read. Availability is only a prerequisite for actual
    // Agent delegation.
    else if (command.type === "delegate" && target.status !== "ready") {
      reasonCode = "agent_unavailable";
    }
    else if (
      command.type === "delegate" &&
      (target.id === run.agentId || ancestry.has(target.id))
    ) {
      reasonCode = "delegation_cycle";
    } else if (command.type === "delegate" && depth >= this.maxDepth) {
      reasonCode = "delegation_depth_exceeded";
    } else if (
      command.type === "delegate" &&
      this.repository.listRuns(run.jobId).length >= this.maxRuns
    ) {
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
      return this.recoverOrFail(
        resumed,
        agent,
        error,
        authContext,
        depth,
        ancestry,
        jobDeadlineAt,
      );
    }
  }

  private async recoverOrFail(
    run: OrchestrationRun,
    agent: OrchestrationAgentDescriptor,
    error: unknown,
    authContext: AuthContext,
    depth: number,
    ancestry: Set<string>,
    jobDeadlineAt: number | null,
  ): Promise<ExecutionOutcome> {
    const reason = redactDiagnostic(errorMessage(error));
    const job = this.repository.getJob(run.jobId);
    const canRetry =
      this.isRecoverableFailure(error) &&
      run.attempt <= this.maxRecoveryAttempts &&
      job?.status !== "cancelled";

    if (!canRetry) return this.failRun(run, reason);

    const nextAttempt = run.attempt + 1;
    const repairPrompt = recoveryPrompt(
      run.prompt,
      reason,
      this.projectTurnContext(run, authContext)?.role === "worker",
    );
    let retried: OrchestrationRun;
    try {
      retried = await this.repository.retryRun({
        runId: run.id,
        prompt: repairPrompt,
      });
      await this.repository.appendMessage({
        jobId: run.jobId,
        runId: run.id,
        role: "system",
        senderKind: "system",
        messageType: "progress",
        content: `Recovery attempt ${nextAttempt} of ${this.maxRecoveryAttempts + 1}: ${recoverySummary(reason)}`,
        payload: {
          event: "run_recovery_attempt",
          attempt: nextAttempt,
          maxAttempts: this.maxRecoveryAttempts + 1,
          errorCode: error instanceof AgentProtocolError ? error.code : "agent_runtime_error",
          error: reason,
        },
      });
    } catch {
      return this.failRun(run, reason);
    }

    try {
      const result = await this.runAgentTurn(
        agent,
        retried,
        retried.prompt,
        retried.codexThreadId,
        authContext,
        jobDeadlineAt,
      );
      return this.processResult(
        retried,
        agent,
        result,
        authContext,
        depth,
        ancestry,
        jobDeadlineAt,
      );
    } catch (retryError) {
      return this.recoverOrFail(
        retried,
        agent,
        retryError,
        authContext,
        depth,
        ancestry,
        jobDeadlineAt,
      );
    }
  }

  private isRecoverableFailure(error: unknown): boolean {
    if (error instanceof AgentProtocolError) return true;
    if (error instanceof OrchestrationTimeoutError) return false;
    const message = errorMessage(error);
    return /(?:temporar(?:y|ily)|transient|runtime unavailable|service unavailable|connection reset|econnreset|econnrefused|epipe|socket)/i.test(
      message,
    );
  }

  private async runAgentTurn(
    agent: OrchestrationAgentDescriptor,
    run: OrchestrationRun,
    prompt: string,
    threadId: string | null,
    authContext: AuthContext,
    jobDeadlineAt: number | null,
  ): Promise<RunnerResult> {
    const projectTurn = this.projectTurnContext(run, authContext);
    const isCollaborative = Boolean(projectTurn);
    this.registerActive(run.jobId, run.id, agent.id);
    let lastPersistedProgressAt = 0;
    const reportProgress = (progress: RunnerProgress): void => {
      const detail = safeRuntimeProgressDetail(progress);
      this.logger.info(
        logFields(authContext, run.jobId, run.id, agent.id, {
          stage: progress.stage,
          detail,
        }),
        "orchestration_agent_runtime_progress",
      );

      const nowMs = Date.now();
      const isImportantEvent =
        progress.stage !== "codex_event" ||
        detail === "thread.started" ||
        detail === "turn.started" ||
        detail === "turn.completed" ||
        detail === "error";
      if (
        !isImportantEvent &&
        nowMs - lastPersistedProgressAt < 5_000
      ) {
        return;
      }
      lastPersistedProgressAt = nowMs;

      const content = runtimeProgressMessage(progress, run.startedAt);
      void this.repository
        .appendMessage({
          jobId: run.jobId,
          runId: run.id,
          role: "system",
          senderKind: "system",
          messageType: "progress",
          content,
          payload: {
            event: "runtime_progress",
            stage: progress.stage,
            detail,
          },
        })
        .catch((error) => {
          this.logger.warn(
            logFields(authContext, run.jobId, run.id, agent.id, {
              error: errorMessage(error),
            }),
            "orchestration_runtime_progress_persist_failed",
          );
        });
    };
    const heartbeat = setInterval(() => {
      reportProgress({ stage: "heartbeat" });
    }, 15_000);
    heartbeat.unref();
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
            projectTurn?.role === "worker"
              ? []
              : this.availableAgentsForRun(run, authContext, agent.id),
            {
              collaborative: isCollaborative,
              projectRole: projectTurn?.role ?? null,
              systemPrompt: projectTurn?.systemPrompt ?? null,
            },
          ),
          threadId,
          ...(isCollaborative && this.collaborativeOutputSchemaPath
            ? { outputSchemaPath: this.collaborativeOutputSchemaPath }
            : {}),
          requestId: authContext.requestId,
          jobId: run.jobId,
          runId: run.id,
          onProgress: reportProgress,
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
      clearInterval(heartbeat);
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

  private projectTurnContext(
    run: OrchestrationRun,
    context: AuthContext,
  ): {
    role: "orchestrator" | "worker";
    systemPrompt: string | null;
  } | null {
    const projectId = this.repository.getJob(run.jobId)?.projectId;
    if (!projectId || !this.projectAccess) return null;
    const orchestrator = this.projectAccess.getOrchestrator?.(
      projectId,
      context.userId,
      isAdminContext(context),
    );
    if (!orchestrator) {
      return {
        role: run.parentRunId === null ? "orchestrator" : "worker",
        systemPrompt: null,
      };
    }
    return orchestrator.id === run.agentId
      ? { role: "orchestrator", systemPrompt: orchestrator.systemPrompt }
      : { role: "worker", systemPrompt: null };
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
    if (limit.duration <= 0) {
      throw new OrchestrationTimeoutError(limit.code, 0);
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        void this.runner.cancel(agent.id).catch(() => undefined);
        reject(new OrchestrationTimeoutError(limit.code, limit.duration));
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
  constructor(
    readonly code: "run_timeout" | "job_timeout",
    readonly durationMs: number,
  ) {
    const subject = code === "run_timeout" ? "Agent turn" : "Orchestration job";
    const duration = durationMs < 1_000
      ? durationMs + " ms"
      : Math.ceil(durationMs / 1_000) + " seconds";
    super(`${subject} timed out after ${duration} (${code})`);
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

function recoveryAttemptsOption(value: number | undefined): number {
  const attempts = value ?? 1;
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > 3) {
    throw new Error("Recovery attempts must be an integer between 0 and 3");
  }
  return attempts;
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

const sharedFinalTemplate =
  '{"type":"final","summary":"Short plain-language summary.","content":"Complete result or exact blocker.","targetAgentKey":null,"task":null,"action":null,"resourceType":null,"resourceKey":null,"purpose":null,"query":null,"delegations":null}';
const sharedDelegateTemplate =
  '{"type":"delegate","summary":null,"content":null,"targetAgentKey":"exact-agent-key","task":"Focused task and expected evidence.","action":null,"resourceType":null,"resourceKey":null,"purpose":null,"query":null,"delegations":null}';
const sharedParallelDelegateTemplate =
  '{"type":"delegate_parallel","summary":null,"content":null,"targetAgentKey":null,"task":null,"action":null,"resourceType":null,"resourceKey":null,"purpose":null,"query":null,"delegations":[{"targetAgentKey":"frontend-agent-key","task":"Focused frontend task with non-overlapping files."},{"targetAgentKey":"backend-agent-key","task":"Focused backend task with non-overlapping files."}]}';
const sharedResourceTemplate =
  '{"type":"resource_request","summary":null,"content":null,"targetAgentKey":"agent-that-owns-the-capability","task":null,"action":"read","resourceType":"data_asset","resourceKey":"exact-resource-key","purpose":"Why this minimum access is needed.","query":null,"delegations":null}';

function structuredPrompt(
  prompt: string,
  availableAgents: OrchestrationAgentDescriptor[] = [],
  options: {
    collaborative?: boolean;
    projectRole?: "orchestrator" | "worker" | null;
    systemPrompt?: string | null;
  } = {},
): string {
  const collaborative = options.collaborative ?? false;
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
  const projectInstructions = options.projectRole === "orchestrator"
    ? [
        "Project orchestrator system prompt:",
        options.systemPrompt?.trim() || "Coordinate this project through its participating Agents.",
        "End project orchestrator system prompt.",
        "You are the only coordinator for this job. Delegate specialist work, request protected resources when needed, review each returned result, and continue until you can synthesize the final answer.",
        `Delegate template: ${sharedDelegateTemplate}`,
        `Parallel delegate template (only for independent tasks that will not edit the same files or depend on each other): ${sharedParallelDelegateTemplate}`,
        `Protected-resource template: ${sharedResourceTemplate}`,
        `Final template: ${sharedFinalTemplate}`,
      ]
    : options.projectRole === "worker"
      ? [
          "You are a participating project Agent answering the dedicated project orchestrator.",
          "Do not delegate to another Agent and do not issue a resource_request. The project orchestrator owns those actions.",
          "Complete the focused task with the information you have. If required information is missing, state the exact resource type, resource key, action, and purpose in content so the orchestrator can request it.",
          `Return only this fixed template: ${sharedFinalTemplate}`,
        ]
      : [];
  return [
    "You are participating in a multi-Agent orchestration.",
    "Return exactly one JSON object and no markdown.",
    ...(collaborative
      ? [
          "This is a shared project run. The runtime enforces the collaboration response template.",
          "Every field in the template is required. Set fields that do not apply to null. Keep final.content as a string, including when it contains serialized structured data.",
          ...projectInstructions,
        ]
      : [
          'For a final response use {"type":"final","summary":"Short plain-language summary of what you did.","content":"Full result, including any structured data."}.',
          'To delegate use {"type":"delegate","targetAgentKey":"...","task":"..."}.',
          `For independent parallel work use ${sharedParallelDelegateTemplate}. Never use it for tasks that edit the same files or require each other's output.`,
          'To request protected data use {"type":"resource_request","targetAgentKey":"...","action":"read","resourceType":"data_asset","resourceKey":"...","purpose":"...","query":"..."}. Omit query unless the resource documents one.',
        ]),
    "The shared order database resource (data_asset key database) accepts only these read-only queries: orders.list?status=<status>&limit=<1..50>&sort=created_at_asc|created_at_desc and orders.summary?status=<status>. The sanitized users table (data_asset key database:users) accepts only users.list?status=active|inactive|all&limit=<1..50>&sort=username_asc|username_desc|created_at_asc|created_at_desc and users.summary?status=active|inactive|all. Use the exact key for the requested table and never send SQL.",
    "Treat authorization denial messages as final policy; never retry a denied request with different wording.",
    "The summary is shown on the run card. Keep it human-readable, concise, and free of JSON or code; keep the complete result in content.",
    ...(options.projectRole === "worker" ? [] : roster),
    "Task or orchestration result:",
    prompt,
  ].join("\n");
}

function recoveryPrompt(
  originalPrompt: string,
  reason: string,
  projectWorkerOnly = false,
): string {
  return [
    "Your previous turn could not be accepted by the orchestration gateway.",
    `Validation detail: ${reason}`,
    "Repair the response and perform the same task again.",
    "Return exactly one valid JSON object and no markdown, prose, or code fences.",
    "Every field is required. Use null for every field that does not apply.",
    `For a final response use exactly this shape: ${sharedFinalTemplate}`,
    ...(projectWorkerOnly
      ? ["You are a participating project Agent. Return type final only; the project orchestrator owns delegation and protected-resource requests."]
      : [
          `For delegation use exactly this shape: ${sharedDelegateTemplate}`,
          `For independent parallel delegation use exactly this shape: ${sharedParallelDelegateTemplate}`,
        `For protected data use exactly this shape: ${sharedResourceTemplate}`,
      ]),
    "Keep final.content as a string, even when it contains serialized JSON.",
    "The shared database resources accept only the documented read-only orders.list/orders.summary query for key database or users.list/users.summary query for key database:users. Use the exact key for the requested table and never send SQL.",
    "Original task:",
    originalPrompt,
  ].join("\n");
}

function recoverySummary(reason: string): string {
  if (reason.toLocaleLowerCase().includes("valid json")) {
    return "The Agent returned an invalid response, so it is being asked to reply in the required JSON format.";
  }
  return "The Agent encountered a temporary execution problem, so it is being asked to try this step again.";
}

function safeRuntimeProgressDetail(progress: RunnerProgress): string {
  if (progress.stage === "runtime_started") return "runtime_started";
  if (progress.stage === "heartbeat") return "heartbeat";
  const detail = progress.detail?.trim() ?? "unknown";
  return /^[a-zA-Z0-9_.:-]{1,80}$/.test(detail) ? detail : "unknown";
}

function runtimeProgressMessage(
  progress: RunnerProgress,
  startedAt: string | null,
): string {
  if (progress.stage === "runtime_started") {
    return "The Agent runtime started; waiting for the first Codex event.";
  }
  if (progress.stage === "heartbeat") {
    const startedMs = startedAt ? Date.parse(startedAt) : NaN;
    const elapsedSeconds = Number.isFinite(startedMs)
      ? Math.max(0, Math.floor((Date.now() - startedMs) / 1_000))
      : null;
    return elapsedSeconds === null
      ? "The Agent runtime is still active."
      : `The Agent runtime is still active after ${elapsedSeconds} seconds.`;
  }
  const event = safeRuntimeProgressDetail(progress);
  return event === "unknown"
    ? "The Agent runtime reported an update."
    : `The Agent runtime reported Codex event: ${event}.`;
}

function finalContentText(content: unknown): string {
  if (typeof content === "string") return content;
  const serialized = JSON.stringify(content, null, 2);
  if (!serialized) throw new Error("Final response content could not be serialized");
  return serialized;
}

function safeResourceReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message === "resource_not_allowlisted" ||
    message === "resource_not_available" ||
    message === "database_query_required" ||
    message === "database_query_not_allowlisted"
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

function isAdminContext(context: AuthContext): boolean {
  return context.roleNames.some(
    (role) => role.toLocaleLowerCase() === "admin",
  );
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

function deniedDelegationEnvelope(
  resourceKey: string,
  reasonCode: string,
): ReturnType<typeof agentResumeEnvelopeSchema.parse> {
  return agentResumeEnvelopeSchema.parse({
    type: "authorization_denied",
    action: "invoke",
    resourceType: "agent",
    resourceKey,
    reasonCode,
  });
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
