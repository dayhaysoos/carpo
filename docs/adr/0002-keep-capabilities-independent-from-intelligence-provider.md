---
status: accepted
---

# Keep capabilities independent from the intelligence provider

Carpo treats its manual UI, built-in Think assistant, and external WebMCP agents as clients of the same application capabilities. Every meaningful capability available to Think must also be available manually and through WebMCP; Think has no privileged domain access. This requires capability parity rather than conversational-UI parity: each client may provide a different experience, while shared Carpo boundaries own authorization, validation, idempotency, human review, and recoverable manual correction. The additional work of maintaining explicit provider-independent contracts is accepted so users can operate Carpo without built-in AI or bring their own agent without weakening product safeguards.
