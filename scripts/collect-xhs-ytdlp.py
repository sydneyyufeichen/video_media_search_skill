#!/usr/bin/env python3
import argparse
import json
import re
import shutil
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from yt_dlp import YoutubeDL
from yt_dlp.extractor.xiaohongshu import XiaoHongShuIE
from yt_dlp.utils import js_to_json
from yt_dlp.utils.traversal import traverse_obj


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


def detail_url(row):
    media_id = str(row.get("media_id", ""))
    parsed = urlsplit(str(row.get("url", "")))
    return urlunsplit(("https", "www.xiaohongshu.com", f"/explore/{media_id}", parsed.query, ""))


def flatten_streams(value):
    if isinstance(value, dict):
        if value.get("masterUrl") or value.get("backupUrls"):
            yield value
        for nested in value.values():
            yield from flatten_streams(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from flatten_streams(nested)


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
    with YoutubeDL({"cookiefile": str(cookie_path), "quiet": True, "no_warnings": True}) as ydl:
        extractor = XiaoHongShuIE(ydl)
        webpage = extractor._download_webpage(url, media_id)
        initial_state = extractor._search_json(
            r"window\.__INITIAL_STATE__\s*=", webpage, "initial state", media_id,
            transform_source=js_to_json)
    note = traverse_obj(initial_state, ("note", "noteDetailMap", media_id, "note")) or {}
    if not note:
        raise RuntimeError("note detail missing (possible risk control or expired xsec token)")
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
    with tempfile.TemporaryDirectory(prefix="allmedia_xhs_cookie_") as temporary:
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
    pending = [
        row for row in rows
        if previous.get(str(row.get("media_id", "")), {}).get("detail_status") != "complete"
        or (row.get("type") == "video" and not previous.get(str(row.get("media_id", "")), {}).get("media_url"))
    ]
    print(f"XHS {account}: total={len(rows)} pending={len(pending)}", flush=True)
    if not pending:
        save_json(output_path, [previous.get(str(row.get("media_id", "")), row) for row in rows])
        return
    stalled_batches = 0
    prior_complete = sum(row.get("detail_status") == "complete" for row in previous.values())
    for start in range(0, len(pending), args.batch_size):
        batch = pending[start:start + args.batch_size]
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
                    previous[key] = {
                        **source, "url": detail_url(source), "detail_status": "failed",
                        "detail_source": "authenticated_xhs_page", "detail_error": str(error)[-500:],
                    }
        ordered = [previous.get(str(row.get("media_id", "")), row) for row in rows]
        save_json(output_path, ordered)
        complete = sum(row.get("detail_status") == "complete" for row in ordered)
        print(f"XHS {account}: processed={min(start + len(batch), len(pending))}/{len(pending)} complete={complete}", flush=True)
        stalled_batches = stalled_batches + 1 if complete == prior_complete else 0
        prior_complete = complete
        if stalled_batches >= 2:
            print(f"XHS {account}: stopped after two stalled batches; retry after platform cooldown", flush=True)
            break
        if start + args.batch_size < len(pending):
            time.sleep(args.batch_pause)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest-dir", default="/tmp/allmedia_xhs_manifests_20260823")
    parser.add_argument("--output-dir", default="/tmp/allmedia_xhs_ytdlp_20260824")
    parser.add_argument("--cookies", default="/tmp/allmedia_xhs.cookies.txt")
    parser.add_argument("--seed-dir", action="append", default=[])
    parser.add_argument("--account", default="")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=24)
    parser.add_argument("--batch-pause", type=float, default=2.0)
    args = parser.parse_args()
    manifest = read_json(Path(args.manifest_dir) / "manifest.json", [])
    for entry in manifest:
        account = entry.get("account", "")
        if args.account and account != args.account:
            continue
        slug = account.encode("utf-8").hex()
        rows = [
            row for row in read_json(Path(args.manifest_dir) / f"{slug}.json", [])
            if row.get("type") == "video"
        ]
        process_account(account, rows, Path(args.output_dir) / f"{slug}.json", args)


if __name__ == "__main__":
    main()
