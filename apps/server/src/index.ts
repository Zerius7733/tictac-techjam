import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { AuthStore } from "./auth-store.js";
import { AuthStoreAuthorizer } from "./auth-authorizer.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { AgentPolicyGateway } from "./agent-policy-gateway.js";
import { PolicyStore } from "./policy-store.js";
import { createRunner } from "./runner-factory.js";
import {
  AgentStoreDirectory,
  OrchestrationDispatcher,
} from "./orchestration-dispatcher.js";
import { AllowlistedResourceProvider } from "./orchestration-resource-provider.js";
import { SqliteOrchestrationRepository } from "./orchestration-sqlite-repository.js";
import { importLegacyAgentData, SqliteAgentStore } from "./sqlite-agent-store.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { ProjectStore } from "./projects.js";
import { writeCollaborativeOutputSchema } from "./orchestration-output-schema.js";

const config = loadConfig();
await writeCodexConfig(config);
const collaborativeOutputSchemaPath = await writeCollaborativeOutputSchema(
  config.dataDirectory,
);

const authStore = new AuthStore(config.authDatabasePath);
await authStore.initialize(config.seedDevelopmentData);
const policyStore = new PolicyStore(config.authDatabasePath);
await policyStore.initialize(config.seedDevelopmentData);

const legacyStore = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
await legacyStore.initialize();
const store = new SqliteAgentStore(config.authDatabasePath);
await store.initialize();
await importLegacyAgentData(store, legacyStore);
const orchestrationRepository = new SqliteOrchestrationRepository(config.authDatabasePath);
await orchestrationRepository.initialize();
await orchestrationRepository.reconcileAfterRestart();
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const policyGateway = new AgentPolicyGateway(authStore, policyStore);
const service = new AgentService(config, store, workspaces, runner, authStore, policyGateway);
await service.initialize();

const agentDirectory = new AgentStoreDirectory(store);
const authorizer = new AuthStoreAuthorizer(authStore);
const projectStore = new ProjectStore(config.authDatabasePath, config.workspaceRoot);
await projectStore.initialize(config.seedDevelopmentData);
const dispatcher = new OrchestrationDispatcher(
  orchestrationRepository,
  agentDirectory,
  authorizer,
  runner,
  {
    resourceProvider: new AllowlistedResourceProvider(policyGateway),
    projectAccess: projectStore,
    collaborativeOutputSchemaPath,
  },
);
const app = await createApp(
  config,
  service,
  authStore,
  {
    repository: orchestrationRepository,
    dispatcher,
    agents: agentDirectory,
    authorizer,
  },
  policyGateway,
  projectStore,
);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  try {
    await app.close();
  } finally {
    store.close();
    orchestrationRepository.close();
    projectStore.close();
    policyStore.close();
    authStore.close();
  }
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
