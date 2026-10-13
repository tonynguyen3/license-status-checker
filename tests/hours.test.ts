import { describe, expect, it } from "vitest";
import { getHoursNeeded } from "../src/hours.js";

describe("getHoursNeeded", () => {
  it("maps Washington trades to required CE hours", () => {
    expect(getHoursNeeded("Plumber Trainee")).toBe(8);
    expect(getHoursNeeded("Plumber")).toBe(24);
    expect(getHoursNeeded("Electrician")).toBe(24);
  });

  it("returns zero for unknown trades", () => {
    expect(getHoursNeeded("Unknown")).toBe(0);
  });
});
