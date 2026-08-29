import { describe, expect, it } from "vitest";
import {
  OrchestrationDispatcher,
  type OrchestrationAgentDescriptor,
  type OrchestrationAgentDirectory,
} from "./orchestration-dispatcher.js";
import { OrchestrationRecoveryWorker } from "./orchestration-recovery-worker.js";
import {
  InMemoryOrchestrationRepository,
  RecordingAuthorizer,
  ScriptedAgentRunner,
} from "./orchestration-test-doubles.js";

const alice: OrchestrationAgentDescriptor = {
  id: "agent-alice",
  agentKey: "alice-frontend",
  workspacePath: "/workspace/alice",
  status: "ready",
};
const bob: OrchestrationAgentDescriptor = {
  id: "agent-bob",
  agentKey: "bob-order-service",
  workspacePath: "/workspace/bob",
  status: "ready",
};
const directory: OrchestrationAgentDirectory = {
  getAgentById: (id) => [alice, bob].find((agent) => agent.id === id) ?? null,
  getAgentByKey: (key) => [alice, bob].find((agent) => agent.agentKey === key) ?? null,
};

describe("OrchestrationRecoveryWorker", () => {
  it("resumes a waiting parent when its child and auth context are reconstructable", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const root = await repository.createRootJob({
      requestId: "request-recovery",
      userId: "user-1",
      inputText: "Recover this job",
      agentId: alice.id,
      prompt: "Recover this job",
    });
    await repository.startRun({ runId: root.run.id });
    await repository.waitRun({ runId: root.run.id, codexThreadId: "alice-thread" });
    const child = await repository.createChildRun({
      jobId: root.job.id,
      parentRunId: root.run.id,
      agentId: bob.id,
      prompt: "Return the approved schema",
    });
    await repository.startRun({ runId: child.run.id });
    await repository.completeRun({ runId: child.run.id, outputText: "id, total" });

    const dispatcher = new OrchestrationDispatcher(
      repository,
      directory,
      new RecordingAuthorizer(() => ({
        allowed: true,
        reasonCode: "permission_granted",
        auditLogId: "audit-recovery",
      })),
      new ScriptedAgentRunner([
        { output: '{"type":"final","content":"Recovered with the schema."}', threadId: "alice-thread-2", usage: null },
      ]),
    );
    const worker = new OrchestrationRecoveryWorker(
      repository,
      dispatcher,
      directory,
      (job) => ({ requestId: job.requestId, userId: job.userId ?? "user-1", roleNames: ["developer"] }),
    );

    await expect(worker.resumeWaitingRuns()).resolves.toMatchObject({
      resumedRunIds: [root.run.id],
      skippedRunIds: [],
      failedRunIds: [],
    });
    expect(repository.getRun(root.run.id)).toMatchObject({
      status: "completed",
      outputText: "Recovered with the schema.",
    });
    expect(repository.getJob(root.job.id)).toMatchObject({
      status: "completed",
      outputText: "Recovered with the schema.",
    });
  });

  it("skips waiting work when authenticated context cannot be reconstructed", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const root = await repository.createRootJob({
      requestId: "request-recovery-skip",
      userId: "user-1",
      inputText: "Do not resume",
      agentId: alice.id,
      prompt: "Do not resume",
    });
    await repository.startRun({ runId: root.run.id });
    await repository.waitRun({ runId: root.run.id });
    const dispatcher = new OrchestrationDispatcher(
      repository,
      directory,
      new RecordingAuthorizer(),
      new ScriptedAgentRunner(),
    );
    const worker = new OrchestrationRecoveryWorker(
      repository,
      dispatcher,
      directory,
      () => null,
    );
    await expect(worker.resumeWaitingRuns()).resolves.toMatchObject({
      resumedRunIds: [],
      skippedRunIds: [root.run.id],
    });
    expect(repository.getRun(root.run.id)?.status).toBe("waiting");
  });
});
