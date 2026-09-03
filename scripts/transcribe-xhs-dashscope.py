#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""小红书视频两级 ASR：本地 Qwen3-ASR-1.7B 首转，再由 qwen3-asr-flash 听同一音频精修。

媒体只保存于临时目录；每完成一条即原子写入 JSON，支持断点续跑。最终稿必须来自
qwen3-asr-flash 的第二次音频识别，不能用标题/正文冒充，也不能用文本聊天模型润色。
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import requests

LOCAL_ASR_MODEL = "Qwen/Qwen3-ASR-1.7B"
REFINE_ASR_MODEL = "qwen3-asr-flash"
SEGMENT_SECONDS = 60
DOMAIN_TERMS = (
    "中医 养生 食养 食疗 气血 阴虚 阳虚 脾虚 肾虚 湿气 痰湿 湿热 "
    "寒湿 经络 穴位 艾灸 推拿 五脏六腑 肝脾肾 心肺 气滞 血瘀 "
    "枸杞 黄芪 党参 当归 茯苓 山药 陈皮 桂圆 红枣 桑葚 熟地黄 "
    "麦冬 百合 莲子 芡实 薏苡仁 酸枣仁 九蒸九晒"
)

FFMPEG_CANDIDATES = [os.environ.get("FFMPEG", "")]


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


def get_api_key():
    key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if key:
        return key
    env_file = Path(
        os.environ.get("VIDEO_MEDIA_SEARCH_SKILL_ROOT")
        or os.environ.get("SKILL_ROOT")
        or Path(__file__).resolve().parents[1]
    ) / ".env"
    text = env_file.read_text(encoding="utf-8")
    match = re.search(r"(?m)^DASHSCOPE_API_KEY=(.*)$", text)
    if not match:
        raise RuntimeError("DASHSCOPE_API_KEY not found in environment or .env")
    return match.group(1).strip()


def find_ffmpeg():
    for candidate in FFMPEG_CANDIDATES:
        if candidate and Path(candidate).is_file():
            return candidate
    which = shutil.which("ffmpeg")
    if which:
        return which
    try:
        import imageio_ffmpeg

        candidate = imageio_ffmpeg.get_ffmpeg_exe()
        if Path(candidate).is_file():
            return candidate
    except Exception:
        pass
    raise RuntimeError("ffmpeg not found")


def download_xhs(urls, target_path):
    candidates = urls if isinstance(urls, list) else [urls]
    candidates = [str(url) for url in candidates if str(url).startswith("http")]
    if not candidates:
        raise RuntimeError("no downloadable media URL")
    last_error = None
    for url in candidates:
        try:
            with requests.get(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0",
                    "Referer": "https://www.xiaohongshu.com/",
                },
                stream=True,
                timeout=120,
            ) as response:
                response.raise_for_status()
                with open(target_path, "wb") as output:
                    for chunk in response.iter_content(1024 * 1024):
                        if chunk:
                            output.write(chunk)
            if os.path.getsize(target_path) >= 1024:
                return target_path
        except Exception as error:
            last_error = error
            Path(target_path).unlink(missing_ok=True)
    if last_error:
        raise last_error
    raise RuntimeError("downloaded media is empty")


def extract_wav(ffmpeg, media_path, wav_path, max_audio_seconds=0):
    duration_args = ["-t", str(max_audio_seconds)] if max_audio_seconds else []
    run = subprocess.run(
        [
            ffmpeg,
            "-y",
            "-i",
            media_path,
            *duration_args,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            wav_path,
        ],
        capture_output=True,
        timeout=300,
    )
    if run.returncode != 0 or not Path(wav_path).is_file():
        detail = (run.stderr or run.stdout or b"ffmpeg failed")[-800:]
        if isinstance(detail, bytes):
            detail = detail.decode("utf-8", errors="replace")
        raise RuntimeError(detail)
    return wav_path


def split_wav(ffmpeg, wav_path):
    source = Path(wav_path)
    pattern = str(source.with_name(f"{source.stem}_c%03d.wav"))
    run = subprocess.run(
        [
            ffmpeg,
            "-y",
            "-i",
            str(source),
            "-f",
            "segment",
            "-segment_time",
            str(SEGMENT_SECONDS),
            "-reset_timestamps",
            "1",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            pattern,
        ],
        capture_output=True,
        timeout=600,
    )
    chunks = sorted(source.parent.glob(f"{source.stem}_c*.wav"))
    if run.returncode != 0 or not chunks:
        raise RuntimeError("failed to split long audio")
    return [str(chunk) for chunk in chunks]


def transcribe_local(audio_path, model_id, context):
    from mlx_qwen3_asr import transcribe

    result = transcribe(
        audio_path,
        model=model_id,
        language="Chinese",
        context=context,
        return_chunks=False,
        verbose=False,
    )
    return str(result.text or "").strip(), str(result.language or "Chinese")


def _extract_text(response):
    text = ""
    for choice in getattr(response, "output", {}).get("choices", []):
        content = choice.get("message", {}).get("content")
        if isinstance(content, list):
            text = " ".join(
                item.get("text", "") for item in content if isinstance(item, dict)
            )
        elif isinstance(content, str):
            text = content
        if text:
            break
    return text.strip()


def _flash_context(first_pass, domain_context):
    draft = re.sub(r"\s+", " ", first_pass).strip()[:6000]
    return (
        "请逐字识别音频中的中文口播，不要总结、改写或补充音频中没有的内容。"
        "优先校正同音字、标点、断句和中医养生术语。\n"
        f"领域词：{domain_context}\n"
        f"首轮识别参考（仅作纠错线索，以音频为准）：{draft}"
    )


def transcribe_flash(key, audio_path, first_pass, domain_context, ffmpeg, timeout=300):
    from dashscope.aigc.multimodal_conversation import MultiModalConversation

    context = _flash_context(first_pass, domain_context)

    def call_one(path):
        response = MultiModalConversation.call(
            model=REFINE_ASR_MODEL,
            api_key=key,
            messages=[
                {"role": "system", "content": [{"text": context}]},
                {"role": "user", "content": [{"audio": path}]},
            ],
            timeout=timeout,
            max_tokens=None,
        )
        if getattr(response, "status_code", None) != 200:
            message = str(getattr(response, "message", ""))
            raise RuntimeError(
                f"ASR {getattr(response, 'status_code', '?')}: {message[:400]}"
            )
        return _extract_text(response)

    try:
        return call_one(audio_path)
    except Exception as error:
        lowered = str(error).lower()
        if not any(marker in lowered for marker in ("too long", "duration", "length")):
            raise
        parts = [call_one(chunk) for chunk in split_wav(ffmpeg, audio_path)]
        return "\n".join(part for part in parts if part)


def process_one(key, ffmpeg, row, local_model, domain_context, max_audio_seconds=0):
    media_id = str(row.get("media_id") or row.get("id") or "")
    urls = row.get("media_urls") or row.get("media_url") or ""
    base = {
        "media_id": media_id,
        "title": row.get("title", ""),
        "url": row.get("url", ""),
        "duration": row.get("duration_seconds") or row.get("duration"),
        "source": "qwen3_asr_two_pass",
        "first_pass_model": local_model,
        "refinement_model": REFINE_ASR_MODEL,
    }
    first_pass = ""
    language = ""
    with tempfile.TemporaryDirectory(prefix="qwen3_asr_") as temporary:
        media = os.path.join(temporary, "media.mp4")
        audio = os.path.join(temporary, "audio.wav")
        try:
            download_xhs(urls, media)
            extract_wav(
                ffmpeg, media, audio, max_audio_seconds=max_audio_seconds
            )
            first_pass, language = transcribe_local(audio, local_model, domain_context)
            if not first_pass:
                return {
                    **base,
                    "status": "no_speech",
                    "language": language,
                    "first_pass_transcript": "",
                    "transcript": "",
                    "script": "",
                    "error": "",
                }
            final_text = transcribe_flash(
                key, audio, first_pass, domain_context, ffmpeg=ffmpeg
            ).strip()
            if not final_text:
                raise RuntimeError("qwen3-asr-flash returned an empty second-pass transcript")
            return {
                **base,
                "status": "complete",
                "language": language,
                "first_pass_transcript": first_pass,
                "transcript": first_pass,
                "script": final_text,
                "error": "",
            }
        except Exception as error:
            return {
                **base,
                "status": "failed",
                "language": language,
                "first_pass_transcript": first_pass,
                "transcript": first_pass,
                "script": "",
                "error": str(error)[-800:],
            }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--account", required=True)
    parser.add_argument("--details-dir", default="work/xhs-full/details")
    parser.add_argument("--output-dir", default="work/xhs-full/transcripts")
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--media-id", default="")
    parser.add_argument("--local-model", default=LOCAL_ASR_MODEL)
    parser.add_argument("--domain-context", default=DOMAIN_TERMS)
    parser.add_argument(
        "--max-audio-seconds",
        type=int,
        default=0,
        help="仅用于冒烟测试；0 表示完整音频",
    )
    args = parser.parse_args()

    if args.workers != 1:
        raise SystemExit("Qwen3-ASR-1.7B uses substantial unified memory; --workers must be 1")

    key = get_api_key()
    ffmpeg = find_ffmpeg()
    slug = args.account.encode("utf-8").hex()
    rows = read_json(Path(args.details_dir) / f"{slug}.json", [])
    if not rows:
        rows = read_json(Path(args.details_dir) / f"xiaohongshu_{slug}.json", [])
    rows = [
        row
        for row in rows
        if row.get("detail_status") == "complete"
        and (
            row.get("is_video") is True
            or (row.get("is_video") is None and row.get("type") == "video")
        )
    ]
    if args.media_id:
        rows = [
            row
            for row in rows
            if str(row.get("media_id") or row.get("id")) == args.media_id
        ]
    if args.limit:
        rows = rows[: args.limit]
    total = len(rows)
    print(f"待转录: {total} 条 (account={args.account})", flush=True)

    output_path = Path(args.output_dir) / f"xiaohongshu_{slug}.json"
    output = read_json(output_path, {})
    pending = [
        row
        for row in rows
        if output.get(str(row.get("media_id") or row.get("id")), {}).get("status")
        not in ("complete", "no_speech")
    ]
    print(f"续跑检测: 已完成 {total - len(pending)}, 待处理 {len(pending)}", flush=True)
    if not pending:
        print("DONE", flush=True)
        return

    # transcribe() 自带进程内模型缓存；不要在这里另行预加载，否则可能同时驻留两份权重。
    print(f"首轮本地模型: {args.local_model}", flush=True)

    for index, row in enumerate(pending, start=1):
        result = process_one(
            key,
            ffmpeg,
            row,
            args.local_model,
            args.domain_context,
            max_audio_seconds=args.max_audio_seconds,
        )
        output[result["media_id"]] = result
        save_json(output_path, output)
        print(
            f"[{index}/{len(pending)}] {result['media_id'][:8]} "
            f"status={result['status']} {result.get('title', '')[:16]}",
            flush=True,
        )
    print("DONE", flush=True)


if __name__ == "__main__":
    main()
