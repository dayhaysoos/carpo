import {
  getClipById,
  getClipByIdForOwner,
  queueArtifactDeletion,
} from "./db";
import type { Env } from "./env";
import type { TranscriptCue } from "./encoder-pool";
import { requestVideoTranscript } from "./transcript-search";
import { readCachedTranscript } from "./transcript-store";
import type { ClipRecord } from "./types";

export const MAX_CAPTION_CUES = 200;
export const MAX_CAPTION_CUE_TEXT_LENGTH = 500;

export const CAPTION_THEME_IDS = [
  "classic",
  "high-contrast-box",
  "bold-yellow",
] as const;

export type CaptionThemeId = (typeof CAPTION_THEME_IDS)[number];
export type CaptionProposalSource = "think" | "webmcp";
export type CaptionRenderStatus = "none" | "encoding" | "complete" | "failed";

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
  theme: CaptionThemeId;
  lastProposalSource: CaptionProposalSource | null;
  renderStatus: CaptionRenderStatus;
  renderErrorMessage: string | null;
  outputCaptionedMp4: string | null;
  revision: string | null;
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

export type CaptionTrackExportFormat = "vtt" | "srt";

export interface CaptionTrackProposal {
  source: CaptionProposalSource;
  baseRevision: string | null;
  cues: CaptionCue[];
  theme: CaptionThemeId;
}

export interface CaptionRenderJob {
  renderId: string;
  clipId: string;
  sourceMp4Key: string;
  outputCaptionedMp4Key: string;
  cues: CaptionCue[];
  theme: CaptionThemeId;
}

export type BeginCaptionRenderResult =
  | { started: false; track: CaptionTrackAvailable }
  | { started: true; track: CaptionTrackAvailable; job: CaptionRenderJob };

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
  theme: string;
  last_proposal_source: string | null;
  render_status: string;
  render_error_message: string | null;
  output_captioned_mp4_key: string | null;
  revision: string;
  updated_at: string;
}

function captionTheme(value: unknown): CaptionThemeId | null {
  return typeof value === "string" &&
    CAPTION_THEME_IDS.includes(value as CaptionThemeId)
    ? (value as CaptionThemeId)
    : null;
}

function proposalSource(value: unknown): CaptionProposalSource | null {
  return value === "think" || value === "webmcp" ? value : null;
}

function renderStatus(value: unknown): CaptionRenderStatus {
  return value === "encoding" || value === "complete" || value === "failed"
    ? value
    : "none";
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

function subRipTimestamp(seconds: number): string {
  return webVttTimestamp(seconds).replace(".", ",");
}

function serializeCaptionTrackAsSubRip(cues: CaptionCue[]): string {
  const body = cues
    .map(
      (cue, index) =>
        `${index + 1}\n${subRipTimestamp(cue.startSeconds)} --> ${subRipTimestamp(cue.endSeconds)}\n${cue.text}`,
    )
    .join("\n\n");
  return body ? `${body}\n` : "";
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
    `SELECT cues_json, source_language, source_automatic, theme,
            last_proposal_source, render_status, render_error_message,
            output_captioned_mp4_key, revision, updated_at
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
    theme: captionTheme(record.theme) ?? "classic",
    lastProposalSource: proposalSource(record.last_proposal_source),
    renderStatus: renderStatus(record.render_status),
    renderErrorMessage: record.render_error_message,
    outputCaptionedMp4: record.output_captioned_mp4_key
      ? `/artifacts/${record.output_captioned_mp4_key}`
      : null,
    revision: record.revision || record.updated_at,
    updatedAt: record.updated_at,
  };
}

export async function viewCaptionTrack(
  env: Env,
  ownerId: string,
  clipId: string,
): Promise<CaptionTrackView> {
  const clip = await editableClip(env, ownerId, clipId);
  return viewCaptionTrackForClip(env, clip);
}

export async function viewCaptionTrackForVideo(
  env: Env,
  videoId: string,
  clipId: string,
): Promise<CaptionTrackView> {
  const clip = await getClipById(env.DB, clipId);
  if (!clip || clip.video_id !== videoId) {
    throw new CaptionTrackError("not_found", "Clip not found");
  }
  if (clip.status !== "complete") {
    throw new CaptionTrackError(
      "not_complete",
      "Captions are only available for completed clips",
    );
  }
  return viewCaptionTrackForClip(env, clip);
}

async function viewCaptionTrackForClip(
  env: Env,
  clip: ClipRecord,
): Promise<CaptionTrackView> {
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
    theme: "classic",
    lastProposalSource: null,
    renderStatus: "none",
    renderErrorMessage: null,
    outputCaptionedMp4: null,
    revision: null,
    updatedAt: null,
  };
}

export async function saveCaptionTrack(
  env: Env,
  ownerId: string,
  clipId: string,
  cueInput: unknown,
  options: {
    theme?: unknown;
    proposalSource?: unknown;
  } = {},
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
  const previousCaptionedKey = existing?.outputCaptionedMp4?.startsWith(
    "/artifacts/",
  )
    ? existing.outputCaptionedMp4.slice("/artifacts/".length)
    : null;
  const transcript = existing
    ? null
    : await readCachedTranscript(env, clip.video_id!);
  const sourceLanguage = existing?.sourceLanguage ?? transcript?.language ?? null;
  const sourceAutomatic =
    existing?.sourceAutomatic ?? transcript?.automatic ?? null;
  const theme =
    options.theme === undefined
      ? existing?.theme ?? "classic"
      : captionTheme(options.theme);
  if (!theme) {
    throw new CaptionTrackError("validation", "Validation failed", [
      { field: "theme", message: "Choose a supported caption theme" },
    ]);
  }
  const savedProposalSource =
    options.proposalSource === undefined
      ? null
      : proposalSource(options.proposalSource);
  if (options.proposalSource !== undefined && !savedProposalSource) {
    throw new CaptionTrackError("validation", "Validation failed", [
      { field: "proposalSource", message: "Proposal source is not supported" },
    ]);
  }
  const revision = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO caption_tracks (
      clip_id, cues_json, source_language, source_automatic, theme,
      last_proposal_source, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (clip_id) DO UPDATE SET
      cues_json = excluded.cues_json,
      theme = excluded.theme,
      last_proposal_source = excluded.last_proposal_source,
      revision = excluded.revision,
      render_status = 'none',
      render_error_message = NULL,
      render_id = NULL,
      render_source_revision = NULL,
      output_captioned_mp4_key = NULL,
      updated_at = datetime('now')`,
  )
    .bind(
      clip.id,
      JSON.stringify(validation.value),
      sourceLanguage,
      sourceAutomatic === null ? null : Number(sourceAutomatic),
      theme,
      savedProposalSource,
      revision,
    )
    .run();

  if (previousCaptionedKey) {
    await queueArtifactDeletion(env.DB, previousCaptionedKey);
  }

  const saved = await readStoredCaptionTrack(env, clip);
  if (!saved) {
    throw new CaptionTrackError("internal", "Caption track was not saved");
  }
  return saved;
}

function captionFilename(title: string, format: CaptionTrackExportFormat): string {
  const stem = title
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${stem || "clip"}-captions.${format}`;
}

export async function exportCaptionTrack(
  env: Env,
  ownerId: string,
  clipId: string,
  format: CaptionTrackExportFormat = "vtt",
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
    filename: captionFilename(clip.title, format),
    body:
      format === "srt"
        ? serializeCaptionTrackAsSubRip(track.cues)
        : serializeCaptionTrackAsWebVtt(track.cues),
  };
}

export async function validateCaptionTrackProposal(
  env: Env,
  ownerId: string,
  clipId: string,
  input: {
    source: unknown;
    baseRevision: unknown;
    cues: unknown;
    theme: unknown;
  },
): Promise<CaptionTrackProposal> {
  const clip = await editableClip(env, ownerId, clipId);
  const current = await readStoredCaptionTrack(env, clip);
  const expectedRevision =
    input.baseRevision === null || typeof input.baseRevision === "string"
      ? input.baseRevision
      : undefined;
  if (expectedRevision === undefined) {
    throw new CaptionTrackError("validation", "Validation failed", [
      { field: "baseRevision", message: "Caption revision is required" },
    ]);
  }
  if ((current?.revision ?? null) !== expectedRevision) {
    throw new CaptionTrackError(
      "validation",
      "The caption track changed. Refresh it before applying this suggestion.",
      [{ field: "baseRevision", message: "Caption revision is stale" }],
    );
  }
  const source = proposalSource(input.source);
  const theme = captionTheme(input.theme);
  const validation = validateCaptionCueInput(input.cues, clipDuration(clip));
  const errors: CaptionTrackValidationError[] = [];
  if (!source) {
    errors.push({ field: "source", message: "Proposal source is not supported" });
  }
  if (!theme) {
    errors.push({ field: "theme", message: "Choose a supported caption theme" });
  }
  if (!validation.ok) errors.push(...validation.errors);
  if (!source || !theme || !validation.ok) {
    throw new CaptionTrackError("validation", "Validation failed", errors);
  }
  return {
    source,
    baseRevision: expectedRevision,
    cues: validation.value,
    theme,
  };
}

export async function beginCaptionRender(
  env: Env,
  ownerId: string,
  clipId: string,
): Promise<BeginCaptionRenderResult> {
  const clip = await editableClip(env, ownerId, clipId);
  const track = await readStoredCaptionTrack(env, clip);
  if (!track) {
    throw new CaptionTrackError(
      "not_saved",
      "Save the caption track before rendering it",
    );
  }
  if (track.renderStatus === "encoding" || track.renderStatus === "complete") {
    return { started: false, track };
  }
  if (!clip.output_mp4_key) {
    throw new CaptionTrackError("internal", "Clip MP4 output is missing");
  }

  const renderId = crypto.randomUUID();
  const outputCaptionedMp4Key = `clips/${clip.id}/captioned-${renderId}.mp4`;
  const result = await env.DB.prepare(
    `UPDATE caption_tracks
     SET render_status = 'encoding', render_error_message = NULL,
         render_id = ?, render_source_revision = revision,
         output_captioned_mp4_key = NULL
     WHERE clip_id = ? AND render_status IN ('none', 'failed')`,
  )
    .bind(renderId, clip.id)
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    return { started: false, track: (await readStoredCaptionTrack(env, clip))! };
  }
  return {
    started: true,
    track: (await readStoredCaptionTrack(env, clip))!,
    job: {
      renderId,
      clipId: clip.id,
      sourceMp4Key: clip.output_mp4_key,
      outputCaptionedMp4Key,
      cues: track.cues,
      theme: track.theme,
    },
  };
}

export async function completeCaptionRender(
  env: Env,
  clipId: string,
  renderId: string,
  outputCaptionedMp4Key: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE caption_tracks
     SET render_status = 'complete', render_error_message = NULL,
         output_captioned_mp4_key = ?
     WHERE clip_id = ? AND render_status = 'encoding' AND render_id = ?
       AND render_source_revision = revision`,
  )
    .bind(outputCaptionedMp4Key, clipId, renderId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function failCaptionRender(
  env: Env,
  clipId: string,
  renderId: string,
  errorMessage: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE caption_tracks
     SET render_status = 'failed', render_error_message = ?,
         output_captioned_mp4_key = NULL
     WHERE clip_id = ? AND render_status = 'encoding' AND render_id = ?`,
  )
    .bind(errorMessage, clipId, renderId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function ownsCaptionedArtifact(
  env: Env,
  ownerId: string,
  key: string,
): Promise<boolean> {
  const match = await env.DB.prepare(
    `SELECT 1 AS present
     FROM caption_tracks
     INNER JOIN clips ON clips.id = caption_tracks.clip_id
     WHERE clips.owner_id = ? AND caption_tracks.output_captioned_mp4_key = ?`,
  )
    .bind(ownerId, key)
    .first<{ present: number }>();
  return Boolean(match);
}
