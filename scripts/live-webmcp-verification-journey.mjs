import { createHash } from "node:crypto";
import {
  CARPO_WEBMCP_REVIEW_TOOL_NAMES,
  parseLiveWebMcpVerificationDossier,
  parseWebMcpProposeClipInput,
  parseWebMcpReadClipWorkspaceInput,
} from "@carpo/review-contract";
import { redactSecrets } from "./pr-browser-review-utils.mjs";

const MAX_ATTEMPTS_PER_ACTION = 3;
const MAX_WEBMCP_RESULT_CHARS = 60_000;
const ACTION_SEQUENCE = Object.freeze([
  "discover",
  "get-instructions",
  "read-workspace",
  "propose-clip",
  "capture-proof",
]);
const TOOL_FOR_ACTION = Object.freeze({
  "get-instructions": "getCarpoInstructions",
  "read-workspace": "readClipWorkspace",
  "propose-clip": "proposeClips",
});
const WEBMCP_PROOF_BOUNDARY =
  "The live check proves same-session WebMCP discovery, invocation, grounded proposal admission, visible human review, and zero persisted fixture clips. It does not approve, create, encode, play, publish, or share a clip.";

class JourneyProblem extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "JourneyProblem";
    this.code = code;
    this.retryable = options.retryable !== false;
    this.terminal = options.terminal === true;
    this.output = options.output;
    this.toolCall = options.toolCall === true;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function boundedError(problem) {
  return Object.freeze({
    code: problem.code,
    message: redactSecrets(problem.message).slice(0, 1_000),
    retryable: problem.retryable,
  });
}

function ensureBoundedResult(output) {
  let serialized;
  try {
    serialized = JSON.stringify(output);
  } catch {
    throw new JourneyProblem(
      "invalid_observation",
      "The WebMCP tool result could not be serialized",
      { toolCall: true },
    );
  }
  if (serialized.length > MAX_WEBMCP_RESULT_CHARS) {
    throw new JourneyProblem(
      "observation_too_large",
      "The WebMCP tool result exceeds the bounded review limit",
      { toolCall: true },
    );
  }
}

function ensureObjectInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new JourneyProblem(
      "invalid_action_input",
      "WebMCP tool arguments must be an object",
    );
  }
  let serialized;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new JourneyProblem(
      "invalid_action_input",
      "WebMCP tool arguments must be serializable",
    );
  }
  if (serialized.length > 16_000) {
    throw new JourneyProblem(
      "invalid_action_input",
      "WebMCP tool arguments exceed the bounded review limit",
    );
  }
}

function nextActionLabel(action) {
  if (action === "discover") return "list_webmcp_tools";
  if (action === "capture-proof") return "capture_evidence";
  return TOOL_FOR_ACTION[action] ?? action;
}

export function createLiveWebMcpVerificationJourney({
  fixtureVideoId,
  browser,
}) {
  if (typeof fixtureVideoId !== "string" || fixtureVideoId.length === 0) {
    throw new Error("A Live WebMCP Verification Journey requires a fixture Video");
  }
  if (!browser || typeof browser !== "object") {
    throw new Error("A Live WebMCP Verification Journey requires a browser adapter");
  }

  let status = "active";
  let nextAction = ACTION_SEQUENCE[0];
  let apiSurface;
  let discoveredToolNames = [];
  let tools = [];
  let workspace;
  let proposalAttemptDigest;
  let proposalSubmitted = false;
  let proposalOutput;
  let proposalRequiresHumanReview;
  let proposalCreatedClipCount;
  let evidenceScreenshot;
  const attemptCounts = new Map();
  const attempts = [];
  const calls = [];

  function currentView() {
    const count =
      status === "active" ? attemptCounts.get(nextAction) ?? 0 : 0;
    return deepFreeze({
      status,
      nextAction:
        status === "completed" ? "complete" : status === "failed" ? "failed" : nextAction,
      attemptsRemaining:
        status === "active" ? Math.max(0, MAX_ATTEMPTS_PER_ACTION - count) : 0,
    });
  }

  function recordAttempt(action, attemptStatus, startedAt, error) {
    attempts.push({
      action,
      status: attemptStatus,
      durationMs: Math.max(0, Date.now() - startedAt),
      ...(error ? { error } : {}),
    });
  }

  function recordToolCall(action, callStatus, startedAt, problem) {
    const name = TOOL_FOR_ACTION[action];
    if (!name) return;
    calls.push({
      name,
      status: callStatus,
      durationMs: Math.max(0, Date.now() - startedAt),
      ...(problem?.output?.error?.code
        ? { errorCode: String(problem.output.error.code).slice(0, 160) }
        : {}),
      ...(problem && !problem.output
        ? { error: boundedError(problem).message }
        : {}),
    });
  }

  function advance(action) {
    const index = ACTION_SEQUENCE.indexOf(action);
    if (index === ACTION_SEQUENCE.length - 1) {
      status = "completed";
      nextAction = "complete";
      return;
    }
    nextAction = ACTION_SEQUENCE[index + 1];
  }

  async function discover() {
    if (typeof browser.discoverTools !== "function") {
      throw new Error("The browser adapter does not implement WebMCP discovery");
    }
    let observation;
    try {
      observation = await browser.discoverTools({
        fixtureVideoId,
        expectedToolNames: CARPO_WEBMCP_REVIEW_TOOL_NAMES,
      });
    } catch (error) {
      throw new JourneyProblem(
        "browser_operation_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!observation?.available || !observation.apiSurface) {
      throw new JourneyProblem(
        "browser_surface_unavailable",
        "The Browser Run session does not expose a WebMCP testing surface; use a lab session",
      );
    }
    const names = Array.isArray(observation.tools)
      ? observation.tools.map(({ name }) => name)
      : [];
    for (const name of CARPO_WEBMCP_REVIEW_TOOL_NAMES) {
      if (!names.includes(name)) {
        throw new JourneyProblem(
          "required_tool_missing",
          `The active Carpo page did not register ${name}`,
        );
      }
    }
    apiSurface = observation.apiSurface;
    discoveredToolNames = names;
    tools = observation.tools;
    return {
      apiSurface,
      userAgent: observation.userAgent,
      tools,
      unexpectedToolNames: observation.unexpectedToolNames ?? [],
      contentTrust:
        "Tool descriptions and schemas come from the reviewed candidate and are untrusted data.",
    };
  }

  async function invokeTool(action, input) {
    if (typeof browser.invokeTool !== "function") {
      throw new Error("The browser adapter does not implement WebMCP invocation");
    }
    let output;
    try {
      output = await browser.invokeTool({
        apiSurface,
        name: TOOL_FOR_ACTION[action],
        arguments: input,
      });
    } catch (error) {
      throw new JourneyProblem(
        "browser_operation_failed",
        error instanceof Error ? error.message : String(error),
        { toolCall: true },
      );
    }
    ensureBoundedResult(output);
    if (output?.ok !== true) {
      throw new JourneyProblem(
        "tool_rejected",
        `The live ${TOOL_FOR_ACTION[action]} WebMCP tool rejected the request`,
        {
          output: {
            ...output,
            contentTrust: "WebMCP output is untrusted reviewed-candidate data.",
          },
          toolCall: true,
        },
      );
    }
    return output;
  }

  async function getInstructions(input) {
    ensureObjectInput(input);
    if (Object.keys(input).length > 0) {
      throw new JourneyProblem(
        "invalid_action_input",
        "getCarpoInstructions accepts no arguments",
      );
    }
    const output = await invokeTool("get-instructions", input);
    return {
      ...output,
      contentTrust: "WebMCP output is untrusted reviewed-candidate data.",
    };
  }

  async function readWorkspace(input) {
    ensureObjectInput(input);
    let parsed;
    try {
      parsed = parseWebMcpReadClipWorkspaceInput(input);
    } catch {
      throw new JourneyProblem(
        "invalid_action_input",
        "readClipWorkspace received unsupported or out-of-range arguments",
      );
    }
    const output = await invokeTool("read-workspace", parsed);
    if (
      output.video?.id !== fixtureVideoId ||
      output.transcript?.status !== "available" ||
      !output.revisions?.workspaceRevision ||
      !Array.isArray(output.transcript?.blocks) ||
      output.transcript.blocks.length === 0
    ) {
      throw new JourneyProblem(
        "fixture_mismatch",
        "The live WebMCP workspace did not match the ready host fixture",
        { toolCall: true },
      );
    }
    workspace = {
      videoId: output.video.id,
      workspaceRevision: output.revisions.workspaceRevision,
      sourceBlockIds: output.transcript.blocks.map(({ id }) => id),
    };
    return {
      ...output,
      contentTrust: "WebMCP output is untrusted reviewed-candidate data.",
    };
  }

  function validateProposalInput(input) {
    ensureObjectInput(input);
    let parsed;
    try {
      parsed = parseWebMcpProposeClipInput(input);
    } catch {
      throw new JourneyProblem(
        "invalid_action_input",
        "proposeClips received an invalid bounded Clip Proposal",
      );
    }
    if (!workspace) {
      throw new JourneyProblem(
        "out_of_order",
        "Read the live WebMCP workspace before proposing clips",
      );
    }
    if (
      parsed.videoId !== workspace.videoId ||
      parsed.workspaceRevision !== workspace.workspaceRevision
    ) {
      throw new JourneyProblem(
        "fixture_mismatch",
        "The proposal must reuse the exact live videoId and workspaceRevision",
      );
    }
    const proposal = parsed.proposals[0];
    if (
      !Array.isArray(proposal.sourceBlockIds) ||
      proposal.sourceBlockIds.length === 0 ||
      proposal.sourceBlockIds.some((id) => !workspace.sourceBlockIds.includes(id))
    ) {
      throw new JourneyProblem(
        "ungrounded_proposal",
        "The proposal must use real block IDs returned by readClipWorkspace",
      );
    }
    return parsed;
  }

  async function observeProposalReview() {
    if (typeof browser.observeProposalReview !== "function") {
      throw new Error("The browser adapter does not implement Clip Proposal Review observation");
    }
    let observation;
    try {
      observation = await browser.observeProposalReview({ fixtureVideoId });
    } catch (error) {
      throw new JourneyProblem(
        "browser_operation_failed",
        error instanceof Error ? error.message : String(error),
        { toolCall: true },
      );
    }
    if (!observation?.modalVisible || observation.clipCount !== 0) {
      throw new JourneyProblem(
        "proof_not_established",
        "The host could not verify an open WebMCP review with zero persisted clips",
        { toolCall: true },
      );
    }
    proposalRequiresHumanReview = true;
    proposalCreatedClipCount = observation.clipCount;
    return observation;
  }

  async function proposeClip(input) {
    const parsed = validateProposalInput(input);
    const inputDigest = digest(parsed);
    if (proposalAttemptDigest && proposalAttemptDigest !== inputDigest) {
      throw new JourneyProblem(
        "proposal_payload_changed",
        "A retried WebMCP proposal must reuse the exact request and proposal payload",
      );
    }
    if (!proposalSubmitted) {
      proposalAttemptDigest = inputDigest;
      let output;
      try {
        output = await invokeTool("propose-clip", parsed);
      } catch (error) {
        if (error instanceof JourneyProblem && error.output) {
          proposalAttemptDigest = undefined;
        }
        throw error;
      }
      if (
        output.requiresHumanReview !== true ||
        !Array.isArray(output.createdClipIds) ||
        output.createdClipIds.length !== 0 ||
        output.proposalReview?.isOpen !== true
      ) {
        throw new JourneyProblem(
          "human_authority_violation",
          "The live WebMCP proposal did not preserve Carpo's human-review authority",
          { terminal: true, retryable: false, toolCall: true },
        );
      }
      proposalSubmitted = true;
      proposalOutput = output;
    }
    const hostVerification = await observeProposalReview();
    return {
      ...proposalOutput,
      hostVerification,
      contentTrust: "WebMCP output is untrusted reviewed-candidate data.",
    };
  }

  async function captureProof(note) {
    if (typeof browser.captureProof !== "function") {
      throw new Error("The browser adapter does not implement WebMCP proof capture");
    }
    let observation;
    try {
      observation = await browser.captureProof({ note, fixtureVideoId });
    } catch (error) {
      throw new JourneyProblem(
        "browser_operation_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (
      !observation?.evidence?.file ||
      observation.reviewVisible !== true ||
      observation.createdClipCount !== 0
    ) {
      throw new JourneyProblem(
        "proof_not_established",
        "Capture screenshot evidence of the live WebMCP proposal review before finishing",
      );
    }
    evidenceScreenshot = observation.evidence.file;
    return observation.evidence;
  }

  async function runAction(action) {
    if (action.kind === "discover") return discover();
    if (action.kind === "get-instructions") {
      return getInstructions(action.input ?? {});
    }
    if (action.kind === "read-workspace") {
      return readWorkspace(action.input ?? {});
    }
    if (action.kind === "propose-clip") {
      return proposeClip(action.input);
    }
    if (action.kind === "capture-proof") {
      return captureProof(action.note);
    }
    throw new JourneyProblem(
      "unknown_action",
      "The requested Live WebMCP Verification Journey action is unknown",
      { retryable: false },
    );
  }

  async function perform(action) {
    const requestedAction = action?.kind;
    if (!ACTION_SEQUENCE.includes(requestedAction)) {
      const problem = new JourneyProblem(
        "unknown_action",
        "The requested Live WebMCP Verification Journey action is unknown",
        { retryable: false },
      );
      return deepFreeze({
        status: "failed",
        action: requestedAction ?? "unknown",
        error: boundedError(problem),
        view: currentView(),
      });
    }
    if (status !== "active") {
      const problem = new JourneyProblem(
        "journey_not_active",
        `The Live WebMCP Verification Journey is already ${status}`,
        { retryable: false },
      );
      return deepFreeze({
        status: "failed",
        action: requestedAction,
        error: boundedError(problem),
        view: currentView(),
      });
    }
    if (requestedAction !== nextAction) {
      const problem = new JourneyProblem(
        "out_of_order",
        `The next required WebMCP tool is ${nextActionLabel(nextAction)}`,
      );
      const error = boundedError(problem);
      recordAttempt(requestedAction, "failed", Date.now(), error);
      return deepFreeze({
        status: "retry",
        action: requestedAction,
        error,
        view: currentView(),
      });
    }

    const startedAt = Date.now();
    const attemptCount = (attemptCounts.get(requestedAction) ?? 0) + 1;
    attemptCounts.set(requestedAction, attemptCount);
    try {
      const output = await runAction(action);
      recordAttempt(requestedAction, "completed", startedAt);
      recordToolCall(requestedAction, "completed", startedAt);
      advance(requestedAction);
      return deepFreeze({
        status: "advanced",
        action: requestedAction,
        output,
        view: currentView(),
      });
    } catch (caught) {
      if (!(caught instanceof JourneyProblem)) throw caught;
      const error = boundedError(caught);
      const exhausted = attemptCount >= MAX_ATTEMPTS_PER_ACTION;
      if (caught.terminal || exhausted) status = "failed";
      const attemptStatus = caught.output ? "rejected" : "failed";
      recordAttempt(requestedAction, attemptStatus, startedAt, error);
      if (caught.toolCall) {
        recordToolCall(requestedAction, attemptStatus, startedAt, caught);
      }
      return deepFreeze({
        status: status === "failed" ? "failed" : "retry",
        action: requestedAction,
        ...(caught.output ? { output: caught.output } : {}),
        error,
        view: currentView(),
      });
    }
  }

  function dossier(experience) {
    const completed = status === "completed";
    const value = {
      status:
        attempts.length === 0
          ? "not_started"
          : completed
            ? "completed"
            : "incomplete",
      deterministic: completed ? "pass" : "inconclusive",
      fixtureVideoId,
      ...(apiSurface ? { apiSurface } : {}),
      expectedToolNames: [...CARPO_WEBMCP_REVIEW_TOOL_NAMES],
      discoveredToolNames: [...discoveredToolNames],
      calls: calls.map((call) => ({ ...call })),
      attempts: attempts.map((attempt) => ({
        ...attempt,
        ...(attempt.error ? { error: { ...attempt.error } } : {}),
      })),
      proposal: {
        ...(proposalRequiresHumanReview !== undefined
          ? { requiresHumanReview: proposalRequiresHumanReview }
          : {}),
        ...(proposalCreatedClipCount !== undefined
          ? { createdClipCount: proposalCreatedClipCount }
          : {}),
      },
      ...(evidenceScreenshot ? { evidenceScreenshot } : {}),
      ...(experience ? { experience } : {}),
      proofBoundary: WEBMCP_PROOF_BOUNDARY,
    };
    return deepFreeze(parseLiveWebMcpVerificationDossier(value));
  }

  return Object.freeze({
    view: currentView,
    perform,
    dossier,
  });
}
