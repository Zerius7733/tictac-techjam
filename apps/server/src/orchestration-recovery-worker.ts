import {
  agentResumeEnvelopeSchema,
  type AgentResumeEnvelope,
} from "./orchestration-protocol.js";
import type {
  AuthContext,
  OrchestrationJob,
  OrchestrationRepository,
} from "./orchestration-contracts.js";
import type {
  OrchestrationAgentDirectory,
  OrchestrationDispatcher,
} from "./orchestration-dispatcher.js";

export type WaitingRunContextResolver = (
  job: OrchestrationJob,
) => Promise<AuthContext | null> | AuthContext | null;

export interface RecoveryResult {
  resumedRunIds: string[];
  skippedRunIds: string[];
  failedRunIds: string[];
}

/**
 * Resumes waiting parents only when a terminal child and authenticated
 * execution context are both available. Call this before conservative
 * restart reconciliation; anything not safely reconstructable is cancelled.
 */
export class OrchestrationRecoveryWorker {
  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly dispatcher: OrchestrationDispatcher,
    private readonly agents: OrchestrationAgentDirectory,
    private readonly resolveContext: WaitingRunContextResolver,
  ) {}

  async resumeWaitingRuns(): Promise<RecoveryResult> {
    const result: RecoveryResult = {
      resumedRunIds: [],
      skippedRunIds: [],
      failedRunIds: [],
    };
    for (const job of this.repository.listJobs()) {
      if (job.status !== "queued" && job.status !== "running") continue;
      const context = await this.resolveContext(job);
      const waitingRuns = this.repository
        .listRuns(job.id)
        .filter((run) => run.status === "waiting");
      for (const run of waitingRuns) {
        const envelope = this.childEnvelope(job.id, run.id);
        if (!context || !envelope) {
          result.skippedRunIds.push(run.id);
          continue;
        }
        try {
          await this.dispatcher.resumeWaitingRun({
            runId: run.id,
            authContext: context,
            envelope,
          });
          result.resumedRunIds.push(run.id);
        } catch {
          result.failedRunIds.push(run.id);
        }
      }
    }
    return result;
  }

  private childEnvelope(jobId: string, parentRunId: string): AgentResumeEnvelope | null {
    const child = this.repository
      .listRuns(jobId)
      .filter((run) => run.parentRunId === parentRunId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!child || !isTerminal(child.status)) return null;
    const source = this.agents.getAgentById(child.agentId);
    const sourceAgentKey = source?.agentKey ?? child.agentId;
    if (child.status === "completed") {
      return agentResumeEnvelopeSchema.parse({
        type: "child_result",
        sourceAgentKey,
        content: child.outputText ?? "Child run completed without output.",
      });
    }
    return agentResumeEnvelopeSchema.parse({
      type: "authorization_denied",
      action: "invoke",
      resourceType: "agent",
      resourceKey: sourceAgentKey,
      reasonCode: "child_run_" + child.status,
    });
  }
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
