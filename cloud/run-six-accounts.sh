#!/usr/bin/env bash
set -euo pipefail

run_dir="${1:-work/xhs-qwen3-20260901}"
.venv/bin/python scripts/transcribe-xhs-qwen3-cloud.py \
  --details-dir "${run_dir}/details" \
  --output-dir "${run_dir}/transcripts" \
  --asr-batch-size "${QWEN_ASR_BATCH_SIZE:-8}" \
  --download-workers "${QWEN_DOWNLOAD_WORKERS:-4}"
