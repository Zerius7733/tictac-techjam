import { describe, expect, it } from "vitest";
import { buildCodexArgs, formatRunnerPrompt, parseCodexEventLine } from "./codex-runner.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("passes a runtime output schema when one is requested", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "return the collaboration command",
        threadId: null,
        outputSchemaPath: "/tmp/orchestration-output.schema.json",
      },
      "workspace-write",
    );

    expect(args).toContain("--output-schema");
    expect(args).toContain("/tmp/orchestration-output.schema.json");
    expect(args.slice(-1)).toEqual(["return the collaboration command"]);
  });

  it("includes authenticated human context without credentials", () => {
    const prompt = formatRunnerPrompt({
      agentId: "agent",
      workspacePath: "/tmp/workspace",
      prompt: "Who am I?",
      threadId: null,
      humanIdentity: {
        username: "alice",
        displayName: "Alice",
        roleNames: ["developer"],
      },
    });

    expect(prompt).toContain('"username":"alice"');
    expect(prompt).toContain("The human chatting with you is this authenticated user");
    expect(prompt).toContain("Who am I?");
    expect(prompt).not.toContain("sessionToken");
    expect(prompt).not.toContain("agt_");
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });
});
