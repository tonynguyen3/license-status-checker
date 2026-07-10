import { readArgs } from "./cli.js";
import { processPipelineQueue } from "./runner.js";

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  const result = await processPipelineQueue(args);
  console.log(`Processed queue from ${result.outputPaths.workItemsPath}`);
  console.log(`Send: ${result.sendCount}. Do-not-send: ${result.doNotSendCount}. Canceled: ${result.canceled ? "yes" : "no"}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
