# External research contract

毎 run、sample review と並列で `weekly-review-researcher` を起動する。

調査の優先順位:

1. X 公式 policy / developer documentation
2. 原著論文・一次研究
3. 信頼できるセキュリティ研究機関・研究者の一次分析
4. 報道
5. SNS 上の単発報告

最低限、X の Authenticity policy を確認する。bulk/high-volume replies、irrelevant replies、duplicative/copypasta、engagement spam、coordination、scam などの taxonomy と既存 rule の対応を確認する。

一次情報:

- X Authenticity policy: https://help.x.com/en/rules-and-policies/authenticity

外部情報だけを根拠にコードを変更しない。`external_threat_gap` を出すには、再現性があり、このプロジェクトが収集している feature で観測可能で、既存 rule では十分に covered されないことを確認する。
