---
type: fixed
---
The exit valve's board read now retries through a batch label sweep: five attempts with jittered waits of about 15s, 30s, 60s and 90s, so a removal made during a sweep no longer fails and strands its card until the daily reconcile; the sync job's timeout rises to 15 minutes to hold the new worst case.
