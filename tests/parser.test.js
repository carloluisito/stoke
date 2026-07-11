import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { extractTurn } from "../src/parser.js";

const lines = fs.readFileSync("tests/fixtures/session-basic.jsonl", "utf8").split("\n").filter(Boolean);

describe("extractTurn", () => {
  it("ignores user lines and malformed lines", () => {
    expect(extractTurn(lines[0], { project: "p" })).toBeNull();
    expect(extractTurn(lines[3], { project: "p" })).toBeNull();
  });
  it("extracts usage with TTL breakdown", () => {
    const t = extractTurn(lines[1], { project: "p" });
    expect(t).toMatchObject({ message_id: "msg_1", session_id: "s1", model: "claude-opus-4-8",
      input_tokens: 100, output_tokens: 200, cache_write_5m: 5000, cache_write_1h: 0, cache_read: 0 });
  });
  it("falls back: no breakdown object means all cache_creation counts as 5m", () => {
    const t = extractTurn(lines[2], { project: "p" });
    expect(t.cache_write_5m).toBe(1000);
    expect(t.cache_write_1h).toBe(0);
    expect(t.cache_read).toBe(5000);
  });
});
