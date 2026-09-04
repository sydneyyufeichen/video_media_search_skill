---
name: video-media-search-skill
description: Incrementally collect newly published public Xiaohongshu or Instagram content into auditable one-post-per-file Markdown. Use for routine additions to an existing corpus, not historical backfills or Excel conversion.
---

# Incremental video media collection

Add only unseen public posts to `output/xiaohongshu/` or `output/instagram/`. Markdown is the canonical deliverable.

## Run

1. Read [references/incremental-workflow.md](references/incremental-workflow.md).
2. Read only the requested platform section in [references/platform-access.md](references/platform-access.md).
3. Scan existing Markdown for canonical media IDs, then verify the live OpenCLI bridge and the user's existing Chrome login.
4. Discover recent posts until they overlap the corpus. Filter known IDs before detail requests, downloads, or ASR.
5. Fetch complete metadata for unseen posts. Transcribe unseen videos with `Qwen/Qwen3-ASR-1.7B`; never invent Script from Caption.
6. Before export, read [references/markdown-contract.md](references/markdown-contract.md). Write one Markdown per new post and validate counts against the run manifest.

## Invariants

- Identity is canonical media ID/URL without query tokens; titles are not identifiers.
- Keep raw captures, media, transcripts, checkpoints, and logs outside `output/`.
- Never print or commit cookies/tokens, automate login, or perform platform write actions.
- Stop on captcha, login failure, `401`, `403`, `429`, “访问频繁”, missing overlap, or incomplete details. Resume from checkpoints after access is restored.
- Do not call `qwen3-asr-flash`. Accept `【无可识别语音】` only from an explicit `no_speech` result.
- Do not rewrite an existing Markdown record during an incremental run unless the user explicitly requests a refresh.
