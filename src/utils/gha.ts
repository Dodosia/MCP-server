import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import YAML from "yaml";

import { fileExists, readTextIfExists, toPosixRelative } from "./fs.js";

export interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

export interface WorkflowJob {
  name: string;
  steps: WorkflowStep[];
  env?: Record<string, unknown>;
}

export interface ParsedWorkflow {
  absolutePath: string;
  relativePath: string;
  rawText: string;
  jobs: Record<string, WorkflowJob>;
}

export interface RunCommandInfo {
  workflowFile: string;
  job: string;
  stepIndex: number;
  command: string;
}

export interface SetupRuntimeVersion {
  kind: "node" | "python";
  version: string;
  workflowFile: string;
  job: string;
  stepIndex: number;
}

interface ParseContext {
  repoPath: string;
  workflowPath: string;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

function asSteps(value: unknown): WorkflowStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((step) => asObject(step) as WorkflowStep);
}

function normalizeTextVersion(raw: string): string {
  return raw.trim().replace(/^v/i, "");
}

function extractVersionFromToolVersions(content: string, toolName: "nodejs" | "python"): string | null {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const [name, value] = trimmed.split(/\s+/, 2);
    if (name === toolName && value) {
      return normalizeTextVersion(value);
    }
  }
  return null;
}

function extractRequiresPythonFromPyproject(content: string): string | null {
  const match = content.match(/requires-python\s*=\s*["']([^"']+)["']/i);
  if (!match) {
    return null;
  }
  return normalizeTextVersion(match[1]);
}

async function resolveVersionFromFile(
  repoPath: string,
  versionFile: unknown,
): Promise<string | null> {
  if (typeof versionFile !== "string" || !versionFile.trim()) {
    return null;
  }
  const filePath = path.resolve(repoPath, versionFile.trim());
  const content = await readTextIfExists(filePath);
  if (!content) {
    return null;
  }
  return normalizeTextVersion(content.split(/\r?\n/, 1)[0] ?? "");
}

async function extractRuntimeVersionFromStep(
  step: WorkflowStep,
  context: ParseContext,
): Promise<SetupRuntimeVersion | null> {
  if (!step.uses || typeof step.uses !== "string") {
    return null;
  }

  const uses = step.uses.toLowerCase();
  const withBlock = asObject(step.with);

  if (uses.startsWith("actions/setup-node")) {
    const directVersion = withBlock["node-version"];
    if (typeof directVersion === "string" && directVersion.trim()) {
      return {
        kind: "node",
        version: normalizeTextVersion(directVersion),
        workflowFile: context.workflowPath,
        job: "",
        stepIndex: 0,
      };
    }

    const fromFile = await resolveVersionFromFile(context.repoPath, withBlock["node-version-file"]);
    if (fromFile) {
      return {
        kind: "node",
        version: fromFile,
        workflowFile: context.workflowPath,
        job: "",
        stepIndex: 0,
      };
    }

    return {
      kind: "node",
      version: "unknown",
      workflowFile: context.workflowPath,
      job: "",
      stepIndex: 0,
    };
  }

  if (uses.startsWith("actions/setup-python")) {
    const directVersion = withBlock["python-version"];
    if (typeof directVersion === "string" && directVersion.trim()) {
      return {
        kind: "python",
        version: normalizeTextVersion(directVersion),
        workflowFile: context.workflowPath,
        job: "",
        stepIndex: 0,
      };
    }

    const fromFile = await resolveVersionFromFile(context.repoPath, withBlock["python-version-file"]);
    if (fromFile) {
      return {
        kind: "python",
        version: fromFile,
        workflowFile: context.workflowPath,
        job: "",
        stepIndex: 0,
      };
    }

    return {
      kind: "python",
      version: "unknown",
      workflowFile: context.workflowPath,
      job: "",
      stepIndex: 0,
    };
  }

  return null;
}

export function extractMajor(version: string): string {
  const match = version.match(/(\d+)/);
  return match ? match[1] : "unknown";
}

export async function loadWorkflows(repoPath: string): Promise<ParsedWorkflow[]> {
  const files = await fg([".github/workflows/*.{yml,yaml}"], {
    cwd: repoPath,
    onlyFiles: true,
    dot: true,
  });

  const workflows: ParsedWorkflow[] = [];
  for (const relative of files) {
    const absolutePath = path.resolve(repoPath, relative);
    const rawText = await fs.readFile(absolutePath, "utf8");
    const parsed = YAML.parse(rawText) as Record<string, unknown>;
    const jobsRaw = asObject(parsed.jobs);
    const jobs: Record<string, WorkflowJob> = {};

    for (const [jobName, jobValue] of Object.entries(jobsRaw)) {
      const jobObj = asObject(jobValue);
      jobs[jobName] = {
        name: jobName,
        steps: asSteps(jobObj.steps),
        env: asObject(jobObj.env),
      };
    }

    workflows.push({
      absolutePath,
      relativePath: toPosixRelative(repoPath, absolutePath),
      rawText,
      jobs,
    });
  }

  return workflows;
}

export async function collectSetupRuntimeVersions(repoPath: string): Promise<SetupRuntimeVersion[]> {
  const workflows = await loadWorkflows(repoPath);
  const versions: SetupRuntimeVersion[] = [];

  for (const workflow of workflows) {
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      for (let i = 0; i < job.steps.length; i += 1) {
        const version = await extractRuntimeVersionFromStep(job.steps[i], {
          repoPath,
          workflowPath: workflow.relativePath,
        });
        if (version) {
          versions.push({
            ...version,
            job: jobName,
            stepIndex: i,
          });
        }
      }
    }
  }

  return versions;
}

export async function collectRunCommands(repoPath: string): Promise<RunCommandInfo[]> {
  const workflows = await loadWorkflows(repoPath);
  const commands: RunCommandInfo[] = [];

  for (const workflow of workflows) {
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      for (let i = 0; i < job.steps.length; i += 1) {
        const runValue = job.steps[i].run;
        if (typeof runValue === "string" && runValue.trim()) {
          commands.push({
            workflowFile: workflow.relativePath,
            job: jobName,
            stepIndex: i,
            command: runValue.trim(),
          });
        }
      }
    }
  }

  return commands;
}

export async function getLocalNodeVersions(repoPath: string): Promise<Array<{ source: string; version: string }>> {
  const versions: Array<{ source: string; version: string }> = [];

  const nvmrcPath = path.resolve(repoPath, ".nvmrc");
  const nvmrc = await readTextIfExists(nvmrcPath);
  if (nvmrc) {
    versions.push({ source: ".nvmrc", version: normalizeTextVersion(nvmrc.split(/\r?\n/, 1)[0] ?? "") });
  }

  const toolVersionsPath = path.resolve(repoPath, ".tool-versions");
  const toolVersions = await readTextIfExists(toolVersionsPath);
  if (toolVersions) {
    const nodeVersion = extractVersionFromToolVersions(toolVersions, "nodejs");
    if (nodeVersion) {
      versions.push({ source: ".tool-versions(nodejs)", version: nodeVersion });
    }
  }

  const packageJsonPath = path.resolve(repoPath, "package.json");
  if (await fileExists(packageJsonPath)) {
    const packageRaw = await fs.readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(packageRaw) as { engines?: { node?: string } };
    const engineNode = pkg.engines?.node;
    if (typeof engineNode === "string" && engineNode.trim()) {
      versions.push({ source: "package.json engines.node", version: normalizeTextVersion(engineNode) });
    }
  }

  return versions;
}

export async function getLocalPythonVersions(repoPath: string): Promise<Array<{ source: string; version: string }>> {
  const versions: Array<{ source: string; version: string }> = [];

  const pythonVersionPath = path.resolve(repoPath, ".python-version");
  const pyVer = await readTextIfExists(pythonVersionPath);
  if (pyVer) {
    versions.push({ source: ".python-version", version: normalizeTextVersion(pyVer.split(/\r?\n/, 1)[0] ?? "") });
  }

  const toolVersionsPath = path.resolve(repoPath, ".tool-versions");
  const toolVersions = await readTextIfExists(toolVersionsPath);
  if (toolVersions) {
    const pythonVersion = extractVersionFromToolVersions(toolVersions, "python");
    if (pythonVersion) {
      versions.push({ source: ".tool-versions(python)", version: pythonVersion });
    }
  }

  const pyprojectPath = path.resolve(repoPath, "pyproject.toml");
  const pyproject = await readTextIfExists(pyprojectPath);
  if (pyproject) {
    const requiresPython = extractRequiresPythonFromPyproject(pyproject);
    if (requiresPython) {
      versions.push({ source: "pyproject.toml requires-python", version: requiresPython });
    }
  }

  return versions;
}

export async function loadSpecificWorkflow(
  repoPath: string,
  workflowFile: string,
): Promise<{ absolutePath: string; relativePath: string; rawText: string; parsed: Record<string, unknown> }> {
  const normalized = workflowFile.replace(/^\/+/, "");
  const absolutePath = path.resolve(repoPath, normalized);
  const rawText = await fs.readFile(absolutePath, "utf8");
  const parsed = YAML.parse(rawText) as Record<string, unknown>;

  return {
    absolutePath,
    relativePath: toPosixRelative(repoPath, absolutePath),
    rawText,
    parsed,
  };
}
