import assert from "node:assert/strict";
import test from "node:test";
import { readCandidateIdentity, REVIEW_ORIGIN } from "./pr-browser-review-runtime.mjs";

const expected = { id: "candidate-version", tag: "candidate-sha", timestamp: "2026-09-03" };
const options = { reviewOrigin: REVIEW_ORIGIN, expectedVersionTag: expected.tag };
function fixture(candidates, status = 200) {
  let requests = 0;
  const delays = [];
  return {
    delays,
    get requests() { return requests; },
    async goto(url) {
      assert.equal(url, `${REVIEW_ORIGIN}/api/review/identity`);
      const candidate = candidates[Math.min(requests++, candidates.length - 1)];
      return { ok: () => status === 200, status: () => status, json: async () => candidate };
    },
    async waitForTimeout(ms) { delays.push(ms); },
  };
}

test("waits for the exact candidate before starting a review", async () => {
  const page = fixture([{ ...expected, tag: "previous-sha" }, expected]);
  assert.deepEqual(await readCandidateIdentity(page, options), expected);
  assert.equal(page.requests, 2);
  assert.deepEqual(page.delays, [2000]);
});
test("rejects a stale deployment after bounded admission attempts", async () => {
  const page = fixture([{ ...expected, tag: "previous-sha" }]);
  await assert.rejects(readCandidateIdentity(page, options), /does not match expected tag/);
  assert.equal(page.requests, 16);
  assert.equal(page.delays.length, 15);
});
test("never retries an identity change during an admitted review", async () => {
  for (const candidate of [{ ...expected, id: "different-version" }, { ...expected, tag: "different-sha" }]) {
    const page = fixture([candidate, expected]);
    await assert.rejects(readCandidateIdentity(page, { ...options, expectedVersionId: expected.id }), /changed|does not match/);
    assert.equal(page.requests, 1);
    assert.deepEqual(page.delays, []);
  }
});
test("fails closed on authorization errors and malformed identity", async () => {
  for (const page of [fixture([expected], 401), fixture([{}])]) {
    await assert.rejects(readCandidateIdentity(page, options), /failed with status 401|invalid Worker version metadata/);
    assert.equal(page.requests, 1);
    assert.deepEqual(page.delays, []);
  }
});
