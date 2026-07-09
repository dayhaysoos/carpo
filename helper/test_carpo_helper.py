#!/usr/bin/env python3
"""Unit tests for carpo_helper pure logic."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from carpo_helper import (
    JOB_DEADLINE_SECONDS,
    MIN_PUT_BUDGET_SECONDS,
    YTDLP_SUBPROCESS_TIMEOUT_SECONDS,
    build_ytdlp_command,
    content_type_for_path,
    load_config,
    remaining_budget,
    render_config_json,
    resolve_upload_url,
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
