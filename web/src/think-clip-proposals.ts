import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type {
  ClipProposalEnvelope,
  ClipProposalInput,
  ClipProposalOutcome,
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

function isClipProposalInput(value: unknown): value is ClipProposalInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.title === "string" &&
    typeof input.startSeconds === "number" &&
    typeof input.endSeconds === "number" &&
    (input.caption === undefined || typeof input.caption === "string") &&
    (input.quality === undefined ||
      input.quality === "720p" ||
      input.quality === "1080p")
  );
}

function thinkProposalReferences(messages: UIMessage[]): ThinkProposalReference[] {
  const proposals: ThinkProposalReference[] = [];
  for (const message of messages) {
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

export function extractThinkClipProposals(
  messages: UIMessage[],
  videoId: string,
  callbacks: ThinkProposalCallbacks,
): ClipProposalEnvelope[] {
  return thinkProposalReferences(messages).map((proposal) => ({
    id: `think:${videoId}:${proposal.proposalId}`,
    videoId,
    idempotencyKey: proposal.toolCallId,
    input: { ...proposal.input },
    settle: async (outcome) => {
      await settleThinkProposal(proposal, callbacks, outcome);
    },
  }));
}
