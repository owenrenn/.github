---
type: fixed
---
The exit valve's board read now retries through a batch label sweep: five attempts with jittered waits of about 15s, 30s, 60s and 90s, so a removal made during a sweep no longer fails and strands its card until the daily reconcile. A retry is skipped when the hourly GraphQL budget is under a 1,000-point floor or unreported, which bounds the valve's spend whatever the board size, and the sync job's timeout rises to 15 minutes to hold the new worst case.
