import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLiveWebMcpVerificationJourney } from "./live-webmcp-verification-journey.mjs";

const fixtureVideoId = "7e57a4c2-20a6-4d83-8f08-57b807338ead";
const workspaceRevision = "workspace-revision";
const proposalInput = {
  requestId: "live-review",
  videoId: fixtureVideoId,
  workspaceRevision,
  proposals: [
    {
      proposalId: "one",
      title: "Human review matters",
      startSeconds: 0,
      endSeconds: 4,
      sourceBlockIds: ["cue-0-0"],
    },
  ],
};

function createBrowser(overrides = {}) {
  const calls = [];
  const browser = {
    calls,
    async discoverTools(input) {
      calls.push(["discoverTools", input]);
      return {
        available: true,
        apiSurface: "navigator.modelContextTesting",
        userAgent: "Chrome/146",
        tools: [
          { name: "getCarpoInstructions" },
          { name: "readClipWorkspace" },
          { name: "proposeClips" },
        ],
        unexpectedToolNames: [],
      };
    },
    async invokeTool(input) {
      calls.push(["invokeTool", input]);
      if (input.name === "getCarpoInstructions") return { ok: true };
      if (input.name === "readClipWorkspace") {
        return {
          ok: true,
          revisions: { workspaceRevision },
          video: { id: fixtureVideoId },
          transcript: {
            status: "available",
            blocks: [
              {
                id: "cue-0-0",
                startSeconds: 0,
                endSeconds: 4,
                text: "Fixture transcript",
              },
            ],
          },
        };
      }
      return {
        ok: true,
        requiresHumanReview: true,
        createdClipIds: [],
        proposalReview: { isOpen: true },
      };
    },
    async observeProposalReview(input) {
      calls.push(["observeProposalReview", input]);
      return { modalVisible: true, persistenceStatus: 200, clipCount: 0 };
    },
    async captureProof(input) {
      calls.push(["captureProof", input]);
      return {
        evidence: {
          file: "agentic-03.png",
          note: input.note,
          url: `https://example.test/?video=${fixtureVideoId}`,
          path: "/",
          sha256: "digest",
          webMcp: { reviewVisible: true, createdClipCount: 0 },
        },
        reviewVisible: true,
        createdClipCount: 0,
      };
    },
    ...overrides,
  };
  return browser;
}

async function advanceToProposal(journey) {
  assert.equal((await journey.perform({ kind: "discover" })).status, "advanced");
  assert.equal(
    (
      await journey.perform({
        kind: "get-instructions",
        input: {},
      })
    ).status,
    "advanced",
  );
  assert.equal(
    (
      await journey.perform({
        kind: "read-workspace",
        input: { transcriptOffset: 0, transcriptLimit: 4 },
      })
    ).status,
    "advanced",
  );
}

describe("Live WebMCP Verification Journey", () => {
  it("owns the ordered reversible journey and returns a validated dossier", async () => {
    const browser = createBrowser();
    const journey = createLiveWebMcpVerificationJourney({
      fixtureVideoId,
      browser,
    });

    assert.deepEqual(journey.view(), {
      status: "active",
      nextAction: "discover",
      attemptsRemaining: 3,
    });
    await advanceToProposal(journey);
    assert.equal(
      (await journey.perform({ kind: "propose-clip", input: proposalInput }))
        .status,
      "advanced",
    );
    assert.equal(journey.view().nextAction, "capture-proof");
    assert.equal(
      (
        await journey.perform({
          kind: "capture-proof",
          note: "Clip Proposal Review is visible",
        })
      ).status,
      "advanced",
    );

    const dossier = journey.dossier();
    assert.equal(dossier.status, "completed");
    assert.equal(dossier.deterministic, "pass");
    assert.equal(dossier.experience, undefined);
    assert.equal(dossier.proposal.requiresHumanReview, true);
    assert.equal(dossier.proposal.createdClipCount, 0);
    assert.equal(dossier.evidenceScreenshot, "agentic-03.png");
    assert.deepEqual(
      dossier.calls.map(({ name, status }) => [name, status]),
      [
        ["getCarpoInstructions", "completed"],
        ["readClipWorkspace", "completed"],
        ["proposeClips", "completed"],
      ],
    );
    assert.equal(Object.isFrozen(dossier), true);
  });

  it("rejects out-of-order work without reaching the browser adapter", async () => {
    const browser = createBrowser();
    const journey = createLiveWebMcpVerificationJourney({
      fixtureVideoId,
      browser,
    });

    const receipt = await journey.perform({
      kind: "read-workspace",
      input: { transcriptLimit: 4 },
    });
    assert.equal(receipt.status, "retry");
    assert.equal(receipt.error.code, "out_of_order");
    assert.equal(receipt.view.nextAction, "discover");
    assert.equal(receipt.view.attemptsRemaining, 3);
    assert.deepEqual(browser.calls, []);
  });

  it("retains a rejected attempt after a corrected retry succeeds", async () => {
    let instructionAttempts = 0;
    const browser = createBrowser({
      async invokeTool(input) {
        browser.calls.push(["invokeTool", input]);
        if (input.name === "getCarpoInstructions") {
          instructionAttempts += 1;
          return instructionAttempts === 1
            ? { ok: false, error: { code: "TEMPORARY" } }
            : { ok: true };
        }
        throw new Error("Unexpected tool");
      },
    });
    const journey = createLiveWebMcpVerificationJourney({
      fixtureVideoId,
      browser,
    });

    await journey.perform({ kind: "discover" });
    const rejected = await journey.perform({
      kind: "get-instructions",
      input: {},
    });
    assert.equal(rejected.status, "retry");
    assert.equal(rejected.output.ok, false);
    assert.equal(rejected.view.attemptsRemaining, 2);
    const corrected = await journey.perform({
      kind: "get-instructions",
      input: {},
    });
    assert.equal(corrected.status, "advanced");

    const dossier = journey.dossier();
    assert.deepEqual(
      dossier.calls.map(({ status }) => status),
      ["rejected", "completed"],
    );
    assert.deepEqual(
      dossier.attempts
        .filter(({ action }) => action === "get-instructions")
        .map(({ status }) => status),
      ["rejected", "completed"],
    );
  });

  it("re-observes a submitted proposal without invoking it twice", async () => {
    let observations = 0;
    const browser = createBrowser({
      async observeProposalReview(input) {
        browser.calls.push(["observeProposalReview", input]);
        observations += 1;
        return observations === 1
          ? { modalVisible: false, persistenceStatus: 200, clipCount: 0 }
          : { modalVisible: true, persistenceStatus: 200, clipCount: 0 };
      },
    });
    const journey = createLiveWebMcpVerificationJourney({
      fixtureVideoId,
      browser,
    });
    await advanceToProposal(journey);

    assert.equal(
      (await journey.perform({ kind: "propose-clip", input: proposalInput }))
        .status,
      "retry",
    );
    assert.equal(
      (await journey.perform({ kind: "propose-clip", input: proposalInput }))
        .status,
      "advanced",
    );
    assert.equal(
      browser.calls.filter(
        ([operation, input]) =>
          operation === "invokeTool" && input.name === "proposeClips",
      ).length,
      1,
    );
    assert.equal(
      browser.calls.filter(([operation]) => operation === "observeProposalReview")
        .length,
      2,
    );
  });

  it("fails closed after the bounded retry budget is exhausted", async () => {
    const browser = createBrowser({
      async discoverTools(input) {
        browser.calls.push(["discoverTools", input]);
        return { available: false, tools: [] };
      },
    });
    const journey = createLiveWebMcpVerificationJourney({
      fixtureVideoId,
      browser,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const receipt = await journey.perform({ kind: "discover" });
      assert.equal(receipt.status, attempt === 2 ? "failed" : "retry");
    }
    assert.deepEqual(journey.view(), {
      status: "failed",
      nextAction: "failed",
      attemptsRemaining: 0,
    });
    assert.equal(journey.dossier().deterministic, "inconclusive");
    assert.equal(journey.dossier().attempts.length, 3);
  });
});
