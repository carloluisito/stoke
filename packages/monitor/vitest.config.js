import { defineConfig } from "vitest/config";

// The monitor's own tests live under src/. The dashboard in web/ is a separate,
// self-contained project with its own deps (React, Vite) and its own test run —
// exclude it here so `npm test -w @stoke/monitor` doesn't glob web/ tests that
// can't resolve React in this workspace.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "web/**"],
  },
});
