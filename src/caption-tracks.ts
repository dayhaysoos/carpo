import { getClipByIdForOwner } from "./db";
import type { Env } from "./env";
import type { TranscriptCue } from "./encoder-pool";
import { requestVideoTranscript } from "./transcript-search";
import { readCachedTranscript } from "./transcript-store";
import type { ClipRecord } from "./types";

export const MAX_CAPTION_CUES = 200;
export const MAX_CAPTION_CUE_TEXT_LENGTH = 500;

export interface CaptionCue {
  id: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface CaptionTrackAvailable {
  captionStatus: "available";
  clipId: string;
  clipDurationSeconds: number;
  saved: boolean;
  sourceLanguage: string | null;
  sourceAutomatic: boolean | null;
  cues: CaptionCue[];
  updatedAt: string | null;
}

export interface CaptionTrackChecking {
  captionStatus: "checking";
  retryAfterMs: number;
}

export type CaptionTrackView = CaptionTrackAvailable | CaptionTrackChecking;

export interface CaptionTrackExport {
  filename: string;
  body: string;
}

export interface CaptionTrackValidationError {
  field: string;
  message: string;
}

export type CaptionTrackValidation =
  | { ok: true; value: CaptionCue[] }
  | { ok: false; errors: CaptionTrackValidationError[] };

export type CaptionTrackErrorKind =
  | "not_found"
  | "not_complete"
  | "not_saved"
  | "validation"
  | "transcript"
  | "internal";

export class CaptionTrackError extends Error {
  constructor(
    readonly kind: CaptionTrackErrorKind,
    message: string,
    readonly details: CaptionTrackValidationError[] = [],
  ) {
    super(message);
  }
}

interface CaptionTrackRecord {
  cues_json: string;
  source_language: string | null;
  source_automatic: number | null;
  updated_at: string;
}

function roundedSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function deriveCaptionCues(
  sourceCues: TranscriptCue[],
  clipRange: { startSeconds: number; endSeconds: number },
): CaptionCue[] {
  return sourceCues.flatMap((cue, index) => {
    const start = Math.max(cue.startSeconds, clipRange.startSeconds);
    const end = Math.min(cue.endSeconds, clipRange.endSeconds);
    if (end <= start) return [];
    return [
      {
        id: `cue-${index + 1}`,
        startSeconds: roundedSeconds(start - clipRange.startSeconds),
        endSeconds: roundedSeconds(end - clipRange.startSeconds),
        text: cue.text.trim(),
      },
    ];
  });
}

function validateCaptionCueInput(
  value: unknown,
  clipDurationSeconds: number,
): CaptionTrackValidation {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      errors: [{ field: "cues", message: "Cues must be an array" }],
    };
  }
  if (value.length > MAX_CAPTION_CUES) {
    return {
      ok: false,
      errors: [
        {
          field: "cues",
          message: `A caption track can contain at most ${MAX_CAPTION_CUES} cues`,
        },
      ],
    };
  }

  const errors: CaptionTrackValidationError[] = [];
  const cues: CaptionCue[] = [];
  const ids = new Set<string>();
  let previousEnd = 0;

  value.forEach((candidate, index) => {
    const field = `cues[${index}]`;
    if (!candidate || typeof candidate !== "object") {
      errors.push({ field, message: "Cue must be an object" });
      return;
    }
    const cue = candidate as Record<string, unknown>;
    const id = typeof cue.id === "string" ? cue.id.trim() : "";
    const startSeconds = cue.startSeconds;
    const endSeconds = cue.endSeconds;
    const text =
      typeof cue.text === "string"
        ? cue.text.replace(/\r\n?/g, "\n").trim()
        : "";

    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      errors.push({
        field: `${field}.id`,
        message: "Cue id must contain only letters, numbers, hyphens, or underscores",
      });
    } else if (ids.has(id)) {
      errors.push({ field: `${field}.id`, message: "Cue id must be unique" });
    }
    ids.add(id);

    if (
      typeof startSeconds !== "number" ||
      !Number.isFinite(startSeconds) ||
      startSeconds < 0
    ) {
      errors.push({
        field: `${field}.startSeconds`,
        message: "Start time must be zero or greater",
      });
    } else if (index > 0 && startSeconds < previousEnd) {
      errors.push({
        field: `${field}.startSeconds`,
        message: "Cue cannot overlap the previous cue",
      });
    }

    if (
      typeof endSeconds !== "number" ||
      !Number.isFinite(endSeconds) ||
      typeof startSeconds !== "number" ||
      endSeconds <= startSeconds
    ) {
      errors.push({
        field: `${field}.endSeconds`,
        message: "End time must be after the start time",
      });
    } else if (endSeconds > clipDurationSeconds) {
      errors.push({
        field: `${field}.endSeconds`,
        message: "End time must be inside the clip",
      });
    }

    if (!text) {
      errors.push({ field: `${field}.text`, message: "Caption text is required" });
    } else if (text.length > MAX_CAPTION_CUE_TEXT_LENGTH) {
      errors.push({
        field: `${field}.text`,
        message: `Caption text must be ${MAX_CAPTION_CUE_TEXT_LENGTH} characters or fewer`,
      });
    }

    if (
      id &&
      typeof startSeconds === "number" &&
      Number.isFinite(startSeconds) &&
      typeof endSeconds === "number" &&
      Number.isFinite(endSeconds) &&
      text
    ) {
      cues.push({
        id,
        startSeconds: roundedSeconds(startSeconds),
        endSeconds: roundedSeconds(endSeconds),
        text,
      });
    }
    if (typeof endSeconds === "number" && Number.isFinite(endSeconds)) {
      previousEnd = endSeconds;
    }
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: cues };
}

function webVttTimestamp(seconds: number): string {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return [hours, minutes, wholeSeconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":") + `.${String(remainder).padStart(3, "0")}`;
}

function serializeCaptionTrackAsWebVtt(cues: CaptionCue[]): string {
  const body = cues
    .map(
      (cue) =>
        `${cue.id}\n${webVttTimestamp(cue.startSeconds)} --> ${webVttTimestamp(cue.endSeconds)}\n${cue.text}`,
    )
    .join("\n\n");
  return `WEBVTT\n${body ? `\n${body}\n` : ""}`;
}

function clipDuration(record: ClipRecord): number {
  return roundedSeconds(record.trim_end - record.trim_start);
}

async function editableClip(
  env: Env,
  ownerId: string,
  clipId: string,
): Promise<ClipRecord> {
  const clip = await getClipByIdForOwner(env.DB, clipId, ownerId);
  if (!clip) throw new CaptionTrackError("not_found", "Clip not found");
  if (clip.status !== "complete") {
    throw new CaptionTrackError(
      "not_complete",
      "Captions are only available for completed clips",
    );
  }
  if (!clip.video_id) {
    throw new CaptionTrackError("internal", "Clip has no source video");
  }
  return clip;
}

async function readStoredCaptionTrack(
  env: Env,
  clip: ClipRecord,
): Promise<CaptionTrackAvailable | null> {
  const record = await env.DB.prepare(
    `SELECT cues_json, source_language, source_automatic, updated_at
     FROM caption_tracks WHERE clip_id = ?`,
  )
    .bind(clip.id)
    .first<CaptionTrackRecord>();
  if (!record) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(record.cues_json);
  } catch {
    throw new CaptionTrackError("internal", "Saved caption track is invalid");
  }
  const validation = validateCaptionCueInput(parsed, clipDuration(clip));
  if (!validation.ok) {
    throw new CaptionTrackError("internal", "Saved caption track is invalid");
  }
  return {
    captionStatus: "available",
    clipId: clip.id,
    clipDurationSeconds: clipDuration(clip),
    saved: true,
    sourceLanguage: record.source_language,
    sourceAutomatic:
      record.source_automatic === null
        ? null
        : Boolean(record.source_automatic),
    cues: validation.value,
    updatedAt: record.updated_at,
  };
}

export async function viewCaptionTrack(
  env: Env,
  ownerId: string,
  clipId: string,
): Promise<CaptionTrackView> {
  const clip = await editableClip(env, ownerId, clipId);
  const stored = await readStoredCaptionTrack(env, clip);
  if (stored) return stored;

  let transcript = await readCachedTranscript(env, clip.video_id!);
  if (!transcript) {
    let preparation;
    try {
      preparation = await requestVideoTranscript(env, clip.video_id!);
    } catch (error) {
      throw new CaptionTrackError(
        "transcript",
        error instanceof Error ? error.message : "Transcript preparation failed",
      );
    }
    if (preparation.transcriptStatus === "checking") {
      return {
        captionStatus: "checking",
        retryAfterMs: preparation.retryAfterMs,
      };
    }
    transcript = await readCachedTranscript(env, clip.video_id!);
  }
  if (!transcript) {
    throw new CaptionTrackError("transcript", "Transcript is unavailable");
  }

  return {
    captionStatus: "available",
    clipId: clip.id,
    clipDurationSeconds: clipDuration(clip),
    saved: false,
    sourceLanguage: transcript.language,
    sourceAutomatic: transcript.automatic,
    cues: deriveCaptionCues(transcript.cues, {
      startSeconds: clip.trim_start,
      endSeconds: clip.trim_end,
    }),
    updatedAt: null,
  };
}

export async function saveCaptionTrack(
  env: Env,
  ownerId: string,
  clipId: string,
  cueInput: unknown,
): Promise<CaptionTrackAvailable> {
  const clip = await editableClip(env, ownerId, clipId);
  const validation = validateCaptionCueInput(cueInput, clipDuration(clip));
  if (!validation.ok) {
    throw new CaptionTrackError(
      "validation",
      "Validation failed",
      validation.errors,
    );
  }

  const existing = await readStoredCaptionTrack(env, clip);
  const transcript = existing
    ? null
    : await readCachedTranscript(env, clip.video_id!);
  const sourceLanguage = existing?.sourceLanguage ?? transcript?.language ?? null;
  const sourceAutomatic =
    existing?.sourceAutomatic ?? transcript?.automatic ?? null;

  await env.DB.prepare(
    `INSERT INTO caption_tracks (
      clip_id, cues_json, source_language, source_automatic
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT (clip_id) DO UPDATE SET
      cues_json = excluded.cues_json,
      updated_at = datetime('now')`,
  )
    .bind(
      clip.id,
      JSON.stringify(validation.value),
      sourceLanguage,
      sourceAutomatic === null ? null : Number(sourceAutomatic),
    )
    .run();

  const saved = await readStoredCaptionTrack(env, clip);
  if (!saved) {
    throw new CaptionTrackError("internal", "Caption track was not saved");
  }
  return saved;
}

function captionFilename(title: string): string {
  const stem = title
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${stem || "clip"}-captions.vtt`;
}

export async function exportCaptionTrack(
  env: Env,
  ownerId: string,
  clipId: string,
): Promise<CaptionTrackExport> {
  const clip = await editableClip(env, ownerId, clipId);
  const track = await readStoredCaptionTrack(env, clip);
  if (!track) {
    throw new CaptionTrackError(
      "not_saved",
      "Save the caption track before exporting it",
    );
  }
  return {
    filename: captionFilename(clip.title),
    body: serializeCaptionTrackAsWebVtt(track.cues),
  };
}
