# Platform access

This skill accesses Xiaohongshu and Instagram directly through OpenCLI. It does not require or invoke the `agent-reach` skill or CLI.

## Shared rules

- Use only read commands and the user's existing Chrome session. Never run a platform `login`, write, follow, like, comment, save, or publish command.
- Before collection, run `node scripts/verify-platform-access.mjs PLATFORM...`. A successful process with valid JSON proves the live browser bridge and session work; installed adapter files alone do not.
- Treat login redirects, `401`, `403`, `429`, captcha, and “访问频繁” as blockers. Retry once only after the user restores the session, then resume from checkpoints.
- Store raw captures outside `output/`. The `output/` tree is reserved for final Markdown records.

## Xiaohongshu

- Search: `opencli xiaohongshu search QUERY -f json`.
- Full account collection: `opencli xiaohongshu user-all-notes USER_ID -f json`, followed by signed-URL detail batches with `note-details-batch` or `note-details-nav-batch`.
- Direct wrapper: `node scripts/collect-social.mjs xiaohongshu account USER_ID --limit 60 --output RUN_DIR/xiaohongshu.json`.
- Never fetch details from a bare note ID. Preserve the current signed URL and `xsec_token` from search/profile results. Wait 2–3 seconds between large batches and stop on risk-control responses.

## Instagram

- Search usernames: `opencli instagram search QUERY -f json`; this is not a global caption search.
- Profile and recent posts: `opencli instagram profile USERNAME -f json` and `opencli instagram user USERNAME --limit 12 -f json`.
- Full video feed: `opencli instagram user-full USERNAME --limit 1000 -f json`.
- Direct wrapper: `node scripts/collect-social.mjs instagram account USERNAME --limit 60 --output RUN_DIR/instagram.json`.
- Prefer `view_count`, then `play_count`. On `429` or `login required`, stop and ask the user to restore the Chrome session or lower the rate.
