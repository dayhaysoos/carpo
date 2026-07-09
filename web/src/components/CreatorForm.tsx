import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { createClip } from "../api";
import { MAX_CLIP_LENGTH_SECONDS } from "../types";
import { extractYoutubeVideoId, isValidYoutubeUrl } from "../youtube";
import { usePlayerTrim } from "./YoutubePlayer";
import { TrimSlider } from "./TrimSlider";

interface CreatorFormProps {
  onClipCreated: (clipId: string) => void;
}

export function CreatorForm({ onClipCreated }: CreatorFormProps) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [urlTouched, setUrlTouched] = useState(false);

  const trimmedUrl = url.trim();
  const urlValid = trimmedUrl.length > 0 && isValidYoutubeUrl(trimmedUrl);
  const urlInvalid = urlTouched && trimmedUrl.length > 0 && !urlValid;
  const videoId = urlValid ? extractYoutubeVideoId(trimmedUrl) : null;

  const { containerId, ready, duration, trim } = usePlayerTrim(videoId);
  const clipDuration = trim.range.end - trim.range.start;
  const canCreate =
    urlValid &&
    ready &&
    title.trim().length > 0 &&
    clipDuration > 0 &&
    clipDuration <= MAX_CLIP_LENGTH_SECONDS;

  const mutation = useMutation({
    mutationFn: createClip,
    onSuccess: (clip) => {
      onClipCreated(clip.id);
      setUrl("");
      setTitle("");
      setUrlTouched(false);
    },
  });

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canCreate || !videoId) return;

    mutation.mutate({
      title: title.trim(),
      source: { type: "youtube", url: trimmedUrl },
      trimStart: trim.range.start,
      trimEnd: trim.range.end,
      filters: [],
    });
  };

  return (
    <form className="creator-form card" onSubmit={handleSubmit}>
      <div className="card-header">
        <h2>New clip</h2>
        <p>Paste a YouTube URL, mark the moment, and create.</p>
      </div>

      <label className="field">
        <span>YouTube URL</span>
        <input
          type="url"
          placeholder="https://www.youtube.com/watch?v=…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => setUrlTouched(true)}
          autoComplete="off"
          spellCheck={false}
        />
        {urlInvalid && (
          <span className="field-error">
            Enter a valid YouTube URL (youtube.com or youtu.be)
          </span>
        )}
        {urlValid && <span className="field-ok">Valid YouTube URL</span>}
      </label>

      {videoId && (
        <div className="player-section">
          <div className="player-frame">
            <div id={containerId} className="player-embed" />
            {!ready && <div className="player-loading">Loading player…</div>}
          </div>
          <TrimSlider duration={duration} ready={ready} trim={trim} />
        </div>
      )}

      <label className="field">
        <span>Title</span>
        <input
          type="text"
          placeholder="Name this clip"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
        />
      </label>

      {mutation.error && (
        <div className="form-error" role="alert">
          {mutation.error.message}
        </div>
      )}

      <button type="submit" className="btn-primary" disabled={!canCreate || mutation.isPending}>
        {mutation.isPending ? "Creating…" : "Create clip"}
      </button>
    </form>
  );
}
