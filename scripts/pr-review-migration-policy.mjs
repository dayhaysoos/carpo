const MIGRATION_PREFIX = "migrations/";
const MIGRATION_FILE_PATTERN = /^migrations\/([^/]+\.sql)$/;

export function reviewMigrationChanges(files) {
  const changed = files.filter(
    (file) =>
      file?.path === "migrations" ||
      (typeof file?.path === "string" &&
        file.path.startsWith(MIGRATION_PREFIX)),
  );
  if (changed.length === 0) {
    return Object.freeze({ status: "unchanged", names: Object.freeze([]) });
  }

  const names = changed.map((file) => {
    const match = file.path.match(MIGRATION_FILE_PATTERN);
    if (!match || file.status !== "A") {
      throw new Error(
        "PR review only accepts newly added top-level D1 migration files; modified, deleted, renamed, or non-SQL migration changes require a recreated review environment",
      );
    }
    return match[1];
  });

  return Object.freeze({
    status: "requires-preapplied",
    names: Object.freeze([...new Set(names)]),
  });
}

export async function admitPreappliedReviewMigrations(
  files,
  { readAppliedMigrationNames },
) {
  const changes = reviewMigrationChanges(files);
  if (changes.status === "unchanged") return changes;
  if (typeof readAppliedMigrationNames !== "function") {
    throw new Error(
      "PR review migration admission requires an applied-migration reader",
    );
  }

  const appliedMigrationNames = await readAppliedMigrationNames();
  if (
    !Array.isArray(appliedMigrationNames) ||
    appliedMigrationNames.some((name) => typeof name !== "string")
  ) {
    throw new Error("Review database returned invalid migration state");
  }
  const applied = new Set(appliedMigrationNames);
  const missing = changes.names.filter((name) => !applied.has(name));
  if (missing.length > 0) {
    throw new Error(
      `PR review requires these new D1 migrations to be pre-applied to the isolated review database: ${missing.join(", ")}`,
    );
  }
  return Object.freeze({
    status: "preapplied",
    names: changes.names,
  });
}
