import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LEASE_NAME = "shared-review-environment";
const LEASE_TTL_SECONDS = 45 * 60;
const DEFAULT_RETRY_DELAY_MS = 10_000;
const REVIEW_DATABASE_ID = "27981ced-fd12-49ea-9ce8-e71205e3f36e";
const EXECUTION_ID_PATTERN =
  /^(?:actions-[1-9][0-9]{0,19}-[1-9][0-9]{0,2}|manual-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8})$/;

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function requireOwner(owner) {
  if (!EXECUTION_ID_PATTERN.test(owner)) {
    throw new Error("review lease owner has an invalid format");
  }
  return owner;
}

function requireFencingToken(fencingToken) {
  if (!/^[0-9a-f]{32}$/.test(fencingToken)) {
    throw new Error("review lease fencing token has an invalid format");
  }
  return fencingToken;
}

function fencedOwner(owner, fencingToken) {
  return `${requireOwner(owner)}:${requireFencingToken(fencingToken)}`;
}

class ReviewLeaseBusyError extends Error {}

function requireSourceUrl(sourceUrl) {
  const url = new URL(sourceUrl);
  if (url.origin !== "https://github.com" || url.search || url.hash) {
    throw new Error("review lease source URL must be an exact GitHub URL");
  }
  return url.href;
}

function leaseSchemaSql() {
  return `CREATE TABLE IF NOT EXISTS _carpo_pr_review_lease (
    name TEXT PRIMARY KEY NOT NULL,
    owner TEXT NOT NULL,
    source_url TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`;
}

export function acquireReviewLeaseSql({ owner, sourceUrl, fencingToken }) {
  const safeOwner = fencedOwner(owner, fencingToken);
  const safeSourceUrl = requireSourceUrl(sourceUrl);
  return `${leaseSchemaSql()};
INSERT INTO _carpo_pr_review_lease (name, owner, source_url, acquired_at, expires_at)
VALUES (${sqlText(LEASE_NAME)}, ${sqlText(safeOwner)}, ${sqlText(safeSourceUrl)}, unixepoch(), unixepoch() + ${LEASE_TTL_SECONDS})
ON CONFLICT(name) DO UPDATE SET
  owner = excluded.owner,
  source_url = excluded.source_url,
  acquired_at = excluded.acquired_at,
  expires_at = excluded.expires_at
WHERE _carpo_pr_review_lease.expires_at <= unixepoch();
SELECT owner, source_url AS sourceUrl, acquired_at AS acquiredAt,
       expires_at AS expiresAt, unixepoch() AS observedAt
FROM _carpo_pr_review_lease WHERE name = ${sqlText(LEASE_NAME)}`;
}

export function renewReviewLeaseSql(owner, fencingToken) {
  const safeOwner = fencedOwner(owner, fencingToken);
  return `UPDATE _carpo_pr_review_lease
SET expires_at = unixepoch() + ${LEASE_TTL_SECONDS}
WHERE name = ${sqlText(LEASE_NAME)} AND owner = ${sqlText(safeOwner)};
SELECT owner, source_url AS sourceUrl, acquired_at AS acquiredAt,
       expires_at AS expiresAt, unixepoch() AS observedAt
FROM _carpo_pr_review_lease WHERE name = ${sqlText(LEASE_NAME)}`;
}

export function releaseReviewLeaseSql(owner, fencingToken) {
  const safeOwner = fencedOwner(owner, fencingToken);
  return `DELETE FROM _carpo_pr_review_lease
WHERE name = ${sqlText(LEASE_NAME)} AND owner = ${sqlText(safeOwner)}`;
}

function leaseRow(result) {
  if (!Array.isArray(result) || result.some((entry) => entry?.success !== true)) {
    throw new Error("Cloudflare D1 did not complete the review lease operation");
  }
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const row = result[index]?.results?.[0];
    if (row) return row;
  }
  throw new Error("Cloudflare D1 did not return the active review lease");
}

async function executeRemoteSql(sql, { cwd, env }) {
  const { stdout } = await execFileAsync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      REVIEW_DATABASE_ID,
      "--remote",
      "--command",
      sql,
      "--json",
    ],
    {
      cwd,
      env,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout);
}

export function createCloudflareReviewLease({
  owner,
  sourceUrl,
  cwd,
  env,
  fencingToken = randomBytes(16).toString("hex"),
  executeSql = (sql) => executeRemoteSql(sql, { cwd, env }),
  now = () => Date.now(),
  wait = (durationMs) =>
    new Promise((resolve) => setTimeout(resolve, durationMs)),
}) {
  const safeOwner = requireOwner(owner);
  const safeSourceUrl = requireSourceUrl(sourceUrl);
  const safeFencingToken = requireFencingToken(fencingToken);
  const safeFencedOwner = fencedOwner(safeOwner, safeFencingToken);
  let acquired = false;

  const requireOwned = (row) => {
    if (row.owner !== safeFencedOwner) {
      const expiresAt = new Date(Number(row.expiresAt) * 1_000).toISOString();
      const activeExecutionId = String(row.owner).split(":", 1)[0];
      throw new ReviewLeaseBusyError(
        `The shared Cloudflare review environment is leased by ${activeExecutionId} until ${expiresAt}. Retry after that review finishes.`,
      );
    }
    return row;
  };

  return {
    async acquire({ waitMs = 0, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = {}) {
      if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
        throw new Error("review lease wait must be a non-negative integer");
      }
      if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs <= 0) {
        throw new Error("review lease retry delay must be a positive integer");
      }
      const deadline = now() + waitMs;
      while (true) {
        const row = leaseRow(
          await executeSql(
            acquireReviewLeaseSql({
              owner: safeOwner,
              sourceUrl: safeSourceUrl,
              fencingToken: safeFencingToken,
            }),
          ),
        );
        try {
          requireOwned(row);
          acquired = true;
          return row;
        } catch (error) {
          if (!(error instanceof ReviewLeaseBusyError)) throw error;
          const remainingMs = deadline - now();
          if (remainingMs <= 0) throw error;
          await wait(Math.min(retryDelayMs, remainingMs));
        }
      }
    },
    async renew() {
      if (!acquired) throw new Error("Cannot renew a review lease before acquiring it");
      return requireOwned(
        leaseRow(
          await executeSql(
            renewReviewLeaseSql(safeOwner, safeFencingToken),
          ),
        ),
      );
    },
    async release() {
      if (!acquired) return;
      const result = await executeSql(
        releaseReviewLeaseSql(safeOwner, safeFencingToken),
      );
      if (!Array.isArray(result) || result.some((entry) => entry?.success !== true)) {
        throw new Error("Cloudflare D1 did not release the review lease");
      }
      acquired = false;
    },
  };
}
