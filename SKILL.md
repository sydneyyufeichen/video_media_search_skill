---
name: video-media-search-skill
description: Collect public Xiaohongshu and Instagram content and write auditable Markdown records. Use for video-media account backfills, topic searches, incremental updates, transcript completion, and legacy workbook conversion.
---

# video_media_search_skill

Collect the configured accounts into a directory of standalone Markdown records. Markdown is the canonical deliverable; do not create or update an Excel workbook unless the user explicitly asks for Excel.

## Required references

- Read [references/markdown-contract.md](references/markdown-contract.md) before writing output.
- Read [references/incremental-workflow.md](references/incremental-workflow.md) before collecting platform data.
- Read [references/platform-access.md](references/platform-access.md) for the requested platform. This skill contains its own access workflow and must not invoke or depend on `agent-reach`.

## Workflow

1. For ordinary corpus collection, use `output/` as the corpus root and write only to `output/xiaohongshu/` or `output/instagram/`. Scan recursively and deduplicate by canonical media ID/URL. Never overwrite a different post because its title matches.
2. Run `node scripts/verify-platform-access.mjs PLATFORM...` to verify the live OpenCLI browser bridge and existing login with read-only probes. Never log in for the user or read browser cookies.
3. Collect the same fields used by the legacy workbook: Timestamp, Caption, Script, Likes, Comments, Shares or Views, Heat, Engagement when applicable, Duration, and URL. Include every public video in scope; do not silently omit inaccessible items.
4. Complete the Script field before delivery. `【无可识别语音】` is valid only when transcription explicitly reports `no_speech`; do not fabricate a transcript from the caption.
   For audio without a reusable transcript, run `Qwen/Qwen3-ASR-1.7B` once on the configured CUDA cloud worker and use that result as the final Script. Do not call `qwen3-asr-flash` for the current six-account backfill.
5. Normalize records, calculate metrics with the rules in the Markdown contract, and write one `.md` per post. Name it `<account> - 点赞<likes> - <caption first line>.md`; use `点赞未知` only when the source omits the value.
6. Run `python3 scripts/export-to-markdown.py validate output`. Reconcile per-account, platform, and total counts against the collected manifests before reporting completion.

## Legacy Excel conversion

Use the read-only converter; never modify the source workbook:

`python3 scripts/export-to-markdown.py xlsx INPUT.xlsx output`

The converter reads cached formula results, preserves every populated source field, and produces the canonical one-record-per-file layout.

## Incremental JSON export

After collection and transcription generate the normalized `rows.json`, then run:

`python3 scripts/export-to-markdown.py rows RUN_DIR/rows.json output --existing-dir output`

The exporter refuses duplicate canonical URLs and adds a stable numeric suffix when different posts have the same account/title filename.

## Safety and failure rules

- Keep cookies only in `.env`; keep generated cookie jars and raw captures in the run directory with mode `0600`. Never print, commit, or embed cookie values in output.
- Keep `output/` retrieval-clean. Ordinary corpus runs may contain only the two platform directories and final `.md` records; put JSON, checkpoints, transcripts, logs, previews, and temporary files elsewhere.
- Treat `400`, `401`, `429`, login redirects, captcha, “访问频繁”, missing overlap, incomplete manifests, and missing detail records as blockers. Retry once after confirming the Chrome session, then stop with the exact account and platform error.
- Do not describe a partial corpus as “all content.” Resume from saved checkpoints after access is restored.
- Preserve the user's existing corpus. Write new records atomically and do not delete or rewrite historical Markdown files unless explicitly requested.
