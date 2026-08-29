import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPolicyGateway } from "./agent-policy-gateway.js";
import { AuthStore } from "./auth-store.js";
import { PolicyStore } from "./policy-store.js";
import type { Agent } from "./types.js";

const temporaryDirectories: string[] = [];
const openSystems: Array<{ authStore: AuthStore; policyStore: PolicyStore }> = [];

afterEach(async () => {
  for (const system of openSystems.splice(0)) {
    system.policyStore.close();
    system.authStore.close();
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makePolicySystem() {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-policy-test-"));
  temporaryDirectories.push(root);
  const authStore = new AuthStore(path.join(root, "auth.db"));
  await authStore.initialize(true);
  const policyStore = new PolicyStore(path.join(root, "auth.db"));
  await policyStore.initialize(true);
  const login = authStore.login("alice", "alice-demo-2026", "request-login");
  const agentId = randomUUID();
  const principal = authStore.createAgentPrincipal(agentId, login!.user.id);
  const agent: Agent = {
    id: agentId,
    ownerUserId: login!.user.id,
    principalId: principal.id,
    name: "Alice Policy Agent",
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: path.join(root, "workspace"),
    codexThreadId: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  openSystems.push({ authStore, policyStore });
  return {
    authStore,
    policyStore,
    gateway: new AgentPolicyGateway(authStore, policyStore),
    agent,
    context: authStore.authenticate(login!.sessionToken, "request-agent")!,
  };
}

describe("AgentPolicyGateway", () => {
  it("requires a capability for an Agent resource action", async () => {
    const system = await makePolicySystem();

    const denied = system.gateway.execute(system.context, system.agent, {
      action: "read",
      resourceType: "mock_record",
      resourceKey: "alice-private-note",
    });
    expect(denied).toMatchObject({
      status: "denied",
      allowed: false,
      reasonCode: "capability_not_granted",
    });

    const approval = system.gateway.requestCapability(
      system.context,
      system.agent,
      {
        action: "read",
        resourceType: "mock_record",
        resourceKey: "alice-private-note",
        expiresInSeconds: 3_600,
      },
    );
    const verification = system.gateway.verifyCapability(
      system.context,
      system.agent,
      approval.id,
      "246810",
    );
    const capability = verification.capability!;
    expect(capability.agentPrincipalId).toBe(system.agent.principalId);

    const allowed = system.gateway.execute(system.context, system.agent, {
      action: "read",
      resourceType: "mock_record",
      resourceKey: "alice-private-note",
    });
    expect(allowed).toMatchObject({
      status: "allowed",
      allowed: true,
      resource: {
        resourceKey: "alice-private-note",
      },
    });
    if (allowed.status === "allowed") {
      expect(allowed.resource.value).toContain("Alice private note");
    }
  });

  it("blocks cross-user private resources even when a grant is attempted", async () => {
    const system = await makePolicySystem();

    expect(() =>
      system.gateway.requestCapability(system.context, system.agent, {
        action: "read",
        resourceType: "mock_record",
        resourceKey: "bob-private-note",
        expiresInSeconds: 3_600,
      }),
    ).toThrow("Cannot delegate a private resource you do not own");

    const denied = system.gateway.execute(system.context, system.agent, {
      action: "read",
      resourceType: "mock_record",
      resourceKey: "bob-private-note",
    });
    expect(denied).toMatchObject({
      status: "denied",
      reasonCode: "resource_owner_mismatch",
    });
  });

  it.each(["read", "write"] as const)(
    "does not allow the direct %s capability endpoint to bypass authenticator approval",
    async (action) => {
    const system = await makePolicySystem();

    expect(() =>
      system.gateway.grantCapability(system.context, system.agent, {
        action,
        resourceType: "mock_record",
        resourceKey: "alice-private-note",
        expiresInSeconds: 3_600,
      }),
    ).toThrow("require authenticator verification");
    },
  );

  it("allows writes with an active write capability and honors revocation", async () => {
    const system = await makePolicySystem();
    const approval = system.gateway.requestWriteCapability(
      system.context,
      system.agent,
      {
        resourceType: "mock_record",
        resourceKey: "alice-private-note",
        expiresInSeconds: 3_600,
      },
    );
    expect(approval).toMatchObject({ status: "pending", action: "write" });
    const verification = system.gateway.verifyWriteCapability(
      system.context,
      system.agent,
      approval.id,
      "246810",
    );
    expect(verification).toMatchObject({
      approved: true,
      reasonCode: "authenticator_verified",
      capability: { action: "write" },
    });
    const capability = verification.capability!;

    const completed = system.gateway.execute(system.context, system.agent, {
      action: "write",
      resourceType: "mock_record",
      resourceKey: "alice-private-note",
      inputText: "Approved replacement note",
    });
    expect(completed).toMatchObject({
      status: "allowed",
      reasonCode: "write_completed",
    });
    expect(system.policyStore.getMockResource("mock_record", "alice-private-note")?.value)
      .toBe("Approved replacement note");

    system.gateway.revokeCapability(system.context, system.agent, capability.id);
    const afterRevoke = system.gateway.execute(system.context, system.agent, {
      action: "write",
      resourceType: "mock_record",
      resourceKey: "alice-private-note",
      inputText: "Should be blocked",
    });
    expect(afterRevoke).toMatchObject({
      status: "denied",
      reasonCode: "capability_not_granted",
    });

    const logs = system.gateway.listActionLogs(system.agent);
    expect(logs.some((log) => log.resultCode === "write_completed")).toBe(true);
    expect(logs.every((log) => log.metadata.targetValueLogged === false)).toBe(true);
  });

  it("denies an incorrect authenticator code without creating write access", async () => {
    const system = await makePolicySystem();
    const approval = system.gateway.requestWriteCapability(system.context, system.agent, {
      resourceType: "mock_record",
      resourceKey: "alice-private-note",
      expiresInSeconds: 3_600,
    });

    const result = system.gateway.verifyWriteCapability(
      system.context,
      system.agent,
      approval.id,
      "000000",
    );
    expect(result).toMatchObject({
      approved: false,
      reasonCode: "authenticator_invalid",
      approval: { status: "denied" },
    });
    expect(system.policyStore.findActiveCapability(
      system.agent.principalId!,
      "mock_record",
      "alice-private-note",
      "write",
    )).toBeNull();
  });

  it("executes through a separate, revocable Agent credential", async () => {
    const system = await makePolicySystem();
    const issued = system.authStore.issueAgentCredential(
      system.agent.id,
      system.context.userId,
      3_600,
    );
    expect(issued.token).toMatch(/^agt_/);
    expect(system.authStore.listAgentCredentials(system.agent.id)[0]).not.toHaveProperty(
      "token",
    );

    const identity = system.authStore.authenticateAgentCredential(
      issued.token,
      "request-agent-tool",
    );
    expect(identity).toMatchObject({
      agentId: system.agent.id,
      principalId: system.agent.principalId,
      ownerUserId: system.context.userId,
    });

    const noCapability = system.gateway.executeAsAgent(identity!, system.agent, {
      action: "read",
      resourceType: "mock_record",
      resourceKey: "alice-private-note",
    });
    expect(noCapability).toMatchObject({
      status: "denied",
      reasonCode: "capability_not_granted",
    });

    const readApproval = system.gateway.requestCapability(system.context, system.agent, {
      action: "read",
      resourceType: "mock_record",
      resourceKey: "alice-private-note",
      expiresInSeconds: 3_600,
    });
    system.gateway.verifyCapability(system.context, system.agent, readApproval.id, "246810");
    const allowed = system.gateway.executeAsAgent(identity!, system.agent, {
      action: "read",
      resourceType: "mock_record",
      resourceKey: "alice-private-note",
    });
    expect(allowed).toMatchObject({ status: "allowed", allowed: true });

    system.authStore.revokeAgentCredential(issued.id, system.agent.id);
    expect(
      system.authStore.authenticateAgentCredential(issued.token, "request-after-revoke"),
    ).toBeNull();
  });
});
