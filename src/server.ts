import { randomUUID } from "node:crypto";
import http from "node:http";

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { buildMcpServer } from "./mcp/buildMcp.js";

export interface RunningServer {
  close: () => Promise<void>;
  host: string;
  port: number;
}

type McpServerInstance = ReturnType<typeof buildMcpServer>;

interface SessionEntry {
  server: McpServerInstance;
  transport: StreamableHTTPServerTransport;
}

function getSessionId(req: express.Request): string | null {
  const raw = req.header("mcp-session-id");
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isInitializeRequest(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  const method = (body as { method?: unknown }).method;
  return method === "initialize";
}

function ensureAcceptHeader(req: express.Request): void {
  const current = typeof req.headers.accept === "string" ? req.headers.accept : "";
  if (current.includes("text/event-stream")) {
    return;
  }

  req.headers.accept = current
    ? `${current}, application/json, text/event-stream`
    : "application/json, text/event-stream";
}

async function closeIfPossible(value: unknown): Promise<void> {
  if (value && typeof value === "object" && typeof (value as { close?: unknown }).close === "function") {
    await (value as { close: () => Promise<void> | void }).close();
  }
}

export async function startHttpServer(port = 8000, host = "0.0.0.0"): Promise<RunningServer> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const sessions = new Map<string, SessionEntry>();

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.all("/mcp", async (req, res) => {
    let ephemeral: SessionEntry | null = null;

    try {
      // Compatibility: some clients omit SSE in Accept; Streamable HTTP requires it.
      ensureAcceptHeader(req);

      const sessionId = getSessionId(req);

      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          res.status(404).json({
            error: `Unknown MCP session id: ${sessionId}`,
          });
          return;
        }

        await existing.transport.handleRequest(req, res, req.body);
        return;
      }

      const isInit = req.method === "POST" && isInitializeRequest(req.body);
      if (isInit) {
        const server = buildMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            sessions.set(newSessionId, { server, transport });
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };

        await server.connect(transport as any);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      const server = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      ephemeral = { server, transport };

      await server.connect(transport as any);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP /mcp request failed", error);
      if (!res.headersSent) {
        res.status(500).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (ephemeral) {
        await closeIfPossible(ephemeral.transport);
        await closeIfPossible(ephemeral.server);
      }
    }
  });

  const server = await new Promise<http.Server>((resolve) => {
    const started = app.listen(port, host, () => resolve(started));
  });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    for (const [sessionId, entry] of sessions.entries()) {
      await closeIfPossible(entry.transport);
      await closeIfPossible(entry.server);
      sessions.delete(sessionId);
    }
  };

  return {
    close,
    host,
    port,
  };
}
