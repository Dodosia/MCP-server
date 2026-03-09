# ci-parity-doctor-mcp

`ci-parity-doctor-mcp` is a TypeScript/Node 20 MCP server that helps teams detect CI parity issues and generate deterministic local reproduction bundles for GitHub Actions jobs.

## What This MCP Server Does

CI failures are often hard to reproduce locally because toolchain versions, Docker images, and workflow steps diverge over time.

This server is for engineers who need a fast, actionable diagnosis and a reproducible local path.

Implemented MCP tools:

1. `doctor_scan`
2. `repro_generate`

Also implemented:

1. Resources: `resource://doctor/latest`, `resource://repro/manifest`
2. Prompts: `prompt://reproduce_ci_failure`, `prompt://onboarding_pack`

## Quick Start

### 1) Build Docker image

```bash
docker build -t ci-parity-doctor .
```

Docker build tries `https://registry.npmmirror.com` first and automatically falls back to `https://registry.npmjs.org` if needed.

### 2) Run server mode (`serve`)

```bash
docker run --rm -p 8000:8000 ci-parity-doctor serve
```

Server contract:

1. Binds `0.0.0.0:8000`
2. Exposes `GET /health`
3. Exposes MCP Streamable HTTP endpoint at `/mcp`

### 3) Check health endpoint

```bash
curl http://localhost:8000/health
```

Expected:

```json
{"status":"ok"}
```

### 4) Connect MCP Inspector

Use Streamable HTTP URL:

```text
http://localhost:8000/mcp
```

After connecting, Inspector should show tools `doctor_scan` and `repro_generate`.

### 5) Run smoke mode

```bash
docker run --rm ci-parity-doctor smoke
```

Expected success output includes:

```text
SMOKE OK
```

## How To Use

### Tool: `doctor_scan`

Purpose: scan repository reproducibility and CI parity risks.

Input example:

```json
{
  "repo_path": "/app/demo_project",
  "ci_system": "github-actions",
  "focus": ["ci", "docker", "toolchain", "env"],
  "output_format": "json"
}
```

Output shape:

```json
{
  "summary": {
    "repro_score": 0,
    "blockers": 0,
    "majors": 0,
    "minors": 0
  },
  "findings": [
    {
      "id": "STRING_ID",
      "severity": "BLOCKER|MAJOR|MINOR",
      "title": "short title",
      "evidence": ["..."],
      "fix": "actionable fix",
      "files": ["relative/path"]
    }
  ],
  "quickstart": {
    "recommended_next_tool": "repro_generate",
    "commands": ["..."]
  }
}
```

Checks implemented:

1. Node toolchain drift (CI vs `.nvmrc`, `.tool-versions`, `package.json engines.node`)
2. Python toolchain drift (CI vs `.python-version`, `.tool-versions`, `pyproject.toml`)
3. Missing lockfile when `package.json` exists
4. Docker image pinning (`latest`/untagged detection in Dockerfiles and compose files)
5. Compose reliability (`depends_on` without `healthcheck`)
6. CI locality gaps (`run` commands without local script/Make target equivalents)

Score formula:

1. Starts from 100
2. `-25` per `BLOCKER`
3. `-10` per `MAJOR`
4. `-3` per `MINOR`
5. Clamped to `0..100`

### Tool: `repro_generate`

Purpose: generate `./repro` bundle for local replay of a GitHub Actions job via Docker.

Input example:

```json
{
  "repo_path": "/app/demo_project",
  "target": {
    "type": "ci_job",
    "workflow_file": ".github/workflows/ci.yml",
    "job": "unit-tests"
  },
  "strategy": "dockerfile",
  "write_mode": "repro_dir_only"
}
```

Output shape:

```json
{
  "repro_dir": "./repro",
  "generated_files": [
    {"path": "repro/README.md"},
    {"path": "repro/Dockerfile"},
    {"path": "repro/run.sh"}
  ],
  "how_to_run": [
    "cd repro && docker build -t repro-ci .",
    "./run.sh unit-tests"
  ]
}
```

Behavior:

1. Parses workflow YAML and reads `jobs.<job>.steps[]`
2. Collects `run:` commands in order
3. Ignores `uses:` steps and writes warnings to `repro/README.md`
4. Detects runtime from setup actions and chooses base image
5. Fallback runtime is `node:20-alpine` if version is not detected
6. Creates `repro/.env.example` if `${{ secrets.* }}` or `${{ env.* }}` placeholders are present
7. Strictly writes only under `./repro` when `write_mode=repro_dir_only`

## Demo Project

Repository includes `demo_project/` with deterministic parity issues for demonstration:

1. GitHub Actions workflow with `unit-tests` job
2. Intentional Node version drift (`setup-node: 20` vs `.nvmrc: 18`)
3. `package.json` without lockfile
4. `Dockerfile` with `FROM node:latest`
5. `docker-compose.yml` with unpinned images and `depends_on` without `healthcheck`

## Assumptions And Limitations

1. Current MVP focuses on GitHub Actions workflows only.
2. Matrix expressions and complex dynamic CI expressions are treated best-effort.
3. `uses:` action emulation is intentionally skipped in repro bundle and must be handled manually.
4. Runtime internet access is not required by server operation itself, but Docker image build requires package installation during build.

## Optional Advanced Mode

No additional advanced mode is required for baseline functionality; default behavior is intentionally minimal and deterministic.

## Repository Layout

```text
ci-parity-doctor-mcp/
  src/
    cli.ts
    server.ts
    mcp/buildMcp.ts
    tools/doctorScan.ts
    tools/reproGenerate.ts
    resources.ts
    prompts.ts
    utils/gha.ts
    utils/fs.ts
    utils/scoring.ts
  dist/
  demo_project/
  Dockerfile
  README.md
  DEMO.md
  .env.example
  .gitignore
  package.json
  tsconfig.json
```
