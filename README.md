# video_media_search_skill

这是一个正式 Codex Skill，用于直接采集小红书与 Instagram 内容，并将每条内容输出为独立 Markdown 文件。运行时不依赖 `agent-reach` skill。

Skill 的规范调用名是 `$video-media-search-skill`（Codex Skill 名称只允许小写字母、数字和连字符）；仓库与项目目录继续使用 `video_media_search_skill`。要让 Codex 自动发现，需要把本目录安装或链接到 `~/.codex/skills/video-media-search-skill`。

## 当前支持

- Instagram：通过 OpenCLI + Chrome 登录态分页读取公开视频、caption、发布时间、点赞、评论、播放量、时长和 URL。
- 小红书：先滚动账号主页建立全部公开帖子清单，再按帖子访问令牌断点读取视频详情，避免主页首屏只能得到约 30 条；采集 caption、发布时间、点赞、评论、分享、收藏、时长、媒体地址和 URL。
- Markdown：一条内容一个 `.md`；按平台写入 `output/xiaohongshu` 或 `output/instagram`，文件名为“账号名称 - 点赞量 - Caption 第一行”。
- Excel：仅作为历史数据导入或用户明确要求时的兼容格式；默认交付不再创建或修改 Excel。
- Script / Transcript：当前批处理直接使用云端 GPU 上的 `Qwen/Qwen3-ASR-1.7B` 单次转写，结果直接作为最终 Script；不再调用 `qwen3-asr-flash`。无语音、非视频或不可访问内容会显示明确状态，不伪造文本。

## 指标口径

- 爆款倍率 = 单条有效播放量 / 本账号平均有效播放量。
- 互动率 =（点赞数 + 评论数 + 可获得的分享数）/ 有效播放量。
- 未公开字段保持为空，不使用 `0` 代替。

## 安全

平台 Cookie 只保存在本地 `.env` 中；`.env`、原始数据、检查点和输出文件均已加入 `.gitignore`。仓库只保存无凭据的适配器和处理脚本。

## 目录

- `adapters/opencli/`：只读 OpenCLI 平台适配器。
- `scripts/collect-social.mjs`：小红书与 Instagram 统一只读采集入口。
- `scripts/verify-platform-access.mjs`：验证小红书与 Instagram 实时浏览器桥接与登录态。
- `scripts/collect-data.mjs`：十账号采集与断点续跑。
- `scripts/collect-xhs-manifests.mjs`：滚动生成小红书账号全部公开帖子清单。
- `scripts/collect-xhs-ytdlp.py`：按签名 URL 断点补齐小红书视频详情和媒体地址。
- `scripts/transcribe-datasets.py`：旧版数据集合并入口；当前六账号云端批处理不使用它。
- `scripts/transcribe-xhs-qwen3-cloud.py`：小红书专用、流式抽音频、CUDA 批处理并原子保存断点的 `Qwen3-ASR-1.7B` 单次转写管线。
- `scripts/run-incremental-capture.mjs`：抓取并转写新增视频，生成规范化 `rows.json`。
- `scripts/export-to-markdown.py`：将历史 Excel 或增量 `rows.json` 转换为逐条 Markdown，并执行完整性验证。

整理旧语料并在成功校验后清理旧目录：

`python3 scripts/export-to-markdown.py organize outputs output --remove-source`
