import { use, useLayoutEffect, useRef } from "react";
import rrwebPlayer from "rrweb-player";
import "rrweb-player/dist/style.css";
import type { RrwebEvent } from "./types";

const recordings = new Map<
  string,
  Promise<{ events: RrwebEvent[]; duration: number }>
>();

function recording(sessionId: string) {
  let pending = recordings.get(sessionId);
  if (!pending) {
    pending = fetch(`/api/recordings/${sessionId}`, {
      credentials: "same-origin",
    }).then(async (response) => {
      const body = (await response.json()) as {
        events?: RrwebEvent[];
        duration?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      return { events: body.events ?? [], duration: body.duration ?? 0 };
    });
    recordings.set(sessionId, pending);
  }
  return pending;
}

export default function RecordingPlayer({ sessionId }: { sessionId: string }) {
  const container = useRef<HTMLDivElement>(null);
  const data = use(recording(sessionId));

  useLayoutEffect(() => {
    const target = container.current;
    if (!target || data.events.length < 2) return;
    const width = Math.min(target.clientWidth || 960, 960);
    new rrwebPlayer({
      target,
      props: {
        events: data.events,
        width,
        height: Math.round((width * 9) / 16),
        autoPlay: false,
        showController: true,
      },
    });
    return () => {
      target.innerHTML = "";
    };
  }, [data.events]);

  if (data.events.length < 2) {
    return <p className="muted">The replay is empty or still being finalized.</p>;
  }

  return (
    <div className="recording">
      <div ref={container} />
    </div>
  );
}
