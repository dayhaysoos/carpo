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
  const dualCaptionA = "First caption!!";
  const dualCaptionB = "Second caption!";
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
  const dualCaptionJob = {
    ...baselineJob,
    jobId: "caption-dual",
    filters: [
      { type: "caption", text: dualCaptionA },
      { type: "caption", text: dualCaptionB },
    ],
    outputs: {
      mp4Key: "dual-captioned.mp4",
      thumbnailKey: "dual-captioned.jpg",
    },
  };

  const baselinePath = path.join(captionOutputDir, "baseline-job.json");
  const captionedPath = path.join(captionOutputDir, "captioned-job.json");
  const dualCaptionPath = path.join(captionOutputDir, "dual-captioned-job.json");
  fs.writeFileSync(baselinePath, JSON.stringify(baselineJob));
  fs.writeFileSync(captionedPath, JSON.stringify(captionedJob));
  fs.writeFileSync(dualCaptionPath, JSON.stringify(dualCaptionJob));

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
      ["dual-captioned", dualCaptionPath],
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
    const dualCaptionedMp4 = path.join(captionOutputDir, "dual-captioned.mp4");
    const dualCaptionedThumb = path.join(captionOutputDir, "dual-captioned.jpg");

    if (!fs.existsSync(baselineMp4) || !fs.existsSync(captionedMp4)) {
      throw new Error("Expected baseline and captioned MP4 artifacts");
    }
    if (!fs.existsSync(captionedThumb)) {
      throw new Error("Expected captioned thumbnail artifact");
    }
    if (!fs.existsSync(dualCaptionedMp4) || !fs.existsSync(dualCaptionedThumb)) {
      throw new Error("Expected dual-captioned MP4 and thumbnail artifacts");
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

    const dualCaptionedLog = run("docker", ["logs", captionContainer]);
    if (
      !dualCaptionedLog.includes("caption-0.txt") ||
      !dualCaptionedLog.includes("caption-1.txt")
    ) {
      throw new Error(
        "Dual-caption encode did not use distinct caption textfiles (caption-0.txt and caption-1.txt)",
      );
    }

    const dualCaptionedFrame = readFrameRgbBuffer(dualCaptionedMp4, 0);
    const dualPixelDifferences = countPixelDifferences(
      baselineFrame,
      dualCaptionedFrame,
    );
    if (dualPixelDifferences < 100) {
      throw new Error(
        `Dual-caption overlay did not visibly change the output frame (${dualPixelDifferences} differing bytes)`,
      );
    }

    console.log("Encoder caption contract test passed");
    console.log(`  Caption: ${captionText}`);
    console.log(`  Frame differences: ${pixelDifferences} bytes`);
    console.log(`  Dual captions: ${dualCaptionA} | ${dualCaptionB}`);
    console.log(`  Dual frame differences: ${dualPixelDifferences} bytes`);
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

function main() {
  assertDockerAvailable();
  assertFfmpegAvailable();
  const { barsPath, frameCounterPath } = ensureFixtureVideo();
  testNullMaxClipLengthValidation();
  testSourceFileSelection();
  buildImage();
  runEncoderContract(barsPath, frameCounterPath);
  runEncoderCaptionContract(barsPath, frameCounterPath);
}

main();
