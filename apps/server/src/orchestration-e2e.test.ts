import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import {
  OrchestrationDispatcher,
  type OrchestrationAgentDescriptor,
  type OrchestrationAgentDirectory,
} from "./orchestration-dispatcher.js";
import {
  InMemoryOrchestrationRepository,
  RecordingAuthorizer,
  ScriptedAgentRunner,
} from "./orchestration-test-doubles.js";
import type { AgentService } from "./agent-service.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const alice: OrchestrationAgentDescriptor = {
  id: "11111111-1111-4111-8111-111111111111",
  agentKey: "alice-frontend",
  workspacePath: "/workspace/alice",
  status: "ready",
};
const bob: OrchestrationAgentDescriptor = {
  id: "22222222-2222-4222-8222-222222222222",
  agentKey: "bob-order-service",
  workspacePath: "/workspace/bob",
  status: "ready",
};

describe("Alice/Bob orchestration API flow", () => {
  it("runs delegation and records a protected-resource denial through the public API", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const directory: OrchestrationAgentDirectory = {
      getAgentById: (id) => [alice, bob].find((agent) => agent.id === id) ?? null,
      getAgentByKey: (key) => [alice, bob].find((agent) => agent.agentKey === key) ?? null,
    };
    const authorizer = new RecordingAuthorizer((call) =>
      call.resourceType === "data_asset" && call.resourceKey === "customer-records"
        ? {
            allowed: false,
            reasonCode: "permission_missing",
            auditLogId: "audit-customer-denied",
          }
        : {
            allowed: true,
            reasonCode: "permission_granted",
            auditLogId: "audit-allowed",
          },
    );
    const runner = new ScriptedAgentRunner([
      {
        output:
          '{"type":"delegate","targetAgentKey":"bob-order-service","task":"Share the sanitized order schema."}',
        threadId: "alice-thread-1",
        usage: null,
      },
      {
        output: '{"type":"final","content":"Approved schema: id, total"}',
        threadId: "bob-thread-1",
        usage: null,
      },
      {
        output:
          '{"type":"resource_request","targetAgentKey":"bob-order-service","action":"read","resourceType":"data_asset","resourceKey":"customer-records","purpose":"Populate customer details"}',
        threadId: "alice-thread-2",
        usage: null,
      },
      {
        output:
          '{"type":"final","content":"I cannot share customer records. I will build against the sanitized order schema."}',
        threadId: "alice-thread-3",
        usage: null,
      },
    ]);
    let deniedProviderCalls = 0;
    const dispatcher = new OrchestrationDispatcher(
      repository,
      directory,
      authorizer,
      runner,
      {
        resourceProvider: {
          async provide() {
            deniedProviderCalls += 1;
            return { content: "should not be called" };
          },
        },
      },
    );
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, undefined, {
      repository,
      dispatcher,
      agents: directory,
      authorizer,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/orchestrations",
      payload: {
        agentId: alice.id,
        prompt: "Build the order dashboard",
      },
    });
    expect(response.statusCode).toBe(202);
    const created = response.json() as { job: { id: string } };
    await expect.poll(() => repository.getJob(created.job.id)?.status).toBe("completed");

    const state = await app.inject({
      method: "GET",
      url: "/api/orchestrations/" + created.job.id,
    });
    const body = state.json() as {
      job: { outputText: string | null };
      runs: Array<{ agentId: string; status: string }>;
    };
    expect(body.job.outputText).toContain("sanitized order schema");
    expect(body.runs).toHaveLength(2);
    expect(body.runs.every((run) => run.status === "completed")).toBe(true);
    expect(deniedProviderCalls).toBe(0);

    const timeline = await app.inject({
      method: "GET",
      url: "/api/orchestrations/" + created.job.id + "/messages",
    });
    const messages = timeline.json().messages as Array<{ messageType: string; content: string }>;
    expect(messages.map((message) => message.messageType)).toEqual([
      "prompt",
      "delegation",
      "result",
      "tool_result",
      "tool_call",
      "tool_result",
      "result",
    ]);
    expect(messages.some((message) => message.content.includes("permission_missing"))).toBe(true);
    expect(messages.some((message) => message.content.includes("customer records"))).toBe(true);
    await app.close();
  });
});
