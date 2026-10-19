---
"@codai/axiom-checks": patch
"@codai/axiom-mcp": patch
---

`content.noSecrets` (`pii: true`): the e-mail detector no longer reports Google Cloud service-account addresses (`*@*.iam.gserviceaccount.com`, `*-compute@developer.gserviceaccount.com`, `*@appspot.gserviceaccount.com`) as personal data — they are machine identities. Look-alikes such as `x@gserviceaccount.com.evil.ro` are still flagged.
