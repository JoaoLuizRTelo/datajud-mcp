#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { DataJudClient } from "./datajud/client.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

// stdout carries the MCP protocol, so every diagnostic goes to stderr.
const log = (message: string): void => {
  console.error(message);
};

try {
  const config = loadConfig();
  const server = createServer(new DataJudClient(config, { log }));
  await server.connect(new StdioServerTransport());
  log(`${SERVER_NAME} ${SERVER_VERSION} running on stdio`);
} catch (error) {
  log(error instanceof ConfigError ? error.message : `Failed to start: ${String(error)}`);
  process.exit(1);
}
