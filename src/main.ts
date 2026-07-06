import { readArgs } from "./cli.js";
import { runWashingtonCheck } from "./runner.js";

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  await runWashingtonCheck(args);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
