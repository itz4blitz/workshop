import { expect, test } from "bun:test";
import { defaultAgentLoadout } from "../src/agent-chat";
import {
  AGENT_PROVIDER_IDS,
  parseAgentProvider,
  providerAnnotationSource,
  providerLabel,
} from "../src/agent-provider";

test("Copilot CLI is part of the canonical provider registry", () => {
  expect(AGENT_PROVIDER_IDS).toContain("copilot");
  expect(parseAgentProvider("copilot")).toBe("copilot");
  expect(providerLabel("copilot")).toBe("GitHub Copilot CLI");
  expect(providerAnnotationSource("copilot")).toBe("copilot");
});

test("Copilot CLI gets a provider-specific default slash command set", () => {
  expect(defaultAgentLoadout("copilot").slash_commands).toEqual([
    "/clear",
    "/resume",
    "/plan",
    "/review",
    "/mcp",
    "/pr",
  ]);
});
