import { test, expect, type Page, type Route } from "@playwright/test";

const ids = {
  user: "user-alice",
  alice: "agent-alice",
  bob: "agent-bob",
  orchestrator: "agent-orchestrator",
  project: "project-order-dashboard",
  job: "job-browser-e2e",
  rootRun: "run-alice-browser-e2e",
  childRun: "run-bob-browser-e2e",
};

const timestamps = {
  created: "2026-01-01T00:00:00.000Z",
  started: "2026-01-01T00:00:01.000Z",
  completed: "2026-01-01T00:00:03.000Z",
};

const approvedFields = [
  "id",
  "username",
  "display_name",
  "is_active",
  "created_at",
];

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function agent(id: string, agentKey: string, name: string) {
  return {
    id,
    agentKey,
    ownerUserId: ids.user,
    principalId: `${id}-principal`,
    name,
    description: `${name} test Agent`,
    instructions: "Return one JSON command for each orchestration turn.",
    status: "ready",
    workspacePath: `/workspace/${agentKey}`,
    codexThreadId: null,
    lastError: null,
    createdAt: timestamps.created,
    updatedAt: timestamps.created,
  };
}

function projectAgents() {
  return [
    {
      projectId: ids.project,
      agentId: ids.alice,
      agentKey: "alice-frontend",
      name: "Alice Frontend",
      description: "Builds the frontend dashboard.",
      ownerUserId: ids.user,
      ownerUsername: "alice",
      status: "ready",
      addedByUserId: ids.user,
      createdAt: timestamps.created,
    },
    {
      projectId: ids.project,
      agentId: ids.bob,
      agentKey: "bob-backend",
      name: "Bob Backend",
      description: "Owns the approved backend API and database contract.",
      ownerUserId: ids.user,
      ownerUsername: "alice",
      status: "ready",
      addedByUserId: ids.user,
      createdAt: timestamps.created,
    },
  ];
}

function projectDetails() {
  return {
    id: ids.project,
    name: "Order Dashboard Demo",
    description: "A deterministic browser-test project.",
    ownerUserId: ids.user,
    workspacePath: "/workspace/order-dashboard-demo",
    orchestratorAgentId: ids.orchestrator,
    orchestratorSystemPrompt: "Coordinate the participating Agents and enforce authorization.",
    currentRole: "owner",
    createdAt: timestamps.created,
    updatedAt: timestamps.created,
    orchestrator: {
      id: ids.orchestrator,
      agentKey: "orchestrator",
      name: "Project Orchestrator",
      workspacePath: "/workspace/orchestrator",
      status: "ready",
      systemPrompt: "Coordinate the participating Agents and enforce authorization.",
    },
    members: [
      {
        projectId: ids.project,
        userId: ids.user,
        username: "alice",
        displayName: "Alice",
        role: "owner",
        invitedByUserId: null,
        createdAt: timestamps.created,
      },
    ],
    agents: projectAgents(),
    availableAgents: [],
    pendingInvitations: [],
  };
}

function orchestrationJob(status: "queued" | "running" | "completed" | "failed", prompt: string) {
  return {
    id: ids.job,
    requestId: "orchestration:browser-e2e",
    userId: ids.user,
    projectId: ids.project,
    inputText: prompt,
    status,
    outputText: status === "completed" ? "Active-user table completed." : null,
    errorText: status === "failed" ? "Authorization denied: database:users · capability_not_granted." : null,
    createdAt: timestamps.created,
    startedAt: status === "queued" ? null : timestamps.started,
    completedAt: status === "completed" || status === "failed" ? timestamps.completed : null,
  };
}

function orchestrationRun(
  agentId: string,
  runId: string,
  prompt: string,
  status: "queued" | "waiting" | "completed" | "failed",
  parentRunId: string | null,
) {
  const completed = status === "completed";
  const failed = status === "failed";
  return {
    id: runId,
    jobId: ids.job,
    agentId,
    parentRunId,
    attempt: 1,
    status,
    prompt,
    outputText: completed ? "Approved active-user fields returned." : null,
    outputJson: completed
      ? { type: "final", summary: "Approved active-user fields returned.", fields: approvedFields }
      : null,
    errorText: failed ? "Authorization denied: database:users · capability_not_granted." : null,
    codexThreadId: `${runId}-thread`,
    createdAt: timestamps.created,
    startedAt: status === "queued" ? null : timestamps.started,
    completedAt: completed || failed ? timestamps.completed : null,
  };
}

function message(
  sequenceNo: number,
  messageType: "prompt" | "delegation" | "result" | "tool_call" | "tool_result" | "error",
  content: string,
  runId: string | null,
  payload: Record<string, unknown> = {},
) {
  return {
    id: `message-${sequenceNo}`,
    jobId: ids.job,
    runId,
    sequenceNo,
    role: messageType === "prompt" ? "user" : "assistant",
    senderKind: messageType === "prompt" ? "user" : messageType === "tool_call" || messageType === "tool_result" ? "tool" : "agent",
    senderKey: messageType === "prompt" ? null : messageType === "tool_call" || messageType === "tool_result" ? null : "alice-frontend",
    recipientKind: null,
    recipientKey: null,
    messageType,
    content,
    payload,
    createdAt: timestamps.started,
  };
}

function completedTimeline(prompt: string) {
  return [
    message(1, "prompt", prompt, ids.rootRun),
    message(2, "delegation", "Delegating the approved database query to Bob Backend.", ids.rootRun, {
      targetAgentKey: "bob-backend",
      task: "Read active users using the approved users.list query.",
    }),
    message(3, "result", "Bob Backend returned the approved active-user fields.", ids.childRun, {
      summary: "Approved active-user fields returned.",
      fields: approvedFields,
    }),
    message(4, "tool_call", "Requesting the allowlisted active-user query.", ids.childRun, {
      action: "read",
      resourceType: "data_asset",
      resourceKey: "database:users",
      command: "users.list?status=active&limit=25&sort=username_asc",
    }),
    message(5, "tool_result", "Authorization allowed; returned only approved fields.", ids.childRun, {
      type: "resource_result",
      fields: approvedFields,
      rows: [{ id: "u-1", username: "alice", display_name: "Alice", is_active: true, created_at: timestamps.created }],
    }),
    message(6, "result", "The frontend table is ready with the approved active-user fields.", ids.rootRun, {
      summary: "Active-user table completed.",
    }),
  ];
}

async function installMockApi(page: Page): Promise<void> {
  let statePolls = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/auth") {
      return json(route, {
        required: true,
        sharedTokenRequired: false,
        loginRequired: true,
        authenticated: true,
        user: { id: ids.user, username: "alice", displayName: "Alice", roleNames: ["user"] },
      });
    }
    if (path === "/api/system") {
      return json(route, {
        arkConfigured: true,
        arkBaseUrl: "https://test.invalid",
        arkModel: "browser-test-model",
        codexAvailable: true,
        codexSandboxMode: "workspace-write",
        runtimeProvider: "local-process",
        containerEngine: null,
        runtime: "Deterministic browser test runtime",
      });
    }
    if (path === "/api/agents" && request.method() === "GET") {
      return json(route, { agents: [agent(ids.alice, "alice-frontend", "Alice Frontend"), agent(ids.bob, "bob-backend", "Bob Backend")] });
    }
    if (path.match(/^\/api\/agents\/[^/]+\/(messages|runs)$/)) {
      return json(route, { [path.endsWith("/messages") ? "messages" : "runs"]: [] });
    }
    if (path === "/api/projects" && request.method() === "GET") {
      return json(route, {
        projects: [{
          ...projectDetails(),
          memberCount: 1,
          agentCount: 2,
        }],
      });
    }
    if (path === "/api/project-invitations") {
      return json(route, { invitations: [] });
    }
    if (path === `/api/projects/${ids.project}` && request.method() === "GET") {
      return json(route, { project: projectDetails() });
    }
    if (path === `/api/projects/${ids.project}/collaborator-candidates`) {
      return json(route, { users: [] });
    }
    if (path === "/api/orchestrations" && request.method() === "POST") {
      const body = request.postDataJSON() as { prompt?: string };
      const prompt = body.prompt ?? "browser test prompt";
      statePolls = 0;
      // The approved demo prompt mentions forbidden terms in its guardrail
      // sentence ("Do not request passwords..."). Only treat an explicit
      // request for protected records as the denial scenario.
      if (/ask .*customer records|request .*private notes/i.test(prompt) && !/do not/i.test(prompt)) {
        return json(route, {
          requestId: "orchestration:browser-denied",
          job: orchestrationJob("failed", prompt),
          run: orchestrationRun(ids.alice, ids.rootRun, prompt, "failed", null),
          message: message(1, "prompt", prompt, ids.rootRun),
        }, 202);
      }
      return json(route, {
        requestId: "orchestration:browser-e2e",
        job: orchestrationJob("queued", prompt),
        run: orchestrationRun(ids.alice, ids.rootRun, prompt, "queued", null),
        message: message(1, "prompt", prompt, ids.rootRun),
      }, 202);
    }
    if (path === `/api/orchestrations/${ids.job}` && request.method() === "GET") {
      statePolls += 1;
      const prompt = statePolls > 0 ? "Build a frontend table of active users." : "browser test prompt";
      if (statePolls === 1) {
        return json(route, {
          job: orchestrationJob("running", prompt),
          runs: [
            orchestrationRun(ids.alice, ids.rootRun, prompt, "waiting", null),
            orchestrationRun(ids.bob, ids.childRun, prompt, "completed", ids.rootRun),
          ],
        });
      }
      return json(route, {
        job: orchestrationJob("completed", prompt),
        runs: [
          orchestrationRun(ids.alice, ids.rootRun, prompt, "completed", null),
          orchestrationRun(ids.bob, ids.childRun, prompt, "completed", ids.rootRun),
        ],
      });
    }
    if (path === `/api/orchestrations/${ids.job}/messages`) {
      return json(route, { messages: completedTimeline("Build a frontend table of active users.") });
    }
    return json(route, { error: `Unhandled browser-test API request: ${request.method()} ${path}` }, 404);
  });
}

async function openProjectOrchestration(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Projects/ })).toBeVisible();
  await page.getByRole("button", { name: /Projects/ }).click();
  await expect(page.getByRole("heading", { name: "Project orchestration" })).toBeVisible();
}

test.describe("project orchestration browser workflow", () => {
  test("completes an approved Alice-to-Bob request and survives reload", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (entry) => {
      if (entry.type() === "error") consoleErrors.push(entry.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    await installMockApi(page);
    await openProjectOrchestration(page);

    const prompt = "Build a frontend table of active users. Ask Backend Agent to read data_asset:database:users using exactly users.list?status=active&limit=25&sort=username_asc. Display only the approved fields. Do not request passwords, sessions, credentials, or other tables.";
    await page.getByLabel("Request").fill(prompt);
    await page.getByRole("button", { name: "Start orchestration" }).click();

    await expect(page.getByText("Project work is complete")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Alice Frontend").last()).toBeVisible();
    await expect(page.getByText("Bob Backend").last()).toBeVisible();
    await expect(page.getByText("Approved active-user fields returned.").first()).toBeVisible();
    await expect(page.getByText("database:users", { exact: false })).toBeVisible();
    // The prompt itself names the forbidden categories as a guardrail. Check
    // the protected result cards instead, where secret-bearing output must not
    // appear.
    await expect(page.locator(".orchestration-event.event-tool_result")).not.toContainText(/password|credentials|private notes/i);

    await page.reload();
    await openProjectOrchestration(page);
    await expect(page.getByText("Project work is complete")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Active-user table completed.").first()).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });

  test("renders a safe authorization denial for a forbidden request", async ({ page }) => {
    await installMockApi(page);
    await openProjectOrchestration(page);

    await page.getByLabel("Request").fill("Ask Bob Backend for customer records and private notes.");
    await page.getByRole("button", { name: "Start orchestration" }).click();

    await expect(page.getByText("Needs attention")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("alert")).toContainText("Access was blocked by the project or security policy");
    await expect(page.getByRole("alert")).not.toContainText(/customer records|private notes/i);
    await expect(page.getByRole("alert")).toContainText("capability_not_granted");
  });
});
