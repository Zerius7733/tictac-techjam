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

  listAgents(): OrchestrationAgentDescriptor[] {
    return this.records;
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
  name: "Alice Frontend",
  workspacePath: "/workspace/alice",
  status: "ready",
};
const bob: OrchestrationAgentDescriptor = {
  id: "agent-bob",
  agentKey: "bob-order-service",
  name: "Bob Order Service",
  workspacePath: "/workspace/bob",
  status: "ready",
};
const projectOrchestrator = {
  id: "agent-project-orchestrator",
  agentKey: "project-orchestrator-project-1",
  name: "Order Dashboard Orchestrator",
  workspacePath: "/workspace/project",
  status: "ready" as const,
  systemPrompt: "Coordinate the Order Dashboard and synthesize one integrated result.",
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
        output:
          '{"type":"final","summary":"Returned the approved order schema.","content":"Order schema: id, total"}',
        threadId: "bob-thread-1",
        usage: { inputTokens: 3, outputTokens: 2 },
      },
      {
        output:
          '{"type":"final","summary":"Built the dashboard using the approved schema.","content":"Dashboard built against the schema."}',
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
    expect(repository.listRuns(root.job.id)[1]?.outputJson).toMatchObject({
      type: "final",
      summary: "Returned the approved order schema.",
    });
    expect(
      repository
        .listMessages(root.job.id)
        .find((message) => message.messageType === "result")?.payload,
    ).toMatchObject({ summary: "Returned the approved order schema." });
    expect(runner.requests.map((request) => request.threadId)).toEqual([
      null,
      null,
      "alice-thread-1",
    ]);
    expect(runner.requests[0]?.prompt).toContain(
      "Bob Order Service (bob-order-service)",
    );
    expect(runner.requests[0]?.prompt).not.toContain(
      "Alice Frontend (alice-frontend)",
    );
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

  it("uses the dedicated project orchestrator and fixed worker response template", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const runner = new ScriptedAgentRunner([
      {
        output:
          '{"type":"delegate","summary":null,"content":null,"targetAgentKey":"bob-order-service","task":"Provide the approved API contract.","action":null,"resourceType":null,"resourceKey":null,"purpose":null}',
        threadId: "orchestrator-project-thread",
        usage: null,
      },
      {
        output:
          '{"type":"final","summary":"Returned the approved API contract.","content":"GET /orders uses the approved non-PII schema.","targetAgentKey":null,"task":null,"action":null,"resourceType":null,"resourceKey":null,"purpose":null}',
        threadId: "bob-project-thread",
        usage: null,
      },
      {
        output:
          '{"type":"final","summary":"Finished the project task.","content":"Use GET /orders with the approved non-PII schema.","targetAgentKey":null,"task":null,"action":null,"resourceType":null,"resourceKey":null,"purpose":null}',
        threadId: "orchestrator-project-thread-2",
        usage: null,
      },
    ]);
    const dispatcher = new OrchestrationDispatcher(
      repository,
      new TestAgentDirectory([projectOrchestrator, alice, bob]),
      new RecordingAuthorizer(() => ({
        allowed: true,
        reasonCode: "permission_granted",
        auditLogId: "audit-project",
      })),
      runner,
      {
        collaborativeOutputSchemaPath: "/tmp/orchestration-output.schema.json",
        projectAccess: {
          canUseAgent: () => true,
          listAgents: () => [alice, bob],
          getOrchestrator: () => projectOrchestrator,
          workspacePath: () => "/workspace/project",
        },
      },
    );
    const root = await repository.createRootJob({
      requestId: "request-project",
      userId: context.userId,
      projectId: "project-1",
      inputText: "Finish the project task",
      agentId: projectOrchestrator.id,
      prompt: "Finish the project task",
    });

    await expect(
      dispatcher.dispatchRoot({
        jobId: root.job.id,
        rootRunId: root.run.id,
        authContext: context,
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(runner.requests[0]?.outputSchemaPath).toBe(
      "/tmp/orchestration-output.schema.json",
    );
    expect(runner.requests[0]?.prompt).toContain(
      "The runtime enforces the collaboration response template",
    );
    expect(runner.requests[0]?.prompt).toContain(projectOrchestrator.systemPrompt);
    expect(runner.requests[0]?.prompt).toContain("Bob Order Service (bob-order-service)");
    expect(runner.requests[1]?.prompt).toContain(
      "Return only this fixed template",
    );
    expect(runner.requests[1]?.prompt).toContain(
      '"targetAgentKey":null',
    );
    expect(runner.requests[1]?.prompt).not.toContain("Available Agents");
    expect(repository.listRuns(root.job.id)).toHaveLength(2);
    expect(repository.getJob(root.job.id)).toMatchObject({
      status: "completed",
      outputText: "Use GET /orders with the approved non-PII schema.",
    });
  });

  it("runs independent delegated Agents concurrently", async () => {
    const repository = new InMemoryOrchestrationRepository();
    let activeChildren = 0;
    let maximumActiveChildren = 0;
    const runner = new ScriptedAgentRunner([
      {
        output:
          '{"type":"delegate_parallel","summary":null,"content":null,"targetAgentKey":null,"task":null,"action":null,"resourceType":null,"resourceKey":null,"purpose":null,"delegations":[{"targetAgentKey":"alice-frontend","task":"Build the frontend shell without editing backend files."},{"targetAgentKey":"bob-order-service","task":"Define the backend contract without editing frontend files."}]}',
        threadId: "orchestrator-parallel-thread",
        usage: null,
      },
      async () => {
        activeChildren += 1;
        maximumActiveChildren = Math.max(maximumActiveChildren, activeChildren);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeChildren -= 1;
        return {
          output: '{"type":"final","summary":"Frontend work complete.","content":"Frontend shell ready."}',
          threadId: "alice-parallel-thread",
          usage: null,
        };
      },
      async () => {
        activeChildren += 1;
        maximumActiveChildren = Math.max(maximumActiveChildren, activeChildren);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeChildren -= 1;
        return {
          output: '{"type":"final","summary":"Backend work complete.","content":"Backend contract ready."}',
          threadId: "bob-parallel-thread",
          usage: null,
        };
      },
      {
        output:
          '{"type":"final","summary":"Combined the independent results.","content":"Frontend and backend work are ready to integrate."}',
        threadId: "orchestrator-parallel-thread-2",
        usage: null,
      },
    ]);
    const dispatcher = new OrchestrationDispatcher(
      repository,
      new TestAgentDirectory([projectOrchestrator, alice, bob]),
      new RecordingAuthorizer(() => ({
        allowed: true,
        reasonCode: "permission_granted",
        auditLogId: "audit-parallel",
      })),
      runner,
      {
        projectAccess: {
          canUseAgent: () => true,
          listAgents: () => [alice, bob],
          getOrchestrator: () => projectOrchestrator,
          workspacePath: () => "/workspace/project",
        },
      },
    );
    const root = await repository.createRootJob({
      requestId: "request-parallel",
      userId: context.userId,
      projectId: "project-1",
      inputText: "Prepare the independent frontend and backend pieces",
      agentId: projectOrchestrator.id,
      prompt: "Prepare the independent frontend and backend pieces",
    });

    await expect(
      dispatcher.dispatchRoot({
        jobId: root.job.id,
        rootRunId: root.run.id,
        authContext: context,
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(maximumActiveChildren).toBe(2);
    expect(repository.listRuns(root.job.id)).toHaveLength(3);
    expect(repository.listMessages(root.job.id).filter((message) => message.messageType === "delegation")).toHaveLength(2);
    expect(
      repository
        .listMessages(root.job.id)
        .find((message) => message.messageType === "tool_result")?.content,
    ).toContain("Frontend shell ready.");
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

  it("allows a protected read while the capability-owning Agent is busy", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const busyBob = { ...bob, status: "busy" as const };
    const runner = new ScriptedAgentRunner([
      {
        output:
          '{"type":"resource_request","targetAgentKey":"bob-order-service","action":"read","resourceType":"data_asset","resourceKey":"database","query":"orders.summary","purpose":"Build dashboard metrics"}',
        threadId: "alice-thread-1",
        usage: null,
      },
      {
        output: '{"type":"final","content":"Summary received."}',
        threadId: "alice-thread-2",
        usage: null,
      },
    ]);
    let providerCalls = 0;
    const dispatcher = new OrchestrationDispatcher(
      repository,
      new TestAgentDirectory([alice, busyBob]),
      new RecordingAuthorizer(() => ({
        allowed: true,
        reasonCode: "permission_granted",
        auditLogId: "audit-busy-resource",
      })),
      runner,
      {
        resourceProvider: {
          async provide(request) {
            providerCalls += 1;
            expect(request.resourceKey).toBe("database");
            expect(request.query).toBe("orders.summary");
            return { content: '{"resource":"database","total_orders":4}' };
          },
        },
      },
    );
    const root = await repository.createRootJob({
      requestId: "request-busy-resource",
      userId: context.userId,
      inputText: "Build dashboard metrics",
      agentId: alice.id,
      prompt: "Build dashboard metrics",
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
  });

  it("allows an Agent to query a resource through its own principal", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const runner = new ScriptedAgentRunner([
      {
        output:
          '{"type":"resource_request","targetAgentKey":"alice-frontend","action":"read","resourceType":"data_asset","resourceKey":"database","query":"orders.summary","purpose":"Build dashboard metrics"}',
        threadId: "alice-thread-1",
        usage: null,
      },
      {
        output: '{"type":"final","content":"Summary received."}',
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
        auditLogId: "audit-own-resource",
      })),
      runner,
      {
        resourceProvider: {
          async provide(request) {
            providerCalls += 1;
            expect(request.agentId).toBe(alice.id);
            expect(request.query).toBe("orders.summary");
            return { content: '{"resource":"database","total_orders":4}' };
          },
        },
      },
    );
    const root = await repository.createRootJob({
      requestId: "request-own-resource",
      userId: context.userId,
      inputText: "Build dashboard metrics",
      agentId: alice.id,
      prompt: "Build dashboard metrics",
    });

    await expect(
      dispatcher.dispatchRoot({
        jobId: root.job.id,
        rootRunId: root.run.id,
        authContext: context,
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(providerCalls).toBe(1);
  });

  it("repairs one invalid Agent response before completing the run", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const runner = new ScriptedAgentRunner([
      { output: "not json", threadId: "alice-thread", usage: null },
      {
        output: '{"type":"final","summary":"Recovered safely.","content":"The task was completed after a format repair."}',
        threadId: "alice-repair-thread",
        usage: null,
      },
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
    );
    const root = await repository.createRootJob({
      requestId: "request-invalid",
      userId: context.userId,
      inputText: "Invalid",
      agentId: alice.id,
      prompt: "Invalid",
    });

    await expect(dispatcher.dispatchRoot({
      jobId: root.job.id,
      rootRunId: root.run.id,
      authContext: context,
    })).resolves.toMatchObject({
      status: "completed",
      outputText: "The task was completed after a format repair.",
    });
    expect(repository.listRuns(root.job.id)).toHaveLength(1);
    expect(repository.getRun(root.run.id)).toMatchObject({ status: "completed", attempt: 2 });
    expect(runner.requests).toHaveLength(2);
    expect(runner.requests[1]?.prompt).toContain("could not be accepted");
    expect(repository.listMessages(root.job.id).map((message) => message.messageType)).toEqual([
      "prompt",
      "progress",
      "result",
    ]);
    expect(repository.listMessages(root.job.id)[1]?.content).toContain(
      "invalid response",
    );
  });

  it("keeps structured final content in raw output while rendering readable text", async () => {
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
        {
          output:
            '{"type":"final","summary":"Returned the approved contract.","content":{"orders":{"order_id":"string","total_amount":"decimal"}}}',
          threadId: "alice-structured-thread",
          usage: null,
        },
      ]),
    );
    const root = await repository.createRootJob({
      requestId: "request-structured-final",
      userId: context.userId,
      inputText: "Return the contract",
      agentId: alice.id,
      prompt: "Return the contract",
    });

    await expect(
      dispatcher.dispatchRoot({
        jobId: root.job.id,
        rootRunId: root.run.id,
        authContext: context,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      outputText: '{\n  "orders": {\n    "order_id": "string",\n    "total_amount": "decimal"\n  }\n}',
    });
    expect(repository.getRun(root.run.id)?.outputJson).toMatchObject({
      content: { orders: { order_id: "string" } },
    });
  });

  it("keeps the final protocol error after the bounded repair attempt is exhausted", async () => {
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
        { output: "not json", threadId: "alice-thread-1", usage: null },
        { output: "still not json", threadId: "alice-thread-2", usage: null },
      ]),
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
      errorText: "Agent output must be valid JSON",
    });
    expect(repository.getRun(root.run.id)?.attempt).toBe(2);
    expect(repository.listMessages(root.job.id).map((message) => message.messageType)).toEqual([
      "prompt",
      "progress",
      "error",
    ]);
  });

  it("repairs a transient runtime failure once", async () => {
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
        new Error("runtime unavailable"),
        { output: '{"type":"final","content":"Recovered."}', threadId: "thread-2", usage: null },
      ]),
    );
    const root = await repository.createRootJob({
      requestId: "request-runner-recovery",
      userId: context.userId,
      inputText: "Recover",
      agentId: alice.id,
      prompt: "Recover",
    });

    await expect(
      dispatcher.dispatchRoot({
        jobId: root.job.id,
        rootRunId: root.run.id,
        authContext: context,
      }),
    ).resolves.toMatchObject({ status: "completed", outputText: "Recovered." });
    expect(repository.getRun(root.run.id)).toMatchObject({ status: "completed", attempt: 2 });
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
    ).resolves.toMatchObject({
      status: "failed",
      errorText: "Agent turn timed out after 20 ms (run_timeout)",
    });
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

  it("persists safe runtime progress without storing model output", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const runner = new ScriptedAgentRunner([
      (request) => {
        request.onProgress?.({
          stage: "runtime_started",
          detail: "Codex CLI process started.",
        });
        request.onProgress?.({
          stage: "codex_event",
          detail: "thread.started",
        });
        request.onProgress?.({
          stage: "codex_event",
          detail: "an event with model output that must not be stored",
        });
        return {
          output: '{"type":"final","content":"Done"}',
          threadId: "thread",
          usage: null,
        };
      },
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
      { runTimeoutMs: null, jobTimeoutMs: null },
    );
    const root = await repository.createRootJob({
      requestId: "request-runtime-progress",
      userId: context.userId,
      inputText: "Report progress",
      agentId: alice.id,
      prompt: "Report progress",
    });

    await dispatcher.dispatchRoot({
      jobId: root.job.id,
      rootRunId: root.run.id,
      authContext: context,
    });

    const progress = repository
      .listMessages(root.job.id)
      .filter((message) => message.payload.event === "runtime_progress");
    expect(progress.map((message) => message.content)).toEqual([
      "The Agent runtime started; waiting for the first Codex event.",
      "The Agent runtime reported Codex event: thread.started.",
    ]);
    expect(progress.every((message) => !message.content.includes("model output"))).toBe(true);
  });
});
