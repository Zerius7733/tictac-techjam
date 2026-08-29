import { describe, expect, it } from "vitest";
import {
  InMemoryOrchestrationRepository,
  RecordingAuthorizer,
  ScriptedAgentRunner,
} from "./orchestration-test-doubles.js";

describe("orchestration test doubles", () => {
  it("records the exact authorization context and request", async () => {
    const authorizer = new RecordingAuthorizer(() => ({
      allowed: true,
      reasonCode: "permission_granted",
      auditLogId: "audit-1",
    }));
    const context = { requestId: "request-1", userId: "user-1", roleNames: ["developer"] };

    await expect(
      authorizer.authorize(context, "read", "data_asset", "order-schema"),
    ).resolves.toEqual({
      allowed: true,
      reasonCode: "permission_granted",
      auditLogId: "audit-1",
    });
    expect(authorizer.calls).toEqual([
      { context, action: "read", resourceType: "data_asset", resourceKey: "order-schema" },
    ]);

    const deniedByDefault = new RecordingAuthorizer();
    await expect(
      deniedByDefault.authorize(context, "read", "data_asset", "customer-records"),
    ).resolves.toMatchObject({ allowed: false, reasonCode: "permission_missing" });
  });

  it("scripts runner output and records cancellation", async () => {
    const runner = new ScriptedAgentRunner([
      { output: '{"type":"final","content":"Done."}', threadId: "alice-1", usage: null },
    ]);
    await expect(
      runner.run({ agentId: "alice", workspacePath: "/workspace/alice", prompt: "Build", threadId: null }),
    ).resolves.toMatchObject({ threadId: "alice-1" });
    await expect(runner.cancel("alice")).resolves.toBe(true);
    expect(runner.requests).toHaveLength(1);
    expect(runner.cancellations).toEqual(["alice"]);

    const failedRunner = new ScriptedAgentRunner([new Error("runtime failed")]);
    await expect(
      failedRunner.run({ agentId: "bob", workspacePath: "/workspace/bob", prompt: "Run", threadId: null }),
    ).rejects.toThrow("runtime failed");
  });

  it("preserves same-job parent links and ordered messages", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const root = await repository.createRootJob({
      requestId: "request-1",
      userId: "user-1",
      inputText: "Build the dashboard",
      agentId: "alice",
      prompt: "Build the dashboard",
    });
    const child = await repository.createChildRun({
      jobId: root.job.id,
      parentRunId: root.run.id,
      agentId: "bob",
      prompt: "Provide the schema",
    });

    expect(child.run.parentRunId).toBe(root.run.id);
    expect(repository.listMessages(root.job.id).map((message) => message.sequenceNo)).toEqual([0, 1]);
    await expect(
      repository.createChildRun({
        jobId: "other-job",
        parentRunId: root.run.id,
        agentId: "bob",
        prompt: "Invalid",
      }),
    ).rejects.toThrow("Parent run does not belong to the job");
  });
});
