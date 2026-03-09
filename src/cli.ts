import path from "node:path";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startHttpServer } from "./server.js";

const HEALTH_URL = "http://127.0.0.1:8000/health";
const MCP_URL = "http://127.0.0.1:8000/mcp";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertHealth(timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const response = await fetch(HEALTH_URL, { signal: controller.signal });
      clearTimeout(timeout);

      if (response.ok) {
        const payload = (await response.json()) as { status?: string };
        if (payload.status === "ok") {
          return;
        }
      }
    } catch {
      // no-op; will retry
    }

    await sleep(200);
  }

  throw new Error(`health endpoint did not become ready within ${timeoutMs} ms`);
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const maybeCause = (error as { cause?: unknown }).cause;
  const parts = [error.message];

  if (maybeCause) {
    parts.push(`cause=${String(maybeCause)}`);
  }

  if (error.stack) {
    parts.push(error.stack);
  }

  return parts.join("\n");
}

async function assertMcpRoundTrip(): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));

  const client = new Client(
    {
      name: "ci-parity-doctor-smoke",
      version: "0.1.0",
    },
    {
      capabilities: {},
    },
  );

  try {
    await client.connect(transport as any);

    const toolListResponse = await (client as any).listTools();
    const toolNames = Array.isArray(toolListResponse?.tools)
      ? toolListResponse.tools.map((tool: { name?: string }) => tool.name).filter(Boolean)
      : [];

    if (!toolNames.includes("doctor_scan")) {
      throw new Error(`doctor_scan not found in MCP tools: ${JSON.stringify(toolNames)}`);
    }

    const demoRepoPath = path.resolve(process.cwd(), "demo_project");
    const doctorResult = await (client as any).callTool({
      name: "doctor_scan",
      arguments: {
        repo_path: demoRepoPath,
        ci_system: "github-actions",
        focus: ["ci", "docker", "toolchain", "env"],
        output_format: "json",
      },
    });

    if (!doctorResult) {
      throw new Error("doctor_scan returned empty response");
    }
  } finally {
    if (typeof (client as any).close === "function") {
      await (client as any).close();
    }

    if (typeof (transport as { close?: () => Promise<void> }).close === "function") {
      await (transport as { close: () => Promise<void> }).close();
    }
  }
}

async function runServe(): Promise<void> {
  const running = await startHttpServer(8000, "0.0.0.0");
  console.log(`CI Parity Doctor MCP server listening on ${running.host}:${running.port}`);

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);
    await running.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

async function runSmoke(): Promise<number> {
  let running: Awaited<ReturnType<typeof startHttpServer>> | null = null;

  try {
    running = await startHttpServer(8000, "0.0.0.0");
    await assertHealth(5000);
    await assertMcpRoundTrip();
    console.log("SMOKE OK");
    return 0;
  } catch (error) {
    console.error(`SMOKE FAIL: ${formatError(error)}`);
    return 1;
  } finally {
    if (running) {
      await running.close();
    }
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];

  if (mode === "serve") {
    await runServe();
    return;
  }

  if (mode === "smoke") {
    const code = await runSmoke();
    process.exit(code);
    return;
  }

  console.error("Usage: node dist/cli.js <serve|smoke>");
  process.exit(2);
}

void main();
