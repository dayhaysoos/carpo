#!/usr/bin/env node
/**
 * Encoder contract test (seam 2).
 * Builds the real Docker image, generates a local fixture video, and asserts
 * trimmed MP4 + thumbnail artifacts are produced without network access.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const fixturesDir = path.join(root, "fixtures");
const outputDir = path.join(root, "test-output", "encoder-contract");
const imageName = "carpo-encoder:test";
const containerName = `carpo-encoder-contract-${Date.now()}`;

function ensureDockerHost() {
  if (process.env.DOCKER_HOST) {
    return;
  }

  const desktopSocket = path.join(
    os.homedir(),
    ".docker",
    "run",
    "docker.sock",
  );
  if (fs.existsSync(desktopSocket)) {
    process.env.DOCKER_HOST = `unix://${desktopSocket}`;
    const probe = spawnSync("docker", ["info"], {
      encoding: "utf-8",
      env: process.env,
    });
    if (probe.status !== 0) {
      delete process.env.DOCKER_HOST;
    }
  }
}

function run(command: string, args: string[], options: { cwd?: string } = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? "";
    const stdout = result.stdout?.trim() ?? "";
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}\n${stderr}\n${stdout}`,
    );
  }

  return result.stdout ?? "";
}

function assertDockerAvailable() {
  ensureDockerHost();
  const result = spawnSync("docker", ["info"], {
    encoding: "utf-8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      "Docker daemon is not reachable. Start Docker Desktop, then rerun npm run test:encoder",
    );
  }
}

function assertFfmpegAvailable() {
  const result = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error("ffmpeg is required to generate the fixture video");
  }
}

function ensureFixtureVideo() {
  fs.mkdirSync(fixturesDir, { recursive: true });
  const fixturePath = path.join(fixturesDir, "bars.mp4");
  const frameCounterPath = path.join(fixturesDir, "framecounter.mp4");

  if (!fs.existsSync(fixturePath)) {
    run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=10:size=320x240:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=10",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      fixturePath,
    ]);
  }

  if (!fs.existsSync(frameCounterPath)) {
    run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=10:size=320x240:rate=30",
      "-vf",
      "geq=r='mod(N\\,256)':g='0':b='0'",
      "-c:v",
      "libx264",
      "-g",
      "90",
      "-pix_fmt",
      "yuv420p",
      "-an",
      frameCounterPath,
    ]);
  }

  return { barsPath: fixturePath, frameCounterPath };
}

function buildImage() {
  run("docker", ["build", "-t", imageName, "./container"]);
}

function waitForHealth(port: number, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    const probe = spawnSync("curl", ["-fsS", `http://127.0.0.1:${port}/health`], {
      encoding: "utf-8",
    });
    if (probe.status === 0) {
      return;
    }
    spawnSync("sleep", ["1"]);
  }
  throw new Error("Encoder container did not become healthy");
}

function testNullMaxClipLengthValidation() {
  const script = `
import sys

sys.path.insert(0, ${JSON.stringify(path.join(root, "container"))})
from encoder import MAX_CLIP_LENGTH_SECONDS, resolve_max_clip_length, validate_job, process_job

assert resolve_max_clip_length(None) == float(MAX_CLIP_LENGTH_SECONDS)
assert resolve_max_clip_length("not-a-number") == float(MAX_CLIP_LENGTH_SECONDS)

valid_job = {
    "trimStart": 0,
    "trimEnd": 5,
    "maxClipLengthSeconds": None,
    "source": {"type": "youtube", "url": "https://example.com/watch?v=test"},
}
assert validate_job(valid_job) is None

failed_job = {
    "trimStart": 0,
    "trimEnd": 5,
    "maxClipLengthSeconds": None,
    "source": {"type": "youtube", "url": ""},
}
result = process_job(failed_job)
assert result["status"] == "failed"
assert isinstance(result.get("errorMessage"), str)

print("Null maxClipLengthSeconds validation test passed")
`;

  run("python3", ["-c", script]);
}

function testEncodeErrorClassification() {
  const script = `
import sys

sys.path.insert(0, ${JSON.stringify(path.join(root, "container"))})
from encoder import ENCODE_FAILURE_MESSAGE, classify_encode_error

assert classify_encode_error("Invalid data found when processing input") == ENCODE_FAILURE_MESSAGE
assert classify_encode_error("", timed_out=True) == ENCODE_FAILURE_MESSAGE

print("Encode error classification test passed")
`;

  run("python3", ["-c", script]);
}

function testYoutubeErrorClassification() {
  const stderrFixture = fs.readFileSync(
    path.join(fixturesDir, "ytdlp-403.stderr"),
    "utf-8",
  );

  const script = `
import sys

sys.path.insert(0, ${JSON.stringify(path.join(root, "container"))})
from encoder import (
    YOUTUBE_BLOCKED_MESSAGE,
    classify_ytdlp_error,
)

blocked = ${JSON.stringify(stderrFixture)}
assert classify_ytdlp_error(blocked) == YOUTUBE_BLOCKED_MESSAGE

assert classify_ytdlp_error("ERROR: Private video. Sign in if you've been granted access.") == (
    "This YouTube video is private. Try uploading the video file instead."
)
assert classify_ytdlp_error("ERROR: Video unavailable") == (
    "This YouTube video is unavailable. It may have been deleted or restricted."
)
assert classify_ytdlp_error("ERROR: Unsupported URL") == (
    "The URL is not a supported YouTube link."
)

stdout_only = "ERROR: unable to download video data: HTTP Error 403: Forbidden\\n"
assert classify_ytdlp_error(stdout_only) == YOUTUBE_BLOCKED_MESSAGE

print("YouTube error classification test passed")
`;

  run("python3", ["-c", script]);
}

function testSectionEncodeBounds() {
  const script = `
import sys
from pathlib import Path

sys.path.insert(0, ${JSON.stringify(path.join(root, "container"))})
from encoder import resolve_section_encode_bounds

start, end = resolve_section_encode_bounds(Path("source.mp4"), 7.5, 10.0, 4.5)
assert start == 3.0, start
assert end == 5.5, end

start, end = resolve_section_encode_bounds(Path("source.mp4"), 1.0, 4.0, 0.0)
assert start == 1.0, start
assert end == 4.0, end

try:
    resolve_section_encode_bounds(Path("source.mp4"), 7.5, 10.0, 11.0)
except RuntimeError as exc:
    assert "does not contain the requested trim range" in str(exc)
else:
    raise AssertionError("expected empty trim window to fail")

print("Section encode bounds test passed")
`;

  run("python3", ["-c", script]);
}

function testProcessGroupKill() {
  const script = `
import os
import subprocess
import sys
import time

sys.path.insert(0, "/app")
from encoder import _kill_process_group


def process_is_running(pid: int) -> bool:
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as handle:
            return handle.read().split()[2] != "Z"
    except OSError:
        return False

child_code = (
    "import subprocess, os, time; "
    "child = subprocess.Popen(['sleep', '600']); "
    "open(os.environ['MARKER'], 'w').write(str(child.pid)); "
    "time.sleep(600)"
)

marker_path = "/tmp/carpo-pg-child.pid"
env = dict(os.environ)
env["MARKER"] = marker_path

proc = subprocess.Popen(
    [sys.executable, "-c", child_code],
    start_new_session=True,
    env=env,
)
time.sleep(0.3)
_kill_process_group(proc.pid)
proc.wait(timeout=5)

with open(marker_path, encoding="utf-8") as handle:
    child_pid = int(handle.read().strip())
os.unlink(marker_path)

if process_is_running(child_pid):
    raise AssertionError("child process survived process-group kill")

print("Process group kill test passed")
`;

  run("docker", ["run", "--rm", imageName, "python3", "-c", script]);
}

function runEncoderYoutubeJob(
  containerName: string,
  encoderPort: number,
  jobPath: string,
  options: {
    fakeYtdlpPath: string;
    outputDir: string;
    frameCounterPath?: string;
    env?: Record<string, string>;
  },
) {
  fs.chmodSync(options.fakeYtdlpPath, 0o755);
  run("docker", ["rm", "-f", containerName]);
  const dockerArgs = [
    "run",
    "-d",
    "--name",
    containerName,
    "-p",
    `${encoderPort}:8080`,
    "-v",
    `${options.outputDir}:/output`,
    "-v",
    `${options.fakeYtdlpPath}:/usr/local/bin/yt-dlp:ro`,
  ];
  if (options.frameCounterPath) {
    dockerArgs.push(
      "-v",
      `${options.frameCounterPath}:/fixture/framecounter.mp4:ro`,
    );
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    dockerArgs.push("-e", `${key}=${value}`);
  }
  dockerArgs.push(imageName);
  run("docker", dockerArgs);
  waitForHealth(encoderPort);

  const startedAt = Date.now();
  const encode = spawnSync(
    "curl",
    [
      "-sS",
      "-X",
      "POST",
      `http://127.0.0.1:${encoderPort}/run`,
      "-H",
      "Content-Type: application/json",
      "-d",
      `@${jobPath}`,
    ],
    { encoding: "utf-8" },
  );
  const elapsedMs = Date.now() - startedAt;
  const logs = run("docker", ["logs", containerName]);

  if (encode.status !== 0) {
    throw new Error(
      `YouTube encoder /run request failed\n${encode.stderr}\ncontainer logs:\n${logs}`,
    );
  }

  return {
    elapsedMs,
    logs,
    result: JSON.parse(encode.stdout || "{}") as {
      status: string;
      errorMessage?: string;
    },
  };
}

function runEncoderYoutubeFailFastContract(frameCounterPath: string) {
  const blockedFixture = path.join(fixturesDir, "fake-ytdlp-403.sh");
  const blockedStdoutFixture = path.join(fixturesDir, "fake-ytdlp-403-stdout.sh");
  const stallFixture = path.join(fixturesDir, "fake-ytdlp-stall.sh");
  const stall403Fixture = path.join(fixturesDir, "fake-ytdlp-stall-403.sh");
  const slowProgressFixture = path.join(fixturesDir, "fake-ytdlp-slow-progress.sh");
  const silentMergeFixture = path.join(fixturesDir, "fake-ytdlp-silent-merge.sh");
  const sectionsFixture = path.join(fixturesDir, "fake-ytdlp-sections.sh");
  const sectionsLateStartFixture = path.join(
    fixturesDir,
    "fake-ytdlp-sections-late-start.sh",
  );

  const failFastOutputDir = path.join(outputDir, "youtube-fail-fast");
  fs.rmSync(failFastOutputDir, { recursive: true, force: true });
  fs.mkdirSync(failFastOutputDir, { recursive: true });

  const baseJob = {
    source: {
      type: "youtube",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    },
    trimStart: 0,
    trimEnd: 5,
    maxClipLengthSeconds: 60,
    outputs: {
      mp4Key: "blocked.mp4",
      thumbnailKey: "blocked.jpg",
    },
    localOutputDir: "/output",
  };

  const blockedJobPath = path.join(failFastOutputDir, "blocked-job.json");
  fs.writeFileSync(
    blockedJobPath,
    JSON.stringify({ ...baseJob, jobId: "youtube-fail-fast-403" }),
  );

  try {
    const blocked = runEncoderYoutubeJob(
      `${containerName}-youtube-403`,
      18085,
      blockedJobPath,
      {
        fakeYtdlpPath: blockedFixture,
        outputDir: failFastOutputDir,
      },
    );
    if (blocked.result.status !== "failed") {
      throw new Error(
        `Expected failed status for 403 fixture, got ${blocked.result.status}`,
      );
    }
    if (
      blocked.result.errorMessage !==
      "YouTube is blocking downloads from this server. Try uploading the video file instead."
    ) {
      throw new Error(
        `Unexpected 403 error message: ${blocked.result.errorMessage ?? "(missing)"}`,
      );
    }
    if (blocked.elapsedMs > 30_000) {
      throw new Error(
        `YouTube 403 fail-fast took too long (${blocked.elapsedMs}ms); expected under 30s`,
      );
    }
    if (
      !blocked.logs.includes("--retries") ||
      !blocked.logs.includes("--fragment-retries")
    ) {
      throw new Error("Encoder logs did not show aggressive yt-dlp retry flags");
    }
    console.log("Encoder YouTube 403 fail-fast contract test passed");
    console.log(`  Elapsed: ${blocked.elapsedMs}ms`);
    console.log(`  Message: ${blocked.result.errorMessage}`);
  } finally {
    run("docker", ["rm", "-f", `${containerName}-youtube-403`]);
  }

  const blockedStdoutJobPath = path.join(failFastOutputDir, "blocked-stdout-job.json");
  fs.writeFileSync(
    blockedStdoutJobPath,
    JSON.stringify({ ...baseJob, jobId: "youtube-fail-fast-403-stdout" }),
  );

  try {
    const blockedStdout = runEncoderYoutubeJob(
      `${containerName}-youtube-403-stdout`,
      18092,
      blockedStdoutJobPath,
      {
        fakeYtdlpPath: blockedStdoutFixture,
        outputDir: failFastOutputDir,
      },
    );
    if (blockedStdout.result.status !== "failed") {
      throw new Error(
        `Expected failed status for stdout-only 403 fixture, got ${blockedStdout.result.status}`,
      );
    }
    if (
      blockedStdout.result.errorMessage !==
      "YouTube is blocking downloads from this server. Try uploading the video file instead."
    ) {
      throw new Error(
        `Unexpected stdout-only 403 error message: ${blockedStdout.result.errorMessage ?? "(missing)"}`,
      );
    }
    console.log("Encoder YouTube stdout-only 403 classification contract test passed");
    console.log(`  Message: ${blockedStdout.result.errorMessage}`);
  } finally {
    run("docker", ["rm", "-f", `${containerName}-youtube-403-stdout`]);
  }

  const stallJobPath = path.join(failFastOutputDir, "stall-job.json");
  fs.writeFileSync(
    stallJobPath,
    JSON.stringify({ ...baseJob, jobId: "youtube-fail-fast-stall" }),
  );

  try {
    const stall = runEncoderYoutubeJob(
      `${containerName}-youtube-stall`,
      18086,
      stallJobPath,
      {
        fakeYtdlpPath: stallFixture,
        outputDir: failFastOutputDir,
        env: { YOUTUBE_STALL_TIMEOUT_SECONDS: "5" },
      },
    );
    if (stall.result.status !== "failed") {
      throw new Error(
        `Expected failed status for stall fixture, got ${stall.result.status}`,
      );
    }
    if (
      stall.result.errorMessage !==
      "YouTube appears to be blocking/stalling downloads from this server. Try uploading the video file instead."
    ) {
      throw new Error(
        `Unexpected stall error message: ${stall.result.errorMessage ?? "(missing)"}`,
      );
    }
    if (stall.elapsedMs < 4_000 || stall.elapsedMs > 20_000) {
      throw new Error(
        `Stall kill timing unexpected (${stall.elapsedMs}ms); expected roughly 5-15s`,
      );
    }
    console.log("Encoder YouTube stall-kill contract test passed");
    console.log(`  Elapsed: ${stall.elapsedMs}ms`);
    console.log(`  Message: ${stall.result.errorMessage}`);
  } finally {
    run("docker", ["rm", "-f", `${containerName}-youtube-stall`]);
  }

  const stall403JobPath = path.join(failFastOutputDir, "stall-403-job.json");
  fs.writeFileSync(
    stall403JobPath,
    JSON.stringify({ ...baseJob, jobId: "youtube-fail-fast-stall-403" }),
  );

  try {
    const stall403 = runEncoderYoutubeJob(
      `${containerName}-youtube-stall-403`,
      18090,
      stall403JobPath,
      {
        fakeYtdlpPath: stall403Fixture,
        outputDir: failFastOutputDir,
        env: { YOUTUBE_STALL_TIMEOUT_SECONDS: "5" },
      },
    );
    if (stall403.result.status !== "failed") {
      throw new Error(
        `Expected failed status for stall-403 fixture, got ${stall403.result.status}`,
      );
    }
    if (
      stall403.result.errorMessage !==
      "YouTube is blocking downloads from this server. Try uploading the video file instead."
    ) {
      throw new Error(
        `Expected 403 classification after stall kill, got ${stall403.result.errorMessage ?? "(missing)"}`,
      );
    }
    if (stall403.elapsedMs < 4_000 || stall403.elapsedMs > 20_000) {
      throw new Error(
        `Stall-403 kill timing unexpected (${stall403.elapsedMs}ms); expected roughly 5-15s`,
      );
    }
    console.log("Encoder YouTube stall-403 classification contract test passed");
    console.log(`  Elapsed: ${stall403.elapsedMs}ms`);
    console.log(`  Message: ${stall403.result.errorMessage}`);
  } finally {
    run("docker", ["rm", "-f", `${containerName}-youtube-stall-403`]);
  }

  const slowJobPath = path.join(failFastOutputDir, "slow-progress-job.json");
  fs.writeFileSync(
    slowJobPath,
    JSON.stringify({ ...baseJob, jobId: "youtube-slow-progress" }),
  );

  try {
    const slow = runEncoderYoutubeJob(
      `${containerName}-youtube-slow`,
      18087,
      slowJobPath,
      {
        fakeYtdlpPath: slowProgressFixture,
        outputDir: failFastOutputDir,
        frameCounterPath,
        env: { YOUTUBE_STALL_TIMEOUT_SECONDS: "5" },
      },
    );
    if (slow.result.status !== "complete") {
      throw new Error(
        `Expected complete status for slow-progress fixture, got ${slow.result.status}: ${slow.result.errorMessage ?? ""}`,
      );
    }
    if (slow.elapsedMs < 6_000) {
      throw new Error(
        `Slow-progress fixture finished too quickly (${slow.elapsedMs}ms); expected >6s of progress`,
      );
    }
    console.log("Encoder YouTube slow-progress contract test passed");
    console.log(`  Elapsed: ${slow.elapsedMs}ms`);
  } finally {
    run("docker", ["rm", "-f", `${containerName}-youtube-slow`]);
  }

  const silentMergeJobPath = path.join(failFastOutputDir, "silent-merge-job.json");
  fs.writeFileSync(
    silentMergeJobPath,
    JSON.stringify({ ...baseJob, jobId: "youtube-silent-merge" }),
  );

  try {
    const silentMerge = runEncoderYoutubeJob(
      `${containerName}-youtube-silent-merge`,
      18091,
      silentMergeJobPath,
      {
        fakeYtdlpPath: silentMergeFixture,
        outputDir: failFastOutputDir,
        frameCounterPath,
        env: { YOUTUBE_STALL_TIMEOUT_SECONDS: "5" },
      },
    );
    if (silentMerge.result.status !== "complete") {
      throw new Error(
        `Expected complete status for silent-merge fixture, got ${silentMerge.result.status}: ${silentMerge.result.errorMessage ?? ""}`,
      );
    }
    if (silentMerge.elapsedMs < 10_000) {
      throw new Error(
        `Silent-merge fixture finished too quickly (${silentMerge.elapsedMs}ms); expected >10s silent post-download phase`,
      );
    }
    console.log("Encoder YouTube silent-merge contract test passed");
    console.log(`  Elapsed: ${silentMerge.elapsedMs}ms`);
  } finally {
    run("docker", ["rm", "-f", `${containerName}-youtube-silent-merge`]);
  }

  const trimStart = 7.5;
  const trimEnd = 10;
  const sectionsOutputDir = path.join(outputDir, "youtube-sections");
  fs.rmSync(sectionsOutputDir, { recursive: true, force: true });
  fs.mkdirSync(sectionsOutputDir, { recursive: true });
  const sectionsJobPath = path.join(sectionsOutputDir, "sections-job.json");
  fs.writeFileSync(
    sectionsJobPath,
    JSON.stringify({
      jobId: "youtube-sections-trim",
      source: {
        type: "youtube",
        url: "https://www.youtube.com/watch?v=section-test",
      },
      trimStart,
      trimEnd,
      maxClipLengthSeconds: 60,
      outputs: {
        mp4Key: "sections.mp4",
        thumbnailKey: "sections.jpg",
      },
      localOutputDir: "/output",
    }),
  );

  try {
    const sections = runEncoderYoutubeJob(
      `${containerName}-youtube-sections`,
      18088,
      sectionsJobPath,
      {
        fakeYtdlpPath: sectionsFixture,
        outputDir: sectionsOutputDir,
        frameCounterPath,
      },
    );
    if (sections.result.status !== "complete") {
      throw new Error(
        `Expected complete status for sections fixture, got ${sections.result.status}: ${sections.result.errorMessage ?? ""}`,
      );
    }
    if (!sections.logs.includes("--download-sections")) {
      throw new Error("Encoder logs did not show --download-sections");
    }
    if (!sections.logs.includes("--force-keyframes-at-cuts")) {
      throw new Error("Encoder logs did not show --force-keyframes-at-cuts");
    }
    if (
      !sections.logs.includes("-S") ||
      !sections.logs.includes("res:1080") ||
      !sections.logs.includes("+codec:h264")
    ) {
      throw new Error("Encoder logs did not show yt-dlp format sort flags");
    }
    if (
      !sections.logs.includes("bestvideo[height<=1080][vcodec^=avc1]+bestaudio")
    ) {
      throw new Error("Encoder logs did not show yt-dlp h264 format selector");
    }
    const sectionMatch = sections.logs.match(
      /--download-sections \*([0-9.]+)-([0-9.]+)/,
    );
    if (!sectionMatch) {
      throw new Error("Encoder logs did not show --download-sections bounds");
    }
    const sectionStart = Number.parseFloat(sectionMatch[1]);
    const sectionEnd = Number.parseFloat(sectionMatch[2]);
    if (sectionStart !== trimStart - 3 || sectionEnd !== trimEnd + 3) {
      throw new Error(
        `Unexpected section bounds ${sectionStart}-${sectionEnd}; expected ${trimStart - 3}-${trimEnd + 3}`,
      );
    }

    const mp4Path = path.join(sectionsOutputDir, "sections.mp4");
    const thumbPath = path.join(sectionsOutputDir, "sections.jpg");
    if (!fs.existsSync(mp4Path) || !fs.existsSync(thumbPath)) {
      throw new Error("Expected sections trim artifacts on host output dir");
    }
    assertTrimFrameAccuracy(frameCounterPath, mp4Path, thumbPath, trimStart);

    console.log("Encoder YouTube sections trim contract test passed");
  } finally {
    run("docker", ["rm", "-f", `${containerName}-youtube-sections`]);
  }

  const lateStartOutputDir = path.join(outputDir, "youtube-sections-zero-start");
  fs.rmSync(lateStartOutputDir, { recursive: true, force: true });
  fs.mkdirSync(lateStartOutputDir, { recursive: true });
  const zeroTrimStart = 1;
  const zeroTrimEnd = 4;
  const lateStartJobPath = path.join(lateStartOutputDir, "zero-start-job.json");
  fs.writeFileSync(
    lateStartJobPath,
    JSON.stringify({
      jobId: "youtube-sections-zero-start",
      source: {
        type: "youtube",
        url: "https://www.youtube.com/watch?v=section-zero-start",
      },
      trimStart: zeroTrimStart,
      trimEnd: zeroTrimEnd,
      maxClipLengthSeconds: 60,
      outputs: {
        mp4Key: "zero-start.mp4",
        thumbnailKey: "zero-start.jpg",
      },
      localOutputDir: "/output",
    }),
  );

  try {
    const lateStart = runEncoderYoutubeJob(
      `${containerName}-youtube-sections-zero`,
      18094,
      lateStartJobPath,
      {
        fakeYtdlpPath: sectionsLateStartFixture,
        outputDir: lateStartOutputDir,
        frameCounterPath,
      },
    );
    if (lateStart.result.status !== "complete") {
      throw new Error(
        `Expected complete status for zero-start sections fixture, got ${lateStart.result.status}: ${lateStart.result.errorMessage ?? ""}`,
      );
    }
    if (!lateStart.logs.includes("--force-keyframes-at-cuts")) {
      throw new Error("Encoder logs did not show --force-keyframes-at-cuts");
    }
    if (lateStart.logs.includes("-ss -")) {
      throw new Error("Encoder logs contained a negative ffmpeg -ss offset");
    }
    const mp4Path = path.join(lateStartOutputDir, "zero-start.mp4");
    const thumbPath = path.join(lateStartOutputDir, "zero-start.jpg");
    if (!fs.existsSync(mp4Path) || !fs.existsSync(thumbPath)) {
      throw new Error("Expected zero-start sections trim artifacts on host output dir");
    }
    const probe = run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      mp4Path,
    ]);
    const duration = Number.parseFloat(probe.trim());
    const expectedDuration = zeroTrimEnd - zeroTrimStart;
    if (
      !Number.isFinite(duration) ||
      duration < expectedDuration - 0.5 ||
      duration > expectedDuration + 0.5
    ) {
      throw new Error(
        `Zero-start sections clip duration ${probe.trim()}s; expected ~${expectedDuration}s`,
      );
    }
    assertTrimFrameAccuracy(
      frameCounterPath,
      mp4Path,
      thumbPath,
      zeroTrimStart,
    );
    console.log("Encoder YouTube zero-start sections contract test passed");
    console.log(`  Duration: ${duration.toFixed(2)}s (expected ${expectedDuration}s)`);
  } finally {
    run("docker", ["rm", "-f", `${containerName}-youtube-sections-zero`]);
  }
}

function runEncoderEncodeFailureContract() {
  const encodeFailureDir = path.join(outputDir, "encode-failure");
  fs.rmSync(encodeFailureDir, { recursive: true, force: true });
  fs.mkdirSync(encodeFailureDir, { recursive: true });

  const corruptPath = path.join(encodeFailureDir, "corrupt.mp4");
  fs.writeFileSync(corruptPath, "not-a-valid-mp4");

  const job = {
    jobId: "encode-failure-contract",
    source: {
      type: "file",
      path: "/fixture/corrupt.mp4",
    },
    trimStart: 0,
    trimEnd: 2,
    maxClipLengthSeconds: 60,
    outputs: {
      mp4Key: "failed.mp4",
      thumbnailKey: "failed.jpg",
    },
    localOutputDir: "/output",
  };
  const jobPath = path.join(encodeFailureDir, "job.json");
  fs.writeFileSync(jobPath, JSON.stringify(job));

  const encodeFailureContainer = `${containerName}-encode-failure`;
  run("docker", ["rm", "-f", encodeFailureContainer]);
  run("docker", [
    "run",
    "-d",
    "--name",
    encodeFailureContainer,
    "-p",
    "18089:8080",
    "-v",
    `${corruptPath}:/fixture/corrupt.mp4:ro`,
    "-v",
    `${encodeFailureDir}:/output`,
    imageName,
  ]);

  try {
    waitForHealth(18089);

    const encode = spawnSync(
      "curl",
      [
        "-sS",
        "-X",
        "POST",
        "http://127.0.0.1:18089/run",
        "-H",
        "Content-Type: application/json",
        "-d",
        `@${jobPath}`,
      ],
      { encoding: "utf-8" },
    );

    const logs = run("docker", ["logs", encodeFailureContainer]);
    const result = JSON.parse(encode.stdout || "{}") as {
      status: string;
      errorMessage?: string;
    };

    if (result.status !== "failed") {
      throw new Error(
        `Expected failed status for corrupt source, got ${result.status}`,
      );
    }
    const expectedMessage =
      "Encoding failed for this video format. Try a shorter clip or upload the file instead.";
    if (result.errorMessage !== expectedMessage) {
      throw new Error(
        `Unexpected encode failure message: ${result.errorMessage ?? "(missing)"}`,
      );
    }
    if (!logs.includes("ffmpeg stderr:")) {
      throw new Error("Encoder logs did not retain detailed ffmpeg stderr");
    }

    console.log("Encoder encode-failure contract test passed");
    console.log(`  Message: ${result.errorMessage}`);
  } finally {
    run("docker", ["rm", "-f", encodeFailureContainer]);
  }
}

function testSourceFileSelection() {
  const selectionDir = path.join(outputDir, "source-selection");
  fs.rmSync(selectionDir, { recursive: true, force: true });
  fs.mkdirSync(selectionDir, { recursive: true });

  const script = `
import sys
from pathlib import Path

sys.path.insert(0, ${JSON.stringify(path.join(root, "container"))})
from encoder import select_source_file

work = Path(${JSON.stringify(selectionDir)})

(work / "source.m4a").write_bytes(b"audio-only")
(work / "source.webm").write_bytes(b"webm-video")
(work / "source.mkv").write_bytes(b"mkv-video")

picked = select_source_file(list(work.glob("source.*")))
assert picked.suffix == ".mkv", picked

work2 = work / "mp4-priority"
work2.mkdir()
(work2 / "source.m4a").write_bytes(b"audio-only")
(work2 / "source.mp4").write_bytes(b"mp4-video")

picked_mp4 = select_source_file(list(work2.glob("source.*")))
assert picked_mp4.suffix == ".mp4", picked_mp4

audio_only = work / "audio-only"
audio_only.mkdir()
(audio_only / "source.m4a").write_bytes(b"audio-only")

try:
    select_source_file(list(audio_only.glob("source.*")))
except RuntimeError as exc:
    assert "no video container" in str(exc)
else:
    raise SystemExit("expected RuntimeError for audio-only candidates")

print("Source file selection test passed")
`;

  run("python3", ["-c", script]);
}

function readTopLeftRedByte(videoPath: string, frame = 0) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      videoPath,
      "-vf",
      `select=eq(n\\,${frame})`,
      "-vframes",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { encoding: "buffer" },
  );

  if (result.status !== 0 || !result.stdout || result.stdout.length < 1) {
    throw new Error(
      `Failed to read frame ${frame} from ${videoPath}\n${result.stderr?.toString() ?? ""}`,
    );
  }

  return result.stdout[0];
}

function readTopLeftRedByteFromImage(imagePath: string) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      imagePath,
      "-vframes",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { encoding: "buffer" },
  );

  if (result.status !== 0 || !result.stdout || result.stdout.length < 1) {
    throw new Error(
      `Failed to read image ${imagePath}\n${result.stderr?.toString() ?? ""}`,
    );
  }

  return result.stdout[0];
}

function expectedFrameMarkerValues(trimStart: number, fps = 30) {
  const center = Math.round(trimStart * fps);
  return [
    (center - 1) % 256,
    center % 256,
    (center + 1) % 256,
  ];
}

function assertTrimFrameAccuracy(
  sourcePath: string,
  mp4Path: string,
  thumbPath: string,
  trimStart: number,
) {
  const allowed = expectedFrameMarkerValues(trimStart);
  const outputFrame = readTopLeftRedByte(mp4Path, 0);
  const thumbFrame = readTopLeftRedByteFromImage(thumbPath);

  if (!allowed.includes(outputFrame)) {
    throw new Error(
      `Trimmed MP4 first frame marker ${outputFrame} not within ±1 frame of trimStart ${trimStart} (allowed ${allowed.join(", ")})`,
    );
  }
  if (!allowed.includes(thumbFrame)) {
    throw new Error(
      `Thumbnail frame marker ${thumbFrame} not within ±1 frame of trimStart ${trimStart} (allowed ${allowed.join(", ")})`,
    );
  }

  const keyframeFrame = readTopLeftRedByte(sourcePath, 0);
  if (outputFrame === keyframeFrame && !allowed.includes(keyframeFrame)) {
    throw new Error(
      "Trimmed MP4 appears to start at the source keyframe instead of trimStart",
    );
  }

  console.log(
    `  Trim accuracy: mp4=${outputFrame}, thumbnail=${thumbFrame} (allowed ${allowed.join(", ")})`,
  );
}

function readFrameRgbBuffer(videoPath: string, frame = 0) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      videoPath,
      "-vf",
      `select=eq(n\\,${frame})`,
      "-vframes",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { encoding: "buffer" },
  );

  if (result.status !== 0 || !result.stdout || result.stdout.length < 1) {
    throw new Error(
      `Failed to read frame ${frame} from ${videoPath}\n${result.stderr?.toString() ?? ""}`,
    );
  }

  return result.stdout;
}

function countPixelDifferences(left: Buffer, right: Buffer) {
  if (left.length !== right.length) {
    throw new Error("Frame buffers differ in size");
  }

  let differences = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      differences += 1;
    }
  }
  return differences;
}

function runEncoderCaptionContract(fixturePath: string, frameCounterPath: string) {
  const captionOutputDir = path.join(outputDir, "caption-contract");
  fs.rmSync(captionOutputDir, { recursive: true, force: true });
  fs.mkdirSync(captionOutputDir, { recursive: true });

  const trimStart = 2.5;
  const trimEnd = 5;
  const captionText = "It's 50% off: now!";
  const baselineJob = {
    jobId: "caption-baseline",
    source: {
      type: "file",
      path: "/fixture/framecounter.mp4",
    },
    trimStart,
    trimEnd,
    caption: null,
    filters: [],
    maxClipLengthSeconds: 60,
    outputs: {
      mp4Key: "baseline.mp4",
      thumbnailKey: "baseline.jpg",
    },
    localOutputDir: "/output",
  };
  const captionedJob = {
    ...baselineJob,
    jobId: "caption-overlay",
    filters: [{ type: "caption", text: captionText }],
    outputs: {
      mp4Key: "captioned.mp4",
      thumbnailKey: "captioned.jpg",
    },
  };
  const baselinePath = path.join(captionOutputDir, "baseline-job.json");
  const captionedPath = path.join(captionOutputDir, "captioned-job.json");
  fs.writeFileSync(baselinePath, JSON.stringify(baselineJob));
  fs.writeFileSync(captionedPath, JSON.stringify(captionedJob));

  const captionContainer = `${containerName}-caption`;
  run("docker", ["rm", "-f", captionContainer]);
  run("docker", [
    "run",
    "-d",
    "--name",
    captionContainer,
    "-p",
    "18081:8080",
    "-v",
    `${fixturePath}:/fixture/bars.mp4:ro`,
    "-v",
    `${frameCounterPath}:/fixture/framecounter.mp4:ro`,
    "-v",
    `${captionOutputDir}:/output`,
    imageName,
  ]);

  try {
    waitForHealth(18081);

    for (const [label, jobFile] of [
      ["baseline", baselinePath],
      ["captioned", captionedPath],
    ] as const) {
      const encode = spawnSync(
        "curl",
        [
          "-fsS",
          "-X",
          "POST",
          "http://127.0.0.1:18081/run",
          "-H",
          "Content-Type: application/json",
          "-d",
          `@${jobFile}`,
        ],
        { encoding: "utf-8" },
      );

      if (encode.status !== 0) {
        const logs = run("docker", ["logs", captionContainer]);
        throw new Error(
          `${label} encoder /run failed\n${encode.stderr}\ncontainer logs:\n${logs}`,
        );
      }

      const result = JSON.parse(encode.stdout) as {
        status: string;
        errorMessage?: string;
      };
      if (result.status !== "complete") {
        throw new Error(
          `${label} encoder returned failure: ${result.errorMessage ?? "unknown error"}`,
        );
      }
    }

    const baselineMp4 = path.join(captionOutputDir, "baseline.mp4");
    const captionedMp4 = path.join(captionOutputDir, "captioned.mp4");
    const captionedThumb = path.join(captionOutputDir, "captioned.jpg");
    if (!fs.existsSync(baselineMp4) || !fs.existsSync(captionedMp4)) {
      throw new Error("Expected baseline and captioned MP4 artifacts");
    }
    if (!fs.existsSync(captionedThumb)) {
      throw new Error("Expected captioned thumbnail artifact");
    }

    const baselineFrame = readFrameRgbBuffer(baselineMp4, 0);
    const captionedFrame = readFrameRgbBuffer(captionedMp4, 0);
    const pixelDifferences = countPixelDifferences(baselineFrame, captionedFrame);
    if (pixelDifferences < 100) {
      throw new Error(
        `Caption overlay did not visibly change the output frame (${pixelDifferences} differing bytes)`,
      );
    }

    const captionedLog = run("docker", ["logs", captionContainer]);
    if (!captionedLog.includes("drawtext")) {
      throw new Error("Encoder logs did not show drawtext filter invocation");
    }

    console.log("Encoder caption contract test passed");
    console.log(`  Caption: ${captionText}`);
    console.log(`  Frame differences: ${pixelDifferences} bytes`);
  } finally {
    run("docker", ["rm", "-f", captionContainer]);
  }
}

function runEncoderContract(fixturePath: string, frameCounterPath: string) {
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const trimStart = 2.5;
  const trimEnd = 5;
  const job = {
    jobId: "contract-test",
    source: {
      type: "file",
      path: "/fixture/framecounter.mp4",
    },
    trimStart,
    trimEnd,
    caption: null,
    filters: [],
    maxClipLengthSeconds: 60,
    outputs: {
      mp4Key: "clip.mp4",
      thumbnailKey: "thumbnail.jpg",
    },
    localOutputDir: "/output",
  };

  const jobPath = path.join(outputDir, "job.json");
  fs.writeFileSync(jobPath, JSON.stringify(job));

  run("docker", ["rm", "-f", containerName]);
  run("docker", [
    "run",
    "-d",
    "--name",
    containerName,
    "-p",
    "18080:8080",
    "-v",
    `${fixturePath}:/fixture/bars.mp4:ro`,
    "-v",
    `${frameCounterPath}:/fixture/framecounter.mp4:ro`,
    "-v",
    `${outputDir}:/output`,
    imageName,
  ]);

  try {
    waitForHealth(18080);

    const encode = spawnSync(
      "curl",
      [
        "-fsS",
        "-X",
        "POST",
        "http://127.0.0.1:18080/run",
        "-H",
        "Content-Type: application/json",
        "-d",
        `@${jobPath}`,
      ],
      { encoding: "utf-8" },
    );

    if (encode.status !== 0) {
      const logs = run("docker", ["logs", containerName]);
      throw new Error(
        `Encoder /run failed\n${encode.stderr}\ncontainer logs:\n${logs}`,
      );
    }

    const result = JSON.parse(encode.stdout) as {
      status: string;
      errorMessage?: string;
      outputs?: {
        mp4Key: string;
        thumbnailKey: string;
      };
    };
    if (result.status !== "complete") {
      throw new Error(
        `Encoder returned failure: ${result.errorMessage ?? "unknown error"}`,
      );
    }
    if (!result.outputs?.mp4Key || !result.outputs?.thumbnailKey) {
      throw new Error("Encoder /run response missing artifact keys");
    }

    const mp4Path = path.join(outputDir, "clip.mp4");
    const thumbPath = path.join(outputDir, "thumbnail.jpg");

    if (!fs.existsSync(mp4Path)) {
      throw new Error(`Expected MP4 artifact at ${mp4Path}`);
    }
    if (!fs.existsSync(thumbPath)) {
      throw new Error(`Expected thumbnail artifact at ${thumbPath}`);
    }

    const mp4Size = fs.statSync(mp4Path).size;
    const thumbSize = fs.statSync(thumbPath).size;
    if (mp4Size < 1000) {
      throw new Error(`MP4 artifact looks too small (${mp4Size} bytes)`);
    }
    if (thumbSize < 100) {
      throw new Error(`Thumbnail artifact looks too small (${thumbSize} bytes)`);
    }

    const probe = run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      mp4Path,
    ]);
    const duration = Number.parseFloat(probe.trim());
    const expectedDuration = trimEnd - trimStart;
    if (
      !Number.isFinite(duration) ||
      duration < expectedDuration - 0.5 ||
      duration > expectedDuration + 0.5
    ) {
      throw new Error(`Unexpected trimmed duration: ${probe.trim()}`);
    }

    assertTrimFrameAccuracy(
      frameCounterPath,
      mp4Path,
      thumbPath,
      trimStart,
    );

    console.log("Encoder contract test passed");
    console.log(`  MP4: ${mp4Path} (${mp4Size} bytes, ${duration.toFixed(2)}s)`);
    console.log(`  Thumbnail: ${thumbPath} (${thumbSize} bytes)`);
  } finally {
    run("docker", ["rm", "-f", containerName]);
  }
}

function runEncoderUploadContract(frameCounterPath: string) {
  const uploadOutputDir = path.join(outputDir, "upload-contract");
  fs.rmSync(uploadOutputDir, { recursive: true, force: true });
  fs.mkdirSync(uploadOutputDir, { recursive: true });

  const trimStart = 2.5;
  const trimEnd = 5;
  const callbackSecret = "upload-contract-secret";
  const encoderPort = 18083;
  const networkName = `carpo-upload-${Date.now()}`;
  const fixtureServerName = `${containerName}-fixture-server`;
  const uploadContainer = `${containerName}-upload`;
  const fixtureServerScript = `
from http.server import BaseHTTPRequestHandler, HTTPServer
import os

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get("X-Carpo-Job-Secret") != os.environ["SECRET"]:
            self.send_response(401)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.end_headers()
        with open("/source.mp4", "rb") as handle:
            self.wfile.write(handle.read())

    def log_message(self, format, *args):
        return

HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
`.trim();

  run("docker", ["network", "create", networkName]);
  run("docker", ["rm", "-f", fixtureServerName]);
  run("docker", [
    "run",
    "-d",
    "--name",
    fixtureServerName,
    "--network",
    networkName,
    "-e",
    `SECRET=${callbackSecret}`,
    "-v",
    `${frameCounterPath}:/source.mp4:ro`,
    "python:3.12-slim",
    "python",
    "-c",
    fixtureServerScript,
  ]);

  const job = {
    jobId: "upload-contract-test",
    source: {
      type: "upload",
      key: "uploads/contract-fixture.mp4",
    },
    sourceFetchUrl: `http://${fixtureServerName}:8080/source`,
    trimStart,
    trimEnd,
    caption: null,
    filters: [],
    maxClipLengthSeconds: 60,
    callbackSecret,
    outputs: {
      mp4Key: "upload-clip.mp4",
      thumbnailKey: "upload-thumbnail.jpg",
    },
    localOutputDir: "/output",
  };

  const jobPath = path.join(uploadOutputDir, "upload-job.json");
  fs.writeFileSync(jobPath, JSON.stringify(job));

  run("docker", ["rm", "-f", uploadContainer]);
  run("docker", [
    "run",
    "-d",
    "--name",
    uploadContainer,
    "--network",
    networkName,
    "-p",
    `${encoderPort}:8080`,
    "-v",
    `${uploadOutputDir}:/output`,
    imageName,
  ]);

  try {
    waitForHealth(encoderPort);

    const encode = spawnSync(
      "curl",
      [
        "-sS",
        "-X",
        "POST",
        "http://127.0.0.1:18083/run",
        "-H",
        "Content-Type: application/json",
        "-d",
        `@${jobPath}`,
      ],
      { encoding: "utf-8" },
    );

    const result = JSON.parse(encode.stdout || "{}") as {
      status: string;
      errorMessage?: string;
    };
    if (encode.status !== 0) {
      const logs = run("docker", ["logs", uploadContainer]);
      throw new Error(
        `Upload-source encoder /run request failed\n${encode.stderr}\ncontainer logs:\n${logs}`,
      );
    }
    if (result.status !== "complete") {
      const logs = run("docker", ["logs", uploadContainer]);
      throw new Error(
        `Upload-source encoder returned failure: ${result.errorMessage ?? encode.stdout ?? "unknown error"}\ncontainer logs:\n${logs}`,
      );
    }

    const mp4Path = path.join(uploadOutputDir, "upload-clip.mp4");
    const thumbPath = path.join(uploadOutputDir, "upload-thumbnail.jpg");
    if (!fs.existsSync(mp4Path) || !fs.existsSync(thumbPath)) {
      throw new Error("Expected upload-source MP4 and thumbnail artifacts");
    }

    const mp4Size = fs.statSync(mp4Path).size;
    const thumbSize = fs.statSync(thumbPath).size;
    if (mp4Size < 1000 || thumbSize < 100) {
      throw new Error("Upload-source artifacts look too small");
    }

    assertTrimFrameAccuracy(frameCounterPath, mp4Path, thumbPath, trimStart);

    const logs = run("docker", ["logs", uploadContainer]);
    if (logs.includes("yt-dlp")) {
      throw new Error("Upload-source job should not invoke yt-dlp");
    }

    console.log("Encoder upload-source contract test passed");
    console.log(`  MP4: ${mp4Path} (${mp4Size} bytes)`);
    console.log(`  Thumbnail: ${thumbPath} (${thumbSize} bytes)`);
  } finally {
    run("docker", ["rm", "-f", uploadContainer]);
    run("docker", ["rm", "-f", fixtureServerName]);
    run("docker", ["network", "rm", networkName]);
  }
}

function runStageSourceContract(frameCounterPath: string) {
  fs.mkdirSync(outputDir, { recursive: true });
  const encoderPort = 18084;
  const stageContainer = `${containerName}-stage-source`;

  run("docker", ["rm", "-f", stageContainer]);
  run("docker", [
    "run",
    "-d",
    "--name",
    stageContainer,
    "-p",
    `${encoderPort}:8080`,
    imageName,
  ]);

  try {
    waitForHealth(encoderPort);

    const missingLength = spawnSync(
      "python3",
      [
        "-c",
        `import http.client
conn = http.client.HTTPConnection("127.0.0.1", ${encoderPort})
conn.request(
    "POST",
    "/stage-source",
    body=b"0\\r\\n\\r\\n",
    headers={
        "Content-Type": "video/mp4",
        "Transfer-Encoding": "chunked",
    },
)
print(conn.getresponse().status)`,
      ],
      { encoding: "utf-8" },
    );
    if (missingLength.stdout?.trim() !== "411") {
      throw new Error(
        `Expected 411 for /stage-source without Content-Length, got ${missingLength.stdout}`,
      );
    }

    const sourceBytes = fs.readFileSync(frameCounterPath);
    const stagedPath = path.join(outputDir, "staged-upload-source.mp4");
    fs.writeFileSync(stagedPath, sourceBytes);

    const staged = spawnSync(
      "curl",
      [
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "-X",
        "POST",
        `http://127.0.0.1:${encoderPort}/stage-source`,
        "-H",
        `Content-Length: ${sourceBytes.length}`,
        "-H",
        "Content-Type: video/mp4",
        "--data-binary",
        `@${stagedPath}`,
      ],
      { encoding: "utf-8" },
    );
    if (staged.stdout?.trim() !== "204") {
      throw new Error(
        `Expected 204 for /stage-source with Content-Length, got ${staged.stdout}`,
      );
    }

    const inspectScript = `
import sys
from pathlib import Path

sys.path.insert(0, ${JSON.stringify(path.join(root, "container"))})
from encoder import STAGED_UPLOAD_PATH

staged = Path(STAGED_UPLOAD_PATH)
assert staged.exists(), "staged upload source missing"
assert staged.stat().st_size == ${sourceBytes.length}, staged.stat().st_size
print("Staged upload source size matches Content-Length")
`;
    run("docker", [
      "exec",
      stageContainer,
      "python3",
      "-c",
      inspectScript,
    ]);

    console.log("Encoder stage-source contract test passed");
    console.log(`  Staged bytes: ${sourceBytes.length}`);

    const declaredLength = 1024;
    const truncatedLength = 512;
    const truncated = spawnSync(
      "python3",
      [
        "-c",
        `import socket

declared = ${declaredLength}
actual = ${truncatedLength}
body = b"x" * actual
request = (
    f"POST /stage-source HTTP/1.1\\r\\n"
    f"Host: 127.0.0.1:${encoderPort}\\r\\n"
    f"Content-Type: video/mp4\\r\\n"
    f"Content-Length: {declared}\\r\\n"
    f"Connection: close\\r\\n"
    f"\\r\\n"
).encode() + body

with socket.create_connection(("127.0.0.1", ${encoderPort}), timeout=10) as sock:
    sock.sendall(request)
    sock.shutdown(socket.SHUT_WR)
    response = b""
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            break
        response += chunk

status = response.split(b"\\r\\n", 1)[0].split(b" ", 2)[1].decode()
print(status)`,
      ],
      { encoding: "utf-8" },
    );
    if (truncated.stdout?.trim() !== "400") {
      throw new Error(
        `Expected 400 for truncated /stage-source body, got ${truncated.stdout?.trim() || "(empty)"} stderr=${truncated.stderr?.trim() || "(none)"}`,
      );
    }

    const missingStagedScript = `
import sys
from pathlib import Path

sys.path.insert(0, ${JSON.stringify(path.join(root, "container"))})
from encoder import STAGED_UPLOAD_PATH

staged = Path(STAGED_UPLOAD_PATH)
assert not staged.exists(), "truncated upload should not leave staged file"
print("Truncated upload left no staged file")
`;
    run("docker", [
      "exec",
      stageContainer,
      "python3",
      "-c",
      missingStagedScript,
    ]);

    console.log("Encoder stage-source truncated-body contract test passed");
    console.log(`  Declared: ${declaredLength}, sent: ${truncatedLength}`);
  } finally {
    run("docker", ["rm", "-f", stageContainer]);
  }
}

function runEncoderGifContract(fixturePath: string) {
  const gifOutputDir = path.join(outputDir, "gif-contract");
  fs.rmSync(gifOutputDir, { recursive: true, force: true });
  fs.mkdirSync(gifOutputDir, { recursive: true });

  const mp4Job = {
    jobId: "gif-contract-mp4",
    source: {
      type: "file",
      path: "/fixture/bars.mp4",
    },
    trimStart: 1,
    trimEnd: 4,
    caption: null,
    filters: [],
    maxClipLengthSeconds: 60,
    outputs: {
      mp4Key: "gif-source.mp4",
      thumbnailKey: "gif-source.jpg",
    },
    localOutputDir: "/output",
  };
  const mp4JobPath = path.join(gifOutputDir, "mp4-job.json");
  fs.writeFileSync(mp4JobPath, JSON.stringify(mp4Job));

  const gifContainer = `${containerName}-gif`;
  run("docker", ["rm", "-f", gifContainer]);
  run("docker", [
    "run",
    "-d",
    "--name",
    gifContainer,
    "-p",
    "18082:8080",
    "-v",
    `${fixturePath}:/fixture/bars.mp4:ro`,
    "-v",
    `${gifOutputDir}:/output`,
    imageName,
  ]);

  try {
    waitForHealth(18082);

    const mp4Encode = spawnSync(
      "curl",
      [
        "-fsS",
        "-X",
        "POST",
        "http://127.0.0.1:18082/run",
        "-H",
        "Content-Type: application/json",
        "-d",
        `@${mp4JobPath}`,
      ],
      { encoding: "utf-8" },
    );
    if (mp4Encode.status !== 0) {
      const logs = run("docker", ["logs", gifContainer]);
      throw new Error(
        `MP4 setup for GIF contract failed\n${mp4Encode.stderr}\ncontainer logs:\n${logs}`,
      );
    }

    const mp4Result = JSON.parse(mp4Encode.stdout) as { status: string };
    if (mp4Result.status !== "complete") {
      throw new Error("MP4 setup job did not complete");
    }

    const sourceMp4 = path.join(gifOutputDir, "gif-source.mp4");
    if (!fs.existsSync(sourceMp4)) {
      throw new Error(`Expected source MP4 at ${sourceMp4}`);
    }

    const gifJob = {
      jobId: "gif-contract",
      jobType: "gif",
      sourceMp4Key: "clips/gif-contract/clip.mp4",
      source: {
        type: "file",
        path: "/fixture/gif-source.mp4",
      },
      outputs: {
        gifKey: "clip.gif",
      },
      localOutputDir: "/output",
    };
    const gifJobPath = path.join(gifOutputDir, "gif-job.json");
    fs.writeFileSync(gifJobPath, JSON.stringify(gifJob));

    run("docker", [
      "exec",
      gifContainer,
      "cp",
      "/output/gif-source.mp4",
      "/fixture/gif-source.mp4",
    ]);

    const gifEncode = spawnSync(
      "curl",
      [
        "-fsS",
        "-X",
        "POST",
        "http://127.0.0.1:18082/run",
        "-H",
        "Content-Type: application/json",
        "-d",
        `@${gifJobPath}`,
      ],
      { encoding: "utf-8" },
    );
    if (gifEncode.status !== 0) {
      const logs = run("docker", ["logs", gifContainer]);
      throw new Error(
        `GIF encoder /run failed\n${gifEncode.stderr}\ncontainer logs:\n${logs}`,
      );
    }

    const gifResult = JSON.parse(gifEncode.stdout) as {
      status: string;
      errorMessage?: string;
    };
    if (gifResult.status !== "complete") {
      throw new Error(
        `GIF encoder returned failure: ${gifResult.errorMessage ?? "unknown error"}`,
      );
    }

    const gifPath = path.join(gifOutputDir, "clip.gif");
    if (!fs.existsSync(gifPath)) {
      throw new Error(`Expected GIF artifact at ${gifPath}`);
    }

    const gifBytes = fs.readFileSync(gifPath);
    const gifHeader = gifBytes.subarray(0, 6).toString("ascii");
    if (gifHeader !== "GIF89a" && gifHeader !== "GIF87a") {
      throw new Error(`Output is not a GIF file (header: ${gifHeader})`);
    }

    const gifSize = gifBytes.length;
    if (gifSize < 500) {
      throw new Error(`GIF artifact looks too small (${gifSize} bytes)`);
    }

    const logs = run("docker", ["logs", gifContainer]);
    if (!logs.includes("palettegen") || !logs.includes("paletteuse")) {
      throw new Error(
        "Encoder logs did not show palettegen + paletteuse two-pass GIF encode",
      );
    }

    const loopProbe = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        gifPath,
      ],
      { encoding: "utf-8" },
    );
    if (loopProbe.status !== 0) {
      throw new Error(`ffprobe failed on GIF output\n${loopProbe.stderr}`);
    }

    const netscapeLoop = gifBytes.includes(
      Buffer.from("NETSCAPE2.0", "ascii"),
    );
    if (!netscapeLoop) {
      throw new Error("GIF output is missing NETSCAPE2.0 looping extension");
    }

    console.log("Encoder GIF contract test passed");
    console.log(`  GIF: ${gifPath} (${gifSize} bytes)`);
    console.log("  Verified palettegen + paletteuse and infinite loop metadata");
  } finally {
    run("docker", ["rm", "-f", gifContainer]);
  }
}

function main() {
  assertDockerAvailable();
  assertFfmpegAvailable();
  const { barsPath, frameCounterPath } = ensureFixtureVideo();
  testNullMaxClipLengthValidation();
  testSourceFileSelection();
  testEncodeErrorClassification();
  testYoutubeErrorClassification();
  testSectionEncodeBounds();
  buildImage();
  testProcessGroupKill();
  runStageSourceContract(frameCounterPath);
  runEncoderYoutubeFailFastContract(frameCounterPath);
  runEncoderEncodeFailureContract();
  runEncoderContract(barsPath, frameCounterPath);
  runEncoderGifContract(barsPath);
  runEncoderUploadContract(frameCounterPath);
  runEncoderCaptionContract(barsPath, frameCounterPath);
}

main();
