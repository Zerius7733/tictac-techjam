import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { AuthStore } from "./auth-store.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { AgentPolicyGateway } from "./agent-policy-gateway.js";
import { PolicyStore } from "./policy-store.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const authStore = new AuthStore(config.authDatabasePath);
await authStore.initialize(config.nodeEnv !== "production");
const policyStore = new PolicyStore(config.authDatabasePath);
await policyStore.initialize(config.nodeEnv !== "production");

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const policyGateway = new AgentPolicyGateway(authStore, policyStore);
const service = new AgentService(config, store, workspaces, runner, authStore, policyGateway);
await service.initialize();
const app = await createApp(config, service, authStore, policyGateway);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  try {
    await app.close();
  } finally {
    policyStore.close();
    authStore.close();
  }
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
