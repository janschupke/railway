import { beforeEach } from "vitest";
import { clearLogRecords, installLogCapture } from "./log-capture";

process.env.RAILWAY_CLIENT_ID ??= "test-client-id";
process.env.RAILWAY_CLIENT_SECRET ??= "test-client-secret";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-chars-long";
process.env.APP_URL ??= "http://localhost:3000";
process.env.MANAGED_PREFIX ??= "spun-";

/*
 * `debug`, not `silent`. Two suites already wrote real error output to stdout during
 * `pnpm test` and nobody noticed; capturing at the lowest level makes that output
 * assertable instead of invisible, and the capture passes non-log writes through so the
 * terminal stays readable. Setup runs before logger.ts is first evaluated in each worker,
 * which is what fixes the level in time.
 */
process.env.LOG_LEVEL ??= "debug";

installLogCapture();
beforeEach(clearLogRecords);
