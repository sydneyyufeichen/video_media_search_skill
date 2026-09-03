#!/usr/bin/env python3
"""CUDA batch transcription for Xiaohongshu using Qwen3-ASR-1.7B only.

The script streams each signed media URL through ffmpeg, keeps only a temporary
16 kHz mono WAV, batches GPU inference, and atomically checkpoints every batch.
It intentionally has no DashScope or qwen3-asr-flash dependency.
"""
import argparse
import json
import os
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


MODEL_ID = "Qwen/Qwen3-ASR-1.7B"
DEFAULT_ACCOUNTS = (
    "阿飞泡枸杞", "欧阳会食养", "肖食儿", "养生小禾", "是小琼啊", "JIN聊养生",
)
DOMAIN_CONTEXT = (
    "中医 养生 食养 食疗 气血 阴虚 阳虚 脾虚 肾虚 湿气 痰湿 湿热 "
    "寒湿 经络 穴位 艾灸 推拿 五脏六腑 肝脾肾 心肺 气滞 血瘀 "
    "枸杞 黄芪 党参 当归 茯苓 山药 陈皮 桂圆 红枣 桑葚 熟地黄 "
    "麦冬 百合 莲子 芡实 薏苡仁 酸枣仁 九蒸九晒"
)


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


def find_ffmpeg():
    candidate = os.environ.get("FFMPEG") or shutil.which("ffmpeg")
    if not candidate:
        raise RuntimeError("ffmpeg not found")
    return candidate


def media_urls(row):
    values = row.get("media_urls") or row.get("media_url") or []
    if isinstance(values, str):
        values = [values]
    return list(dict.fromkeys(str(value) for value in values if str(value).startswith("http")))


def stream_audio(ffmpeg, row, wav_path):
    urls = media_urls(row)
    if not urls:
        raise RuntimeError("no downloadable media URL")
    headers = "User-Agent: Mozilla/5.0\r\nReferer: https://www.xiaohongshu.com/\r\n"
    last_error = ""
    for url in urls:
        run = subprocess.run(
            [
                ffmpeg, "-nostdin", "-loglevel", "error", "-y", "-headers", headers,
                "-i", url, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                str(wav_path),
            ],
            capture_output=True,
            timeout=600,
        )
        if run.returncode == 0 and Path(wav_path).is_file() and Path(wav_path).stat().st_size >= 1024:
            return str(wav_path)
        Path(wav_path).unlink(missing_ok=True)
        last_error = (run.stderr or run.stdout or b"ffmpeg failed")[-600:].decode("utf-8", errors="replace")
    raise RuntimeError(last_error or "unable to extract audio")


def load_model(model_id, batch_size):
    import torch
    from qwen_asr import Qwen3ASRModel

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA GPU is required for the cloud worker")
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    return Qwen3ASRModel.from_pretrained(
        model_id,
        dtype=dtype,
        device_map="cuda:0",
        max_inference_batch_size=batch_size,
        max_new_tokens=2048,
    )


def infer(model, paths, context):
    languages = ["Chinese"] * len(paths)
    contexts = [context] * len(paths)
    try:
        results = model.transcribe(audio=paths, language=languages, context=contexts)
    except TypeError:
        results = model.transcribe(audio=paths, language=languages)
    if not isinstance(results, (list, tuple)):
        results = [results]
    if len(results) != len(paths):
        raise RuntimeError(f"ASR returned {len(results)} results for {len(paths)} inputs")
    return [
        (str(getattr(result, "text", "") or "").strip(),
         str(getattr(result, "language", "Chinese") or "Chinese"))
        for result in results
    ]


def infer_with_oom_backoff(model, prepared, context):
    try:
        values = infer(model, [item[1] for item in prepared], context)
        return list(zip([item[0] for item in prepared], values))
    except RuntimeError as error:
        if len(prepared) == 1 or "out of memory" not in str(error).lower():
            raise
        import torch
        torch.cuda.empty_cache()
        middle = len(prepared) // 2
        return (
            infer_with_oom_backoff(model, prepared[:middle], context)
            + infer_with_oom_backoff(model, prepared[middle:], context)
        )


def account_rows(details_dir, account, media_id=""):
    slug = account.encode("utf-8").hex()
    rows = read_json(Path(details_dir) / f"{slug}.json", [])
    if not rows:
        rows = read_json(Path(details_dir) / f"xiaohongshu_{slug}.json", [])
    rows = [
        row for row in rows
        if row.get("detail_status") == "complete"
        and (row.get("is_video") is True or (row.get("is_video") is None and row.get("type") == "video"))
        and media_urls(row)
    ]
    if media_id:
        rows = [row for row in rows if str(row.get("media_id") or row.get("id")) == media_id]
    return rows


def base_result(row):
    return {
        "media_id": str(row.get("media_id") or row.get("id") or ""),
        "title": row.get("title", ""),
        "url": row.get("url", ""),
        "duration": row.get("duration_seconds") or row.get("duration"),
        "source": "qwen3_asr_single_pass",
        "first_pass_model": MODEL_ID,
        "refinement_model": "",
    }


def process_account(model, ffmpeg, account, details_dir, output_dir, batch_size, download_workers, context, media_id=""):
    rows = account_rows(details_dir, account, media_id=media_id)
    slug = account.encode("utf-8").hex()
    output_path = Path(output_dir) / f"xiaohongshu_{slug}.json"
    output = read_json(output_path, {})
    pending = [row for row in rows if output.get(str(row.get("media_id") or row.get("id")), {}).get("status") not in ("complete", "no_speech")]
    print(f"START {account} videos={len(rows)} complete={len(rows) - len(pending)} pending={len(pending)}", flush=True)

    for offset in range(0, len(pending), batch_size):
        batch = pending[offset:offset + batch_size]
        with tempfile.TemporaryDirectory(prefix="qwen3_asr_cloud_") as temporary:
            prepared = []
            with ThreadPoolExecutor(max_workers=download_workers) as pool:
                futures = {}
                for row in batch:
                    media_id = str(row.get("media_id") or row.get("id"))
                    wav_path = Path(temporary) / f"{media_id}.wav"
                    futures[pool.submit(stream_audio, ffmpeg, row, wav_path)] = row
                for future in as_completed(futures):
                    row = futures[future]
                    media_id = str(row.get("media_id") or row.get("id"))
                    try:
                        prepared.append((row, future.result()))
                    except Exception as error:
                        output[media_id] = {
                            **base_result(row), "status": "failed", "language": "",
                            "first_pass_transcript": "", "transcript": "", "script": "",
                            "error": str(error)[-800:],
                        }
            prepared.sort(key=lambda item: str(item[0].get("media_id") or item[0].get("id")))
            if prepared:
                for row, (text, language) in infer_with_oom_backoff(model, prepared, context):
                    media_id = str(row.get("media_id") or row.get("id"))
                    status = "complete" if text else "no_speech"
                    output[media_id] = {
                        **base_result(row), "status": status, "language": language,
                        "first_pass_transcript": text, "transcript": text, "script": text,
                        "error": "",
                    }
            save_json(output_path, output)
        done = sum(item.get("status") in ("complete", "no_speech") for item in output.values())
        print(f"CHECKPOINT {account} processed={min(offset + len(batch), len(pending))}/{len(pending)} total_done={done}", flush=True)
    print(f"DONE {account}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--details-dir", default="work/xhs-qwen3-20260901/details")
    parser.add_argument("--output-dir", default="work/xhs-qwen3-20260901/transcripts")
    parser.add_argument("--account", action="append", dest="accounts")
    parser.add_argument("--model", default=MODEL_ID)
    parser.add_argument("--asr-batch-size", type=int, default=8)
    parser.add_argument("--download-workers", type=int, default=4)
    parser.add_argument("--domain-context", default=DOMAIN_CONTEXT)
    parser.add_argument("--media-id", default="")
    args = parser.parse_args()
    accounts = args.accounts or list(DEFAULT_ACCOUNTS)
    ffmpeg = find_ffmpeg()
    model = load_model(args.model, max(1, args.asr_batch_size))
    for account in accounts:
        process_account(
            model, ffmpeg, account, args.details_dir, args.output_dir,
            max(1, args.asr_batch_size), max(1, args.download_workers), args.domain_context,
            media_id=args.media_id,
        )


if __name__ == "__main__":
    main()
