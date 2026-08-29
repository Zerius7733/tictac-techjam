import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AuthStore } from "./auth-store.js";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import type {
  AuthContext as OrchestrationAuthContext,
  Authorizer,
  OrchestrationJob,
  OrchestrationMessage,
  OrchestrationRepository,
  OrchestrationRun,
} from "./orchestration-contracts.js";
import type {
  OrchestrationAgentDirectory,
  OrchestrationDispatcher,
} from "./orchestration-dispatcher.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const loginBody = z.object({
  username: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(256),
});
const orchestrationBody = z.object({
  agentId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(50_000),
});
const orchestrationIdParams = z.object({ id: z.string().uuid() });
const orchestrationCancelBody = z.object({
  reason: z.string().trim().min(1).max(160).optional(),
});

type ResourceType = "agent" | "run" | "orchestration" | "system";

export interface OrchestrationHttpDependencies {
  repository: OrchestrationRepository;
  dispatcher: OrchestrationDispatcher;
  agents: OrchestrationAgentDirectory;
  authorizer: Authorizer;
}

function requestPath(request: FastifyRequest): string {
  return request.url.split("?", 1)[0] ?? request.url;
}

function isRoute(request: FastifyRequest, method: string, path: string): boolean {
  return request.method === method && requestPath(request) === path;
}

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function sharedToken(request: FastifyRequest): string {
  const header = request.headers["x-app-auth-token"];
  return typeof header === "string" ? header : "";
}

function safelyEquals(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}

function agentAccess(
  request: FastifyRequest,
  authStore: AuthStore | undefined,
): { ownerUserId: string | undefined; includeAll: boolean } {
  // The no-auth mode is still useful for local service tests. Once the auth
  // store is enabled, every request is scoped to its session owner unless the
  // authenticated user has the explicit admin role.
  if (!authStore) return { ownerUserId: undefined, includeAll: true };
  return {
    ownerUserId: request.auth?.userId,
    includeAll:
      request.auth?.roleNames.some((role) => role.toLowerCase() === "admin") ?? false,
  };
}

function requirePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  authStore: AuthStore | undefined,
  action: string,
  resourceType: ResourceType,
  resourceKey: string,
): boolean {
  if (!authStore) return true;
  if (!request.auth) {
    void reply.code(401).send({ error: "Authentication required" });
    return false;
  }
  const decision = authStore.authorize(
    request.auth,
    action,
    resourceType,
    resourceKey,
  );
  if (!decision.allowed) {
    void reply.code(403).send({
      error: "Forbidden",
      reasonCode: decision.reasonCode,
      requestId: request.id,
    });
    return false;
  }
  return true;
}

function orchestrationContext(request: FastifyRequest): OrchestrationAuthContext {
  return request.auth
    ? {
        requestId: request.auth.requestId,
        userId: request.auth.userId,
        roleNames: request.auth.roleNames,
      }
    : { requestId: request.id, userId: "anonymous", roleNames: [] };
}

function isAdmin(request: FastifyRequest): boolean {
  return request.auth?.roleNames.some((role) => role.toLowerCase() === "admin") ?? false;
}

function ownsJob(job: OrchestrationJob, request: FastifyRequest): boolean {
  if (!authEnabled(request)) return true;
  return isAdmin(request) || job.userId === request.auth?.userId;
}

function authEnabled(request: FastifyRequest): boolean {
  return Boolean(request.auth);
}

function publicRun(run: OrchestrationRun) {
  return {
    id: run.id,
    jobId: run.jobId,
    agentId: run.agentId,
    parentRunId: run.parentRunId,
    attempt: run.attempt,
    status: run.status,
    outputText: run.outputText,
    errorText: run.errorText,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

function publicMessage(message: OrchestrationMessage) {
  return {
    id: message.id,
    jobId: message.jobId,
    runId: message.runId,
    sequenceNo: message.sequenceNo,
    role: message.role,
    senderKind: message.senderKind,
    senderKey: message.senderKey,
    recipientKind: message.recipientKind,
    recipientKey: message.recipientKey,
    messageType: message.messageType,
    content: message.content,
    createdAt: message.createdAt,
  };
}

async function requireOrchestrationPermission(
  request: FastifyRequest,
  reply: FastifyReply,
  authStore: AuthStore | undefined,
  orchestration: OrchestrationHttpDependencies | undefined,
  action: string,
  resourceType: string,
  resourceKey: string,
): Promise<boolean> {
  if (!authStore) return true;
  if (!request.auth) {
    await reply.code(401).send({ error: "Authentication required" });
    return false;
  }
  const decision = orchestration
    ? await orchestration.authorizer.authorize(
        orchestrationContext(request),
        action,
        resourceType,
        resourceKey,
      )
    : authStore.authorize(
        request.auth,
        action,
        resourceType as ResourceType,
        resourceKey,
      );
  if (!decision.allowed) {
    await reply.code(403).send({
      error: "Forbidden",
      reasonCode: decision.reasonCode,
      requestId: request.id,
    });
    return false;
  }
  return true;
}

export async function createApp(
  config: AppConfig,
  service: AgentService,
  authStore?: AuthStore,
  orchestration?: OrchestrationHttpDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-app-auth-token']",
      ],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
    allowedHeaders: ["Content-Type", "Authorization", "X-App-Auth-Token"],
  });

  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request, reply) => {
    const path = requestPath(request);
    if (!path.startsWith("/api/")) return;

    const isHealth = isRoute(request, "GET", "/api/health");
    const isAuthInfo = isRoute(request, "GET", "/api/auth");
    const isLogin = isRoute(request, "POST", "/api/auth/login");
    const isAccessCheck = isRoute(request, "GET", "/api/auth/access");

    if (config.authToken && !isHealth && !isAuthInfo) {
      // With database auth enabled, the shared deployment token uses its own
      // header so Authorization can carry the per-user session token.
      // Without a database store, retain the original Bearer-token behavior.
      const candidate = sharedToken(request) || (!authStore ? bearerToken(request) : "");
      if (!safelyEquals(candidate, config.authToken)) {
        return reply.code(401).send({ error: "Application access token required" });
      }
    }

    if (!authStore || isHealth) return;

    request.auth = bearerToken(request)
      ? authStore.authenticate(bearerToken(request), request.id)
      : null;

    if (!isAuthInfo && !isLogin && !isAccessCheck && !request.auth) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async (request) => ({
    required: Boolean(authStore) || config.authToken.length > 0,
    sharedTokenRequired: config.authToken.length > 0,
    loginRequired: Boolean(authStore),
    authenticated: Boolean(request.auth),
    user: request.auth
      ? {
          id: request.auth.id,
          username: request.auth.username,
          displayName: request.auth.displayName,
          roleNames: request.auth.roleNames,
        }
      : null,
  }));

  app.get("/api/auth/access", async () => ({ ok: true }));

  app.post("/api/auth/login", async (request, reply) => {
    if (!authStore) {
      return reply.code(503).send({ error: "Database authentication is not configured" });
    }
    const body = loginBody.parse(request.body);
    const result = authStore.login(body.username, body.password, request.id);
    if (!result) {
      return reply.code(401).send({ error: "Invalid username or password" });
    }
    return result;
  });

  app.get("/api/auth/me", async (request, reply) => {
    if (!request.auth) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    return { user: request.auth };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    if (!authStore || !request.auth) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    authStore.logout(request.auth);
    return { ok: true };
  });

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async (request, reply) => {
    if (!requirePermission(request, reply, authStore, "view", "agent", "*")) return;
    const access = agentAccess(request, authStore);
    return { agents: service.listAgents(access.ownerUserId, access.includeAll) };
  });

  app.post("/api/agents", async (request, reply) => {
    if (!requirePermission(request, reply, authStore, "create", "agent", "*")) return;
    const body = createAgentBody.parse(request.body);
    const access = agentAccess(request, authStore);
    const agent = await service.createAgent(body, access.ownerUserId);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    if (!requirePermission(request, reply, authStore, "view", "agent", id)) return;
    const access = agentAccess(request, authStore);
    return { agent: service.getAgent(id, access.ownerUserId, access.includeAll) };
  });

  app.patch("/api/agents/:id", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    if (!requirePermission(request, reply, authStore, "update", "agent", id)) return;
    const body = updateAgentBody.parse(request.body);
    const access = agentAccess(request, authStore);
    return {
      agent: await service.updateAgent(
        id,
        body,
        access.ownerUserId,
        access.includeAll,
      ),
    };
  });

  app.delete("/api/agents/:id", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    if (!requirePermission(request, reply, authStore, "delete", "agent", id)) return;
    const access = agentAccess(request, authStore);
    return service.deleteAgent(id, access.ownerUserId, access.includeAll);
  });

  app.post("/api/agents/:id/start", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    if (!requirePermission(request, reply, authStore, "start", "agent", id)) return;
    const access = agentAccess(request, authStore);
    return {
      agent: await service.startAgent(id, access.ownerUserId, access.includeAll),
    };
  });

  app.post("/api/agents/:id/stop", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    if (!requirePermission(request, reply, authStore, "stop", "agent", id)) return;
    const access = agentAccess(request, authStore);
    return {
      agent: await service.stopAgent(id, access.ownerUserId, access.includeAll),
    };
  });

  app.get("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    if (!requirePermission(request, reply, authStore, "view", "agent", id)) return;
    const access = agentAccess(request, authStore);
    return {
      messages: service.getMessages(id, access.ownerUserId, access.includeAll),
    };
  });

  app.get("/api/agents/:id/runs", async (request, reply) => {
    if (!requirePermission(request, reply, authStore, "view", "run", "*")) return;
    const { id } = agentIdParams.parse(request.params);
    const access = agentAccess(request, authStore);
    return { runs: service.getRuns(id, access.ownerUserId, access.includeAll) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    if (!requirePermission(request, reply, authStore, "invoke", "agent", id)) return;
    const body = messageBody.parse(request.body);
    const access = agentAccess(request, authStore);
    const result = await service.sendMessage(
      id,
      body.content,
      access.ownerUserId,
      access.includeAll,
    );
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = runIdParams.parse(request.params);
    if (!requirePermission(request, reply, authStore, "view", "run", id)) return;
    const access = agentAccess(request, authStore);
    return { run: service.getRun(id, access.ownerUserId, access.includeAll) };
  });

  app.post("/api/orchestrations", async (request, reply) => {
    if (!orchestration) {
      return reply.code(503).send({ error: "Orchestration is not configured" });
    }
    if (
      !(await requireOrchestrationPermission(
        request,
        reply,
        authStore,
        orchestration,
        "create",
        "orchestration",
        "*",
      ))
    ) {
      return;
    }
    const body = orchestrationBody.parse(request.body);
    const agent = orchestration.agents.getAgentById(body.agentId);
    if (!agent) return reply.code(404).send({ error: "Agent not found" });
    if (agent.status !== "ready") {
      return reply.code(409).send({ error: "Agent is not ready" });
    }
    if (
      !(await requireOrchestrationPermission(
        request,
        reply,
        authStore,
        orchestration,
        "invoke",
        "agent",
        agent.agentKey,
      ))
    ) {
      return;
    }
    const context = orchestrationContext(request);
    let created: Awaited<ReturnType<OrchestrationRepository["createRootJob"]>>;
    try {
      created = await orchestration.repository.createRootJob({
        requestId: context.requestId,
        userId: authStore ? context.userId : null,
        inputText: body.prompt,
        agentId: body.agentId,
        prompt: body.prompt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "Agent is not ready" || message === "Agent already has an active run") {
        return reply.code(409).send({ error: message });
      }
      throw error;
    }
    void orchestration.dispatcher
      .dispatchRoot({
        jobId: created.job.id,
        rootRunId: created.run.id,
        authContext: context,
      })
      .catch((error) => {
        request.log.error(
          { jobId: created.job.id, error: error instanceof Error ? error.message : String(error) },
          "orchestration_dispatch_unhandled_error",
        );
      });
    return reply.code(202).send({
      requestId: context.requestId,
      job: created.job,
      run: publicRun(created.run),
      message: publicMessage(created.message),
    });
  });

  app.get("/api/orchestrations/:id", async (request, reply) => {
    if (!orchestration) {
      return reply.code(503).send({ error: "Orchestration is not configured" });
    }
    const { id } = orchestrationIdParams.parse(request.params);
    const job = orchestration.repository.getJob(id);
    if (!job) return reply.code(404).send({ error: "Orchestration not found" });
    if (!(await requireOrchestrationPermission(request, reply, authStore, orchestration, "view", "orchestration", id))) return;
    if (!ownsJob(job, request)) return reply.code(404).send({ error: "Orchestration not found" });
    return {
      job,
      runs: orchestration.repository.listRuns(job.id).map(publicRun),
    };
  });

  app.get("/api/orchestrations/:id/messages", async (request, reply) => {
    if (!orchestration) {
      return reply.code(503).send({ error: "Orchestration is not configured" });
    }
    const { id } = orchestrationIdParams.parse(request.params);
    const job = orchestration.repository.getJob(id);
    if (!job) return reply.code(404).send({ error: "Orchestration not found" });
    if (!(await requireOrchestrationPermission(request, reply, authStore, orchestration, "view", "orchestration", id))) return;
    if (!ownsJob(job, request)) return reply.code(404).send({ error: "Orchestration not found" });
    return {
      messages: orchestration.repository.listMessages(job.id).map(publicMessage),
    };
  });

  app.post("/api/orchestrations/:id/cancel", async (request, reply) => {
    if (!orchestration) {
      return reply.code(503).send({ error: "Orchestration is not configured" });
    }
    const { id } = orchestrationIdParams.parse(request.params);
    const job = orchestration.repository.getJob(id);
    if (!job) return reply.code(404).send({ error: "Orchestration not found" });
    if (!(await requireOrchestrationPermission(request, reply, authStore, orchestration, "cancel", "orchestration", id))) return;
    if (!ownsJob(job, request)) return reply.code(404).send({ error: "Orchestration not found" });
    const body = orchestrationCancelBody.parse(request.body ?? {});
    const cancelled = await orchestration.dispatcher.cancelJob(id, body.reason);
    return { job: cancelled };
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}
