#!/usr/bin/env python3
import argparse
import json

from yt_dlp import YoutubeDL
from yt_dlp.extractor.xiaohongshu import XiaoHongShuIE
from yt_dlp.utils import js_to_json
from yt_dlp.utils.traversal import traverse_obj


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--cookies", required=True)
    args = parser.parse_args()
    video_id = XiaoHongShuIE._match_id(args.url)
    with YoutubeDL({"cookiefile": args.cookies, "quiet": True}) as ydl:
        extractor = XiaoHongShuIE(ydl)
        webpage = extractor._download_webpage(args.url, video_id)
        initial_state = extractor._search_json(
            r"window\.__INITIAL_STATE__\s*=", webpage, "initial state", video_id,
            transform_source=js_to_json)
    note = traverse_obj(initial_state, ("note", "noteDetailMap", video_id, "note")) or {}
    selected = {
        key: note.get(key)
        for key in ("noteId", "type", "title", "desc", "time", "lastUpdateTime", "interactInfo", "user")
    }
    selected["top_level_keys"] = sorted(note.keys())
    print(json.dumps(selected, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
