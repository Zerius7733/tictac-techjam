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
import { AgentPolicyGateway } from "./agent-policy-gateway.js";
import { AuthStore } from "./auth-store.js";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const capabilityParams = z.object({
  id: z.string().uuid(),
  capabilityId: z.string().uuid(),
});
const approvalParams = z.object({
  id: z.string().uuid(),
  approvalId: z.string().uuid(),
});
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
const capabilityBody = z.object({
  resourceType: z.string().trim().min(1).max(80),
  resourceKey: z.string().trim().min(1).max(160),
  action: z.enum(["read", "write"]),
  expiresInSeconds: z.number().int().min(60).max(86_400).default(3_600),
});
const toolCallBody = z.object({
  resourceType: z.string().trim().min(1).max(80),
  resourceKey: z.string().trim().min(1).max(160),
  action: z.enum(["read", "write"]),
  inputText: z.string().max(10_000).optional(),
});
const credentialParams = z.object({
  id: z.string().uuid(),
  credentialId: z.string().uuid(),
});
const credentialBody = z.object({
  expiresInSeconds: z.number().int().min(60).max(86_400).default(3_600),
});

type ResourceType = "agent" | "run" | "orchestration" | "system";

function requestPath(request: FastifyRequest): string {
  return request.url.split("?", 1)[0] ?? request.url;
}

function isRoute(request: FastifyRequest, method: string, path: string): boolean {
  return request.method === method && requestPath(request) === path;
}

function isAgentConversation(request: FastifyRequest): boolean {
  return (
    request.method === "POST" &&
    /^\/api\/agents\/[^/]+\/messages$/.test(requestPath(request))
  );
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

export async function createApp(
  config: AppConfig,
  service: AgentService,
  authStore?: AuthStore,
  policyGateway?: AgentPolicyGateway,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-app-auth-token']",
        "req.headers['x-agent-principal-token']",
      ],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-App-Auth-Token",
        "X-Agent-Principal-Token",
      ],
  });

  app.decorateRequest("auth", null);
  app.decorateRequest("agentAuth", null);
  app.addHook("onRequest", async (request, reply) => {
    const path = requestPath(request);
    if (!path.startsWith("/api/")) return;

    const isHealth = isRoute(request, "GET", "/api/health");
    const isAuthInfo = isRoute(request, "GET", "/api/auth");
    const isLogin = isRoute(request, "POST", "/api/auth/login");
    const isAccessCheck = isRoute(request, "GET", "/api/auth/access");
    const isAgentToolCall = isRoute(request, "POST", "/api/agent/tool-calls");
    const isConversation = isAgentConversation(request);

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

    if (isAgentToolCall) {
      const token = request.headers["x-agent-principal-token"];
      request.agentAuth =
        typeof token === "string"
          ? authStore.authenticateAgentCredential(token, request.id)
          : null;
      if (!request.agentAuth) {
        return reply.code(401).send({ error: "Valid Agent principal token required" });
      }
      return;
    }

    request.auth = bearerToken(request)
      ? authStore.authenticate(bearerToken(request), request.id)
      : null;

    if (isConversation) {
      const token = request.headers["x-agent-principal-token"];
      if (typeof token === "string" && token.trim()) {
        request.agentAuth = authStore.authenticateAgentCredential(token, request.id);
        if (!request.agentAuth) {
          return reply.code(401).send({ error: "Valid Agent principal token required" });
        }
      }
    }

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
      request.agentAuth ?? undefined,
    );
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = runIdParams.parse(request.params);
    if (!requirePermission(request, reply, authStore, "view", "run", id)) return;
    const access = agentAccess(request, authStore);
    return { run: service.getRun(id, access.ownerUserId, access.includeAll) };
  });

  app.get("/api/security/mock-resources", async (request, reply) => {
    if (!policyGateway || !request.auth) {
      return reply.code(503).send({ error: "Agent policy is not configured" });
    }
    if (!requirePermission(request, reply, authStore, "view", "orchestration", "*")) {
      return;
    }
    return { resources: policyGateway.listResources(request.auth) };
  });

  app.get("/api/agents/:id/capabilities", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    if (!requirePermission(request, reply, authStore, "view", "agent", id)) return;
    if (!policyGateway || !request.auth) {
      return reply.code(503).send({ error: "Agent policy is not configured" });
    }
    const access = agentAccess(request, authStore);
    const agent = service.getAgent(id, access.ownerUserId, access.includeAll);
    return { capabilities: policyGateway.listCapabilities(agent) };
  });

  app.post("/api/agents/:id/capabilities", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    if (!policyGateway || !request.auth) {
      return reply.code(503).send({ error: "Agent policy is not configured" });
    }
    const access = agentAccess(request, authStore);
    const agent = service.getAgent(id, access.ownerUserId, access.includeAll);
    const body = capabilityBody.parse(request.body);
    const capability = policyGateway.grantCapability(request.auth, agent, body);
    return reply.code(201).send({ capability });
  });

  app.get("/api/agents/:id/credentials", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    if (!requirePermission(request, reply, authStore, "view", "agent", id)) return;
    if (!authStore || !request.auth) {
      return reply.code(503).send({ error: "Database authentication is not configured" });
    }
    const access = agentAccess(request, authStore);
    service.getAgent(id, access.ownerUserId, access.includeAll);
    return { credentials: authStore.listAgentCredentials(id) };
  });

  app.post("/api/agents/:id/credentials", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    if (!requirePermission(request, reply, authStore, "delegate", "agent", id)) return;
    if (!authStore || !request.auth) {
      return reply.code(503).send({ error: "Database authentication is not configured" });
    }
    service.getAgent(id, request.auth.userId, false);
    const body = credentialBody.parse(request.body);
    const credential = authStore.issueAgentCredential(
      id,
      request.auth.userId,
      body.expiresInSeconds,
    );
    return reply.code(201).send({ credential });
  });

  app.post("/api/agents/:id/credentials/:credentialId/revoke", async (request, reply) => {
    const { id, credentialId } = credentialParams.parse(request.params);
    if (!requirePermission(request, reply, authStore, "delegate", "agent", id)) return;
    if (!authStore || !request.auth) {
      return reply.code(503).send({ error: "Database authentication is not configured" });
    }
    service.getAgent(id, request.auth.userId, false);
    const credential = authStore.revokeAgentCredential(credentialId, id);
    if (!credential) return reply.code(404).send({ error: "Agent credential not found" });
    return { credential };
  });

  app.post("/api/agents/:id/capabilities/:capabilityId/revoke", async (request, reply) => {
    const { id, capabilityId } = capabilityParams.parse(request.params);
    if (!policyGateway || !request.auth) {
      return reply.code(503).send({ error: "Agent policy is not configured" });
    }
    const access = agentAccess(request, authStore);
    const agent = service.getAgent(id, access.ownerUserId, access.includeAll);
    const capability = policyGateway.revokeCapability(request.auth, agent, capabilityId);
    return { capability };
  });

  app.post("/api/agents/:id/tool-calls", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    if (!policyGateway || !request.auth) {
      return reply.code(503).send({ error: "Agent policy is not configured" });
    }
    const access = agentAccess(request, authStore);
    const agent = service.getAgent(id, access.ownerUserId, access.includeAll);
    const body = toolCallBody.parse(request.body);
    const result = policyGateway.execute(request.auth, agent, body);
    if (!result.allowed) {
      return reply.code(403).send({
        error:
          result.status === "approval_required"
            ? "Approval required"
            : "Agent action denied",
        ...result,
      });
    }
    return result;
  });

  app.post("/api/agent/tool-calls", async (request, reply) => {
    if (!policyGateway || !request.agentAuth) {
      return reply.code(503).send({ error: "Agent policy is not configured" });
    }
    const body = toolCallBody.parse(request.body);
    const agent = service.getAgent(request.agentAuth.agentId, request.agentAuth.ownerUserId, false);
    const result = policyGateway.executeAsAgent(request.agentAuth, agent, body);
    if (!result.allowed) {
      return reply.code(403).send({
        error:
          result.status === "approval_required"
            ? "Approval required"
            : "Agent action denied",
        ...result,
      });
    }
    return result;
  });

  app.get("/api/agents/:id/approvals", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    if (!requirePermission(request, reply, authStore, "view", "agent", id)) return;
    if (!policyGateway || !request.auth) {
      return reply.code(503).send({ error: "Agent policy is not configured" });
    }
    const access = agentAccess(request, authStore);
    const agent = service.getAgent(id, access.ownerUserId, access.includeAll);
    return { approvals: policyGateway.listApprovals(agent) };
  });

  app.post("/api/agents/:id/approvals/:approvalId/approve", async (request, reply) => {
    const { id, approvalId } = approvalParams.parse(request.params);
    if (!policyGateway || !request.auth) {
      return reply.code(503).send({ error: "Agent policy is not configured" });
    }
    const access = agentAccess(request, authStore);
    const agent = service.getAgent(id, access.ownerUserId, access.includeAll);
    const approval = policyGateway.decideApproval(
      request.auth,
      agent,
      approvalId,
      "approved",
    );
    return { approval };
  });

  app.post("/api/agents/:id/approvals/:approvalId/deny", async (request, reply) => {
    const { id, approvalId } = approvalParams.parse(request.params);
    if (!policyGateway || !request.auth) {
      return reply.code(503).send({ error: "Agent policy is not configured" });
    }
    const access = agentAccess(request, authStore);
    const agent = service.getAgent(id, access.ownerUserId, access.includeAll);
    const approval = policyGateway.decideApproval(
      request.auth,
      agent,
      approvalId,
      "denied",
    );
    return { approval };
  });

  app.get("/api/agents/:id/action-logs", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    if (!requirePermission(request, reply, authStore, "view", "agent", id)) return;
    if (!policyGateway || !request.auth) {
      return reply.code(503).send({ error: "Agent policy is not configured" });
    }
    const access = agentAccess(request, authStore);
    const agent = service.getAgent(id, access.ownerUserId, access.includeAll);
    return { actions: policyGateway.listActionLogs(agent) };
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
