import { readFile } from "node:fs/promises";
import { parse, printParseErrorCode } from "jsonc-parser";

const EXPECTED = {
  workerName: "carpo-pr-review",
  databaseName: "carpo-pr-review",
  databaseId: "27981ced-fd12-49ea-9ce8-e71205e3f36e",
  clipBucketName: "carpo-clips-pr-review",
  evidenceBucketName: "carpo-pr-review-evidence",
  containerName: "carpo-pr-review-encodercontainer",
  vectorIndexName: "carpo-library-transcripts-pr-review",
};

const PRODUCTION = {
  workerName: "carpo",
  databaseName: "carpo",
  databaseId: "c130b680-e7fc-489e-927f-3c2139bc0afb",
  bucketName: "carpo-clips",
  vectorIndexName: "carpo-library-transcripts",
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expectedKeys, label) {
  invariant(value && typeof value === "object", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  invariant(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} keys are not allowlisted: ${actual.join(", ")}`,
  );
}

function hasNoRoutes(review) {
  return (
    review.route === undefined &&
    (review.routes === undefined || review.routes.length === 0)
  );
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])]),
  );
}

async function readJsonc(configPath) {
  const parseErrors = [];
  const config = parse(await readFile(configPath, "utf8"), parseErrors, {
    allowTrailingComma: true,
  });
  if (parseErrors.length === 0) return config;

  const details = parseErrors
    .map((error) => `${printParseErrorCode(error.error)} at ${error.offset}`)
    .join(", ");
  throw new Error(`Could not parse ${configPath}: ${details}`);
}

async function main() {
  const configPath = process.argv[2] ?? "wrangler.jsonc";
  const baseConfigPath = process.argv[3];
  const config = await readJsonc(configPath);
  if (baseConfigPath) {
    const baseConfig = await readJsonc(baseConfigPath);
    invariant(
      JSON.stringify(canonicalJson(config.migrations)) ===
        JSON.stringify(canonicalJson(baseConfig.migrations)),
      "Durable Object migrations changed; v0 requires an isolated review environment",
    );
  }

  const review = config?.env?.["pr-review"];
  invariant(review, "wrangler.jsonc must define env.pr-review");
  exactKeys(
    review,
    [
      "name",
      "workers_dev",
      "preview_urls",
      "routes",
      "ai",
      "vectorize",
      "assets",
      "version_metadata",
      "secrets",
      "vars",
      "d1_databases",
      "r2_buckets",
      "containers",
      "durable_objects",
    ],
    "Review environment",
  );
  invariant(review.name === EXPECTED.workerName, "Review Worker name is not allowlisted");
  invariant(review.name !== PRODUCTION.workerName, "Review Worker must not use the production name");
  invariant(review.workers_dev === true, "Review Worker must remain on workers.dev");
  invariant(review.preview_urls === false, "Review preview URLs must remain disabled");
  invariant(hasNoRoutes(review), "Review Worker must not define custom or production routes");
  exactKeys(review.ai, ["binding", "remote"], "Review AI binding");
  invariant(review.ai.binding === "AI" && review.ai.remote === true, "Review AI binding is not allowlisted");
  invariant(
    review.vectorize?.length === 1,
    "Review Worker must have exactly one Vectorize binding",
  );
  const vectorIndex = review.vectorize[0];
  exactKeys(vectorIndex, ["binding", "index_name"], "Review Vectorize binding");
  invariant(
    vectorIndex.binding === "LIBRARY_TRANSCRIPT_INDEX",
    "Review Vectorize binding name is not allowlisted",
  );
  invariant(
    vectorIndex.index_name === EXPECTED.vectorIndexName,
    "Review Vectorize index is not allowlisted",
  );
  invariant(
    vectorIndex.index_name !== PRODUCTION.vectorIndexName,
    "Review Vectorize binding must not use the production index",
  );
  exactKeys(
    review.assets,
    ["directory", "binding", "not_found_handling", "run_worker_first"],
    "Review asset binding",
  );
  invariant(review.assets.directory === "./public", "Review asset directory is not allowlisted");
  invariant(review.assets.binding === "ASSETS", "Review asset binding name is not allowlisted");
  invariant(review.assets.not_found_handling === "single-page-application", "Review asset fallback is not allowlisted");
  invariant(review.assets?.run_worker_first === true, "Review authentication must run before every asset");
  exactKeys(review.version_metadata, ["binding"], "Review version metadata binding");
  invariant(review.version_metadata?.binding === "CF_VERSION_METADATA", "Review Worker must expose version metadata");
  exactKeys(review.secrets, ["required"], "Review secrets declaration");
  invariant(
    JSON.stringify(review.secrets?.required) === JSON.stringify(["PR_REVIEW_AUTH_TOKEN"]),
    "Review Worker must require only PR_REVIEW_AUTH_TOKEN",
  );
  exactKeys(
    review.vars,
    ["AUTH_MODE", "R2_PUBLIC_PREFIX", "PR_REVIEW_MODE"],
    "Review vars",
  );
  invariant(review.vars.AUTH_MODE === "legacy", "Review auth mode is not allowlisted");
  invariant(review.vars.R2_PUBLIC_PREFIX === "/artifacts", "Review artifact prefix is not allowlisted");
  invariant(review.vars.PR_REVIEW_MODE === "enabled", "Review mode marker is not allowlisted");

  invariant(review.d1_databases?.length === 1, "Review Worker must have exactly one D1 binding");
  const database = review.d1_databases[0];
  exactKeys(
    database,
    ["binding", "database_name", "database_id", "migrations_dir"],
    "Review D1 binding",
  );
  invariant(database.binding === "DB", "Review D1 binding must be DB");
  invariant(database.database_name === EXPECTED.databaseName, "Review D1 name is not allowlisted");
  invariant(database.database_id === EXPECTED.databaseId, "Review D1 ID is not allowlisted");
  invariant(database.migrations_dir === "migrations", "Review D1 migrations directory is not allowlisted");
  invariant(database.database_name !== PRODUCTION.databaseName, "Review D1 must not use the production name");
  invariant(database.database_id !== PRODUCTION.databaseId, "Review D1 must not use the production ID");

  invariant(review.r2_buckets?.length === 2, "Review Worker must have exactly two R2 bindings");
  for (const bucket of review.r2_buckets) {
    exactKeys(bucket, ["binding", "bucket_name"], "Review R2 binding");
  }
  const bucketPairs = review.r2_buckets
    .map((bucket) => `${bucket.binding}:${bucket.bucket_name}`)
    .sort();
  invariant(
    JSON.stringify(bucketPairs) ===
      JSON.stringify([
        `CLIPS_BUCKET:${EXPECTED.clipBucketName}`,
        `PR_REVIEW_EVIDENCE_BUCKET:${EXPECTED.evidenceBucketName}`,
      ]),
    "Review R2 bindings are not allowlisted",
  );
  invariant(
    review.r2_buckets.every((bucket) => bucket.bucket_name !== PRODUCTION.bucketName),
    "Review R2 must not use the production bucket",
  );

  invariant(review.containers?.length === 1, "Review Worker must have exactly one Container binding");
  const container = review.containers[0];
  exactKeys(
    container,
    ["name", "class_name", "image", "instance_type", "max_instances"],
    "Review Container binding",
  );
  invariant(container.name === EXPECTED.containerName, "Review Container name is not allowlisted");
  invariant(container.class_name === "EncoderContainer", "Review Container class is not allowlisted");
  invariant(container.image === "./container/Dockerfile", "Review Container image is not allowlisted");
  invariant(container.instance_type === "standard-4", "Review Container type is not allowlisted");
  invariant(container.max_instances === 1, "Review Container must stay capped at one instance");

  exactKeys(review.durable_objects, ["bindings"], "Review Durable Object configuration");
  const durableBindings = review.durable_objects.bindings;
  invariant(durableBindings?.length === 3, "Review Worker must have exactly three Durable Object bindings");
  for (const binding of durableBindings) {
    exactKeys(binding, ["name", "class_name"], "Review Durable Object binding");
  }
  const durablePairs = durableBindings
    .map((binding) => `${binding.name}:${binding.class_name}`)
    .sort();
  invariant(
    JSON.stringify(durablePairs) ===
      JSON.stringify([
        "ENCODER_CONTAINER:EncoderContainer",
        "TRANSCRIPT_PREPARATION:TranscriptPreparation",
        "VideoClipAgent:VideoClipAgent",
      ]),
    "Review Durable Object bindings are not allowlisted",
  );

  process.stdout.write("Review configuration matches the isolated resource allowlist.\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
