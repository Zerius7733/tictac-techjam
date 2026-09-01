import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { AuthStore } from "./auth-store.js";
import { loadConfig } from "./config.js";
import { ProjectStore } from "./projects.js";
import { SqliteAgentStore } from "./sqlite-agent-store.js";
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
  it("redirects the development server root to the Vite web app", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "development" }), service);

    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("http://localhost:5173/");
    await app.close();
  });

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

    const bobAgents = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer " + bobToken },
    });
    expect(bobAgents.statusCode).toBe(200);

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

  it("authenticates a browser session from the http-only cookie after reload", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-http-cookie-test-"));
    const authStore = new AuthStore(path.join(root, "auth.db"));
    await authStore.initialize(true);
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, authStore);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "alice-demo-2026" },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers["set-cookie"];
    expect(setCookie).toEqual(expect.stringContaining("launchpad_session="));
    expect(setCookie).toEqual(expect.stringContaining("HttpOnly"));

    const cookie = setCookie!.split(";", 1)[0];
    const afterReload = await app.inject({
      method: "GET",
      url: "/api/auth",
      headers: { cookie },
    });
    expect(afterReload.statusCode).toBe(200);
    expect(afterReload.json()).toMatchObject({
      authenticated: true,
      user: { username: "alice" },
    });

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("launchpad_session=;"),
        expect.stringContaining("launchpad_app_access=;"),
      ]),
    );

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
    const createdBody = created.json() as {
      job: { id: string };
      run: { id: string };
      message: { payload: Record<string, unknown> };
    };
    expect(createdBody.message.payload).toEqual({});

    await expect.poll(() => repository.getJob(createdBody.job.id)?.status).toBe("completed");
    const state = await app.inject({
      method: "GET",
      url: "/api/orchestrations/" + createdBody.job.id,
    });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({
      job: { status: "completed" },
      runs: [
        {
          id: createdBody.run.id,
          status: "completed",
          outputJson: { type: "final", content: "API complete" },
          codexThreadId: "thread-api",
        },
      ],
    });

    const timeline = await app.inject({
      method: "GET",
      url: "/api/orchestrations/" + createdBody.job.id + "/messages",
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json().messages).toHaveLength(2);
    expect(timeline.json().messages[1]).toMatchObject({
      messageType: "result",
      payload: { type: "final", content: "API complete" },
    });

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

  it("uses unique persisted orchestration request IDs across server restarts", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const agent: OrchestrationAgentDescriptor = {
      id: "22222222-2222-4222-8222-222222222222",
      agentKey: "restart-safe-agent",
      workspacePath: "/workspace/restart-safe-agent",
      status: "ready",
    };
    const directory: OrchestrationAgentDirectory = {
      getAgentById: (id) => (id === agent.id ? agent : null),
      getAgentByKey: (key) => (key === agent.agentKey ? agent : null),
    };
    const authorizer = new RecordingAuthorizer(() => ({
      allowed: true,
      reasonCode: "permission_granted",
      auditLogId: "audit-restart-safe",
    }));
    const makeApp = (threadId: string) =>
      createApp(loadConfig({ NODE_ENV: "test" }), service, undefined, {
        repository,
        dispatcher: new OrchestrationDispatcher(
          repository,
          directory,
          authorizer,
          new ScriptedAgentRunner([
            { output: '{"type":"final","content":"done"}', threadId, usage: null },
          ]),
        ),
        agents: directory,
        authorizer,
      });

    const firstApp = await makeApp("thread-restart-1");
    const first = await firstApp.inject({
      method: "POST",
      url: "/api/orchestrations",
      payload: { agentId: agent.id, prompt: "First job" },
    });
    expect(first.statusCode).toBe(202);
    const firstBody = first.json() as { job: { id: string; requestId: string } };
    await expect.poll(() => repository.getJob(firstBody.job.id)?.status).toBe("completed");
    await firstApp.close();

    // A new Fastify instance starts its request counter at req-1 again. The
    // persisted orchestration ID must not reuse that short HTTP identifier.
    const secondApp = await makeApp("thread-restart-2");
    const second = await secondApp.inject({
      method: "POST",
      url: "/api/orchestrations",
      payload: { agentId: agent.id, prompt: "Second job" },
    });
    expect(second.statusCode).toBe(202);
    const secondBody = second.json() as { job: { id: string; requestId: string } };
    expect(secondBody.job.requestId).not.toBe(firstBody.job.requestId);
    expect(secondBody.job.requestId).toMatch(/^orchestration:req-1:/);
    await expect.poll(() => repository.getJob(secondBody.job.id)?.status).toBe("completed");
    await secondApp.close();
  });

  it("resolves a project's orchestrator when no root Agent is submitted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-http-project-orchestrator-test-"));
    const databasePath = path.join(root, "auth.db");
    const authStore = new AuthStore(databasePath);
    const agentStore = new SqliteAgentStore(databasePath);
    const projectStore = new ProjectStore(databasePath, path.join(root, "workspaces"));
    const repository = new InMemoryOrchestrationRepository();
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      await authStore.initialize(true);
      await agentStore.initialize();
      await projectStore.initialize(true);
      const login = authStore.login("alice", "alice-demo-2026", "project-orchestrator-test");
      expect(login).not.toBeNull();
      const project = projectStore.listProjects(login!.user.id)[0]!;
      const orchestrator = projectStore.getOrchestrator(project.id, login!.user.id);
      const directory: OrchestrationAgentDirectory = {
        getAgentById: (id) => (id === orchestrator.id ? orchestrator : null),
        getAgentByKey: (key) => (key === orchestrator.agentKey ? orchestrator : null),
      };
      const dispatcher = new OrchestrationDispatcher(
        repository,
        directory,
        new RecordingAuthorizer(() => ({
          allowed: true,
          reasonCode: "permission_granted",
          auditLogId: "audit-project-orchestrator",
        })),
        new ScriptedAgentRunner([
          {
            output:
              '{"type":"final","summary":"Completed the project task.","content":"Project orchestrator completed the task.","targetAgentKey":null,"task":null,"action":null,"resourceType":null,"resourceKey":null,"purpose":null}',
            threadId: "project-orchestrator-thread",
            usage: null,
          },
        ]),
        {
          projectAccess: projectStore,
          collaborativeOutputSchemaPath: "/tmp/orchestration-output.schema.json",
        },
      );
      app = await createApp(
        loadConfig({ NODE_ENV: "test" }),
        service,
        authStore,
        {
          repository,
          dispatcher,
          agents: directory,
          authorizer: new RecordingAuthorizer(() => ({
            allowed: true,
            reasonCode: "permission_granted",
            auditLogId: "audit-project-orchestrator",
          })),
        },
        undefined,
        projectStore,
      );

      const created = await app.inject({
        method: "POST",
        url: "/api/orchestrations",
        headers: { authorization: "Bearer " + login!.sessionToken },
        payload: { projectId: project.id, prompt: "Coordinate the project task" },
      });
      expect(created.statusCode).toBe(202);
      const createdBody = created.json() as {
        job: { id: string };
        run: { agentId: string };
      };
      expect(createdBody.run.agentId).toBe(orchestrator.id);
      await expect.poll(() => repository.getJob(createdBody.job.id)?.status).toBe("completed");
      expect(repository.getJob(createdBody.job.id)?.outputText).toBe(
        "Project orchestrator completed the task.",
      );
    } finally {
      await app?.close();
      projectStore.close();
      agentStore.close();
      authStore.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
