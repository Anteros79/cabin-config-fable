import { importReference } from "../importer/cli.ts";
import { type AppHandle, createApp } from "./app.ts";
import { ConfigError, resolveServerConfig, type ServerConfig } from "./config.ts";
import { inspectStore } from "./referenceStore.ts";

/** How long a shutdown may take before the process is forced out with exit code 1. */
const SHUTDOWN_TIMEOUT_MS = 5000;

let handle: AppHandle | null = null;

/** Log at fatal through the server logger when there is one, always also one line on stderr; then exit 1. */
function fatal(message: string, error: unknown): never {
  handle?.app.log.fatal({ err: error }, message);
  console.error(`${message}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

/**
 * Close the server and the stores once. A second signal while closing, or a close that takes longer
 * than SHUTDOWN_TIMEOUT_MS, forces exit code 1.
 */
function installShutdown(app: AppHandle): void {
  let closing = false;
  const shutdown = () => {
    if (closing) process.exit(1);
    closing = true;
    setTimeout(() => {
      console.error(`Shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS / 1000} s.`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    app.close().then(
      () => process.exit(0),
      (e: unknown) => fatal("Shutdown failed", e),
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Start the Cabin Kit server. Binds to loopback by default: there is no authentication.
 * Settings are validated before any store is touched. If no reference store exists yet it is
 * created by the same import the CLI runs (creating a new file is not destructive). An existing
 * store is never re-imported or reset on start.
 */
async function main(config: ServerConfig): Promise<void> {
  const ref = inspectStore(config.referencePath);
  if (ref.kind === "absent" || ref.kind === "empty") {
    const outcome = importReference({ referencePath: config.referencePath, visitsPath: config.visitsPath });
    console.log(`Reference store created: release ${outcome.releaseId} (${outcome.status}${outcome.activated ? ", active" : ""}).`);
  }
  handle = createApp(config);
  installShutdown(handle);
  try {
    await handle.app.listen({ host: config.host, port: config.port });
  } catch (e) {
    if ((e as { code?: string }).code !== "EADDRINUSE") throw e;
    await handle.close();
    console.error(`Port ${config.port} is in use. Set CABIN_KIT_PORT.`);
    process.exit(1);
  }
  const address = handle.app.server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  console.log(`Cabin Kit (fictional demonstration) listening on http://${config.host}:${port}`);
  console.log(`Reference store: ${config.referencePath}`);
  console.log(`Visit store    : ${config.visitsPath}`);
}

process.on("unhandledRejection", (reason) => fatal("Unhandled rejection", reason));
process.on("uncaughtException", (error) => fatal("Uncaught exception", error));

let config: ServerConfig;
try {
  config = resolveServerConfig();
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(e.message);
  process.exit(2);
}

main(config).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
