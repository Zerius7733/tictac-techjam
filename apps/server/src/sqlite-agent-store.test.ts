import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { AuthStore } from "./auth-store.js";
import { loadConfig } from "./config.js";
import {
  importLegacyAgentData,
  SqliteAgentStore,
} from "./sqlite-agent-store.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const authMigration = path.join(repositoryRoot, "db/migrations/001_authentication.sql");
const temporaryDirectories: string[] = [];
const openStores = new Set<SqliteAgentStore>();
const openAuthStores = new Set<AuthStore>();

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: "thread-" + request.runId,
      usage: { inputTokens: 3, outputTokens: 2 },
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

afterEach(async () => {
  for (const store of openStores) store.close();
  openStores.clear();
  for (const authStore of openAuthStores) authStore.close();
  openAuthStores.clear();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function seedAuthDatabase(databasePath: string): Promise<void> {
  await mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(await readFile(authMigration, "utf8"));
  database.close();
}

function makeConfig(root: string) {
  return loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
}

describe("SqliteAgentStore", () => {
  it("seeds the default demo Agents in the combined SQLite database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-sqlite-default-agents-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "data", "launchpad.db");
    const authStore = new AuthStore(databasePath);
    openAuthStores.add(authStore);
    await authStore.initialize(true);

    const config = loadConfig({
      NODE_ENV: "test",
      SEED_DEVELOPMENT_DATA: "true",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const store = new SqliteAgentStore(databasePath);
    openStores.add(store);
    const service = new AgentService(
      config,
      store,
      new WorkspaceManager(config.workspaceRoot),
      new FakeRunner(),
      authStore,
    );
    await service.initialize();

    const alice = store.getAgentByKey("alice-frontend");
    const bob = store.getAgentByKey("bob-backend");
    expect(alice).toMatchObject({
      name: "Alice Frontend",
      ownerUserId: "22222222-2222-4222-8222-111111111111",
      status: "ready",
    });
    expect(bob).toMatchObject({
      name: "Bob Backend",
      ownerUserId: "22222222-2222-4222-8222-222222222222",
      status: "ready",
    });
    expect(
      await readFile(path.join(config.workspaceRoot, alice!.id, "AGENTS.md"), "utf8"),
    ).toContain("frontend-design-system");
  });

  it("shares the combined database with AuthStore and preserves Agent principals", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-sqlite-auth-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "data", "launchpad.db");
    const authStore = new AuthStore(databasePath);
    openAuthStores.add(authStore);
    await authStore.initialize(true);

    const config = makeConfig(root);
    const store = new SqliteAgentStore(databasePath);
    openStores.add(store);
    const service = new AgentService(
      config,
      store,
      new WorkspaceManager(config.workspaceRoot),
      new FakeRunner(),
      authStore,
    );
    await service.initialize();
    const user = authStore.login("alice", "alice-demo-2026", "request-auth");
    expect(user).not.toBeNull();
    const agent = await service.createAgent({ name: "Auth-backed Agent" }, user!.user.id);

    expect(agent.principalId).toEqual(expect.any(String));
    expect(authStore.getAgentPrincipal(agent.id)).toMatchObject({
      id: agent.principalId,
      agentId: agent.id,
      ownerUserId: user!.user.id,
      status: "active",
    });
    expect(store.snapshot().agents[0]).toMatchObject({
      id: agent.id,
      ownerUserId: user!.user.id,
    });
    expect(store.getAgentByKey("auth-backed-agent")).toMatchObject({
      id: agent.id,
      agentKey: "auth-backed-agent",
      status: "ready",
    });
  });

  it("imports legacy JSON only when the SQLite database is empty", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-sqlite-import-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "data", "launchpad.db");
    await seedAuthDatabase(databasePath);

    const legacy = new JsonStore(path.join(root, "data", "launchpad.json"));
    await legacy.initialize();
    await legacy.mutate((database) => {
      database.agents.push({
        id: "legacy-agent",
        agentKey: "legacy-legacy-agent",
        ownerUserId: null,
        principalId: null,
        name: "Imported Agent",
        description: "",
        instructions: "",
        status: "ready",
        workspacePath: path.join(root, "workspace"),
        codexThreadId: "legacy-thread",
        lastError: null,
        createdAt: "2026-08-29T00:00:00.000Z",
        updatedAt: "2026-08-29T00:00:00.000Z",
      });
      database.runs.push({
        id: "legacy-run",
        agentId: "legacy-agent",
        codexThreadId: "legacy-thread",
        status: "completed",
        prompt: "Legacy prompt",
        output: "Legacy output",
        error: null,
        usage: null,
        startedAt: "2026-08-29T00:00:01.000Z",
        completedAt: "2026-08-29T00:00:02.000Z",
        createdAt: "2026-08-29T00:00:00.000Z",
      });
      database.messages.push({
        id: "legacy-message",
        agentId: "legacy-agent",
        runId: "legacy-run",
        role: "user",
        content: "Legacy prompt",
        createdAt: "2026-08-29T00:00:00.000Z",
      });
    });

    const target = new SqliteAgentStore(databasePath);
    openStores.add(target);
    await target.initialize();
    await expect(importLegacyAgentData(target, legacy)).resolves.toBe(true);
    expect(target.snapshot()).toMatchObject({
      agents: [{ id: "legacy-agent", name: "Imported Agent" }],
      runs: [{ id: "legacy-run", status: "completed" }],
      messages: [{ id: "legacy-message", content: "Legacy prompt" }],
    });
    expect(target.getAgentById("legacy-agent")).toMatchObject({
      agentKey: "legacy-legacy-agent",
      workspacePath: path.join(root, "workspace"),
    });

    await legacy.mutate((database) => {
      database.agents[0]!.name = "Should not overwrite";
    });
    await expect(importLegacyAgentData(target, legacy)).resolves.toBe(false);
    expect(target.snapshot().agents[0]?.name).toBe("Imported Agent");
  });

  it("keeps the legacy AgentService API durable across store instances", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-sqlite-agent-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "data", "launchpad.db");
    await seedAuthDatabase(databasePath);

    const config = makeConfig(root);
    const firstStore = new SqliteAgentStore(databasePath);
    openStores.add(firstStore);
    const firstService = new AgentService(
      config,
      firstStore,
      new WorkspaceManager(config.workspaceRoot),
      new FakeRunner(),
    );
    await firstService.initialize();
    const agent = await firstService.createAgent({ name: "Durable Agent" });
    const accepted = await firstService.sendMessage(agent.id, "persist this");
    await expect
      .poll(() => firstService.getRun(accepted.run.id).status)
      .toBe("completed");
    firstStore.close();

    const secondStore = new SqliteAgentStore(databasePath);
    openStores.add(secondStore);
    const secondService = new AgentService(
      config,
      secondStore,
      new WorkspaceManager(config.workspaceRoot),
      new FakeRunner(),
    );
    await secondService.initialize();

    expect(secondService.getAgent(agent.id)).toMatchObject({
      id: agent.id,
      name: "Durable Agent",
      status: "ready",
    });
    expect(secondService.getRuns(agent.id)).toMatchObject([
      {
        id: accepted.run.id,
        status: "completed",
        codexThreadId: "thread-" + accepted.run.id,
        usage: { inputTokens: 3, outputTokens: 2 },
      },
    ]);
    expect(secondService.getMessages(agent.id).map((message) => message.content)).toEqual([
      "persist this",
      "Completed: persist this",
    ]);
  });

  it("preserves archived Agent history in SQLite", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-sqlite-archive-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "data", "launchpad.db");
    await seedAuthDatabase(databasePath);

    const config = makeConfig(root);
    const store = new SqliteAgentStore(databasePath);
    openStores.add(store);
    const service = new AgentService(
      config,
      store,
      new WorkspaceManager(config.workspaceRoot),
      new FakeRunner(),
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "Archive me" });
    const accepted = await service.sendMessage(agent.id, "keep this history");
    await expect.poll(() => service.getRun(accepted.run.id).status).toBe("completed");

    await service.deleteAgent(agent.id);

    expect(store.snapshot().agents).toMatchObject([{ id: agent.id, status: "archived" }]);
    expect(service.getRuns(agent.id)).toHaveLength(1);
    expect(service.getMessages(agent.id)).toHaveLength(2);
  });
});
