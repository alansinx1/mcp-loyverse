import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const BASE = "https://api.loyverse.com/v1.0";

// Llamada genérica a la API de Loyverse (lee el token en tiempo de ejecución)
async function loyverse(path, params = {}) {
  const token = process.env.LOYVERSE_TOKEN;
  if (!token) throw new Error("Falta la variable de entorno LOYVERSE_TOKEN");

  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Loyverse API ${res.status}: ${body}`);
  }
  return res.json();
}

function asJson(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// Crea y configura un servidor MCP con las herramientas de Loyverse
export function buildServer() {
  const server = new McpServer({ name: "loyverse-mcp", version: "1.0.0" });

  server.tool(
    "list_items",
    "Lista productos del catálogo de Loyverse",
    { limit: z.number().int().min(1).max(250).default(50).describe("Cuántos productos traer") },
    async ({ limit }) => asJson(await loyverse("items", { limit }))
  );

  server.tool(
    "list_receipts",
    "Lista recibos (ventas). Fechas en ISO 8601, ej. 2026-06-01T00:00:00Z",
    {
      created_at_min: z.string().optional().describe("Fecha mínima ISO 8601"),
      created_at_max: z.string().optional().describe("Fecha máxima ISO 8601"),
      store_id: z.string().optional().describe("ID de la tienda"),
      limit: z.number().int().min(1).max(250).default(50),
    },
    async (args) => asJson(await loyverse("receipts", args))
  );

  server.tool(
    "get_inventory",
    "Consulta niveles de inventario por variante y tienda",
    {
      store_id: z.string().optional().describe("ID de la tienda"),
      limit: z.number().int().min(1).max(250).default(50),
    },
    async (args) => asJson(await loyverse("inventory", args))
  );

  server.tool(
    "list_stores",
    "Lista las tiendas/sucursales de la cuenta",
    {},
    async () => asJson(await loyverse("stores"))
  );

  server.tool(
    "list_customers",
    "Lista clientes registrados",
    { limit: z.number().int().min(1).max(250).default(50) },
    async ({ limit }) => asJson(await loyverse("customers", { limit }))
  );

  server.tool(
    "list_categories",
    "Lista categorías de productos",
    {},
    async () => asJson(await loyverse("categories"))
  );

  return server;
}
