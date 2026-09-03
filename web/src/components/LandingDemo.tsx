import { useEffect, useRef, useState } from "react";
import { loadYoutubeApi, type YTPlayer } from "../youtube-api";
import { demoSamples, demoTime, type DemoSample } from "./landing-demo-samples";

type PlaybackStatus = "ready" | "loading" | "playing" | "paused" | "error";

interface DemoPlayerProps {
  sample: DemoSample;
  selected: number | null;
  request: number;
  muted: boolean;
  onMutedChange: (muted: boolean) => void;
  onStatus: (status: PlaybackStatus) => void;
}

function LocalDemoPlayer({
  sample,
  selected,
  request,
  muted,
  onMutedChange,
  onStatus,
}: DemoPlayerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const media = sample.media;
  const source =
    media.kind === "local"
      ? selected === null
        ? media.source
        : media.clips[selected]
      : "";

  useEffect(() => {
    const player = video.current;
    if (!player) return;
    player.muted = muted;
    if (!muted && player.volume === 0) player.volume = 1;
  }, [muted]);

  useEffect(() => {
    const player = video.current;
    if (!player || request === 0) return;
    let cancelled = false;
    player.currentTime = 0;
    onStatus("loading");
    void player.play().catch((error: unknown) => {
      if (!cancelled)
        onStatus(
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "paused"
            : "error",
        );
    });
    return () => {
      cancelled = true;
    };
  }, [source, request, onStatus]);

  return (
    <video
      ref={video}
      src={source}
      poster={media.kind === "local" ? media.poster : undefined}
      muted={muted}
      playsInline
      preload="none"
      controls
      aria-label={
        selected === null
          ? `${sample.title} sample video`
          : `${sample.moments[selected].title} sample clip`
      }
      onPlay={() => onStatus("playing")}
      onPause={() => onStatus("paused")}
      onEnded={() => onStatus("ready")}
      onError={() => onStatus("error")}
      onVolumeChange={(event) =>
        onMutedChange(
          event.currentTarget.muted || event.currentTarget.volume === 0,
        )
      }
    />
  );
}

function YoutubeDemoPlayer(props: DemoPlayerProps) {
  const container = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [ready, setReady] = useState(false);
  const videoId =
    props.sample.media.kind === "youtube" ? props.sample.media.videoId : "";

  useEffect(() => {
    let cancelled = false;
    let volumeTimer: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      if (!cancelled) latest.current.onStatus("error");
    }, 15000);
    latest.current.onStatus("loading");

    void loadYoutubeApi()
      .then(() => {
        if (cancelled || !window.YT || !container.current) return;
        // YouTube replaces its target node. Keep React's wrapper intact so cleanup
        // and StrictMode remounts cannot leave a detached player behind.
        const target = document.createElement("div");
        target.id = `demo-youtube-${crypto.randomUUID()}`;
        container.current.replaceChildren(target);
        player.current = new window.YT.Player(target.id, {
          videoId,
          host: "https://www.youtube-nocookie.com",
          width: "100%",
          height: "100%",
          playerVars: {
            origin: window.location.origin,
            playsinline: 1,
            rel: 0,
            cc_load_policy: 1,
            cc_lang_pref: "en",
          },
          events: {
            onReady: ({ target: readyPlayer }) => {
              if (cancelled) return;
              clearTimeout(timeout);
              if (latest.current.muted) readyPlayer.mute();
              else readyPlayer.unMute();
              container.current
                ?.querySelector("iframe")
                ?.setAttribute("title", "The Next Token sample player");
              setReady(true);
              volumeTimer = setInterval(() => {
                const soundOff =
                  readyPlayer.isMuted() || readyPlayer.getVolume() === 0;
                if (soundOff !== latest.current.muted)
                  latest.current.onMutedChange(soundOff);
              }, 250);
            },
            onStateChange: ({ data }) => {
              if (!cancelled)
                latest.current.onStatus(
                  data === 1 ? "playing" : data === 3 ? "loading" : "ready",
                );
            },
            onError: () => {
              clearTimeout(timeout);
              if (!cancelled) latest.current.onStatus("error");
            },
            onAutoplayBlocked: () => {
              if (!cancelled) latest.current.onStatus("paused");
            },
          },
        });
      })
      .catch(() => {
        if (!cancelled) latest.current.onStatus("error");
      });

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      clearInterval(volumeTimer);
      player.current?.destroy();
      player.current = null;
    };
  }, [videoId]);

  useEffect(() => {
    if (!ready || !player.current) return;
    const moment = props.sample.moments[props.selected ?? 0];
    const clip = {
      videoId,
      startSeconds: moment.start,
      endSeconds: moment.end,
    };
    if (props.request > 0) player.current.loadVideoById(clip);
    else player.current.cueVideoById(clip);
  }, [ready, videoId, props.sample, props.selected, props.request]);

  useEffect(() => {
    if (!ready || !player.current) return;
    if (props.muted) player.current.mute();
    else {
      if (player.current.getVolume() === 0) player.current.setVolume(100);
      player.current.unMute();
    }
  }, [ready, props.muted]);

  return <div ref={container} className="demo-youtube" />;
}

export function LandingDemo() {
  const [sourceIndex, setSourceIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(
    demoSamples[0].media.kind === "youtube" ? 0 : null,
  );
  const [request, setRequest] = useState(0);
  const [muted, setMuted] = useState(true);
  const [status, setStatus] = useState<PlaybackStatus>("ready");
  const sample = demoSamples[sourceIndex];
  const moment = selected === null ? null : sample.moments[selected];
  const Player =
    sample.media.kind === "local" ? LocalDemoPlayer : YoutubeDemoPlayer;
  const sourceUrl =
    sample.media.kind === "youtube"
      ? `https://www.youtube.com/watch?v=${sample.media.videoId}&t=${(moment ?? sample.moments[0]).start}s`
      : "https://studio.blender.org/projects/charge/";

  function changeSource(index: number) {
    const next = (index + demoSamples.length) % demoSamples.length;
    if (next === sourceIndex) return;
    setSourceIndex(next);
    setSelected(demoSamples[next].media.kind === "youtube" ? 0 : null);
    setRequest(0);
    setStatus("ready");
  }

  return (
    <section
      className="landing-demo"
      aria-labelledby="demo-title"
      aria-roledescription="carousel"
    >
      <div className="demo-heading">
        <h2 id="demo-title">One source. Three possibilities.</h2>
        <span>Interactive samples</span>
      </div>
      <div className="demo-carousel-controls">
        <div
          className="demo-sample-options"
          role="group"
          aria-label="Choose a sample"
        >
          {demoSamples.map((item, index) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={index === sourceIndex}
              onClick={() => changeSource(index)}
            >
              {item.category}
            </button>
          ))}
        </div>
        <div className="demo-carousel-arrows">
          <span aria-live="polite" aria-atomic="true">
            {String(sourceIndex + 1).padStart(2, "0")} /{" "}
            {String(demoSamples.length).padStart(2, "0")}
          </span>
          <button
            type="button"
            aria-label="Previous sample"
            onClick={() => changeSource(sourceIndex - 1)}
          >
            ←
          </button>
          <button
            type="button"
            aria-label="Next sample"
            onClick={() => changeSource(sourceIndex + 1)}
          >
            →
          </button>
        </div>
      </div>
      <div className="demo-sample-heading">
        <h3>{sample.title}</h3>
        <p>{sample.description}</p>
      </div>
      <div
        className="demo-workspace"
        role="group"
        aria-roledescription="slide"
        aria-label={`${sourceIndex + 1} of ${demoSamples.length}: ${sample.title}`}
      >
        <div className="demo-source">
          <Player
            key={sample.id}
            sample={sample}
            selected={selected}
            request={request}
            muted={muted}
            onMutedChange={setMuted}
            onStatus={setStatus}
          />
          <div className="demo-source-caption">
            <span>{moment?.title ?? `${sample.title} — sample source`}</span>
            <div className="demo-playback-controls">
              <span>
                {moment
                  ? `${demoTime(moment.start)} – ${demoTime(moment.end)}`
                  : "00:18"}
              </span>
              <button
                type="button"
                className="demo-sound-toggle"
                aria-label={muted ? "Turn sound on" : "Mute sound"}
                aria-pressed={!muted}
                onClick={() => setMuted(!muted)}
              >
                {muted ? "Sound off" : "Sound on"}
              </button>
            </div>
          </div>
        </div>
        <div className="demo-moments">
          <p>
            {sample.media.kind === "youtube"
              ? "Hear the idea. Find the clip."
              : "Select a moment to preview its cut."}
          </p>
          {sample.moments.map((item, index) => (
            <button
              key={item.title}
              type="button"
              className="demo-moment"
              aria-pressed={selected === index}
              onClick={() => {
                setSelected(index);
                setRequest((value) => value + 1);
              }}
            >
              <span className="demo-moment-index" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span>
                <strong>{item.title}</strong>
                {item.quote && (
                  <span className="demo-quote">“{item.quote}”</span>
                )}
                <span className="demo-time">
                  {demoTime(item.start)} – {demoTime(item.end)} ·{" "}
                  {item.end - item.start}s
                </span>
              </span>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m9 5 10 7-10 7Z" />
              </svg>
            </button>
          ))}
          <p className="demo-status" role="status">
            {status === "error" ? (
              <>
                Preview unavailable.{" "}
                <a href={sourceUrl} target="_blank" rel="noreferrer">
                  Watch at the source ↗
                </a>
              </>
            ) : status === "playing" ? (
              `Playing: ${moment?.title ?? sample.title}`
            ) : status === "loading" ? (
              "Loading preview…"
            ) : status === "paused" ? (
              "Press play in the video to continue."
            ) : sample.media.kind === "youtube" ? (
              "Short excerpts from the episode. Captions are available in the player."
            ) : (
              "Your source stays intact. Each clip gets its own cut."
            )}
          </p>
        </div>
      </div>
      <p className="demo-credit">
        {sample.media.kind === "local" ? (
          <>
            Demo footage from <a href={sourceUrl}>Charge</a>, © Blender
            Foundation.{" "}
            <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>
            . Shortened for this sample.
          </>
        ) : (
          <>
            <a href={sourceUrl} target="_blank" rel="noreferrer">
              The Next Token · Episode 02 ↗
            </a>
            , sponsored by Cloudflare. Played from the official YouTube channel.
          </>
        )}{" "}
        Handpicked sample clips. Sound is off by default.
      </p>
    </section>
  );
}
