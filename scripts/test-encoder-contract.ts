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
import { ENCODER_PROTOCOL_VERSION } from "../src/encoder-pool.ts";

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

  const frameCounterHdPath = path.join(fixturesDir, "framecounter-hd.mp4");
  if (!fs.existsSync(frameCounterHdPath)) {
    run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=10:size=1920x1080:rate=30",
      "-vf",
      "geq=r='mod(N\\,256)':g='0':b='0'",
      "-c:v",
      "libx264",
      "-g",
      "90",
      "-pix_fmt",
      "yuv420p",
      "-an",
      frameCounterHdPath,
    ]);
  }

  return { barsPath: fixturePath, frameCounterPath, frameCounterHdPath };
}

function buildImage() {
  run("docker", ["build", "-t", imageName, "./container"]);
}

function testImageToolchainSmoke() {
  const protocolVersion = Number(
    run("docker", [
      "run",
      "--rm",
      imageName,
      "python3",
      "-c",
      "from encoder import ENCODER_PROTOCOL_VERSION; print(ENCODER_PROTOCOL_VERSION)",
    ]).trim(),
  );
  if (protocolVersion !== ENCODER_PROTOCOL_VERSION) {
    throw new Error(
      `Worker encoder protocol ${ENCODER_PROTOCOL_VERSION} does not match image protocol ${protocolVersion}`,
    );
  }
  const ytdlpVersion = run("docker", [
    "run",
    "--rm",
    imageName,
    "yt-dlp",
    "--version",
  ]).trim();
  const denoVersion = run("docker", [
    "run",
    "--rm",
    imageName,
    "deno",
    "--version",
  ]).trim();
  const verboseProbe = run("docker", [
    "run",
    "--rm",
    imageName,
    "sh",
    "-c",
    "yt-dlp -v 2>&1 || true",
  ]).trim();
  const poTokenProbe = JSON.parse(
    run("docker", [
      "run",
      "--rm",
      imageName,
      "python3",
      "-c",
      [
        "import json",
        "import os",
        "from pathlib import Path",
        "from encoder import BGUTIL_PROVIDER_HOME, ytdlp_po_token_args",
        "print(json.dumps({'args': ytdlp_po_token_args(), 'providerHome': BGUTIL_PROVIDER_HOME, 'providerHomeExists': Path(BGUTIL_PROVIDER_HOME).is_dir(), 'providerVersion': os.environ.get('BGUTIL_PROVIDER_VERSION')}))",
      ].join("; "),
    ]),
  ) as {
    args: string[];
    providerHome: string;
    providerHomeExists: boolean;
    providerVersion: string;
  };
  const providerPluginVersion = run("docker", [
    "run",
    "--rm",
    imageName,
    "python3",
    "-c",
    "from yt_dlp_plugins.extractor.getpot_bgutil import __version__; print(__version__)",
  ]).trim();
  const providerScriptVersion = run("docker", [
    "run",
    "--rm",
    imageName,
    "sh",
    "-c",
    [
      'provider_cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/bgutil-ytdlp-pot-provider";',
      "deno run --allow-env --allow-net",
      '--allow-ffi="$BGUTIL_PROVIDER_HOME/node_modules"',
      '--allow-write="$provider_cache_dir"',
      '--allow-read="$provider_cache_dir,$BGUTIL_PROVIDER_HOME/node_modules"',
      '"$BGUTIL_PROVIDER_HOME/src/generate_once.ts" --version',
    ].join(" "),
  ]).trim();

  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(ytdlpVersion)) {
    throw new Error(`Unexpected yt-dlp --version output: ${ytdlpVersion}`);
  }
  if (!denoVersion.startsWith("deno 2.")) {
    throw new Error(`Unexpected deno --version output: ${denoVersion}`);
  }
  const verboseLower = verboseProbe.toLowerCase();
  if (!verboseLower.includes("js runtimes: deno")) {
    throw new Error(
      `yt-dlp -v did not report Deno runtime:\n${verboseProbe}`,
    );
  }
  if (!verboseLower.includes("yt_dlp_ejs")) {
    throw new Error(
      `yt-dlp -v did not report yt-dlp-ejs:\n${verboseProbe}`,
    );
  }
  if (providerPluginVersion !== poTokenProbe.providerVersion) {
    throw new Error(
      `BgUtils plugin version ${providerPluginVersion} did not match image version ${poTokenProbe.providerVersion}`,
    );
  }
  if (providerScriptVersion !== poTokenProbe.providerVersion) {
    throw new Error(
      `BgUtils script version ${providerScriptVersion} did not match image version ${poTokenProbe.providerVersion}`,
    );
  }
  if (!poTokenProbe.providerHomeExists) {
    throw new Error("BgUtils provider home is missing from the encoder image");
  }
  if (
    poTokenProbe.args.length !== 4 ||
    poTokenProbe.args[0] !== "--extractor-args" ||
    poTokenProbe.args[1] !== "youtube:player_client=mweb" ||
    poTokenProbe.args[2] !== "--extractor-args" ||
    poTokenProbe.args[3] !==
      `youtubepot-bgutilscript:server_home=${poTokenProbe.providerHome}`
  ) {
    throw new Error(
      `Unexpected PO-token yt-dlp args: ${JSON.stringify(poTokenProbe.args)}`,
    );
  }

  console.log("Encoder image toolchain smoke test passed");
  console.log(`  yt-dlp: ${ytdlpVersion}`);
  console.log(`  deno: ${denoVersion.split("\n")[0]}`);
  const runtimeLine =
    verboseProbe
      .split("\n")
      .find((line) => line.toLowerCase().includes("js runtimes")) ??
    "(runtime line not found)";
  console.log(`  runtime: ${runtimeLine.trim()}`);
  console.log(
    `  PO tokens: BgUtils ${providerPluginVersion} script provider with mweb client`,
  );
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

function testClipRangeValidation() {
  const script = `
import sys

sys.path.insert(0, ${JSON.stringify(path.join(root, "container"))})
from encoder import validate_job, process_job

valid_job = {
    "trimStart": 0,
    "trimEnd": 1200,
    "source": {"type": "youtube", "url": "https://example.com/watch?v=test"},
}
assert validate_job(valid_job) is None

negative_start_job = {
    "trimStart": -1,
    "trimEnd": 5,
    "source": {"type": "youtube", "url": "https://example.com/watch?v=test"},
}
assert validate_job(negative_start_job) == "trimStart must be non-negative"

failed_job = {
    "trimStart": 0,
    "trimEnd": 5,
    "source": {"type": "youtube", "url": ""},
}
result = process_job(failed_job)
assert result["status"] == "failed"
assert isinstance(result.get("errorMessage"), str)

print("Clip range validation test passed")
`;

  run("python3", ["-c", script]);
}

function testLongClipEncoding() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "carpo-long-clip-"));
  const sourcePath = path.join(tempDir, "source.mp4");
  const outputPath = path.join(tempDir, "clip.mp4");
  const thumbnailPath = path.join(tempDir, "thumbnail.jpg");

  try {
    run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=64x36:r=1:d=62",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      sourcePath,
    ]);
    const script = `
import sys
from pathlib import Path

sys.path.insert(0, ${JSON.stringify(path.join(root, "container"))})
from encoder import encode_clip

encode_clip(
    Path(${JSON.stringify(sourcePath)}),
    1,
    62,
    Path(${JSON.stringify(outputPath)}),
    Path(${JSON.stringify(thumbnailPath)}),
    max_output_height=720,
)
`;
    run("python3", ["-c", script]);
    const duration = Number(
      run("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        outputPath,
      ]).trim(),
    );
    if (duration < 60.5 || duration > 61.5) {
      throw new Error(`Expected a 61-second encoded clip, got ${duration}`);
    }
    if (!fs.existsSync(thumbnailPath)) {
      throw new Error("Long clip thumbnail was not created");
    }
    console.log("Long clip encode contract test passed");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
    YOUTUBE_LOGIN_REQUIRED_MESSAGE,
    YOUTUBE_RATE_LIMITED_MESSAGE,
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
assert classify_ytdlp_error("ERROR: HTTP Error 429: Too Many Requests") == (
    YOUTUBE_RATE_LIMITED_MESSAGE
)
assert classify_ytdlp_error("Sign in to confirm you're not a bot") == (
    YOUTUBE_LOGIN_REQUIRED_MESSAGE
)

from encoder import (
    YOUTUBE_DOWNLOAD_TIMEOUT_MESSAGE,
    YOUTUBE_SECTION_EXACT_FALLBACK_MESSAGE,
    _is_user_facing_ytdlp_error,
)

assert _is_user_facing_ytdlp_error(YOUTUBE_BLOCKED_MESSAGE)
assert _is_user_facing_ytdlp_error(YOUTUBE_RATE_LIMITED_MESSAGE)
assert _is_user_facing_ytdlp_error(YOUTUBE_LOGIN_REQUIRED_MESSAGE)
assert _is_user_facing_ytdlp_error(YOUTUBE_DOWNLOAD_TIMEOUT_MESSAGE)
assert _is_user_facing_ytdlp_error(
    "This YouTube video is unavailable. It may have been deleted or restricted."
)
assert not _is_user_facing_ytdlp_error(YOUTUBE_SECTION_EXACT_FALLBACK_MESSAGE)
assert not _is_user_facing_ytdlp_error("yt-dlp did not produce a source file")

print("YouTube error classification test passed")
`;

  run("python3", ["-c", script]);
}

function testYtdlpStallLineDetection() {
  const script = `
import sys

sys.path.insert(0, ${JSON.stringify(path.join(root, "container"))})
from encoder import (
    _ytdlp_download_line_disables_stall_detection,
    _ytdlp_download_line_enables_stall_detection,
    _ytdlp_line_indicates_postprocess,
)

assert _ytdlp_line_indicates_postprocess("[Merger] Merging formats into \\"source.mp4\\"")
assert _ytdlp_line_indicates_postprocess("[ffmpeg] Merging formats")
assert not _ytdlp_line_indicates_postprocess(
    "[download] 100.0% of ~5.00MiB at 1.00MiB/s ETA 00:00"
)

assert _ytdlp_download_line_enables_stall_detection(
    "[download] Destination: source.f399.mp4"
)
assert _ytdlp_download_line_enables_stall_detection(
    "[download]  50.0% of ~5.00MiB at 1.00MiB/s ETA 00:05"
)
assert not _ytdlp_download_line_enables_stall_detection(
    "[download] 100.0% of ~5.00MiB at 1.00MiB/s ETA 00:00"
)

assert _ytdlp_download_line_disables_stall_detection(
    "[download] 100.0% of ~5.00MiB at 1.00MiB/s ETA 00:00"
)
assert not _ytdlp_download_line_disables_stall_detection(
    "[download]  10.0% of ~1.00MiB at 1.00MiB/s ETA 00:09"
)

print("yt-dlp stall line detection test passed")
`;

  run("python3", ["-c", script]);
}

function testRetainedSourceDownloadCommand() {
  const script = `
import sys

sys.path.insert(0, ${JSON.stringify(path.join(root, "container"))})
from encoder import _ytdlp_download_command

command, section_start = _ytdlp_download_command(
    "https://www.youtube.com/watch?v=retained-source",
    "/tmp/source.%(ext)s",
    trim_start=0,
    trim_end=0,
    use_sections=False,
    remux_to_mp4=True,
)

assert section_start == 0
assert "--download-sections" not in command
assert "--remux-video" in command
assert command[command.index("--remux-video") + 1] == "mp4"

print("Retained YouTube source command test passed")
`;

  run("python3", ["-c", script]);
}

function testYoutubeMetadataParsing() {
  const script = `
import sys

sys.path.insert(0, ${JSON.stringify(path.join(root, "container"))})
from encoder import parse_youtube_metadata

manual = parse_youtube_metadata({
    "duration": 321,
    "subtitles": {"en": [{"ext": "vtt"}]},
    "automatic_captions": {},
})
assert manual == {
    "durationSeconds": 321.0,
    "transcriptAvailable": True,
}

automatic = parse_youtube_metadata({
    "duration": 12.5,
    "subtitles": {},
    "automatic_captions": {
        "live_chat": [{"ext": "json"}],
        "en": [{"ext": "vtt"}],
    },
})
assert automatic["transcriptAvailable"] is True

none = parse_youtube_metadata({
    "duration": None,
    "subtitles": {},
    "automatic_captions": {"live_chat": [{"ext": "json"}]},
})
assert none == {
    "durationSeconds": None,
    "transcriptAvailable": False,
}

print("YouTube metadata parsing test passed")
`;

  run("python3", ["-c", script]);
}

function testYoutubeTranscriptParsing() {
  const script = `
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, ${JSON.stringify(path.join(root, "container"))})
from encoder import inspect_youtube_transcript, parse_youtube_transcript

payload = {
    "events": [
        {
            "tStartMs": 1000,
            "dDurationMs": 900,
            "segs": [
                {"utf8": "Hello "},
                {"utf8": "code", "tOffsetMs": 400},
            ],
        },
        {
            "tStartMs": 2000,
            "dDurationMs": 500,
            "segs": [{"utf8": "again today"}],
        },
        {"tStartMs": 2500, "dDurationMs": 100, "segs": [{"utf8": "\\n"}]},
    ],
}

expected = {
    "language": "en",
    "automatic": True,
    "cues": [
        {"startSeconds": 1.0, "endSeconds": 1.4, "text": "Hello"},
        {"startSeconds": 1.4, "endSeconds": 1.9, "text": "code"},
        {"startSeconds": 2.0, "endSeconds": 2.25, "text": "again"},
        {"startSeconds": 2.25, "endSeconds": 2.5, "text": "today"},
    ],
}

transcript = parse_youtube_transcript(
    payload,
    language="en",
    automatic=True,
)
assert transcript == expected

info = {
    "subtitles": {},
    "automatic_captions": {
        "en": [{"ext": "json3"}],
        "es": [{"ext": "json3"}],
    },
}
captured_command = None

def fake_run(command, **kwargs):
    global captured_command
    captured_command = command
    output_template = command[command.index("--output") + 1]
    output_path = Path(output_template).parent / "transcript.en.json3"
    output_path.write_text(json.dumps(payload), encoding="utf-8")
    return SimpleNamespace(returncode=0, stdout="", stderr="")

with patch("encoder.inspect_youtube_info", return_value=info), \\
     patch("encoder.subprocess.run", side_effect=fake_run):
    fetched = inspect_youtube_transcript(
        "https://www.youtube.com/watch?v=transcript-contract",
    )

assert fetched == expected
assert captured_command is not None
assert "--write-auto-subs" in captured_command
assert "--write-subs" in captured_command
assert captured_command[captured_command.index("--sub-langs") + 1] == "en"
assert captured_command[captured_command.index("--sub-format") + 1] == "json3"

print("YouTube transcript parsing test passed")
`;

  run("python3", ["-c", script]);
}

function testAudioChunkWindows() {
  const script = `
import sys

sys.path.insert(0, ${JSON.stringify(path.join(root, "container"))})
from encoder import audio_chunk_windows

assert audio_chunk_windows(601) == [
    {
        "name": "audio-000.mp3",
        "startSeconds": 0.0,
        "durationSeconds": 300.0,
        "keepStartSeconds": 0.0,
        "keepEndSeconds": 299.0,
    },
    {
        "name": "audio-001.mp3",
        "startSeconds": 298.0,
        "durationSeconds": 300.0,
        "keepStartSeconds": 1.0,
        "keepEndSeconds": 299.0,
    },
    {
        "name": "audio-002.mp3",
        "startSeconds": 596.0,
        "durationSeconds": 5.0,
        "keepStartSeconds": 1.0,
        "keepEndSeconds": 5.0,
    },
]

print("Audio chunk window contract test passed")
`;

  run("python3", ["-c", script]);
}

function testAudioChunkExtraction(sourcePath: string) {
  const script = `
import sys
from pathlib import Path

sys.path.insert(0, "/app")
from encoder import extract_audio_chunks

chunks = extract_audio_chunks(Path("/tmp/source.mp4"), "audio-contract")
assert len(chunks) == 1
assert chunks[0]["name"] == "audio-000.mp3"
output = Path("/outputs/audio-contract/audio-000.mp3")
assert output.exists()
assert output.stat().st_size > 0
print("Audio chunk extraction contract test passed")
`;

  run("docker", [
    "run",
    "--rm",
    "-v",
    `${sourcePath}:/tmp/source.mp4:ro`,
    imageName,
    "python3",
    "-c",
    script,
  ]);
  console.log("Encoder audio chunk extraction contract test passed");
}

function testSampleFrameExtraction(sourcePath: string) {
  const script = `
import sys
from pathlib import Path

sys.path.insert(0, "/app")
from encoder import extract_sample_frames

samples = extract_sample_frames(
    Path("/tmp/source.mp4"),
    "visual-contract",
    [
        {"id": "frame-00-1000", "timestampSeconds": 1.0},
        {"id": "frame-01-5000", "timestampSeconds": 5.0},
    ],
)
assert samples == [
    {"id": "frame-00-1000", "timestampSeconds": 1.0},
    {"id": "frame-01-5000", "timestampSeconds": 5.0},
]
for sample in samples:
    output = Path("/outputs/visual-contract") / f"{sample['id']}.jpg"
    assert output.exists()
    assert output.stat().st_size > 0
print("Visual frame sampling contract test passed")
`;

  run("docker", [
    "run",
    "--rm",
    "-v",
    `${sourcePath}:/tmp/source.mp4:ro`,
    imageName,
    "python3",
    "-c",
    script,
  ]);
  console.log("Encoder visual frame sampling contract test passed");
}

function testSectionEncodeBounds() {
  const script = `
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, ${JSON.stringify(path.join(root, "container"))})
from encoder import resolve_section_encode_bounds

with patch("encoder.probe_media_start_time", return_value=7.6):
    start, end = resolve_section_encode_bounds(Path("source.mp4"), 7.5, 10.0, 4.5)
    assert start == 0.0, start
    assert abs(end - 2.4) < 0.001, end

with patch("encoder.probe_media_start_time", return_value=7):
    start, end = resolve_section_encode_bounds(Path("source.mp4"), 7.5, 10.0, 4.5)
    assert start == 0.5, start
    assert abs(end - 3.0) < 0.001, end

with patch("encoder.probe_media_start_time", return_value=8.0):
    try:
        resolve_section_encode_bounds(Path("source.mp4"), 7.5, 10.0, 4.5)
    except RuntimeError as exc:
        assert "does not contain the requested trim range" in str(exc)
    else:
        raise AssertionError("expected late keyframe snap after trimStart to fail")

with patch("encoder.probe_media_start_time", return_value=11.0):
    try:
        resolve_section_encode_bounds(Path("source.mp4"), 7.5, 10.0, 4.5)
    except RuntimeError as exc:
        assert "does not contain the requested trim range" in str(exc)
    else:
        raise AssertionError("expected empty trim window to fail")

from encoder import section_exact_encode_bounds

start, end = section_exact_encode_bounds(7.5, 10.0, 4.5)
assert start == 3.0, start
assert end == 5.5, end

print("Section encode bounds test passed")
`;

  run("python3", ["-c", script]);
}

function testStreamCopyGate() {
  const script = `
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, ${JSON.stringify(path.join(root, "container"))})
from encoder import (
    ENCODE_DURATION_TOLERANCE_SECONDS,
    _can_stream_copy_encode,
    encode_clip,
    probe_media_duration,
    probe_media_height,
    probe_media_start_time,
)

source = Path("source.mp4")

with patch("encoder.probe_media_height", return_value=240), \\
     patch("encoder.probe_media_duration", return_value=2.5):
    assert _can_stream_copy_encode(
        source, 0, 2.5, caption_filters=None, max_output_height=1080
    )

with patch("encoder.probe_media_height", return_value=240), \\
     patch("encoder.probe_media_duration", return_value=3.2):
    assert _can_stream_copy_encode(
        source, 0, 3.0, caption_filters=None, max_output_height=1080
    ), "slightly long source within tolerance must stream-copy"

with patch("encoder.probe_media_height", return_value=240), \\
     patch("encoder.probe_media_duration", return_value=2.54):
    assert not _can_stream_copy_encode(
        source, 0.04, 2.54, caption_filters=None, max_output_height=1080
    ), "small trim_start must not stream-copy"

with patch("encoder.probe_media_height", return_value=240), \\
     patch("encoder.probe_media_duration", return_value=2.7):
    assert not _can_stream_copy_encode(
        source, 0, 3.0, caption_filters=None, max_output_height=1080
    ), "short source must re-encode, not silently truncate"

with patch("encoder.probe_media_height", return_value=240), \\
     patch("encoder.probe_media_duration", return_value=2.5):
    assert not _can_stream_copy_encode(
        source, 2.5, 5.0, caption_filters=None, max_output_height=1080
    ), "upload/file trim offsets must re-encode"

with patch("encoder.probe_media_height", return_value=None), \\
     patch("encoder.probe_media_duration", return_value=2.5):
    assert not _can_stream_copy_encode(
        source, 0, 2.5, caption_filters=None, max_output_height=1080
    ), "missing/zero height must not stream-copy"

with patch("encoder.probe_media_stream_value", return_value=8):
    assert probe_media_start_time(source) == 8.0

zero_height_result = MagicMock(returncode=0, stdout="0\\n")
with patch("encoder.subprocess.run", return_value=zero_height_result):
    assert probe_media_height(source) is None, "zero height probe must be rejected"

requested_duration = 3.0
with tempfile.TemporaryDirectory() as tmpdir:
    workdir = Path(tmpdir)
    long_source = workdir / "long-source.mp4"
    output_mp4 = workdir / "trimmed.mp4"
    output_thumb = workdir / "trimmed.jpg"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=3.2:size=320x240:rate=30",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            long_source,
        ],
        check=True,
    )
    source_duration = probe_media_duration(long_source)
    assert source_duration is not None
    assert source_duration > requested_duration
    assert (
        abs(source_duration - requested_duration)
        <= ENCODE_DURATION_TOLERANCE_SECONDS
    )
    encode_clip(
        long_source,
        0,
        requested_duration,
        output_mp4,
        output_thumb,
    )
    output_duration = probe_media_duration(output_mp4)
    assert output_duration is not None
    assert abs(output_duration - requested_duration) <= ENCODE_DURATION_TOLERANCE_SECONDS
    assert output_duration < source_duration - 0.1, (
        "stream-copy must trim slightly long source to requested window"
    )

print("Stream-copy gate test passed")
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

function assertSectionDownloadBounds(
  logs: string,
  trimStart: number,
  trimEnd: number,
) {
  const matches = [
    ...logs.matchAll(/--download-sections \*([0-9.]+)-([0-9.]+)/g),
  ];
  if (matches.length < 2) {
    throw new Error(
      `Expected padded + exact --download-sections invocations, got ${matches.length}`,
    );
  }
  const paddedStart = Number.parseFloat(matches[0][1]);
  const paddedEnd = Number.parseFloat(matches[0][2]);
  const exactStart = Number.parseFloat(matches[1][1]);
  const exactEnd = Number.parseFloat(matches[1][2]);
  const expectedPaddedStart = Math.max(0, trimStart - 3);
  if (paddedStart !== expectedPaddedStart || paddedEnd !== trimEnd + 3) {
    throw new Error(
      `Unexpected padded section bounds ${paddedStart}-${paddedEnd}; expected ${expectedPaddedStart}-${trimEnd + 3}`,
    );
  }
  if (exactStart !== trimStart || exactEnd !== trimEnd) {
    throw new Error(
      `Unexpected exact fallback section bounds ${exactStart}-${exactEnd}; expected ${trimStart}-${trimEnd}`,
    );
  }
}

function assertForceKeyframesFallbackInvocation(logs: string) {
  if (!logs.includes("force-keyframes-at-cuts")) {
    throw new Error("Encoder logs did not show force-keyframes fallback");
  }
  if (
    !logs.includes("--ppa") ||
    !logs.includes("ffmpeg:-preset veryfast")
  ) {
    throw new Error(
      "Encoder logs did not show yt-dlp ffmpeg veryfast postprocessor args",
    );
  }
}

function assertPoTokenInvocation(logs: string) {
  if (
    !logs.includes("--extractor-args") ||
    !logs.includes("youtube:player_client=mweb") ||
    !logs.includes("youtubepot-bgutilscript:server_home=")
  ) {
    throw new Error(
      "Encoder logs did not show the mweb BgUtils PO-token configuration",
    );
  }
}

function runEncoderYoutubeFailFastContract(frameCounterPath: string) {
  const blockedFixture = path.join(fixturesDir, "fake-ytdlp-403.sh");
  const blockedStdoutFixture = path.join(fixturesDir, "fake-ytdlp-403-stdout.sh");
  const stallFixture = path.join(fixturesDir, "fake-ytdlp-stall.sh");
  const stall403Fixture = path.join(fixturesDir, "fake-ytdlp-stall-403.sh");
  const slowProgressFixture = path.join(fixturesDir, "fake-ytdlp-slow-progress.sh");
  const silentMergeFixture = path.join(fixturesDir, "fake-ytdlp-silent-merge.sh");
  const multiStreamStallFixture = path.join(
    fixturesDir,
    "fake-ytdlp-multi-stream-stall.sh",
  );
  const betweenStreamsSilenceFixture = path.join(
    fixturesDir,
    "fake-ytdlp-between-streams-silence.sh",
  );
  const sectionsFixture = path.join(fixturesDir, "fake-ytdlp-sections.sh");
  const sectionsLateStartFixture = path.join(
    fixturesDir,
    "fake-ytdlp-sections-late-start.sh",
  );
  const sectionsLateKeyframeFixture = path.join(
    fixturesDir,
    "fake-ytdlp-sections-late-keyframe.sh",
  );
  const sectionsRejectedFixture = path.join(
    fixturesDir,
    "fake-ytdlp-sections-rejected.sh",
  );
  const sectionsFallback403Fixture = path.join(
    fixturesDir,
    "fake-ytdlp-sections-fallback-403.sh",
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
    assertPoTokenInvocation(blocked.logs);
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
        env: {
          YOUTUBE_STALL_TIMEOUT_SECONDS: "5",
          // Scaled stand-in for the old 180s post-process idle budget (10s).
          YOUTUBE_POSTPROCESS_STALL_TIMEOUT_SECONDS: "10",
        },
      },
    );
    if (silentMerge.result.status !== "complete") {
      throw new Error(
        `Expected complete status for silent-merge fixture, got ${silentMerge.result.status}: ${silentMerge.result.errorMessage ?? ""}`,
      );
    }
    if (silentMerge.elapsedMs < 14_000) {
      throw new Error(
        `Silent-merge fixture finished too quickly (${silentMerge.elapsedMs}ms); expected >14s silent post-merge phase`,
      );
    }
    console.log("Encoder YouTube silent-merge contract test passed");
    console.log(`  Elapsed: ${silentMerge.elapsedMs}ms`);
  } finally {
    run("docker", ["rm", "-f", `${containerName}-youtube-silent-merge`]);
  }

  const betweenStreamsSilenceJobPath = path.join(
    failFastOutputDir,
    "between-streams-silence-job.json",
  );
  fs.writeFileSync(
    betweenStreamsSilenceJobPath,
    JSON.stringify({ ...baseJob, jobId: "youtube-between-streams-silence" }),
  );

  try {
    const betweenStreamsSilence = runEncoderYoutubeJob(
      `${containerName}-youtube-between-streams-silence`,
      18092,
      betweenStreamsSilenceJobPath,
      {
        fakeYtdlpPath: betweenStreamsSilenceFixture,
        outputDir: failFastOutputDir,
        env: {
          YOUTUBE_STALL_TIMEOUT_SECONDS: "5",
          YOUTUBE_POST_100_GRACE_TIMEOUT_SECONDS: "5",
        },
      },
    );
    if (betweenStreamsSilence.result.status !== "failed") {
      throw new Error(
        `Expected failed status for between-streams silence fixture, got ${betweenStreamsSilence.result.status}`,
      );
    }
    if (
      betweenStreamsSilence.result.errorMessage !==
      "YouTube appears to be blocking/stalling downloads from this server. Try uploading the video file instead."
    ) {
      throw new Error(
        `Unexpected between-streams silence error message: ${betweenStreamsSilence.result.errorMessage ?? "(missing)"}`,
      );
    }
    if (
      betweenStreamsSilence.elapsedMs < 4_000 ||
      betweenStreamsSilence.elapsedMs > 20_000
    ) {
      throw new Error(
        `Between-streams silence kill timing unexpected (${betweenStreamsSilence.elapsedMs}ms); expected roughly 5-15s after video 100%`,
      );
    }
    console.log(
      "Encoder YouTube between-streams silence stall-kill contract test passed",
    );
    console.log(`  Elapsed: ${betweenStreamsSilence.elapsedMs}ms`);
    console.log(`  Message: ${betweenStreamsSilence.result.errorMessage}`);
  } finally {
    run("docker", [
      "rm",
      "-f",
      `${containerName}-youtube-between-streams-silence`,
    ]);
  }

  const multiStreamStallJobPath = path.join(
    failFastOutputDir,
    "multi-stream-stall-job.json",
  );
  fs.writeFileSync(
    multiStreamStallJobPath,
    JSON.stringify({ ...baseJob, jobId: "youtube-multi-stream-stall" }),
  );

  try {
    const multiStreamStall = runEncoderYoutubeJob(
      `${containerName}-youtube-multi-stream-stall`,
      18093,
      multiStreamStallJobPath,
      {
        fakeYtdlpPath: multiStreamStallFixture,
        outputDir: failFastOutputDir,
        env: { YOUTUBE_STALL_TIMEOUT_SECONDS: "5" },
      },
    );
    if (multiStreamStall.result.status !== "failed") {
      throw new Error(
        `Expected failed status for multi-stream stall fixture, got ${multiStreamStall.result.status}`,
      );
    }
    if (
      multiStreamStall.result.errorMessage !==
      "YouTube appears to be blocking/stalling downloads from this server. Try uploading the video file instead."
    ) {
      throw new Error(
        `Unexpected multi-stream stall error message: ${multiStreamStall.result.errorMessage ?? "(missing)"}`,
      );
    }
    if (multiStreamStall.elapsedMs < 4_000 || multiStreamStall.elapsedMs > 20_000) {
      throw new Error(
        `Multi-stream stall kill timing unexpected (${multiStreamStall.elapsedMs}ms); expected roughly 5-15s after audio stream starts`,
      );
    }
    console.log("Encoder YouTube multi-stream stall-kill contract test passed");
    console.log(`  Elapsed: ${multiStreamStall.elapsedMs}ms`);
    console.log(`  Message: ${multiStreamStall.result.errorMessage}`);
  } finally {
    run("docker", ["rm", "-f", `${containerName}-youtube-multi-stream-stall`]);
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
    if (sections.logs.includes("--force-keyframes-at-cuts")) {
      throw new Error(
        "Fast-path section download should not use --force-keyframes-at-cuts",
      );
    }
    if (!sections.logs.includes("--concurrent-fragments 8")) {
      throw new Error("Encoder logs did not show --concurrent-fragments 8");
    }
    assertPoTokenInvocation(sections.logs);
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

  const rejectedTrimStart = 7.5;
  const rejectedTrimEnd = 9.5;
  const rejectedOutputDir = path.join(outputDir, "youtube-sections-rejected");
  fs.rmSync(rejectedOutputDir, { recursive: true, force: true });
  fs.mkdirSync(rejectedOutputDir, { recursive: true });
  const rejectedJobPath = path.join(rejectedOutputDir, "rejected-job.json");
  fs.writeFileSync(
    rejectedJobPath,
    JSON.stringify({
      jobId: "youtube-sections-rejected",
      source: {
        type: "youtube",
        url: "https://www.youtube.com/watch?v=section-rejected",
      },
      trimStart: rejectedTrimStart,
      trimEnd: rejectedTrimEnd,
      outputs: {
        mp4Key: "rejected.mp4",
        thumbnailKey: "rejected.jpg",
      },
      localOutputDir: "/output",
    }),
  );

  try {
    const rejected = runEncoderYoutubeJob(
      `${containerName}-youtube-sections-rejected`,
      18095,
      rejectedJobPath,
      {
        fakeYtdlpPath: sectionsRejectedFixture,
        outputDir: rejectedOutputDir,
        frameCounterPath,
      },
    );
    if (rejected.result.status !== "complete") {
      throw new Error(
        `Expected complete status for rejected-section fixture, got ${rejected.result.status}: ${rejected.result.errorMessage ?? ""}`,
      );
    }
    const ytdlpRuns = rejected.logs.match(/running: yt-dlp/g) ?? [];
    if (ytdlpRuns.length !== 2) {
      throw new Error(
        `Expected 2 yt-dlp invocations (section + force-keyframes fallback), got ${ytdlpRuns.length}`,
      );
    }
    const sectionRuns = rejected.logs.match(/--download-sections/g) ?? [];
    if (sectionRuns.length !== 2) {
      throw new Error(
        `Expected two --download-sections invocations, got ${sectionRuns.length}`,
      );
    }
    if (
      !rejected.logs.includes("does not contain the requested trim range")
    ) {
      throw new Error(
        "Encoder logs did not show rejected section trim range fallback",
      );
    }
    if (!rejected.logs.includes("force-keyframes-at-cuts")) {
      throw new Error(
        "Encoder logs did not show force-keyframes section fallback for rejected section window",
      );
    }
    assertSectionDownloadBounds(
      rejected.logs,
      rejectedTrimStart,
      rejectedTrimEnd,
    );
    assertForceKeyframesFallbackInvocation(rejected.logs);
    if (!rejected.logs.includes("encode: stream-copy (no re-encode needed)")) {
      throw new Error(
        "Encoder logs did not show stream-copy encode after exact fallback section",
      );
    }
    if (rejected.logs.includes("re-downloading full video")) {
      throw new Error("Encoder logs still show removed full-video fallback");
    }
    const mp4Path = path.join(rejectedOutputDir, "rejected.mp4");
    const thumbPath = path.join(rejectedOutputDir, "rejected.jpg");
    if (!fs.existsSync(mp4Path) || !fs.existsSync(thumbPath)) {
      throw new Error("Expected rejected-section trim artifacts on host output dir");
    }
    assertTrimFrameAccuracy(
      frameCounterPath,
      mp4Path,
      thumbPath,
      rejectedTrimStart,
    );

    console.log(
      "Encoder YouTube rejected-section force-keyframes fallback contract test passed",
    );
  } finally {
    run("docker", ["rm", "-f", `${containerName}-youtube-sections-rejected`]);
  }

  const lateKeyframeTrimStart = 7.5;
  const lateKeyframeTrimEnd = 10;
  const lateKeyframeOutputDir = path.join(
    outputDir,
    "youtube-sections-late-keyframe",
  );
  fs.rmSync(lateKeyframeOutputDir, { recursive: true, force: true });
  fs.mkdirSync(lateKeyframeOutputDir, { recursive: true });
  const lateKeyframeJobPath = path.join(
    lateKeyframeOutputDir,
    "late-keyframe-job.json",
  );
  fs.writeFileSync(
    lateKeyframeJobPath,
    JSON.stringify({
      jobId: "youtube-sections-late-keyframe",
      source: {
        type: "youtube",
        url: "https://www.youtube.com/watch?v=section-late-keyframe",
      },
      trimStart: lateKeyframeTrimStart,
      trimEnd: lateKeyframeTrimEnd,
      outputs: {
        mp4Key: "late-keyframe.mp4",
        thumbnailKey: "late-keyframe.jpg",
      },
      localOutputDir: "/output",
    }),
  );

  try {
    const lateKeyframe = runEncoderYoutubeJob(
      `${containerName}-youtube-sections-late-keyframe`,
      18096,
      lateKeyframeJobPath,
      {
        fakeYtdlpPath: sectionsLateKeyframeFixture,
        outputDir: lateKeyframeOutputDir,
        frameCounterPath,
      },
    );
    if (lateKeyframe.result.status !== "complete") {
      throw new Error(
        `Expected complete status for late-keyframe fixture, got ${lateKeyframe.result.status}: ${lateKeyframe.result.errorMessage ?? ""}`,
      );
    }
    const ytdlpRuns = lateKeyframe.logs.match(/running: yt-dlp/g) ?? [];
    if (ytdlpRuns.length !== 2) {
      throw new Error(
        `Expected 2 yt-dlp invocations (section + force-keyframes fallback), got ${ytdlpRuns.length}`,
      );
    }
    const sectionRuns = lateKeyframe.logs.match(/--download-sections/g) ?? [];
    if (sectionRuns.length !== 2) {
      throw new Error(
        `Expected two --download-sections invocations, got ${sectionRuns.length}`,
      );
    }
    if (
      !lateKeyframe.logs.includes("does not contain the requested trim range")
    ) {
      throw new Error(
        "Encoder logs did not show rejected section for late keyframe snap",
      );
    }
    if (!lateKeyframe.logs.includes("force-keyframes-at-cuts")) {
      throw new Error(
        "Encoder logs did not show force-keyframes fallback for late keyframe snap",
      );
    }
    assertSectionDownloadBounds(
      lateKeyframe.logs,
      lateKeyframeTrimStart,
      lateKeyframeTrimEnd,
    );
    assertForceKeyframesFallbackInvocation(lateKeyframe.logs);
    if (
      !lateKeyframe.logs.includes("encode: stream-copy (no re-encode needed)")
    ) {
      throw new Error(
        "Encoder logs did not show stream-copy encode after late-keyframe fallback",
      );
    }
    if (lateKeyframe.logs.includes("re-downloading full video")) {
      throw new Error("Encoder logs still show removed full-video fallback");
    }
    const mp4Path = path.join(lateKeyframeOutputDir, "late-keyframe.mp4");
    const thumbPath = path.join(lateKeyframeOutputDir, "late-keyframe.jpg");
    if (!fs.existsSync(mp4Path) || !fs.existsSync(thumbPath)) {
      throw new Error(
        "Expected late-keyframe trim artifacts on host output dir",
      );
    }
    assertTrimFrameAccuracy(
      frameCounterPath,
      mp4Path,
      thumbPath,
      lateKeyframeTrimStart,
    );

    console.log(
      "Encoder YouTube late-keyframe force-keyframes fallback contract test passed",
    );
  } finally {
    run("docker", [
      "rm",
      "-f",
      `${containerName}-youtube-sections-late-keyframe`,
    ]);
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
        `Expected complete status for rebased-timestamp sections fixture, got ${lateStart.result.status}: ${lateStart.result.errorMessage ?? ""}`,
      );
    }
    const ytdlpRuns = lateStart.logs.match(/running: yt-dlp/g) ?? [];
    if (ytdlpRuns.length !== 2) {
      throw new Error(
        `Expected 2 yt-dlp invocations (section + force-keyframes fallback), got ${ytdlpRuns.length}`,
      );
    }
    const sectionRuns = lateStart.logs.match(/--download-sections/g) ?? [];
    if (sectionRuns.length !== 2) {
      throw new Error(
        `Expected two --download-sections invocations, got ${sectionRuns.length}`,
      );
    }
    if (!lateStart.logs.includes("force-keyframes-at-cuts")) {
      throw new Error(
        "Encoder logs did not show force-keyframes fallback for unknown alignment",
      );
    }
    assertSectionDownloadBounds(lateStart.logs, zeroTrimStart, zeroTrimEnd);
    assertForceKeyframesFallbackInvocation(lateStart.logs);
    if (!lateStart.logs.includes("encode: stream-copy (no re-encode needed)")) {
      throw new Error(
        "Encoder logs did not show stream-copy encode after zero-start fallback",
      );
    }
    if (lateStart.logs.includes("re-downloading full video")) {
      throw new Error("Encoder logs still show removed full-video fallback");
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
    console.log(
      "Encoder YouTube rebased-timestamp sections fallback contract test passed",
    );
    console.log(`  Duration: ${duration.toFixed(2)}s (expected ${expectedDuration}s)`);
  } finally {
    run("docker", ["rm", "-f", `${containerName}-youtube-sections-zero`]);
  }

  const fallback403TrimStart = 7.5;
  const fallback403TrimEnd = 10;
  const fallback403OutputDir = path.join(
    outputDir,
    "youtube-sections-fallback-403",
  );
  fs.rmSync(fallback403OutputDir, { recursive: true, force: true });
  fs.mkdirSync(fallback403OutputDir, { recursive: true });
  const fallback403JobPath = path.join(
    fallback403OutputDir,
    "fallback-403-job.json",
  );
  fs.writeFileSync(
    fallback403JobPath,
    JSON.stringify({
      jobId: "youtube-sections-fallback-403",
      source: {
        type: "youtube",
        url: "https://www.youtube.com/watch?v=section-fallback-403",
      },
      trimStart: fallback403TrimStart,
      trimEnd: fallback403TrimEnd,
      outputs: {
        mp4Key: "fallback-403.mp4",
        thumbnailKey: "fallback-403.jpg",
      },
      localOutputDir: "/output",
    }),
  );

  try {
    const fallback403 = runEncoderYoutubeJob(
      `${containerName}-youtube-sections-fallback-403`,
      18093,
      fallback403JobPath,
      {
        fakeYtdlpPath: sectionsFallback403Fixture,
        outputDir: fallback403OutputDir,
        frameCounterPath,
      },
    );
    if (fallback403.result.status !== "failed") {
      throw new Error(
        `Expected failed status for fallback-403 fixture, got ${fallback403.result.status}`,
      );
    }
    if (
      fallback403.result.errorMessage !==
      "YouTube is blocking downloads from this server. Try uploading the video file instead."
    ) {
      throw new Error(
        `Expected classified 403 on force-keyframes fallback, got ${fallback403.result.errorMessage ?? "(missing)"}`,
      );
    }
    const ytdlpRuns = fallback403.logs.match(/running: yt-dlp/g) ?? [];
    if (ytdlpRuns.length !== 2) {
      throw new Error(
        `Expected 2 yt-dlp invocations before classified fallback failure, got ${ytdlpRuns.length}`,
      );
    }
    assertSectionDownloadBounds(
      fallback403.logs,
      fallback403TrimStart,
      fallback403TrimEnd,
    );
    assertForceKeyframesFallbackInvocation(fallback403.logs);
    if (
      fallback403.logs.includes(
        "Section-only download failed after retry with exact cuts",
      )
    ) {
      throw new Error(
        "Classified fallback failure was masked by generic section fallback message",
      );
    }
    console.log(
      "Encoder YouTube classified fallback-403 contract test passed",
    );
    console.log(`  Message: ${fallback403.result.errorMessage}`);
  } finally {
    run("docker", [
      "rm",
      "-f",
      `${containerName}-youtube-sections-fallback-403`,
    ]);
  }
}

function probeVideoHeight(videoPath: string): number {
  const output = run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=height",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    videoPath,
  ]);
  const height = Number.parseInt(output.trim(), 10);
  if (!Number.isFinite(height)) {
    throw new Error(`Could not probe video height for ${videoPath}`);
  }
  return height;
}

function runEncoderQualityContract(
  frameCounterPath: string,
  frameCounterHdPath: string,
) {
  const sectionsFixture = path.join(fixturesDir, "fake-ytdlp-sections.sh");
  const qualityOutputDir = path.join(outputDir, "quality");
  fs.rmSync(qualityOutputDir, { recursive: true, force: true });
  fs.mkdirSync(qualityOutputDir, { recursive: true });

  const hd720JobPath = path.join(qualityOutputDir, "hd-720-job.json");
  fs.writeFileSync(
    hd720JobPath,
    JSON.stringify({
      jobId: "quality-hd-720",
      source: {
        type: "file",
        path: "/fixture/framecounter-hd.mp4",
      },
      trimStart: 0,
      trimEnd: 2,
      quality: "720p",
      outputs: {
        mp4Key: "hd-720.mp4",
        thumbnailKey: "hd-720.jpg",
      },
      localOutputDir: "/output",
    }),
  );

  const hd720Container = `${containerName}-quality-hd-720`;
  run("docker", ["rm", "-f", hd720Container]);
  run("docker", [
    "run",
    "-d",
    "--name",
    hd720Container,
    "-p",
    "18097:8080",
    "-v",
    `${frameCounterHdPath}:/fixture/framecounter-hd.mp4:ro`,
    "-v",
    `${qualityOutputDir}:/output`,
    imageName,
  ]);

  try {
    waitForHealth(18097);
    const hd720 = spawnSync(
      "curl",
      [
        "-sS",
        "-X",
        "POST",
        "http://127.0.0.1:18097/run",
        "-H",
        "Content-Type: application/json",
        "-d",
        `@${hd720JobPath}`,
      ],
      { encoding: "utf-8" },
    );
    if (hd720.status !== 0) {
      throw new Error(`720p HD encode request failed: ${hd720.stderr}`);
    }
    const hd720Result = JSON.parse(hd720.stdout || "{}") as {
      status: string;
      errorMessage?: string;
    };
    if (hd720Result.status !== "complete") {
      throw new Error(
        `Expected complete status for 720p HD encode, got ${hd720Result.status}: ${hd720Result.errorMessage ?? ""}`,
      );
    }
    const hd720Mp4 = path.join(qualityOutputDir, "hd-720.mp4");
    const outputHeight = probeVideoHeight(hd720Mp4);
    if (outputHeight > 720) {
      throw new Error(
        `720p encode output height ${outputHeight}px exceeds 720px cap`,
      );
    }
    console.log("Encoder 720p output height cap contract test passed");
    console.log(`  Output height: ${outputHeight}px`);
  } finally {
    run("docker", ["rm", "-f", hd720Container]);
  }

  const ytdlp1080JobPath = path.join(qualityOutputDir, "ytdlp-1080-job.json");
  fs.writeFileSync(
    ytdlp1080JobPath,
    JSON.stringify({
      jobId: "quality-ytdlp-1080",
      source: {
        type: "youtube",
        url: "https://www.youtube.com/watch?v=quality-1080",
      },
      trimStart: 7.5,
      trimEnd: 10,
      quality: "1080p",
      outputs: {
        mp4Key: "ytdlp-1080.mp4",
        thumbnailKey: "ytdlp-1080.jpg",
      },
      localOutputDir: "/output",
    }),
  );

  const ytdlp720JobPath = path.join(qualityOutputDir, "ytdlp-720-job.json");
  fs.writeFileSync(
    ytdlp720JobPath,
    JSON.stringify({
      jobId: "quality-ytdlp-720",
      source: {
        type: "youtube",
        url: "https://www.youtube.com/watch?v=quality-720",
      },
      trimStart: 7.5,
      trimEnd: 10,
      quality: "720p",
      outputs: {
        mp4Key: "ytdlp-720.mp4",
        thumbnailKey: "ytdlp-720.jpg",
      },
      localOutputDir: "/output",
    }),
  );

  try {
    const ytdlp1080 = runEncoderYoutubeJob(
      `${containerName}-quality-ytdlp-1080`,
      18098,
      ytdlp1080JobPath,
      {
        fakeYtdlpPath: sectionsFixture,
        outputDir: qualityOutputDir,
        frameCounterPath,
      },
    );
    if (ytdlp1080.result.status !== "complete") {
      throw new Error(
        `Expected complete status for 1080p yt-dlp job, got ${ytdlp1080.result.status}`,
      );
    }
    if (
      !ytdlp1080.logs.includes("res:1080") ||
      !ytdlp1080.logs.includes("bestvideo[height<=1080][vcodec^=avc1]+bestaudio")
    ) {
      throw new Error("1080p yt-dlp job logs missing expected format flags");
    }
    run("docker", ["rm", "-f", `${containerName}-quality-ytdlp-1080`]);

    const ytdlp720 = runEncoderYoutubeJob(
      `${containerName}-quality-ytdlp-720`,
      18099,
      ytdlp720JobPath,
      {
        fakeYtdlpPath: sectionsFixture,
        outputDir: qualityOutputDir,
        frameCounterPath,
      },
    );
    if (ytdlp720.result.status !== "complete") {
      throw new Error(
        `Expected complete status for 720p yt-dlp job, got ${ytdlp720.result.status}`,
      );
    }
    if (
      !ytdlp720.logs.includes("res:720") ||
      !ytdlp720.logs.includes("bestvideo[height<=720][vcodec^=avc1]+bestaudio")
    ) {
      throw new Error("720p yt-dlp job logs missing expected format flags");
    }

    console.log("Encoder quality yt-dlp format selector contract test passed");
  } finally {
    run("docker", ["rm", "-f", `${containerName}-quality-ytdlp-1080`]);
    run("docker", ["rm", "-f", `${containerName}-quality-ytdlp-720`]);
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

function runEncoderTimedCaptionContract(fixturePath: string) {
  const timedOutputDir = path.join(outputDir, "timed-caption-contract");
  fs.rmSync(timedOutputDir, { recursive: true, force: true });
  fs.mkdirSync(timedOutputDir, { recursive: true });
  const jobs = [
    { label: "baseline", theme: "classic", cues: [] },
    {
      label: "classic",
      theme: "classic",
      cues: [
        {
          id: "cue-1",
          startSeconds: 1,
          endSeconds: 2.5,
          text: "It's 50% off: now!",
        },
      ],
    },
    {
      label: "box",
      theme: "high-contrast-box",
      cues: [
        {
          id: "cue-1",
          startSeconds: 1,
          endSeconds: 2.5,
          text: "It's 50% off: now!",
        },
      ],
    },
    {
      label: "yellow",
      theme: "bold-yellow",
      cues: [
        {
          id: "cue-1",
          startSeconds: 1,
          endSeconds: 2.5,
          text: "It's 50% off: now!",
        },
      ],
    },
  ] as const;
  const jobFiles = jobs.map((job) => {
    const jobPath = path.join(timedOutputDir, `${job.label}.json`);
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        jobId: `timed-caption-${job.label}`,
        jobType: "captioned",
        renderId: `render-${job.label}`,
        sourceMp4Key: "fixture",
        source: { type: "file", path: "/fixture/bars.mp4" },
        cues: job.cues,
        theme: job.theme,
        outputs: { captionedMp4Key: `${job.label}.mp4` },
        localOutputDir: "/output",
      }),
    );
    return { ...job, jobPath };
  });

  const timedContainer = `${containerName}-timed-caption`;
  run("docker", ["rm", "-f", timedContainer]);
  run("docker", [
    "run",
    "-d",
    "--name",
    timedContainer,
    "-p",
    "18082:8080",
    "-v",
    `${fixturePath}:/fixture/bars.mp4:ro`,
    "-v",
    `${timedOutputDir}:/output`,
    imageName,
  ]);

  try {
    waitForHealth(18082);
    for (const job of jobFiles) {
      const encode = spawnSync(
        "curl",
        [
          "-fsS",
          "-X",
          "POST",
          "http://127.0.0.1:18082/run",
          "-H",
          "Content-Type: application/json",
          "-d",
          `@${job.jobPath}`,
        ],
        { encoding: "utf-8" },
      );
      if (encode.status !== 0) {
        throw new Error(
          `${job.label} timed-caption encode failed\n${encode.stderr}\n${run("docker", ["logs", timedContainer])}`,
        );
      }
      const result = JSON.parse(encode.stdout) as {
        status: string;
        errorMessage?: string;
      };
      if (result.status !== "complete") {
        throw new Error(
          `${job.label} timed-caption encoder returned ${result.status}: ${result.errorMessage ?? "unknown error"}`,
        );
      }
      fs.renameSync(
        path.join(timedOutputDir, "captioned.mp4"),
        path.join(timedOutputDir, `${job.label}.mp4`),
      );
    }

    const deferredJobId = "timed-caption-deferred";
    const deferredJobPath = path.join(timedOutputDir, "deferred.json");
    const deferredOutputPath = path.join(timedOutputDir, "deferred.mp4");
    fs.writeFileSync(
      deferredJobPath,
      JSON.stringify({
        jobId: deferredJobId,
        jobType: "captioned",
        renderId: "render-deferred",
        sourceMp4Key: "fixture",
        source: { type: "file", path: "/fixture/bars.mp4" },
        cues: [
          {
            id: "cue-1",
            startSeconds: 1,
            endSeconds: 2.5,
            text: "Deferred artifact proof",
          },
        ],
        theme: "classic",
        outputs: { captionedMp4Key: "deferred.mp4" },
        deferArtifactUpload: true,
      }),
    );
    const deferredEncode = spawnSync(
      "curl",
      [
        "-fsS",
        "-X",
        "POST",
        "http://127.0.0.1:18082/run",
        "-H",
        "Content-Type: application/json",
        "-d",
        `@${deferredJobPath}`,
      ],
      { encoding: "utf-8" },
    );
    if (deferredEncode.status !== 0) {
      throw new Error(
        `deferred timed-caption encode failed\n${deferredEncode.stderr}\n${run("docker", ["logs", timedContainer])}`,
      );
    }
    const deferredResult = JSON.parse(deferredEncode.stdout) as {
      status: string;
      errorMessage?: string;
    };
    if (deferredResult.status !== "staged") {
      throw new Error(
        `deferred timed-caption encoder returned ${deferredResult.status}: ${deferredResult.errorMessage ?? "unknown error"}`,
      );
    }
    const deferredDownload = spawnSync(
      "curl",
      [
        "-fsS",
        `http://127.0.0.1:18082/outputs/${deferredJobId}/captioned.mp4`,
        "-o",
        deferredOutputPath,
      ],
      { encoding: "utf-8" },
    );
    if (deferredDownload.status !== 0 || !fs.existsSync(deferredOutputPath)) {
      throw new Error(
        `deferred timed-caption artifact could not be downloaded\n${deferredDownload.stderr}\n${run("docker", ["logs", timedContainer])}`,
      );
    }

    const baselineInactive = readFrameRgbBuffer(
      path.join(timedOutputDir, "baseline.mp4"),
      15,
    );
    const baselineActive = readFrameRgbBuffer(
      path.join(timedOutputDir, "baseline.mp4"),
      45,
    );
    const activeFrames = ["classic", "box", "yellow"].map((label) => ({
      label,
      frame: readFrameRgbBuffer(path.join(timedOutputDir, `${label}.mp4`), 45),
      inactive: readFrameRgbBuffer(
        path.join(timedOutputDir, `${label}.mp4`),
        15,
      ),
    }));
    for (const result of activeFrames) {
      const activeDifferences = countPixelDifferences(
        baselineActive,
        result.frame,
      );
      if (activeDifferences < 100) {
        throw new Error(
          `${result.label} timed caption was not visible during its cue (${activeDifferences} differing bytes)`,
        );
      }
      const inactiveDifferences = countPixelDifferences(
        baselineInactive,
        result.inactive,
      );
      if (inactiveDifferences > 100) {
        throw new Error(
          `${result.label} timed caption changed pixels before its cue (${inactiveDifferences} differing bytes)`,
        );
      }
    }
    if (
      countPixelDifferences(activeFrames[0].frame, activeFrames[1].frame) < 100 ||
      countPixelDifferences(activeFrames[1].frame, activeFrames[2].frame) < 100
    ) {
      throw new Error("Timed caption themes did not produce distinct frames");
    }
    const logs = run("docker", ["logs", timedContainer]);
    if (!logs.includes("between(t\\,1.000\\,2.500)")) {
      throw new Error("Encoder logs did not show the cue timing expression");
    }
    console.log("Encoder timed-caption contract test passed");
  } finally {
    run("docker", ["rm", "-f", timedContainer]);
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
    if (logs.includes("encode: stream-copy (no re-encode needed)")) {
      throw new Error(
        "Upload job with trim_start=2.5 must re-encode, not stream-copy",
      );
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

function runRetainedYoutubeSourceContract(frameCounterPath: string) {
  const retainedOutputDir = path.join(outputDir, "youtube-retained-source");
  fs.rmSync(retainedOutputDir, { recursive: true, force: true });
  fs.mkdirSync(retainedOutputDir, { recursive: true });

  const jobId = "youtube-retained-source";
  const jobPath = path.join(retainedOutputDir, "job.json");
  fs.writeFileSync(
    jobPath,
    JSON.stringify({
      jobId,
      source: {
        type: "youtube",
        url: "https://www.youtube.com/watch?v=retained-source",
      },
      trimStart: 2,
      trimEnd: 5,
      caption: null,
      filters: [],
      quality: "1080p",
      outputs: {
        mp4Key: "clips/retained/clip.mp4",
        thumbnailKey: "clips/retained/thumbnail.jpg",
      },
      retainSourceArtifact: true,
      deferArtifactUpload: true,
    }),
  );

  const retainedContainer = `${containerName}-retained-source`;
  const encoderPort = 18096;
  try {
    const retained = runEncoderYoutubeJob(
      retainedContainer,
      encoderPort,
      jobPath,
      {
        fakeYtdlpPath: path.join(fixturesDir, "fake-ytdlp-full.sh"),
        outputDir: retainedOutputDir,
        frameCounterPath,
      },
    );
    if (retained.result.status !== "staged") {
      throw new Error(
        `Expected staged retained source, got ${retained.result.status}: ${retained.result.errorMessage ?? ""}`,
      );
    }
    if (retained.logs.includes("--download-sections")) {
      throw new Error("Retained source unexpectedly used a section download");
    }
    if (!retained.logs.includes("--remux-video mp4")) {
      throw new Error("Retained source did not request MP4 remuxing");
    }

    for (const name of ["source.mp4", "clip.mp4", "thumbnail.jpg"]) {
      const probe = spawnSync(
        "curl",
        [
          "-sS",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          `http://127.0.0.1:${encoderPort}/outputs/${jobId}/${name}`,
        ],
        { encoding: "utf-8" },
      );
      if (probe.stdout?.trim() !== "200") {
        throw new Error(`Retained output ${name} was not served`);
      }
    }

    console.log("Encoder retained YouTube source contract test passed");
  } finally {
    run("docker", ["rm", "-f", retainedContainer]);
  }
}

function runStageSourceContract(frameCounterPath: string) {
  fs.mkdirSync(outputDir, { recursive: true });
  const encoderPort = 18084;
  const stageContainer = `${containerName}-stage-source`;
  const jobId = "stage-source-contract";

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
    "/stage-source?job=${jobId}",
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

    for (const [endpoint, badJob] of [
      ["stage-source", "bad%2Fjob"],
      ["stage-source", "bad.job"],
      ["cleanup", "bad.job"],
    ] as const) {
      const invalidJob = spawnSync(
        "curl",
        [
          "-sS",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "-X",
          "POST",
          `http://127.0.0.1:${encoderPort}/${endpoint}?job=${badJob}`,
          "-H",
          "Content-Length: 4",
          "--data-binary",
          "test",
        ],
        { encoding: "utf-8" },
      );
      if (invalidJob.stdout?.trim() !== "400") {
        throw new Error(
          `Expected 400 for /${endpoint} with invalid job=${badJob}, got ${invalidJob.stdout}`,
        );
      }
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
        `http://127.0.0.1:${encoderPort}/stage-source?job=${jobId}`,
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
from encoder import staged_source_path

staged = staged_source_path(${JSON.stringify(jobId)})
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
    f"POST /stage-source?job=${jobId} HTTP/1.1\\r\\n"
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
from encoder import staged_source_path

staged = staged_source_path(${JSON.stringify(jobId)})
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

function runSequentialTwoJobContract(frameCounterPath: string) {
  const sequentialDir = path.join(outputDir, "sequential-two-job");
  fs.rmSync(sequentialDir, { recursive: true, force: true });
  fs.mkdirSync(sequentialDir, { recursive: true });

  const firstJobId = "sequential-job-1";
  const secondJobId = "sequential-job-2";
  const trimStart = 2.5;
  const trimEnd = 5;

  // Byte-for-byte mirror of the EncoderContainer DO call sequence for each
  // job: POST /stage-source?job=X (source bytes) → POST /run with
  // source={type:"file", path:"/tmp/carpo-src-X"} + deferArtifactUpload →
  // GET /outputs/X/... → POST /cleanup?job=X. The staged source MUST survive
  // the run-start defensive cleanup, which is exactly the flow production
  // upload clips and GIF exports use.
  const jobFor = (jobId: string, prefix: string) => ({
    jobId,
    source: { type: "file", path: `/tmp/carpo-src-${jobId}` },
    trimStart,
    trimEnd,
    deferArtifactUpload: true,
    outputs: {
      mp4Key: `${prefix}.mp4`,
      thumbnailKey: `${prefix}.jpg`,
    },
  });

  const firstJobPath = path.join(sequentialDir, "first-job.json");
  const secondJobPath = path.join(sequentialDir, "second-job.json");
  fs.writeFileSync(firstJobPath, JSON.stringify(jobFor(firstJobId, "first")));
  fs.writeFileSync(secondJobPath, JSON.stringify(jobFor(secondJobId, "second")));

  const sequentialContainer = `${containerName}-sequential`;
  const encoderPort = 18079;
  run("docker", ["rm", "-f", sequentialContainer]);
  run("docker", [
    "run",
    "-d",
    "--name",
    sequentialContainer,
    "-p",
    `${encoderPort}:8080`,
    imageName,
  ]);

  const sourceBytes = fs.readFileSync(frameCounterPath);

  const stageSource = (jobId: string) => {
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
        `http://127.0.0.1:${encoderPort}/stage-source?job=${jobId}`,
        "-H",
        `Content-Length: ${sourceBytes.length}`,
        "-H",
        "Content-Type: video/mp4",
        "--data-binary",
        `@${frameCounterPath}`,
      ],
      { encoding: "utf-8" },
    );
    if (staged.stdout?.trim() !== "204") {
      throw new Error(
        `stage-source for ${jobId} failed (${staged.stdout})`,
      );
    }
  };

  const runJob = (jobPath: string, label: string) => {
    const encode = spawnSync(
      "curl",
      [
        "-fsS",
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
    if (encode.status !== 0) {
      const logs = run("docker", ["logs", sequentialContainer]);
      throw new Error(
        `${label} sequential job failed\n${encode.stderr}\ncontainer logs:\n${logs}`,
      );
    }
    const result = JSON.parse(encode.stdout) as {
      status: string;
      errorMessage?: string;
    };
    if (result.status !== "staged") {
      throw new Error(
        `${label} job expected staged status, got ${result.status}: ${result.errorMessage ?? ""}`,
      );
    }
  };

  const outputStatus = (jobId: string, name: string): string => {
    const probe = spawnSync(
      "curl",
      [
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        `http://127.0.0.1:${encoderPort}/outputs/${jobId}/${name}`,
      ],
      { encoding: "utf-8" },
    );
    return probe.stdout?.trim() ?? "";
  };

  const cleanupJob = (jobId: string) => {
    const cleanup = spawnSync(
      "curl",
      [
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "-X",
        "POST",
        `http://127.0.0.1:${encoderPort}/cleanup?job=${jobId}`,
      ],
      { encoding: "utf-8" },
    );
    if (cleanup.stdout?.trim() !== "204") {
      throw new Error(`Cleanup for ${jobId} failed (${cleanup.stdout})`);
    }
  };

  const assertStagedSourceGone = (jobId: string) => {
    const script = `
import sys
sys.path.insert(0, "/app")
from encoder import staged_source_path
assert not staged_source_path(${JSON.stringify(jobId)}).exists(), "staged source not cleaned"
print("staged source cleaned for ${jobId}")
`;
    run("docker", ["exec", sequentialContainer, "python3", "-c", script]);
  };

  try {
    waitForHealth(encoderPort);

    stageSource(firstJobId);
    runJob(firstJobPath, "First");
    if (outputStatus(firstJobId, "clip.mp4") !== "200") {
      throw new Error("First job MP4 not served");
    }
    if (outputStatus(firstJobId, "thumbnail.jpg") !== "200") {
      throw new Error("First job thumbnail not served");
    }
    cleanupJob(firstJobId);
    assertStagedSourceGone(firstJobId);

    stageSource(secondJobId);
    runJob(secondJobPath, "Second");
    if (outputStatus(secondJobId, "clip.mp4") !== "200") {
      throw new Error("Second job MP4 not served");
    }
    if (outputStatus(firstJobId, "clip.mp4") !== "404") {
      throw new Error("First job outputs should remain cleaned up");
    }
    cleanupJob(secondJobId);
    assertStagedSourceGone(secondJobId);
    if (outputStatus(secondJobId, "clip.mp4") !== "404") {
      throw new Error("Second job outputs were not cleaned up");
    }

    console.log("Encoder sequential two-job contract test passed");
  } finally {
    run("docker", ["rm", "-f", sequentialContainer]);
  }
}

function main() {
  assertDockerAvailable();
  assertFfmpegAvailable();
  const { barsPath, frameCounterPath, frameCounterHdPath } = ensureFixtureVideo();
  testClipRangeValidation();
  testLongClipEncoding();
  testSourceFileSelection();
  testEncodeErrorClassification();
  testYoutubeErrorClassification();
  testYtdlpStallLineDetection();
  testRetainedSourceDownloadCommand();
  testYoutubeMetadataParsing();
  testYoutubeTranscriptParsing();
  testAudioChunkWindows();
  testSectionEncodeBounds();
  testStreamCopyGate();
  buildImage();
  testImageToolchainSmoke();
  testAudioChunkExtraction(barsPath);
  testSampleFrameExtraction(barsPath);
  testProcessGroupKill();
  runStageSourceContract(frameCounterPath);
  runSequentialTwoJobContract(frameCounterPath);
  runEncoderYoutubeFailFastContract(frameCounterPath);
  runEncoderQualityContract(frameCounterPath, frameCounterHdPath);
  runEncoderEncodeFailureContract();
  runEncoderContract(barsPath, frameCounterPath);
  runEncoderGifContract(barsPath);
  runRetainedYoutubeSourceContract(frameCounterPath);
  runEncoderUploadContract(frameCounterPath);
  runEncoderCaptionContract(barsPath, frameCounterPath);
  runEncoderTimedCaptionContract(barsPath);
}

main();
