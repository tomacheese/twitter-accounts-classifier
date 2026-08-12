# Evaluation methodology

Weekly Review must not conflate quality estimation with bug hunting.

- Random audit: for each label/value in the target period, perform seeded randomization within a bounded candidate set to control database load. Because the candidate set itself is not a perfectly uniform sample of the entire population, do not interpret its observed error rate as strict population precision. A targeted-sample error rate is even less suitable as a population-precision estimate.
- Targeted audit: prioritize recent changes, active findings, metric shifts, low-confidence positives, high-confidence negatives, old rule versions, and rare reasons to find defects.
- Do not treat a fixed sample of 20 as sufficient quality assurance. NIST demonstrates that required sample size varies with power, margin, and confidence level for proportion estimates and tests.
- Do not interpret zero observed defects in a small sample as a zero error rate. Record only that no defects were observed.
- Continuously monitor changes in production-data distribution, coverage, and missing or stale data. Follow the principles in Google's production ML monitoring and data-validation guidance.

Primary sources:

- NIST sample sizes for proportions: https://itl.nist.gov/div898/handbook/prc/section2/prc242.htm
- NIST proportion confidence intervals: https://itl.nist.gov/div898/handbook/prc/section2/prc241.htm
- Google Production ML monitoring: https://developers.google.com/machine-learning/crash-course/production-ml-systems/monitoring
- Google Data Validation for Machine Learning: https://research.google/pubs/data-validation-for-machine-learning/
- Google Rules of Machine Learning: https://developers.google.com/machine-learning/guides/rules-of-ml
