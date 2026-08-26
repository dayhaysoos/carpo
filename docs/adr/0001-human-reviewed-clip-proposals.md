---
status: accepted
---

# Route agent clip proposals through one human-controlled review

Think and WebMCP are proposal producers, not Clip creators: both adapt into one provider-neutral Clip Proposal Review module that owns frozen batches, manual range correction, reversible decisions, idempotent Clip creation, per-proposal failure recovery, and terminal acknowledgement. A Clip is persisted only after the user finishes Carpo's in-page review; the standalone manual editor remains separate, unfinished reviews are session-scoped, and the first migration moves Think onto this seam before WebMCP becomes its second adapter.
