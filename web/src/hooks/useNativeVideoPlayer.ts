import { useEffect, useRef, useState } from "react";

export function useNativeVideoPlayer(sourceUrl: string | null) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [ready, setReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !sourceUrl) {
      setReady(false);
      setDuration(0);
      setCurrentTime(0);
      setError(false);
      return;
    }

    let cancelled = false;

    const handleLoadedMetadata = () => {
      if (cancelled) return;
      const nextDuration = Number.isFinite(video.duration) ? video.duration : 0;
      setDuration(nextDuration);
      setReady(nextDuration > 0);
    };

    const handleTimeUpdate = () => {
      if (!cancelled) {
        setCurrentTime(video.currentTime);
      }
    };

    const handleError = () => {
      if (!cancelled) {
        setReady(false);
        setError(true);
      }
    };

    setReady(false);
    setDuration(0);
    setCurrentTime(0);
    setError(false);
    video.src = sourceUrl;
    video.load();

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("error", handleError);

    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("error", handleError);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [sourceUrl]);

  const seekTo = (seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = seconds;
    setCurrentTime(seconds);
  };

  return {
    videoRef,
    ready,
    duration,
    currentTime,
    error,
    seekTo,
  };
}
