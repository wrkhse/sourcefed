# sourcefed monitors

Monitors watch a Jira issue, GitHub PR, Slack thread, a timer, or a feed read through Yab and bring new events
into this session.

Create one with `monitor_create` when:

- you work on a Jira ticket: `{ name: "<key>", source: { type: "jira", issueKey: "PROJ-123" } }`
  (new comments, edits, status, assignee, priority, labels);
- your branch has a PR: `{ name: "<pr>", source: { type: "github", repo: "owner/name", prNumber: 42 } }`
  (reviews, comments, CI failures, conflicts, merge or close);
- you were given a Slack thread: `{ name: "<thread>", source: { type: "slack", threadUrl: "<url>" } }`
  (new messages; read-only, never replies);
- the user wants new entries of a feed they are signed in to in Yab (unread Gmail, a job board's RSS):
  `{ name: "<feed>", source: { type: "yab", url: "https://mail.google.com/mail/u/0/feed/atom", space: "Personal", match: "interview|offer" } }`
  (each new entry; `match`/`exclude` are case-insensitive regexes; Yab must be running);
- you need to come back to something later: `{ name: "<job>", source: { type: "timer", job: "check the deploy", in: "20m" } }`
  (once with `in` or `at`, or each period with `every: "45m"`; a one-shot ends once it fires).

Keep the default `pollIntervalSec` unless the work is time-sensitive (min 15).
`monitor_list`, `monitor_status { id }` and `monitor_stop { id }` act on this session's monitors.
GitHub monitors end when the PR merges; one-shot timers end when they fire.

An event arrives as a message. Act on it if it needs action, or tell the user it needs a
decision; acknowledge an informational one (such as CI passing) and move on. Never invent work
from it. `sourcefed skills get core` has the full guide.
