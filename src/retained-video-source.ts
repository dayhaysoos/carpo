import {
  markSourceVideoRetainedSourceFailed,
  markSourceVideoRetainedSourceImporting,
  markSourceVideoRetainedSourceReady,
} from "./db";
import { youtubeRetainedSourceKey } from "./source-videos";
import type { SourceVideoRecord } from "./types";

export type RetainedVideoSourceFailure = {
  ok: false;
  error: string;
};

export type RetainedVideoSourceRetention = {
  ok: true;
  key: string;
  acquired: boolean;
};

export type StagedVideoSource = {
  ok: true;
  path: string;
  acquired: boolean;
};

type StageResult =
  | { ok: true; path: string }
  | RetainedVideoSourceFailure;

export interface RetainedVideoSourceAdapter {
  downloadYoutubeSource(input: {
    url: string;
    jobId: string;
  }): Promise<{ ok: true } | RetainedVideoSourceFailure>;
  persistDownloadedSource(input: {
    key: string;
    jobId: string;
  }): Promise<void>;
  stageBucketSource(input: {
    key: string;
    jobId: string;
  }): Promise<StageResult>;
}

export interface RetainedVideoSourceAcquisition {
  retain(
    video: SourceVideoRecord,
    jobId: string,
  ): Promise<RetainedVideoSourceRetention | RetainedVideoSourceFailure>;
  stage(
    video: SourceVideoRecord,
    jobId: string,
  ): Promise<StagedVideoSource | RetainedVideoSourceFailure>;
}

export function createRetainedVideoSourceAcquisition(input: {
  db: D1Database;
  bucket: R2Bucket;
  adapter: RetainedVideoSourceAdapter;
}): RetainedVideoSourceAcquisition {
  const { db, bucket, adapter } = input;

  const fail = async (
    videoId: string,
    error: unknown,
    fallback: string,
  ): Promise<RetainedVideoSourceFailure> => {
    const message = error instanceof Error ? error.message : fallback;
    await markSourceVideoRetainedSourceFailed(db, videoId, message);
    return { ok: false, error: message };
  };

  const retain: RetainedVideoSourceAcquisition["retain"] = async (
    video,
    jobId,
  ) => {
    if (video.source_type !== "youtube") {
      return {
        ok: false,
        error: "Uploaded videos do not require remote source acquisition",
      };
    }

    try {
      if (
        video.retained_source_status === "ready" &&
        video.retained_source_key &&
        (await bucket.head(video.retained_source_key))
      ) {
        return {
          ok: true,
          key: video.retained_source_key,
          acquired: false,
        };
      }

      if (video.retained_source_status === "ready") {
        await markSourceVideoRetainedSourceFailed(
          db,
          video.id,
          "Retained video source is unavailable",
        );
      }

      const key = youtubeRetainedSourceKey(video.id);
      await markSourceVideoRetainedSourceImporting(db, video.id, key);
      const downloaded = await adapter.downloadYoutubeSource({
        url: video.source_ref,
        jobId,
      });
      if (!downloaded.ok) {
        throw new Error(downloaded.error);
      }

      await adapter.persistDownloadedSource({ key, jobId });
      const retained = await markSourceVideoRetainedSourceReady(
        db,
        video.id,
        key,
      );
      if (!retained) {
        await bucket.delete(key);
        throw new Error("Video was deleted during source import");
      }

      return { ok: true, key, acquired: true };
    } catch (error) {
      return fail(video.id, error, "YouTube source acquisition failed");
    }
  };

  const stage: RetainedVideoSourceAcquisition["stage"] = async (
    video,
    jobId,
  ) => {
    if (video.source_type === "upload") {
      const staged = await adapter.stageBucketSource({
        key: video.source_ref,
        jobId,
      });
      return staged.ok ? { ...staged, acquired: false } : staged;
    }

    const retained = await retain(video, jobId);
    if (!retained.ok) return retained;

    const staged = await adapter.stageBucketSource({
      key: retained.key,
      jobId,
    });
    if (!staged.ok) {
      return fail(video.id, staged.error, "Retained video source staging failed");
    }
    return { ...staged, acquired: retained.acquired };
  };

  return { retain, stage };
}
