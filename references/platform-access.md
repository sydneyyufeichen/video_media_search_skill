# Platform access

Use read-only OpenCLI commands with the user's existing Chrome session. Never log in, read browser cookies, or like, follow, comment, save, or publish.

Before collection run `node scripts/verify-platform-access.mjs PLATFORM...`. Valid JSON from the live probe—not installed adapter files—proves access.

## Xiaohongshu

- Discover an account with `opencli xiaohongshu user-all-notes USER_ID --limit N -f json`.
- Keep each returned signed URL and `xsec_token` for detail retrieval; never request details from a bare note ID.
- Process unseen details conservatively and stop on captcha, “访问频繁”, or HTTP `401`, `403`, `429`.

## Instagram

- Discover recent posts with `opencli instagram user-full USERNAME --limit N -f json`.
- Use reel/post shortcode as identity. Prefer `view_count`, then `play_count`.
- Stop on login-required, privacy/region restrictions, or HTTP `401`, `403`, `429`.

Store all platform responses and diagnostics in the run directory, never in `output/`.
