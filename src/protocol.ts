// The wire protocol between this server and the MIB2 Configurator page: the page connects over a WebSocket on
// 127.0.0.1 and answers the tool calls. The same types live in the app (src/lib/bridge/protocol.ts in
// pqisa-mib2-configurator-web); change both together and bump PROTOCOL_VERSION when a message changes shape.

export const PROTOCOL_VERSION = 1;
/** The server's default port (mib2c-mcp --port / MIB2C_PORT changes it). */
export const DEFAULT_PORT = 47391;

/** Page → server, first message: who is connecting, with the pairing code the server printed. */
export interface Hello {
  t: 'hello';
  protocol: number;
  code: string;
  app: { version: string; url: string };
}

/** Server → page: the pairing was accepted (or not, then the server closes the socket). */
export interface Welcome {
  t: 'welcome';
  server: { name: string; version: string };
}
export interface Rejected {
  t: 'rejected';
  reason: string;
}

/** Server → page: run one command. */
export interface Call {
  t: 'call';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** Page → server: what a command returned, or why it failed. */
export type Result = { t: 'result'; id: number; ok: true; result: unknown } | { t: 'result'; id: number; ok: false; error: string };

export type ServerMessage = Welcome | Rejected | Call;
export type PageMessage = Hello | Result;

/**
 * A command result carrying a picture: the server turns `image` into MCP image content and sends the rest as text.
 */
export interface ImageResult {
  image: { data: string; mimeType: 'image/png' };
  [key: string]: unknown;
}
