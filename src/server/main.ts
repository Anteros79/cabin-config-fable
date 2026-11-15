import { importReference } from "../importer/cli.ts";
import { createApp } from "./app.ts";
import { resolveServerConfig } from "./config.ts";
import { inspectStore } from "./referenceStore.ts";

/**
 * Start the Cabin Kit server. Binds to loopback by default: there is no authentication.
 * If no reference store exists yet it is created by the same import the CLI runs (creating a new
 * file is not destructive). An existing store is never re-imported or reset on start.
 */
async function main(): Promise<void> {
  const config = resolveServerConfig();
  const ref = inspectStore(config.referencePath);
  if (ref.kind === "absent" || ref.kind === "empty") {
    const outcome = importReference({ referencePath: config.referencePath, visitsPath: config.visitsPath });
    console.log(`Reference store created: release ${outcome.releaseId} (${outcome.status}${outcome.activated ? ", active" : ""}).`);
  }
  const handle = createApp(config);
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await handle.app.listen({ host: config.host, port: config.port });
  const address = handle.app.server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  console.log(`Cabin Kit (fictional demonstration) listening on http://${config.host}:${port}`);
  console.log(`Reference store: ${config.referencePath}`);
  console.log(`Visit store    : ${config.visitsPath}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
