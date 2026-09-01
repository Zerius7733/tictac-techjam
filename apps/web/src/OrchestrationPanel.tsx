import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api";
import type {
  Agent,
  OrchestrationJob,
  OrchestrationMessage,
  OrchestrationRun,
  ProjectOrchestrator,
} from "./types";

interface OrchestrationPanelProps {
  agents: OrchestrationAgentOption[];
  currentUserId: string;
  projectId: string;
  projectName: string;
  orchestrator: ProjectOrchestrator;
}

export interface OrchestrationAgentOption {
  id: string;
  agentKey: string;
  name: string;
  status: Agent["status"];
  ownerLabel?: string;
}

const activeStatuses = new Set(["queued", "running", "waiting"]);
const expandableMessageTypes = new Set(["result", "tool_call", "tool_result"]);

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

interface PersistedOrchestrationState {
  version: 1;
  jobId: string | null;
  prompt: string;
}

function orchestrationJobStorageKey(projectId: string, userId: string): string {
  return `launchpad.project-orchestration.${projectId}.${userId}`;
}

function orchestrationDraftStorageKey(projectId: string, userId: string): string {
  return `launchpad.project-orchestration-draft.${projectId}.${userId}`;
}

function readPersistedOrchestration(
  projectId: string,
  userId: string,
): PersistedOrchestrationState {
  try {
    const jobId = window.localStorage.getItem(orchestrationJobStorageKey(projectId, userId));
    const prompt = window.localStorage.getItem(orchestrationDraftStorageKey(projectId, userId));
    return {
      version: 1,
      jobId: jobId || null,
      prompt: prompt ?? "",
    };
  } catch {
    return { version: 1, jobId: null, prompt: "" };
  }
}

function writePersistedOrchestration(
  projectId: string,
  userId: string,
  state: PersistedOrchestrationState,
): void {
  try {
    const jobKey = orchestrationJobStorageKey(projectId, userId);
    if (state.jobId) window.localStorage.setItem(jobKey, state.jobId);
    else window.localStorage.removeItem(jobKey);
    window.localStorage.setItem(
      orchestrationDraftStorageKey(projectId, userId),
      state.prompt,
    );
  } catch {
    // Browser storage can be unavailable in private or restricted contexts.
  }
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

function messageTitle(message: OrchestrationMessage, names: Map<string, string>): string {
  if (message.senderKind === "agent" && message.senderKey) {
    return names.get(message.senderKey) ?? message.senderKey;
  }
  if (message.senderKind === "orchestrator") return "Orchestration gateway";
  if (message.senderKind === "system") return "System";
  return "You";
}

function payloadString(
  payload: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function fallbackSummary(content: string, fallback: string): string {
  const value = content.trim();
  if (!value || value.startsWith("{") || value.startsWith("[")) return fallback;
  const firstLine = value.split(/\r?\n/, 1)[0]?.replace(/[`*_#]/g, "").trim() ?? "";
  if (!firstLine || firstLine.startsWith("{") || firstLine.startsWith("[")) {
    return fallback;
  }
  return firstLine.length > 180 ? firstLine.slice(0, 177) + "…" : firstLine;
}

function runSummary(run: OrchestrationRun): string {
  const summary = run.outputJson ? payloadString(run.outputJson, "summary") : null;
  return summary ?? fallbackSummary(run.outputText ?? "", "Agent completed the run.");
}

function errorTitle(error: string): string {
  const value = error.toLocaleLowerCase();
  if (value.includes("reported a blocker")) {
    return "Required information or access is unavailable.";
  }
  if (value.includes("valid json") || value.includes("invalid agent command")) {
    return "The Agent returned an invalid response format.";
  }
  if (value.includes("timeout")) return "The Agent took too long to finish.";
  if (value.includes("authorization") || value.includes("permission")) {
    return "Access was blocked by the project or security policy.";
  }
  if (value.includes("agent is not registered") || value.includes("not found")) {
    return "The requested Agent was not available.";
  }
  if (value.includes("runtime") || value.includes("connection") || value.includes("service unavailable")) {
    return "The Agent runtime stopped before it could finish.";
  }
  return "The Agent could not complete this step.";
}

function errorGuidance(error: string, recoveryAttempted = false): string {
  const value = error.toLocaleLowerCase();
  if (value.includes("reported a blocker")) {
    return "No further Agent was started. Review the delegated result and provide the missing resource or access before starting a new job.";
  }
  if (value.includes("authorization") || value.includes("permission")) {
    return "No automatic retry was made. Check the project membership, Agent assignment, or protected-resource capability, then start a new job.";
  }
  if (value.includes("timeout")) {
    return "No automatic retry was made because the Agent was already asked to stop. Try a smaller task or increase the configured time limit.";
  }
  if (
    value.includes("valid json") ||
    value.includes("invalid agent command") ||
    value.includes("runtime") ||
    value.includes("connection")
  ) {
    return recoveryAttempted
      ? "The system made one automatic repair attempt. The original issue is shown below; update the Agent instructions or runtime before starting another job."
      : "No automatic repair attempt is recorded for this run. This was an older or pre-recovery run; start a new job to use the automatic repair flow.";
  }
  return "The run stopped safely. Review the detail below, fix the Agent setup, and start a new job.";
}

function messageSummary(message: OrchestrationMessage): string {
  const summary = payloadString(message.payload, "summary");
  if (summary) return summary;

  if (message.messageType === "tool_result") {
    const type = payloadString(message.payload, "type");
    if (type === "authorization_denied") {
      const reason = payloadString(message.payload, "reasonCode") ?? "policy denied";
      const resource = payloadString(message.payload, "resourceKey");
      return `Authorization denied: ${resource ? resource + " · " : ""}${reason}.`;
    }
    if (type === "child_result") return "Received a result from the delegated Agent.";
    return "The orchestration gateway returned a tool result.";
  }

  if (message.messageType === "tool_call") return "The orchestration gateway requested an authorized action.";
  return fallbackSummary(message.content, "Agent returned a completed result.");
}

function rawRunOutput(run: OrchestrationRun): string {
  return run.outputJson
    ? JSON.stringify(run.outputJson, null, 2)
    : run.outputText ?? "";
}

function rawMessageOutput(message: OrchestrationMessage): string {
  const payload = message.payload;
  return payload && Object.keys(payload).length > 0
    ? JSON.stringify(payload, null, 2)
    : message.content;
}

function elapsedLabel(run: OrchestrationRun, now: number): string {
  const startedAt = Date.parse(run.startedAt ?? run.createdAt);
  const endedAt = run.completedAt ? Date.parse(run.completedAt) : now;
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function activityProgress(status: OrchestrationRun["status"]): number {
  if (status === "queued") return 15;
  if (status === "running") return 55;
  if (status === "waiting") return 75;
  return 100;
}

function runtimeActivityDetail(
  run: OrchestrationRun,
  latest: OrchestrationMessage | undefined,
): string {
  if (!latest) {
    return run.status === "running"
      ? "Runtime has not reported its first event yet."
      : "No runtime event recorded yet.";
  }
  if (latest.payload.event === "runtime_progress") {
    const detail = payloadString(latest.payload, "detail");
    const stage = payloadString(latest.payload, "stage");
    if (stage === "heartbeat") return `Last heartbeat · ${formatTime(latest.createdAt)}`;
    return detail
      ? `Runtime event: ${detail} · ${formatTime(latest.createdAt)}`
      : `Runtime update · ${formatTime(latest.createdAt)}`;
  }
  return `Latest event: ${latest.messageType.replaceAll("_", " ")}`;
}

function isRuntimeProgressMessage(message: OrchestrationMessage): boolean {
  return payloadString(message.payload, "event") === "runtime_progress";
}

function runtimeSummary(
  job: OrchestrationJob,
  latest: OrchestrationMessage | undefined,
): { state: "starting" | "active" | "complete" | "stopped"; label: string; detail: string } {
  if (job.status === "completed") {
    return {
      state: "complete",
      label: "Finished",
      detail: latest
        ? `Last event · ${payloadString(latest.payload, "detail") ?? "completed"}`
        : "Run completed successfully.",
    };
  }
  if (job.status === "failed" || job.status === "cancelled") {
    return {
      state: "stopped",
      label: job.status === "failed" ? "Stopped" : "Cancelled",
      detail: job.status === "failed" ? "Runtime stopped with an error." : "Runtime stopped by the user.",
    };
  }
  if (!latest) {
    return {
      state: "starting",
      label: "Starting up",
      detail: "Waiting for the first runtime event.",
    };
  }
  const stage = payloadString(latest.payload, "stage");
  if (stage === "runtime_started") {
    return {
      state: "starting",
      label: "Starting up",
      detail: "Runtime started · waiting for the first event.",
    };
  }
  return {
    state: "active",
    label: "Active",
    detail: latest
      ? `Last event · ${payloadString(latest.payload, "detail") ?? "runtime update"}`
      : "Runtime is processing the request.",
  };
}

function staleRuntimeWarning(
  run: OrchestrationRun,
  latest: OrchestrationMessage | undefined,
  now: number,
): string | null {
  if (run.status !== "running") return null;
  const lastActivity = Date.parse(latest?.createdAt ?? run.startedAt ?? run.createdAt);
  if (!Number.isFinite(lastActivity)) return null;
  const seconds = Math.floor((now - lastActivity) / 1_000);
  if (seconds < 45) return null;
  return `No runtime update for ${seconds}s. Inspect the runtime or cancel this job.`;
}

function runActivity(
  run: OrchestrationRun,
  message: OrchestrationMessage | undefined,
  names: Map<string, string>,
): string {
  if (run.status === "queued") return "Queued and waiting to start.";
  if (run.status === "completed") return "Completed the assigned work.";
  if (run.status === "failed") return "Stopped safely after an error.";
  if (run.status === "cancelled") return "Cancelled by the user.";

  const targetKey = message
    ? payloadString(message.payload, "targetAgentKey") ??
      payloadString(message.payload, "sourceAgentKey")
    : null;
  const targetName = targetKey ? names.get(targetKey) ?? targetKey : "a delegated Agent";
  if (run.status === "waiting") {
    if (message?.messageType === "delegation") {
      return `Waiting for ${targetName} to complete delegated work.`;
    }
    if (message?.messageType === "tool_call") {
      const resource = payloadString(message.payload, "resourceKey");
      return `Waiting for authorization to access ${resource ?? "a protected resource"}.`;
    }
    return "Waiting for delegated work or an authorization decision.";
  }

  if (message?.messageType === "delegation") {
    return `Delegating work to ${targetName}.`;
  }
  if (message?.messageType === "tool_call") {
    const action = payloadString(message.payload, "action") ?? "read";
    const resource = payloadString(message.payload, "resourceKey") ?? "a protected resource";
    return `Requesting permission to ${action} ${resource}.`;
  }
  if (message?.messageType === "tool_result") {
    return "Reviewing the latest delegated result or authorization decision.";
  }
  if (message?.messageType === "progress") {
    return fallbackSummary(message.content, "Working on the assigned task.");
  }
  return "Working on the assigned task.";
}

interface ExpandableOutputProps {
  summary: string;
  raw: string;
  expanded: boolean;
  onToggle: () => void;
}

function ExpandableOutput({ summary, raw, expanded, onToggle }: ExpandableOutputProps) {
  return (
    <div className="orchestration-output">
      <button
        type="button"
        className="orchestration-output-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span>{summary}</span>
        <small>{expanded ? "Hide raw JSON" : "View raw JSON"}</small>
      </button>
      {expanded && <pre className="orchestration-raw-output">{raw}</pre>}
    </div>
  );
}

export function OrchestrationPanel({
  agents,
  currentUserId,
  projectId,
  projectName,
  orchestrator,
}: OrchestrationPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [job, setJob] = useState<OrchestrationJob | null>(null);
  const [runs, setRuns] = useState<OrchestrationRun[]>([]);
  const [messages, setMessages] = useState<OrchestrationMessage[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const persisted = readPersistedOrchestration(projectId, currentUserId);
    setLoadedProjectId(null);
    setPrompt(persisted.prompt);
    setJob(null);
    setRuns([]);
    setMessages([]);
    setExpandedIds(new Set());
    setError(null);

    const restore = async () => {
      if (!persisted.jobId) {
        if (!disposed) setLoadedProjectId(projectId);
        return;
      }
      try {
        const [state, timeline] = await Promise.all([
          api.orchestration(persisted.jobId),
          api.orchestrationMessages(persisted.jobId),
        ]);
        if (disposed) return;
        if (state.job.projectId !== projectId) {
          writePersistedOrchestration(projectId, currentUserId, { ...persisted, jobId: null });
          setLoadedProjectId(projectId);
          return;
        }
        setJob(state.job);
        setRuns(state.runs);
        setMessages(timeline.messages);
      } catch (reason) {
        if (!disposed) {
          // A deleted or inaccessible job should not prevent the project from
          // opening; the persisted pointer is simply stale.
          writePersistedOrchestration(projectId, currentUserId, { ...persisted, jobId: null });
          if (reason instanceof ApiError && reason.status >= 500) {
            setError(reason.message);
          }
        }
      } finally {
        if (!disposed) setLoadedProjectId(projectId);
      }
    };
    void restore();
    return () => {
      disposed = true;
    };
  }, [currentUserId, projectId]);

  useEffect(() => {
    if (loadedProjectId !== projectId) return;
    writePersistedOrchestration(projectId, currentUserId, {
      version: 1,
      jobId: job?.id ?? null,
      prompt,
    });
  }, [currentUserId, job?.id, loadedProjectId, projectId, prompt]);

  useEffect(() => {
    if (loadedProjectId !== projectId) return;
    const jobId = job?.id;
    const jobStatus = job?.status;
    if (!jobId || !jobStatus || !activeStatuses.has(jobStatus)) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const [state, timeline] = await Promise.all([
          api.orchestration(jobId),
          api.orchestrationMessages(jobId),
        ]);
        if (disposed) return;
        setJob(state.job);
        setRuns(state.runs);
        setMessages(timeline.messages);
      } catch (reason) {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 900);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [job?.id, job?.status, loadedProjectId, projectId]);

  const hasActiveRuns = runs.some((run) => activeStatuses.has(run.status));
  useEffect(() => {
    if (!hasActiveRuns) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasActiveRuns]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createOrchestration({
        prompt: prompt.trim(),
        projectId,
      });
      setJob(created.job);
      setRuns([created.run]);
      setMessages([created.message]);
      setExpandedIds(new Set());
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

  const cancel = async () => {
    if (!job || !activeStatuses.has(job.status)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.cancelOrchestration(job.id, "cancelled_from_playground");
      setJob(result.job);
      const [state, timeline] = await Promise.all([
        api.orchestration(job.id),
        api.orchestrationMessages(job.id),
      ]);
      setRuns(state.runs);
      setMessages(timeline.messages);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const names = useMemo(
    () =>
      new Map([
        ...agents.flatMap((agent) => [
          [agent.id, agent.name],
          [agent.agentKey, agent.name],
        ] as [string, string][]),
        [orchestrator.id, orchestrator.name],
        [orchestrator.agentKey, orchestrator.name],
      ]),
    [agents, orchestrator],
  );
  const latestMessageByRun = useMemo(() => {
    const latest = new Map<string, OrchestrationMessage>();
    for (const message of messages) {
      if (!message.runId) continue;
      const previous = latest.get(message.runId);
      if (!previous || message.sequenceNo > previous.sequenceNo) {
        latest.set(message.runId, message);
      }
    }
    return latest;
  }, [messages]);
  const recoveryAttemptByRun = useMemo(() => {
    const recovery = new Set<string>();
    for (const message of messages) {
      if (
        message.runId &&
        payloadString(message.payload, "event") === "run_recovery_attempt"
      ) {
        recovery.add(message.runId);
      }
    }
    return recovery;
  }, [messages]);
  const runtimeMessages = useMemo(
    () => messages.filter(isRuntimeProgressMessage),
    [messages],
  );
  const timelineMessages = useMemo(
    () => messages.filter((message) => !isRuntimeProgressMessage(message)),
    [messages],
  );
  const latestRuntimeMessage = runtimeMessages.at(-1);
  const runtimeState = job ? runtimeSummary(job, latestRuntimeMessage) : null;
  const completedRunCount = runs.filter((run) => run.status === "completed").length;
  const toggleExpanded = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section className="orchestration-panel">
      <header className="orchestration-header">
        <div>
          <span className="eyebrow">{projectName} · shared project</span>
          <h1>Project orchestration</h1>
          <p>The project orchestrator receives every request, delegates focused work to participating Agents, requests authorized resources when needed, and combines their results.</p>
        </div>
        {job && (
          <span className={"orchestration-status status-" + job.status}>
            {job.status === "completed" ? "✓" : job.status === "failed" ? "!" : "•"}
            {statusLabel(job.status)}
          </span>
        )}
      </header>

      {error && <div className="error-banner" role="alert">{error}</div>}

      <form className="orchestration-form" onSubmit={submit}>
        <div className="project-orchestrator-control">
          <span className="project-orchestrator-label">Project orchestrator</span>
          <div className="project-orchestrator-identity">
            <span>O</span>
            <div>
              <strong>{orchestrator.name}</strong>
              <small>Automatic coordinator · {orchestrator.status}</small>
            </div>
          </div>
          <details>
            <summary>View orchestrator instructions</summary>
            <p>{orchestrator.systemPrompt}</p>
          </details>
        </div>
        <label>
          Request
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} maxLength={50_000} placeholder="Describe what you want the participating Agents to do…" disabled={busy || Boolean(job && activeStatuses.has(job.status))} />
        </label>
        <div className="orchestration-actions">
          <button className="button button-primary" disabled={busy || !prompt.trim() || Boolean(job && activeStatuses.has(job.status))}>
            {busy ? "Working…" : "Start orchestration"}
          </button>
          {job && activeStatuses.has(job.status) && (
            <button type="button" className="button button-danger" onClick={() => void cancel()} disabled={busy}>Cancel job</button>
          )}
          {job && !activeStatuses.has(job.status) && (
            <button type="button" className="button button-ghost" onClick={() => { setJob(null); setRuns([]); setMessages([]); setError(null); setPrompt(""); }}>New job</button>
          )}
        </div>
      </form>

      {job && (
        <div className="orchestration-content">
          {job.status === "completed" && (
            <div className="orchestration-completion-card" role="status" aria-live="polite">
              <span className="orchestration-completion-icon" aria-hidden="true">✓</span>
              <div>
                <span className="eyebrow">Run complete</span>
                <strong>Project work is complete</strong>
                <p>
                  {completedRunCount === runs.length
                    ? `All ${runs.length} run${runs.length === 1 ? "" : "s"} finished successfully.`
                    : `${completedRunCount} of ${runs.length} runs finished successfully.`}{" "}
                  Review the results below.
                </p>
              </div>
              <small>{job.completedAt ? `Completed · ${formatTime(job.completedAt)}` : "Completed"}</small>
            </div>
          )}
          <div className="orchestration-summary">
            <div><span>Job</span><code>{job.id}</code></div>
            <div><span>Request</span><code>{job.requestId}</code></div>
            <div><span>Runs</span><strong>{runs.length}</strong></div>
            {runtimeState && (
              <div className={"orchestration-runtime-summary runtime-summary-" + runtimeState.state}>
                <span>Runtime</span>
                <strong><i aria-hidden="true" />{runtimeState.label}</strong>
                <small>{runtimeState.detail}</small>
              </div>
            )}
          </div>
          {job.status === "failed" && (
            <div className="orchestration-failure-card" role="alert">
              <span className="eyebrow">Needs attention</span>
              <strong>{errorTitle(job.errorText ?? "")}</strong>
              <p>{job.errorText ?? "The orchestration stopped before it could complete."}</p>
              <small>{errorGuidance(job.errorText ?? "", recoveryAttemptByRun.size > 0)}</small>
            </div>
          )}
          {activeStatuses.has(job.status) && runs.length > 0 && (
            <section className="orchestration-live-card" aria-live="polite">
              <div className="orchestration-live-heading">
                <div>
                  <span className="eyebrow">Live activity</span>
                  <h2>What the Agents are doing</h2>
                </div>
                <span className="orchestration-live-indicator"><i /> Updating live</span>
              </div>
              <div className="orchestration-live-grid">
                {runs.map((run) => {
                  const latest = latestMessageByRun.get(run.id);
                  const agentName = names.get(run.agentId) ?? run.agentId;
                  const staleWarning = staleRuntimeWarning(run, latest, now);
                  return (
                    <article className="orchestration-live-agent" key={run.id}>
                      <div className="orchestration-live-agent-heading">
                        <span className="orchestration-live-icon">{agentName.slice(0, 1).toUpperCase()}</span>
                        <div>
                          <strong>{agentName}</strong>
                          <small>{run.parentRunId ? "Delegated child" : "Project orchestrator"} · {elapsedLabel(run, now)}</small>
                        </div>
                        <span className={"run-state state-" + run.status}>{statusLabel(run.status)}</span>
                      </div>
                      <p>{runActivity(run, latest, names)}</p>
                      <div className="orchestration-live-track" aria-label={`Activity stage ${statusLabel(run.status)}`}>
                        <span style={{ width: `${activityProgress(run.status)}%` }} />
                      </div>
                      <small className={"orchestration-live-detail" + (staleWarning ? " orchestration-live-stale" : "")}>
                        {staleWarning ?? runtimeActivityDetail(run, latest)}
                      </small>
                    </article>
                  );
                })}
              </div>
              <p className="orchestration-live-help">Delegations, protected-resource checks, and results will appear in the timeline below as they happen.</p>
            </section>
          )}
          <div className="orchestration-columns">
            <section>
              <div className="orchestration-section-title"><span className="eyebrow">Run tree</span><strong>{runs.length} run{runs.length === 1 ? "" : "s"}</strong></div>
              <div className="orchestration-runs">
                {runs.map((run) => (
                  <article className="orchestration-run" key={run.id}>
                    <div><strong>{names.get(run.agentId) ?? run.agentId}</strong><span className={"run-state state-" + run.status}>{statusLabel(run.status)}</span></div>
                    <small>{run.parentRunId ? "Delegated child" : "Project orchestrator"} · Attempt {run.attempt}{run.errorText && !recoveryAttemptByRun.has(run.id) ? " · no retry recorded" : ""} · {run.id.slice(0, 8)}</small>
                    {run.errorText && (
                      <div className="orchestration-error-detail">
                        <span className="eyebrow">What went wrong</span>
                        <strong>{errorTitle(run.errorText)}</strong>
                        <p>{errorGuidance(run.errorText, recoveryAttemptByRun.has(run.id))}</p>
                        <code>{run.errorText}</code>
                      </div>
                    )}
                    {run.outputText && (
                      <ExpandableOutput
                        summary={runSummary(run)}
                        raw={rawRunOutput(run)}
                        expanded={expandedIds.has("run:" + run.id)}
                        onToggle={() => toggleExpanded("run:" + run.id)}
                      />
                    )}
                  </article>
                ))}
              </div>
            </section>
            <section>
              <div className="orchestration-section-title"><span className="eyebrow">Timeline</span><strong>{timelineMessages.length} event{timelineMessages.length === 1 ? "" : "s"}</strong></div>
              <div className="orchestration-timeline">
                {timelineMessages.map((message) => (
                  <article className={"orchestration-event event-" + message.messageType} key={message.id}>
                    <div><strong>{messageTitle(message, names)}</strong><span>{message.messageType.replaceAll("_", " ")} · {formatTime(message.createdAt)}</span></div>
                    {message.messageType === "error" ? (
                      <div className="orchestration-error-detail">
                        <span className="eyebrow">What went wrong</span>
                        <strong>{errorTitle(message.content)}</strong>
                        <p>{errorGuidance(message.content, Boolean(message.runId && recoveryAttemptByRun.has(message.runId)))}</p>
                        <code>{message.content}</code>
                      </div>
                    ) : expandableMessageTypes.has(message.messageType) ? (
                      <ExpandableOutput
                        summary={messageSummary(message)}
                        raw={rawMessageOutput(message)}
                        expanded={expandedIds.has("message:" + message.id)}
                        onToggle={() => toggleExpanded("message:" + message.id)}
                      />
                    ) : (
                      <p>{message.content}</p>
                    )}
                  </article>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}
    </section>
  );
}
