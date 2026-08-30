import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPolicyGateway } from "./agent-policy-gateway.js";
import { AuthStore } from "./auth-store.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PolicyStore } from "./policy-store.js";
import type { AgentService } from "./agent-service.js";
import type { Agent } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Agent policy HTTP boundary", () => {
  it("keeps Agent credentials separate from the human session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-policy-http-test-"));
    temporaryDirectories.push(root);
    const authStore = new AuthStore(path.join(root, "auth.db"));
    const policyStore = new PolicyStore(path.join(root, "auth.db"));
    await authStore.initialize(true);
    await policyStore.initialize(true);

    const login = authStore.login("alice", "alice-demo-2026", "request-login");
    const principal = authStore.createAgentPrincipal(randomUUID(), login!.user.id);
    const agent: Agent = {
      id: principal.agentId,
      ownerUserId: login!.user.id,
      principalId: principal.id,
      name: "Alice HTTP Policy Agent",
      description: "",
      instructions: "",
      status: "ready",
      workspacePath: path.join(root, "workspace"),
      codexThreadId: null,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    let conversationArgs: unknown[] | null = null;
    const service = {
      getAgent: (id: string) => {
        if (id !== agent.id) throw new Error("Agent not found");
        return agent;
      },
      sendMessage: async (...args: unknown[]) => {
        conversationArgs = args;
        return { run: {}, message: {} };
      },
    } as unknown as AgentService;
    const policyGateway = new AgentPolicyGateway(authStore, policyStore);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      authStore,
      policyGateway,
    );

    try {
      const sessionToken = login!.sessionToken;
      const resources = await app.inject({
        method: "GET",
        url: "/api/security/mock-resources",
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      expect(resources.statusCode).toBe(200);
      expect(resources.json().resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resourceType: "data_asset",
            resourceKey: "order-schema",
            sensitivity: "shared",
          }),
        ]),
      );
      expect(resources.json().resources).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ resourceKey: "customer-records" }),
        ]),
      );
      expect(resources.json().resources[0]).not.toHaveProperty("value");

      const credentialResponse = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/credentials`,
        headers: { authorization: `Bearer ${sessionToken}` },
        payload: { expiresInSeconds: 3_600 },
      });
      expect(credentialResponse.statusCode).toBe(201);
      const credential = credentialResponse.json().credential as {
        id: string;
        token: string;
      };
      expect(credential.token).toMatch(/^agt_/);

      const orderSchemaGrant = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/capabilities`,
        headers: { authorization: `Bearer ${sessionToken}` },
        payload: {
          action: "read",
          resourceType: "data_asset",
          resourceKey: "order-schema",
          expiresInSeconds: 3_600,
        },
      });
      expect(orderSchemaGrant.statusCode).toBe(201);

      const orderSchemaRead = await app.inject({
        method: "POST",
        url: "/api/agent/tool-calls",
        headers: { "x-agent-principal-token": credential.token },
        payload: {
          action: "read",
          resourceType: "data_asset",
          resourceKey: "order-schema",
        },
      });
      expect(orderSchemaRead.statusCode).toBe(200);
      expect(orderSchemaRead.json()).toMatchObject({
        status: "allowed",
        resource: { resourceType: "data_asset", resourceKey: "order-schema" },
      });

      const customerRecordsRead = await app.inject({
        method: "POST",
        url: "/api/agent/tool-calls",
        headers: { "x-agent-principal-token": credential.token },
        payload: {
          action: "read",
          resourceType: "data_asset",
          resourceKey: "customer-records",
        },
      });
      expect(customerRecordsRead.statusCode).toBe(403);
      expect(customerRecordsRead.json()).toMatchObject({
        reasonCode: "resource_owner_mismatch",
      });

      const beforeGrant = await app.inject({
        method: "POST",
        url: "/api/agent/tool-calls",
        headers: { "x-agent-principal-token": credential.token },
        payload: {
          action: "read",
          resourceType: "mock_record",
          resourceKey: "alice-private-note",
        },
      });
      expect(beforeGrant.statusCode).toBe(403);
      expect(beforeGrant.json()).toMatchObject({ reasonCode: "capability_not_granted" });

      const grant = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/capabilities`,
        headers: { authorization: `Bearer ${sessionToken}` },
        payload: {
          action: "read",
          resourceType: "mock_record",
          resourceKey: "alice-private-note",
          expiresInSeconds: 3_600,
        },
      });
      expect(grant.statusCode).toBe(201);

      const allowed = await app.inject({
        method: "POST",
        url: "/api/agent/tool-calls",
        headers: { "x-agent-principal-token": credential.token },
        payload: {
          action: "read",
          resourceType: "mock_record",
          resourceKey: "alice-private-note",
        },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toMatchObject({
        status: "allowed",
        resource: { resourceKey: "alice-private-note" },
      });

      const conversation = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/messages`,
        headers: {
          authorization: `Bearer ${sessionToken}`,
          "x-agent-principal-token": credential.token,
        },
        payload: { content: "read Alice's private notes", mode: "protected-data" },
      });
      expect(conversation.statusCode).toBe(202);
      expect(conversationArgs?.[0]).toBe(agent.id);
      expect(conversationArgs?.[1]).toBe("read Alice's private notes");
      expect(conversationArgs?.[5]).toBe("protected-data");
      expect(conversationArgs?.[6]).toMatchObject({ username: "alice" });
      expect(conversationArgs?.[4]).toMatchObject({
        agentId: agent.id,
        principalId: principal.id,
        ownerUserId: login!.user.id,
      });

      const revoked = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/credentials/${credential.id}/revoke`,
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      expect(revoked.statusCode).toBe(200);

      const afterRevoke = await app.inject({
        method: "POST",
        url: "/api/agent/tool-calls",
        headers: { "x-agent-principal-token": credential.token },
        payload: {
          action: "read",
          resourceType: "mock_record",
          resourceKey: "alice-private-note",
        },
      });
      expect(afterRevoke.statusCode).toBe(401);
    } finally {
      await app.close();
      policyStore.close();
      authStore.close();
    }
  });
});
