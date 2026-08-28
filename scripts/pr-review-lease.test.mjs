import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acquireReviewLeaseSql,
  createCloudflareReviewLease,
  releaseReviewLeaseSql,
  renewReviewLeaseSql,
} from "./pr-review-lease.mjs";

const OWNER = "manual-20260827T120000Z-01234567";
const SOURCE_URL = "https://github.com/dayhaysoos/carpo/pull/8";
const FENCING_TOKEN = "a".repeat(32);
const FENCED_OWNER = `${OWNER}:${FENCING_TOKEN}`;

function d1Result(row, changes = 1) {
  return [
    {
      success: true,
      results: row ? [row] : [],
      meta: { changes },
    },
  ];
}

describe("shared Cloudflare review lease", () => {
  it("builds bounded acquire, renew, and owner-only release statements", () => {
    assert.match(
      acquireReviewLeaseSql({
        owner: OWNER,
        sourceUrl: SOURCE_URL,
        fencingToken: FENCING_TOKEN,
      }),
      /ON CONFLICT\(name\) DO UPDATE/,
    );
    assert.doesNotMatch(
      acquireReviewLeaseSql({
        owner: OWNER,
        sourceUrl: SOURCE_URL,
        fencingToken: FENCING_TOKEN,
      }),
      /OR _carpo_pr_review_lease\.owner = excluded\.owner/,
    );
    assert.match(
      renewReviewLeaseSql(OWNER, FENCING_TOKEN),
      /WHERE name = .* AND owner =/,
    );
    assert.match(releaseReviewLeaseSql(OWNER, FENCING_TOKEN), /DELETE FROM/);
    assert.throws(
      () =>
        acquireReviewLeaseSql({
          owner: "bad-owner'; DROP TABLE videos; --",
          sourceUrl: SOURCE_URL,
          fencingToken: FENCING_TOKEN,
        }),
      /invalid format/,
    );
  });

  it("acquires, renews, and releases one owner through the injected D1 client", async () => {
    const statements = [];
    const row = {
      owner: FENCED_OWNER,
      sourceUrl: SOURCE_URL,
      acquiredAt: 1_787_834_400,
      expiresAt: 1_787_837_100,
      observedAt: 1_787_834_400,
    };
    const lease = createCloudflareReviewLease({
      owner: OWNER,
      sourceUrl: SOURCE_URL,
      fencingToken: FENCING_TOKEN,
      executeSql: async (sql) => {
        statements.push(sql);
        return sql.startsWith("DELETE") ? d1Result(undefined) : d1Result(row);
      },
    });

    assert.deepEqual(await lease.acquire(), row);
    assert.deepEqual(await lease.renew(), row);
    await lease.release();
    assert.equal(statements.length, 3);
  });

  it("rejects a concurrent runner that reuses the same execution ID", async () => {
    const lease = createCloudflareReviewLease({
      owner: OWNER,
      sourceUrl: SOURCE_URL,
      fencingToken: "b".repeat(32),
      executeSql: async () =>
        d1Result(
          {
            owner: FENCED_OWNER,
            sourceUrl: SOURCE_URL,
            acquiredAt: 1_787_834_400,
            expiresAt: 1_787_837_100,
            observedAt: 1_787_834_400,
          },
          0,
        ),
    });

    await assert.rejects(() => lease.acquire(), /leased by manual-20260827/);
  });

  it("fails closed when another trigger owns the unexpired lease", async () => {
    const lease = createCloudflareReviewLease({
      owner: OWNER,
      sourceUrl: SOURCE_URL,
      executeSql: async () =>
        d1Result({
          owner: `actions-32981962097-2:${"c".repeat(32)}`,
          sourceUrl: "https://github.com/dayhaysoos/carpo/actions/runs/32981962097",
          acquiredAt: 1_787_834_400,
          expiresAt: 1_787_837_100,
          observedAt: 1_787_834_400,
        }, 0),
    });

    await assert.rejects(() => lease.acquire(), /leased by actions-32981962097-2/);
  });
});
