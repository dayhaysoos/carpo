import type { Env } from "./env";
import {
  buildTranscriptBlocks,
  buildTranscriptClipRange,
  findTranscriptMatches,
  type TranscriptBlock,
} from "./transcript-search";
import { readCachedTranscript, type StoredTranscript } from "./transcript-store";

export const MAX_LIBRARY_SEARCH_QUERY_LENGTH = 200;
export const MAX_LIBRARY_SEARCH_RESULTS = 20;
export const LIBRARY_EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5" as const;

const EXACT_SEARCH_BEFORE_SECONDS = 1;
const EXACT_SEARCH_AFTER_SECONDS = 2;
const VECTOR_QUERY_CANDIDATE_LIMIT = 100;

export type LibrarySearchMode = "exact" | "meaning";

interface SearchableVideo {
  id: string;
  owner_id: string;
  source_type: "youtube" | "upload";
  source_ref: string;
  title: string;
  duration_seconds: number | null;
  transcript_status: string;
  archived_at: string | null;
  updated_at: string;
}

interface TranscriptIndexState {
  video_id: string;
  transcript_revision: string;
  video_revision: string;
  semantic_revision: string | null;
  semantic_error: string | null;
}

interface IndexedBlockRow {
  block_id: string;
  start_seconds: number;
  end_seconds: number;
  text: string;
  vector_id: string;
}

interface ReauthorizedBlockRow extends IndexedBlockRow {
  video_id: string;
  transcript_revision: string;
  video_revision: string;
  title: string;
  source_type: "youtube" | "upload";
  duration_seconds: number | null;
  archived_at: string | null;
}

interface PreparedReviewRow {
  id: string;
  owner_id: string;
  video_id: string;
  search_result_id: string;
  search_mode: LibrarySearchMode;
  query: string;
  transcript_revision: string;
  video_revision: string;
  block_ids_json: string;
  title: string;
  rationale: string;
  start_seconds: number;
  end_seconds: number;
  expires_at: string;
}

export interface LibrarySearchResult {
  resultId: string;
  mode: LibrarySearchMode;
  query: string;
  video: {
    id: string;
    title: string;
    sourceType: "youtube" | "upload";
    archived: boolean;
  };
  evidence: {
    blockIds: string[];
    text: string;
    startSeconds: number;
    endSeconds: number;
  };
  proposedRange: {
    startSeconds: number;
    endSeconds: number;
  };
  revisions: {
    transcriptRevision: string;
    videoRevision: string;
  };
  similarityScore?: number;
}

export interface LibrarySearchResponse {
  query: string;
  mode: LibrarySearchMode;
  results: LibrarySearchResult[];
  coverage: {
    totalVideos: number;
    searchableVideos: number;
    unavailableVideos: number;
  };
  meaningStatus?: "available" | "unavailable";
  meaningMessage?: string;
}

export interface PrepareLibraryMomentInput {
  resultId: string;
  mode: LibrarySearchMode;
  query: string;
  videoId: string;
  transcriptRevision: string;
  videoRevision: string;
  blockIds: string[];
  evidenceStartSeconds: number;
  evidenceEndSeconds: number;
}

export interface PreparedLibraryMomentReview {
  proposalId: string;
  searchResultId: string;
  videoId: string;
  reviewUrl: string;
  input: {
    title: string;
    startSeconds: number;
    endSeconds: number;
    quality: "1080p";
  };
  evidence: {
    rationale: string;
    sourceBlockIds: string[];
    workspaceRevision: string;
  };
}

export class LibraryDiscoveryError extends Error {
  constructor(
    readonly code:
      | "INVALID_RESULT"
      | "RESULT_EXPIRED"
      | "RESULT_NOT_FOUND"
      | "STALE_RESULT",
    message: string,
  ) {
    super(message);
    this.name = "LibraryDiscoveryError";
  }
}

function normalizedTokens(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function transcriptRevision(transcript: StoredTranscript): Promise<string> {
  return `transcript-${await sha256(JSON.stringify(transcript))}`;
}

async function videoRevision(video: SearchableVideo): Promise<string> {
  return `video-${await sha256(
    JSON.stringify({
      id: video.id,
      ownerId: video.owner_id,
      sourceType: video.source_type,
      sourceRef: video.source_ref,
      title: video.title,
      durationSeconds: video.duration_seconds,
      archivedAt: video.archived_at,
      updatedAt: video.updated_at,
    }),
  )}`;
}

async function vectorId(
  videoId: string,
  revision: string,
  blockId: string,
): Promise<string> {
  return sha256(`${videoId}\u0000${revision}\u0000${blockId}`);
}

async function searchResultId(input: {
  ownerId: string;
  mode: LibrarySearchMode;
  query: string;
  videoId: string;
  transcriptRevision: string;
  videoRevision: string;
  blockIds: string[];
  evidenceStartSeconds: number;
  evidenceEndSeconds: number;
}): Promise<string> {
  return `library-result-${await sha256(JSON.stringify(input))}`;
}

function ftsQuery(query: string): string {
  return normalizedTokens(query)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" OR ");
}

function compactTitle(query: string, videoTitle: string): string {
  const subject = query.trim().replace(/\s+/g, " ");
  const title = subject.length > 80 ? `${subject.slice(0, 77)}…` : subject;
  return `${title} — ${videoTitle}`.slice(0, 200);
}

function rationale(mode: LibrarySearchMode, query: string, evidence: string): string {
  const description =
    mode === "exact"
      ? `Exact transcript match for “${query}”.`
      : `Meaning-based transcript match for “${query}”.`;
  const excerpt = evidence.length > 220 ? `${evidence.slice(0, 217)}…` : evidence;
  return `${description} Evidence: “${excerpt}”`;
}

async function listSearchableVideos(
  db: D1Database,
  ownerId: string,
  archived: boolean,
): Promise<SearchableVideo[]> {
  const archiveClause = archived ? "archived_at IS NOT NULL" : "archived_at IS NULL";
  const result = await db
    .prepare(
      `SELECT id, owner_id, source_type, source_ref, title, duration_seconds,
              transcript_status, archived_at, updated_at
       FROM source_videos
       WHERE owner_id = ? AND ${archiveClause}
       ORDER BY updated_at DESC`,
    )
    .bind(ownerId)
    .all<SearchableVideo>();
  return result.results ?? [];
}

async function getSearchableVideo(
  db: D1Database,
  ownerId: string,
  videoId: string,
): Promise<SearchableVideo | null> {
  return db
    .prepare(
      `SELECT id, owner_id, source_type, source_ref, title, duration_seconds,
              transcript_status, archived_at, updated_at
       FROM source_videos
       WHERE owner_id = ? AND id = ?`,
    )
    .bind(ownerId, videoId)
    .first<SearchableVideo>();
}

async function getIndexState(
  db: D1Database,
  videoId: string,
): Promise<TranscriptIndexState | null> {
  return db
    .prepare(
      `SELECT video_id, transcript_revision, video_revision,
              semantic_revision, semantic_error
       FROM library_transcript_index_state
       WHERE video_id = ?`,
    )
    .bind(videoId)
    .first<TranscriptIndexState>();
}

async function runStatementChunks(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<void> {
  for (let index = 0; index < statements.length; index += 100) {
    await db.batch(statements.slice(index, index + 100));
  }
}

async function syncExactTranscript(
  env: Env,
  video: SearchableVideo,
  transcript: StoredTranscript,
): Promise<{ transcriptRevision: string; videoRevision: string }> {
  const [nextTranscriptRevision, nextVideoRevision] = await Promise.all([
    transcriptRevision(transcript),
    videoRevision(video),
  ]);
  const state = await getIndexState(env.DB, video.id);
  if (state?.transcript_revision === nextTranscriptRevision) {
    if (state.video_revision !== nextVideoRevision) {
      await env.DB
        .prepare(
          `UPDATE library_transcript_index_state
           SET video_revision = ?, indexed_at = datetime('now')
           WHERE video_id = ? AND owner_id = ?`,
        )
        .bind(nextVideoRevision, video.id, video.owner_id)
        .run();
    }
    return {
      transcriptRevision: nextTranscriptRevision,
      videoRevision: nextVideoRevision,
    };
  }

  const blocks = buildTranscriptBlocks(transcript);
  const indexedBlocks = await Promise.all(
    blocks.map(async (block) => ({
      ...block,
      vectorId: await vectorId(video.id, nextTranscriptRevision, block.id),
    })),
  );
  await runStatementChunks(
    env.DB,
    indexedBlocks.map((block) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO library_transcript_blocks (
           owner_id, video_id, transcript_revision, block_id,
           start_seconds, end_seconds, text, vector_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        video.owner_id,
        video.id,
        nextTranscriptRevision,
        block.id,
        block.startSeconds,
        block.endSeconds,
        block.text,
        block.vectorId,
      ),
    ),
  );
  const inserted = await env.DB
    .prepare(
      `SELECT COUNT(*) AS count
       FROM library_transcript_blocks
       WHERE video_id = ? AND transcript_revision = ?`,
    )
    .bind(video.id, nextTranscriptRevision)
    .first<{ count: number }>();
  if ((inserted?.count ?? 0) !== indexedBlocks.length) {
    throw new Error("The transcript search index could not be completed");
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO library_transcript_index_state (
         video_id, owner_id, transcript_revision, video_revision,
         semantic_revision, semantic_error, indexed_at, semantic_indexed_at
       ) VALUES (?, ?, ?, ?, NULL, NULL, datetime('now'), NULL)
       ON CONFLICT(video_id) DO UPDATE SET
         owner_id = excluded.owner_id,
         transcript_revision = excluded.transcript_revision,
         video_revision = excluded.video_revision,
         semantic_revision = NULL,
         semantic_error = NULL,
         indexed_at = datetime('now'),
         semantic_indexed_at = NULL`,
    ).bind(
      video.id,
      video.owner_id,
      nextTranscriptRevision,
      nextVideoRevision,
    ),
    env.DB.prepare(
      `DELETE FROM library_transcript_blocks
       WHERE video_id = ? AND transcript_revision <> ?`,
    ).bind(video.id, nextTranscriptRevision),
  ]);

  return {
    transcriptRevision: nextTranscriptRevision,
    videoRevision: nextVideoRevision,
  };
}

async function ensureExactIndex(
  env: Env,
  videos: SearchableVideo[],
): Promise<SearchableVideo[]> {
  const indexed: SearchableVideo[] = [];
  for (const video of videos) {
    if (video.transcript_status !== "available") continue;
    const transcript = await readCachedTranscript(env, video.id);
    if (!transcript) continue;
    await syncExactTranscript(env, video, transcript);
    indexed.push(video);
  }
  return indexed;
}

function blocksForMatch(
  blocks: TranscriptBlock[],
  startSeconds: number,
  endSeconds: number,
): TranscriptBlock[] {
  return blocks.filter(
    (block) =>
      block.endSeconds >= startSeconds && block.startSeconds <= endSeconds,
  );
}

async function exactSearch(
  env: Env,
  ownerId: string,
  videos: SearchableVideo[],
  query: string,
  limit: number,
  archived: boolean,
): Promise<LibrarySearchResult[]> {
  const matchExpression = ftsQuery(query);
  if (!matchExpression) return [];
  const candidateRows = await env.DB
    .prepare(
      `SELECT DISTINCT b.video_id
       FROM library_transcript_fts
       JOIN library_transcript_blocks AS b ON b.id = library_transcript_fts.rowid
       JOIN library_transcript_index_state AS state
         ON state.video_id = b.video_id
        AND state.transcript_revision = b.transcript_revision
       JOIN source_videos AS video ON video.id = b.video_id
       WHERE library_transcript_fts MATCH ?
         AND b.owner_id = ?
         AND state.owner_id = ?
         AND video.owner_id = ?
         AND ${archived ? "video.archived_at IS NOT NULL" : "video.archived_at IS NULL"}
       ORDER BY b.video_id`,
    )
    .bind(matchExpression, ownerId, ownerId, ownerId)
    .all<{ video_id: string }>();
  const candidates = new Set((candidateRows.results ?? []).map((row) => row.video_id));
  const results: LibrarySearchResult[] = [];

  for (const video of videos.filter((item) => candidates.has(item.id))) {
    const [transcript, state] = await Promise.all([
      readCachedTranscript(env, video.id),
      getIndexState(env.DB, video.id),
    ]);
    if (!transcript || !state) continue;
    const blocks = buildTranscriptBlocks(transcript);
    const matches = findTranscriptMatches(transcript, query, {
      beforeSeconds: EXACT_SEARCH_BEFORE_SECONDS,
      afterSeconds: EXACT_SEARCH_AFTER_SECONDS,
      durationSeconds: video.duration_seconds,
    });
    for (const match of matches) {
      const evidenceBlocks = blocksForMatch(
        blocks,
        match.spokenStartSeconds,
        match.spokenEndSeconds,
      );
      const blockIds = evidenceBlocks.map((block) => block.id);
      if (blockIds.length === 0) continue;
      results.push({
        resultId: await searchResultId({
          ownerId,
          mode: "exact",
          query,
          videoId: video.id,
          transcriptRevision: state.transcript_revision,
          videoRevision: state.video_revision,
          blockIds,
          evidenceStartSeconds: match.spokenStartSeconds,
          evidenceEndSeconds: match.spokenEndSeconds,
        }),
        mode: "exact",
        query,
        video: {
          id: video.id,
          title: video.title,
          sourceType: video.source_type,
          archived: video.archived_at !== null,
        },
        evidence: {
          blockIds,
          text: match.text,
          startSeconds: match.spokenStartSeconds,
          endSeconds: match.spokenEndSeconds,
        },
        proposedRange: {
          startSeconds: match.startSeconds,
          endSeconds: match.endSeconds,
        },
        revisions: {
          transcriptRevision: state.transcript_revision,
          videoRevision: state.video_revision,
        },
      });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

async function embedTexts(ai: Ai, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const output = await ai.run(LIBRARY_EMBEDDING_MODEL, {
    text: texts,
    pooling: "cls",
  });
  if (!("data" in output) || !Array.isArray(output.data)) {
    throw new Error("Workers AI returned no embedding vectors");
  }
  if (
    output.data.length !== texts.length ||
    output.data.some(
      (vector) =>
        !Array.isArray(vector) ||
        vector.length === 0 ||
        vector.some((value) => !Number.isFinite(value)),
    )
  ) {
    throw new Error("Workers AI returned invalid embedding vectors");
  }
  return output.data;
}

async function markSemanticFailure(
  db: D1Database,
  videoId: string,
  message: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE library_transcript_index_state
       SET semantic_revision = NULL,
           semantic_error = ?,
           semantic_indexed_at = datetime('now')
       WHERE video_id = ?`,
    )
    .bind(message.slice(0, 500), videoId)
    .run();
}

async function ensureSemanticIndex(
  env: Env,
  videos: SearchableVideo[],
): Promise<{ failures: string[]; indexedAny: boolean }> {
  const vectorIndex = env.LIBRARY_TRANSCRIPT_INDEX;
  if (!vectorIndex) {
    return {
      failures: ["Meaning search is not configured for this environment."],
      indexedAny: false,
    };
  }
  const failures: string[] = [];
  let indexedAny = false;
  for (const video of videos) {
    const state = await getIndexState(env.DB, video.id);
    if (!state || state.semantic_revision === state.transcript_revision) continue;
    const result = await env.DB
      .prepare(
        `SELECT block_id, start_seconds, end_seconds, text, vector_id
         FROM library_transcript_blocks
         WHERE owner_id = ? AND video_id = ? AND transcript_revision = ?
         ORDER BY start_seconds ASC`,
      )
      .bind(video.owner_id, video.id, state.transcript_revision)
      .all<IndexedBlockRow>();
    const blocks = result.results ?? [];
    try {
      for (let index = 0; index < blocks.length; index += 50) {
        const chunk = blocks.slice(index, index + 50);
        const vectors = await embedTexts(
          env.AI,
          chunk.map((block) => block.text),
        );
        await vectorIndex.upsert(
          chunk.map((block, blockIndex) => ({
            id: block.vector_id,
            values: vectors[blockIndex],
            namespace: video.owner_id,
            metadata: {
              ownerId: video.owner_id,
              videoId: video.id,
              transcriptRevision: state.transcript_revision,
              blockId: block.block_id,
            },
          })),
        );
      }
      await env.DB
        .prepare(
          `UPDATE library_transcript_index_state
           SET semantic_revision = transcript_revision,
               semantic_error = NULL,
               semantic_indexed_at = datetime('now')
           WHERE video_id = ? AND owner_id = ? AND transcript_revision = ?`,
        )
        .bind(video.id, video.owner_id, state.transcript_revision)
        .run();
      indexedAny = true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Meaning indexing failed";
      failures.push(`${video.title}: ${message}`);
      await markSemanticFailure(env.DB, video.id, message);
    }
  }
  return { failures, indexedAny };
}

async function meaningSearch(
  env: Env,
  ownerId: string,
  videos: SearchableVideo[],
  query: string,
  limit: number,
  archived: boolean,
): Promise<{
  results: LibrarySearchResult[];
  status: "available" | "unavailable";
  message?: string;
}> {
  const vectorIndex = env.LIBRARY_TRANSCRIPT_INDEX;
  if (!vectorIndex) {
    return {
      results: [],
      status: "unavailable",
      message: "Meaning search is not configured. Exact search is still available.",
    };
  }
  const semanticIndex = await ensureSemanticIndex(env, videos);
  try {
    const [queryVector] = await embedTexts(env.AI, [query]);
    const matches = await vectorIndex.query(queryVector, {
      topK: VECTOR_QUERY_CANDIDATE_LIMIT,
      namespace: ownerId,
    });
    const rankedIds = matches.matches.map((match) => match.id);
    if (rankedIds.length === 0) {
      return {
        results: [],
        status: "available",
        ...(semanticIndex.indexedAny
          ? { message: "The meaning index is catching up. Try this search again shortly." }
          : {}),
      };
    }
    const placeholders = rankedIds.map(() => "?").join(", ");
    const rows = await env.DB
      .prepare(
        `SELECT block.video_id, block.block_id, block.transcript_revision,
                block.start_seconds, block.end_seconds, block.text, block.vector_id,
                state.video_revision, video.title, video.source_type,
                video.duration_seconds, video.archived_at
         FROM library_transcript_blocks AS block
         JOIN library_transcript_index_state AS state
           ON state.video_id = block.video_id
          AND state.owner_id = block.owner_id
          AND state.transcript_revision = block.transcript_revision
          AND state.semantic_revision = block.transcript_revision
         JOIN source_videos AS video
           ON video.id = block.video_id AND video.owner_id = block.owner_id
         WHERE block.owner_id = ?
           AND block.vector_id IN (${placeholders})
           AND ${archived ? "video.archived_at IS NOT NULL" : "video.archived_at IS NULL"}`,
      )
      .bind(ownerId, ...rankedIds)
      .all<ReauthorizedBlockRow>();
    const rowsById = new Map((rows.results ?? []).map((row) => [row.vector_id, row]));
    const scores = new Map(matches.matches.map((match) => [match.id, match.score]));
    const results: LibrarySearchResult[] = [];
    for (const id of rankedIds) {
      const row = rowsById.get(id);
      if (!row) continue;
      const range = buildTranscriptClipRange({
        spokenStartSeconds: row.start_seconds,
        spokenEndSeconds: row.end_seconds,
        beforeSeconds: EXACT_SEARCH_BEFORE_SECONDS,
        afterSeconds: EXACT_SEARCH_AFTER_SECONDS,
        durationSeconds: row.duration_seconds,
      });
      if (!range) continue;
      const blockIds = [row.block_id];
      results.push({
        resultId: await searchResultId({
          ownerId,
          mode: "meaning",
          query,
          videoId: row.video_id,
          transcriptRevision: row.transcript_revision,
          videoRevision: row.video_revision,
          blockIds,
          evidenceStartSeconds: row.start_seconds,
          evidenceEndSeconds: row.end_seconds,
        }),
        mode: "meaning",
        query,
        video: {
          id: row.video_id,
          title: row.title,
          sourceType: row.source_type,
          archived: row.archived_at !== null,
        },
        evidence: {
          blockIds,
          text: row.text,
          startSeconds: row.start_seconds,
          endSeconds: row.end_seconds,
        },
        proposedRange: range,
        revisions: {
          transcriptRevision: row.transcript_revision,
          videoRevision: row.video_revision,
        },
        similarityScore: scores.get(id),
      });
      if (results.length >= limit) break;
    }
    const message = semanticIndex.failures.length > 0
      ? "Some videos could not be added to meaning search. Exact search remains complete."
      : semanticIndex.indexedAny
        ? "The meaning index was updated and may take a moment to reflect every new passage."
        : undefined;
    return { results, status: "available", ...(message ? { message } : {}) };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Meaning search failed";
    return {
      results: [],
      status: "unavailable",
      message: `${message}. Exact search is still available.`,
    };
  }
}

export async function searchPrivateLibrary(
  env: Env,
  ownerId: string,
  input: {
    query: string;
    mode: LibrarySearchMode;
    limit?: number;
    archived?: boolean;
  },
): Promise<LibrarySearchResponse> {
  const query = input.query.trim();
  const limit = Math.min(
    MAX_LIBRARY_SEARCH_RESULTS,
    Math.max(1, input.limit ?? 10),
  );
  const archived = input.archived ?? false;
  const videos = await listSearchableVideos(env.DB, ownerId, archived);
  const indexedVideos = await ensureExactIndex(env, videos);
  const coverage = {
    totalVideos: videos.length,
    searchableVideos: indexedVideos.length,
    unavailableVideos: videos.length - indexedVideos.length,
  };

  if (input.mode === "exact") {
    return {
      query,
      mode: "exact",
      results: await exactSearch(
        env,
        ownerId,
        indexedVideos,
        query,
        limit,
        archived,
      ),
      coverage,
    };
  }

  const semantic = await meaningSearch(
    env,
    ownerId,
    indexedVideos,
    query,
    limit,
    archived,
  );
  return {
    query,
    mode: "meaning",
    results: semantic.results,
    coverage,
    meaningStatus: semantic.status,
    meaningMessage: semantic.message,
  };
}

async function loadCurrentEvidence(
  db: D1Database,
  ownerId: string,
  input: PrepareLibraryMomentInput,
): Promise<{
  video: SearchableVideo;
  blocks: IndexedBlockRow[];
  workspaceRevision: string;
}> {
  const video = await getSearchableVideo(db, ownerId, input.videoId);
  const state = await getIndexState(db, input.videoId);
  if (!video || !state || state.transcript_revision !== input.transcriptRevision) {
    throw new LibraryDiscoveryError(
      "STALE_RESULT",
      "This transcript changed. Run the Library search again before opening a proposal.",
    );
  }
  const currentVideoRevision = await videoRevision(video);
  if (
    state.video_revision !== input.videoRevision ||
    currentVideoRevision !== input.videoRevision
  ) {
    throw new LibraryDiscoveryError(
      "STALE_RESULT",
      "This video changed. Run the Library search again before opening a proposal.",
    );
  }
  const blockIds = [...new Set(input.blockIds)];
  if (blockIds.length === 0 || blockIds.length > 20) {
    throw new LibraryDiscoveryError(
      "INVALID_RESULT",
      "A Library result must reference between 1 and 20 transcript passages.",
    );
  }
  const placeholders = blockIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT block_id, start_seconds, end_seconds, text, vector_id
       FROM library_transcript_blocks
       WHERE owner_id = ? AND video_id = ? AND transcript_revision = ?
         AND block_id IN (${placeholders})
       ORDER BY start_seconds ASC`,
    )
    .bind(ownerId, input.videoId, input.transcriptRevision, ...blockIds)
    .all<IndexedBlockRow>();
  const blocks = result.results ?? [];
  if (blocks.length !== blockIds.length) {
    throw new LibraryDiscoveryError(
      "STALE_RESULT",
      "The transcript evidence is no longer current. Run the Library search again.",
    );
  }
  return {
    video,
    blocks,
    workspaceRevision: `${currentVideoRevision}:${input.transcriptRevision}`,
  };
}

export async function prepareLibraryMomentReview(
  env: Env,
  ownerId: string,
  input: PrepareLibraryMomentInput,
): Promise<PreparedLibraryMomentReview> {
  const query = input.query.trim();
  const expectedResultId = await searchResultId({
    ownerId,
    mode: input.mode,
    query,
    videoId: input.videoId,
    transcriptRevision: input.transcriptRevision,
    videoRevision: input.videoRevision,
    blockIds: input.blockIds,
    evidenceStartSeconds: input.evidenceStartSeconds,
    evidenceEndSeconds: input.evidenceEndSeconds,
  });
  if (expectedResultId !== input.resultId) {
    throw new LibraryDiscoveryError(
      "INVALID_RESULT",
      "This Library result identity is invalid. Run the search again.",
    );
  }
  const evidence = await loadCurrentEvidence(env.DB, ownerId, input);
  let range: { startSeconds: number; endSeconds: number } | null = null;
  if (input.mode === "exact") {
    const transcript = await readCachedTranscript(env, input.videoId);
    const exactMatch = transcript
      ? findTranscriptMatches(transcript, query, {
          beforeSeconds: EXACT_SEARCH_BEFORE_SECONDS,
          afterSeconds: EXACT_SEARCH_AFTER_SECONDS,
          durationSeconds: evidence.video.duration_seconds,
        }).find(
          (match) =>
            Math.abs(match.spokenStartSeconds - input.evidenceStartSeconds) < 0.001 &&
            Math.abs(match.spokenEndSeconds - input.evidenceEndSeconds) < 0.001,
        )
      : undefined;
    range = exactMatch
      ? { startSeconds: exactMatch.startSeconds, endSeconds: exactMatch.endSeconds }
      : null;
  } else {
    const firstBlock = evidence.blocks[0];
    const lastBlock = evidence.blocks.at(-1)!;
    const evidenceMatchesBlocks =
      Math.abs(firstBlock.start_seconds - input.evidenceStartSeconds) < 0.001 &&
      Math.abs(lastBlock.end_seconds - input.evidenceEndSeconds) < 0.001;
    range = evidenceMatchesBlocks
      ? buildTranscriptClipRange({
          spokenStartSeconds: input.evidenceStartSeconds,
          spokenEndSeconds: input.evidenceEndSeconds,
          beforeSeconds: EXACT_SEARCH_BEFORE_SECONDS,
          afterSeconds: EXACT_SEARCH_AFTER_SECONDS,
          durationSeconds: evidence.video.duration_seconds,
        })
      : null;
  }
  if (!range) {
    throw new LibraryDiscoveryError(
      "INVALID_RESULT",
      "This result cannot form a valid clip range.",
    );
  }
  const proposalId = crypto.randomUUID();
  const evidenceText = evidence.blocks.map((block) => block.text).join(" ");
  const proposalTitle = compactTitle(query, evidence.video.title);
  const proposalRationale = rationale(input.mode, query, evidenceText);
  await env.DB
    .prepare(
      `INSERT INTO library_moment_proposals (
         id, owner_id, video_id, search_result_id, search_mode, query,
         transcript_revision, video_revision, block_ids_json, title,
         rationale, start_seconds, end_seconds
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      proposalId,
      ownerId,
      input.videoId,
      input.resultId,
      input.mode,
      query,
      input.transcriptRevision,
      input.videoRevision,
      JSON.stringify(input.blockIds),
      proposalTitle,
      proposalRationale,
      range.startSeconds,
      range.endSeconds,
    )
    .run();
  return {
    proposalId,
    searchResultId: input.resultId,
    videoId: input.videoId,
    reviewUrl: `/?video=${encodeURIComponent(input.videoId)}&libraryProposal=${encodeURIComponent(proposalId)}`,
    input: {
      title: proposalTitle,
      startSeconds: range.startSeconds,
      endSeconds: range.endSeconds,
      quality: "1080p",
    },
    evidence: {
      rationale: proposalRationale,
      sourceBlockIds: [...input.blockIds],
      workspaceRevision: evidence.workspaceRevision,
    },
  };
}

function parseBlockIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

export async function readPreparedLibraryMomentReview(
  env: Env,
  ownerId: string,
  proposalId: string,
): Promise<PreparedLibraryMomentReview> {
  const proposal = await env.DB
    .prepare(
      `SELECT id, owner_id, video_id, search_result_id, search_mode, query,
              transcript_revision, video_revision, block_ids_json, title,
              rationale, start_seconds, end_seconds, expires_at
       FROM library_moment_proposals
       WHERE id = ? AND owner_id = ?`,
    )
    .bind(proposalId, ownerId)
    .first<PreparedReviewRow>();
  if (!proposal) {
    throw new LibraryDiscoveryError(
      "RESULT_NOT_FOUND",
      "Library proposal not found.",
    );
  }
  const expiresAt = Date.parse(`${proposal.expires_at.replace(" ", "T")}Z`);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new LibraryDiscoveryError(
      "RESULT_EXPIRED",
      "This Library proposal expired. Run the search again.",
    );
  }
  const blockIds = parseBlockIds(proposal.block_ids_json);
  const current = await loadCurrentEvidence(env.DB, ownerId, {
    resultId: proposal.search_result_id,
    mode: proposal.search_mode,
    query: proposal.query,
    videoId: proposal.video_id,
    transcriptRevision: proposal.transcript_revision,
    videoRevision: proposal.video_revision,
    blockIds,
    evidenceStartSeconds: proposal.start_seconds,
    evidenceEndSeconds: proposal.end_seconds,
  });
  return {
    proposalId: proposal.id,
    searchResultId: proposal.search_result_id,
    videoId: proposal.video_id,
    reviewUrl: `/?video=${encodeURIComponent(proposal.video_id)}&libraryProposal=${encodeURIComponent(proposal.id)}`,
    input: {
      title: proposal.title,
      startSeconds: proposal.start_seconds,
      endSeconds: proposal.end_seconds,
      quality: "1080p",
    },
    evidence: {
      rationale: proposal.rationale,
      sourceBlockIds: blockIds,
      workspaceRevision: current.workspaceRevision,
    },
  };
}
