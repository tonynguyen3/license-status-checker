import { resolve } from "node:path";

export interface CliArgs {
  input: string;
  outDir: string;
  worksheet?: string;
  headed: boolean;
  slowMo: number;
  checkDelayMs: number;
  limit?: number;
}

export function readArgs(argv: string[]): CliArgs {
  const args = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;

    const equalsIndex = arg.indexOf("=");
    if (equalsIndex > 2) {
      args.set(arg.slice(2, equalsIndex), arg.slice(equalsIndex + 1));
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, true);
    } else {
      args.set(key, next);
      i++;
    }
  }

  const outDir = String(args.get("out-dir") ?? "Files");
  const input = String(args.get("input") ?? resolve(outDir, "ListToCheck.xlsx"));
  const limitValue = args.get("limit");
  const checkDelayValue = Number(args.get("check-delay-ms") ?? 1000);

  return {
    input: resolve(input),
    outDir: resolve(outDir),
    worksheet: typeof args.get("worksheet") === "string" ? String(args.get("worksheet")) : undefined,
    headed: args.get("headed") === true,
    slowMo: Number(args.get("slow-mo") ?? 0),
    checkDelayMs: Number.isFinite(checkDelayValue) && checkDelayValue >= 0 ? checkDelayValue : 1000,
    limit: typeof limitValue === "string" ? Number(limitValue) : undefined
  };
}
