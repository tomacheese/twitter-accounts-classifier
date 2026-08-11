# External research contract

On every run, start `weekly-review-researcher` in parallel with sample review.

Research source priority:

1. Official X policies and developer documentation
2. Original papers and primary research
3. Primary analysis from reputable security research organizations or researchers
4. News reporting
5. Isolated reports on social media

At minimum, review X's Authenticity policy. Compare its taxonomy for bulk or high-volume replies, irrelevant replies, duplicative or copypasta content, engagement spam, coordination, scams, and related behavior against existing rules.

Primary source:

- X Authenticity policy: https://help.x.com/en/rules-and-policies/authenticity

Do not change code based on external information alone. Emit `external_threat_gap` only when the behavior is reproducible, observable through features collected by this project, and insufficiently covered by existing rules.
