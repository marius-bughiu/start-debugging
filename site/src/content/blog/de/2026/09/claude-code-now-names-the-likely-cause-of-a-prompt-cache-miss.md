---
title: "Claude Code nennt jetzt die wahrscheinliche Ursache eines Prompt-Cache-Miss"
description: "Claude Code 2.1.260 ergänzt die Zeile Prompt cache (main) in /usage und das prompt_cache-Objekt der Status Line um eine Ursachendiagnose. Statt Misses nur zu zählen, wird angegeben, ob sich der Tool-Satz geändert hat, ob sich der System-Prompt geändert hat oder ob die TTL abgelaufen ist."
pubDate: 2026-09-07
tags:
  - "claude-code"
  - "ai-agents"
  - "prompt-caching"
  - "token-cost"
lang: "de"
translationOf: "2026/09/claude-code-now-names-the-likely-cause-of-a-prompt-cache-miss"
translatedBy: "claude"
translationDate: 2026-09-07
---

Claude Code 2.1.260 liefert eine Diagnose, die eine alte Lücke beim Debuggen von Kosten schließt: Wenn der Prompt-Cache verfehlt wird, nennt Claude Code jetzt den Grund. Version 2.1.251 hatte bereits eine Zeile `Prompt cache (main)` im Session-Block von `/usage` ergänzt, doch diese Zeile zählte die Misses lediglich. Zu wissen, dass Sie drei vollständige Neuverarbeitungen einer Konversation mit 300k Tokens bezahlt haben, sagt nichts darüber aus, was Sie unterlassen sollten. Ab 2.1.260 nennt die Zeile eine wahrscheinliche Ursache, zum Beispiel `likely cause: tool definitions changed`.

## Warum ein Miss teuer und unsichtbar ist

Claude Code sendet die gesamte Konversation bei jedem Zug erneut, daher hält erst das Caching eine lange Sitzung bezahlbar. Die API gleicht das Präfix der Anfrage ab, und der Abgleich ist exakt: Eine Änderung an beliebiger Stelle im Präfix führt dazu, dass alles danach neu berechnet wird. Es gibt kein Caching pro Datei oder pro Segment. Deshalb listet die [Dokumentation zum Prompt Caching](https://code.claude.com/docs/en/prompt-caching) einen konkreten Satz von Aktionen auf, die den Cache invalidieren: unter anderem ein Modellwechsel, das Verbinden oder Trennen eines MCP-Servers, wenn die Tool-Suche dessen Tools nicht zurückstellt, das Sperren eines ganzen Tools über eine einfache Deny-Regel wie `Bash` sowie ein Update von Claude Code selbst.

Das Problem ist, dass die meisten dieser Vorgänge unsichtbar sind. Ein stdio-MCP-Server, dessen Prozess unbemerkt beendet wird, oder eine ablaufende HTTP-Session ändert mitten in der Sitzung Ihre Tool-Definitionen, ohne dass eine Meldung im Transcript erscheint. Sichtbar sind nur ein langsamer Zug und die Rechnung.

Claude Code zählt eine Anfrage als Miss, wenn sie mehr als 5% und mindestens 2.000 Tokens dessen neu verarbeitet hat, was aus dem Cache hätte gelesen werden können, ohne dass eine Kompaktierung oder ein Bereinigen alter Tool-Ergebnisse die Differenz erklärt. Durch Kompaktierung ausgelöste Rebuilds werden separat als Expected Rebuilds gezählt, was die Miss-Zahl ehrlich hält.

## Die Ursache aus einer Status Line lesen

Interessant für alle, die ihre Status Line skripten: Die Diagnose ist strukturiert, nicht nur Prosa. Das Objekt `prompt_cache` hat in 2.1.260 die Felder `last_miss_cause` und `miss_causes` erhalten. Das Array `causes` enthält Namen wie `tools_changed`, `system_prompt_changed`, `ttl_expired_5m` oder `likely_server_side`, und zwei davon liefern Zählwerte mit: `tools_changed` kommt mit `tools_added` und `tools_removed`, `system_prompt_changed` mit `system_char_delta`.

```bash
#!/bin/bash
input=$(cat)
cause=$(echo "$input" | jq -r '.prompt_cache.last_miss_cause.causes[0] // empty')
ratio=$(echo "$input" | jq -r '.prompt_cache.hit_ratio // 0')
printf "cache %.0f%%" "$(echo "$ratio * 100" | bc -l)"
[ -n "$cause" ] && printf " | last miss: %s" "$cause"
```

`last_miss_cause` ist `null`, bis der erste Miss der Sitzung auftritt, und ebenso immer dann, wenn Claude Code keine Ursache ermitteln kann. Sichern Sie den Zugriff also ab. `miss_causes` ist der aggregierte Wert: Eine Sitzung, die fünfmal `tools_changed` zeigt, hat einen instabilen MCP-Server und keinen Einzelfall.

Die Zahlen stammen aus den Cache-Token-Feldern der API-Antwort, also funktioniert das Ganze auf Bedrock, auf Google Cloud's Agent Platform und über ein Gateway. Es deckt nur die Hauptkonversation ab, nicht die Subagenten, und `/clear` setzt es zurück.

Dasselbe Release brachte außerdem ein `/diff`-Panel, das im Vollbildmodus neben der Konversation aufgeht und nicht committete Änderungen mitverfolgt, während Claude editiert. Wer die Release-Folge verfolgt: [2.1.261 brachte /skill-doctor](/de/2026/09/claude-code-2-1-261-skill-doctor-finds-skills-that-only-cost-context/) am Tag darauf. Die vollständigen Notizen stehen im [Release v2.1.260](https://github.com/anthropics/claude-code/releases/tag/v2.1.260), die Feldreferenz in der [Status-Line-Dokumentation](https://code.claude.com/docs/en/statusline#prompt-cache-fields).
