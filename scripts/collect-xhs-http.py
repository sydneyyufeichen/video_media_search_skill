#!/usr/bin/env python3
"""Collect Xiaohongshu note details via plain HTTP (no browser automation).

Reads a manifests directory produced by collect-xhs-manifests.mjs and fetches the
full note detail (title, caption, likes/comments/shares, duration, media URL,
publish time) for each note by requesting the note page and parsing the embedded
``__INITIAL_STATE__.note.noteDetailMap`` JSON.

This is intentionally lighter than the browser-based note-details-batch adapter:
one plain HTTP GET per note, with configurable delay and retry/backoff, which is
far less likely to trigger Xiaohongshu risk control.

Usage:
    python3 scripts/collect-xhs-http.py <manifests-dir> <details-dir> \
        [--cookies /tmp/video_media_search_xhs.cookies.txt] [--delay 1.2] \
        [--account 养生小禾] [--limit N] [--retries 3]

Output: for each account, a <hex(account)>.json file under <details-dir> with one
detail row per note (detail_status: complete | failed), matching the shape the
downstream scripts (transcribe-datasets.py, prepare-incremental-rows.mjs) expect.
"""

import argparse
import json
import re
import time
from pathlib import Path

import requests

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    ),
    "Referer": "https://www.xiaohongshu.com/",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def load_cookies(path):
    cookies = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.startswith("#") or not line.strip():
            continue
        parts = line.strip().split("\t")
        if len(parts) == 7:
            cookies[parts[5]] = parts[6]
    return cookies


def extract_balanced(text, marker):
    """Return the balanced JSON object starting right after `marker`."""
    start = text.find(marker)
    if start < 0:
        return None
    i = start + len(marker)
    n = len(text)
    depth = 0
    in_str = False
    esc = False
    while i < n:
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return text[start + len(marker):i + 1]
        i += 1
    return None


def parse_count(value):
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("万"):
        try:
            return int(float(text[:-1]) * 10000)
        except ValueError:
            return None
    try:
        return int(float(text))
    except ValueError:
        return None


def format_utc(ms):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(ms / 1000)) if ms else None


def pick_video_stream(video):
    """Return (master_url, duration_seconds) from the note's video media stream."""
    if not isinstance(video, dict):
        return "", None
    media = video.get("media") or {}
    stream = media.get("stream") or {}
    best = None
    for items in stream.values():
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict) or not item.get("masterUrl"):
                continue
            if best is None or (item.get("bitrate") or 0) > (best.get("bitrate") or 0):
                best = item
    if not best:
        return "", None
    duration_ms = best.get("duration") or best.get("videoDuration")
    duration = round(duration_ms / 1000, 2) if duration_ms else None
    return best["masterUrl"], duration


def fetch_note(url, cookies, session):
    response = session.get(url, cookies=cookies, headers=DEFAULT_HEADERS, timeout=30)
    if response.status_code != 200:
        raise RuntimeError(f"HTTP {response.status_code}")
    blob = extract_balanced(response.text, '"noteDetailMap":')
    if not blob:
        raise RuntimeError("noteDetailMap not found in page")
    blob = re.sub(r"\bundefined\b", "null", blob)
    mapping = json.loads(blob)
    key = next(iter(mapping.keys()), None)
    if not key:
        raise RuntimeError("empty noteDetailMap")
    note = mapping[key].get("note") or {}
    if not note:
        raise RuntimeError("note object missing")
    return note


def build_row(note, page_url, fallback_title="", fallback_published_ms=None, fallback_cover=""):
    note_id = str(note.get("noteId") or "")
    title = str(note.get("title") or fallback_title or "").strip()
    desc = str(note.get("desc") or "").strip()
    if desc.startswith(title) and title:
        caption = desc
    else:
        caption = (title + ("\n" + desc if desc else "")).strip()
    is_video = note.get("type") == "video"
    interact = note.get("interactInfo") or {}
    media_url, duration = pick_video_stream(note.get("video")) if is_video else ("", None)
    image_list = note.get("imageList") or []
    cover = (image_list[0].get("urlDefault") if image_list else "") or fallback_cover or ""
    published_ms = note.get("lastUpdateTime") or fallback_published_ms
    return {
        "media_id": note_id,
        "title": title,
        "caption": caption,
        "type": note.get("type") or ("normal" if not is_video else "video"),
        "is_video": is_video,
        "likes": parse_count(interact.get("likedCount")),
        "comments": parse_count(interact.get("commentCount")),
        "shares": parse_count(interact.get("shareCount")),
        "collected": parse_count(interact.get("collectedCount")),
        "duration_seconds": duration,
        "media_url": media_url,
        "media_urls": [media_url] if media_url else [],
        "cover_url": cover,
        "page_url": page_url,
        "published_at": format_utc(published_ms),
        "last_update_time": published_ms,
        "detail_status": "complete",
        "error": "",
    }


def row_is_done(row):
    if not row or row.get("detail_status") != "complete":
        return False
    if row.get("is_video"):
        return bool(row.get("media_url"))
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifests_dir")
    parser.add_argument("details_dir")
    parser.add_argument("--cookies", default="/tmp/video_media_search_xhs.cookies.txt")
    parser.add_argument("--delay", type=float, default=1.2, help="seconds between requests")
    parser.add_argument("--account", default="", help="only process this account")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--retries", type=int, default=3)
    args = parser.parse_args()

    manifests_dir = Path(args.manifests_dir)
    details_dir = Path(args.details_dir)
    details_dir.mkdir(parents=True, exist_ok=True)
    cookies = load_cookies(args.cookies)
    if not cookies:
        raise SystemExit(f"no cookies loaded from {args.cookies}")

    manifest = json.loads((manifests_dir / "manifest.json").read_text(encoding="utf-8"))
    session = requests.Session()

    for entry in manifest:
        account = entry.get("account", "")
        if args.account and account != args.account:
            continue
        data_path = Path(entry["dataPath"])
        rows = json.loads(data_path.read_text(encoding="utf-8"))
        if args.limit:
            rows = rows[: args.limit]
        slug = account.encode("utf-8").hex()
        output_path = details_dir / f"{slug}.json"
        existing = {}
        if output_path.exists():
            for row in json.loads(output_path.read_text(encoding="utf-8")):
                existing[str(row.get("media_id", ""))] = row

        pending = [row for row in rows if not row_is_done(existing.get(str(row.get("media_id", ""))))]
        print(f"{account}: {len(rows)} total, {len(pending)} to fetch", flush=True)

        consecutive_failures = 0
        for index, row in enumerate(pending, 1):
            key = str(row.get("media_id", ""))
            if not key:
                continue
            url = str(row.get("url", ""))
            fallback_url = f"https://www.xiaohongshu.com/explore/{key}"
            note = None
            error = ""
            for attempt in range(args.retries + 1):
                for candidate in (url, fallback_url):
                    try:
                        note = fetch_note(candidate, cookies, session)
                        break
                    except Exception as e:
                        error = str(e)
                if note:
                    break
                time.sleep(args.delay * (attempt + 2))
            if note:
                detail = build_row(
                    note, url,
                    fallback_title=row.get("title", ""),
                    fallback_published_ms=row.get("published_at"),
                    fallback_cover=row.get("cover_url", ""),
                )
            else:
                detail = {
                    "media_id": key,
                    "title": row.get("title", ""),
                    "type": row.get("type", ""),
                    "is_video": row.get("type") == "video",
                    "caption": "",
                    "likes": None,
                    "comments": None,
                    "shares": None,
                    "duration_seconds": None,
                    "media_url": "",
                    "media_urls": [],
                    "cover_url": row.get("cover_url", ""),
                    "page_url": url,
                    "published_at": None,
                    "last_update_time": None,
                    "detail_status": "failed",
                    "error": error,
                }
            existing[key] = detail
            output_path.write_text(
                json.dumps(list(existing.values()), ensure_ascii=False, indent=2), encoding="utf-8"
            )
            print(f"  {account} {index}/{len(pending)} {key} {detail['detail_status']}", flush=True)
            if detail["detail_status"] == "complete":
                consecutive_failures = 0
            else:
                consecutive_failures += 1
                if consecutive_failures >= 12:
                    print(f"  {account} {consecutive_failures} consecutive failures, risk triggered, aborting run", flush=True)
                    print("aborted_by_risk", flush=True)
                    raise SystemExit(0)
                if consecutive_failures >= 5:
                    cooldown = min(120, 20 * (consecutive_failures // 5))
                    print(f"  {account} {consecutive_failures} consecutive failures, cooling down {cooldown}s", flush=True)
                    time.sleep(cooldown)
            time.sleep(args.delay)

    print("done", flush=True)


if __name__ == "__main__":
    main()
