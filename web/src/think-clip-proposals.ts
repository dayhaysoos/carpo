import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type {
  ClipProposalAdmissionResult,
  ClipProposalInput,
  ClipProposalOutcome,
  ClipProposalSubmission,
} from "./clip-proposal-review";

interface ThinkProposalCallbacks {
  addToolApprovalResponse: (response: {
    id: string;
    approved: boolean;
  }) => void | PromiseLike<void>;
  addToolOutput: (response: {
    toolCallId: string;
    output: unknown;
  }) => void | PromiseLike<void>;
}

interface ThinkProposalReference {
  proposalId: string;
  toolCallId: string;
  resolution: "approval" | "client";
  input: ClipProposalInput;
}

export interface ThinkClipProposalSubmission {
  submission: ClipProposalSubmission;
  reportAdmission: (result: ClipProposalAdmissionResult) => Promise<void>;
}

function isClipProposalInput(value: unknown): value is ClipProposalInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.title === "string" &&
    typeof input.startSeconds === "number" &&
    typeof input.endSeconds === "number" &&
    (input.caption === undefined || typeof input.caption === "string") &&
    (input.quality === undefined || typeof input.quality === "string")
  );
}

function thinkProposalReferences(message: UIMessage): ThinkProposalReference[] {
  const proposals: ThinkProposalReference[] = [];
  for (const part of message.parts) {
    if (!isToolUIPart(part) || getToolName(part) !== "createClip") continue;
    if (!isClipProposalInput(part.input)) continue;

    if (part.state === "input-available") {
      proposals.push({
        proposalId: part.toolCallId,
        toolCallId: part.toolCallId,
        resolution: "client",
        input: part.input,
      });
      continue;
    }

    if (part.state !== "approval-requested") continue;
    const approval = "approval" in part
      ? (part.approval as { id?: unknown })
      : undefined;
    if (typeof approval?.id !== "string") continue;
    proposals.push({
      proposalId: approval.id,
      toolCallId: part.toolCallId,
      resolution: "approval",
      input: part.input,
    });
  }
  return proposals;
}

function settleThinkProposal(
  proposal: ThinkProposalReference,
  callbacks: ThinkProposalCallbacks,
  outcome: ClipProposalOutcome,
): void | PromiseLike<void> {
  if (outcome.status === "created") {
    return callbacks.addToolOutput({
      toolCallId: proposal.toolCallId,
      output: {
        clipId: outcome.clip.id,
        title: outcome.clip.title,
        startSeconds: outcome.clip.startSeconds,
        endSeconds: outcome.clip.endSeconds,
        quality: outcome.clip.quality,
        status: outcome.clip.status,
      },
    });
  }

  if (proposal.resolution === "approval") {
    return callbacks.addToolApprovalResponse({
      id: proposal.proposalId,
      approved: false,
    });
  }

  return callbacks.addToolOutput({
    toolCallId: proposal.toolCallId,
    output: {
      status: outcome.status,
      reason:
        outcome.status === "cancelled"
          ? "The clip proposal was cancelled."
          : "User rejected this proposed clip.",
    },
  });
}

async function reportThinkAdmission(
  proposals: ThinkProposalReference[],
  callbacks: ThinkProposalCallbacks,
  result: ClipProposalAdmissionResult,
): Promise<void> {
  const references = new Map(
    proposals.map((proposal) => [proposal.proposalId, proposal]),
  );
  for (const rejected of result.items.filter(
    ({ state }) => state === "rejected",
  )) {
    const proposal = references.get(rejected.proposalId);
    if (!proposal) continue;
    const reason = rejected.issues.map(({ message }) => message).join(" ");
    if (proposal.resolution === "approval") {
      await callbacks.addToolApprovalResponse({
        id: proposal.proposalId,
        approved: false,
      });
    } else {
      await callbacks.addToolOutput({
        toolCallId: proposal.toolCallId,
        output: { status: "invalid", reason },
      });
    }
  }
}

export function extractThinkClipProposalSubmissions(
  messages: UIMessage[],
  videoId: string,
  callbacks: ThinkProposalCallbacks,
): ThinkClipProposalSubmission[] {
  return messages.flatMap((message) => {
    const proposals = thinkProposalReferences(message);
    if (proposals.length === 0) return [];
    return [
      {
        submission: {
          adapter: "think" as const,
          requestId: message.id,
          videoId,
          proposals: proposals.map((proposal) => ({
            proposalId: proposal.proposalId,
            input: { ...proposal.input },
            settle: async (outcome: ClipProposalOutcome) => {
              await settleThinkProposal(proposal, callbacks, outcome);
            },
          })),
        },
        reportAdmission: (result: ClipProposalAdmissionResult) =>
          reportThinkAdmission(proposals, callbacks, result),
      },
    ];
  });
}
