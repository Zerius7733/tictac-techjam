import { describe, expect, it } from "vitest";
import {
  InMemoryOrchestrationRepository,
  RecordingAuthorizer,
  ScriptedAgentRunner,
} from "./orchestration-test-doubles.js";
import {
  OrchestrationDispatcher,
  type OrchestrationAgentDescriptor,
  type OrchestrationAgentDirectory,
} from "./orchestration-dispatcher.js";
import type { RunnerResult } from "./types.js";

class TestAgentDirectory implements OrchestrationAgentDirectory {
  constructor(private readonly records: OrchestrationAgentDescriptor[]) {}

  getAgentById(agentId: string): OrchestrationAgentDescriptor | null {
    return this.records.find((agent) => agent.id === agentId) ?? null;
  }

  getAgentByKey(agentKey: string): OrchestrationAgentDescriptor | null {
    return this.records.find((agent) => agent.agentKey === agentKey) ?? null;
  }
}

class TrackingRepository extends InMemoryOrchestrationRepository {
  readonly events: string[] = [];

  override async waitRun(input: { runId: string }) {
    this.events.push("wait:" + input.runId);
    return super.waitRun(input);
  }

  override async createChildRun(input: Parameters<InMemoryOrchestrationRepository["createChildRun"]>[0]) {
    this.events.push("child:" + input.agentId);
    return super.createChildRun(input);
  }
}

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
const context = { requestId: "request-1", userId: "user-1", roleNames: ["developer"] };

describe("OrchestrationDispatcher", () => {
  it("runs Alice -> Bob -> Alice with separate run threads", async () => {
    const repository = new TrackingRepository();
    const runner = new ScriptedAgentRunner([
      {
        output:
          '{"type":"delegate","targetAgentKey":"bob-order-service","task":"Provide the sanitized order schema."}',
        threadId: "alice-thread-1",
        usage: { inputTokens: 4, outputTokens: 2 },
      },
      {
        output: '{"type":"final","content":"Order schema: id, total"}',
        threadId: "bob-thread-1",
        usage: { inputTokens: 3, outputTokens: 2 },
      },
      {
        output: '{"type":"final","content":"Dashboard built against the schema."}',
        threadId: "alice-thread-2",
        usage: { inputTokens: 5, outputTokens: 2 },
      },
    ]);
    const authorizer = new RecordingAuthorizer(() => ({
      allowed: true,
      reasonCode: "permission_granted",
      auditLogId: "audit-1",
    }));
    const dispatcher = new OrchestrationDispatcher(
      repository,
      new TestAgentDirectory([alice, bob]),
      authorizer,
      runner,
    );
    const root = await repository.createRootJob({
      requestId: context.requestId,
      userId: context.userId,
      inputText: "Build the order dashboard",
      agentId: alice.id,
      prompt: "Build the order dashboard",
    });

    await expect(
      dispatcher.dispatchRoot({ jobId: root.job.id, rootRunId: root.run.id, authContext: context }),
    ).resolves.toMatchObject({ status: "completed", outputText: "Dashboard built against the schema." });
    expect(repository.listRuns(root.job.id).map((run) => run.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(repository.events).toEqual([
      "wait:" + root.run.id,
      "child:" + bob.id,
    ]);
    expect(repository.getRun(root.run.id)).toMatchObject({
      usage: { inputTokens: 9, outputTokens: 4 },
    });
    expect(runner.requests.map((request) => request.threadId)).toEqual([
      null,
      null,
      "alice-thread-1",
    ]);
    expect(runner.requests.map((request) => request.jobId)).toEqual([
      root.job.id,
      root.job.id,
      root.job.id,
    ]);
    expect(repository.listMessages(root.job.id).map((message) => message.messageType)).toEqual([
      "prompt",
      "delegation",
      "result",
      "tool_result",
      "result",
    ]);
  });

  it("records an authorization denial and never creates or runs Bob", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const runner = new ScriptedAgentRunner([
      {
        output:
          '{"type":"resource_request","targetAgentKey":"bob-order-service","action":"read","resourceType":"data_asset","resourceKey":"customer-records","purpose":"Populate the dashboard"}',
        threadId: "alice-thread-1",
        usage: null,
      },
      {
        output: '{"type":"final","content":"I cannot access customer records."}',
        threadId: "alice-thread-2",
        usage: null,
      },
    ]);
    const authorizer = new RecordingAuthorizer((call) =>
      call.action === "read"
        ? {
            allowed: false,
            reasonCode: "permission_missing",
            auditLogId: "audit-denied",
          }
        : {
            allowed: true,
            reasonCode: "permission_granted",
            auditLogId: "audit-root",
          },
    );
    const dispatcher = new OrchestrationDispatcher(
      repository,
      new TestAgentDirectory([alice, bob]),
      authorizer,
      runner,
    );
    const root = await repository.createRootJob({
      requestId: context.requestId,
      userId: context.userId,
      inputText: "Build the order dashboard",
      agentId: alice.id,
      prompt: "Build the order dashboard",
    });

    await dispatcher.dispatchRoot({
      jobId: root.job.id,
      rootRunId: root.run.id,
      authContext: context,
    });

    expect(repository.listRuns(root.job.id)).toHaveLength(1);
    expect(repository.getRun(root.run.id)).toMatchObject({ status: "completed" });
    expect(runner.requests).toHaveLength(2);
    expect(authorizer.calls.map((call) => [call.action, call.resourceKey])).toEqual([
      ["invoke", alice.agentKey],
      ["read", "customer-records"],
    ]);
    expect(
      repository.listMessages(root.job.id).some((message) =>
        message.content.includes("permission_missing"),
      ),
    ).toBe(true);
  });

  it("uses an allowlisted provider for approved resources without creating Bob work", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const runner = new ScriptedAgentRunner([
      {
        output:
          '{"type":"resource_request","targetAgentKey":"bob-order-service","action":"read","resourceType":"data_asset","resourceKey":"order-schema","purpose":"Build the dashboard"}',
        threadId: "alice-thread-1",
        usage: null,
      },
      {
        output: '{"type":"final","content":"Built against the approved schema."}',
        threadId: "alice-thread-2",
        usage: null,
      },
    ]);
    let providerCalls = 0;
    const dispatcher = new OrchestrationDispatcher(
      repository,
      new TestAgentDirectory([alice, bob]),
      new RecordingAuthorizer(() => ({
        allowed: true,
        reasonCode: "permission_granted",
        auditLogId: "audit-allowed-resource",
      })),
      runner,
      {
        resourceProvider: {
          async provide(request) {
            providerCalls += 1;
            expect(request.resourceKey).toBe("order-schema");
            return {
              content: '{"name":"order-schema","fields":["id","total"]}',
            };
          },
        },
      },
    );
    const root = await repository.createRootJob({
      requestId: "request-resource-allowed",
      userId: context.userId,
      inputText: "Build the order dashboard",
      agentId: alice.id,
      prompt: "Build the order dashboard",
    });

    await expect(
      dispatcher.dispatchRoot({
        jobId: root.job.id,
        rootRunId: root.run.id,
        authContext: context,
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(providerCalls).toBe(1);
    expect(repository.listRuns(root.job.id)).toHaveLength(1);
    expect(repository.listMessages(root.job.id).map((message) => message.messageType)).toEqual([
      "prompt",
      "tool_call",
      "tool_result",
      "result",
    ]);
    expect(repository.listMessages(root.job.id).some((message) =>
      message.content.includes("customer-records"),
    )).toBe(false);
  });

  it("fails closed on invalid Agent output and does not dispatch children", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const dispatcher = new OrchestrationDispatcher(
      repository,
      new TestAgentDirectory([alice, bob]),
      new RecordingAuthorizer(() => ({
        allowed: true,
        reasonCode: "permission_granted",
        auditLogId: "audit-1",
      })),
      new ScriptedAgentRunner([
        { output: "not json", threadId: "alice-thread", usage: null },
      ]),
    );
    const root = await repository.createRootJob({
      requestId: "request-invalid",
      userId: context.userId,
      inputText: "Invalid",
      agentId: alice.id,
      prompt: "Invalid",
    });

    await dispatcher.dispatchRoot({
      jobId: root.job.id,
      rootRunId: root.run.id,
      authContext: context,
    });
    expect(repository.listRuns(root.job.id)).toHaveLength(1);
    expect(repository.getRun(root.run.id)).toMatchObject({ status: "failed" });
  });

  it("turns a runner failure into terminal root and job state", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const dispatcher = new OrchestrationDispatcher(
      repository,
      new TestAgentDirectory([alice, bob]),
      new RecordingAuthorizer(() => ({
        allowed: true,
        reasonCode: "permission_granted",
        auditLogId: "audit-1",
      })),
      new ScriptedAgentRunner([new Error("runtime unavailable")]),
    );
    const root = await repository.createRootJob({
      requestId: "request-runner-failure",
      userId: context.userId,
      inputText: "Fail safely",
      agentId: alice.id,
      prompt: "Fail safely",
    });

    await expect(
      dispatcher.dispatchRoot({
        jobId: root.job.id,
        rootRunId: root.run.id,
        authContext: context,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(repository.getRun(root.run.id)).toMatchObject({
      status: "failed",
      errorText: "runtime unavailable",
    });
  });

  it("rejects unknown, self-targeted, stopped, and busy targets without child runs", async () => {
    const cases: Array<{
      name: string;
      targetKey: string;
      records: OrchestrationAgentDescriptor[];
    }> = [
      { name: "unknown", targetKey: "missing-agent", records: [alice, bob] },
      { name: "self", targetKey: alice.agentKey, records: [alice, bob] },
      {
        name: "stopped",
        targetKey: bob.agentKey,
        records: [alice, { ...bob, status: "stopped" }],
      },
      {
        name: "busy",
        targetKey: bob.agentKey,
        records: [alice, { ...bob, status: "busy" }],
      },
    ];

    for (const testCase of cases) {
      const repository = new InMemoryOrchestrationRepository();
      const dispatcher = new OrchestrationDispatcher(
        repository,
        new TestAgentDirectory(testCase.records),
        new RecordingAuthorizer(() => ({
          allowed: true,
          reasonCode: "permission_granted",
          auditLogId: "audit-1",
        })),
        new ScriptedAgentRunner([
          {
            output: `{"type":"delegate","targetAgentKey":"${testCase.targetKey}","task":"Delegate safely"}`,
            threadId: "alice-thread-1",
            usage: null,
          },
          {
            output: `{"type":"final","content":"Handled ${testCase.name}."}`,
            threadId: "alice-thread-2",
            usage: null,
          },
        ]),
      );
      const root = await repository.createRootJob({
        requestId: "request-" + testCase.name,
        userId: context.userId,
        inputText: testCase.name,
        agentId: alice.id,
        prompt: testCase.name,
      });
      await dispatcher.dispatchRoot({
        jobId: root.job.id,
        rootRunId: root.run.id,
        authContext: context,
      });
      expect(repository.listRuns(root.job.id), testCase.name).toHaveLength(1);
      expect(repository.getRun(root.run.id), testCase.name).toMatchObject({
        status: "completed",
      });
    }
  });

  it("cancels an active job and interrupts its runner", async () => {
    let release!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      release = resolve;
    });
    const repository = new InMemoryOrchestrationRepository();
    const runner = new ScriptedAgentRunner([() => pending]);
    const dispatcher = new OrchestrationDispatcher(
      repository,
      new TestAgentDirectory([alice, bob]),
      new RecordingAuthorizer(() => ({
        allowed: true,
        reasonCode: "permission_granted",
        auditLogId: "audit-1",
      })),
      runner,
    );
    const root = await repository.createRootJob({
      requestId: "request-cancel-dispatch",
      userId: context.userId,
      inputText: "Cancel me",
      agentId: alice.id,
      prompt: "Cancel me",
    });

    const dispatch = dispatcher.dispatchRoot({
      jobId: root.job.id,
      rootRunId: root.run.id,
      authContext: context,
    });
    await expect.poll(() => runner.requests.length).toBe(1);
    await expect(dispatcher.cancelJob(root.job.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(runner.cancellations).toEqual([alice.id]);

    release({
      output: '{"type":"final","content":"Should not complete"}',
      threadId: "alice-thread",
      usage: null,
    });
    await expect(dispatch).resolves.toMatchObject({ status: "cancelled" });
    expect(repository.getRun(root.run.id)).toMatchObject({ status: "cancelled" });
  });

  it("fails a run on timeout and asks the runner to cancel", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const runner = new ScriptedAgentRunner([
      () => new Promise<RunnerResult>(() => undefined),
    ]);
    const dispatcher = new OrchestrationDispatcher(
      repository,
      new TestAgentDirectory([alice, bob]),
      new RecordingAuthorizer(() => ({
        allowed: true,
        reasonCode: "permission_granted",
        auditLogId: "audit-1",
      })),
      runner,
      { runTimeoutMs: 20, jobTimeoutMs: null },
    );
    const root = await repository.createRootJob({
      requestId: "request-timeout",
      userId: context.userId,
      inputText: "Timeout me",
      agentId: alice.id,
      prompt: "Timeout me",
    });

    await expect(
      dispatcher.dispatchRoot({
        jobId: root.job.id,
        rootRunId: root.run.id,
        authContext: context,
      }),
    ).resolves.toMatchObject({ status: "failed", errorText: "run_timeout" });
    expect(runner.cancellations).toEqual([alice.id]);
  });

  it("emits correlated lifecycle logs and forwards requestId to the runner", async () => {
    const events: string[] = [];
    const repository = new InMemoryOrchestrationRepository();
    const runner = new ScriptedAgentRunner([
      { output: '{"type":"final","content":"Done"}', threadId: "thread", usage: null },
    ]);
    const dispatcher = new OrchestrationDispatcher(
      repository,
      new TestAgentDirectory([alice, bob]),
      new RecordingAuthorizer(() => ({
        allowed: true,
        reasonCode: "permission_granted",
        auditLogId: "audit-1",
      })),
      runner,
      {
        runTimeoutMs: null,
        jobTimeoutMs: null,
        logger: {
          info: (_fields, message) => events.push(message),
          warn: (_fields, message) => events.push(message),
          error: (_fields, message) => events.push(message),
        },
      },
    );
    const root = await repository.createRootJob({
      requestId: "request-logs",
      userId: context.userId,
      inputText: "Log me",
      agentId: alice.id,
      prompt: "Log me",
    });

    await dispatcher.dispatchRoot({
      jobId: root.job.id,
      rootRunId: root.run.id,
      authContext: context,
    });
    expect(runner.requests[0]?.requestId).toBe(context.requestId);
    expect(events).toEqual(expect.arrayContaining([
      "orchestration_dispatch_started",
      "orchestration_agent_turn_started",
      "orchestration_agent_turn_finished",
      "orchestration_dispatch_finished",
    ]));
  });
});
