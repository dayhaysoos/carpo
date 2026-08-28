import { useAgentChat } from "@cloudflare/think/react";
import { getToolName, isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClipProposalReview } from "../clip-proposal-review";
import { createClipProposalReview } from "../create-clip-proposal-review";
import { useClipProposalReview } from "../hooks/useClipProposalReview";
import { extractThinkClipProposalSubmissions } from "../think-clip-proposals";
import type { ClipSource } from "../types";
import {
  extractTimestampEntities,
  type TimestampEntity,
  type TimestampWindow,
} from "../timestamp-windows";
import type { ExistingClipRange } from "../timeline";
import { ClipReviewModal } from "./ClipReviewModal";

interface VideoAgentChatProps {
  videoId: string;
  source?: ClipSource;
  retainedSourceReady?: boolean;
  videoDurationSeconds?: number | null;
  onClipCreated: () => void;
  onTimestampSelect: (window: TimestampWindow) => void;
  existingClips?: ExistingClipRange[];
  proposalReview?: ClipProposalReview;
}

const DEFAULT_TIMESTAMP_WINDOW_SECONDS = 10;
const EMPTY_EXISTING_CLIPS: ExistingClipRange[] = [];

function messageText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function VideoAgentChat(props: VideoAgentChatProps) {
  const [fallbackProposalReview] = useState(createClipProposalReview);
  const proposalReview = props.proposalReview ?? fallbackProposalReview;

  useEffect(() => {
    if (!props.videoId) proposalReview.activate(null);
  }, [proposalReview, props.videoId]);

  if (!props.videoId) {
    return (
      <section className="agent-chat card" aria-label="Clip with Think">
        <div className="card-header agent-chat-header">
          <div>
            <h2>Clip with Think</h2>
            <p>
              Choose a YouTube video or upload a file to start clipping.
            </p>
          </div>
          <span className="agent-connection" role="status" aria-live="polite">
            Waiting
          </span>
        </div>

        <div className="agent-messages" aria-live="polite">
          <div className="agent-empty">
            <strong>Think is ready when your video is</strong>
            <p>Paste a YouTube URL or upload a video to continue.</p>
          </div>
        </div>

        <form className="agent-composer">
          <div className="agent-composer-input">
            <textarea
              placeholder="Choose a video to start clipping…"
              rows={3}
              disabled
              aria-label="Clip instruction"
            />
          </div>
          <div className="agent-composer-footer">
            <button type="submit" className="btn-primary" disabled>
              Send
            </button>
          </div>
        </form>
      </section>
    );
  }

  return (
    <ConnectedVideoAgentChat
      key={props.videoId}
      {...props}
      proposalReview={proposalReview}
    />
  );
}

function ConnectedVideoAgentChat({
  videoId,
  source,
  retainedSourceReady = false,
  videoDurationSeconds = null,
  onClipCreated,
  onTimestampSelect,
  existingClips = EMPTY_EXISTING_CLIPS,
  proposalReview,
}: Omit<VideoAgentChatProps, "proposalReview"> & {
  proposalReview: ClipProposalReview;
}) {
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const lastAutoAppliedTimestamp = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

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
  const reviewState = useClipProposalReview(proposalReview);
  const hasActiveVideoReview = reviewState.videoId === videoId;
  const thinkSubmissions = useMemo(
    () =>
      extractThinkClipProposalSubmissions(chatMessages, videoId, {
        addToolApprovalResponse,
        addToolOutput,
      }),
    [addToolApprovalResponse, addToolOutput, chatMessages, videoId],
  );
  const timestampEntities = useMemo(
    () => extractTimestampEntities(input, DEFAULT_TIMESTAMP_WINDOW_SECONDS),
    [input],
  );
  const composerMirrorRef = useRef<HTMLDivElement>(null);

  const working = status === "submitted" || status === "streaming";

  useEffect(() => {
    proposalReview.activate({ id: videoId, durationSeconds: videoDurationSeconds });
  }, [proposalReview, videoDurationSeconds, videoId]);

  useEffect(() => {
    if (!working) {
      for (const { submission, reportAdmission } of thinkSubmissions) {
        const result = proposalReview.admit(submission);
        void reportAdmission(result).catch((error: unknown) => {
          console.error("Think clip proposal admission reporting failed", error);
        });
      }
    }
  }, [proposalReview, thinkSubmissions, working]);

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
  }, [chatMessages]);

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
          <p>
            Describe clips by timestamp, spoken phrase, or idea. You approve
            them before creation.
          </p>
        </div>
        <span
          className={`agent-connection ${connected ? "connected" : ""}`}
          role="status"
          aria-live="polite"
        >
          {connected ? "Ready" : "Connecting"}
        </span>
      </div>

      <div className="agent-messages" aria-live="polite">
        {chatMessages.length === 0 ? (
          <div className="agent-empty">
            <strong>Try an instruction</strong>
            <p>“Clip every time ‘code’ is said.”</p>
            <p>“Find the strongest explanation of the main idea.”</p>
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
        {hasActiveVideoReview && reviewState.items.length > 0 ? (
          <div className="agent-review-ready">
            <div>
              <strong>
                {reviewState.items.length} clip
                {reviewState.items.length === 1 ? "" : "s"} ready to review
              </strong>
              <span>Nothing will be created until you finish reviewing.</span>
            </div>
            <button
              type="button"
              className="btn-primary"
              onClick={() => proposalReview.dispatch({ type: "open" })}
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
            placeholder="Clip by time, phrase, or idea…"
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

      {hasActiveVideoReview &&
      reviewState.isOpen &&
      reviewState.items.length > 0 ? (
        <ClipReviewModal
          review={proposalReview}
          videoId={videoId}
          source={source}
          retainedSourceReady={retainedSourceReady}
          onClipCreated={onClipCreated}
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
