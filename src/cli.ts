// src/cli.ts
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createProxyServer } from "./proxy.ts";
import { Registry } from "./registry.ts";
import { JsonlLogger } from "./logger.ts";
import { BudgetGuard } from "./budget.ts";
import { runSchedulerTick, makeHttpFetcher } from "./scheduler.ts";
import { loadConfig } from "./config.ts";
import { emitDigest, buildDigest } from "./digest.ts";
import type { OtelHandle } from "./otel.ts";
import {
  startOfDayMs,
  startOfMonthMs,
  startOfBillingCycleMs,
} from "./time-windows.ts";
import {
  ensurePersistentBaseUrl,
  removePersistentBaseUrl,
} from "./env-setup.ts";
import type { Config } from "./types.ts";

async function main(argv: string[]): Promise<void> {
  const cmd = argv[2] ?? "start";

  if (cmd === "start") {
    const config = loadConfigWithEnvOverrides();
    const logger = new JsonlLogger(config.logPath, config.logRotation);
    if (config.requireT1 && process.env.ENABLE_PROMPT_CACHING_1H !== "1") {
      console.error(
        "stoke: ENABLE_PROMPT_CACHING_1H is not set.\n" +
          "Set it before launching Claude Code, or set requireT1: false in config.",
      );
      process.exit(1);
    }
    const lifecycle = await startProxyAndSchedulerLifecycle(config, logger);
    process.on("SIGINT", () => {
      lifecycle.stop();
      process.exit(0);
    });
    // Block forever; the proxy's listening socket and the scheduler ticker
    // keep the event loop alive. The SIGINT handler above is the exit point.
    await new Promise<void>(() => {
      /* never resolves */
    });
  } else if (cmd === "run") {
    await runWithChild(argv);
  } else if (cmd === "replay") {
    runReplay(argv);
  } else if (cmd === "status") {
    const config = loadConfig();
    const logger = new JsonlLogger(config.logPath, config.logRotation);
    printStatus(logger);
  } else if (cmd === "tail") {
    const config = loadConfig();
    tailLog(config.logPath);
  } else if (cmd === "unset-env") {
    const result = removePersistentBaseUrl();
    if (result.action === "set") {
      console.log("✓ Removed ANTHROPIC_BASE_URL from user-scope registry.");
      console.log("  Already-open shells keep their existing value until closed.");
    } else if (result.action === "skipped-unsupported-platform") {
      console.log(`Auto env-var removal skipped — unsupported platform: ${result.detail}`);
    } else if (result.action === "already-set") {
      console.log(`Nothing to remove (${result.detail ?? "no marked block"}).`);
    } else {
      console.error(`Could not remove env var: ${result.detail ?? "unknown"}`);
      process.exit(1);
    }
  } else {
    console.error(`unknown command: ${cmd}`);
    console.error("usage: stoke {start|status|tail|unset-env|run|replay}");
    process.exit(2);
  }
}

interface ProxyLifecycle {
  baseUrl: string;
  stop(): void;
}

function registryPath(): string {
  return join(homedir(), ".stoke", "registry.json");
}

function loadPersistedRegistry(registry: Registry): void {
  const p = registryPath();
  if (!existsSync(p)) return;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (Array.isArray(raw)) registry.hydrate(raw);
  } catch {
    // ignore unparseable; start fresh
  }
}

function savePersistedRegistry(registry: Registry): void {
  const p = registryPath();
  try {
    const data = JSON.stringify(registry.serialize());
    writeFileSync(p, data);
    if (process.platform !== "win32") {
      try {
        chmodSync(p, 0o600);
      } catch {
        /* best-effort */
      }
    }
  } catch (err) {
    try {
      process.stderr.write(
        `stoke: failed to persist registry (${(err as Error).message})\n`,
      );
    } catch {
      /* best-effort */
    }
  }
}

async function startProxyAndSchedulerLifecycle(
  config: Config,
  logger: JsonlLogger,
): Promise<ProxyLifecycle> {
  const registry = new Registry();
  loadPersistedRegistry(registry);
  const now0 = Date.now();
  registry.abandonStale(now0, (s) =>
    (s.detectedTtlSeconds || config.cacheTtlSeconds) *
    config.abandonTtlMultiplier *
    1000,
  );
  registry.evictAbandoned(now0, config.evictAfterHours * 3600_000);
  let activeConfig = config;
  activeConfig.authToken = randomBytes(16).toString("hex");
  let guard = new BudgetGuard(activeConfig);
  const fetcher = makeHttpFetcher("https://api.anthropic.com");
  const startedAt = Date.now();

  let otelHandle: OtelHandle | null = null;
  if (activeConfig.otel?.enabled) {
    const otelMod = await import("./otel.ts");
    otelHandle = await otelMod.init(activeConfig.otel);
  }

  let version = "unknown";
  try {
    const pkgPath = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    /* best-effort */
  }

  const proxy = createProxyServer({
    registry,
    logger,
    config: activeConfig,
    otel: otelHandle,
    dashboard: {
      startedAt,
      version,
      onReload: (next) => {
        next.authToken = activeConfig.authToken;
        activeConfig = next;
        guard = new BudgetGuard(next);
        console.log(`stoke: config reloaded · plan=${next.plan}`);
      },
    },
  });

  const baseUrl = `http://${activeConfig.listen.host}:${activeConfig.listen.port}`;

  await new Promise<void>((resolve) => {
    proxy.listen(activeConfig.listen.port, activeConfig.listen.host, () => {
      console.log(`stoke listening on ${baseUrl}`);
      const dashboardUrl = `${baseUrl}/dashboard?token=${activeConfig.authToken}`;
      console.log(`Dashboard: ${dashboardUrl}`);
      console.log("  Bookmark this URL. The token is required for every dashboard request and regenerates on each restart.");

      if (activeConfig.autoSetEnvVar) {
        const result = ensurePersistentBaseUrl(baseUrl);
        switch (result.action) {
          case "set":
            console.log(`✓ Persistent ANTHROPIC_BASE_URL set to ${baseUrl}`);
            console.log(`  Wrote to: ${result.detail}`);
            console.log("  Open a NEW shell to pick it up.");
            break;
          case "updated":
            console.log(`✓ Persistent ANTHROPIC_BASE_URL updated: ${result.detail}`);
            console.log("  Open a NEW shell to pick up the new value.");
            break;
          case "already-set":
            console.log(`✓ ANTHROPIC_BASE_URL already set persistently to ${baseUrl}.`);
            break;
          case "skipped-unsupported-platform":
            console.log(`ℹ Auto env-var setup skipped — unsupported platform: ${result.detail}`);
            break;
          case "error":
            console.log(`⚠ Could not persist ANTHROPIC_BASE_URL: ${result.detail}`);
            console.log(`  Set manually: $env:ANTHROPIC_BASE_URL = "${baseUrl}" (or 'export' on macOS/Linux)`);
            break;
        }
      } else {
        console.log(`(autoSetEnvVar=false) Set manually: $env:ANTHROPIC_BASE_URL = "${baseUrl}"`);
      }

      console.log(`Log: ${activeConfig.logPath}`);
      logger.write({
        ts: new Date().toISOString(),
        kind: "proxy_started",
        config: {
          listen: activeConfig.listen,
          cacheTtlSeconds: activeConfig.cacheTtlSeconds,
          pingCadenceMarginSeconds: activeConfig.pingCadenceMarginSeconds,
          abandonTtlMultiplier: activeConfig.abandonTtlMultiplier,
        },
      });
      // Initial digest right after the startup banner.
      emitDigest({ registry, logger, config: activeConfig, nowMs: Date.now() });
      resolve();
    });
  });

  // Schedule the next digest at local midnight. Re-arms after firing so we
  // don't drift across DST or clock changes.
  let digestTimer: NodeJS.Timeout | null = null;
  function scheduleNextMidnight(): void {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 5, 0); // 5s past midnight to be unambiguously the next day
    const delay = next.getTime() - now.getTime();
    digestTimer = setTimeout(() => {
      emitDigest({ registry, logger, config: activeConfig, nowMs: Date.now() });
      scheduleNextMidnight();
    }, delay);
  }
  scheduleNextMidnight();

  const ticker = setInterval(() => {
    const now = new Date();
    const dayStats = logger.statsSinceMs(startOfDayMs(now));
    const monthStartMs =
      activeConfig.plan === "enterprise" && activeConfig.enterpriseCap
        ? startOfBillingCycleMs(activeConfig.enterpriseCap.cycleStartDayOfMonth, now)
        : startOfMonthMs(now);
    const monthStats = logger.statsSinceMs(monthStartMs);

    registry.evictAbandoned(
      now.getTime(),
      activeConfig.evictAfterHours * 3600 * 1000,
    );

    runSchedulerTick({
      registry,
      logger,
      config: activeConfig,
      guard,
      fetcher,
      nowMs: now.getTime(),
      spendUsdToday: dayStats.totalPingSpendUsd,
      spendUsdMonth: monthStats.totalPingSpendUsd,
      pingsToday: dayStats.pingsFired,
      otel: otelHandle,
    }).catch((err) => console.error("scheduler tick error:", err));
  }, activeConfig.tickIntervalSeconds * 1000);

  return {
    baseUrl,
    stop(): void {
      clearInterval(ticker);
      if (digestTimer) clearTimeout(digestTimer);
      // Final digest on shutdown so the user always sees a closing summary.
      emitDigest({ registry, logger, config: activeConfig, nowMs: Date.now() });
      proxy.close();
      logger.flushSync();
      savePersistedRegistry(registry);
      // OTel shutdown is async; we fire-and-forget here to keep the lifecycle
      // synchronous. The collector may lose the last batch if the process
      // exits before the flush completes — acceptable for an opt-in feature.
      if (otelHandle) void otelHandle.shutdown?.();
    },
  };
}

async function runWithChild(argv: string[]): Promise<void> {
  const dashIdx = argv.indexOf("--");
  if (dashIdx === -1 || dashIdx === argv.length - 1) {
    console.error("usage: stoke run -- <command> [args...]");
    process.exit(2);
  }
  const childCmd = argv[dashIdx + 1];
  const childArgs = argv.slice(dashIdx + 2);

  const config = loadConfigWithEnvOverrides();
  const logger = new JsonlLogger(config.logPath, config.logRotation);
  if (config.requireT1 && process.env.ENABLE_PROMPT_CACHING_1H !== "1") {
    console.error("stoke: ENABLE_PROMPT_CACHING_1H is not set.");
    process.exit(1);
  }

  const lifecycle = await startProxyAndSchedulerLifecycle(config, logger);

  const childEnv = { ...process.env, ANTHROPIC_BASE_URL: lifecycle.baseUrl };
  const child = spawn(childCmd, childArgs, {
    stdio: "inherit",
    env: childEnv,
    shell: process.platform === "win32",
  });

  let shuttingDown = false;
  const shutdown = (exitCode: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    lifecycle.stop();
    process.exit(exitCode);
  };

  child.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      console.error(`stoke: command not found: ${childCmd}`);
      shutdown(127);
    } else {
      console.error(`stoke: failed to spawn child: ${err.message}`);
      shutdown(1);
    }
  });
  child.on("close", (code) => {
    shutdown(typeof code === "number" ? code : 1);
  });

  process.on("SIGINT", () => {
    if (!child.killed) {
      try {
        child.kill("SIGINT");
      } catch {
        /* best-effort */
      }
    }
    shutdown(130);
  });
}

/**
 * Load config from disk, then apply environment-variable overrides for
 * fields that need to differ per-process (most notably the listen port,
 * which tests must override to avoid conflicting with the developer's
 * running instance).
 */
function loadConfigWithEnvOverrides(): Config {
  const config = loadConfig();
  const portStr = process.env.CACHE_KEEPALIVE_PORT;
  if (portStr) {
    const port = Number(portStr);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      config.listen.port = port;
    }
  }
  const hostEnv = process.env.CACHE_KEEPALIVE_HOST;
  if (hostEnv && hostEnv.length > 0) {
    config.listen.host = hostEnv;
  }
  const logPathEnv = process.env.CACHE_KEEPALIVE_LOG_PATH;
  if (logPathEnv && logPathEnv.length > 0) {
    config.logPath = logPathEnv;
  }
  // autoSetEnvVar defaults to true, but in tests we never want to clobber
  // the developer's actual ANTHROPIC_BASE_URL.
  if (process.env.CACHE_KEEPALIVE_AUTO_SET_ENV === "0") {
    config.autoSetEnvVar = false;
  }
  return config;
}

function runReplay(argv: string[]): void {
  const path = argv[3];
  if (!path) {
    console.error("usage: stoke replay <path-to-events.jsonl>");
    process.exit(2);
  }
  if (!existsSync(path)) {
    console.error(`stoke: file not found: ${path}`);
    process.exit(1);
  }
  const config = loadConfig();
  // JsonlLogger reads the file into its in-memory cache on construction;
  // no writes happen here. Rotation disabled (null).
  const logger = new JsonlLogger(path, null);
  const registry = new Registry();
  const text = buildDigest({ registry, logger, config, nowMs: Date.now() });
  process.stdout.write(text);
}

function printStatus(logger: JsonlLogger): void {
  const s = logger.summary();
  console.log("stoke status");
  console.log(`  real requests recorded:    ${s.realRequests}`);
  console.log(`  pings fired:               ${s.pingsFired}`);
  console.log(`  pings skipped (budget):    ${s.pingsSkipped}`);
  console.log(`  sessions paused:           ${s.sessionsPaused}`);
  console.log(`  total ping spend USD:      $${s.totalPingSpendUsd.toFixed(4)}`);
  console.log(`  resumes — survived (clean): ${s.resumesSurvived}`);
  console.log(`  resumes — partial (small new write): ${s.resumesPartial}`);
  console.log(`  resumes — rebuilt (cold cache): ${s.resumesRebuilt}`);
  console.log(`  total $ paid on partial+rebuilt: $${s.resumeRebuildSpendUsd.toFixed(4)}`);
}

function tailLog(path: string): void {
  console.log(`tailing ${path} (Ctrl+C to stop)`);
  spawn("powershell", ["-Command", `Get-Content -Path '${path}' -Wait -Tail 20`], {
    stdio: "inherit",
  });
}

main(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
