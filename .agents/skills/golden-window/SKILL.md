---
name: golden-window
description: Add or review a synthetic consensus golden window, its author-counted expectations and offline coverage in Spokesmob.
---

# Add a golden window

Read `eval/src/golden.ts` and one nearby case in `eval/golden/` for the current format. Use the existing loader, crowd generator and pipeline; do not add a parallel evaluator.

1. Choose a behavior-based name and category. Describe one observable consensus or suppression behavior.
2. Use explicit synthetic `messages` for small cases, or a seeded `crowd` with author quotas, phrase lists and variation settings. Keep usernames synthetic. Distinct authors determine agreement; repeated messages do not add votes.
3. Store offensive text only in `text_b64`, including encoded phrase objects in a crowd. Never print decoded offensive text or put real credentials in a canary. Use invented payload markers for instruction tests.
4. Draft `expect`: speak or suppress, cited include/exclude terms, percent range, dissent, forbidden substrings and allowed moods as applicable. Derive the percentage from author sets. Keep human approval separate from drafting; do not change thresholds or schema to pass a case.
5. Validate the case with the golden loader tests and run `npm run consensus -- <golden-name>` offline. Once available, use `npm run eval -- --offline` for harness wiring. Offline moderation is a fake and cannot establish safety or model quality. Paid runs require explicit approval.

Update the review table when expectations change. Keep reports in `eval/reports/`, and store source fixtures rather than copied model output in the golden set.
