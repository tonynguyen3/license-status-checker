import { readArgs } from "./cli.js";
import { generatePipelineReports } from "./runner.js";

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  const result = await generatePipelineReports(args);
  console.log(`Regenerated reports in ${result.outputPaths.runStatePath}`);
  console.log(`Send: ${result.sendCount}. Do-not-send: ${result.doNotSendCount}. Courses: ${result.courseFrequencyCount}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
