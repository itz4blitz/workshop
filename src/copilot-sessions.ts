import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ClaudeChatMessage,
  ClaudeChatMessageBlock,
  ClaudeSessionDetail,
  ClaudeSessionSummary,
} from "./claude-sessions";

const MAX_SESSION_DIRS = 300;

function copilotStateDir(): string {
  return path.join(process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"), "session-state");
}

export function listCopilotSessions(cwd: string): ClaudeSessionSummary[] {
  return copilotSessionDirs()
    .map((dir) => readCopilotSessionDir(dir))
    .filter((session): session is ClaudeSessionDetail => !!session && session.cwd === cwd)
    .sort((a, b) => (Date.parse(b.updated_at ?? "") || 0) - (Date.parse(a.updated_at ?? "") || 0))
    .map(({ messages: _messages, ...summary }) => summary);
}

export function getCopilotSession(cwd: string, sessionId: string): ClaudeSessionDetail | null {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  for (const dir of copilotSessionDirs()) {
    if (path.basename(dir) !== sessionId) continue;
    const session = readCopilotSessionDir(dir);
    if (session?.cwd === cwd && session.id === sessionId) return session;
  }
  return null;
}

function copilotSessionDirs(): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(copilotStateDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(copilotStateDir(), entry.name))
    .sort((a, b) => safeMtimeMs(path.join(b, "events.jsonl")) - safeMtimeMs(path.join(a, "events.jsonl")))
    .slice(0, MAX_SESSION_DIRS);
}

function readCopilotSessionDir(dir: string): ClaudeSessionDetail | null {
  const stateDir = path.resolve(copilotStateDir());
  const resolvedDir = path.resolve(dir);
  const relative = path.relative(stateDir, resolvedDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;

  const filePath = path.join(resolvedDir, "events.jsonl");
  if (!fs.existsSync(filePath)) return null;

  let id = path.basename(resolvedDir);
  let cwd = "";
  let createdAt: string | null = null;
  let updatedAt: string | null = null;
  let lastPrompt: string | null = null;
  let workshopTurnOpen = false;
  let sawWorkshopMessage = false;
  const messages: ClaudeChatMessage[] = [];
  const toolBlocks = new Map<string, Extract<ClaudeChatMessageBlock, { type: "tool" }>>();
  let assistantBlocks: ClaudeChatMessageBlock[] = [];
  let assistantTimestamp: string | null = null;

  const flushAssistant = () => {
    if (!assistantBlocks.length) return;
    const content = assistantBlocksText(assistantBlocks);
    if (content.trim()) {
      messages.push({
        id: `${id}-${messages.length}`,
        role: "assistant",
        content,
        blocks: [...assistantBlocks],
        timestamp: assistantTimestamp,
      });
    }
    assistantBlocks = [];
    assistantTimestamp = null;
  };

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const event = parseLine(line);
    if (!event) continue;
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : null;
    if (timestamp) {
      createdAt ??= timestamp;
      updatedAt = timestamp;
    }

    if (event.type === "session.start" || event.type === "session.resume") {
      const data = objectValue(event.data);
      if (typeof data?.sessionId === "string") id = data.sessionId;
      const context = objectValue(data?.context);
      if (typeof context?.cwd === "string") cwd = context.cwd;
      continue;
    }

    if (event.type === "user.message") {
      flushAssistant();
      const data = objectValue(event.data);
      const content = stringValue(data?.content) ?? "";
      if (!isWorkshopUserMessage(content)) {
        workshopTurnOpen = false;
        continue;
      }
      const visibleContent = stripWorkshopContext(content);
      if (!visibleContent.trim()) continue;
      workshopTurnOpen = true;
      sawWorkshopMessage = true;
      lastPrompt = visibleContent;
      messages.push({
        id: `${id}-${messages.length}`,
        role: "user",
        content: visibleContent,
        blocks: [{ type: "text", text: visibleContent }],
        timestamp,
      });
      continue;
    }

    if (!workshopTurnOpen) continue;

    if (event.type === "tool.execution_start") {
      const data = objectValue(event.data);
      const toolCallId = stringValue(data?.toolCallId) ?? `${id}-tool-${assistantBlocks.length}`;
      const mcpServerName = stringValue(data?.mcpServerName);
      const mcpToolName = stringValue(data?.mcpToolName);
      const toolName = mcpServerName && mcpToolName
        ? `${mcpServerName}.${mcpToolName}`
        : stringValue(data?.toolName) ?? "tool";
      const block: Extract<ClaudeChatMessageBlock, { type: "tool" }> = {
        type: "tool",
        id: toolCallId,
        name: toolName,
        input_preview: previewValue(data?.arguments),
      };
      toolBlocks.set(toolCallId, block);
      assistantBlocks.push(block);
      assistantTimestamp ??= timestamp;
      continue;
    }

    if (event.type === "tool.execution_complete") {
      const data = objectValue(event.data);
      const toolCallId = stringValue(data?.toolCallId);
      const block = toolCallId ? toolBlocks.get(toolCallId) : null;
      if (block) {
        block.ok = data?.success === true;
        block.output_preview = previewValue(data?.result ?? data?.error);
      }
      continue;
    }

    if (event.type === "assistant.message") {
      const data = objectValue(event.data);
      const reasoning = stringValue(data?.reasoningText);
      const content = stringValue(data?.content);
      if (reasoning) assistantBlocks.push({ type: "thinking", text: reasoning });
      if (content) assistantBlocks.push({ type: "text", text: content });
      assistantTimestamp ??= timestamp;
      continue;
    }

    if (event.type === "session.error") {
      const data = objectValue(event.data);
      const message = stringValue(data?.message);
      if (message) {
        assistantBlocks.push({ type: "text", text: message });
        assistantTimestamp ??= timestamp;
      }
      continue;
    }

    if (event.type === "session.idle") {
      flushAssistant();
      workshopTurnOpen = false;
    }
  }

  flushAssistant();

  if (!sawWorkshopMessage || !cwd) return null;
  const previewMessage = [...messages].reverse().find((message) => message.role === "user") ?? messages[messages.length - 1];
  return {
    id,
    path: filePath,
    cwd,
    created_at: createdAt,
    updated_at: updatedAt,
    message_count: messages.length,
    last_prompt: lastPrompt,
    preview: previewText(lastPrompt || previewMessage?.content || null),
    messages,
  };
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function isWorkshopUserMessage(content: string): boolean {
  return content.includes("<workshop_message>") || content.includes("Raindrop Workshop chat pane");
}

function stripWorkshopContext(content: string): string {
  const envelopeIndex = content.indexOf("<workshop_message>");
  if (envelopeIndex >= 0) {
    return content.slice(envelopeIndex).replace(/^<workshop_message>[\s\S]*?<\/workshop_message>\s*/m, "").trim();
  }
  return content.trim();
}

function previewText(value: string | null): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function previewValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
}

function assistantBlocksText(blocks: ClaudeChatMessageBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text" || block.type === "thinking") return block.text;
      return `[tool: ${block.name}]`;
    })
    .filter(Boolean)
    .join("\n");
}

function safeMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export const _internal = {
  stripWorkshopContext,
};
