---
title: "Der Auto-Modus von Claude Code erkennt jetzt das rm -rf mit leerer Variable"
description: "Die Releases der Woche 28 von Claude Code (v2.1.202-v2.1.206, 6. bis 10. Juli 2026) bringen dem Auto-Modus bei, vor einem rm -rf innezuhalten, dessen Pfad aus einer Variable stammt, die sich zu nichts aufgeloest hat, und schliessen so die klassische rm -rf /-Falle."
pubDate: 2026-07-13
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "de"
translationOf: "2026/07/claude-code-auto-mode-guards-empty-variable-rm-rf"
translatedBy: "claude"
translationDate: 2026-07-13
---

Jeder, der Shell-Skripte schreibt, kennt das Desaster: eine Aufraeumzeile wie `rm -rf "$BUILD_DIR/bin"`, bei der `$BUILD_DIR` nie gesetzt wurde, sodass sich der Befehl stillschweigend zu `rm -rf /bin` aufloest. Die Releases der Woche 28 von Claude Code (v2.1.202 bis v2.1.206, veroeffentlicht vom 6. bis 10. Juli 2026) fuegen genau fuer diesen Fall eine Absicherung im Auto-Modus hinzu: Der Agent haelt jetzt inne und fragt nach, bevor er ein `rm -rf` ausfuehrt, dessen Zielpfad aus einer Variable gebaut wurde, die sich zu nichts aufgeloest hat.

## Warum ein Agent haeufiger darauf hereinfaellt als Sie

Sie schreiben einen destruktiven Befehl einmal und pruefen ihn mit dem Auge. Ein Agent im Auto-Modus setzt Shell im Vorbeigehen zusammen und verwendet dabei oft eine Variable wieder, die er drei Zuege zuvor gesetzt hat. Wenn ein frueherer Schritt fehlgeschlagen ist und diese Variable leer gelassen hat, besteht die Gefahr nicht darin, dass das Modell absichtlich `rm -rf /` tippt. Sie besteht darin, dass es etwas tippt, das *begrenzt* und sicher *aussieht*, und die Shell macht daraus beim Aufloesen ein Loeschen auf Wurzelebene.

```bash
# The agent set this earlier, but the step that populated it failed
BUILD_DIR=""

# Looks scoped. Expands to: rm -rf /bin
rm -rf "$BUILD_DIR/bin"

# Same trap with an unset var under `set -u` off
rm -rf $ARTIFACTS_DIR/*
```

Der Klassifizierer im Auto-Modus untersucht jetzt den aufgeloesten Befehl, nicht nur den woertlichen Text, den Sie im Transkript sehen wuerden. Wenn der Pfad, den ein `rm -rf` gleich loeschen will, auf eine leere oder nicht aufgeloeste Variable zurueckgeht, haelt der Agent an und legt ihn Ihnen zur Freigabe vor, statt ihn auszufuehren.

## Absicht, kein pauschales Verbot

Das ist dieselbe Design-Linie, die Claude Code in [v2.1.183 gezogen hat, die destruktive Git- und IaC-Befehle blockierte, die der Agent eigenmaechtig ausfuehren wollte](/de/2026/06/claude-code-2-1-183-auto-mode-blocks-destructive-commands/). Ein bewusstes `rm -rf ./build`, um das Sie gebeten haben, laeuft weiterhin ohne Rueckfrage. Die Absicherung greift in dem spezifischen Fall, in dem das aufgeloeste Ziel weit umfassender ist als die Absicht, weil eine Variable leer war.

Vor Woche 28 bewertete der Auto-Modus `rm -rf "$BUILD_DIR/bin"` anhand der Oberflaechen-Zeichenkette, die sich wie ein enges, lokales Loeschen liest. Danach erfolgt die Pruefung gegen das, was die Shell tatsaechlich entfernen wird, sodass ein leeres `$BUILD_DIR` aus einem gruenen Licht eine Rueckfrage macht.

## Der Rest von Woche 28

Derselbe Release-Schwung haertet den Auto-Modus gegen Manipulation des Transkripts ab (der Agent kann seinen eigenen Sitzungsverlauf nicht mehr stillschweigend umschreiben), macht `/doctor` zu einer vollstaendigen Setup-Pruefung, die Probleme diagnostiziert und beheben kann, mit `/checkup` als Alias, und ueberarbeitet die Ansicht `claude agents` so, dass jede Zeile ein farbiges Statuswort und eine von einem Klassifizierer geschriebene Ueberschrift statt der rohen Tool-Ausgabe zeigt. Die Desktop-App hat diese Woche ausserdem einen integrierten Browser bekommen, sodass Claude Dokumentation und Designs oeffnen kann, so wie es bereits die Vorschauen Ihres lokalen Entwicklungsservers steuert.

Wenn Sie Agenten im Auto-Modus gegen echte Repositories oder CI-Checkouts laufen lassen, ist das die Art von Absicherung, die Sie erst an dem Tag bemerken, an dem sie Sie rettet. Die vollstaendigen Notizen finden Sie im [Claude Code Changelog](https://code.claude.com/docs/en/changelog).
