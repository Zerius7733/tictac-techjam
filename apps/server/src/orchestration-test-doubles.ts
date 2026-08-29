import { randomUUID } from "node:crypto";
import type {
  AgentRunner,
  RunnerRequest,
  RunnerResult,
} from "./types.js";
import type {
  AppendMessageInput,
  AuthContext,
  AuthorizationDecision,
  CompleteJobInput,
  CompleteRunInput,
  CreateChildRunInput,
  CreateRootJobInput,
  FailRunInput,
  OrchestrationJob,
  OrchestrationMessage,
  OrchestrationRepository,
  OrchestrationRun,
  StartRunInput,
} from "./orchestration-contracts.js";

const now = () => new Date().toISOString();

export type RunnerScript =
  | RunnerResult
  | Error
  | ((request: RunnerRequest) => RunnerResult | Promise<RunnerResult>);

/** A deterministic runner for state-machine tests; it never starts Codex. */
export class ScriptedAgentRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];
  readonly cancellations: string[] = [];

  constructor(private readonly scripts: RunnerScript[] = []) {}

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(structuredClone(request));
    const script = this.scripts.shift();
    if (script === undefined) {
      throw new Error("No scripted runner result is available");
    }
    if (script instanceof Error) throw script;
    if (typeof script === "function") return await script(request);
    return structuredClone(script);
  }

  async cancel(agentId: string): Promise<boolean> {
    this.cancellations.push(agentId);
    return true;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

export type AuthorizationCall = {
  context: AuthContext;
  action: string;
  resourceType: string;
  resourceKey: string;
};

/** A fail-closed-by-default authorizer fixture that records every call. */
export class RecordingAuthorizer {
  readonly calls: AuthorizationCall[] = [];

  constructor(
    private readonly decide: (
      call: AuthorizationCall,
    ) => AuthorizationDecision | Promise<AuthorizationDecision> = () => ({
      allowed: false,
      reasonCode: "permission_missing",
      auditLogId: randomUUID(),
    }),
  ) {}

  async authorize(
    context: AuthContext,
    action: string,
    resourceType: string,
    resourceKey: string,
  ): Promise<AuthorizationDecision> {
    const call = {
      context: structuredClone(context),
      action,
      resourceType,
      resourceKey,
    };
    this.calls.push(call);
    return structuredClone(await this.decide(call));
  }
}

/**
 * Small repository fixture for orchestration tests. It mirrors the invariants
 * the SQLite repository must enforce, including same-job parent/run links and
 * one active run per Agent.
 */
export class InMemoryOrchestrationRepository implements OrchestrationRepository {
  private readonly jobs = new Map<string, OrchestrationJob>();
  private readonly runs = new Map<string, OrchestrationRun>();
  private readonly messages = new Map<string, OrchestrationMessage>();
  private readonly nextSequence = new Map<string, number>();

  async createRootJob(input: CreateRootJobInput) {
    if ([...this.jobs.values()].some((job) => job.requestId === input.requestId)) {
      throw new Error("requestId already exists");
    }
    this.assertAgentAvailable(input.agentId);
    const createdAt = input.createdAt ?? now();
    const job: OrchestrationJob = {
      id: randomUUID(),
      requestId: input.requestId,
      userId: input.userId,
      inputText: input.inputText,
      inputJson: structuredClone(input.inputJson ?? {}),
      status: "queued",
      outputText: null,
      errorText: null,
      createdAt,
      startedAt: null,
      completedAt: null,
    };
    const run: OrchestrationRun = {
      id: randomUUID(),
      jobId: job.id,
      agentId: input.agentId,
      parentRunId: null,
      attempt: 1,
      status: "queued",
      prompt: input.prompt,
      inputJson: structuredClone(input.runInputJson ?? {}),
      outputText: null,
      outputJson: null,
      errorText: null,
      codexThreadId: null,
      usage: null,
      createdAt,
      startedAt: null,
      completedAt: null,
    };
    this.jobs.set(job.id, job);
    this.runs.set(run.id, run);
    const message = this.appendMessageSync({
      jobId: job.id,
      runId: run.id,
      role: "user",
      senderKind: "user",
      messageType: "prompt",
      content: input.inputText,
      createdAt,
    });
    return { job: structuredClone(job), run: structuredClone(run), message };
  }

  async createChildRun(input: CreateChildRunInput) {
    const job = this.jobs.get(input.jobId);
    const parent = this.runs.get(input.parentRunId);
    if (!job || !parent || parent.jobId !== input.jobId) {
      throw new Error("Parent run does not belong to the job");
    }
    this.assertAgentAvailable(input.agentId);
    const createdAt = input.createdAt ?? now();
    const run: OrchestrationRun = {
      id: randomUUID(),
      jobId: input.jobId,
      agentId: input.agentId,
      parentRunId: input.parentRunId,
      attempt: 1,
      status: "queued",
      prompt: input.prompt,
      inputJson: structuredClone(input.inputJson ?? {}),
      outputText: null,
      outputJson: null,
      errorText: null,
      codexThreadId: null,
      usage: null,
      createdAt,
      startedAt: null,
      completedAt: null,
    };
    this.runs.set(run.id, run);
    const message = this.appendMessageSync({
      jobId: input.jobId,
      runId: input.parentRunId,
      role: "assistant",
      senderKind: "agent",
      senderKey: parent.agentId,
      recipientKind: "agent",
      recipientKey: input.agentId,
      messageType: "delegation",
      content: input.prompt,
      createdAt,
    });
    return { run: structuredClone(run), message };
  }

  async appendMessage(input: AppendMessageInput) {
    return this.appendMessageSync(input);
  }

  async startRun(input: StartRunInput) {
    const run = this.requireRun(input.runId);
    if (run.status !== "queued") throw new Error("Run is not queued");
    this.assertAgentAvailable(run.agentId, run.id);
    run.status = "running";
    run.startedAt = input.startedAt ?? now();
    const job = this.requireJob(run.jobId);
    if (job.status === "queued") {
      job.status = "running";
      job.startedAt = run.startedAt;
    }
    return structuredClone(run);
  }

  async completeRun(input: CompleteRunInput) {
    const run = this.requireRun(input.runId);
    if (run.status !== "running") throw new Error("Run is not running");
    run.status = "completed";
    run.outputText = input.outputText;
    run.outputJson = structuredClone(input.outputJson ?? null);
    run.codexThreadId = input.codexThreadId ?? null;
    run.usage = structuredClone(input.usage ?? null);
    run.completedAt = input.completedAt ?? now();
    return structuredClone(run);
  }

  async failRun(input: FailRunInput) {
    const run = this.requireRun(input.runId);
    if (run.status !== "running" && run.status !== "queued") {
      throw new Error("Run is already terminal");
    }
    run.status = "failed";
    run.errorText = input.errorText;
    run.completedAt = input.completedAt ?? now();
    return structuredClone(run);
  }

  async completeJob(input: CompleteJobInput) {
    const job = this.requireJob(input.jobId);
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      throw new Error("Job is already terminal");
    }
    job.status = input.status;
    job.outputText = input.outputText ?? null;
    job.errorText = input.errorText ?? null;
    job.completedAt = input.completedAt ?? now();
    return structuredClone(job);
  }

  getJob(jobId: string) {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : null;
  }

  getRun(runId: string) {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : null;
  }

  listRuns(jobId: string) {
    return [...this.runs.values()]
      .filter((run) => run.jobId === jobId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((run) => structuredClone(run));
  }

  listMessages(jobId: string) {
    return [...this.messages.values()]
      .filter((message) => message.jobId === jobId)
      .sort((left, right) => left.sequenceNo - right.sequenceNo)
      .map((message) => structuredClone(message));
  }

  private appendMessageSync(input: AppendMessageInput): OrchestrationMessage {
    const job = this.requireJob(input.jobId);
    if (input.runId !== undefined && input.runId !== null) {
      const run = this.requireRun(input.runId);
      if (run.jobId !== job.id) throw new Error("Message run does not belong to the job");
    }
    const sequenceNo = this.nextSequence.get(job.id) ?? 0;
    this.nextSequence.set(job.id, sequenceNo + 1);
    const message: OrchestrationMessage = {
      id: randomUUID(),
      jobId: job.id,
      runId: input.runId ?? null,
      sequenceNo,
      role: input.role,
      senderKind: input.senderKind,
      senderKey: input.senderKey ?? null,
      recipientKind: input.recipientKind ?? null,
      recipientKey: input.recipientKey ?? null,
      messageType: input.messageType,
      content: input.content ?? "",
      payload: structuredClone(input.payload ?? {}),
      createdAt: input.createdAt ?? now(),
    };
    this.messages.set(message.id, message);
    return structuredClone(message);
  }

  private requireJob(jobId: string): OrchestrationJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("Job not found");
    return job;
  }

  private requireRun(runId: string): OrchestrationRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error("Run not found");
    return run;
  }

  private assertAgentAvailable(agentId: string, currentRunId?: string): void {
    const active = [...this.runs.values()].find(
      (run) =>
        run.agentId === agentId &&
        (run.status === "queued" || run.status === "running") &&
        run.id !== currentRunId,
    );
    if (active) throw new Error("Agent already has an active run");
  }
}
