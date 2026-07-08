import { describe, expect, it } from "vitest";
import { readArgs } from "../src/cli.js";

describe("readArgs", () => {
  it("keeps quoted worksheet names with spaces as one value", () => {
    const args = readArgs(["--worksheet", "Plumber Trainees", "--limit", "5"]);

    expect(args.worksheet).toBe("Plumber Trainees");
    expect(args.limit).toBe(5);
  });

  it("supports equals-form worksheet arguments", () => {
    const args = readArgs(["--worksheet=Plumber Trainees"]);

    expect(args.worksheet).toBe("Plumber Trainees");
  });

  it("supports a configurable delay between website checks", () => {
    const args = readArgs(["--check-delay-ms", "4500"]);

    expect(args.checkDelayMs).toBe(4500);
  });
});
