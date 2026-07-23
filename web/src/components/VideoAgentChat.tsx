import { useAgentChat } from "@cloudflare/think/react";
import { getToolName, isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClipFromSourceVideo } from "../api";
import type { ClipSource } from "../types";
import {
  extractTimestampEntities,
  type TimestampEntity,
  type TimestampWindow,
} from "../timestamp-windows";
import type { ExistingClipRange } from "../timeline";
import {
  ClipReviewModal,
  type ManualClipInput,
  type PendingClipApproval,
} from "./ClipReviewModal";

interface VideoAgentChatProps {
  videoId: string;
  source?: ClipSource;
  retainedSourceReady?: boolean;
  onClipCreated: () => void;
  onTimestampSelect: (window: TimestampWindow) => void;
  existingClips?: ExistingClipRange[];
}

const DEFAULT_TIMESTAMP_WINDOW_SECONDS = 10;

function isManualClipInput(value: unknown): value is ManualClipInput {
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

function messageText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function VideoAgentChat({
  videoId,
  source,
  retainedSourceReady = false,
  onClipCreated,
  onTimestampSelect,
  existingClips = [],
}: VideoAgentChatProps) {
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const completedClipIds = useRef(new Set<string>());
  const lastAutoAppliedTimestamp = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [activeReviewIndex, setActiveReviewIndex] = useState(0);
  const [reviewDecisions, setReviewDecisions] = useState<
    Record<string, boolean>
  >({});
  const [reviewInputs, setReviewInputs] = useState<
    Record<string, ManualClipInput>
  >({});
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewSubmitError, setReviewSubmitError] = useState<string | null>(
    null,
  );
  const [submittedReviewBatch, setSubmittedReviewBatch] = useState<
    string | null
  >(null);
  const openedReviewIds = useRef(new Set<string>());

  const agent = useAgent({
    agent: "VideoClipAgent",
    name: videoId,
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(() => setConnected(false), []),
  });
  const {
    messages,
    sendMessage,
    addToolApprovalResponse,
    addToolOutput,
    status,
    error,
  } = useAgentChat({ agent });
  const chatMessages = messages as UIMessage[];
  const pendingApprovals = useMemo(() => {
    const approvals: PendingClipApproval[] = [];
    for (const message of chatMessages) {
      for (const part of message.parts) {
        if (!isToolUIPart(part) || getToolName(part) !== "createClip") continue;
        if (!isManualClipInput(part.input)) {
          continue;
        }
        if (part.state === "input-available") {
          approvals.push({
            approvalId: part.toolCallId,
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
        approvals.push({
          approvalId: approval.id,
          toolCallId: part.toolCallId,
          resolution: "approval",
          input: part.input,
        });
      }
    }
    return approvals.sort(
      (left, right) =>
        left.input.startSeconds - right.input.startSeconds ||
        left.input.endSeconds - right.input.endSeconds,
    );
  }, [chatMessages]);
  const reviewBatchKey = pendingApprovals
    .map((approval) => approval.approvalId)
    .join(":");
  const timestampEntities = useMemo(
    () => extractTimestampEntities(input, DEFAULT_TIMESTAMP_WINDOW_SECONDS),
    [input],
  );
  const composerMirrorRef = useRef<HTMLDivElement>(null);

  const working = status === "submitted" || status === "streaming";

  useEffect(() => {
    if (pendingApprovals.length === 0) {
      openedReviewIds.current.clear();
      return;
    }
    const belongsToOpenReview = pendingApprovals.every((approval) =>
      openedReviewIds.current.has(approval.approvalId),
    );
    if (
      working ||
      belongsToOpenReview
    ) {
      return;
    }
    openedReviewIds.current = new Set(
      pendingApprovals.map((approval) => approval.approvalId),
    );
    setActiveReviewIndex(0);
    setReviewDecisions({});
    setReviewInputs(
      Object.fromEntries(
        pendingApprovals.map((approval) => [
          approval.approvalId,
          approval.input,
        ]),
      ),
    );
    setReviewSubmitError(null);
    setSubmittedReviewBatch(null);
    setReviewOpen(true);
  }, [pendingApprovals, working]);

  useEffect(() => {
    setActiveReviewIndex((current) =>
      Math.min(current, Math.max(0, pendingApprovals.length - 1)),
    );
  }, [pendingApprovals.length]);

  const submitReview = async (
    decisions: Readonly<Record<string, boolean>>,
  ) => {
    setReviewSubmitting(true);
    setReviewSubmitError(null);
    try {
      for (const approval of pendingApprovals) {
        if (!Object.hasOwn(decisions, approval.approvalId)) continue;
        const approved = decisions[approval.approvalId];
        if (!approved) {
          if (approval.resolution === "approval") {
            addToolApprovalResponse({
              id: approval.approvalId,
              approved: false,
            });
          } else {
            addToolOutput({
              toolCallId: approval.toolCallId,
              output: {
                status: "rejected",
                reason: "User rejected this proposed clip.",
              },
            });
          }
          continue;
        }

        const input = reviewInputs[approval.approvalId] ?? approval.input;
        const clip = await createClipFromSourceVideo(
          videoId,
          {
            title: input.title,
            trimStart: input.startSeconds,
            trimEnd: input.endSeconds,
            quality: input.quality ?? "1080p",
            filters: input.caption
              ? [{ type: "caption", text: input.caption }]
              : [],
          },
          approval.toolCallId,
        );
        addToolOutput({
          toolCallId: approval.toolCallId,
          output: {
            clipId: clip.id,
            title: clip.title,
            startSeconds: clip.trimStart,
            endSeconds: clip.trimEnd,
            quality: clip.quality,
            status: clip.status,
          },
        });
      }
      setSubmittedReviewBatch(reviewBatchKey);
      setReviewOpen(false);
    } catch (submissionError) {
      setReviewSubmitError(
        submissionError instanceof Error
          ? submissionError.message
          : "The approved clips could not be created.",
      );
    } finally {
      setReviewSubmitting(false);
    }
  };

  const submitAll = (approved: boolean) => {
    const decisions = Object.fromEntries(
      pendingApprovals.map((approval) => [approval.approvalId, approved]),
    );
    setReviewDecisions(decisions);
    void submitReview(decisions);
  };

  useEffect(() => {
    const entity = timestampEntities.at(-1);
    if (!entity) {
      lastAutoAppliedTimestamp.current = null;
      return;
    }

    const signature = [
      entity.startIndex,
      entity.endIndex,
      entity.startSeconds,
      entity.endSeconds,
    ].join(":");
    if (lastAutoAppliedTimestamp.current === signature) return;

    lastAutoAppliedTimestamp.current = signature;
    onTimestampSelect({
      label: entity.label,
      startSeconds: entity.startSeconds,
      endSeconds: entity.endSeconds,
    });
  }, [onTimestampSelect, timestampEntities]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    for (const message of chatMessages) {
      for (const part of message.parts) {
        if (!isToolUIPart(part) || getToolName(part) !== "createClip") continue;
        if (part.state !== "output-available") continue;
        const output = part.output as { clipId?: unknown } | undefined;
        if (typeof output?.clipId !== "string") continue;
        if (completedClipIds.current.has(output.clipId)) continue;
        completedClipIds.current.add(output.clipId);
        onClipCreated();
      }
    }
  }, [chatMessages, onClipCreated]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || working || !connected) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  };

  return (
    <section className="agent-chat card" aria-label="Clip with Think">
      <div className="card-header agent-chat-header">
        <div>
          <h2>Clip with Think</h2>
          <p>Describe clips by timestamp. You approve them before creation.</p>
        </div>
        <span className={`agent-connection ${connected ? "connected" : ""}`}>
          {connected ? "Ready" : "Connecting"}
        </span>
      </div>

      <div className="agent-messages" aria-live="polite">
        {chatMessages.length === 0 ? (
          <div className="agent-empty">
            <strong>Try a manual instruction</strong>
            <p>“Clip from 2:10 to 2:28 and call it PO tokens explained.”</p>
          </div>
        ) : null}

        {chatMessages.map((message) => {
          const text = messageText(message.parts);
          return (
            <div key={message.id} className={`agent-message ${message.role}`}>
              {text ? <div className="agent-bubble">{text}</div> : null}
              {message.parts.map((part) => {
                if (!isToolUIPart(part)) return null;
                const toolName = getToolName(part);
                if (toolName !== "createClip") {
                  return part.state === "input-available" ||
                    part.state === "input-streaming" ? (
                    <div key={part.toolCallId} className="agent-tool-status">
                      Checking this video…
                    </div>
                  ) : null;
                }

                if (
                  part.state === "approval-requested" ||
                  part.state === "input-available"
                ) {
                  return null;
                }

                if (part.state === "output-available") {
                  const output = part.output as
                    | { clipId?: unknown; status?: unknown }
                    | undefined;
                  if (output?.status === "rejected") {
                    return (
                      <div key={part.toolCallId} className="agent-tool-status">
                        Rejected — nothing was created.
                      </div>
                    );
                  }
                  return (
                    <div key={part.toolCallId} className="agent-tool-success">
                      Clip queued{typeof output?.clipId === "string" ? ` · ${output.clipId.slice(0, 8)}` : ""}
                    </div>
                  );
                }

                if (part.state === "output-denied") {
                  return (
                    <div key={part.toolCallId} className="agent-tool-status">
                      Rejected — nothing was created.
                    </div>
                  );
                }

                if (part.state === "output-error") {
                  return (
                    <div key={part.toolCallId} className="agent-tool-error" role="alert">
                      {part.errorText || "The clip could not be created."}
                    </div>
                  );
                }

                return null;
              })}
            </div>
          );
        })}
        {pendingApprovals.length > 0 &&
        submittedReviewBatch !== reviewBatchKey ? (
          <div className="agent-review-ready">
            <div>
              <strong>
                {pendingApprovals.length} clip
                {pendingApprovals.length === 1 ? "" : "s"} ready to review
              </strong>
              <span>Nothing will be created until you finish reviewing.</span>
            </div>
            <button
              type="button"
              className="btn-primary"
              onClick={() => setReviewOpen(true)}
            >
              Review clips
            </button>
          </div>
        ) : null}
        {working ? <div className="agent-thinking">Think is working…</div> : null}
        <div ref={endRef} />
      </div>

      {error ? (
        <div className="agent-tool-error" role="alert">
          {error.message}
        </div>
      ) : null}

      <form className="agent-composer" onSubmit={submit}>
        <div className="agent-composer-input">
          <div
            ref={composerMirrorRef}
            className="agent-composer-highlight"
          >
            <TimestampHighlightedText
              text={input}
              entities={timestampEntities}
              onSelect={onTimestampSelect}
            />
          </div>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onScroll={(event) => {
              if (composerMirrorRef.current) {
                composerMirrorRef.current.scrollTop =
                  event.currentTarget.scrollTop;
              }
            }}
            placeholder="Clip from 1:20 to 1:35…"
            rows={3}
            disabled={!connected || working}
            aria-label="Clip instruction"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
        </div>
        <div className="agent-composer-footer">
          <button
            type="submit"
            className="btn-primary"
            disabled={!connected || working || !input.trim()}
          >
            Send
          </button>
        </div>
      </form>

      {reviewOpen && pendingApprovals.length > 0 ? (
        <ClipReviewModal
          videoId={videoId}
          source={source}
          retainedSourceReady={retainedSourceReady}
          approvals={pendingApprovals}
          activeIndex={activeReviewIndex}
          decisions={reviewDecisions}
          inputs={reviewInputs}
          submitting={reviewSubmitting}
          submitError={reviewSubmitError}
          onActiveIndexChange={setActiveReviewIndex}
          onInputChange={(approvalId, nextInput) =>
            setReviewInputs((current) => ({
              ...current,
              [approvalId]: nextInput,
            }))
          }
          onDecision={(approvalId, approved) =>
            setReviewDecisions((current) => ({
              ...current,
              [approvalId]: approved,
            }))
          }
          onSubmit={() => void submitReview(reviewDecisions)}
          onApproveAll={() => submitAll(true)}
          onRejectAll={() => submitAll(false)}
          onDismiss={() => setReviewOpen(false)}
          existingClips={existingClips}
        />
      ) : null}
    </section>
  );
}

function TimestampHighlightedText({
  text,
  entities,
  onSelect,
}: {
  text: string;
  entities: TimestampEntity[];
  onSelect: (window: TimestampWindow) => void;
}) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (const entity of entities) {
    if (entity.startIndex > cursor) {
      parts.push(
        <span aria-hidden="true" key={`text-${cursor}`}>
          {text.slice(cursor, entity.startIndex)}
        </span>,
      );
    }
    parts.push(
      <button
        key={`timestamp-${entity.startIndex}-${entity.endIndex}`}
        type="button"
        className="agent-inline-timestamp"
        aria-label={`Set editor to ${entity.label.replace(" → ", " through ")}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() =>
          onSelect({
            label: entity.label,
            startSeconds: entity.startSeconds,
            endSeconds: entity.endSeconds,
          })
        }
      >
        {entity.sourceText}
      </button>,
    );
    cursor = entity.endIndex;
  }

  if (cursor < text.length) {
    parts.push(
      <span aria-hidden="true" key={`text-${cursor}`}>
        {text.slice(cursor)}
      </span>,
    );
  }

  return parts;
}
