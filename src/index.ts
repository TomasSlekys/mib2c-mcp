#!/usr/bin/env node
// mib2c-mcp: an MCP server (stdio) for AI assistants (Claude, Codex, Cursor, ...) that drives the MIB2 Configurator web app open in the browser. The
// page connects to it over a WebSocket on 127.0.0.1; the assistant's tool calls run on that page.

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Bridge, DEFAULT_ORIGINS } from './bridge.js';
import { DEFAULT_PORT } from './protocol.js';
import { INSTRUCTIONS, registerTools } from './tools.js';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

const HELP = `mib2c-mcp ${version}: lets an AI assistant see and work the MIB2 Configurator page open in your browser.

Usage: mib2c-mcp [--port <n>]

  --port <n>     WebSocket port on 127.0.0.1 (default ${DEFAULT_PORT}; or MIB2C_PORT)

Environment:
  MIB2C_PORT        the port
  MIB2C_ORIGINS     extra page origins allowed to connect, comma-separated ("*" matches any part),
                    e.g. https://mib2c.example.home (default: ${DEFAULT_ORIGINS.join(', ')})

Add it to Claude Code:  claude mcp add --scope user mib2c -- npx -y github:TomasSlekys/mib2c-mcp
Add it to Codex CLI:    codex mcp add mib2c -- npx -y github:TomasSlekys/mib2c-mcp
                        (and in ~/.codex/config.toml under [mcp_servers.mib2c]: startup_timeout_sec = 120,
                        tool_timeout_sec = 900)
Others: https://github.com/TomasSlekys/mib2c-mcp#set-up`;

function parseArgs(argv: string[]) {
  const out = { port: Number(process.env.MIB2C_PORT) || DEFAULT_PORT, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown option ${a} (--help lists them).`);
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error('The port must be 1 to 65535.');
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // stdout is the MCP channel: everything for people goes to stderr.
  const log = (line: string) => process.stderr.write(`[mib2c-mcp] ${line}\n`);
  if (args.help) {
    process.stderr.write(`${HELP}\n`);
    return;
  }
  const extra = (process.env.MIB2C_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const bridge = new Bridge({ port: args.port, origins: [...DEFAULT_ORIGINS, ...extra], server: { name: 'mib2c-mcp', version }, log });
  await bridge.start();

  const server = new McpServer({ name: 'mib2c-mcp', version }, { instructions: INSTRUCTIONS });
  registerTools(server, bridge);
  await server.connect(new StdioServerTransport());

  const stop = async () => {
    await bridge.stop();
    process.exit(0);
  };
  process.stdin.on('close', stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  process.stderr.write(`[mib2c-mcp] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
