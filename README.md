# allmedia_search_skill

这是视频内容采集与分析流程的试运行代码。当前阶段用于验证数据口径和 Excel 输出，尚未封装为正式 Codex Skill。

## 当前支持

- Instagram：通过 OpenCLI + Chrome 登录态分页读取公开视频、caption、发布时间、点赞、评论、播放量、时长和 URL。
- 小红书：先滚动账号主页建立全部公开帖子清单，再按帖子访问令牌断点读取视频详情，避免主页首屏只能得到约 30 条；采集 caption、发布时间、点赞、评论、分享、收藏、时长、媒体地址和 URL。
- Excel：每个账号一个工作表，按爆款倍率降序排列；平台未公开播放量时保留空值，并用点赞数制作辅助排名图。
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
- `scripts/build-workbook.mjs`：规范化、附件合并、公式、图表与 `.xlsx` 导出。
