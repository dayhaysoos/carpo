import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { createClip, requestUploadUrl, uploadFileWithProgress } from "../api";
import { useNativeVideoPlayer } from "../hooks/useNativeVideoPlayer";
import { useTrimRange } from "../hooks/useTrimRange";
import { useYoutubePlayer } from "../hooks/useYoutubePlayer";
import { MAX_CAPTION_LENGTH, MAX_CLIP_LENGTH_SECONDS, type ClipQuality, DEFAULT_CLIP_QUALITY } from "../types";
import {
  contentTypeForFile,
  formatUploadProgress,
  validateUploadFile,
} from "../upload";
import { extractYoutubeVideoId, isValidYoutubeUrl } from "../youtube";
import { TrimSlider } from "./TrimSlider";

type SourceMode = "youtube" | "upload";

interface CreatorFormProps {
  onClipCreated: () => void;
}

const DEFAULT_MAX_UPLOAD_BYTES = 95 * 1024 * 1024;

export function CreatorForm({ onClipCreated }: CreatorFormProps) {
  const [searchParams] = useSearchParams();
  const [sourceMode, setSourceMode] = useState<SourceMode>("upload");
  const [clipCreatedNotice, setClipCreatedNotice] = useState(false);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [quality, setQuality] = useState<ClipQuality>(DEFAULT_CLIP_QUALITY);
  const [urlTouched, setUrlTouched] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadKey, setUploadKey] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [maxUploadBytes, setMaxUploadBytes] = useState(DEFAULT_MAX_UPLOAD_BYTES);

  const trimmedUrl = url.trim();
  const urlValid = trimmedUrl.length > 0 && isValidYoutubeUrl(trimmedUrl);
  const urlInvalid = urlTouched && trimmedUrl.length > 0 && !urlValid;
  const videoId = sourceMode === "youtube" && urlValid ? extractYoutubeVideoId(trimmedUrl) : null;

  const filePreviewUrl = useMemo(
    () => (selectedFile ? URL.createObjectURL(selectedFile) : null),
    [selectedFile],
  );

  useEffect(() => {
    return () => {
      if (filePreviewUrl) {
        URL.revokeObjectURL(filePreviewUrl);
      }
    };
  }, [filePreviewUrl]);

  const youtube = useYoutubePlayer(sourceMode === "youtube" ? videoId : null);

  const fileValidationError =
    sourceMode === "upload" && selectedFile
      ? validateUploadFile(selectedFile, maxUploadBytes)
      : null;

  const native = useNativeVideoPlayer(
    sourceMode === "upload" && selectedFile && !fileValidationError
      ? filePreviewUrl
      : null,
  );

  const ready =
    sourceMode === "youtube"
      ? youtube.ready
      : Boolean(selectedFile && !fileValidationError && native.ready);
  const duration = sourceMode === "youtube" ? youtube.duration : native.duration;
  const seekTo = sourceMode === "youtube" ? youtube.seekTo : native.seekTo;
  const trim = useTrimRange({ duration, onSeek: seekTo });

  const clipDuration = trim.range.end - trim.range.start;
  const canCreate =
    ready &&
    title.trim().length > 0 &&
    clipDuration > 0 &&
    clipDuration <= MAX_CLIP_LENGTH_SECONDS &&
    ((sourceMode === "youtube" && urlValid && videoId) ||
      (sourceMode === "upload" && uploadKey && !fileValidationError));

  const mutation = useMutation({
    mutationFn: createClip,
    onSuccess: () => {
      onClipCreated();
      setTitle("");
      setCaption("");
      setClipCreatedNotice(true);
    },
  });

  useEffect(() => {
    if (!clipCreatedNotice) {
      return;
    }
    const timeout = setTimeout(() => setClipCreatedNotice(false), 5000);
    return () => clearTimeout(timeout);
  }, [clipCreatedNotice]);

  const handleSourceModeChange = (mode: SourceMode) => {
    setSourceMode(mode);
    setUrlTouched(false);
    setUploadError(null);
    setUploadProgress(null);
    if (mode === "youtube") {
      setSelectedFile(null);
      setUploadKey(null);
    } else {
      setUrl("");
    }
  };

  useEffect(() => {
    if (searchParams.get("source") === "upload") {
      handleSourceModeChange("upload");
    }
  }, [searchParams]);

  const handleFileChange = async (file: File | null) => {
    setSelectedFile(file);
    setUploadKey(null);
    setUploadError(null);
    setUploadProgress(null);

    if (!file) {
      return;
    }

    const validationError = validateUploadFile(file, maxUploadBytes);
    if (validationError) {
      setUploadError(validationError);
      return;
    }

    const contentType = contentTypeForFile(file);
    if (!contentType) {
      setUploadError("Unsupported video file type");
      return;
    }

    try {
      setUploadProgress("Preparing upload…");
      const slot = await requestUploadUrl({
        contentType,
        sizeBytes: file.size,
        filename: file.name,
      });
      setMaxUploadBytes(slot.maxSizeBytes);

      const slotValidation = validateUploadFile(file, slot.maxSizeBytes);
      if (slotValidation) {
        setUploadError(slotValidation);
        setUploadProgress(null);
        return;
      }

      await uploadFileWithProgress(
        slot.uploadUrl,
        file,
        slot.contentType,
        (loaded, total) => {
          setUploadProgress(formatUploadProgress(loaded, total));
        },
      );

      setUploadKey(slot.key);
      setUploadProgress("Upload complete");
    } catch (error) {
      setUploadError(
        error instanceof Error ? error.message : "Upload failed",
      );
      setUploadProgress(null);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canCreate) return;

    if (sourceMode === "youtube" && videoId) {
      mutation.mutate({
        title: title.trim(),
        source: { type: "youtube", url: trimmedUrl },
        trimStart: trim.range.start,
        trimEnd: trim.range.end,
        filters:
          caption.trim().length > 0
            ? [{ type: "caption", text: caption.trim() }]
            : [],
        quality,
      });
      return;
    }

    if (sourceMode === "upload" && uploadKey) {
      mutation.mutate({
        title: title.trim(),
        source: { type: "upload", key: uploadKey },
        trimStart: trim.range.start,
        trimEnd: trim.range.end,
        filters:
          caption.trim().length > 0
            ? [{ type: "caption", text: caption.trim() }]
            : [],
        quality,
      });
    }
  };

  return (
    <form className="creator-form card" onSubmit={handleSubmit}>
      <div className="card-header">
        <h2>New clip</h2>
        <p>Paste a YouTube URL or upload a video, mark the moment, and create.</p>
      </div>

      <div className="source-picker" role="tablist" aria-label="Source type">
        <button
          type="button"
          role="tab"
          aria-selected={sourceMode === "youtube"}
          className={`source-tab ${sourceMode === "youtube" ? "active" : ""}`}
          onClick={() => handleSourceModeChange("youtube")}
        >
          YouTube URL
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={sourceMode === "upload"}
          className={`source-tab ${sourceMode === "upload" ? "active" : ""}`}
          onClick={() => handleSourceModeChange("upload")}
        >
          Upload file
        </button>
      </div>

      {sourceMode === "youtube" ? (
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
      ) : (
        <label className="field">
          <span>Video file</span>
          <input
            type="file"
            accept="video/mp4,video/webm,video/quicktime,video/x-matroska,.mp4,.webm,.mov,.mkv"
            onChange={(e) => void handleFileChange(e.target.files?.[0] ?? null)}
          />
          {selectedFile && !fileValidationError && !uploadError && (
            <span className="field-ok">
              {selectedFile.name} ({Math.round(selectedFile.size / 1024)} KB)
            </span>
          )}
          {fileValidationError && (
            <span className="field-error">{fileValidationError}</span>
          )}
          {uploadError && <span className="field-error">{uploadError}</span>}
          {uploadProgress && (
            <span className="field-hint">{uploadProgress}</span>
          )}
        </label>
      )}

      {sourceMode === "youtube" && videoId && (
        <div className="player-section">
          <div className="player-frame">
            <div id={youtube.containerId} className="player-embed" />
            {!youtube.ready && <div className="player-loading">Loading player…</div>}
          </div>
          <TrimSlider duration={duration} ready={ready} trim={trim} />
          <div className="quality-picker" role="group" aria-label="Output quality">
            <span className="quality-label">Quality</span>
            <div className="quality-options">
              <button
                type="button"
                className={`quality-option ${quality === "1080p" ? "active" : ""}`}
                aria-pressed={quality === "1080p"}
                onClick={() => setQuality("1080p")}
              >
                1080p
              </button>
              <button
                type="button"
                className={`quality-option ${quality === "720p" ? "active" : ""}`}
                aria-pressed={quality === "720p"}
                onClick={() => setQuality("720p")}
              >
                720p
              </button>
            </div>
          </div>
        </div>
      )}

      {sourceMode === "upload" && selectedFile && !fileValidationError && (
        <div className="player-section">
          <div className="player-frame">
            <video
              ref={native.videoRef}
              className="native-player"
              controls
              playsInline
              preload="metadata"
            />
            {!ready && (
              <div className="player-loading">Loading preview…</div>
            )}
          </div>
          <TrimSlider duration={duration} ready={ready} trim={trim} />
          <div className="quality-picker" role="group" aria-label="Output quality">
            <span className="quality-label">Quality</span>
            <div className="quality-options">
              <button
                type="button"
                className={`quality-option ${quality === "1080p" ? "active" : ""}`}
                aria-pressed={quality === "1080p"}
                onClick={() => setQuality("1080p")}
              >
                1080p
              </button>
              <button
                type="button"
                className={`quality-option ${quality === "720p" ? "active" : ""}`}
                aria-pressed={quality === "720p"}
                onClick={() => setQuality("720p")}
              >
                720p
              </button>
            </div>
          </div>
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

      <label className="field">
        <span>Caption (optional)</span>
        <input
          type="text"
          placeholder="Burn text into the clip"
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          maxLength={MAX_CAPTION_LENGTH}
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

      {clipCreatedNotice && (
        <p className="form-success" role="status">
          Clip created — check the status panel
        </p>
      )}
    </form>
  );
}
