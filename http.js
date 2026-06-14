#!/usr/bin/env node
// MCP por HTTP con autenticación. Soporta SSE (n8n) y Streamable HTTP (ChatGPT).
// Auth: token en la ruta (/<token>/sse) o header "Authorization: Bearer <token>".
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { buildServer, salesSummary, dayBoundsUTC, dateInTZ } from "./server.js";

const PORT = process.env.PORT || 5001;
const AUTH = process.env.MCP_AUTH_TOKEN; // si está vacío, NO se exige auth (solo para pruebas)
const app = express();
app.use(express.json());

// Devuelve true si la petición está autorizada; si no, responde 401 y devuelve false.
function authOk(req, res) {
  if (!AUTH) return true; // sin token configurado = abierto (no recomendado en producción)
  const fromPath = req.params.token;
  const fromHeader = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (fromPath === AUTH || fromHeader === AUTH) return true;
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "No autorizado" },
    id: null,
  });
  return false;
}

// --- Streamable HTTP (ChatGPT) ---
async function handleMcpPost(req, res) {
  if (!authOk(req, res)) return;
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
}
app.post("/mcp", handleMcpPost);
app.post("/:token/mcp", handleMcpPost);

const noStream = (_req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
app.get("/mcp", noStream);
app.delete("/mcp", noStream);
app.get("/:token/mcp", noStream);
app.delete("/:token/mcp", noStream);

// --- SSE (n8n) ---
const sseTransports = {};

async function handleSse(req, res) {
  if (!authOk(req, res)) return;
  const messagesPath = req.params.token ? `/${req.params.token}/messages` : "/messages";
  const transport = new SSEServerTransport(messagesPath, res);
  sseTransports[transport.sessionId] = transport;
  res.on("close", () => {
    delete sseTransports[transport.sessionId];
  });
  const server = buildServer();
  await server.connect(transport);
}
app.get("/sse", handleSse);
app.get("/:token/sse", handleSse);

async function handleMessages(req, res) {
  if (!authOk(req, res)) return;
  const transport = sseTransports[req.query.sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res, req.body);
  } else {
    res.status(400).send("No hay sesión SSE para ese sessionId");
  }
}
app.post("/messages", handleMessages);
app.post("/:token/messages", handleMessages);

// --- Reporte diario en JSON (para n8n / Google Sheets) ---
// GET /<token>/report/daily?date=YYYY-MM-DD&tz=America/Mexico_City
// Sin ?date toma AYER (zona horaria indicada). Devuelve una fila por tienda.
async function handleDaily(req, res) {
  if (!authOk(req, res)) return;
  try {
    const tz = req.query.tz || "America/Mexico_City";
    const date = req.query.date || dateInTZ(tz, -1); // por defecto: ayer
    const { created_at_min, created_at_max } = dayBoundsUTC(date, tz);
    const resumen = await salesSummary({ created_at_min, created_at_max });
    const filas = resumen.por_tienda.map((s) => ({
      fecha: date,
      tienda: s.tienda,
      total: s.total,
      recibos: s.recibos,
      devoluciones: s.devoluciones,
    }));
    res.json({ fecha: date, zona_horaria: tz, total_neto: resumen.total_neto, filas });
  } catch (err) {
    console.error("Error en /report/daily:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
}
app.get("/report/daily", handleDaily);
app.get("/:token/report/daily", handleDaily);

// --- Salud (sin auth) ---
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.error(
    `loyverse-mcp escuchando en :${PORT}  (auth: ${AUTH ? "ON" : "OFF"})  SSE: /<token>/sse  HTTP: /<token>/mcp`
  );
});
