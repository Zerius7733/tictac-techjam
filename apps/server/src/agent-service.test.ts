import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { AuthStore } from "./auth-store.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates a separate active principal for an authenticated Agent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-principal-test-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const authStore = new AuthStore(path.join(root, "data", "auth.db"));
    await authStore.initialize(true);
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
      authStore,
    );
    await service.initialize();

    const alice = authStore.login("alice", "alice-demo-2026", "request-login");
    const agent = await service.createAgent({ name: "Alice Principal Agent" }, alice!.user.id);
    const principal = authStore.getAgentPrincipal(agent.id);

    expect(agent.principalId).toEqual(expect.any(String));
    expect(principal).toMatchObject({
      id: agent.principalId,
      agentId: agent.id,
      ownerUserId: alice!.user.id,
      status: "active",
    });
    expect(principal!.id).not.toBe(alice!.user.id);

    authStore.revokeAgentPrincipal(agent.id);
    expect(() => service.getAgent(agent.id, alice!.user.id)).toThrowError(
      expect.objectContaining({ statusCode: 404 }),
    );
    authStore.close();
  });

  it("scopes Agents to their owner while allowing admins to see all", async () => {
    const service = await makeService();
    const aliceId = "alice-user-id";
    const bobId = "bob-user-id";
    const aliceAgent = await service.createAgent({ name: "Alice Agent" }, aliceId);
    const bobAgent = await service.createAgent({ name: "Bob Agent" }, bobId);

    expect(service.listAgents(aliceId).map((agent) => agent.id)).toEqual([aliceAgent.id]);
    expect(service.listAgents(bobId).map((agent) => agent.id)).toEqual([bobAgent.id]);
    expect(service.listAgents(aliceId, true)).toHaveLength(2);
    expect(() => service.getAgent(aliceAgent.id, bobId)).toThrowError(
      expect.objectContaining({ statusCode: 404 }),
    );
    await expect(service.updateAgent(aliceAgent.id, { name: "Hijacked" }, bobId))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("archives an Agent without deleting its conversation history", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Historical" });
    const { run } = await service.sendMessage(agent.id, "preserve this");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    await service.deleteAgent(agent.id);

    expect(service.listAgents()).toHaveLength(0);
    expect(service.getAgent(agent.id).status).toBe("archived");
    expect(service.getRuns(agent.id)).toHaveLength(1);
    expect(service.getMessages(agent.id)).toHaveLength(2);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("does not inherit the legacy Agent thread across runs", async () => {
    const requests: RunnerRequest[] = [];
    const service = await makeService({
      run: async (request) => {
        requests.push(request);
        return {
          output: "done",
          threadId: requests.length === 1 ? "thread-one" : "thread-two",
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Isolated" });

    const first = await service.sendMessage(agent.id, "first");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    const second = await service.sendMessage(agent.id, "second");
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");

    expect(requests.map((request) => request.threadId)).toEqual([null, null]);
    expect(requests.map((request) => request.runId)).toEqual([
      first.run.id,
      second.run.id,
    ]);
    expect(service.getRun(first.run.id).codexThreadId).toBe("thread-one");
    expect(service.getRun(second.run.id).codexThreadId).toBe("thread-two");
    expect(service.getAgent(agent.id).codexThreadId).toBe("thread-two");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});
