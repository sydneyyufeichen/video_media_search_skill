# allmedia_search_skill

这是一个正式 Codex Skill，用于增量采集小红书与 Instagram 新发布视频，并在不改动历史行、顺序和样式的前提下追加到现有账号子表。

## 当前支持

- Instagram：通过 OpenCLI + Chrome 登录态分页读取公开视频、caption、发布时间、点赞、评论、播放量、时长和 URL。
- 小红书：先滚动账号主页建立全部公开帖子清单，再按帖子访问令牌断点读取视频详情，避免主页首屏只能得到约 30 条；采集 caption、发布时间、点赞、评论、分享、收藏、时长、媒体地址和 URL。
- Excel：每个账号一个工作表；后续更新只在底部追加新内容，不重排历史行，并沿用当前文件的列顺序、颜色、公式、列宽和表格样式。
- Script / Transcript：优先按帖子短码合并 `Ins Reel Data.xlsx` 中已有文本；其余视频下载音轨后使用 Whisper 自动转写。无语音、非视频或不可访问内容会显示明确状态，不伪造文本。

## 指标口径

- 爆款倍率 = 单条有效播放量 / 本账号平均有效播放量。
- 互动率 =（点赞数 + 评论数 + 可获得的分享数）/ 有效播放量。
- 未公开字段保持为空，不使用 `0` 代替。

## 安全

平台 Cookie 只保存在本地 `.env` 中；`.env`、原始数据、检查点和输出文件均已加入 `.gitignore`。仓库只保存无凭据的适配器和处理脚本。

## 目录

- `adapters/opencli/`：只读 OpenCLI 平台适配器。
- `scripts/collect-data.mjs`：十账号采集与断点续跑。
- `scripts/collect-xhs-manifests.mjs`：滚动生成小红书账号全部公开帖子清单。
- `scripts/collect-xhs-ytdlp.py`：按签名 URL 断点补齐小红书视频详情和媒体地址。
- `scripts/transcribe-datasets.py`：合并附件 transcript，并对缺失视频执行 Whisper 音轨转写。
- `scripts/run-incremental-capture.mjs`：读取现有工作簿 ID，抓取并转写新增视频，生成待追加的 `rows.json`。
- `scripts/check-workbook-backend.py`：根据公式与表格范围选择 Excel 实时追加或离线 artifact-tool。
- `scripts/append-incremental-workbook.mjs`：仅用于范围受限工作簿的离线追加；当前规范文件优先走 Excel 实时追加。
