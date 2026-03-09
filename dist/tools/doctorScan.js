import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import YAML from "yaml";
import { z } from "zod";

import { calculateReproScore } from "../utils/scoring.js";
import {
  collectRunCommands,
  collectSetupRuntimeVersions,
  extractMajor,
  getLocalNodeVersions,
  getLocalPythonVersions,
  loadWorkflows,
} from "../utils/gha.js";
import { fileExists, resolveRepoPath } from "../utils/fs.js";

const Focus = z.enum(["ci", "docker", "toolchain", "env"]);

export const doctorScanInputSchema = z.object({
  repo_path: z.string(),
  ci_system: z.literal("github-actions").default("github-actions"),
  focus: z.array(Focus).default(["ci", "docker", "toolchain", "env"]),
  output_format: z.literal("json").default("json"),
});

function addFinding(findings, finding) {
  findings.push(finding);
}

function ensureId(id) {
  return id.replace(/[^A-Z0-9_]/g, "_").toUpperCase();
}

function parseMakeTargets(makefileContent) {
  const targets = new Set();
  for (const line of makefileContent.split(/\r?\n/)) {
    if (!line || line.startsWith("\t") || line.trim().startsWith("#")) {
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*:/);
    if (match) {
      targets.add(match[1]);
    }
  }
  return targets;
}

function hasPinnedImage(image) {
  const value = image.trim();
  if (!value) {
    return { pinned: false, reason: "empty image" };
  }
  if (value.includes("@sha256:")) {
    return { pinned: true, reason: "digest" };
  }

  const lastSegment = value.split("/").pop() ?? value;
  if (!lastSegment.includes(":")) {
    return { pinned: false, reason: "missing tag" };
  }

  const tag = lastSegment.split(":").pop()?.toLowerCase() ?? "";
  if (!tag || tag === "latest") {
    return { pinned: false, reason: `tag is ${tag || "missing"}` };
  }

  return { pinned: true, reason: "explicit tag" };
}

function parseDockerfileFromImages(content) {
  const images = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^FROM\s+([^\s]+)/i);
    if (!match) {
      continue;
    }

    const image = match[1].trim();
    if (image) {
      images.push(image);
    }
  }
  return images;
}

function summarize(findings) {
  const blockers = findings.filter((f) => f.severity === "BLOCKER").length;
  const majors = findings.filter((f) => f.severity === "MAJOR").length;
  const minors = findings.filter((f) => f.severity === "MINOR").length;

  return {
    repro_score: calculateReproScore(findings),
    blockers,
    majors,
    minors,
  };
}

function buildQuickstart(repoPath, workflows) {
  const workflow = workflows[0] ?? ".github/workflows/ci.yml";
  return {
    recommended_next_tool: "repro_generate",
    commands: [
      `Use repro_generate with repo_path=${repoPath}, workflow_file=${workflow}, job=unit-tests`,
      `cd ${repoPath} && ls -la repro`,
    ],
  };
}

function compareMajorVersions(values) {
  return new Set(values.map(extractMajor).filter((v) => v !== "unknown"));
}

export async function doctorScan(rawInput) {
  const input = doctorScanInputSchema.parse(rawInput);
  const repoPath = resolveRepoPath(input.repo_path);
  const findings = [];

  const workflows = await loadWorkflows(repoPath);
  const workflowFiles = workflows.map((w) => w.relativePath);

  if (workflowFiles.length === 0 && input.focus.includes("ci")) {
    addFinding(findings, {
      id: ensureId("CI_WORKFLOW_MISSING"),
      severity: "BLOCKER",
      title: "No GitHub Actions workflows found",
      evidence: ["Expected .github/workflows/*.yml or *.yaml but none were discovered."],
      fix: "Add at least one workflow under .github/workflows to define CI behavior.",
      files: [".github/workflows"],
    });
  }

  if (input.focus.includes("toolchain")) {
    const runtimeVersions = await collectSetupRuntimeVersions(repoPath);
    const ciNode = runtimeVersions.filter((v) => v.kind === "node");
    const ciPython = runtimeVersions.filter((v) => v.kind === "python");

    const localNode = await getLocalNodeVersions(repoPath);
    const localPython = await getLocalPythonVersions(repoPath);

    const ciNodeMajors = compareMajorVersions(ciNode.map((v) => v.version));
    const localNodeMajors = compareMajorVersions(localNode.map((v) => v.version));

    if (ciNodeMajors.size > 0 && localNodeMajors.size > 0) {
      const overlap = [...ciNodeMajors].some((major) => localNodeMajors.has(major));
      if (!overlap) {
        addFinding(findings, {
          id: ensureId("NODE_TOOLCHAIN_DRIFT"),
          severity: "MAJOR",
          title: "Node.js version drift between CI and local toolchain",
          evidence: [
            `CI node versions: ${ciNode.map((v) => `${v.version} (${v.workflowFile})`).join(", ")}`,
            `Local node versions: ${localNode.map((v) => `${v.version} (${v.source})`).join(", ")}`,
          ],
          fix: "Align setup-node version with .nvmrc/.tool-versions/package.json engines.node.",
          files: [...new Set([...(ciNode.map((v) => v.workflowFile)), ...(localNode.map((v) => v.source))])],
        });
      }
    }

    if (localNodeMajors.size > 1) {
      addFinding(findings, {
        id: ensureId("NODE_LOCAL_DRIFT"),
        severity: "MAJOR",
        title: "Conflicting local Node.js version declarations",
        evidence: localNode.map((v) => `${v.source}: ${v.version}`),
        fix: "Keep one Node major version across .nvmrc, .tool-versions and package.json engines.node.",
        files: localNode.map((v) => v.source),
      });
    }

    const ciPythonMajors = compareMajorVersions(ciPython.map((v) => v.version));
    const localPythonMajors = compareMajorVersions(localPython.map((v) => v.version));

    if (ciPythonMajors.size > 0 && localPythonMajors.size > 0) {
      const overlap = [...ciPythonMajors].some((major) => localPythonMajors.has(major));
      if (!overlap) {
        addFinding(findings, {
          id: ensureId("PYTHON_TOOLCHAIN_DRIFT"),
          severity: "MAJOR",
          title: "Python version drift between CI and local toolchain",
          evidence: [
            `CI python versions: ${ciPython.map((v) => `${v.version} (${v.workflowFile})`).join(", ")}`,
            `Local python versions: ${localPython.map((v) => `${v.version} (${v.source})`).join(", ")}`,
          ],
          fix: "Align setup-python with .python-version/.tool-versions/pyproject.toml requires-python.",
          files: [...new Set([...(ciPython.map((v) => v.workflowFile)), ...(localPython.map((v) => v.source))])],
        });
      }
    }
  }

  if (input.focus.includes("ci")) {
    const hasPackageJson = await fileExists(path.resolve(repoPath, "package.json"));
    if (hasPackageJson) {
      const lockfiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"];
      const presentLockfiles = [];

      for (const lockfile of lockfiles) {
        if (await fileExists(path.resolve(repoPath, lockfile))) {
          presentLockfiles.push(lockfile);
        }
      }

      if (presentLockfiles.length === 0) {
        addFinding(findings, {
          id: ensureId("LOCKFILE_MISSING"),
          severity: "MAJOR",
          title: "package.json exists but lockfile is missing",
          evidence: ["Detected package.json without package-lock.json/yarn.lock/pnpm-lock.yaml/bun.lockb."],
          fix: "Generate and commit a lockfile (for example package-lock.json) to stabilize dependency resolution.",
          files: ["package.json"],
        });
      }
    }

    const runCommands = await collectRunCommands(repoPath);
    if (runCommands.length > 0) {
      let scripts = {};
      const packagePath = path.resolve(repoPath, "package.json");
      if (await fileExists(packagePath)) {
        const packageRaw = await fs.readFile(packagePath, "utf8");
        const pkg = JSON.parse(packageRaw);
        scripts = pkg.scripts ?? {};
      }

      const makefilePath = path.resolve(repoPath, "Makefile");
      const makeTargets = (await fileExists(makefilePath))
        ? parseMakeTargets(await fs.readFile(makefilePath, "utf8"))
        : new Set();

      const missingEquivalents = [];
      const files = new Set();

      for (const run of runCommands) {
        files.add(run.workflowFile);
        for (const line of run.command.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          const npmRun = trimmed.match(/^npm\s+run\s+([A-Za-z0-9:_-]+)/);
          if (npmRun && !(npmRun[1] in scripts)) {
            missingEquivalents.push(`${run.workflowFile}#${run.job}: npm run ${npmRun[1]} (script missing)`);
            continue;
          }

          if (/^npm\s+test(\s|$)/.test(trimmed) && !Object.prototype.hasOwnProperty.call(scripts, "test")) {
            missingEquivalents.push(`${run.workflowFile}#${run.job}: npm test (scripts.test missing)`);
            continue;
          }

          const makeMatch = trimmed.match(/^make\s+([A-Za-z0-9_.-]+)/);
          if (makeMatch && !makeTargets.has(makeMatch[1])) {
            missingEquivalents.push(`${run.workflowFile}#${run.job}: make ${makeMatch[1]} (Makefile target missing)`);
          }
        }
      }

      if (missingEquivalents.length > 0) {
        addFinding(findings, {
          id: ensureId("CI_LOCALITY_GAP"),
          severity: "MINOR",
          title: "CI run steps are missing local equivalents",
          evidence: missingEquivalents,
          fix: "Add matching local commands/scripts (for example scripts.test or Makefile targets) so CI can be reproduced locally.",
          files: [...files],
        });
      }
    }
  }

  if (input.focus.includes("docker")) {
    const dockerfiles = await fg(["**/Dockerfile", "**/Dockerfile.*"], {
      cwd: repoPath,
      onlyFiles: true,
      dot: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });

    for (const dockerfile of dockerfiles) {
      const absolute = path.resolve(repoPath, dockerfile);
      const content = await fs.readFile(absolute, "utf8");
      const fromImages = parseDockerfileFromImages(content);

      for (const image of fromImages) {
        const pin = hasPinnedImage(image);
        if (!pin.pinned) {
          addFinding(findings, {
            id: ensureId(`DOCKER_FROM_UNPINNED_${dockerfile}_${image}`),
            severity: "MAJOR",
            title: "Dockerfile base image is not pinned",
            evidence: [`${dockerfile}: FROM ${image} (${pin.reason})`],
            fix: "Pin Docker base image to a non-latest explicit tag or digest.",
            files: [dockerfile],
          });
        }
      }
    }

    const composeFiles = await fg(
      [
        "docker-compose*.yml",
        "docker-compose*.yaml",
        "compose*.yml",
        "compose*.yaml",
        "**/docker-compose*.yml",
        "**/docker-compose*.yaml",
      ],
      {
        cwd: repoPath,
        onlyFiles: true,
        dot: true,
        ignore: ["**/node_modules/**", "**/.git/**"],
      },
    );

    for (const composeFile of [...new Set(composeFiles)]) {
      const absolute = path.resolve(repoPath, composeFile);
      const content = await fs.readFile(absolute, "utf8");
      const parsed = YAML.parse(content);
      const services = parsed.services ?? {};

      for (const [serviceName, service] of Object.entries(services)) {
        const image = service.image;
        if (typeof image === "string") {
          const pin = hasPinnedImage(image);
          if (!pin.pinned) {
            addFinding(findings, {
              id: ensureId(`COMPOSE_IMAGE_UNPINNED_${composeFile}_${serviceName}`),
              severity: "MAJOR",
              title: "Compose service image is not pinned",
              evidence: [`${composeFile}: services.${serviceName}.image=${image} (${pin.reason})`],
              fix: "Use explicit image tags in docker-compose.yml instead of latest/untagged images.",
              files: [composeFile],
            });
          }
        }

        const hasDependsOn = Array.isArray(service.depends_on)
          ? service.depends_on.length > 0
          : typeof service.depends_on === "object" && service.depends_on !== null;
        const hasHealthcheck = typeof service.healthcheck === "object" && service.healthcheck !== null;

        if (hasDependsOn && !hasHealthcheck) {
          addFinding(findings, {
            id: ensureId(`COMPOSE_DEPENDS_ON_NO_HEALTHCHECK_${composeFile}_${serviceName}`),
            severity: "MAJOR",
            title: "Service uses depends_on without healthcheck",
            evidence: [
              `${composeFile}: services.${serviceName}.depends_on is set but healthcheck is missing.`,
            ],
            fix: "Add a service healthcheck so startup order and readiness checks are deterministic.",
            files: [composeFile],
          });
        }
      }
    }
  }

  const summary = summarize(findings);

  return {
    summary,
    findings,
    quickstart: buildQuickstart(repoPath, workflowFiles),
  };
}
