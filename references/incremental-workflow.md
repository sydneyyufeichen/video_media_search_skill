# Incremental collection workflow

## Accounts

Xiaohongshu:

- 阿飞泡枸杞 — `65086f960000000017023c45`
- 欧阳会食养 — `5e4e14f2000000000100745e`
- 肖食儿 — `6513f54a00000000230244b0`
- 养生小禾 — `65afb335000000000e001062`
- 袁姐姐全息健康笔记 — `65ddc0f60000000005008e49`
- 是小琼啊 — `5a1075134eacab60b17c74b1`
- 艾先生讲思路 — `5f3a20220000000001002380`
- JIN聊养生 — `61d16bdb0000000010006f59`

Instagram: `tcmbycheehee`, `wellness.with.gloria`, `dr.franktcm`, `yourtcmguide`.


## Fast path

1. Scan `output/**/*.md` for canonical media IDs/URLs and each account's latest timestamp. Use a legacy workbook only when converting an older dataset.
2. Fetch only the newest 60 posts per account.
3. If no known ID overlaps, double the window until overlap or 500 posts. If 500 still has no overlap, stop and use the full-backfill scripts.
4. Filter known IDs before XHS detail requests, media downloads, or transcription.
5. Fetch XHS detail batches only for unseen notes, then keep only confirmed video rows.
6. Transcribe only unseen videos. For the current six-account backfill, run `Qwen/Qwen3-ASR-1.7B` once on a CUDA cloud worker and use that transcript as the final Script. Do not invoke `qwen3-asr-flash`.
7. Normalize to `rows.json`, grouped by account, and enforce nonblank Script.
8. Dedupe against the Markdown corpus again just before writing. Run `scripts/export-to-markdown.py rows ...` and validate the completed directory.

This changes the recurring workload from “all historical videos” to “recent discovery + new-video details/ASR + one Markdown file per new post.”

## Canonical IDs

- Instagram: shortcode from `/p/SHORTCODE/` or `/reel/SHORTCODE/`.
- Xiaohongshu: 24-character hexadecimal note ID from `/explore/ID` or `/user/profile/USER/ID`.
- Ignore query strings and `xsec_token` when deduplicating. Retain the latest valid source URL in the appended row.

## Transcript quality gate

- `complete`: write the returned transcript.
- `no_speech`: write `【无可识别语音】`.
- `failed` or missing: do not append; retry media access/transcription and report the affected account and URL.

Do not use caption text as a fabricated transcript.

## Platform failure handling

- Instagram `400`: retry profile lookup by exact username ID, then user-feed pagination. If only one account fails, verify rename/deactivation/privacy/age-region restrictions and do not reuse another account's data.
- `401` or login redirect: ask the user to log in again in Chrome; do not automate login.
- `429` or captcha: stop, reduce frequency, and resume from saved checkpoints later.
- Xiaohongshu missing details: refresh the signed URL/token through the profile manifest; never query a bare note ID without its current `xsec_token`.

## Secrets

Read `INSTAGRAM_COOKIE` and `XHS_COOKIE` only from `.env`. `.env`, cookie jars, captures, transcripts, checkpoints, previews, and workbooks must remain ignored by Git. Never echo cookie contents.
