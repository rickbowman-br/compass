import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

try {
  process.loadEnvFile(path.resolve(process.cwd(), ".env.local"));
} catch {
  // CI supplies DATABASE_URL directly.
}

const mode = process.argv[2];
const passthrough = process.argv.slice(3).filter((argument) => argument !== "--");
const modes = {
  roadmap: [
    "--project=functional-setup",
    "--project=functional",
    "e2e/functional/specs/roadmap-timeline.spec.ts",
    "e2e/functional/specs/roadmap-unscheduled-items.spec.ts",
    "e2e/functional/specs/native-timeline-rollout.spec.ts",
  ],
  functional: ["--project=functional-setup", "--project=functional"],
  all: [],
};

if (!(mode in modes)) {
  throw new Error("Usage: run-functional-e2e.mjs <roadmap|functional|all>");
}

/* ──────────────────────────────────────────────────────────────────────────
 * Machine-wide single-run mutex.
 *
 * This repo is worked by many concurrent agents, each in its own git worktree
 * (`.claude/worktrees/*`, `.worktrees/*`, `~/.geode/worktrees/compass/*`), and
 * several of those worktrees carry a full `node_modules`. Any of them can
 * independently run `pnpm test:e2e:functional`.
 *
 * Each such run is expensive and NOT self-limiting:
 *   - It boots its own `pnpm dev` Next.js server. Note that this script forces
 *     CI=1 below, which makes playwright.config.ts's
 *     `reuseExistingServer: !process.env.CI` evaluate false — so a fresh dev
 *     server is started every single time, never reused.
 *   - It launches its own chrome-headless-shell process group.
 *   - It prepares and mutates the shared `compass_e2e` database. Two runs
 *     overlapping there corrupt each other's fixtures regardless of memory.
 *
 * On 2026-09-17 two agent threads started this suite ~11 minutes apart in two
 * different worktrees. The combined dev servers and browser groups drove swap
 * to 8.4 GB of 9.2 GB and took the whole machine down. Nothing in the stack
 * pushed back, because `workers: 1` only serializes *within* a single run.
 *
 * So serialize *across* runs, at the machine level. The lock deliberately
 * lives in os.tmpdir() rather than inside any worktree: every worktree copy of
 * this script must contend for the same one file.
 *
 * Default behaviour is to WAIT rather than fail, so an agent that hits a busy
 * machine queues instead of erroring out and retrying in a loop.
 *   E2E_LOCK_TIMEOUT_MS=0  -> fail fast instead of waiting
 *   E2E_SKIP_LOCK=1        -> bypass entirely (only when you know no other run
 *                             is live; unguarded concurrency is what crashed
 *                             the machine)
 * ────────────────────────────────────────────────────────────────────────── */

const LOCK_PATH = path.join(os.tmpdir(), "compass-e2e-functional.lock");
const LOCK_TIMEOUT_MS = Number(process.env.E2E_LOCK_TIMEOUT_MS ?? 30 * 60 * 1000);
const LOCK_POLL_MS = 5_000;
const LOCK_NOTICE_MS = 30_000;

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user - still alive.
    return error.code === "EPERM";
  }
}

function tryAcquireLock(attempt = 0) {
  try {
    // "wx" fails if the file already exists, which makes this atomic.
    const fd = fs.openSync(LOCK_PATH, "wx");
    fs.writeSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        cwd: process.cwd(),
        mode,
        startedAt: new Date().toISOString(),
      }),
    );
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;

    const holder = readLock();
    // Reclaim a lock whose owner died (SIGKILL, crash, machine reboot).
    if (!holder || !pidAlive(holder.pid)) {
      if (attempt >= 3) return false;
      try {
        fs.unlinkSync(LOCK_PATH);
      } catch {
        // Someone else reclaimed it first; fall through and retry.
      }
      return tryAcquireLock(attempt + 1);
    }
    return false;
  }
}

function releaseLock() {
  const holder = readLock();
  if (holder && holder.pid !== process.pid) return; // not ours - leave it alone
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    // Already gone.
  }
}

function describeHolder(holder) {
  return holder
    ? `pid ${holder.pid} in ${holder.cwd} (mode=${holder.mode}, since ${holder.startedAt})`
    : "another process";
}

function acquireLockOrExit() {
  if (process.env.E2E_SKIP_LOCK === "1") {
    console.warn(
      "[e2e-lock] E2E_SKIP_LOCK=1 - running without the machine-wide mutex. " +
        "Concurrent functional runs can exhaust memory and corrupt compass_e2e.",
    );
    return;
  }

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let lastNotice = 0;

  for (;;) {
    if (tryAcquireLock()) {
      process.on("exit", releaseLock);
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.on(signal, () => {
          releaseLock();
          process.exit(1);
        });
      }
      return;
    }

    const holder = readLock();

    if (Date.now() >= deadline) {
      console.error(
        `[e2e-lock] Another functional e2e run holds the lock: ${describeHolder(holder)}\n` +
          `[e2e-lock] Refusing to start a second one - concurrent runs each boot their own\n` +
          `[e2e-lock] Next.js dev server and browser group, and share the compass_e2e database.\n` +
          `[e2e-lock] Wait for it to finish, or raise E2E_LOCK_TIMEOUT_MS to wait longer.`,
      );
      process.exit(1);
    }

    if (Date.now() - lastNotice >= LOCK_NOTICE_MS) {
      const waitedS = Math.round((LOCK_TIMEOUT_MS - (deadline - Date.now())) / 1000);
      console.log(
        `[e2e-lock] Waiting for functional e2e lock held by ${describeHolder(holder)} - ${waitedS}s elapsed.`,
      );
      lastNotice = Date.now();
    }

    // Synchronous sleep: this script is sequential (spawnSync throughout) and
    // must not proceed until the lock is genuinely held.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
  }
}

acquireLockOrExit();

const env = {
  ...process.env,
  CI: "1",
  E2E_FUNCTIONAL: "1",
  E2E_ISOLATED_DATABASE: "1",
};

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

const prepareCode = run(["scripts/prepare-e2e-database.mjs"]);
if (prepareCode !== 0) process.exit(prepareCode);

const playwrightCode = run([
  "node_modules/@playwright/test/cli.js",
  "test",
  ...modes[mode],
  "--retries=0",
  ...passthrough,
]);
const cleanupCode = run(["scripts/verify-e2e-cleanup.mjs"]);

process.exit(playwrightCode !== 0 ? playwrightCode : cleanupCode);
