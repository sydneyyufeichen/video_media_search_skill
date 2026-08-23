# allmedia_search_skill

这是视频内容采集与分析流程的试运行代码。当前阶段用于验证数据口径和 Excel 输出，尚未封装为正式 Codex Skill。

## 当前支持

- Instagram：通过 OpenCLI + Chrome 登录态分页读取公开视频、caption、发布时间、点赞、评论、播放量、时长和 URL。
- 小红书：通过 OpenCLI + Chrome 登录态读取账号公开视频列表及详情页中的 caption、发布时间、点赞、评论、分享和 URL。
- Excel：每个账号一个工作表，按爆款倍率降序排列；平台未公开播放量时保留空值，并用点赞数制作辅助排名图。
- 历史补全：可按帖子短码合并 `Ins Reel Data.xlsx` 中已有的 transcript。

## 指标口径

- 爆款倍率 = 单条有效播放量 / 本账号平均有效播放量。
- 互动率 =（点赞数 + 评论数 + 可获得的分享数）/ 有效播放量。
- 未公开字段保持为空，不使用 `0` 代替。

## 安全

平台 Cookie 只保存在本地 `.env` 中；`.env`、原始数据、检查点和输出文件均已加入 `.gitignore`。仓库只保存无凭据的适配器和处理脚本。

## 目录

- `adapters/opencli/`：只读 OpenCLI 平台适配器。
- `scripts/collect-data.mjs`：十账号采集与断点续跑。
- `scripts/build-workbook.mjs`：规范化、附件合并、公式、图表与 `.xlsx` 导出。

