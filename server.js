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
    "sales_summary",
    "Resumen EXACTO de ventas por tienda en un rango de fechas. Suma el total de TODOS los recibos (paginando), neto de devoluciones. USA SIEMPRE esta herramienta para preguntas de '¿cuánto se vendió?' en vez de sumar recibos a mano.",
    {
      created_at_min: z.string().describe("Inicio del rango en UTC ISO 8601, ej. 2026-06-14T06:00:00Z"),
      created_at_max: z.string().optional().describe("Fin del rango en UTC ISO 8601"),
    },
    async ({ created_at_min, created_at_max }) => {
      // Nombres de tiendas
      const storesData = await loyverse("stores");
      const storeName = {};
      for (const s of storesData.stores || []) storeName[s.id] = s.name;

      // Recorre todas las páginas de recibos
      const perStore = {};
      let totalNet = 0, totalReceipts = 0, totalRefunds = 0;
      let cursor;
      let pages = 0;
      do {
        const params = cursor
          ? { cursor, limit: 250 }
          : { created_at_min, limit: 250, ...(created_at_max ? { created_at_max } : {}) };
        const page = await loyverse("receipts", params);
        for (const r of page.receipts || []) {
          const isRefund = r.receipt_type === "REFUND";
          const sign = isRefund ? -1 : 1;
          const amt = (r.total_money || 0) * sign;
          const sid = r.store_id || "desconocida";
          if (!perStore[sid]) perStore[sid] = { tienda: storeName[sid] || sid, total: 0, recibos: 0, devoluciones: 0 };
          perStore[sid].total += amt;
          if (isRefund) { perStore[sid].devoluciones += 1; totalRefunds += 1; }
          else perStore[sid].recibos += 1;
          totalNet += amt;
          totalReceipts += 1;
        }
        cursor = page.cursor;
      } while (cursor && ++pages < 100);

      const round = (n) => Math.round(n * 100) / 100;
      return asJson({
        rango: { desde: created_at_min, hasta: created_at_max || "ahora" },
        total_neto: round(totalNet),
        total_recibos: totalReceipts,
        total_devoluciones: totalRefunds,
        por_tienda: Object.values(perStore).map((s) => ({ ...s, total: round(s.total) })),
      });
    }
  );

  server.tool(
    "sales_by_hour",
    "Ventas agrupadas por HORA del día, ya convertidas a la zona horaria indicada (por defecto México). Devuelve total y número de recibos por hora, y la hora pico. USA esta herramienta para preguntas de '¿a qué hora se vende más?'.",
    {
      created_at_min: z.string().describe("Inicio del rango en UTC ISO 8601"),
      created_at_max: z.string().optional().describe("Fin del rango en UTC ISO 8601"),
      timezone: z.string().default("America/Mexico_City").describe("Zona horaria IANA"),
    },
    async ({ created_at_min, created_at_max, timezone }) => {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "2-digit",
        hour12: false,
      });

      const buckets = {}; // hora -> { total, recibos }
      let cursor, pages = 0;
      do {
        const params = cursor
          ? { cursor, limit: 250 }
          : { created_at_min, limit: 250, ...(created_at_max ? { created_at_max } : {}) };
        const page = await loyverse("receipts", params);
        for (const r of page.receipts || []) {
          if (r.receipt_type === "REFUND") continue;
          const when = new Date(r.receipt_date || r.created_at);
          let h = fmt.format(when); // "14" o "24"
          if (h === "24") h = "00";
          if (!buckets[h]) buckets[h] = { total: 0, recibos: 0 };
          buckets[h].total += r.total_money || 0;
          buckets[h].recibos += 1;
        }
        cursor = page.cursor;
      } while (cursor && ++pages < 100);

      const round = (n) => Math.round(n * 100) / 100;
      const por_hora = Object.entries(buckets)
        .map(([h, v]) => ({ hora: `${h}:00`, total: round(v.total), recibos: v.recibos }))
        .sort((a, b) => a.hora.localeCompare(b.hora));
      const pico = por_hora.reduce((max, x) => (x.total > (max?.total ?? -1) ? x : max), null);

      return asJson({
        rango: { desde: created_at_min, hasta: created_at_max || "ahora" },
        zona_horaria: timezone,
        hora_pico: pico,
        por_hora,
      });
    }
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
