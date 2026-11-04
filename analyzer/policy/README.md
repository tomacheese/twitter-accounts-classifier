# 検出ポリシー

`detection-policy.json` は本番運用開始時点の初期値であり、バックテスト結果を見ながら調整していくことを前提にしている。閾値そのものに強い根拠があるわけではなく、まず false positive を過度に出さない安全側の値から始め、`analyzer/backtest` の結果を見ながら運用者が更新する運用を想定している。

更新する際は `policyVersion` を必ず変更する。`policyHash` は内容の SHA-256 なので値を変えなければ `policyVersion` を変えても hash は変わらないが、`policyVersion` は人間が読む変更履歴として維持する。
