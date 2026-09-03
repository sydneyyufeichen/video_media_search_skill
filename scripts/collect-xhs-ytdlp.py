#!/usr/bin/env python3
import argparse
import json
import math
import re
import shutil
import tempfile
import time
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

warnings.filterwarnings("ignore", message="urllib3 v2 only supports OpenSSL.*")

from yt_dlp import YoutubeDL
from yt_dlp.extractor.xiaohongshu import XiaoHongShuIE
from yt_dlp.utils import js_to_json
from yt_dlp.utils.traversal import traverse_obj


RISK_MARKERS = (
    "401", "403", "429", "461", "captcha", "risk control", "访问频繁",
    "操作频繁", "验证码", "安全验证", "login required", "verify",
)


class QuietYdlLogger:
    def debug(self, _message):
        pass

    def warning(self, _message):
        pass

    def error(self, _message):
        pass


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


def is_risk_error(error):
    message = str(error).lower()
    return any(marker.lower() in message for marker in RISK_MARKERS)


def redact_error(error):
    message = re.sub(r"https?://\\S+", "<url>", str(error))
    message = re.sub(r"(?i)(xsec_token|web_session|a1)=([^&\\s]+)", r"\\1=<redacted>", message)
    return message


def detail_url(row):
    media_id = str(row.get("media_id", ""))
    parsed = urlsplit(str(row.get("url", "")))
    return urlunsplit(("https", "www.xiaohongshu.com", f"/explore/{media_id}", parsed.query, ""))


def valid_signed_row(row):
    media_id = str(row.get("media_id", ""))
    if not re.fullmatch(r"[0-9a-fA-F]{24}", media_id):
        return False
    parsed = urlsplit(str(row.get("url", "")))
    parts = [part for part in parsed.path.split("/") if part]
    return len(parts) >= 4 and parts[-1] == media_id and "xsec_token=" in parsed.query


def flatten_streams(value):
    if isinstance(value, dict):
        if value.get("masterUrl") or value.get("backupUrls"):
            yield value
        for nested in value.values():
            yield from flatten_streams(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from flatten_streams(nested)


def extract_balanced(text, marker):
    start = text.find(marker)
    if start < 0:
        return ""
    index = start + len(marker)
    depth = 0
    in_string = False
    escaped = False
    while index < len(text):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        else:
            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    return text[start + len(marker):index + 1]
        index += 1
    return ""


def parse_note_detail_map(webpage, media_id):
    blob = extract_balanced(webpage, '"noteDetailMap":')
    if not blob:
        raise RuntimeError("noteDetailMap not found in page")
    mapping = json.loads(re.sub(r"\bundefined\b", "null", blob))
    entry = mapping.get(media_id) or next(iter(mapping.values()), {})
    return entry.get("note") or entry.get("noteData") or entry.get("data") or entry


def first_media(note):
    streams = list(flatten_streams(traverse_obj(note, ("video", "media", "stream")) or {}))
    candidates = []
    for stream in streams:
        urls = [*(stream.get("backupUrls") or []), stream.get("masterUrl")]
        for url in urls:
            if isinstance(url, str) and url.startswith("http"):
                candidates.append((stream, url))
    if not candidates:
        return {}, "", []
    return candidates[0][0], candidates[0][1], list(dict.fromkeys(url for _, url in candidates))


def extract_with_cookie(row, cookie_path):
    media_id = str(row.get("media_id", ""))
    url = detail_url(row)
    with YoutubeDL({
        "cookiefile": str(cookie_path), "quiet": True, "no_warnings": True,
        "logger": QuietYdlLogger(),
    }) as ydl:
        extractor = XiaoHongShuIE(ydl)
        webpage = extractor._download_webpage(url, media_id)
        try:
            initial_state = extractor._search_json(
                r"window\.__INITIAL_STATE__\s*=", webpage, "initial state", media_id,
                transform_source=js_to_json)
            note = traverse_obj(initial_state, ("note", "noteDetailMap", media_id, "note")) or {}
        except Exception:
            note = parse_note_detail_map(webpage, media_id) or {}
    if not note:
        raise RuntimeError("note detail missing")
    interact = note.get("interactInfo") or note.get("interact_info") or {}
    stream, media_url, media_urls = first_media(note)
    duration_ms = stream.get("duration")
    if duration_ms is None:
        duration_ms = traverse_obj(note, ("video", "media", "video", "duration"))
    return {
        **row,
        "url": url,
        "type": note.get("type") or row.get("type"),
        "is_video": (note.get("type") or row.get("type")) == "video",
        "title": note.get("title") or row.get("title", ""),
        "caption": note.get("desc") or "",
        "published_at": note.get("time"),
        "updated_at": note.get("lastUpdateTime"),
        "likes": interact.get("likedCount") or row.get("likes"),
        "comments": interact.get("commentCount"),
        "shares": interact.get("shareCount"),
        "collects": interact.get("collectedCount"),
        "duration_seconds": (float(duration_ms) / 1000) if duration_ms not in (None, "") else None,
        "media_url": media_url,
        "media_urls": media_urls,
        "detail_status": "complete",
        "detail_source": "authenticated_xhs_page",
    }


def extract_row(row, cookie_file, isolate_cookie):
    if not isolate_cookie:
        return extract_with_cookie(row, cookie_file)
    with tempfile.TemporaryDirectory(prefix="video_media_search_xhs_cookie_") as temporary:
        isolated_cookie = Path(temporary) / "cookies.txt"
        shutil.copyfile(cookie_file, isolated_cookie)
        return extract_with_cookie(row, isolated_cookie)


def process_account(account, rows, output_path, args):
    previous = {}
    slug = account.encode("utf-8").hex()
    for seed_dir in args.seed_dir:
        for filename in (f"{slug}.json", f"xiaohongshu_{slug}.json"):
            for row in read_json(Path(seed_dir) / filename, []):
                if row.get("media_url"):
                    previous[str(row.get("media_id", ""))] = {
                        **row, "is_video": row.get("is_video") is True or row.get("type") == "video",
                        "detail_status": "complete", "detail_source": row.get("detail_source", "prior_capture")}
    previous.update({str(row.get("media_id", "")): row for row in read_json(output_path, [])})
    for row in previous.values():
        if row.get("is_video") is None and row.get("type") == "video":
            row["is_video"] = True
    def needs_primary(row):
        prior = previous.get(str(row.get("media_id", "")), {})
        error = str(prior.get("detail_error") or prior.get("error") or "")
        if "noteDetailMap not found in page" in error or "note detail missing" in error:
            return False
        return (
            prior.get("detail_status") != "complete"
            or (row.get("type") == "video" and not prior.get("media_url"))
        )

    pending = [row for row in rows if needs_primary(row)]
    if args.limit:
        pending = pending[:args.limit]
    print(f"XHS {account}: total={len(rows)} pending={len(pending)}", flush=True)
    if not pending:
        save_json(output_path, [previous.get(str(row.get("media_id", "")), row) for row in rows])
        return True
    stalled_batches = 0
    prior_complete = sum(row.get("detail_status") == "complete" for row in previous.values())
    for start in range(0, len(pending), args.batch_size):
        batch = pending[start:start + args.batch_size]
        batch_errors = []
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {
                pool.submit(extract_row, row, args.cookies, args.workers > 1): row
                for row in batch
            }
            for future in as_completed(futures):
                source = futures[future]
                key = str(source.get("media_id", ""))
                try:
                    previous[key] = future.result()
                except Exception as error:
                    batch_errors.append(str(error))
                    previous[key] = {
                        **source, "url": detail_url(source), "detail_status": "failed",
                        "detail_source": "authenticated_xhs_page", "detail_error": str(error)[-500:],
                    }
        ordered = [previous.get(str(row.get("media_id", "")), row) for row in rows]
        save_json(output_path, ordered)
        complete = sum(row.get("detail_status") == "complete" for row in ordered)
        print(f"XHS {account}: processed={min(start + len(batch), len(pending))}/{len(pending)} complete={complete}", flush=True)
        risk_error = next((error for error in batch_errors if is_risk_error(error)), "")
        if risk_error:
            print(f"XHS {account}: RISK_STOP {redact_error(risk_error)[-240:]}", flush=True)
            return False
        failure_limit = max(3, math.ceil(len(batch) * 0.2))
        parser_fallback_only = batch_errors and all(
            "noteDetailMap not found in page" in error or "note detail missing" in error
            for error in batch_errors
        )
        if len(batch_errors) >= failure_limit and not parser_fallback_only:
            print(
                f"XHS {account}: QUALITY_STOP failures={len(batch_errors)}/{len(batch)}",
                flush=True,
            )
            return False
        if parser_fallback_only:
            print(f"XHS {account}: OPENCLI_FALLBACK_QUEUED rows={len(batch_errors)}", flush=True)
        stalled_batches = 0 if parser_fallback_only else (stalled_batches + 1 if complete == prior_complete else 0)
        prior_complete = complete
        if stalled_batches >= 2:
            print(f"XHS {account}: stopped after two stalled batches; retry after platform cooldown", flush=True)
            return False
        if start + args.batch_size < len(pending):
            time.sleep(args.batch_pause)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest-dir", default="/tmp/video_media_search_xhs_manifests_20260823")
    parser.add_argument("--output-dir", default="/tmp/video_media_search_xhs_ytdlp_20260824")
    parser.add_argument("--cookies", default="/tmp/video_media_search_xhs.cookies.txt")
    parser.add_argument("--seed-dir", action="append", default=[])
    parser.add_argument("--account", default="")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=24)
    parser.add_argument("--batch-pause", type=float, default=2.0)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    manifest = read_json(Path(args.manifest_dir) / "manifest.json", [])
    account_names = [args.account] if args.account else [entry.get("account", "") for entry in manifest]
    all_ok = True
    for account in account_names:
        if not account:
            continue
        slug = account.encode("utf-8").hex()
        rows = [
            row for row in read_json(Path(args.manifest_dir) / f"{slug}.json", [])
            if row.get("type") != "normal" and valid_signed_row(row)
        ]
        if not rows:
            print(f"XHS {account}: no signed candidates in manifest", flush=True)
            all_ok = False
            continue
        ok = process_account(account, rows, Path(args.output_dir) / f"{slug}.json", args)
        all_ok = all_ok and ok
        if not ok:
            break
    if not all_ok:
        raise SystemExit(3)


if __name__ == "__main__":
    main()
