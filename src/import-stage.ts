import { readArgs } from "./cli.js";
import { importPipelineWorkItems } from "./runner.js";

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  const result = await importPipelineWorkItems(args);
  console.log(`Imported ${result.queuedCount} queued work item(s) into ${result.outputPaths.workItemsPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
