import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import YAML from "yaml";

import { fileExists, readTextIfExists, toPosixRelative } from "./fs.js";

function asObject(value) {
  if (value && typeof value === "object") {
    return value;
  }
  return {};
}

function asSteps(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((step) => asObject(step));
}

function normalizeTextVersion(raw) {
  return raw.trim().replace(/^v/i, "");
}

function extractVersionFromToolVersions(content, toolName) {
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

function extractRequiresPythonFromPyproject(content) {
  const match = content.match(/requires-python\s*=\s*["']([^"']+)["']/i);
  if (!match) {
    return null;
  }
  return normalizeTextVersion(match[1]);
}

async function resolveVersionFromFile(repoPath, versionFile) {
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

async function extractRuntimeVersionFromStep(step, context) {
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

export function extractMajor(version) {
  const match = version.match(/(\d+)/);
  return match ? match[1] : "unknown";
}

export async function loadWorkflows(repoPath) {
  const files = await fg([".github/workflows/*.{yml,yaml}"], {
    cwd: repoPath,
    onlyFiles: true,
    dot: true,
  });

  const workflows = [];
  for (const relative of files) {
    const absolutePath = path.resolve(repoPath, relative);
    const rawText = await fs.readFile(absolutePath, "utf8");
    const parsed = YAML.parse(rawText);
    const jobsRaw = asObject(parsed.jobs);
    const jobs = {};

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

export async function collectSetupRuntimeVersions(repoPath) {
  const workflows = await loadWorkflows(repoPath);
  const versions = [];

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

export async function collectRunCommands(repoPath) {
  const workflows = await loadWorkflows(repoPath);
  const commands = [];

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

export async function getLocalNodeVersions(repoPath) {
  const versions = [];

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
    const pkg = JSON.parse(packageRaw);
    const engineNode = pkg.engines?.node;
    if (typeof engineNode === "string" && engineNode.trim()) {
      versions.push({ source: "package.json engines.node", version: normalizeTextVersion(engineNode) });
    }
  }

  return versions;
}

export async function getLocalPythonVersions(repoPath) {
  const versions = [];

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

export async function loadSpecificWorkflow(repoPath, workflowFile) {
  const normalized = workflowFile.replace(/^\/+/, "");
  const absolutePath = path.resolve(repoPath, normalized);
  const rawText = await fs.readFile(absolutePath, "utf8");
  const parsed = YAML.parse(rawText);

  return {
    absolutePath,
    relativePath: toPosixRelative(repoPath, absolutePath),
    rawText,
    parsed,
  };
}
