---
name: allmedia-incremental-update
description: Incrementally collect newly published public videos from the configured Xiaohongshu and Instagram accounts, complete captions and speech transcripts, and append only unseen rows to the existing allmedia Excel workbook while preserving historical values, row order, formulas, colors, widths, table styles, and per-account sheets. Use for ongoing refreshes of allmedia_video_analysis workbooks, small-batch social video updates, account-level video scraping, transcript completion, and Heat/Engagement metric maintenance.
---

# Allmedia Incremental Update

Update the existing workbook as an append-only historical dataset. Never rebuild or re-sort the workbook unless the user explicitly requests it.

## Required references

- Read [references/workbook-contract.md](references/workbook-contract.md) before touching the workbook.
- Read [references/incremental-workflow.md](references/incremental-workflow.md) before collecting platform data.
- Use the installed `agent-reach` skill for Instagram and Xiaohongshu access.
- Use the installed spreadsheet skill that matches the selected backend: Excel live control for the canonical workbook, or standalone Spreadsheets for a bounded-range workbook.

## Workflow

1. Resolve the exact input workbook and create a dated output name. Do not overwrite the input unless the user explicitly authorizes an in-place update. Run `python3 scripts/audit_workbook.py INPUT.xlsx RUN_DIR/workbook-audit.json` and compare the current file with the contract; the current workbook is the source of truth when the user has modified it.
2. Run `agent-reach doctor --json`. Require a working OpenCLI Chrome session for both platforms. Never log in for the user or read browser cookies.
3. Run `python3 scripts/check-workbook-backend.py INPUT.xlsx`.
   - Use `excel-live` when the workbook contains full-sheet tables or formulas. Complete all Excel live-control setup gates before editing.
   - Use `artifact-tool` only when the report says bounded ranges are safe.
4. Run `node scripts/run-incremental-capture.mjs INPUT.xlsx RUN_DIR` to extract known IDs, fetch recent posts until historical overlap, fetch details only for unseen posts, transcribe only new videos, and generate `RUN_DIR/rows.json`.
5. Inspect `rows.json`. Stop if any new video lacks a nonblank `script`; `【无可识别语音】` is valid only when transcription explicitly reports `no_speech`.
6. Append account by account using the field mapping in the workbook contract. Dedupe again by canonical media ID/URL immediately before writing.
7. Preserve all historical raw cells and their order. Append each run's new rows at the bottom, newest first within that new batch.
8. Copy the previous data row's complete row style/formulas into each new row, then write only raw fields:
   - Xiaohongshu: write `A:F` and `H:I`; preserve/copy the `G` Heat formula.
   - Instagram: write `A:F` and `I:J`; preserve/copy the `G:H` Heat/Engagement formulas.
9. Autofit only the new rows. Never autofit or restyle entire sheets. Do not alter sheet order, column widths, colors, table style, gridline state, or existing row heights.
10. Verify new values/formulas, duplicate URLs, blank Script cells, formula errors, and a visual image of every changed range. Save/export exactly one updated workbook.

## Excel live append

Use connected Excel commands advertised by the selected session. Read the current last populated URL row first. Prefer `copy_range_to` for the last data row to the new rows, then `write_range` only on raw-field blocks. If direct commands cannot preserve formulas and formatting, follow the Excel live-control Office.js gate; do not improvise undocumented commands.

The canonical workbook's tables and formulas extend to row 1,048,576, so live Excel is the normal fast path. Do not send it to the offline artifact updater.

## Bounded offline append

Immediately before the first workbook edit, run the Spreadsheets artifact-operation marker exactly once. Then run:

`node scripts/append-incremental-workbook.mjs INPUT.xlsx RUN_DIR/rows.json OUTPUT.xlsx RUN_DIR/previews`

Use this only after `check-workbook-backend.py` returns `artifact-tool`.

## Safety and failure rules

- Keep platform cookies only in `.env`; keep generated cookie jars in the run directory with mode `0600`. Never print, commit, or embed cookie values in workbooks.
- Treat `400`, `401`, `429`, login redirects, captcha, and missing overlap as blockers. Retry once after confirming the Chrome session, then stop with the exact account and platform error.
- If the newest scan reaches its maximum limit without overlapping a known media ID, run the existing full-backfill path before appending. Never assume the gap is complete.
- Never append partial XHS note manifests without detail records, and never silently leave Script blank.
- Continue excluding `袁姐姐全息健康笔记` unless the user explicitly restores that account.
