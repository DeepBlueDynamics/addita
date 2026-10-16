#!/usr/bin/env node
import { config } from "./config.js";
import { preloadMcpModule, startHttpServer } from "./server.js";

let httpServer: import("node:http").Server | undefined;
let httpPort = config.port;

if (config.port >= 0) {
  try {
    const started = await startHttpServer({ host: config.host, port: config.port });
    httpServer = started.server;
    httpPort = started.port;
  } catch (e: any) {
    if (e?.code === "EADDRINUSE" && process.env.ADDITA_PORT === undefined) {
      const started = await startHttpServer({ host: config.host, port: 0 });
      httpServer = started.server;
      httpPort = started.port;
    } else {
      throw e;
    }
  }
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    httpServer?.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

console.error(
  `addita: http ${config.host}:${httpPort}, stdio ${config.stdio ? "on" : "off"}, ollaya ${config.ollayaUrl}, ollama ${config.ollamaUrl} (${config.ollamaModel}), data ${config.dataDir}`,
);

if (config.stdio) {
  // Load and connect the MCP stdio server asynchronously after the HTTP listener is already open.
  void preloadMcpModule()
    .then((mcp) =>
      mcp.startStdioMcpServer(() => {
        httpServer?.close();
        process.exit(0);
      }),
    )
    .catch((e: any) => {
      console.error(`addita: mcp startup error: ${e?.message ?? e}`);
    });
}
