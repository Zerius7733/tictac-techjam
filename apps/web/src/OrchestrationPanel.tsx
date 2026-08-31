import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api";
import type {
  Agent,
  OrchestrationJob,
  OrchestrationMessage,
  OrchestrationRun,
} from "./types";

interface OrchestrationPanelProps {
  agents: Agent[];
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

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

function messageTitle(message: OrchestrationMessage, names: Map<string, string>): string {
  if (message.senderKind === "agent" && message.senderKey) {
    return names.get(message.senderKey) ?? message.senderKey;
  }
  if (message.senderKind === "orchestrator") return "Authorization gateway";
  if (message.senderKind === "system") return "System";
  return "You";
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
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
  return Object.keys(message.payload).length > 0
    ? JSON.stringify(message.payload, null, 2)
    : message.content;
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

export function OrchestrationPanel({ agents }: OrchestrationPanelProps) {
  const availableAgents = useMemo(
    () => agents.filter((agent) => agent.status !== "archived"),
    [agents],
  );
  const [agentId, setAgentId] = useState(availableAgents[0]?.id ?? "");
  const [prompt, setPrompt] = useState(
    "Build an order dashboard. Ask the order-service Agent for the approved schema and do not request customer records.",
  );
  const [job, setJob] = useState<OrchestrationJob | null>(null);
  const [runs, setRuns] = useState<OrchestrationRun[]>([]);
  const [messages, setMessages] = useState<OrchestrationMessage[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!availableAgents.some((agent) => agent.id === agentId)) {
      setAgentId(availableAgents[0]?.id ?? "");
    }
  }, [agentId, availableAgents]);

  useEffect(() => {
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
  }, [job?.id, job?.status]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!agentId || !prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createOrchestration({
        agentId,
        prompt: prompt.trim(),
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
      new Map(
        agents.flatMap((agent) => [
          [agent.id, agent.name],
          [agent.agentKey, agent.name],
        ]),
      ),
    [agents],
  );
  const selectedAgent = availableAgents.find((agent) => agent.id === agentId);
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
          <span className="eyebrow">Multi-Agent workflow</span>
          <h1>Orchestration playground</h1>
          <p>Run a root Agent, inspect delegation, and watch authorization decisions arrive in order.</p>
        </div>
        {job && <span className={"orchestration-status status-" + job.status}>{statusLabel(job.status)}</span>}
      </header>

      {error && <div className="error-banner" role="alert">{error}</div>}

      <form className="orchestration-form" onSubmit={submit}>
        <label>
          Root Agent
          <select value={agentId} onChange={(event) => setAgentId(event.target.value)} disabled={busy || availableAgents.length === 0}>
            {availableAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name} · {agent.agentKey}</option>
            ))}
          </select>
          {selectedAgent && (
            <small className="orchestration-field-hint">
              Delegation key: <code>{selectedAgent.agentKey}</code>
            </small>
          )}
        </label>
        <label>
          Request
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} maxLength={50_000} disabled={busy || Boolean(job && activeStatuses.has(job.status))} />
        </label>
        <div className="orchestration-actions">
          <button className="button button-primary" disabled={busy || !agentId || !prompt.trim() || Boolean(job && activeStatuses.has(job.status))}>
            {busy ? "Working…" : "Start orchestration"}
          </button>
          {job && activeStatuses.has(job.status) && (
            <button type="button" className="button button-danger" onClick={() => void cancel()} disabled={busy}>Cancel job</button>
          )}
          {job && !activeStatuses.has(job.status) && (
            <button type="button" className="button button-ghost" onClick={() => { setJob(null); setRuns([]); setMessages([]); setError(null); }}>New job</button>
          )}
        </div>
      </form>

      {job && (
        <div className="orchestration-content">
          <div className="orchestration-summary">
            <div><span>Job</span><code>{job.id}</code></div>
            <div><span>Request</span><code>{job.requestId}</code></div>
            <div><span>Runs</span><strong>{runs.length}</strong></div>
          </div>
          <div className="orchestration-columns">
            <section>
              <div className="orchestration-section-title"><span className="eyebrow">Run tree</span><strong>{runs.length} run{runs.length === 1 ? "" : "s"}</strong></div>
              <div className="orchestration-runs">
                {runs.map((run) => (
                  <article className="orchestration-run" key={run.id}>
                    <div><strong>{names.get(run.agentId) ?? run.agentId}</strong><span className={"run-state state-" + run.status}>{statusLabel(run.status)}</span></div>
                    <small>{run.parentRunId ? "Delegated child" : "Root run"} · {run.id.slice(0, 8)}</small>
                    {run.errorText && <p className="orchestration-error">{run.errorText}</p>}
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
              <div className="orchestration-section-title"><span className="eyebrow">Timeline</span><strong>{messages.length} event{messages.length === 1 ? "" : "s"}</strong></div>
              <div className="orchestration-timeline">
                {messages.map((message) => (
                  <article className={"orchestration-event event-" + message.messageType} key={message.id}>
                    <div><strong>{messageTitle(message, names)}</strong><span>{message.messageType.replaceAll("_", " ")} · {formatTime(message.createdAt)}</span></div>
                    {expandableMessageTypes.has(message.messageType) ? (
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
