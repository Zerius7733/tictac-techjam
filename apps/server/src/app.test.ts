import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { AuthStore } from "./auth-store.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";
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

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("logs in through the auth database and protects agent actions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-http-auth-test-"));
    const authStore = new AuthStore(
      path.join(root, "auth.db"),
    );
    await authStore.initialize(true);
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, authStore);

    const status = await app.inject({ method: "GET", url: "/api/auth" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      required: true,
      loginRequired: true,
      authenticated: false,
    });

    const unauthenticated = await app.inject({ method: "GET", url: "/api/agents" });
    expect(unauthenticated.statusCode).toBe(401);

    const aliceLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "alice-demo-2026" },
    });
    expect(aliceLogin.statusCode).toBe(200);
    const aliceToken = aliceLogin.json().sessionToken as string;

    const aliceAgents = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer " + aliceToken },
    });
    expect(aliceAgents.statusCode).toBe(200);

    const bobLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "bob", password: "bob-demo-2026" },
    });
    expect(bobLogin.statusCode).toBe(200);
    const bobToken = bobLogin.json().sessionToken as string;

    const bobCreate = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { authorization: "Bearer " + bobToken },
      payload: { name: "Should be denied" },
    });
    expect(bobCreate.statusCode).toBe(403);

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { authorization: "Bearer " + aliceToken },
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer " + aliceToken },
    });
    expect(afterLogout.statusCode).toBe(401);

    await app.close();
    authStore.close();
    await rm(root, { recursive: true, force: true });
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("creates, polls, lists, and cancels orchestration jobs through the API", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const agent: OrchestrationAgentDescriptor = {
      id: "11111111-1111-4111-8111-111111111111",
      agentKey: "alice-frontend",
      workspacePath: "/workspace/alice",
      status: "ready",
    };
    const directory: OrchestrationAgentDirectory = {
      getAgentById: (id) => (id === agent.id ? agent : null),
      getAgentByKey: (key) => (key === agent.agentKey ? agent : null),
    };
    const dispatcher = new OrchestrationDispatcher(
      repository,
      directory,
      new RecordingAuthorizer(() => ({
        allowed: true,
        reasonCode: "permission_granted",
        auditLogId: "audit-api",
      })),
      new ScriptedAgentRunner([
        { output: '{"type":"final","content":"API complete"}', threadId: "thread-api", usage: null },
      ]),
    );
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, undefined, {
      repository,
      dispatcher,
      agents: directory,
      authorizer: new RecordingAuthorizer(() => ({
        allowed: true,
        reasonCode: "permission_granted",
        auditLogId: "audit-api",
      })),
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/orchestrations",
      payload: { agentId: agent.id, prompt: "Build it" },
    });
    expect(created.statusCode).toBe(202);
    const createdBody = created.json() as { job: { id: string }; run: { id: string } };

    await expect.poll(() => repository.getJob(createdBody.job.id)?.status).toBe("completed");
    const state = await app.inject({
      method: "GET",
      url: "/api/orchestrations/" + createdBody.job.id,
    });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ job: { status: "completed" }, runs: [{ id: createdBody.run.id, status: "completed" }] });

    const timeline = await app.inject({
      method: "GET",
      url: "/api/orchestrations/" + createdBody.job.id + "/messages",
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json().messages).toHaveLength(2);

    const cancellableRepository = new InMemoryOrchestrationRepository();
    let releasePending!: (result: { output: string; threadId: string; usage: null }) => void;
    const cancellableRunner = new ScriptedAgentRunner([
      () => new Promise((resolve) => {
        releasePending = resolve;
      }),
    ]);
    const cancellableDispatcher = new OrchestrationDispatcher(
      cancellableRepository,
      directory,
      new RecordingAuthorizer(() => ({
        allowed: true,
        reasonCode: "permission_granted",
        auditLogId: "audit-cancel-api",
      })),
      cancellableRunner,
      { runTimeoutMs: null, jobTimeoutMs: null },
    );
    const cancelApp = await createApp(loadConfig({ NODE_ENV: "test" }), service, undefined, {
      repository: cancellableRepository,
      dispatcher: cancellableDispatcher,
      agents: directory,
      authorizer: new RecordingAuthorizer(() => ({
        allowed: true,
        reasonCode: "permission_granted",
        auditLogId: "audit-cancel-api",
      })),
    });
    const pending = await cancelApp.inject({
      method: "POST",
      url: "/api/orchestrations",
      payload: { agentId: agent.id, prompt: "Cancel it" },
    });
    const pendingJobId = (pending.json() as { job: { id: string } }).job.id;
    await expect.poll(() => cancellableRunner.requests.length).toBe(1);
    const cancelled = await cancelApp.inject({
      method: "POST",
      url: "/api/orchestrations/" + pendingJobId + "/cancel",
      payload: { reason: "test_cancel" },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ job: { status: "cancelled" } });
    releasePending({
      output: '{"type":"final","content":"Cancelled"}',
      threadId: "cancelled-thread",
      usage: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await app.close();
    await cancelApp.close();
  });
});
