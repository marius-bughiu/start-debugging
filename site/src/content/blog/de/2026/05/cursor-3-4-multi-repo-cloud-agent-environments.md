---
title: "Cursor 3.4 bringt Multi-Repo-Umgebungen und schnellere Dockerfile-Builds für Cloud Agents"
description: "Cursor 3.4 (13. Mai 2026) erlaubt es, dass eine Cloud-Agent-Umgebung mehrere Repositories umfasst, ergänzt Build-Secrets für Dockerfiles, Layer-gecachte Rebuilds, die 70% schneller laufen, und einen agentengeführten Setup-Schritt, der Credentials vor dem ersten Lauf validiert."
pubDate: 2026-05-21
tags:
  - "cursor"
  - "ai-agents"
  - "cloud-agents"
  - "docker"
lang: "de"
translationOf: "2026/05/cursor-3-4-multi-repo-cloud-agent-environments"
translatedBy: "claude"
translationDate: 2026-05-21
---

Am 13. Mai 2026 hat Cursor [Version 3.4](https://cursor.com/changelog) veröffentlicht, und das Release dreht sich vor allem um die Infrastruktur, die Flotten von Cloud Agents brauchen, um wirklich arbeiten zu können. Die Schlagzeile sind Multi-Repo-Umgebungen, aber die Build-Secret- und Layer-Caching-Änderungen darunter machen es überhaupt erst billig genug, viele Agents parallel laufen zu lassen. Es ist eine direkte Fortsetzung der Parallelisierungs-Arbeiten in [Cursor 3.3](/de/2026/05/cursor-3-3-build-in-parallel-split-prs/) und richtet sich an Teams, die Aufgaben bereits auf Subagenten verteilen und an die Wand "ein Repo pro Umgebung" gestoßen sind.

## Eine Umgebung, viele Repositories

Bis 3.4 war die Umgebung eines Cloud Agents auf ein einziges Repository beschränkt. Das brach in dem Moment zusammen, in dem eine Aufgabe Grenzen überschritt: eine Backend-API plus ihr geteiltes Types-Paket, eine Flutter-App plus ein Dart-Server oder eine `.NET`-Solution plus ein benachbartes Infrastruktur-Repo. Entweder Sie haben die zusätzlichen Repos manuell im Setup-Skript geklont (langsam, fragil) oder die Aufgabe geteilt und den Kontext zwischen den Repos verloren.

Cursor 3.4 nutzt die Multi-Root-Workspace-Mechanik weiter und lässt Sie jedes Repository, das der Agent braucht, als Teil der Umgebungsdefinition auflisten. Eine typische Konfiguration sieht so aus:

```json
{
  "name": "api-and-shared-types",
  "repositories": [
    { "url": "github.com/acme/api", "branch": "main" },
    { "url": "github.com/acme/shared-types", "branch": "main" }
  ],
  "dockerfile": "./infra/agent.Dockerfile"
}
```

Beide Repos werden in dieselbe Umgebung geklont, und der Agent sieht sie als einen einzigen Workspace. Sessions verwenden die Umgebung wieder, also ist das Hochfahren eines neuen Agents gegen dasselbe Paar ein Cache-Treffer statt eines frischen Clones.

## Build-Secrets und 70% schnellere Cache-Treffer

Auch der Dockerfile-Pfad bekam zwei praktische Korrekturen. Die erste ist `--mount=type=secret` für Build-Secrets, die außerhalb des laufenden Containers bleiben:

```dockerfile
# syntax=docker/dockerfile:1.7
FROM mcr.microsoft.com/dotnet/sdk:9.0
RUN --mount=type=secret,id=nuget_pat \
    dotnet nuget add source https://nuget.pkg.github.com/acme/index.json \
      --name acme --username ci \
      --password "$(cat /run/secrets/nuget_pat)" --store-password-in-clear-text
COPY . /src
WORKDIR /src
RUN dotnet restore
```

Das PAT ist auf den Build-Schritt beschränkt, sodass der Agent-Prozess, der später läuft, es nicht lesen kann. Damit ist die Lücke geschlossen, in der private Paket-Feeds bisher bedeuteten, Credentials ins Image oder ins Umgebungs-Skript einzubacken.

Die zweite Korrektur ist das Layer-Caching. Builds, die den Cache treffen, laufen laut Release Notes 70% schneller, weil nur veränderte Layer neu kompiliert werden, wenn Sie das Dockerfile bearbeiten. In der Praxis heißt das: an der Zeile `RUN apt-get install ...` zu iterieren, invalidiert kein langes `dotnet restore` darunter mehr, solange der Restore-Layer über der Änderung liegt.

## Agentengeführtes Setup erkennt fehlende Credentials vor dem Lauf

Wenn Sie eine Umgebung erstellen oder aktualisieren, führt Cursor jetzt einen Setup-Lauf aus, der Rückfragen stellt, fehlende Credentials identifiziert und prüft, dass der Build erfolgreich ist, bevor ein Agent die Umgebung nutzen darf. Schlägt der Build fehl, fällt die Umgebung auf ein Basis-Image zurück und zeigt die Warnung an, statt in dem Moment still zu scheitern, in dem ein Agent zu klonen versucht.

Jede Umgebung führt außerdem eine Versionshistorie mit auf Admins beschränktem Rollback und ein Audit-Log, wer was geändert hat. Für Teams, die parallelisierte Agents bereits im großen Stil betreiben, wiegen diese Leitplanken mehr als die Geschwindigkeitsgewinne.

Das vollständige [Cursor Changelog](https://cursor.com/changelog) enthält den Rest von 3.4.
