---
title: "Cloud-Sessions von Claude Code laufen jetzt auf Ihren eigenen Hosts"
description: "Claude Code 2.1.224 ergänzt claude self-hosted-runner, eine Public Beta, die Cloud-Sessions auf selbst bereitgestellten Maschinen ausführt. Hier sind das Setup, die Ein-Nutzer-Regel pro Runner und das, was weiterhin Ihr Netzwerk verlässt."
pubDate: 2026-08-11
tags:
  - "claude-code"
  - "ai-agents"
  - "devops"
lang: "de"
translationOf: "2026/08/claude-code-self-hosted-runner-cloud-sessions-on-your-own-hosts"
translatedBy: "claude"
translationDate: 2026-08-11
---

Cloud-Sessions in Claude Code, also jene, die Sie über claude.ai, die Mobil- und Desktop-Apps, eine geplante Routine oder das Terminal mit `claude --cloud` starten, liefen bislang immer auf der Infrastruktur von Anthropic. Claude Code 2.1.224, veröffentlicht am 2026-08-07, ändert das. Ein neuer Unterbefehl, `claude self-hosted-runner`, macht einen Linux- oder macOS-Host zu der Maschine, die die Session tatsächlich ausführt. Es handelt sich um eine Public Beta in den Plänen Team und Enterprise, und sie bleibt unsichtbar, bis ein Owner oder Admin auf der Adminseite Cloud environments die Option "Allow self-hosted environments" einschaltet.

## Environment, Runner, Session

Drei Bausteine sorgen dafür. Ein **Environment** ist ein benanntes Ziel, das in den Admineinstellungen von claude.ai angelegt wird und in der Umgebungsauswahl neben den von Anthropic gehosteten Optionen erscheint. Ein **Runner** ist ein langlebiger Prozess, den Sie innerhalb Ihres Netzwerks bereitstellen. Eine **Session** ist eine Aufgabe, die ein Runner aus der Warteschlange des Environments übernimmt; er klont das Repository und startet einen untergeordneten `claude`-Prozess, der die Arbeit erledigt.

Das kleinste funktionierende Setup besteht aus drei Befehlen plus dem Environment-Secret, das claude.ai genau einmal bei der Erstellung anzeigt und das nach 365 Tagen abläuft:

```bash
mkdir -p /etc/claude
(umask 077 && cat > /etc/claude/environment-secret)
mkdir -p /srv/claude-work

claude self-hosted-runner \
  --environment-secret-file '/etc/claude/environment-secret' \
  --base-dir '/srv/claude-work'
```

Ohne `--base-dir` greift der Runner auf `/workspace` zurück, was nur funktioniert, wenn dieser Pfad bereits existiert und beschreibbar ist. Prüfen Sie den Host zuerst mit `claude self-hosted-runner --help`: In allen Versionen älter als 2.1.224 wird der Unterbefehl nicht erkannt und Sie erhalten stattdessen die allgemeine Ausgabe von `claude --help`. Es gibt außerdem einen geführten Weg, `claude self-hosted-runner setup`, der die Schritte in der Admin-Oberfläche durchgeht und einen Spickzettel nach `./runner-setup/CHEAT-SHEET.md` schreibt.

## Warum ein Runner genau einen Nutzer bedient

Das ist die Designentscheidung, die Ihre Flottengröße bestimmt. Die erste Session, die ein Runner übernimmt, bindet diesen Runner an das Konto des Nutzers, der sie gestartet hat, und danach nimmt er nur noch Arbeit für dieses Konto an, bis zu `--capacity` gleichzeitigen Sessions. Der Standardwert für die Kapazität ist `1`. Die Mindestgröße Ihrer Flotte entspricht damit der Anzahl der Nutzer, die Sie gleichzeitig aktiv erwarten, nicht der Anzahl der Sessions.

Runner sind zudem standardmäßig kurzlebig. `--drain-grace-sec` steht per Voreinstellung auf `0`, sodass ein Runner beendet wird, sobald seine aktiven Sessions fertig sind, statt weiter die Warteschlange abzufragen. Kubernetes kann ihn so mit einer frischen Festplatte neu starten, bereit für jedes Konto. Genau dadurch entsteht die Isolation der Checkouts pro Nutzer, ohne dass Zustand zwischen Nutzern gelöscht werden muss. Das Abfragen dient gleichzeitig als Heartbeat: Bleibt es rund 60 Sekunden aus, stellt die Steuerungsebene die Session anderswo erneut in die Warteschlange. Health-Endpunkt und Prometheus-Metriken liegen unter `/healthz` und `/metrics` auf `--health-port`, Standard `8080`.

## Was weiterhin an api.anthropic.com geht

Repository-Checkouts, Build-Artefakte, Secrets und jede Datei, die eine Session schreibt, bleiben auf Ihren Maschinen. Die Konversation nicht: Prompts, Antworten und Tool-Ergebnisse gehen zur Inferenz an `api.anthropic.com`, und Anthropic speichert das Transkript, damit die Session von einer anderen Oberfläche aus fortgesetzt werden kann. Jede Verbindung ist ausgehend, und Anthropic verbindet sich niemals in Ihr Netzwerk hinein.

Drei Einschränkungen sollten Sie vor einem Rollout prüfen. Organisationen mit Zero Data Retention können dies nicht nutzen. Die Inferenz lässt sich nicht über Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry oder ein LLM-Gateway leiten, weil Sessions sich mit einem von Anthropic ausgestellten, sessiongebundenen Token authentifizieren. Und Sessions von Claude Tag, Claude Security und Code Review werden noch nicht an selbst gehostete Environments geroutet.

Dieselbe Version brachte auch das [Messaging zwischen Sessions](/de/2026/08/claude-code-2-1-224-sessions-message-each-other/). Die vollständigen Flag-Tabellen finden Sie in der [Referenz zu selbst gehosteten Environments](https://code.claude.com/docs/en/self-hosted-environments-reference).
