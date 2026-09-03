# Canonical Markdown corpus contract

Markdown is the standard video_media_search_skill output. Each published post is one UTF-8 `.md` file; Excel is a legacy import/export format only.

## Directory and filename rules

- Use `output/` as the corpus root. Every record must be directly inside exactly one platform directory: `output/xiaohongshu/` or `output/instagram/`.
- Base filename: `<account> - 点赞<likes> - <first nonblank line of Caption>.md`. Use `点赞未知` only when Likes is unavailable.
- Replace `/`, `\\`, `:`, control characters, and filesystem-reserved punctuation with spaces; collapse whitespace; trim trailing dots/spaces.
- Keep filenames within filesystem byte limits. Truncate the title portion without changing the account prefix.
- If two different URLs produce the same filename, use `__2`, `__3`, and so on. Never overwrite one post with another.
- A blank Caption uses `无标题`.

## Record layout

Use this exact order, omitting only fields that do not apply to the platform:

```markdown
# <first line of Caption>

- Account: <account>
- Timestamp: <YYYY-MM-DD HH:MM:SS>
- Likes: <integer or blank>
- Comments: <integer or blank>
- Shares: <integer or blank>        <!-- Xiaohongshu -->
- Views: <integer or blank>         <!-- Instagram -->
- Heat: <number or blank>
- Engagement: <number or blank>     <!-- Instagram -->
- Duration: <seconds or blank>
- URL: <canonical or source URL>

## Caption

<complete Caption, unchanged>

## Script

<complete transcript, unchanged>
```

Do not place Caption or Script in a Markdown table. Preserve internal line breaks and Unicode text. Use a trailing newline at EOF.

## Field mapping and metrics

Xiaohongshu fields: Timestamp, Caption, Script, Likes, Comments, Shares, Heat, Duration, URL.

- Heat = `(Likes + Comments + Shares) / account mean(Likes + Comments + Shares)`.
- Keep Shares blank when unavailable; do not replace unknown values with zero in the displayed field.

Instagram fields: Timestamp, Caption, Script, Likes, Comments, Views, Heat, Engagement, Duration, URL.

- Heat = `(Likes + Comments) / account mean(Likes + Comments)`.
- Engagement = `(Likes + Comments) / Views` when Views is positive.
- Prefer `view_count`; otherwise use `play_count`. Keep unavailable metrics blank.

For legacy Excel conversion, copy the cached displayed numeric values rather than recalculating them. Preserve source precision; do not round values merely for presentation.

## Completeness and validation

- A newly collected record has Account, Timestamp, Caption, Script, and URL; Script may contain the explicit `【无可识别语音】` sentinel. During legacy conversion, preserve source blanks exactly and report them rather than inventing replacement content.
- URL/media ID is the identity key. Query strings and `xsec_token` do not define a new Xiaohongshu post.
- Validate recursively that platform directories are correct, filenames include account and Likes, URLs are unique, required sections occur exactly once, and output file count matches the number of populated input rows.
- Report per-account counts and any skipped/blocked records.
