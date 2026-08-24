#!/usr/bin/env python3
import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
from pathlib import Path

import requests
from mlx_whisper import transcribe


IG_ACCOUNTS = ["wellness.with.gloria", "tcmbycheehee", "dr.franktcm", "yourtcmguide"]
XHS_ACCOUNTS = ["阿飞泡枸杞", "欧阳会食养", "小七养生说", "肖食儿", "养生小禾", "袁姐姐全息健康笔记"]


def read_json(path, fallback):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return fallback


def save_json(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(target)


def shortcode(url):
    match = re.search(r"instagram\.com/(?:p|reel)/([^/?#]+)", str(url), re.I)
    return match.group(1) if match else ""


def transcribe_file(media_path, model, language=None, timeout_seconds=180, initial_prompt=None):
    def handle_timeout(_signum, _frame):
        raise TimeoutError(f"transcription timed out after {timeout_seconds}s")

    previous_handler = signal.signal(signal.SIGALRM, handle_timeout)
    signal.setitimer(signal.ITIMER_REAL, timeout_seconds)
    try:
        result = transcribe(
            str(media_path),
            path_or_hf_repo=model,
            verbose=None,
            language=language,
            initial_prompt=initial_prompt,
            temperature=0,
            condition_on_previous_text=True,
        )
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
    return {
        "transcript": str(result.get("text", "")).strip(),
        "language": result.get("language", language or ""),
        "duration_seconds": max((segment.get("end", 0) for segment in result.get("segments", [])), default=0),
    }


def download_instagram(url, cookie_file, yt_dlp, target_dir):
    template = str(Path(target_dir) / "media_%(playlist_index|0)03d_%(id)s.%(ext)s")
    run = subprocess.run([
        yt_dlp, "--cookies", cookie_file, "--no-playlist", "--quiet", "--no-warnings",
        "-f", "bestaudio/best", "-o", template, url,
    ], text=True, capture_output=True, timeout=180)
    files = sorted(path for path in Path(target_dir).glob("media_*.*") if path.is_file())
    if not files:
        raise RuntimeError((run.stderr or run.stdout or f"yt-dlp exit {run.returncode}").strip()[-500:])
    return files


def download_xhs(urls, target_dir):
    urls = [urls] if isinstance(urls, str) else list(urls or [])
    urls = [url for url in urls if str(url).startswith("http")]
    if not urls:
        raise RuntimeError("no downloadable media URL")
    target = Path(target_dir) / "media.mp4"
    last_error = None
    for url in urls:
        try:
            with requests.get(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.xiaohongshu.com/"}, stream=True, timeout=90) as response:
                response.raise_for_status()
                with target.open("wb") as output:
                    for chunk in response.iter_content(1024 * 1024):
                        if chunk:
                            output.write(chunk)
            if target.stat().st_size >= 1024:
                return target
        except Exception as error:
            last_error = error
            target.unlink(missing_ok=True)
    if last_error:
        raise last_error
    if target.stat().st_size < 1024:
        raise RuntimeError("downloaded media is empty")
    return target


def transcribe_instagram(args):
    seeds = read_json(args.reference_transcripts, {})
    for account in IG_ACCOUNTS:
        if args.account and account != args.account:
            continue
        rows = read_json(Path(args.instagram_capture_dir) / f"instagram_{account}.json", [])
        if args.limit:
            rows = rows[:args.limit]
        output_path = Path(args.output_dir) / f"instagram_{account}.json"
        output = read_json(output_path, {})
        for index, row in enumerate(rows, 1):
            key = shortcode(row.get("url")) or str(row.get("media_id", ""))
            if not key:
                continue
            if str(seeds.get(account, {}).get(key, "")).strip():
                output[key] = {
                    "transcript": seeds[account][key], "language": "", "status": "complete",
                    "source": "reference_attachment", "url": row.get("url", ""),
                }
                continue
            if output.get(key, {}).get("status") in ("complete", "no_speech"):
                continue
            try:
                with tempfile.TemporaryDirectory(prefix="allmedia_ig_") as temporary:
                    media_files = download_instagram(row.get("url", ""), args.instagram_cookie_file, args.yt_dlp, temporary)
                    parts = []
                    media_errors = []
                    for media in media_files:
                        try:
                            parts.append(transcribe_file(media, args.model, timeout_seconds=args.transcribe_timeout))
                        except Exception as error:
                            message = str(error)
                            if "does not contain any stream" in message or "Failed to load audio" in message:
                                continue
                            media_errors.append(message)
                    if not parts and media_errors:
                        raise RuntimeError(" | ".join(media_errors)[-1000:])
                    result = {
                        "transcript": "\n\n".join(part["transcript"] for part in parts if part.get("transcript")),
                        "language": next((part.get("language", "") for part in parts if part.get("language")), ""),
                        "duration_seconds": sum(part.get("duration_seconds", 0) or 0 for part in parts),
                    }
                status = "complete" if result.get("transcript") else "no_speech"
                output[key] = {**result, "status": status, "source": "whisper_asr", "url": row.get("url", "")}
            except Exception as error:
                output[key] = {"transcript": "", "status": "failed", "error": str(error), "url": row.get("url", "")}
            save_json(output_path, output)
            print(f"IG {account} {index}/{len(rows)} status={output[key]['status']}", flush=True)


def transcribe_xhs(args):
    for name in XHS_ACCOUNTS:
        if args.account and name != args.account:
            continue
        slug = name.encode("utf-8").hex()
        rows = read_json(Path(args.xhs_details_dir) / f"{slug}.json", [])
        if not rows:
            rows = read_json(Path(args.xhs_details_dir) / f"xiaohongshu_{slug}.json", [])
        rows = [
            row for row in rows
            if row.get("detail_status") == "complete"
            and (row.get("is_video") is True or (row.get("is_video") is None and row.get("type") == "video"))
        ]
        if args.limit:
            rows = rows[:args.limit]
        output_path = Path(args.output_dir) / f"xiaohongshu_{slug}.json"
        output = read_json(output_path, {})
        for index, row in enumerate(rows, 1):
            key = str(row.get("media_id", ""))
            if not key or output.get(key, {}).get("status") in ("complete", "no_speech"):
                continue
            try:
                with tempfile.TemporaryDirectory(prefix="allmedia_xhs_") as temporary:
                    media = download_xhs(row.get("media_urls") or row.get("media_url", ""), temporary)
                    result = transcribe_file(
                        media, args.model, language="zh", timeout_seconds=args.transcribe_timeout,
                        initial_prompt="以下是中医、食养、健康科普类视频，请准确转写节气、穴位、中药材、方剂和养生术语。",
                    )
                status = "complete" if result.get("transcript") else "no_speech"
                output[key] = {**result, "status": status, "source": "whisper_asr", "url": row.get("url", "")}
            except Exception as error:
                output[key] = {"transcript": "", "status": "failed", "error": str(error), "url": row.get("url", "")}
            save_json(output_path, output)
            print(f"XHS {name} {index}/{len(rows)} status={output[key]['status']}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform", choices=["instagram", "xiaohongshu", "all"], default="all")
    parser.add_argument("--account", default="")
    parser.add_argument("--instagram-capture-dir", default="/tmp/allmedia_full_capture_20260823")
    parser.add_argument("--instagram-cookie-file", default="/tmp/allmedia_instagram.cookies.txt")
    parser.add_argument("--reference-transcripts", default="/tmp/allmedia_reference_transcripts.json")
    parser.add_argument("--xhs-details-dir", default="/tmp/allmedia_xhs_ytdlp_20260824")
    parser.add_argument("--output-dir", default="/tmp/allmedia_transcripts_20260823")
    parser.add_argument("--model", default="mlx-community/whisper-large-v3-turbo")
    parser.add_argument("--transcribe-timeout", type=int, default=180)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--yt-dlp", default=shutil.which("yt-dlp") or "yt-dlp")
    args = parser.parse_args()
    os.environ["PATH"] = f"{Path(os.sys.executable).parent}:{os.environ.get('PATH', '')}"
    if args.platform in ("instagram", "all"):
        transcribe_instagram(args)
    if args.platform in ("xiaohongshu", "all"):
        transcribe_xhs(args)


if __name__ == "__main__":
    main()
