---
name: Versionshantering
description: Minor version ska ökas med 1 i package.json vid ny funktionalitet
type: feedback
---

Öka minor-versionen i package.json (t.ex. 1.2.0 → 1.3.0) varje gång ny funktionalitet läggs till.

Öka patch version i package.json (t.ex. 1.2.0 → 1.2.1) varje gång vi rättar en bugg.

**Why:** Användaren vill ha tydlig versionshistorik kopplad till features.
**How to apply:** Vid varje PR/ändring som tillför ny funktionalitet — bumpa minor, inte patch.
