#!/usr/bin/env python3
"""Refine raw ASR / corpus transcripts into clean readable scripts using a local MLX LLM.

Reads a transcripts file (media_id -> {transcript, status}) plus the matching
details file (media_id -> row with title/caption), rewrites each transcript with
the local model into clean Chinese prose (punctuation + term correction), and
writes an output file (media_id -> {script, status}) that is resumable.
"""

import argparse
import json
import re
import sys
from pathlib import Path

from mlx_lm import load, generate

PROMPT = (
    "你是一位资深的中医养生科普文稿编辑。下面是一条小红书养生短视频的语音转写草稿，"
    "其中包含错别字、缺标点、病句、重复片段和口语乱码。请把它整理成一篇面向普通读者的"
    "正式中文文稿。要求："
    "1) 修正错别字和养生/中医术语（节气、穴位、中药材、方剂），忠于原意，绝不编造新内容；"
    "2) 补全标点，划分句子和段落，必要时去除重复片段、病句和无意义语气词，使表达通顺自然；"
    "3) 绝对不要输出任何 #话题标签、'正文:'等提示词、或转写中杂乱的标签符号，正文里也不要带标题；"
    "4) 只输出整理好的正文本身，不要任何开头语、解释或结尾语。\n\n"
    "标题：{title}\n\n原始转写：\n{raw}\n\n整理后的正文："
)

HASHTAG = re.compile(r"#[\u4e00-\u9fffA-Za-z0-9_\[\]\u6907]*")


def clean(script):
    text = HASHTAG.sub("", script)
    text = re.sub(r"\[话题\]", "", text)
    # collapse any substring that repeats 3+ times contiguously down to a single copy
    pattern = re.compile(r"((.{12,}?)\2{3,})", re.S)
    while True:
        match = pattern.search(text)
        if not match:
            break
        text = text.replace(match.group(0), match.group(2))
    # collapse runs of 3+ blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()[:6000]


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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--transcripts", required=True)
    parser.add_argument("--details", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="mlx-community/Qwen2.5-3B-Instruct-4bit")
    parser.add_argument("--max-tokens", type=int, default=2048)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    transcripts = read_json(args.transcripts, {})
    details = {str(r.get("media_id", "")): r for r in read_json(args.details, []) if r.get("media_id")}
    output = read_json(args.output, {})

    model, tokenizer = load(args.model)
    print(f"model loaded: {args.model}", flush=True)

    done = 0
    for key, value in transcripts.items():
        if not value or value.get("status") != "complete":
            continue
        raw = str(value.get("transcript", "") or "").strip()
        if not raw:
            continue
        if output.get(key, {}).get("status") == "done":
            done += 1
            continue
        title = str(details.get(key, {}).get("title", "") or "").strip()
        prompt = PROMPT.format(title=title, raw=raw)
        try:
            refined = generate(
                model, tokenizer, prompt=prompt,
                max_tokens=args.max_tokens, verbose=False,
            )
        except Exception as error:
            output[key] = {"status": "failed", "error": str(error)[-500:]}
            save_json(args.output, output)
            print(f"refine {key}: failed ({error})", flush=True)
            continue
        script = clean(refined)
        output[key] = {"script": script, "status": "done" if script else "empty"}
        save_json(args.output, output)
        done += 1
        print(f"refine {key}: len={len(script)}", flush=True)
        if args.limit and done >= args.limit:
            break

    from collections import Counter
    print("summary:", dict(Counter(v.get("status") for v in output.values())), "done_in_run=" + str(done), flush=True)


if __name__ == "__main__":
    main()