import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api";
import { OrchestrationPanel, type OrchestrationAgentOption } from "./OrchestrationPanel";
import type {
  ProjectDetails,
  ProjectInvitation,
  ProjectRole,
  ProjectSummary,
  ProjectUserCandidate,
} from "./types";

interface ProjectWorkspaceProps {
  currentUser: {
    id: string;
    username: string;
    displayName: string | null;
  };
  onRefreshAgents: () => Promise<void>;
}

function projectRoleLabel(role: ProjectRole): string {
  return role === "owner" ? "Owner" : role === "editor" ? "Editor" : "Viewer";
}

function agentOwnerLabel(ownerUsername: string | null, currentUsername: string): string {
  if (!ownerUsername) return "System Agent";
  return ownerUsername === currentUsername ? "Your Agent" : `@${ownerUsername}'s Agent`;
}

export function ProjectWorkspace({
  currentUser,
  onRefreshAgents,
}: ProjectWorkspaceProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [project, setProject] = useState<ProjectDetails | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [memberUserId, setMemberUserId] = useState("");
  const [memberCandidates, setMemberCandidates] = useState<ProjectUserCandidate[]>([]);
  const [memberPickerOpen, setMemberPickerOpen] = useState(false);
  const [memberRole, setMemberRole] = useState<"editor" | "viewer">("editor");
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshProjects = useCallback(async () => {
    const result = await api.listProjects();
    setProjects(result.projects);
    setSelectedProjectId((current) =>
      current && result.projects.some((item) => item.id === current)
        ? current
        : (result.projects[0]?.id ?? ""),
    );
  }, []);

  const refreshProject = useCallback(async (projectId: string) => {
    if (!projectId) {
      setProject(null);
      return;
    }
    const result = await api.project(projectId);
    setProject(result.project);
  }, []);

  const refreshInvitations = useCallback(async () => {
    const result = await api.listProjectInvitations();
    setInvitations(result.invitations);
  }, []);

  const refreshMemberCandidates = useCallback(async (projectId: string, query = "") => {
    const result = await api.listProjectCollaboratorCandidates(projectId, query);
    setMemberCandidates(result.users);
  }, []);

  useEffect(() => {
    void Promise.all([refreshProjects(), refreshInvitations()]).catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [refreshInvitations, refreshProjects]);

  useEffect(() => {
    void refreshProject(selectedProjectId).catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [refreshProject, selectedProjectId]);

  useEffect(() => {
    if (!project || !["owner", "editor"].includes(project.currentRole)) {
      setMemberCandidates([]);
      return;
    }
    if (memberUserId) return;
    const timer = window.setTimeout(() => {
      void refreshMemberCandidates(project.id, memberSearch).catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    }, 180);
    return () => window.clearTimeout(timer);
  }, [memberSearch, memberUserId, project?.currentRole, project?.id, refreshMemberCandidates]);

  const runAction = async (work: () => Promise<void>, success: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(success);
    } catch (reason) {
      setError(
        reason instanceof ApiError
          ? reason.message
          : reason instanceof Error
            ? reason.message
            : String(reason),
      );
    } finally {
      setBusy(false);
    }
  };

  const createProject = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectName.trim()) return;
    await runAction(async () => {
      const result = await api.createProject({
        name: projectName.trim(),
        description: projectDescription.trim(),
      });
      await refreshProjects();
      setSelectedProjectId(result.project.id);
      setProjectName("");
      setProjectDescription("");
      await refreshProject(result.project.id);
    }, "Project created. Invite a collaborator or add an Agent to begin.");
  };

  const inviteMember = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!project || !memberUserId) return;
    const candidate = memberCandidates.find((user) => user.id === memberUserId);
    if (!candidate) return;
    await runAction(async () => {
      const result = await api.addProjectMember(project.id, {
        userId: memberUserId,
        role: memberRole,
      });
      setProject(result.project);
      await refreshProjects();
      setMemberSearch("");
      setMemberUserId("");
      setMemberPickerOpen(false);
    }, `Invitation sent to ${candidate.displayName ?? candidate.username}. They must accept before joining.`);
  };

  const acceptInvitation = async (invitation: ProjectInvitation) => {
    await runAction(async () => {
      const result = await api.acceptProjectInvitation(invitation.id);
      await refreshInvitations();
      await refreshProjects();
      setSelectedProjectId(result.project.id);
      setProject(result.project);
    }, `You joined ${invitation.projectName}.`);
  };

  const declineInvitation = async (invitation: ProjectInvitation) => {
    await runAction(async () => {
      await api.declineProjectInvitation(invitation.id);
      await refreshInvitations();
    }, `Invitation to ${invitation.projectName} declined.`);
  };

  const addAgent = async (agentId: string) => {
    if (!project) return;
    await runAction(async () => {
      const result = await api.addProjectAgent(project.id, agentId);
      setProject(result.project);
      await refreshProjects();
      await onRefreshAgents();
    }, "Your Agent was assigned to the project. Collaborators can now use it in project tasks.");
  };

  const removeAgent = async (agentId: string, agentName: string) => {
    if (!project || !window.confirm(`Remove ${agentName} from this project?`)) return;
    await runAction(async () => {
      const result = await api.removeProjectAgent(project.id, agentId);
      setProject(result.project);
      await refreshProjects();
    }, "Agent removed from this project.");
  };

  const removeMember = async (userId: string, username: string) => {
    if (!project || !window.confirm(`Remove @${username} from this project?`)) return;
    await runAction(async () => {
      const result = await api.removeProjectMember(project.id, userId);
      setProject(result.project);
      await refreshProjects();
    }, `@${username} no longer has access to this project.`);
  };

  const leaveProject = async () => {
    if (!project || project.currentRole === "owner") return;
    if (!window.confirm(`Leave “${project.name}”? You will lose access to its workspace and participating Agents.`)) return;
    const leavingProjectName = project.name;
    await runAction(async () => {
      await api.leaveProject(project.id);
      setProject(null);
      await refreshProjects();
    }, `You left ${leavingProjectName}.`);
  };

  const revokeInvitation = async (invitation: ProjectInvitation) => {
    if (!project || !window.confirm(`Cancel the invitation for ${invitation.displayName ?? invitation.username}?`)) return;
    await runAction(async () => {
      const result = await api.revokeProjectInvitation(project.id, invitation.id);
      setProject(result.project);
      await refreshProjects();
    }, `Invitation for ${invitation.displayName ?? invitation.username} cancelled.`);
  };

  const deleteProject = async () => {
    if (!project || project.currentRole !== "owner") return;
    if (!window.confirm(`Delete “${project.name}”? This removes its shared workspace and project history.`)) return;
    const deletedProjectName = project.name;
    await runAction(async () => {
      await api.deleteProject(project.id);
      setProject(null);
      await refreshProjects();
    }, `Project ${deletedProjectName} deleted.`);
  };

  const openWorkspace = async () => {
    if (!project) return;
    await runAction(async () => {
      await api.openProjectWorkspace(project.id);
    }, "Project folder opened in your file manager.");
  };

  const selectMemberCandidate = (candidate: ProjectUserCandidate) => {
    setMemberUserId(candidate.id);
    setMemberSearch(`${candidate.displayName ?? candidate.username} · @${candidate.username}`);
    setMemberPickerOpen(false);
  };

  const addableAgents = project?.availableAgents ?? [];
  const projectAgentOptions = useMemo<OrchestrationAgentOption[]>(
    () =>
      (project?.agents ?? []).map((agent) => ({
        id: agent.agentId,
        agentKey: agent.agentKey,
        name: agent.name,
        status: agent.status,
        ownerLabel: agentOwnerLabel(agent.ownerUsername, currentUser.username),
      })),
    [currentUser.username, project],
  );
  const canEdit = project?.currentRole === "owner" || project?.currentRole === "editor";
  const pendingProjectInvitations = project?.pendingInvitations ?? [];

  return (
    <section className="project-workspace">
      <header className="project-header">
        <div>
          <span className="eyebrow">Shared workspaces</span>
          <h1>Projects</h1>
          <p>Invite collaborators, choose the Agents that participate, and run tasks inside one shared project workspace.</p>
        </div>
        <span className="project-role-badge">{project ? projectRoleLabel(project.currentRole) : "Your projects"}</span>
      </header>

      {error && <div className="error-banner" role="alert">{error}</div>}
      {notice && <div className="project-notice" role="status">{notice}</div>}

      {invitations.length > 0 && (
        <section className="project-invitations-card">
          <div className="project-section-heading">
            <div>
              <span className="eyebrow">Needs your response</span>
              <h2>Pending project invitations</h2>
            </div>
            <span className="security-count">{invitations.length}</span>
          </div>
          <div className="project-invitation-list">
            {invitations.map((invitation) => (
              <div className="project-invitation-row" key={invitation.id}>
                <div>
                  <strong>{invitation.projectName}</strong>
                  <span>Invited by {invitation.invitedByDisplayName ?? invitation.invitedByUsername} · {projectRoleLabel(invitation.role)}</span>
                </div>
                <div className="project-invitation-actions">
                  <button className="button button-primary button-small" onClick={() => void acceptInvitation(invitation)} disabled={busy}>Accept</button>
                  <button className="button button-ghost button-small" onClick={() => void declineInvitation(invitation)} disabled={busy}>Decline</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="project-layout">
        <aside className="project-list-card">
          <div className="project-section-heading">
            <div>
              <span className="eyebrow">Your projects</span>
              <h2>Repositories</h2>
            </div>
            <span className="security-count">{projects.length}</span>
          </div>
          <div className="project-list">
            {projects.map((item) => (
              <button
                type="button"
                key={item.id}
                className={"project-list-item " + (item.id === selectedProjectId ? "selected" : "")}
                onClick={() => {
                  setSelectedProjectId(item.id);
                }}
              >
                <span className="project-list-icon">⌘</span>
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.memberCount} member{item.memberCount === 1 ? "" : "s"} · {item.agentCount} Agent{item.agentCount === 1 ? "" : "s"}</small>
                </span>
                <em>{projectRoleLabel(item.currentRole)}</em>
              </button>
            ))}
            {projects.length === 0 && <div className="project-empty">Create a project to start collaborating.</div>}
          </div>

          <form className="project-create-form" onSubmit={createProject}>
            <span className="eyebrow">New project</span>
            <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Project name" maxLength={100} />
            <input value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} placeholder="What are you building?" maxLength={500} />
            <button className="button button-primary" disabled={busy || !projectName.trim()}>{busy ? "Creating…" : "Create project"}</button>
          </form>
        </aside>

        {project ? (
          <div className="project-detail">
            <section className="project-overview-card">
              <div className="project-overview-topline">
                <div>
                  <span className="eyebrow">Project workspace</span>
                  <h2>{project.name}</h2>
                  <p>{project.description || "A shared workspace for coordinated Agent work."}</p>
                </div>
                <div className="project-overview-actions">
                  <span className="project-state">Local workspace ready</span>
                  {project.currentRole === "owner" ? (
                    <button className="button button-danger button-small" onClick={() => void deleteProject()} disabled={busy}>Delete project</button>
                  ) : (
                    <button className="button button-danger button-small" onClick={() => void leaveProject()} disabled={busy}>Leave project</button>
                  )}
                </div>
              </div>
              <div className="project-repo-strip">
                <span><b>Shared repository</b> Collaborators can use selected Agents here.</span>
                <button
                  type="button"
                  className="project-repo-location"
                  onClick={() => void openWorkspace()}
                  disabled={busy}
                  title="Open this project folder"
                  aria-label={`Open project folder ${project.workspacePath}`}
                >
                  <code>{project.workspacePath}</code>
                  <span>Open folder ↗</span>
                </button>
              </div>
            </section>

            <div className="project-management-grid">
              <section className="project-card">
                <div className="project-section-heading">
                  <div>
                    <span className="eyebrow">Collaborators</span>
                    <h2>People on this project</h2>
                  </div>
                  <span className="security-count">{project.members.length}</span>
                </div>
                <div className="project-member-list">
                  {project.members.map((member) => (
                    <div className="project-member-row" key={member.userId}>
                      <div className="project-person-avatar">{(member.displayName ?? member.username).slice(0, 1).toUpperCase()}</div>
                      <div>
                        <strong>{member.displayName ?? member.username}</strong>
                        <span>@{member.username} · {projectRoleLabel(member.role)}</span>
                      </div>
                      {canEdit && member.role !== "owner" && project.currentRole === "owner" && (
                        <button className="button button-danger button-small" onClick={() => void removeMember(member.userId, member.username)} disabled={busy}>Remove</button>
                      )}
                    </div>
                  ))}
                </div>
                {canEdit && (
                  <form className="project-invite-form" onSubmit={inviteMember}>
                    <label>
                      Add collaborator
                      <div className="project-inline-form">
                        <div className="project-user-picker">
                          <input
                            value={memberSearch}
                            onChange={(event) => {
                              setMemberSearch(event.target.value);
                              setMemberUserId("");
                              setMemberPickerOpen(true);
                            }}
                            onFocus={() => setMemberPickerOpen(true)}
                            onBlur={() => window.setTimeout(() => setMemberPickerOpen(false), 150)}
                            placeholder="Search people by name or username"
                            maxLength={120}
                            autoComplete="off"
                            role="combobox"
                            aria-expanded={memberPickerOpen}
                            aria-controls="project-user-candidates"
                          />
                          {memberPickerOpen && (
                            <div className="project-user-candidates" id="project-user-candidates" role="listbox">
                              {memberCandidates.map((candidate) => (
                                <button
                                  type="button"
                                  key={candidate.id}
                                  role="option"
                                  aria-selected={candidate.id === memberUserId}
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={() => selectMemberCandidate(candidate)}
                                >
                                  <strong>{candidate.displayName ?? candidate.username}</strong>
                                  <small>@{candidate.username}</small>
                                </button>
                              ))}
                              {memberCandidates.length === 0 && <span className="project-user-empty">No people available for this project.</span>}
                            </div>
                          )}
                        </div>
                        <select value={memberRole} onChange={(event) => setMemberRole(event.target.value as "editor" | "viewer")}>
                          <option value="editor">Editor</option>
                          <option value="viewer">Viewer</option>
                        </select>
                        <button className="button button-primary" disabled={busy || !memberUserId}>Invite</button>
                      </div>
                    </label>
                  </form>
                )}
                {canEdit && pendingProjectInvitations.length > 0 && (
                  <div className="project-pending-list">
                    <span>Pending invitations</span>
                    {pendingProjectInvitations.map((invitation) => (
                      <div className="project-pending-row" key={invitation.id}>
                        <div>
                          <strong>{invitation.displayName ?? invitation.username}</strong>
                          <small>@{invitation.username} · invited as {projectRoleLabel(invitation.role)}</small>
                        </div>
                        <button className="button button-danger button-small" onClick={() => void revokeInvitation(invitation)} disabled={busy}>Cancel</button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="project-card">
                <div className="project-section-heading">
                  <div>
                    <span className="eyebrow">Participating Agents</span>
                    <h2>Agents in this repository</h2>
                  </div>
                  <span className="security-count">{project.agents.length}</span>
                </div>
                <p className="project-copy">Only Agents explicitly added here appear in project orchestration. Ownership and protected-resource capabilities stay with their human owner.</p>
                <div className="project-agent-list">
                  {project.agents.map((agent) => (
                    <div className="project-agent-row" key={agent.agentId}>
                      <div className="project-agent-icon">{agent.name.slice(0, 1).toUpperCase()}</div>
                      <div>
                        <strong>{agent.name}</strong>
                        <span>{agentOwnerLabel(agent.ownerUsername, currentUser.username)} · <code>{agent.agentKey}</code></span>
                      </div>
                      {canEdit && (project.currentRole === "owner" || agent.ownerUserId === currentUser.id) && (
                        <button className="button button-danger button-small" onClick={() => void removeAgent(agent.agentId, agent.name)} disabled={busy}>Remove</button>
                      )}
                    </div>
                  ))}
                  {project.agents.length === 0 && <div className="project-empty">No Agents have joined yet.</div>}
                </div>
                {canEdit && (
                  <div className="project-add-agent">
                    <span>Assign your Agent to this project</span>
                    <small className="project-muted">Each Agent owner assigns their own Agent. You cannot add another collaborator's Agent.</small>
                    <div className="project-agent-add-list">
                      {addableAgents.map((agent) => (
                        <button type="button" className="project-agent-add-button" key={agent.agentId} onClick={() => void addAgent(agent.agentId)} disabled={busy}>
                          <strong>{agent.name}</strong>
                          <small>{agentOwnerLabel(agent.ownerUsername, currentUser.username)} · {agent.agentKey}</small>
                          <em>＋ Add</em>
                        </button>
                      ))}
                      {addableAgents.length === 0 && <small className="project-muted">You have no unassigned Agents. Create one or ask its owner to assign it.</small>}
                    </div>
                  </div>
                )}
              </section>
            </div>

            <section className="project-task-card">
              {canEdit && projectAgentOptions.length > 0 && (
                <OrchestrationPanel
                  agents={projectAgentOptions}
                  projectId={project.id}
                  projectName={project.name}
                />
              )}
              {(!canEdit || projectAgentOptions.length === 0) && (
                <>
                  <div className="project-task-heading">
                    <div>
                      <span className="eyebrow">Project orchestration</span>
                      <h2>Ask the project Agents to collaborate</h2>
                      <p>The root Agent receives your request first, coordinates the task, and can delegate to the other participating Agents. The gateway enforces project membership and protected-resource authorization.</p>
                    </div>
                  </div>
                  {!canEdit && <div className="project-empty">Viewer access is read-only. Ask a project editor to run the task.</div>}
                  {projectAgentOptions.length === 0 && <div className="project-empty">Add at least one participating Agent before running a task.</div>}
                </>
              )}
            </section>
          </div>
        ) : (
          <section className="project-no-selection">
            <div className="no-agent-art">⌘</div>
            <h2>{invitations.length > 0 ? "Review your project invitations" : "Create a shared project"}</h2>
            <p>{invitations.length > 0
              ? "Accept an invitation above to join the shared workspace and use its participating Agents."
              : "Projects are the collaboration boundary for people, Agents, workspace access, and project tasks."}</p>
          </section>
        )}
      </div>
    </section>
  );
}
