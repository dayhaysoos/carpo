import { useAgentChat } from "@cloudflare/think/react";
import { getToolName, isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  extractTimestampEntities,
  type TimestampEntity,
  type TimestampWindow,
} from "../timestamp-windows";
import { ClipApprovalCard } from "./ClipApprovalCard";
import type { ManualClipInput } from "./ClipApprovalCard";

interface VideoAgentChatProps {
  videoId: string;
  onClipCreated: () => void;
  onTimestampSelect: (window: TimestampWindow) => void;
}

const CLIP_WINDOW_SECONDS = [5, 10, 30, 60] as const;
type ClipWindowSeconds = (typeof CLIP_WINDOW_SECONDS)[number];

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
  onClipCreated,
  onTimestampSelect,
}: VideoAgentChatProps) {
  const [input, setInput] = useState("");
  const [clipWindowSeconds, setClipWindowSeconds] =
    useState<ClipWindowSeconds>(10);
  const [connected, setConnected] = useState(false);
  const completedClipIds = useRef(new Set<string>());
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
    status,
    error,
  } = useAgentChat({ agent });
  const chatMessages = messages as UIMessage[];
  const timestampEntities = useMemo(
    () => extractTimestampEntities(input, clipWindowSeconds),
    [clipWindowSeconds, input],
  );
  const composerMirrorRef = useRef<HTMLDivElement>(null);

  const working = status === "submitted" || status === "streaming";

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
          <p>Describe one timestamp range. You approve it before creation.</p>
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

                if (part.state === "approval-requested") {
                  const approval = "approval" in part
                    ? (part.approval as { id?: unknown })
                    : undefined;
                  if (
                    typeof approval?.id !== "string" ||
                    !isManualClipInput(part.input)
                  ) {
                    return null;
                  }
                  return (
                    <ClipApprovalCard
                      key={part.toolCallId}
                      approvalId={approval.id}
                      input={part.input}
                      onDecision={(approvalId, approved) =>
                        addToolApprovalResponse({ id: approvalId, approved })
                      }
                    />
                  );
                }

                if (part.state === "output-available") {
                  const output = part.output as
                    | { clipId?: unknown; status?: unknown }
                    | undefined;
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
          <div className="agent-window-picker">
            <span>Clip length</span>
            <div role="group" aria-label="Default clip length">
              {CLIP_WINDOW_SECONDS.map((seconds) => (
                <button
                  key={seconds}
                  type="button"
                  aria-label={`Use ${seconds} second clips`}
                  aria-pressed={clipWindowSeconds === seconds}
                  onClick={() => setClipWindowSeconds(seconds)}
                >
                  {seconds}s
                </button>
              ))}
            </div>
          </div>
          <button
            type="submit"
            className="btn-primary"
            disabled={!connected || working || !input.trim()}
          >
            Send
          </button>
        </div>
      </form>
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
