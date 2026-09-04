# Markdown contract

Each public post is one UTF-8 `.md` directly under `output/xiaohongshu/` or `output/instagram/`.

## Identity and filename

- Identity is the canonical media ID/URL; ignore query strings and Xiaohongshu `xsec_token` when deduplicating.
- Filename: `<account> - 点赞<likes> - <first nonblank Caption line>.md`; use `点赞未知` and `无标题` when absent.
- Sanitize filesystem-reserved characters and truncate safely. If different IDs collide, append `__2`, `__3`, etc.; never overwrite another post.

## Layout

```markdown
# <first Caption line>

- Account: <account>
- Timestamp: <YYYY-MM-DD HH:MM:SS>
- Likes: <integer or blank>
- Comments: <integer or blank>
- Shares: <integer or blank>        <!-- Xiaohongshu -->
- Views: <integer or blank>         <!-- Instagram -->
- Heat: <number or blank>
- Engagement: <number or blank>     <!-- Instagram -->
- Duration: <seconds or blank>
- URL: <source URL>

## Caption

<complete Caption>

## Script

<complete transcript or explicit status>
```

Preserve Unicode, Caption/Script line breaks, unknown numeric fields as blank, and a final newline. Do not put Caption or Script in a table.

## Metrics and validation

- Xiaohongshu Heat: `(Likes + Comments + Shares) / account mean` using available values.
- Instagram Heat: `(Likes + Comments) / account mean`; Engagement: `(Likes + Comments) / Views` when Views is positive. Prefer `view_count`, then `play_count`.
- A new record requires Account, Timestamp, Caption, Script, and URL. Script may be `【无可识别语音】` only after `no_speech`.
- Validate platform directories, filename prefixes, unique canonical IDs/URLs, single required sections, and per-account totals against `rows.json`.
