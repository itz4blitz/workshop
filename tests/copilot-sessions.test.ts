import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCopilotSession, listCopilotSessions } from "../src/copilot-sessions";

function makeSessionHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "workshop-copilot-home-"));
}

test("Copilot session parsing returns Workshop-scoped chats for the matching cwd", () => {
  const home = makeSessionHome();
  const sessionDir = path.join(home, "session-state", "ses_demo");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.copyFileSync(
    path.join(import.meta.dir, "fixtures", "copilot-events.jsonl"),
    path.join(sessionDir, "events.jsonl"),
  );

  const previousHome = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = home;
  try {
    const sessions = listCopilotSessions("/tmp/project");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "ses_demo",
      cwd: "/tmp/project",
      preview: "Reply with exactly: COPILOT-E2E-SIGNAL",
    });

    const detail = getCopilotSession("/tmp/project", "ses_demo");
    expect(detail).not.toBeNull();
    expect(detail?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(detail?.messages[0]?.content).toBe("Reply with exactly: COPILOT-E2E-SIGNAL");
    expect(detail?.messages[1]?.blocks?.some((block) => block.type === "tool" && block.name === "bash")).toBe(true);
    expect(detail?.messages[1]?.content).toContain("COPILOT-E2E-SIGNAL");
  } finally {
    if (previousHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
