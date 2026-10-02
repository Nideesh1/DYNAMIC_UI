---
name: runbook
description: Latency incident runbook. Read it before triaging any latency, timeout or p99 alert.
---

# Latency incident runbook

1. Scope: which service alerted, since when (UTC), which user flow is affected (checkout, cart, login).
2. Severity: SEV1 if checkout or payments p99 > 2s or error rate > 5%, else SEV2.
3. Hypotheses, in this order:
   - a deploy or config change in the 30 minutes before the alert
   - a saturated dependency (DB connection pool, cache, downstream API)
   - a traffic spike or retry storm
4. Split the investigation:
   - logs and metrics: error logs, p99 latency, error rate, pool saturation, the paging incident
   - code: recent deploys, the diff of any suspicious commit, code owners, service dependencies
5. Output of triage: severity, affected service, 2-3 hypotheses, and one question each for logs and code.
