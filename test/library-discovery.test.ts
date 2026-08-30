import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import type { AuthenticatedUser } from "../src/identity";
import {
  prepareLibraryMomentReview,
  readPreparedLibraryMomentReview,
  searchPrivateLibrary,
} from "../src/library-discovery";
import { handleRequest } from "../src/routes";
import { transcriptObjectKey } from "../src/source-videos";

interface TestOwner {
  id: string;
  email: string;
}

async function installOwner(label: string): Promise<TestOwner> {
  const id = crypto.randomUUID();
  const owner = { id, email: `${label}-${id}@example.com` };
  await env.DB.prepare(
    `INSERT INTO app_users (id, access_user_id, email) VALUES (?, ?, ?)`,
  )
    .bind(owner.id, owner.id, owner.email)
    .run();
  return owner;
}

async function installTranscriptVideo(input: {
  owner: TestOwner;
  title: string;
  cues: Array<{ startSeconds: number; endSeconds: number; text: string }>;
  archived?: boolean;
}): Promise<string> {
  const videoId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO source_videos (
       id, owner_id, source_type, source_ref, title, duration_seconds,
       transcript_status, archived_at
     ) VALUES (?, ?, 'upload', ?, ?, 90, 'available', ?)`,
  )
    .bind(
      videoId,
      input.owner.id,
      `uploads/${input.owner.id}/${videoId}.mp4`,
      input.title,
      input.archived ? "2026-08-29 12:00:00" : null,
    )
    .run();
  await env.CLIPS_BUCKET.put(
    transcriptObjectKey(videoId),
    JSON.stringify({
      version: 1,
      fetchedAt: "2026-08-29T12:00:00.000Z",
      language: "en",
      automatic: true,
      cues: input.cues,
    }),
  );
  return videoId;
}

async function requestAs(
  owner: TestOwner,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await handleRequest(
    new Request(`http://example.com${path}`, init),
    env,
    ctx,
    owner as AuthenticatedUser,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("private Library discovery", () => {
  it("finds exact phrases deterministically and never returns another owner's evidence", async () => {
    const alice = await installOwner("alice-library-search");
    const bob = await installOwner("bob-library-search");
    const aliceVideoId = await installTranscriptVideo({
      owner: alice,
      title: "Alice launch notes",
      cues: [
        { startSeconds: 10, endSeconds: 12, text: "The private launch" },
        { startSeconds: 12.2, endSeconds: 14, text: "plan starts tomorrow" },
      ],
    });
    await installTranscriptVideo({
      owner: bob,
      title: "Bob secret notes",
      cues: [
        { startSeconds: 20, endSeconds: 23, text: "The private launch plan is Bob's" },
      ],
    });

    const result = await searchPrivateLibrary(env, alice.id, {
      query: "private launch plan",
      mode: "exact",
    });

    expect(result.coverage).toEqual({
      totalVideos: 1,
      searchableVideos: 1,
      unavailableVideos: 0,
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].video).toMatchObject({
      id: aliceVideoId,
      title: "Alice launch notes",
    });
    expect(result.results[0].evidence.text).toContain("private launch");
    expect(result.results[0].evidence.blockIds.length).toBeGreaterThan(0);
    expect(result.results[0].proposedRange).toEqual({
      startSeconds: 9,
      endSeconds: 16,
    });
  });

  it("prepares an owner-bound editable handoff and rejects it after the video changes", async () => {
    const owner = await installOwner("prepared-library-review");
    const videoId = await installTranscriptVideo({
      owner,
      title: "Grounded interview",
      cues: [
        { startSeconds: 30, endSeconds: 34, text: "Reliability comes from evidence" },
      ],
    });
    const search = await searchPrivateLibrary(env, owner.id, {
      query: "reliability",
      mode: "exact",
    });
    const result = search.results[0];
    const prepared = await prepareLibraryMomentReview(env, owner.id, {
      resultId: result.resultId,
      mode: result.mode,
      query: result.query,
      videoId: result.video.id,
      transcriptRevision: result.revisions.transcriptRevision,
      videoRevision: result.revisions.videoRevision,
      blockIds: result.evidence.blockIds,
      evidenceStartSeconds: result.evidence.startSeconds,
      evidenceEndSeconds: result.evidence.endSeconds,
    });

    expect(prepared.videoId).toBe(videoId);
    expect(prepared.reviewUrl).toContain(`video=${videoId}`);
    expect(prepared.reviewUrl).toContain("libraryProposal=");
    expect(prepared.evidence.sourceBlockIds).toEqual(result.evidence.blockIds);
    expect(await readPreparedLibraryMomentReview(env, owner.id, prepared.proposalId))
      .toMatchObject({ proposalId: prepared.proposalId, videoId });

    await env.DB.prepare(
      `UPDATE source_videos SET title = 'Changed interview' WHERE id = ?`,
    )
      .bind(videoId)
      .run();
    await expect(
      readPreparedLibraryMomentReview(env, owner.id, prepared.proposalId),
    ).rejects.toMatchObject({ code: "STALE_RESULT" });
  });

  it("keeps exact search available when meaning search is not configured", async () => {
    const owner = await installOwner("optional-meaning-search");
    await installTranscriptVideo({
      owner,
      title: "Optional AI",
      cues: [
        { startSeconds: 4, endSeconds: 8, text: "A calm explanation of architecture" },
      ],
    });

    const meaning = await searchPrivateLibrary(env, owner.id, {
      query: "why the design is trustworthy",
      mode: "meaning",
    });
    const exact = await searchPrivateLibrary(env, owner.id, {
      query: "calm explanation",
      mode: "exact",
    });

    expect(meaning).toMatchObject({
      results: [],
      meaningStatus: "unavailable",
    });
    expect(meaning.meaningMessage).toContain("Exact search is still available");
    expect(exact.results).toHaveLength(1);
  });

  it("builds the exact index idempotently when searches arrive together", async () => {
    const owner = await installOwner("concurrent-exact-search");
    await installTranscriptVideo({
      owner,
      title: "Concurrent transcript",
      cues: [
        { startSeconds: 8, endSeconds: 11, text: "Concurrent indexing stays deterministic" },
      ],
    });

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        searchPrivateLibrary(env, owner.id, {
          query: "concurrent indexing",
          mode: "exact",
        }),
      ),
    );

    expect(results.map((result) => result.results.length)).toEqual([1, 1, 1]);
    expect(new Set(results.map((result) => result.results[0].resultId)).size).toBe(1);
  });

  it("keeps repeated exact hits in one transcript block distinct and preserves the chosen range", async () => {
    const owner = await installOwner("repeated-exact-hit");
    await installTranscriptVideo({
      owner,
      title: "Repeated phrase",
      cues: [
        { startSeconds: 10, endSeconds: 10.2, text: "code" },
        { startSeconds: 10.4, endSeconds: 15, text: "a thought between the hits" },
        { startSeconds: 15.2, endSeconds: 15.4, text: "code" },
      ],
    });
    const search = await searchPrivateLibrary(env, owner.id, {
      query: "code",
      mode: "exact",
    });

    expect(search.results).toHaveLength(2);
    expect(new Set(search.results.map((result) => result.resultId)).size).toBe(2);
    const chosen = search.results[1];
    const prepared = await prepareLibraryMomentReview(env, owner.id, {
      resultId: chosen.resultId,
      mode: chosen.mode,
      query: chosen.query,
      videoId: chosen.video.id,
      transcriptRevision: chosen.revisions.transcriptRevision,
      videoRevision: chosen.revisions.videoRevision,
      blockIds: chosen.evidence.blockIds,
      evidenceStartSeconds: chosen.evidence.startSeconds,
      evidenceEndSeconds: chosen.evidence.endSeconds,
    });

    expect(prepared.input).toMatchObject(chosen.proposedRange);
  });

  it("reauthorizes meaning matches against the owner's current D1 rows", async () => {
    const alice = await installOwner("alice-meaning-search");
    const bob = await installOwner("bob-meaning-search");
    const aliceVideoId = await installTranscriptVideo({
      owner: alice,
      title: "Alice architecture",
      cues: [
        { startSeconds: 6, endSeconds: 10, text: "Boundaries keep the system trustworthy" },
      ],
    });
    await installTranscriptVideo({
      owner: bob,
      title: "Bob architecture",
      cues: [
        { startSeconds: 16, endSeconds: 20, text: "A private explanation from Bob" },
      ],
    });

    const vectors = new Map<string, VectorizeVector>();
    const vectorIndex = {
      upsert: async (items: VectorizeVector[]) => {
        items.forEach((item) => vectors.set(item.id, item));
        return { ids: items.map((item) => item.id), count: items.length };
      },
      query: async () => ({
        count: vectors.size,
        matches: [...vectors.values()].map((item, index) => ({
          ...item,
          score: 1 - index / 100,
        })),
      }),
    } as unknown as VectorizeIndex;
    const semanticEnv = {
      DB: env.DB,
      CLIPS_BUCKET: env.CLIPS_BUCKET,
      AI: {
        run: async (_model: string, input: { text: string | string[] }) => {
          const texts = Array.isArray(input.text) ? input.text : [input.text];
          return { data: texts.map((text) => [text.length, 1, 0]) };
        },
      } as unknown as Ai,
      LIBRARY_TRANSCRIPT_INDEX: vectorIndex,
    } as Env;

    await searchPrivateLibrary(semanticEnv, bob.id, {
      query: "private explanation",
      mode: "meaning",
    });
    const result = await searchPrivateLibrary(semanticEnv, alice.id, {
      query: "trustworthy design",
      mode: "meaning",
    });

    expect(result.meaningStatus).toBe("available");
    expect(result.results.map((item) => item.video.id)).toEqual([aliceVideoId]);
    expect(result.results[0].evidence.blockIds).toHaveLength(1);
  });

  it("keeps meaning-result reauthorization within D1's variable limit", async () => {
    const owner = await installOwner("meaning-d1-variable-limit");
    const videoId = await installTranscriptVideo({
      owner,
      title: "Semantic candidate budget",
      cues: [
        { startSeconds: 6, endSeconds: 10, text: "Elephants have long trunks" },
      ],
    });

    const vectors = new Map<string, VectorizeVector>();
    const vectorIndex = {
      upsert: async (items: VectorizeVector[]) => {
        items.forEach((item) => vectors.set(item.id, item));
        return { ids: items.map((item) => item.id), count: items.length };
      },
      query: async (_vector: number[], options: { topK?: number }) => {
        const candidateCount = options.topK ?? 10;
        const [current] = [...vectors.values()];
        return {
          count: candidateCount,
          matches: Array.from({ length: candidateCount }, (_, index) => ({
            ...(index === 0
              ? current
              : {
                  id: `untrusted-vector-${index}`,
                  values: [0, 0, 0],
                  namespace: owner.id,
                }),
            score: 1 - index / 100,
          })),
        };
      },
    } as unknown as VectorizeIndex;
    const d1WithProductionVariableLimit = {
      prepare(query: string) {
        const statement = env.DB.prepare(query);
        return new Proxy(statement, {
          get(target, property, receiver) {
            if (property === "bind") {
              return (...values: unknown[]) => {
                if (values.length > 100) {
                  throw new Error("D1_ERROR: too many SQL variables");
                }
                return target.bind(...values);
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      batch(statements: D1PreparedStatement[]) {
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;
    const semanticEnv = {
      DB: d1WithProductionVariableLimit,
      CLIPS_BUCKET: env.CLIPS_BUCKET,
      AI: {
        run: async (_model: string, input: { text: string | string[] }) => {
          const texts = Array.isArray(input.text) ? input.text : [input.text];
          return { data: texts.map((text) => [text.length, 1, 0]) };
        },
      } as unknown as Ai,
      LIBRARY_TRANSCRIPT_INDEX: vectorIndex,
    } as Env;

    const result = await searchPrivateLibrary(semanticEnv, owner.id, {
      query: "animal with a long nose",
      mode: "meaning",
      limit: 1,
    });

    expect(result.meaningStatus).toBe("available");
    expect(result.results.map((item) => item.video.id)).toEqual([videoId]);
  });

  it("exposes owner-bound search and proposal handoffs through the authenticated API", async () => {
    const alice = await installOwner("alice-library-api");
    const bob = await installOwner("bob-library-api");
    await installTranscriptVideo({
      owner: alice,
      title: "API transcript",
      cues: [
        { startSeconds: 3, endSeconds: 7, text: "Grounded API evidence" },
      ],
    });
    const searchResponse = await requestAs(alice, "/api/library/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "API evidence", mode: "exact" }),
    });
    expect(searchResponse.status).toBe(200);
    const search = (await searchResponse.json()) as {
      results: Array<{
        resultId: string;
        mode: "exact";
        query: string;
        video: { id: string };
        revisions: { transcriptRevision: string; videoRevision: string };
        evidence: { blockIds: string[]; startSeconds: number; endSeconds: number };
      }>;
    };
    const result = search.results[0];
    const prepareResponse = await requestAs(alice, "/api/library/moments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resultId: result.resultId,
        mode: result.mode,
        query: result.query,
        videoId: result.video.id,
        transcriptRevision: result.revisions.transcriptRevision,
        videoRevision: result.revisions.videoRevision,
        blockIds: result.evidence.blockIds,
        evidenceStartSeconds: result.evidence.startSeconds,
        evidenceEndSeconds: result.evidence.endSeconds,
      }),
    });
    expect(prepareResponse.status).toBe(201);
    const prepared = (await prepareResponse.json()) as { proposalId: string };

    expect(
      (await requestAs(bob, `/api/library/moments/${prepared.proposalId}`)).status,
    ).toBe(404);
    expect(
      (await requestAs(alice, `/api/library/moments/${prepared.proposalId}`)).status,
    ).toBe(200);
  });
});
