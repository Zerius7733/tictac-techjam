import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuthStore } from "./auth-store.js";
import { ProjectStore } from "./projects.js";
import { SqliteAgentStore } from "./sqlite-agent-store.js";

describe("ProjectStore", () => {
  it("keeps membership and Agent participation separate from Agent ownership", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-project-test-"));
    const databasePath = path.join(root, "auth.db");
    const authStore = new AuthStore(databasePath);
    const agentStore = new SqliteAgentStore(databasePath);
    const projectStore = new ProjectStore(databasePath, path.join(root, "workspaces"));
    try {
      await authStore.initialize(true);
      await agentStore.initialize();
      await projectStore.initialize(true);
      const alice = authStore.login("alice", "alice-demo-2026", "project-test-alice");
      const bob = authStore.login("bob", "bob-demo-2026", "project-test-bob");
      expect(alice).not.toBeNull();
      expect(bob).not.toBeNull();

      const agentId = "99999999-9999-4999-8999-999999999999";
      await agentStore.mutate((database) => {
        database.agents.push({
          id: agentId,
          agentKey: "bob-backend-service",
          ownerUserId: bob!.user.id,
          principalId: null,
          name: "Backend Service",
          description: "Bob's backend Agent",
          instructions: "Work on backend tasks only.",
          status: "ready",
          workspacePath: path.join(root, "bob-agent"),
          codexThreadId: null,
          lastError: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      });

      const project = projectStore.listProjects(alice!.user.id)[0];
      expect(project).toMatchObject({
        name: "Order Dashboard",
        currentRole: "owner",
        memberCount: 1,
        agentCount: 0,
      });
      expect(projectStore.listCollaboratorCandidates(project.id, alice!.user.id, "bo")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            displayName: "Bob",
            username: "bob",
          }),
        ]),
      );

      const invited = projectStore.inviteMember(
        project.id,
        alice!.user.id,
        bob!.user.id,
        "editor",
      );
      expect(invited.members).toHaveLength(1);
      expect(invited.pendingInvitations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            displayName: "Bob",
            username: "bob",
            role: "editor",
            status: "pending",
          }),
        ]),
      );
      expect(projectStore.getProject(project.id, alice!.user.id).availableAgents).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Backend Service",
            ownerUsername: "bob",
          }),
        ]),
      );

      expect(() => projectStore.addAgent(project.id, alice!.user.id, agentId)).toThrow(
        "Only the Agent owner can assign this Agent to a project",
      );

      const bobInvitations = projectStore.listIncomingInvitations(bob!.user.id);
      expect(bobInvitations).toHaveLength(1);
      const accepted = projectStore.acceptInvitation(
        bobInvitations[0]!.id,
        bob!.user.id,
      );
      expect(accepted.currentRole).toBe("editor");
      expect(accepted.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ username: "bob", role: "editor" }),
        ]),
      );
      expect(projectStore.getProject(project.id, alice!.user.id).availableAgents).toEqual(
        expect.not.arrayContaining([
          expect.objectContaining({ name: "Backend Service", ownerUsername: "bob" }),
        ]),
      );
      expect(projectStore.getProject(project.id, bob!.user.id).availableAgents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Backend Service",
            ownerUsername: "bob",
          }),
        ]),
      );

      expect(() => projectStore.addAgent(project.id, alice!.user.id, agentId)).toThrow(
        "Only the Agent owner can assign this Agent to a project",
      );

      const withAgent = projectStore.addAgent(
        project.id,
        bob!.user.id,
        agentId,
      );
      expect(withAgent.agents[0]).toMatchObject({
        name: "Backend Service",
        ownerUsername: "bob",
        agentKey: "bob-backend-service",
        addedByUserId: bob!.user.id,
      });
      expect(projectStore.canUseAgent(project.id, alice!.user.id, agentId)).toBe(true);
      expect(projectStore.canUseAgent(project.id, bob!.user.id, agentId)).toBe(true);
      expect(projectStore.canUseAgent(project.id, "not-a-member", agentId)).toBe(false);

      expect(() => projectStore.leaveProject(project.id, alice!.user.id)).toThrow(
        "Project owner must delete or transfer the project before leaving",
      );
      projectStore.leaveProject(project.id, bob!.user.id);
      expect(projectStore.getProject(project.id, alice!.user.id).agents).toHaveLength(0);
      expect(() => projectStore.getProject(project.id, bob!.user.id)).toThrow("Project not found");
    } finally {
      projectStore.close();
      agentStore.close();
      authStore.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets only the owner delete a project and its workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-project-delete-test-"));
    const databasePath = path.join(root, "auth.db");
    const authStore = new AuthStore(databasePath);
    const agentStore = new SqliteAgentStore(databasePath);
    const projectStore = new ProjectStore(databasePath, path.join(root, "workspaces"));
    try {
      await authStore.initialize(true);
      await agentStore.initialize();
      await projectStore.initialize(true);
      const alice = authStore.login("alice", "alice-demo-2026", "project-delete-alice");
      const bob = authStore.login("bob", "bob-demo-2026", "project-delete-bob");
      const project = projectStore.listProjects(alice!.user.id)[0]!;

      projectStore.inviteMember(project.id, alice!.user.id, bob!.user.id, "editor");
      const invitation = projectStore.listIncomingInvitations(bob!.user.id)[0]!;
      projectStore.acceptInvitation(invitation.id, bob!.user.id);
      await expect(projectStore.deleteProject(project.id, bob!.user.id)).rejects.toThrow(
        "Project permission denied",
      );
      await projectStore.deleteProject(project.id, alice!.user.id);
      expect(projectStore.listProjects(alice!.user.id)).toHaveLength(0);
    } finally {
      projectStore.close();
      agentStore.close();
      authStore.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
