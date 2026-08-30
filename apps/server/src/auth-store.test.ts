import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStore } from "./auth-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeAuthStore(): Promise<AuthStore> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-auth-test-"));
  temporaryDirectories.push(root);
  const store = new AuthStore(
    path.join(root, "auth.db"),
  );
  await store.initialize(true);
  return store;
}

describe("AuthStore", () => {
  it("logs Alice in, authorizes her, and records the decision", async () => {
    const store = await makeAuthStore();
    const login = store.login("alice", "alice-demo-2026", "request-login");

    expect(login).not.toBeNull();
    expect(login?.user).toMatchObject({ username: "alice", roleNames: ["developer"] });

    const context = store.authenticate(login!.sessionToken, "request-invoke");
    expect(context).toMatchObject({ username: "alice", roleNames: ["developer"] });

    const decision = store.authorize(context!, "invoke", "agent", "any-agent");
    expect(decision).toMatchObject({ allowed: true, reasonCode: "permission_granted" });
    expect(decision.auditLogId).toEqual(expect.any(String));
    expect(store.count("audit_logs")).toBe(2);
    store.close();
  });

  it("rejects the wrong password and denies Bob's invoke permission", async () => {
    const store = await makeAuthStore();

    expect(store.login("alice", "wrong-password", "request-wrong")).toBeNull();
    const bobLogin = store.login("bob", "bob-demo-2026", "request-bob-login");
    const bob = store.authenticate(bobLogin!.sessionToken, "request-bob-invoke");
    const decision = store.authorize(bob!, "invoke", "agent", "any-agent");

    expect(bob?.roleNames).toEqual(["viewer"]);
    expect(decision).toMatchObject({ allowed: false, reasonCode: "permission_missing" });
    expect(store.count("audit_logs")).toBe(3);
    store.close();
  });

  it("revokes a session on logout", async () => {
    const store = await makeAuthStore();
    const login = store.login("alice", "alice-demo-2026", "request-login");
    const context = store.authenticate(login!.sessionToken, "request-authenticated");

    expect(context).not.toBeNull();
    store.logout(context!);

    expect(store.authenticate(login!.sessionToken, "request-after-logout")).toBeNull();
    store.close();
  });

  it("creates an independent Agent principal and can revoke it", async () => {
    const store = await makeAuthStore();
    const login = store.login("alice", "alice-demo-2026", "request-login");
    const principal = store.createAgentPrincipal("agent-alice-1", login!.user.id);

    expect(principal).toMatchObject({
      agentId: "agent-alice-1",
      ownerUserId: login!.user.id,
      status: "active",
      revokedAt: null,
    });
    expect(principal.id).not.toBe(login!.user.id);
    expect(store.count("agent_principals")).toBe(1);

    const revoked = store.revokeAgentPrincipal("agent-alice-1");
    expect(revoked).toMatchObject({
      id: principal.id,
      status: "revoked",
    });
    expect(revoked?.revokedAt).toEqual(expect.any(String));
    store.close();
  });

});
