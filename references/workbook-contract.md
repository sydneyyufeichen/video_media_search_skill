# Canonical workbook contract

Source baseline: `allmedia_video_analysis_2026-08-24_metrics_added.xlsx`, audited on 2026-08-24.

## Invariants

- Keep one worksheet per account; do not add an `All Videos` sheet.
- Keep sheet order exactly: `阿飞泡枸杞`, `欧阳会食养`, `小七养生说`, `肖食儿`, `养生小禾`, `tcmbycheehee`, `wellness.with.gloria`, `dr.franktcm`, `yourtcmguide`.
- Keep historical rows in their current order. The current order is mixed historical ranking plus prior appends, not a strict date or Heat sort.
- Append new rows at the bottom, newest first within the new batch.
- Keep gridlines hidden, Times New Roman body typography, TableStyleMedium2 banding, existing borders/wrap behavior, and content-driven row heights.
- Keep the Likes data bar red `#D93A49` on Xiaohongshu sheets and purple `#7C3AED` on Instagram sheets.
- Preserve style-only trailing blank columns in `阿飞泡枸杞` and `yourtcmguide`; never treat them as data or delete them.

## Schemas

Xiaohongshu uses 9 columns:

| Col | Header | Type / rule |
|---|---|---|
| A | Timestamp | Excel datetime, display `mm-dd-yy` |
| B | Caption | text |
| C | Script | transcript text; never silently blank |
| D | Likes | integer `#,##0` |
| E | Comments | integer `#,##0` |
| F | Shares | integer `#,##0`; blank if unavailable |
| G | Heat | formula, display `0.00x` |
| H | Duration | seconds, display `0.0` |
| I | URL | canonical post URL |

Xiaohongshu Heat formula pattern:

`=IFERROR(SUM(Dn:Fn)/(SUM($D$2:$F$1048576)/COUNTA($I$2:$I$1048576)),"")`

Instagram uses 10 columns:

| Col | Header | Type / rule |
|---|---|---|
| A | Timestamp | Excel datetime, display `mm-dd-yy` |
| B | Caption | text |
| C | Script | transcript text; never silently blank |
| D | Likes | integer `#,##0` |
| E | Comments | integer `#,##0` |
| F | Views | prefer `view_count`, otherwise `play_count` |
| G | Heat | formula, display `0.00x` |
| H | Engagement | formula, display `0.0%` |
| I | Duration | seconds, display `0.0` |
| J | URL | canonical post URL |

Instagram formula patterns:

- Heat: `=IFERROR((Dn+En)/((SUM($D$2:$D$1048576)+SUM($E$2:$E$1048576))/COUNTA($J$2:$J$1048576)),"")`
- Engagement: `=IFERROR((Dn+En)/Fn,"")`

## Audited sizes and widths

| Sheet | Historical rows | Column widths |
|---|---:|---|
| 阿飞泡枸杞 | 538 | A 9.83, B 34.83, C 121.33, D 11, E 13, F 13, G 8.83, H 12, I 29.16 |
| 欧阳会食养 | 206 | A 11, B 61.33, C 112.16, D 7.5, E 10.5, F 7.33, G 7.5, H 9.33, I 18.33 |
| 小七养生说 | 99 | A 10, B 44, C 126.33, D 7.5, E 10.5, F 7.33, G 6.5, H 9.33, I 25.16 |
| 肖食儿 | 83 | A 10.66, B 34.33, C 135.66, D 7.5, E 10.5, F 7.5, G 13, H 9.33, I 12.16 |
| 养生小禾 | 57 | A 11.33, B 46.5, C 123.5, D 7.5, E 10.5, F 7.33, G 7.5, H 9.33, I 17.16 |
| tcmbycheehee | 288 | A 11, B 65, C 86, D 8.5, E 11.66, F 11, G 7.5, H 13.16, I 9.66, J 9 |
| wellness.with.gloria | 141 | A 11.16, B 48.5, C 102.16, D 7.5, E 11.66, F 10, G 7.5, H 13.16, I 9.66, J 10.66 |
| dr.franktcm | 97 | A 11.16, B 44, C 99, D 8.5, E 11.66, F 10, G 7.5, H 13.16, I 9.66, J 17.16 |
| yourtcmguide | 281 | A 11.66, B 44, C 106.33, D 8.5, E 11.66, F 10, G 7.5, H 13.16, I 9.66, J 10.5 |

The workbook currently has no frozen panes. Do not add them unless requested.
