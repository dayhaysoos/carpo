#!/usr/bin/env python3
"""Unit tests for carpo_helper pure logic."""

from __future__ import annotations

import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from carpo_helper import (
    API_TIMEOUT_FLOOR_SECONDS,
    API_TIMEOUT_SECONDS,
    DeadlineExceeded,
    DeadlineReader,
    JOB_DEADLINE_SECONDS,
    MIN_PUT_BUDGET_SECONDS,
    YTDLP_SUBPROCESS_TIMEOUT_SECONDS,
    api_timeout_for_budget,
    build_ytdlp_command,
    content_type_for_path,
    load_config,
    SECTION_MISALIGNED_MESSAGE,
    SECTION_TOO_SHORT_MESSAGE,
    parse_claim_payload,
    poll_process,
    remaining_budget,
    render_config_json,
    resolve_upload_url,
    section_alignment_error,
    section_bounds,
    truncate_error_message,
    validate_config,
    ytdlp_format_for_quality,
    ytdlp_timeout_for_budget,
)


class SectionBoundsTests(unittest.TestCase):
    def test_padded_bounds(self) -> None:
        start, end = section_bounds(10.0, 20.0)
        self.assertEqual(start, 7.0)
        self.assertEqual(end, 23.0)

    def test_trim_start_below_padding(self) -> None:
        start, end = section_bounds(1.0, 10.0)
        self.assertEqual(start, 0.0)
        self.assertEqual(end, 13.0)

    def test_zero_trim_start(self) -> None:
        start, end = section_bounds(0.0, 5.0)
        self.assertEqual(start, 0.0)
        self.assertEqual(end, 8.0)


class YtdlpFormatTests(unittest.TestCase):
    def test_720p_matches_container(self) -> None:
        format_sort, format_selector = ytdlp_format_for_quality("720p")
        self.assertEqual(format_sort, "res:720,+codec:h264")
        self.assertEqual(
            format_selector,
            "bestvideo[height<=720][vcodec^=avc1]+bestaudio/"
            "bestvideo[height<=720]+bestaudio/"
            "best[height<=720]/"
            "bestvideo[vcodec^=av01][height<=720]+bestaudio/"
            "bestvideo[height<=720]+bestaudio/"
            "best",
        )

    def test_1080p_matches_container(self) -> None:
        format_sort, format_selector = ytdlp_format_for_quality("1080p")
        self.assertEqual(format_sort, "res:1080,+codec:h264")
        self.assertEqual(
            format_selector,
            "bestvideo[height<=1080][vcodec^=avc1]+bestaudio/"
            "bestvideo[height<=1080]+bestaudio/"
            "best[height<=1080]/"
            "bestvideo[vcodec^=av01][height<=720]+bestaudio/"
            "bestvideo[height<=720]+bestaudio/"
            "best",
        )

    def test_unknown_quality_defaults_to_1080(self) -> None:
        format_sort, _ = ytdlp_format_for_quality("4k")
        self.assertEqual(format_sort, "res:1080,+codec:h264")


class YtdlpCommandTests(unittest.TestCase):
    def test_command_includes_sections_and_keyframes(self) -> None:
        command = build_ytdlp_command(
            yt_dlp_path="yt-dlp",
            url="https://youtu.be/abc",
            section_start=7.0,
            section_end=23.0,
            quality="720p",
            output_dir=Path("/tmp/work"),
            cookies_from_browser="chrome",
        )
        self.assertIn("--download-sections", command)
        self.assertIn("*7.0-23.0", command)
        self.assertIn("--force-keyframes-at-cuts", command)
        self.assertIn("--cookies-from-browser", command)
        self.assertIn("chrome", command)

    def test_command_omits_cookies_when_disabled(self) -> None:
        command = build_ytdlp_command(
            yt_dlp_path="yt-dlp",
            url="https://youtu.be/abc",
            section_start=0.0,
            section_end=10.0,
            quality="1080p",
            output_dir=Path("/tmp/work"),
            cookies_from_browser=None,
        )
        self.assertNotIn("--cookies-from-browser", command)


class ConfigValidationTests(unittest.TestCase):
    def test_valid_minimal_config(self) -> None:
        config = validate_config(
            {"baseUrl": "https://carpo.example.com", "helperToken": "secret"},
        )
        self.assertEqual(config["baseUrl"], "https://carpo.example.com")
        self.assertEqual(config["helperToken"], "secret")
        self.assertEqual(config["cookiesFromBrowser"], "chrome")
        self.assertEqual(config["pollIntervalSeconds"], 5.0)
        self.assertEqual(config["ytDlpPath"], "yt-dlp")
        self.assertEqual(config["ffprobePath"], "ffprobe")

    def test_invalid_ffprobe_path(self) -> None:
        with self.assertRaisesRegex(ValueError, "ffprobePath"):
            validate_config(
                {
                    "baseUrl": "https://carpo.example.com",
                    "helperToken": "secret",
                    "ffprobePath": "  ",
                },
            )

    def test_missing_base_url(self) -> None:
        with self.assertRaisesRegex(ValueError, "baseUrl"):
            validate_config({"helperToken": "secret"})

    def test_missing_helper_token(self) -> None:
        with self.assertRaisesRegex(ValueError, "helperToken"):
            validate_config({"baseUrl": "https://carpo.example.com"})

    def test_partial_cf_access_credentials(self) -> None:
        with self.assertRaisesRegex(ValueError, "cfAccessClientId"):
            validate_config(
                {
                    "baseUrl": "https://carpo.example.com",
                    "helperToken": "secret",
                    "cfAccessClientId": "id-only",
                },
            )

    def test_load_config_from_file(self) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(
                {
                    "baseUrl": "https://carpo.example.com/",
                    "helperToken": "tok",
                    "cookiesFromBrowser": "",
                },
                handle,
            )
            path = Path(handle.name)
        try:
            config = load_config(path)
            self.assertEqual(config["baseUrl"], "https://carpo.example.com")
            self.assertIsNone(config["cookiesFromBrowser"])
        finally:
            path.unlink()


class UploadUrlResolutionTests(unittest.TestCase):
    def test_absolute_url_unchanged(self) -> None:
        url = "https://cdn.example.com/uploads/foo.mp4"
        self.assertEqual(resolve_upload_url("https://carpo.example.com", url), url)

    def test_relative_path_resolved(self) -> None:
        resolved = resolve_upload_url(
            "https://carpo.example.com",
            "/api/uploads/uploads%2Fabc.mp4",
        )
        self.assertEqual(
            resolved,
            "https://carpo.example.com/api/uploads/uploads%2Fabc.mp4",
        )

    def test_relative_without_leading_slash(self) -> None:
        resolved = resolve_upload_url("https://carpo.example.com", "api/uploads/key.mp4")
        self.assertEqual(resolved, "https://carpo.example.com/api/uploads/key.mp4")


class ErrorTruncationTests(unittest.TestCase):
    def test_short_message_unchanged(self) -> None:
        self.assertEqual(truncate_error_message("short"), "short")

    def test_long_message_truncated(self) -> None:
        message = "x" * 600
        truncated = truncate_error_message(message)
        self.assertEqual(len(truncated), 500)
        self.assertTrue(truncated.endswith("..."))


class DeadlineBudgetTests(unittest.TestCase):
    def test_remaining_budget_positive(self) -> None:
        self.assertEqual(remaining_budget(100.0, 40.0), 60.0)

    def test_remaining_budget_clamped_at_zero(self) -> None:
        self.assertEqual(remaining_budget(100.0, 150.0), 0.0)

    def test_ytdlp_timeout_capped_by_base(self) -> None:
        self.assertEqual(ytdlp_timeout_for_budget(500.0), YTDLP_SUBPROCESS_TIMEOUT_SECONDS)

    def test_ytdlp_timeout_capped_by_budget(self) -> None:
        self.assertEqual(ytdlp_timeout_for_budget(42.0), 42.0)

    def test_ytdlp_timeout_never_negative(self) -> None:
        self.assertEqual(ytdlp_timeout_for_budget(-5.0), 0.0)

    def test_deadline_leaves_safety_margin_under_claim_ttl(self) -> None:
        self.assertLessEqual(JOB_DEADLINE_SECONDS, 300.0 - 60.0)

    def test_put_budget_floor(self) -> None:
        self.assertGreater(MIN_PUT_BUDGET_SECONDS, 0.0)


class SectionAlignmentTests(unittest.TestCase):
    def test_aligned_section_passes(self) -> None:
        self.assertIsNone(section_alignment_error(0.1, 16.0, 20.0, 7.0))

    def test_zero_start_time_passes(self) -> None:
        self.assertIsNone(section_alignment_error(0.0, 13.0, 20.0, 7.0))

    def test_drifted_start_time_fails(self) -> None:
        self.assertEqual(
            section_alignment_error(0.5, 16.0, 20.0, 7.0),
            SECTION_MISALIGNED_MESSAGE,
        )

    def test_negative_drift_fails(self) -> None:
        self.assertEqual(
            section_alignment_error(-0.5, 16.0, 20.0, 7.0),
            SECTION_MISALIGNED_MESSAGE,
        )

    def test_short_duration_fails(self) -> None:
        self.assertEqual(
            section_alignment_error(0.0, 10.0, 20.0, 7.0),
            SECTION_TOO_SHORT_MESSAGE,
        )

    def test_duration_within_slack_passes(self) -> None:
        self.assertIsNone(section_alignment_error(0.0, 12.6, 20.0, 7.0))

    def test_missing_start_time_still_checks_duration(self) -> None:
        self.assertEqual(
            section_alignment_error(None, 10.0, 20.0, 7.0),
            SECTION_TOO_SHORT_MESSAGE,
        )

    def test_missing_duration_still_checks_start(self) -> None:
        self.assertEqual(
            section_alignment_error(1.0, None, 20.0, 7.0),
            SECTION_MISALIGNED_MESSAGE,
        )

    def test_all_missing_proceeds(self) -> None:
        self.assertIsNone(section_alignment_error(None, None, 20.0, 7.0))


class DeadlineReaderTests(unittest.TestCase):
    def test_reads_succeed_before_deadline(self) -> None:
        clock = FakeClock(0.0)
        reader = DeadlineReader(io.BytesIO(b"hello world"), 10.0, clock=clock)
        self.assertEqual(reader.read(5), b"hello")
        self.assertEqual(reader.read(), b" world")

    def test_read_raises_after_deadline(self) -> None:
        clock = FakeClock(20.0)
        reader = DeadlineReader(io.BytesIO(b"hello"), 10.0, clock=clock)
        with self.assertRaises(DeadlineExceeded):
            reader.read(1)

    def test_deadline_crossed_mid_stream(self) -> None:
        clock = FakeClock(0.0)
        reader = DeadlineReader(io.BytesIO(b"abcdef"), 10.0, clock=clock)
        self.assertEqual(reader.read(3), b"abc")
        clock.now = 10.0
        with self.assertRaises(DeadlineExceeded):
            reader.read(3)


class FakeClock:
    def __init__(self, now: float) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


class FakeProcess:
    def __init__(self, finishes_after_polls: int | None = None, returncode: int = 0) -> None:
        self.finishes_after_polls = finishes_after_polls
        self.returncode: int | None = None
        self._final_returncode = returncode
        self.polls = 0
        self.killed = False
        self.reaped = False

    def poll(self) -> int | None:
        self.polls += 1
        if (
            self.finishes_after_polls is not None
            and self.polls > self.finishes_after_polls
        ):
            self.returncode = self._final_returncode
        return self.returncode

    def wait(self) -> int:
        self.reaped = True
        self.returncode = self._final_returncode
        return self.returncode


class PollProcessTests(unittest.TestCase):
    def test_completed_process(self) -> None:
        proc = FakeProcess(finishes_after_polls=2)
        clock = FakeClock(0.0)
        outcome = poll_process(
            proc,
            180.0,
            is_shutdown=lambda: False,
            clock=clock,
            sleep=lambda s: setattr(clock, "now", clock.now + s),
            kill=lambda p: setattr(p, "killed", True),
        )
        self.assertEqual(outcome, "completed")
        self.assertFalse(proc.killed)

    def test_shutdown_kills_and_returns(self) -> None:
        proc = FakeProcess()
        clock = FakeClock(0.0)
        outcome = poll_process(
            proc,
            180.0,
            is_shutdown=lambda: True,
            clock=clock,
            sleep=lambda s: setattr(clock, "now", clock.now + s),
            kill=lambda p: setattr(p, "killed", True),
        )
        self.assertEqual(outcome, "shutdown")
        self.assertTrue(proc.killed)
        self.assertTrue(proc.reaped)

    def test_timeout_kills_and_returns(self) -> None:
        proc = FakeProcess()
        clock = FakeClock(0.0)
        outcome = poll_process(
            proc,
            10.0,
            is_shutdown=lambda: False,
            clock=clock,
            sleep=lambda s: setattr(clock, "now", clock.now + s),
            kill=lambda p: setattr(p, "killed", True),
        )
        self.assertEqual(outcome, "timeout")
        self.assertTrue(proc.killed)
        self.assertTrue(proc.reaped)

    def test_shutdown_mid_download(self) -> None:
        shutdown_state = {"flag": False}
        proc = FakeProcess()
        clock = FakeClock(0.0)

        def sleep(seconds: float) -> None:
            clock.now += seconds
            if clock.now >= 2.0:
                shutdown_state["flag"] = True

        outcome = poll_process(
            proc,
            180.0,
            is_shutdown=lambda: shutdown_state["flag"],
            clock=clock,
            sleep=sleep,
            kill=lambda p: setattr(p, "killed", True),
        )
        self.assertEqual(outcome, "shutdown")
        self.assertTrue(proc.killed)


class ApiTimeoutTests(unittest.TestCase):
    def test_capped_by_base_timeout(self) -> None:
        self.assertEqual(api_timeout_for_budget(500.0), API_TIMEOUT_SECONDS)

    def test_capped_by_budget(self) -> None:
        self.assertEqual(api_timeout_for_budget(30.0), 30.0)

    def test_floor_applied(self) -> None:
        self.assertEqual(api_timeout_for_budget(1.0), API_TIMEOUT_FLOOR_SECONDS)
        self.assertEqual(api_timeout_for_budget(0.0), API_TIMEOUT_FLOOR_SECONDS)


class ParseClaimPayloadTests(unittest.TestCase):
    def valid_payload(self) -> dict:
        return {
            "clipId": "abc",
            "url": "https://youtu.be/xyz",
            "trimStart": 10,
            "trimEnd": 20.5,
            "quality": "720p",
        }

    def test_valid_payload(self) -> None:
        parsed = parse_claim_payload(self.valid_payload())
        self.assertEqual(parsed["url"], "https://youtu.be/xyz")
        self.assertEqual(parsed["trimStart"], 10.0)
        self.assertEqual(parsed["trimEnd"], 20.5)
        self.assertEqual(parsed["quality"], "720p")

    def test_missing_quality_defaults(self) -> None:
        payload = self.valid_payload()
        del payload["quality"]
        self.assertEqual(parse_claim_payload(payload)["quality"], "1080p")

    def test_missing_url(self) -> None:
        payload = self.valid_payload()
        del payload["url"]
        with self.assertRaisesRegex(ValueError, "url"):
            parse_claim_payload(payload)

    def test_empty_url(self) -> None:
        payload = self.valid_payload()
        payload["url"] = "   "
        with self.assertRaisesRegex(ValueError, "url"):
            parse_claim_payload(payload)

    def test_missing_trim_start(self) -> None:
        payload = self.valid_payload()
        del payload["trimStart"]
        with self.assertRaisesRegex(ValueError, "trimStart"):
            parse_claim_payload(payload)

    def test_non_numeric_trim(self) -> None:
        payload = self.valid_payload()
        payload["trimEnd"] = "20"
        with self.assertRaisesRegex(ValueError, "trimEnd"):
            parse_claim_payload(payload)

    def test_boolean_trim_rejected(self) -> None:
        payload = self.valid_payload()
        payload["trimStart"] = True
        with self.assertRaisesRegex(ValueError, "trimStart"):
            parse_claim_payload(payload)

    def test_non_finite_trim(self) -> None:
        payload = self.valid_payload()
        payload["trimStart"] = float("nan")
        with self.assertRaisesRegex(ValueError, "trimStart"):
            parse_claim_payload(payload)

    def test_negative_trim_start(self) -> None:
        payload = self.valid_payload()
        payload["trimStart"] = -1
        with self.assertRaisesRegex(ValueError, "trimStart"):
            parse_claim_payload(payload)

    def test_trim_end_not_greater(self) -> None:
        payload = self.valid_payload()
        payload["trimEnd"] = 10
        with self.assertRaisesRegex(ValueError, "trimEnd"):
            parse_claim_payload(payload)

    def test_non_dict_payload(self) -> None:
        with self.assertRaisesRegex(ValueError, "JSON object"):
            parse_claim_payload(["not", "a", "dict"])


class RenderConfigJsonTests(unittest.TestCase):
    def test_round_trips_plain_values(self) -> None:
        rendered = render_config_json("https://carpo.example.com", "tok", "chrome")
        parsed = json.loads(rendered)
        self.assertEqual(parsed["baseUrl"], "https://carpo.example.com")
        self.assertEqual(parsed["helperToken"], "tok")
        self.assertEqual(parsed["cookiesFromBrowser"], "chrome")

    def test_escapes_quotes_and_backslashes(self) -> None:
        token = 'we"ird\\to"ken'
        rendered = render_config_json("https://x.example", token, "chrome")
        self.assertEqual(json.loads(rendered)["helperToken"], token)

    def test_install_sh_invocation_produces_valid_json(self) -> None:
        helper_dir = str(Path(__file__).resolve().parent)
        snippet = (
            "import sys; sys.path.insert(0, sys.argv[1]); "
            "from carpo_helper import render_config_json; "
            "print(render_config_json(sys.argv[2], sys.argv[3], sys.argv[4]))"
        )
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                snippet,
                helper_dir,
                "https://carpo.example.com",
                'tok"en\\with$pecial`chars',
                "firefox",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        parsed = json.loads(result.stdout)
        self.assertEqual(parsed["helperToken"], 'tok"en\\with$pecial`chars')
        self.assertEqual(parsed["cookiesFromBrowser"], "firefox")


class ContentTypeTests(unittest.TestCase):
    def test_mp4(self) -> None:
        self.assertEqual(content_type_for_path(Path("source.mp4")), "video/mp4")

    def test_unsupported_extension(self) -> None:
        self.assertIsNone(content_type_for_path(Path("source.avi")))


if __name__ == "__main__":
    unittest.main()
