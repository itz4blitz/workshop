import {
  getSkillAgentConfig,
  getSkillAgentTypes,
  isSkillAgentType,
} from "agent-install/skill";
import {
  getMcpAgentConfig,
  getMcpAgentTypes,
  isMcpAgentType,
} from "agent-install/mcp";
import { getCustomMcpAgentIds } from "./custom-mcp";
import type { InstallAgentCapability, InstallAgentId, InstallScope } from "./types";

export interface DetectInstallAgentsOptions {
  scope?: InstallScope;
  cwd?: string;
}

export const APPROVED_AGENTS: readonly InstallAgentId[] = [
  "claude-code",
  "cursor",
  "codex",
  "github-copilot-cli",
  "opencode",
  "amp",
  "windsurf",
];

function skillAgentFor(agent: InstallAgentId): InstallAgentId {
  return agent === "github-copilot-cli" ? "github-copilot" : agent;
}

function mcpAgentFor(agent: InstallAgentId): InstallAgentId {
  return agent;
}

function displayName(agent: InstallAgentId): string {
  if (agent === "github-copilot-cli") return "GitHub Copilot CLI";
  if (isSkillAgentType(agent)) return getSkillAgentConfig(agent).displayName;
  if (isMcpAgentType(agent)) return getMcpAgentConfig(agent).displayName;
  return agent;
}

export function getSupportedInstallAgents(opts: DetectInstallAgentsOptions = {}): InstallAgentCapability[] {
  const scope = opts.scope ?? "global";
  const skillAgents = new Set<InstallAgentId>(getSkillAgentTypes());
  const mcpAgents = new Set<InstallAgentId>([...getMcpAgentTypes(), ...getCustomMcpAgentIds(scope)]);
  const agents = APPROVED_AGENTS.filter((agent) => skillAgents.has(agent) || mcpAgents.has(agent)).sort((a, b) =>
    displayName(a).localeCompare(displayName(b)),
  );

  return agents.map((agent) => ({
    agent,
    label: displayName(agent),
    detected: false,
    supportsSkills: skillAgents.has(skillAgentFor(agent)),
    supportsMcp: mcpAgents.has(mcpAgentFor(agent)),
  }));
}

export function agentLabel(agent: InstallAgentId): string {
  return displayName(agent);
}
