import {
  listArtifactDeletions,
  markArtifactDeletionFailed,
  removeArtifactDeletion,
} from "./db";

const DEFAULT_DRAIN_LIMIT = 100;

export async function drainArtifactDeletions(
  db: D1Database,
  bucket: R2Bucket,
  limit = DEFAULT_DRAIN_LIMIT,
): Promise<void> {
  let pending: Array<{ key: string }>;
  try {
    pending = await listArtifactDeletions(db, limit);
  } catch (error) {
    console.error("Failed to read artifact deletion queue", error);
    return;
  }

  await Promise.all(
    pending.map(async ({ key }) => {
      try {
        await bucket.delete(key);
        await removeArtifactDeletion(db, key);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown storage error";
        try {
          await markArtifactDeletionFailed(db, key, message.slice(0, 1000));
        } catch (recordError) {
          console.error("Failed to record artifact deletion failure", recordError);
        }
      }
    }),
  );
}
