# Evaluation methodology

Weekly Review は「品質推定」と「バグ探索」を混同しない。

- random audit: 対象期間の各 label/value について、DB 負荷を bounded に保つ候補集合内で seed 付きランダム化を行う。候補集合自体が母集団の完全な一様抽出ではないため、誤分類率を厳密な母集団 precision と解釈しない。targeted sample の誤分類率はなおさら全体 precision として扱わない。
- targeted audit: recent change、active finding、metric shift、低 confidence positive、高 confidence negative、旧 rule version、rare reason を優先してバグを探す。
- sample size は固定 20 件を品質保証の根拠にしない。NIST は proportion の検定力・許容差・信頼水準に応じて sample size が変わることを示している。
- 小標本で defect が 0 件でも「誤分類率 0」とは扱わない。観測できなかっただけと記録する。
- production data の distribution、coverage、missing/stale data の変化を継続監視する。Google の production ML guidance と data validation の考え方を参考にする。

一次情報:

- NIST sample sizes for proportions: https://itl.nist.gov/div898/handbook/prc/section2/prc242.htm
- NIST proportion confidence intervals: https://itl.nist.gov/div898/handbook/prc/section2/prc241.htm
- Google Production ML monitoring: https://developers.google.com/machine-learning/crash-course/production-ml-systems/monitoring
- Google Data Validation for Machine Learning: https://research.google/pubs/data-validation-for-machine-learning/
- Google Rules of Machine Learning: https://developers.google.com/machine-learning/guides/rules-of-ml
