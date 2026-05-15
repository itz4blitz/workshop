import { expect, test } from "bun:test";
import { buildCopilotArgs, handleCopilotEvent } from "../src/copilot-cli-chat";
import type { AgentStreamEvent } from "../src/agent-chat";

function runEvent(raw: unknown) {
  const emitted: AgentStreamEvent[] = [];
  const providerSessions: string[] = [];
  const texts: string[] = [];
  const errors: string[] = [];

  const result = handleCopilotEvent(raw, {
    content: "",
    providerSessionId: null,
    messageContents: new Map<string, string>(),
    onProviderSession(sessionId) {
      providerSessions.push(sessionId);
    },
    onText(content) {
      texts.push(content);
    },
    onStatus() {},
    onError(content) {
      errors.push(content);
    },
    emit(event) {
      emitted.push(event);
    },
  });

  return { emitted, providerSessions, texts, errors, result };
}

test("Copilot CLI args include MCP wiring, JSON output, and resume support", () => {
  const previousModel = process.env.RAINDROP_WORKSHOP_COPILOT_MODEL;
  process.env.RAINDROP_WORKSHOP_COPILOT_MODEL = "gpt-5";
  try {
    const args = buildCopilotArgs({
      backendUrl: "http://localhost:5899",
      content: "hello",
      cwd: "/tmp/project",
      runId: "run_demo",
      resumeSessionId: "ses_demo",
    });

    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--allow-all-tools");
    expect(args).toContain("--additional-mcp-config");
    expect(args).toContain("--resume");
    expect(args).toContain("ses_demo");
    expect(args).toContain("--model");
    expect(args).toContain("gpt-5");
    const prompt = args[args.indexOf("-p") + 1];
    expect(prompt).toContain("You are replying inside the Raindrop Workshop chat pane.");
    expect(prompt).toContain("run_id: run_demo");
    expect(prompt).toContain("\nhello");
  } finally {
    if (previousModel === undefined) delete process.env.RAINDROP_WORKSHOP_COPILOT_MODEL;
    else process.env.RAINDROP_WORKSHOP_COPILOT_MODEL = previousModel;
  }
});

test("Copilot CLI session and tool events are normalized", () => {
  const startOutcome = runEvent({
    type: "session.start",
    data: {
      sessionId: "ses_demo",
      selectedModel: "gpt-5",
    },
  });
  const toolOutcome = runEvent({
    type: "tool.execution_start",
    data: {
      toolCallId: "tool_1",
      toolName: "bash",
      arguments: { command: "pwd" },
    },
  });
  const toolDoneOutcome = runEvent({
    type: "tool.execution_complete",
    data: {
      toolCallId: "tool_1",
      toolName: "bash",
      success: true,
      result: { output: "/tmp/project" },
    },
  });
  const textOutcome = runEvent({
    type: "assistant.message",
    data: {
      messageId: "msg_1",
      reasoningText: "Inspecting the workspace.",
      content: "hello from copilot",
    },
  });
  const usageOutcome = runEvent({
    type: "assistant.usage",
    data: {
      model: "gpt-5",
      inputTokens: 12,
      outputTokens: 34,
      cost: 0.001,
    },
  });
  const idleOutcome = runEvent({ type: "session.idle", data: { backgroundTasks: [] } });

  expect(startOutcome.providerSessions).toEqual(["ses_demo"]);
  expect(startOutcome.emitted.map((event) => event.type)).toEqual(["provider_session", "loadout"]);
  expect(toolOutcome.emitted.find((event) => event.type === "tool_start")).toMatchObject({
    type: "tool_start",
    id: "tool_1",
    name: "bash",
  });
  expect(toolDoneOutcome.emitted.find((event) => event.type === "tool_finish")).toMatchObject({
    type: "tool_finish",
    id: "tool_1",
    ok: true,
  });
  expect(textOutcome.texts).toEqual(["hello from copilot"]);
  expect(textOutcome.emitted.find((event) => event.type === "thinking_delta")).toMatchObject({
    type: "thinking_delta",
    content: "Inspecting the workspace.",
  });
  expect(usageOutcome.emitted.find((event) => event.type === "usage")).toMatchObject({
    type: "usage",
    input_tokens: 12,
    output_tokens: 34,
  });
  expect(idleOutcome.emitted.at(-1)).toEqual({ type: "done" });
});

test("Copilot CLI error events map into the Workshop error stream", () => {
  const outcome = runEvent({
    type: "session.error",
    data: {
      errorType: "authentication",
      message: "Authentication required",
    },
  });

  expect(outcome.errors).toEqual(["Authentication required"]);
  expect(outcome.emitted.map((event) => event.type)).toEqual(["error", "done"]);
});
