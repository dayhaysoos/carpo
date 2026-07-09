import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    YT?: {
      Player: new (
        elementId: string,
        options: {
          videoId: string;
          width?: string | number;
          height?: string | number;
          playerVars?: Record<string, string | number>;
          events?: {
            onReady?: (event: { target: YTPlayer }) => void;
            onStateChange?: (event: { data: number; target: YTPlayer }) => void;
          };
        },
      ) => YTPlayer;
      PlayerState: {
        PLAYING: number;
        PAUSED: number;
        ENDED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

export interface YTPlayer {
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  pauseVideo(): void;
  playVideo(): void;
  destroy(): void;
}

let apiLoadPromise: Promise<void> | null = null;

function loadYoutubeApi(): Promise<void> {
  if (window.YT?.Player) {
    return Promise.resolve();
  }

  if (!apiLoadPromise) {
    apiLoadPromise = new Promise((resolve) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        resolve();
      };

      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        script.async = true;
        document.head.appendChild(script);
      }
    });
  }

  return apiLoadPromise;
}

export function useYoutubePlayer(videoId: string | null) {
  const containerIdRef = useRef(`yt-player-${Math.random().toString(36).slice(2)}`);
  const playerRef = useRef<YTPlayer | null>(null);
  const [ready, setReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    if (!videoId) {
      setReady(false);
      setDuration(0);
      setCurrentTime(0);
      playerRef.current?.destroy();
      playerRef.current = null;
      return;
    }

    let cancelled = false;
    let rafId = 0;

    const tick = () => {
      const player = playerRef.current;
      if (player) {
        setCurrentTime(player.getCurrentTime());
      }
      rafId = requestAnimationFrame(tick);
    };

    void loadYoutubeApi().then(() => {
      if (cancelled || !window.YT) return;

      playerRef.current?.destroy();
      playerRef.current = new window.YT.Player(containerIdRef.current, {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: {
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
        },
        events: {
          onReady: (event) => {
            if (cancelled) return;
            const d = event.target.getDuration();
            setDuration(Number.isFinite(d) ? d : 0);
            setReady(true);
            rafId = requestAnimationFrame(tick);
          },
        },
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      playerRef.current?.destroy();
      playerRef.current = null;
      setReady(false);
    };
  }, [videoId]);

  const seekTo = (seconds: number) => {
    playerRef.current?.seekTo(seconds, true);
    setCurrentTime(seconds);
  };

  return {
    containerId: containerIdRef.current,
    ready,
    duration,
    currentTime,
    seekTo,
  };
}
