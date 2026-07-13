import { test } from "node:test";
import assert from "node:assert/strict";
import { extractProjectPath } from "../src/project-path.ts";

test("extracts cwd from an <env> block", () => {
  const payload = {
    system: "<env>\n  cwd: C:\\Users\\carlo\\Desktop\\repositories\\work\\resto-backend\n</env>",
  };
  assert.equal(extractProjectPath(payload), "work/resto-backend");
});

test("extracts cwd from a string-array system field", () => {
  const payload = {
    system: [
      { type: "text", text: "You are a helpful assistant." },
      { type: "text", text: "<env>cwd: /home/user/projects/notes-mcp</env>" },
    ],
  };
  assert.equal(extractProjectPath(payload), "projects/notes-mcp");
});

test("extracts cwd from a 'Working directory:' line", () => {
  const payload = { system: "Working directory: /Users/me/personal/dotfiles" };
  assert.equal(extractProjectPath(payload), "personal/dotfiles");
});

test("falls back to last two path segments when no anchor word matches", () => {
  const payload = { system: "cwd: /opt/services/billing" };
  assert.equal(extractProjectPath(payload), "services/billing");
});

test("returns null when payload has no system field", () => {
  assert.equal(extractProjectPath({}), null);
  assert.equal(extractProjectPath({ system: "" }), null);
});

test("returns null when system field has no CWD pattern", () => {
  const payload = { system: "You are a helpful assistant. Be concise." };
  assert.equal(extractProjectPath(payload), null);
});
