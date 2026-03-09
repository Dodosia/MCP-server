import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerPrompts } from "../prompts.js";
import { registerResources } from "../resources.js";
import { setLatestDoctorReport, setLatestReproManifest } from "../state.js";
import { doctorScan, doctorScanInputSchema } from "../tools/doctorScan.js";
import { reproGenerate, reproGenerateInputSchema } from "../tools/reproGenerate.js";

function asToolResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function asErrorResult(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
  };
}

export function buildMcpServer() {
  const mcpServer = new McpServer({
    name: "ci-parity-doctor-mcp",
    version: "0.1.0",
  });

  mcpServer.registerTool(
    "doctor_scan",
    {
      title: "Doctor Scan",
      description: "Analyze a repository for CI parity and reproducibility issues.",
      inputSchema: doctorScanInputSchema.shape,
    },
    async (args: unknown) => {
      try {
        const result = await doctorScan(args);
        setLatestDoctorReport(result);
        return asToolResult(result);
      } catch (error) {
        return asErrorResult(error);
      }
    },
  );

  mcpServer.registerTool(
    "repro_generate",
    {
      title: "Repro Generate",
      description: "Generate ./repro artifacts to replay a GitHub Actions job via Docker.",
      inputSchema: reproGenerateInputSchema.shape,
    },
    async (args: unknown) => {
      try {
        const result = await reproGenerate(args);
        setLatestReproManifest(result);
        return asToolResult(result);
      } catch (error) {
        return asErrorResult(error);
      }
    },
  );

  registerResources(mcpServer);
  registerPrompts(mcpServer);

  return mcpServer;
}
