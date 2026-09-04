# video_media_search_skill

Codex Skill for incrementally adding newly published Xiaohongshu and Instagram content to a one-post-per-file Markdown corpus.

- Skill invocation: `$video-media-search-skill`
- Corpus: `output/xiaohongshu/` and `output/instagram/`
- Discovery/access: read-only OpenCLI with the user's existing Chrome session
- Video transcript: `Qwen/Qwen3-ASR-1.7B`, checkpointed; no Flash second pass
- Intermediate data: a separate run directory, ignored by Git

The maintained workflow is in `SKILL.md` and `references/incremental-workflow.md`. Historical full backfills and Excel conversion are outside the active Skill workflow; existing utility scripts remain available for recovery but are not loaded as instructions.
