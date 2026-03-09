import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { ReproManifest } from "../types.js";
import { loadSpecificWorkflow } from "../utils/gha.js";
import { ensurePathInside, resolveRepoPath, safeWriteFile } from "../utils/fs.js";

const ReproTargetSchema = z.object({
  type: z.literal("ci_job"),
  workflow_file: z.string(),
  job: z.string(),
});

export const reproGenerateInputSchema = z.object({
  repo_path: z.string(),
  target: ReproTargetSchema,
  strategy: z.literal("dockerfile").default("dockerfile"),
  write_mode: z.literal("repro_dir_only"),
});

export type ReproGenerateInput = z.infer<typeof reproGenerateInputSchema>;

interface RuntimeDetection {
  baseImage: string;
  dockerfileBootstrapLines: string[];
  warnings: string[];
}

function firstVersionDigits(value: string): string | null {
  const match = value.match(/(\d+(?:\.\d+){0,2})/);
  return match ? match[1] : null;
}

function normalizeNodeVersion(value: string): string | null {
  const digits = firstVersionDigits(value);
  if (!digits) {
    return null;
  }
  return digits.split(".")[0];
}

function normalizePythonVersion(value: string): string | null {
  const digits = firstVersionDigits(value);
  if (!digits) {
    return null;
  }
  const parts = digits.split(".");
  if (parts.length >= 2) {
    return `${parts[0]}.${parts[1]}`;
  }
  return parts[0];
}

function findSetupVersion(steps: Array<Record<string, unknown>>, action: "setup-node" | "setup-python"): string | null {
  const actionPrefix = `actions/${action}`;
  for (const step of steps) {
    const uses = typeof step.uses === "string" ? step.uses.toLowerCase() : "";
    if (!uses.startsWith(actionPrefix)) {
      continue;
    }

    const withBlock = (step.with ?? {}) as Record<string, unknown>;
    if (action === "setup-node") {
      const nodeVersion = withBlock["node-version"];
      if (typeof nodeVersion === "string" && nodeVersion.trim()) {
        return nodeVersion.trim();
      }
    }

    if (action === "setup-python") {
      const pyVersion = withBlock["python-version"];
      if (typeof pyVersion === "string" && pyVersion.trim()) {
        return pyVersion.trim();
      }
    }
  }

  return null;
}

function detectRuntime(steps: Array<Record<string, unknown>>): RuntimeDetection {
  const warnings: string[] = [];
  const nodeVersionRaw = findSetupVersion(steps, "setup-node");
  const pythonVersionRaw = findSetupVersion(steps, "setup-python");

  const nodeVersion = nodeVersionRaw ? normalizeNodeVersion(nodeVersionRaw) : null;
  const pythonVersion = pythonVersionRaw ? normalizePythonVersion(pythonVersionRaw) : null;

  if (nodeVersion && pythonVersion) {
    warnings.push(
      "Detected both actions/setup-node and actions/setup-python. Selected Node as base image and installed python3 in the container.",
    );
    return {
      baseImage: `node:${nodeVersion}-alpine`,
      dockerfileBootstrapLines: ["RUN apk add --no-cache bash python3 py3-pip"],
      warnings,
    };
  }

  if (nodeVersion) {
    return {
      baseImage: `node:${nodeVersion}-alpine`,
      dockerfileBootstrapLines: ["RUN apk add --no-cache bash"],
      warnings,
    };
  }

  if (pythonVersion) {
    return {
      baseImage: `python:${pythonVersion}-slim`,
      dockerfileBootstrapLines: [
        "RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates && rm -rf /var/lib/apt/lists/*",
      ],
      warnings,
    };
  }

  warnings.push("Could not detect runtime version from setup actions. Fallback to node:20-alpine.");
  return {
    baseImage: "node:20-alpine",
    dockerfileBootstrapLines: ["RUN apk add --no-cache bash"],
    warnings,
  };
}

function escapeForMarkdownCodeBlock(value: string): string {
  return value.replace(/```/g, "`\\`\\`");
}

function collectSecretAndEnvPlaceholders(rawWorkflow: string): string[] {
  const vars = new Set<string>();
  const regex = /\$\{\{\s*(?:secrets|env)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(rawWorkflow)) !== null) {
    vars.add(match[1]);
  }
  return [...vars].sort((a, b) => a.localeCompare(b));
}

function generateDockerfile(runtime: RuntimeDetection): string {
  return [
    `FROM ${runtime.baseImage}`,
    ...runtime.dockerfileBootstrapLines,
    "WORKDIR /workspace",
  ].join("\n");
}

function generateRunScript(jobName: string, runCommands: string[]): string {
  const commandLines = runCommands.length > 0 ? runCommands : [`echo \"No run commands were found for job ${jobName}.\"`];
  const delimiter = "CI_PARITY_JOB_SCRIPT";

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    `JOB_NAME=\"${jobName}\"`,
    "if [[ $# -ge 1 ]]; then",
    "  JOB_NAME=\"$1\"",
    "fi",
    "",
    "SCRIPT_DIR=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" && pwd)\"",
    "REPO_ROOT=\"$(cd \"${SCRIPT_DIR}/..\" && pwd)\"",
    "",
    "ENV_ARGS=()",
    "if [[ -f \"${SCRIPT_DIR}/.env\" ]]; then",
    "  ENV_ARGS+=(--env-file \"${SCRIPT_DIR}/.env\")",
    "fi",
    "",
    `JOB_SCRIPT=$(cat <<'${delimiter}'`,
    "set -euo pipefail",
    ...commandLines,
    delimiter,
    ")",
    "",
    "echo \"Running workflow job: ${JOB_NAME}\"",
    "docker run --rm \\",
    "  -v \"${REPO_ROOT}:/workspace\" \\",
    "  -w /workspace \\",
    "  \"${ENV_ARGS[@]}\" \\",
    "  repro-ci \\",
    "  bash -lc \"${JOB_SCRIPT}\"",
  ].join("\n");
}

function generateReadme(
  targetWorkflow: string,
  targetJob: string,
  runCommands: string[],
  ignoredUses: string[],
  warnings: string[],
  placeholders: string[],
): string {
  const lines: string[] = [];
  lines.push("# CI Reproduction Bundle");
  lines.push("");
  lines.push(`Target workflow: \`${targetWorkflow}\``);
  lines.push(`Target job: \`${targetJob}\``);
  lines.push("");

  lines.push("## How To Run");
  lines.push("1. `docker build -t repro-ci .`");
  lines.push(`2. \`./run.sh ${targetJob}\``);
  lines.push("");

  lines.push("## Collected run commands");
  if (runCommands.length === 0) {
    lines.push("No `run:` commands were found for this job.");
  } else {
    for (const command of runCommands) {
      lines.push("```bash");
      lines.push(escapeForMarkdownCodeBlock(command));
      lines.push("```");
    }
  }
  lines.push("");

  lines.push("## Ignored uses steps");
  if (ignoredUses.length === 0) {
    lines.push("No `uses:` steps were ignored.");
  } else {
    for (const uses of ignoredUses) {
      lines.push(`- ${uses}`);
    }
    lines.push("These actions were not emulated; replicate them manually if required.");
  }
  lines.push("");

  lines.push("## Warnings and assumptions");
  if (warnings.length === 0) {
    lines.push("No additional warnings.");
  } else {
    for (const warning of warnings) {
      lines.push(`- ${warning}`);
    }
  }
  lines.push("");

  lines.push("## Environment variables");
  if (placeholders.length === 0) {
    lines.push("No `${{ secrets.* }}` or `${{ env.* }}` placeholders detected in workflow text.");
  } else {
    lines.push("Detected `${{ secrets.* }}` / `${{ env.* }}` placeholders.");
    lines.push("Fill `repro/.env` manually (template is `repro/.env.example`) before running reproduction.");
    for (const placeholder of placeholders) {
      lines.push(`- ${placeholder}`);
    }
  }

  return lines.join("\n");
}

export async function reproGenerate(rawInput: unknown): Promise<ReproManifest> {
  const input = reproGenerateInputSchema.parse(rawInput);
  const repoPath = resolveRepoPath(input.repo_path);

  if (input.write_mode !== "repro_dir_only") {
    throw new Error("Only write_mode=repro_dir_only is supported.");
  }

  const workflow = await loadSpecificWorkflow(repoPath, input.target.workflow_file);
  const jobs = (workflow.parsed.jobs ?? {}) as Record<string, Record<string, unknown>>;
  const selectedJob = jobs[input.target.job];
  if (!selectedJob) {
    throw new Error(`Job '${input.target.job}' not found in ${workflow.relativePath}`);
  }

  const steps = Array.isArray(selectedJob.steps)
    ? (selectedJob.steps as Array<Record<string, unknown>>)
    : [];

  const runCommands: string[] = [];
  const ignoredUses: string[] = [];

  for (const step of steps) {
    const run = step.run;
    if (typeof run === "string" && run.trim()) {
      runCommands.push(run.trim());
    }

    const uses = step.uses;
    if (typeof uses === "string" && uses.trim()) {
      ignoredUses.push(uses.trim());
    }
  }

  const runtime = detectRuntime(steps);
  const placeholders = collectSecretAndEnvPlaceholders(workflow.rawText);
  const reproDir = path.resolve(repoPath, "repro");
  ensurePathInside(repoPath, reproDir);
  await fs.mkdir(reproDir, { recursive: true });

  const dockerfileContent = generateDockerfile(runtime);
  const runScriptContent = generateRunScript(input.target.job, runCommands);
  const readmeContent = generateReadme(
    workflow.relativePath,
    input.target.job,
    runCommands,
    ignoredUses,
    runtime.warnings,
    placeholders,
  );

  const generatedFiles: Array<{ path: string }> = [];

  await safeWriteFile(reproDir, "README.md", `${readmeContent}\n`);
  generatedFiles.push({ path: "repro/README.md" });

  await safeWriteFile(reproDir, "Dockerfile", `${dockerfileContent}\n`);
  generatedFiles.push({ path: "repro/Dockerfile" });

  await safeWriteFile(reproDir, "run.sh", `${runScriptContent}\n`, true);
  generatedFiles.push({ path: "repro/run.sh" });

  if (placeholders.length > 0) {
    const envExample = `${placeholders.map((key) => `${key}=`).join("\n")}\n`;
    await safeWriteFile(reproDir, ".env.example", envExample);
    generatedFiles.push({ path: "repro/.env.example" });
  }

  return {
    repro_dir: "./repro",
    generated_files: generatedFiles,
    how_to_run: ["cd repro && docker build -t repro-ci .", `./run.sh ${input.target.job}`],
  };
}
