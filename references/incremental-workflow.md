# Incremental workflow

Use this path only to append content published after the existing Markdown corpus.

## Inputs

- Requested accounts and their platform identifiers.
- Existing corpus under `output/`.
- A new run directory outside `output/` for manifests, details, media, transcripts, logs, and `rows.json`.

## Procedure

1. Scan `output/**/*.md` and build per-account sets of canonical media IDs plus the latest timestamp.
2. Verify only the requested platforms:
   `node scripts/verify-platform-access.mjs PLATFORM...`
3. Fetch the newest 60 posts per account. If no known ID overlaps, double the window up to 500. Stop if overlap is still absent; do not guess that the listing is complete.
4. Save the discovery manifest, then remove known IDs before any detail request or download.
5. For each unseen Xiaohongshu note, retain its current signed URL and fetch complete details from that URL. Never reuse an expired `xsec_token` or request a bare note ID. Preserve Instagram shortcode identity and complete post metadata.
6. Route by content type:
   - Video: obtain a valid media URL and transcribe only if no reusable transcript exists.
   - Text/image note: preserve the retrieved body in Caption; do not run ASR or fabricate Script.
7. Run video ASR with `Qwen/Qwen3-ASR-1.7B`, checkpointing each item. Map `complete` to its transcript, `no_speech` to `【无可识别语音】`, and keep `failed` out of the final export until resolved.
8. Normalize all unseen records into `RUN_DIR/rows.json`, grouped by account. Recheck IDs against `output/` immediately before writing.
9. Append and validate:
   `python3 scripts/export-to-markdown.py rows RUN_DIR/rows.json output --existing-dir output`
   `python3 scripts/export-to-markdown.py validate output`
10. Reconcile discovered, filtered, detailed, transcribed, exported, failed, and skipped counts for every account before reporting completion.

## Resume and stopping

- Write manifests, details, transcripts, and rows atomically; reruns process only missing or failed items.
- One ordinary technical failure may be diagnosed and retried from its checkpoint.
- Stop requests immediately on captcha, risk-control text, login redirect, `401`, `403`, or `429`; do not loop restarts.
- Never describe a partial account as complete. Report the exact account, stage, completed count, and remaining count.
