#!/usr/bin/env node
// Modo HTTP (Streamable HTTP) — para que n8n se conecte por red
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { buildServer } from "./server.js";

const PORT = process.env.PORT || 5001;
const app = express();
app.use(express.json());

// Endpoint MCP sin estado: cada petición crea su propio transporte
app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error en /mcp:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Error interno del servidor" },
        id: null,
      });
    }
  }
});

// En modo sin estado no se usan GET/DELETE
const noStream = (_req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
app.get("/mcp", noStream);
app.delete("/mcp", noStream);

// === Transporte SSE (para n8n MCP Client Tool) ===
const sseTransports = {};

app.get("/sse", async (_req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sseTransports[transport.sessionId] = transport;
  res.on("close", () => {
    delete sseTransports[transport.sessionId];
  });
  const server = buildServer();
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseTransports[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res, req.body);
  } else {
    res.status(400).send("No hay sesión SSE para ese sessionId");
  }
});

// Chequeo de salud
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.error(`loyverse-mcp escuchando en :${PORT}  (SSE: /sse  |  HTTP: /mcp)`);
});
