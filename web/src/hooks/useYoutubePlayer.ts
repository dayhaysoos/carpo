import { useCallback, useEffect, useRef, useState } from "react";

import { loadYoutubeApi, type YTPlayer } from "../youtube-api";

export function useYoutubePlayer(videoId: string | null) {
  const containerIdRef = useRef(
    `yt-player-${Math.random().toString(36).slice(2)}`,
  );
  const playerRef = useRef<YTPlayer | null>(null);
  const [ready, setReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (!videoId) {
      setReady(false);
      setDuration(0);
      setCurrentTime(0);
      setTitle("");
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
            const videoData = event.target.getVideoData();
            setDuration(Number.isFinite(d) ? d : 0);
            setTitle(videoData.title?.trim() ?? "");
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

  const seekTo = useCallback((seconds: number) => {
    playerRef.current?.seekTo(seconds, true);
    setCurrentTime(seconds);
  }, []);

  const pauseVideo = useCallback(() => {
    playerRef.current?.pauseVideo();
  }, []);

  return {
    containerId: containerIdRef.current,
    ready,
    duration,
    currentTime,
    title,
    seekTo,
    pauseVideo,
  };
}
