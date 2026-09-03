import importlib.util
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "export-to-markdown.py"
SPEC = importlib.util.spec_from_file_location("export_to_markdown", MODULE_PATH)
EXPORTER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(EXPORTER)


class ExportToMarkdownTests(unittest.TestCase):
    def record(self, platform, url, account="author", likes=42):
        return {
            "Account": account,
            "Platform": platform,
            "Timestamp": "2026-08-30 12:00:00",
            "Caption": "A useful post",
            "Script": "Body",
            "Likes": likes,
            "Comments": 3,
            "URL": url,
        }

    def test_writes_each_platform_with_likes_in_filename(self):
        records = [
            (self.record("xiaohongshu", "https://www.xiaohongshu.com/explore/abc?xsec_token=secret"), EXPORTER.XHS_HEADERS),
            (self.record("instagram", "https://www.instagram.com/p/abc/"), EXPORTER.IG_HEADERS),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "output"
            result = EXPORTER.write_records(records, root)
            self.assertEqual(result["written"], 2)
            for platform in ("xiaohongshu", "instagram"):
                files = list((root / platform).glob("*.md"))
                self.assertEqual(len(files), 1)
                self.assertTrue(files[0].name.startswith("author - 点赞42 - "))
            self.assertEqual(EXPORTER.validate(root)["files"], 2)

    def test_unknown_likes_are_explicit(self):
        self.assertIn("点赞未知", EXPORTER.filename_for("author", None, "title"))

    def test_rejects_wrong_platform_folder(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "output"
            wrong = root / "instagram" / "author - 点赞42 - A useful post.md"
            wrong.parent.mkdir(parents=True)
            wrong.write_text(EXPORTER.markdown(
                self.record("xiaohongshu", "https://www.xiaohongshu.com/explore/abc"),
                EXPORTER.XHS_HEADERS,
            ), encoding="utf-8")
            with self.assertRaises(ValueError):
                EXPORTER.validate(root)


if __name__ == "__main__":
    unittest.main()
