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

  return fixturePath;
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

function runEncoderContract(fixturePath: string) {
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const job = {
    jobId: "contract-test",
    source: {
      type: "file",
      path: "/fixture/bars.mp4",
    },
    trimStart: 2,
    trimEnd: 5,
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
    };
    if (result.status !== "complete") {
      throw new Error(
        `Encoder returned failure: ${result.errorMessage ?? "unknown error"}`,
      );
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
    if (!Number.isFinite(duration) || duration < 2.5 || duration > 3.5) {
      throw new Error(`Unexpected trimmed duration: ${probe.trim()}`);
    }

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
  const fixturePath = ensureFixtureVideo();
  buildImage();
  runEncoderContract(fixturePath);
}

main();
