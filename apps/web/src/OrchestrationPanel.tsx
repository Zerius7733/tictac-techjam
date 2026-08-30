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
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );

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
              <option key={agent.id} value={agent.id}>{agent.name}</option>
            ))}
          </select>
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
                    {run.outputText && <p>{run.outputText}</p>}
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
                    <p>{message.content}</p>
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
