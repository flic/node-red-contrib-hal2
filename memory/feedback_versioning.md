---
name: Versionshantering
description: En minor-bump per färdig funktion; patch-nivåer under utvecklingsarbetet
type: feedback
---

Öka **minor**-versionen i package.json (t.ex. 2.4.2 → 2.5.0) för **en färdig funktion** — inte
för varje delleverans på vägen dit.

Öka **patch**-versionen (t.ex. 2.5.0 → 2.5.1) för buggrättningar, och för iterationen medan en
funktion fortfarande byggs.

Versionen ska spegla vad den som installerar paketet ser. Kod som aldrig publicerats kan inte
vara brytande för någon, så den motiverar varken major- eller minor-bump.

**Why:** Användaren vill ha tydlig versionshistorik kopplad till features. Under arbetet med
hal2Bayes bumpades minor vid varje delsteg, och major när en osläppt nods schema skrevs om — det
tog paketet från 2.4.2 till 3.4.2 trots att allt utifrån sett bara var "en ny nod tillkom".
Branchen backades till 2.5.0.

**How to apply:** Fråga vad som ändrats *för den som installerar paketet*. Ny funktionalitet
tillgänglig för användare → minor, en gång. Rättningar och pågående arbete → patch. Major endast
när något publicerat slutar fungera som förut.
