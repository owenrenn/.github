---
type: fixed
---
The dead-path check reads every comment in a JS or TS file: a template literal nested inside another one's `${…}` no longer ends it early, which left the comments after it unread and their dead paths unchecked.
