#!/usr/bin/env bash
set -euo pipefail

run_dir="${1:-work/xhs-qwen3-20260901}"
cookie_jar="${run_dir}/xhs.cookies.txt"
mkdir -p "${run_dir}/details"
node scripts/write-cookie-jar.mjs .env xiaohongshu "${cookie_jar}"
chmod 600 "${cookie_jar}"

accounts=("阿飞泡枸杞" "欧阳会食养" "肖食儿" "养生小禾" "是小琼啊" "JIN聊养生")
workers="${XHS_WORKERS:-1}"
batch_size="${XHS_BATCH_SIZE:-1}"
batch_pause="${XHS_BATCH_PAUSE:-2}"
for account in "${accounts[@]}"; do
  python3 scripts/collect-xhs-ytdlp.py \
    --manifest-dir "${run_dir}/manifests" \
    --output-dir "${run_dir}/details" \
    --cookies "${cookie_jar}" \
    --seed-dir "${run_dir}/details" \
    --account "${account}" \
    --workers "${workers}" \
    --batch-size "${batch_size}" \
    --batch-pause "${batch_pause}"
  slug="$(printf '%s' "${account}" | xxd -p | tr -d '\n')"
  user_id=""
  case "${account}" in
    "阿飞泡枸杞") user_id="65086f960000000017023c45" ;;
    "欧阳会食养") user_id="5e4e14f2000000000100745e" ;;
    "肖食儿") user_id="6513f54a00000000230244b0" ;;
    "养生小禾") user_id="65afb335000000000e001062" ;;
    "是小琼啊") user_id="5a1075134eacab60b17c74b1" ;;
    "JIN聊养生") user_id="61d16bdb0000000010006f59" ;;
  esac
  XHS_DETAIL_BATCH_SIZE=1 XHS_DETAIL_BATCH_DELAY_MS=2000 XHS_SITE_SESSION=persistent \
    node scripts/collect-xhs-details-safe.mjs \
      "${account}" "${user_id}" \
      "${run_dir}/manifests/${slug}.json" \
      "${run_dir}/details/${slug}.json"
done
