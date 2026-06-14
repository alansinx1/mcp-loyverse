#!/usr/bin/env node
// Modo STDIO — para usar el MCP desde Claude Code
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

const server = buildServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("loyverse-mcp (stdio) listo");
