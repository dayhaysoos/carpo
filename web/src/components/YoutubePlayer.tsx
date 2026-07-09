import { useYoutubePlayer } from "../hooks/useYoutubePlayer";
import { useTrimRange } from "../hooks/useTrimRange";
import { TrimSlider } from "./TrimSlider";

interface YoutubePlayerProps {
  videoId: string;
  onTrimChange?: (start: number, end: number) => void;
}

export function YoutubePlayer({ videoId, onTrimChange }: YoutubePlayerProps) {
  const { containerId, ready, duration, seekTo } = useYoutubePlayer(videoId);
  const trim = useTrimRange({ duration, onSeek: seekTo });

  if (onTrimChange) {
    onTrimChange(trim.range.start, trim.range.end);
  }

  return (
    <div className="player-section">
      <div className="player-frame">
        <div id={containerId} className="player-embed" />
        {!ready && <div className="player-loading">Loading player…</div>}
      </div>
      <TrimSlider duration={duration} ready={ready} trim={trim} />
    </div>
  );
}

export function usePlayerTrim(videoId: string | null) {
  const { containerId, ready, duration, seekTo } = useYoutubePlayer(videoId);
  const trim = useTrimRange({ duration, onSeek: seekTo });
  return { containerId, ready, duration, seekTo, trim };
}
