declare global {
  interface Window {
    YT?: {
      Player: new (
        elementId: string,
        options: {
          videoId: string;
          host?: string;
          width?: string | number;
          height?: string | number;
          playerVars?: Record<string, string | number>;
          events?: {
            onReady?: (event: { target: YTPlayer }) => void;
            onStateChange?: (event: { data: number; target: YTPlayer }) => void;
            onError?: (event: { data: number; target: YTPlayer }) => void;
            onAutoplayBlocked?: () => void;
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
  cueVideoById(clip: {
    videoId: string;
    startSeconds: number;
    endSeconds: number;
  }): void;
  loadVideoById(clip: {
    videoId: string;
    startSeconds: number;
    endSeconds: number;
  }): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  getVolume(): number;
  setVolume(volume: number): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getVideoData(): { title?: string };
  pauseVideo(): void;
  playVideo(): void;
  destroy(): void;
}

let apiLoadPromise: Promise<void> | null = null;

export function loadYoutubeApi(): Promise<void> {
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
