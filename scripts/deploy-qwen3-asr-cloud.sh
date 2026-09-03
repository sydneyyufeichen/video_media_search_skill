#!/usr/bin/env bash
set -euo pipefail

cloud_host="${1:?Usage: scripts/deploy-qwen3-asr-cloud.sh <ssh-host> [remote-dir] [run-dir]}"
remote_dir="${2:-video_media_search_skill}"
run_dir="${3:-work/xhs-qwen3-20260901}"

ssh "${cloud_host}" "mkdir -p '${remote_dir}/scripts' '${remote_dir}/cloud' '${remote_dir}/${run_dir}/details' '${remote_dir}/${run_dir}/transcripts'"
rsync -az \
  scripts/transcribe-xhs-qwen3-cloud.py \
  "${cloud_host}:${remote_dir}/scripts/"
rsync -az cloud/ "${cloud_host}:${remote_dir}/cloud/"
rsync -az "${run_dir}/details/" "${cloud_host}:${remote_dir}/${run_dir}/details/"
ssh "${cloud_host}" "cd '${remote_dir}' && bash cloud/bootstrap-qwen3-asr.sh"
ssh "${cloud_host}" "cd '${remote_dir}' && nohup bash cloud/run-six-accounts.sh '${run_dir}' > '${run_dir}/cloud-asr.log' 2>&1 & echo \$!"
