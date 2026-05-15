import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installSkillsFromSource,
  isSkillAgentType,
  type FailedSkillRecord,
  type InstalledSkillRecord,
  type SkillAgentType,
} from "agent-install/skill";
import {
  installMcpServerForAgent,
  isMcpAgentType,
  type McpServerConfig,
} from "agent-install/mcp";
import { VERSION } from "../version";
import { materializeSkillBundle } from "./bundle";
import {
  installCustomMcpServerForAgent,
  supportsCustomMcpAgent,
  type CustomMcpInstallResult,
} from "./custom-mcp";
import {
  entryFromInstallPlanItem,
  loadInstallRegistry,
  saveInstallRegistry,
  upsertInstallRegistryEntry,
} from "./registry";
import type { InstallAgentId, InstallPlan } from "./types";

export interface ApplyInstallOptions {
  binPath?: string;
  registryFile?: string;
  bundleRoot?: string;
}

export interface ApplyInstallItemResult {
  agent: InstallAgentId;
  skillsInstalled: InstalledSkillRecord[];
  skillsFailed: FailedSkillRecord[];
  mcp: CustomMcpInstallResult;
}

export interface ApplyInstallResult {
  bundlePath: string;
  items: ApplyInstallItemResult[];
}

interface ResolveMcpConfigRuntime {
  execPath: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  defaultBinPath: string;
}

const RAINDROP_BIN_PATH_ENV = "RAINDROP_BIN_PATH";
const MCP_ARGS = ["workshop", "mcp"] as const;

function isRaindropBinary(file: string): boolean {
  return path.basename(file).toLowerCase().startsWith("raindrop");
}

function absolutePath(file: string, cwd: string): string {
  return path.isAbsolute(file) ? file : path.resolve(cwd, file);
}

function sourceEntrypoint(argv: string[], cwd: string): string | null {
  const entry = argv[1];
  if (!entry || !/\.(c|m)?[jt]s$/.test(entry)) return null;

  const resolved = absolutePath(entry, cwd);
  return fs.existsSync(resolved) ? resolved : null;
}

function resolveMcpServerConfig(
  override: string | undefined,
  runtime: ResolveMcpConfigRuntime = {
    execPath: process.execPath,
    argv: process.argv,
    env: process.env,
    cwd: process.cwd(),
    defaultBinPath: path.join(os.homedir(), ".raindrop", "bin", "raindrop"),
  },
): McpServerConfig {
  if (override) {
    return { command: path.resolve(override), args: [...MCP_ARGS] };
  }

  const envBin = runtime.env[RAINDROP_BIN_PATH_ENV];
  if (envBin) {
    return { command: absolutePath(envBin, runtime.cwd), args: [...MCP_ARGS] };
  }

  if (isRaindropBinary(runtime.execPath)) {
    return { command: runtime.execPath, args: [...MCP_ARGS] };
  }

  const sourceEntry = sourceEntrypoint(runtime.argv, runtime.cwd);
  if (sourceEntry) {
    return { command: runtime.execPath, args: [sourceEntry, ...MCP_ARGS] };
  }

  if (fs.existsSync(runtime.defaultBinPath)) {
    return { command: runtime.defaultBinPath, args: [...MCP_ARGS] };
  }

  throw new Error(
    `install: could not resolve a runnable Raindrop binary for MCP. ` +
      `Run setup with --bin-path=<path>, or reinstall Raindrop so ${runtime.defaultBinPath} exists.`,
  );
}

function assertFullSupport(agent: InstallAgentId, scope: "global" | "local"): asserts agent is SkillAgentType {
  if (
    !isSkillAgentType(skillAgentFor(agent)) ||
    (!isMcpAgentType(mcpAgentFor(agent)) && !supportsCustomMcpAgent(mcpAgentFor(agent), scope))
  ) {
    throw new Error(`install: ${agent} does not support both Raindrop skills and MCP`);
  }
}

function skillAgentFor(agent: InstallAgentId): SkillAgentType {
  return (agent === "github-copilot-cli" ? "github-copilot" : agent) as SkillAgentType;
}

function mcpAgentFor(agent: InstallAgentId): InstallAgentId {
  return agent;
}

export async function applyInstallPlan(
  plan: InstallPlan,
  opts: ApplyInstallOptions = {},
): Promise<ApplyInstallResult> {
  const bundle = await materializeSkillBundle(opts.bundleRoot);
  const mcpConfig = resolveMcpServerConfig(opts.binPath);
  const registry = loadInstallRegistry(opts.registryFile);
  const results: ApplyInstallItemResult[] = [];

  for (const item of plan.items) {
    assertFullSupport(item.agent, item.scope);
    const isGlobal = item.scope === "global";
    const cwd = item.cwd ?? process.cwd();
    const skillAgent = skillAgentFor(item.agent);
    const mcpAgent = mcpAgentFor(item.agent);

    const skills = await installSkillsFromSource({
      source: bundle.skillsDir,
      agents: [skillAgent],
      global: isGlobal,
      cwd,
      mode: "symlink",
    });
    const mcp = isMcpAgentType(mcpAgent)
      ? installMcpServerForAgent("raindrop", mcpConfig, mcpAgent, {
          global: isGlobal,
          cwd,
        })
      : installCustomMcpServerForAgent("raindrop", mcpConfig, mcpAgent, item.scope);

    results.push({
      agent: item.agent,
      skillsInstalled: skills.installed,
      skillsFailed: skills.failed,
      mcp,
    });

    if (skills.failed.length === 0 && mcp.success) {
      upsertInstallRegistryEntry(registry, entryFromInstallPlanItem(item, VERSION));
    }
  }

  saveInstallRegistry(registry, opts.registryFile);
  return { bundlePath: bundle.skillsDir, items: results };
}

export const _internal = {
  resolveMcpServerConfig,
  sourceEntrypoint,
  RAINDROP_BIN_PATH_ENV,
};
