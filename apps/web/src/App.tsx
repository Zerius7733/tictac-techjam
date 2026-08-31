import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  clearSessionToken,
  setAppAuthToken,
  setSessionToken,
} from "./api";
import { ProjectWorkspace } from "./ProjectWorkspace";
import type {
  Agent,
  AgentActionLog,
  AgentCapability,
  AgentCredential,
  AgentRun,
  ChatMode,
  Message,
  MockResource,
  PolicyAction,
  SystemInfo,
} from "./types";

type AuthStage = "loading" | "app-token" | "login" | "authenticated";

interface AuthUser {
  id: string;
  username: string;
  displayName: string | null;
  roleNames: string[];
}

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

type SecurityBusyAction =
  | "loading"
  | "credential"
  | "grant"
  | "revoke"
  | null;

interface SecurityPanelProps {
  agent: Agent;
  ownerName: string;
  setupMode?: boolean;
  initialAgentCredential: { id: string; token: string } | null;
  onAgentCredentialChange: (credential: { id: string; token: string } | null) => void;
  onClose: () => void;
}

function formatPolicyTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function SecurityPanel({
  agent,
  ownerName,
  setupMode = false,
  initialAgentCredential,
  onAgentCredentialChange,
  onClose,
}: SecurityPanelProps) {
  const [resources, setResources] = useState<MockResource[]>([]);
  const [capabilities, setCapabilities] = useState<AgentCapability[]>([]);
  const [credentials, setCredentials] = useState<AgentCredential[]>([]);
  const [actionLogs, setActionLogs] = useState<AgentActionLog[]>([]);
  const [resourceKey, setResourceKey] = useState("");
  const [action, setAction] = useState<PolicyAction>("read");
  const [agentToken, setAgentToken] = useState(initialAgentCredential?.token ?? "");
  const [credentialId, setCredentialId] = useState<string | null>(
    initialAgentCredential?.id ?? null,
  );
  const [busyAction, setBusyAction] = useState<SecurityBusyAction>("loading");
  const [panelError, setPanelError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [resourceResult, capabilityResult, credentialResult, logResult] =
      await Promise.all([
        api.listResources(),
        api.listCapabilities(agent.id),
        api.listCredentials(agent.id),
        api.listActionLogs(agent.id),
      ]);
    setResources(resourceResult.resources);
    setCapabilities(capabilityResult.capabilities);
    setCredentials(credentialResult.credentials);
    setActionLogs(logResult.actions);
    setResourceKey((current) =>
      current && resourceResult.resources.some((resource) => resource.resourceKey === current)
        ? current
        : (resourceResult.resources[0]?.resourceKey ?? ""),
    );
  }, [agent.id]);

  useEffect(() => {
    void refresh()
      .catch((reason) =>
        setPanelError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusyAction(null));
  }, [refresh]);

  const selectedResource = resources.find((resource) => resource.resourceKey === resourceKey);
  const availableActions: PolicyAction[] =
    selectedResource?.resourceType === "data_asset" ? ["read"] : ["read", "write"];
  const activeCapabilities = capabilities.filter(
    (capability) =>
      !capability.revokedAt && new Date(capability.expiresAt).getTime() > Date.now(),
  );

  const runWithRefresh = async (work: () => Promise<void>, busy: SecurityBusyAction) => {
    setBusyAction(busy);
    setPanelError(null);
    setNotice(null);
    try {
      await work();
      await refresh();
    } catch (reason) {
      setPanelError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyAction(null);
    }
  };

  const issueCredential = async () => {
    await runWithRefresh(async () => {
      const result = await api.issueCredential(agent.id, 3_600);
      setAgentToken(result.credential.token);
      setCredentialId(result.credential.id);
      onAgentCredentialChange({
        id: result.credential.id,
        token: result.credential.token,
      });
      setNotice("Credential issued. Copy it now—the raw token will not be shown again.");
    }, "credential");
  };

  const grantCapability = async () => {
    if (!selectedResource) return;
    await runWithRefresh(async () => {
      await api.grantCapability(agent.id, {
        resourceType: selectedResource.resourceType,
        resourceKey: selectedResource.resourceKey,
        action,
        expiresInSeconds: 3_600,
      });
      setNotice(
        `${action === "read" ? "Read" : "Write"} access to ${selectedResource.resourceKey} is enabled for 1 hour.`,
      );
    }, "grant");
  };

  const revokeCapability = async (capabilityId: string) => {
    await runWithRefresh(async () => {
      await api.revokeCapability(agent.id, capabilityId);
      setNotice("Capability revoked. The next matching Agent request will be denied.");
    }, "revoke");
  };

  const revokeCredential = async (id: string) => {
    await runWithRefresh(async () => {
      await api.revokeCredential(agent.id, id);
      if (id === credentialId) {
        setAgentToken("");
        setCredentialId(null);
        onAgentCredentialChange(null);
      }
      setNotice("Credential revoked. Requests using it will now return unauthorized.");
    }, "revoke");
  };

  const clearToken = () => {
    setAgentToken("");
    setCredentialId(null);
    onAgentCredentialChange(null);
    setNotice("The raw credential was cleared from this browser tab.");
  };

  return (
    <div className="modal-backdrop security-backdrop" onMouseDown={onClose}>
      <section
        className="security-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="security-panel-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="security-heading">
          <div>
            <span className="eyebrow">{setupMode ? "Step 2 of 2" : "Security & Policy"}</span>
            <h2 id="security-panel-title">
              {setupMode ? "Choose what this Agent may access" : "Agent identity and permissions"}
            </h2>
            <p>
              {setupMode
                ? "Start with the smallest access needed. You can change this later."
                : "Alice’s permissions do not automatically become the Agent’s permissions."}
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close security panel">
            ×
          </button>
        </div>

        {panelError && <div className="security-alert security-alert-error" role="alert">{panelError}</div>}
        {notice && <div className="security-alert security-alert-success" role="status">{notice}</div>}

        <div className="security-identity-grid">
          <div className="security-identity-card">
            <span className="eyebrow">Human owner</span>
            <strong>{ownerName}</strong>
            <code>{agent.ownerUserId ?? "not assigned"}</code>
          </div>
          <div className="security-identity-card">
            <span className="eyebrow">Independent Agent principal</span>
            <strong>{agent.name}</strong>
            <code>{agent.principalId ?? "not assigned"}</code>
          </div>
        </div>

        <div className="security-grid">
          <section className="security-card security-access-card">
            <div className="security-card-heading">
              <div>
                <span className="eyebrow">1 · Agent credential</span>
                <h3>Give the Agent its own key</h3>
              </div>
              <span className="security-count">{credentials.length}</span>
            </div>
            <p className="security-copy">
              This credential is separate from Alice’s login session and is stored as a hash by the backend.
            </p>
            <button
              className="button button-primary"
              onClick={() => void issueCredential()}
              disabled={busyAction !== null}
            >
              {busyAction === "credential" ? <Spinner /> : "Issue Agent credential"}
            </button>
            {agentToken && (
              <div className="credential-reveal">
                <span className="eyebrow">Shown once · keep it for this test</span>
                <code>{agentToken}</code>
                <button className="button button-ghost" onClick={clearToken}>Forget token</button>
              </div>
            )}
            {credentials.length > 0 && (
              <div className="security-list compact-list">
                {credentials.map((credential) => (
                  <div className="security-list-row" key={credential.id}>
                    <div>
                      <strong>{credential.id === credentialId ? "Current browser credential" : "Issued credential"}</strong>
                      <span>{credential.revokedAt ? "Revoked" : `Expires ${formatPolicyTime(credential.expiresAt)}`}</span>
                    </div>
                    {!credential.revokedAt && (
                      <button
                        className="button button-danger button-small"
                        onClick={() => void revokeCredential(credential.id)}
                        disabled={busyAction !== null}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="security-card security-access-card">
            <div className="security-card-heading">
              <div>
                <span className="eyebrow">2 · Delegated capability</span>
                <h3>Choose the smallest access</h3>
              </div>
              <span className="security-count">{activeCapabilities.length} active</span>
            </div>
            <p className="security-copy">
              A capability is exact: one Agent, one resource, and one action.
              Data assets are allowlisted and read-only; other demo records can
              also receive a write capability. The backend enforces the selected
              capability for every protected request.
            </p>
            <label>
              Protected resource
              <select
                value={resourceKey}
                onChange={(event) => {
                  const nextKey = event.target.value;
                  setResourceKey(nextKey);
                  const nextResource = resources.find(
                    (resource) => resource.resourceKey === nextKey,
                  );
                  if (nextResource?.resourceType === "data_asset") setAction("read");
                }}
              >
                {resources.map((resource) => (
                  <option key={resource.resourceKey} value={resource.resourceKey}>
                    {resource.label} · {resource.sensitivity}
                  </option>
                ))}
              </select>
            </label>
            {selectedResource && (
              <small className="security-resource-hint">
                {selectedResource.description} <code>{selectedResource.resourceType}:{selectedResource.resourceKey}</code>
              </small>
            )}
            <div className="action-choice" role="group" aria-label="Capability action">
              {availableActions.map((option) => (
                <button
                  type="button"
                  key={option}
                  className={"choice-button " + (action === option ? "selected" : "")}
                  onClick={() => setAction(option)}
                >
                  {option === "read" ? "Read" : "Write"}
                </button>
              ))}
            </div>
            <button
              className="button button-primary"
              onClick={() => void grantCapability()}
              disabled={busyAction !== null || !selectedResource}
            >
              {busyAction === "grant" ? <Spinner /> : `Grant ${action} access`}
            </button>
            <div className="security-list">
              {capabilities.length === 0 ? (
                <div className="security-empty">No capabilities yet. This Agent currently has no resource access.</div>
              ) : (
                capabilities.map((capability) => (
                  <div className="security-list-row" key={capability.id}>
                    <div>
                      <strong>
                        {capability.action} · {capability.resourceType} · {capability.resourceKey}
                      </strong>
                      <span>
                        {capability.revokedAt
                          ? "Revoked"
                          : `Expires ${formatPolicyTime(capability.expiresAt)}`}
                      </span>
                    </div>
                    {!capability.revokedAt && (
                      <button
                        className="button button-danger button-small"
                        onClick={() => void revokeCapability(capability.id)}
                        disabled={busyAction !== null}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <div className="security-grid security-grid-single">
          <section className="security-card">
            <div className="security-card-heading">
              <div>
                <span className="eyebrow">Audit proof</span>
                <h3>Recent Agent actions</h3>
              </div>
              <span className="security-count">{actionLogs.length}</span>
            </div>
            <div className="security-list compact-list">
              {actionLogs.length === 0 ? (
                <div className="security-empty">No Agent actions yet.</div>
              ) : (
                actionLogs.slice(0, 4).map((log) => (
                  <div className="security-list-row" key={log.id}>
                    <div>
                      <strong className={log.decision === "allow" ? "text-success" : "text-danger"}>
                        {log.decision} · {log.action}
                      </strong>
                      <span>{log.resourceKey} · {log.resultCode}</span>
                    </div>
                    <time>{formatPolicyTime(log.createdAt)}</time>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <div className="security-footer">
          <span>Permissions are enforced by the backend and recorded in the database.</span>
          <button className="button button-ghost" onClick={onClose}>
            {setupMode ? "Finish later" : "Close"}
          </button>
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentCredentials, setAgentCredentials] = useState<
    Record<string, { id: string; token: string }>
  >({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [projectsVisited, setProjectsVisited] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSecurity, setShowSecurity] = useState(false);
  const [securitySetup, setSecuritySetup] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [chatMode, setChatMode] = useState<ChatMode>("agent");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshingAgents, setRefreshingAgents] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authStage, setAuthStage] = useState<AuthStage>("loading");
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [sharedTokenRequired, setSharedTokenRequired] = useState(false);
  const [appAuthInput, setAppAuthInput] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const rememberAgentCredential = useCallback(
    (agentId: string, credential: { id: string; token: string } | null) => {
      setAgentCredentials((current) => {
        const next = { ...current };
        if (credential) next[agentId] = credential;
        else delete next[agentId];
        return next;
      });
    },
    [],
  );

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshAgentStatuses = useCallback(async () => {
    if (refreshingAgents) return;
    setRefreshingAgents(true);
    setError(null);
    try {
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRefreshingAgents(false);
    }
  }, [refreshAgents, refreshingAgents]);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async (status) => {
        if (!mountedRef.current) return;
        setSharedTokenRequired(status.sharedTokenRequired);
        if (status.authenticated && status.user) {
          setCurrentUser(status.user);
          setAuthStage("authenticated");
          await bootstrap();
        } else if (status.sharedTokenRequired) {
          setAuthStage("app-token");
        } else if (status.loginRequired) {
          setAuthStage("login");
        } else {
          setAuthStage("authenticated");
          await bootstrap();
        }
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setShowSettings(false);
    setChatMode("agent");
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running", "waiting"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setSecuritySetup(true);
      setShowSecurity(true);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
      setShowSecurity(false);
      setSecuritySetup(false);
      setShowProjects(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running", "waiting"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    if (/^\/data\s*$/i.test(content)) {
      setChatMode("protected-data");
      setPrompt("");
      setError(null);
      return;
    }
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(
        selected.id,
        content,
        agentCredentials[selected.id]?.token ?? "",
        chatMode,
      );
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlockWithAppToken = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAppAuthToken(appAuthInput);
    try {
      await api.authAccess();
      setAuthStage("login");
      setAppAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The application access token is not valid.");
        setAppAuthToken("");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login({ username, password });
      setSessionToken(result.sessionToken);
      setCurrentUser(result.user);
      setAuthStage("authenticated");
      setPassword("");
      await bootstrap();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("Username or password is incorrect.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.logout();
    } catch (reason) {
      if (!(reason instanceof ApiError && reason.status === 401)) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      clearSessionToken();
      setAppAuthToken("");
      setCurrentUser(null);
      setAgents([]);
      setAgentCredentials({});
      setMessages([]);
      setSelectedId(null);
      setActiveRun(null);
      setSystem(null);
      setShowSecurity(false);
      setSecuritySetup(false);
      setAuthStage(sharedTokenRequired ? "app-token" : "login");
      setBusy(false);
    }
  };

  if (authStage === "loading") {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authStage === "app-token") {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlockWithAppToken}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the platform token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Platform access token
            <input
              autoFocus
              type="password"
              value={appAuthInput}
              onChange={(event) => setAppAuthInput(event.target.value)}
              autoComplete="off"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !appAuthInput.trim()}>
            {busy ? <Spinner /> : "Continue"}
          </button>
        </form>
      </main>
    );
  }

  if (authStage === "login") {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={login}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Sign in to Launchpad</h1>
          <p>Use your individual account to access your Agents and permissions.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Username
            <input
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder="alice"
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="Your password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !username.trim() || !password}>
            {busy ? <Spinner /> : "Sign in"}
          </button>
          <p className="auth-demo-hint">Development accounts: alice or bob. Credentials are in the database README.</p>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          type="button"
          className="brand home-brand"
          onClick={() => {
            setShowProjects(false);
            setShowCreate(false);
            setShowSettings(false);
            setShowSecurity(false);
            setSecuritySetup(false);
          }}
          aria-label="Go to home"
        >
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
              : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </button>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <button
          className={"button button-ghost projects-nav-button " + (showProjects ? "active" : "")}
          onClick={() => {
            setProjectsVisited(true);
            setShowProjects(true);
          }}
          disabled={busy}
        >
          <span>⌘</span> Projects
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <div className="agent-list-tools">
            <span>{agents.length}</span>
            <button
              type="button"
              className={"icon-button agent-refresh-button " + (refreshingAgents ? "is-refreshing" : "")}
              onClick={() => void refreshAgentStatuses()}
              disabled={refreshingAgents}
              aria-label={refreshingAgents ? "Refreshing Agent statuses" : "Refresh Agent statuses"}
              aria-busy={refreshingAgents}
              title={refreshingAgents ? "Refreshing Agent statuses" : "Refresh Agent statuses"}
            >
              <span aria-hidden="true">↻</span>
            </button>
          </div>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => {
                setSelectedId(agent.id);
                setShowProjects(false);
              }}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
        {currentUser && (
          <div className="user-card">
            <div className="user-avatar">{(currentUser.displayName ?? currentUser.username).slice(0, 1).toUpperCase()}</div>
            <div className="user-copy">
              <strong>{currentUser.displayName ?? currentUser.username}</strong>
              <span>@{currentUser.username}</span>
            </div>
            <button className="button button-logout" onClick={() => void logout()} disabled={busy}>
              Log out
            </button>
          </div>
        )}
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {currentUser && projectsVisited && (
          <div className={"projects-view " + (showProjects ? "" : "projects-view-hidden")}>
            <ProjectWorkspace
              currentUser={currentUser}
              onRefreshAgents={refreshAgents}
            />
          </div>
        )}

        {!showProjects && (selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
                <div className="agent-key-summary">
                  <span>Delegation key</span>
                  <code>{selected.agentKey}</code>
                </div>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-policy"
                  onClick={() => {
                    setSecuritySetup(false);
                    setShowSecurity(true);
                  }}
                  disabled={busy || selected.status === "busy"}
                >
                  Security & Policy
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <div className="agent-key-field">
                  <span>Delegation key</span>
                  <code>{selected.agentKey}</code>
                  <small>This stable key is what another Agent uses to delegate work to this Agent.</small>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running", "waiting"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <div className="composer-modebar" role="group" aria-label="Chat mode">
                  <span className="composer-mode-label">Use chat for</span>
                  <div className="composer-mode-options">
                    <button
                      type="button"
                      className={"composer-mode-button " + (chatMode === "agent" ? "active" : "")}
                      aria-pressed={chatMode === "agent"}
                      onClick={() => setChatMode("agent")}
                    >
                      Agent tasks
                    </button>
                    <button
                      type="button"
                      className={"composer-mode-button " + (chatMode === "protected-data" ? "active" : "")}
                      aria-pressed={chatMode === "protected-data"}
                      onClick={() => setChatMode("protected-data")}
                    >
                      Protected data
                    </button>
                  </div>
                  <span className="composer-mode-help">
                    {chatMode === "protected-data"
                      ? "Read or write access already granted in Security & Policy"
                      : "Use /data as a shortcut · type it alone to switch"}
                  </span>
                </div>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : chatMode === "protected-data"
                      ? "Try: read Alice’s private notes…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running", "waiting"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                    {chatMode === "protected-data"
                      ? agentCredentials[selected.id]
                        ? " · Protected data mode · credential active"
                        : " · Protected data mode · issue an Agent credential"
                      : " · Normal Agent mode"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running", "waiting"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        ))}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
                <p className="form-hint">Use a unique name. A short delegation key will be generated automatically.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}

      {showSecurity && selected && (
        <SecurityPanel
          agent={selected}
          ownerName={currentUser?.displayName ?? currentUser?.username ?? "Current user"}
          setupMode={securitySetup}
          initialAgentCredential={agentCredentials[selected.id] ?? null}
          onAgentCredentialChange={(credential) =>
            rememberAgentCredential(selected.id, credential)
          }
          onClose={() => {
            setShowSecurity(false);
            setSecuritySetup(false);
          }}
        />
      )}
    </div>
  );
}
