import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import {
  agentAnnotationSource,
  defaultAgentLoadout,
  raindropMcpToolList,
  resolveWorkshopMcpCommand,
  type AgentCliChatHandlers,
  type AgentCliChatInput,
  type AgentCliChatResult,
  type AgentLoadout,
  type AgentStreamEvent,
} from "./agent-chat";
import { getCopilotSession } from "./copilot-sessions";

export type CopilotCliChatInput = AgentCliChatInput;
export type CopilotCliChatHandlers = AgentCliChatHandlers;
export type CopilotCliChatResult = AgentCliChatResult;

export async function runCopilotCliChat(
  input: CopilotCliChatInput,
  handlers: CopilotCliChatHandlers,
): Promise<CopilotCliChatResult> {
  const args = buildCopilotArgs(input);
  const child = spawn(process.env.RAINDROP_WORKSHOP_COPILOT_BIN ?? "copilot", args, {
    cwd: input.cwd,
    env: {
      ...process.env,
      GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: process.env.GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS ?? "true",
      GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS: process.env.GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS ?? "true",
      GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP: process.env.GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP ?? "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (input.abortSignal) {
    if (input.abortSignal.aborted) child.kill("SIGINT");
    input.abortSignal.addEventListener("abort", () => child.kill("SIGINT"), { once: true });
  }
  return consumeCopilotStream(child, input, handlers);
}

export function buildCopilotArgs(input: CopilotCliChatInput): string[] {
  const mcpCommand = resolveWorkshopMcpCommand();
  const mcpConfig = {
    mcpServers: {
      raindrop: {
        type: "local",
        command: mcpCommand.command,
        args: mcpCommand.args,
        env: {
          RAINDROP_WORKSHOP_URL: input.backendUrl,
          RAINDROP_WORKSHOP_AGENT_PROVIDER: "copilot",
          RAINDROP_WORKSHOP_ANNOTATION_SOURCE: agentAnnotationSource("copilot"),
        },
        tools: ["*"],
      },
    },
  };

  const args = [
    "-C",
    input.cwd,
    "-p",
    userPrompt(input),
    "--output-format",
    "json",
    "--stream",
    "on",
    "--allow-all-tools",
    "--no-ask-user",
    "--additional-mcp-config",
    JSON.stringify(mcpConfig),
  ];

  const model = process.env.RAINDROP_WORKSHOP_COPILOT_MODEL;
  if (model) args.push("--model", model);
  if (input.resumeSessionId) {
    args.push("--resume", input.resumeSessionId);
  } else {
    args.push("-n", `Raindrop Workshop ${Date.now().toString(36)}`);
  }
  return args;
}

function directReplySystemPrompt(input: CopilotCliChatInput): string {
  const runInstruction = input.runId
    ? `The current Workshop trace is ${input.runId}. Use the Raindrop trace tools as needed when the user asks about "this trace" or the trace context matters; get_run_outline is usually the fastest first read, and get_span_payload is for exact raw payload evidence.`
    : "No Workshop trace is currently selected.";

  return [
    "You are replying inside the Raindrop Workshop chat pane.",
    "Use normal assistant text as your final answer. Markdown is supported.",
    "If the user asks you to reply with exact text, return only that exact text.",
    "Use Raindrop MCP tools to inspect traces, read span payloads, annotate findings, and show evidence in the UI when those tools are available.",
    "The Raindrop MCP server is configured as `raindrop` with these tools:",
    raindropMcpToolList(),
    "If the user asks what Workshop tools are available, answer from that list instead of saying no tools are visible.",
    runInstruction,
  ].join(" ");
}

function userPrompt(input: CopilotCliChatInput): string {
  const lines = [
    directReplySystemPrompt(input),
    "",
    "<workshop_message>",
  ];
  if (input.sessionId) lines.push(`session_id: ${input.sessionId}`);
  if (input.userMessageId) lines.push(`message_id: ${input.userMessageId}`);
  if (input.runId) lines.push(`run_id: ${input.runId}`);
  lines.push("</workshop_message>", "", input.content);
  return lines.join("\n");
}

function consumeCopilotStream(
  child: ChildProcessByStdio<null, Readable, Readable>,
  input: CopilotCliChatInput,
  handlers: CopilotCliChatHandlers,
): Promise<CopilotCliChatResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let content = "";
    let providerSessionId: string | null = input.resumeSessionId ?? null;
    let doneEmitted = false;
    const messageContents = new Map<string, string>();

    const applyEvent = (event: unknown) => {
      const next = handleCopilotEvent(event, {
        content,
        providerSessionId,
        messageContents,
        onProviderSession(sessionId) {
          providerSessionId = sessionId;
          handlers.onProviderSession(sessionId);
        },
        onText(nextContent) {
          content = nextContent;
          handlers.onText(nextContent);
        },
        onStatus(status) {
          handlers.onStatus(status);
        },
        onError(nextError) {
          handlers.onError?.(nextError);
        },
        emit(event) {
          if (event.type === "done") doneEmitted = true;
          handlers.onEvent?.(event);
        },
      });
      content = next.content;
      providerSessionId = next.providerSessionId;
    };

    child.on("error", reject);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = parseJsonLine(line);
        if (!event) continue;
        applyEvent(event);
      }
    });
    child.on("close", (code, signal) => {
      if (stdout.trim()) {
        const event = parseJsonLine(stdout);
        if (event) applyEvent(event);
      }
      if ((!content || code === 0) && providerSessionId) {
        const session = getCopilotSession(input.cwd, providerSessionId);
        const assistant = session?.messages.filter((message) => message.role === "assistant").at(-1);
        if (assistant?.content && assistant.content !== content) {
          content = assistant.content;
          handlers.onText(content);
        }
      }
      if (!doneEmitted) handlers.onEvent?.({ type: "done" });
      resolve({ code, signal, stderr });
    });
  });
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function handleCopilotEvent(
  raw: unknown,
  state: {
    content: string;
    providerSessionId: string | null;
    messageContents: Map<string, string>;
    onProviderSession(sessionId: string): void;
    onText(content: string): void;
    onStatus(status: string): void;
    onError(content: string): void;
    emit(event: AgentStreamEvent): void;
  },
): { content: string; providerSessionId: string | null } {
  if (!raw || typeof raw !== "object") return state;
  const event = raw as Record<string, unknown>;

  if (event.type === "session.start" || event.type === "session.resume") {
    const data = objectValue(event.data);
    const sessionId = stringValue(data?.sessionId) ?? state.providerSessionId;
    if (sessionId && sessionId !== state.providerSessionId) {
      state.onProviderSession(sessionId);
      state.emit({ type: "provider_session", sessionId });
    }
    state.emit({ type: "loadout", ...copilotLoadout(stringValue(data?.selectedModel) ?? undefined) });
    return { content: state.content, providerSessionId: sessionId };
  }

  if (event.type === "assistant.message_delta") {
    const data = objectValue(event.data);
    const messageId = stringValue(data?.messageId) ?? "message";
    const nextContent = (state.messageContents.get(messageId) ?? "") + (stringValue(data?.delta) ?? "");
    state.messageContents.set(messageId, nextContent);
    state.onText(nextContent);
    return { content: nextContent, providerSessionId: state.providerSessionId };
  }

  if (event.type === "assistant.message") {
    const data = objectValue(event.data);
    const reasoning = stringValue(data?.reasoningText);
    const content = stringValue(data?.content);
    const messageId = stringValue(data?.messageId);
    if (reasoning) state.emit({ type: "thinking_delta", content: reasoning });
    if (content) {
      if (messageId) state.messageContents.set(messageId, content);
      state.onText(content);
      return { content, providerSessionId: state.providerSessionId };
    }
    return { content: state.content, providerSessionId: state.providerSessionId };
  }

  if (event.type === "tool.execution_start") {
    const data = objectValue(event.data);
    const serverName = stringValue(data?.mcpServerName);
    const serverToolName = stringValue(data?.mcpToolName);
    state.emit({
      type: "tool_start",
      id: stringValue(data?.toolCallId) ?? "tool",
      name: serverName && serverToolName ? `${serverName}.${serverToolName}` : stringValue(data?.toolName) ?? "tool",
      input_preview: previewValue(data?.arguments),
    });
    return { content: state.content, providerSessionId: state.providerSessionId };
  }

  if (event.type === "tool.execution_complete") {
    const data = objectValue(event.data);
    state.emit({
      type: "tool_finish",
      id: stringValue(data?.toolCallId) ?? "tool",
      ok: data?.success === true,
      output_preview: previewValue(data?.result ?? data?.error),
    });
    return { content: state.content, providerSessionId: state.providerSessionId };
  }

  if (event.type === "tool.execution_progress") {
    const data = objectValue(event.data);
    const message = stringValue(data?.progressMessage);
    if (message) {
      state.onStatus(message);
      state.emit({ type: "status", content: message });
    }
    return { content: state.content, providerSessionId: state.providerSessionId };
  }

  if (event.type === "assistant.usage") {
    const data = objectValue(event.data);
    state.emit({
      type: "usage",
      input_tokens: numberValue(data?.inputTokens),
      output_tokens: numberValue(data?.outputTokens),
      cost_usd: numberValue(data?.cost),
    });
    return { content: state.content, providerSessionId: state.providerSessionId };
  }

  if (event.type === "session.error") {
    const data = objectValue(event.data);
    const message = stringValue(data?.message) ?? "Copilot CLI returned an error.";
    state.onError(message);
    state.emit({ type: "error", content: message });
    state.emit({ type: "done" });
    return { content: state.content, providerSessionId: state.providerSessionId };
  }

  if (event.type === "session.idle") {
    state.emit({ type: "done" });
  }

  return { content: state.content, providerSessionId: state.providerSessionId };
}

function copilotLoadout(model?: string): AgentLoadout {
  return {
    ...defaultAgentLoadout("copilot"),
    model,
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function previewValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}
