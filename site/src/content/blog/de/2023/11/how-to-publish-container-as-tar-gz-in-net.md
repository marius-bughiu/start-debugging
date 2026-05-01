---
title: "Wie Sie einen Container als tar.gz in .NET veröffentlichen"
description: "Erfahren Sie, wie Sie einen .NET 8 Container als tar.gz-Archiv über die Eigenschaft ContainerArchiveOutputPath mit dotnet publish veröffentlichen."
pubDate: 2023-11-11
tags:
  - "docker"
  - "dotnet"
lang: "de"
translationOf: "2023/11/how-to-publish-container-as-tar-gz-in-net"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ab .NET 8 ist es möglich, ein tar.gz-Containerarchiv direkt zu erzeugen. Das ist besonders vorteilhaft für komplexere Arbeitsabläufe, in denen Aktivitäten wie das Scannen der Images vor dem Push erforderlich sind. Nach Erstellung des Archivs kann es übertragen, gescannt oder in Ihre lokale Docker-Installation eingebunden werden.

Um beim Veröffentlichen zu archivieren, ergänzen Sie das Attribut `ContainerArchiveOutputPath` in Ihrem dotnet publish-Befehl. Zum Beispiel:

```bash
dotnet publish \
  -p PublishProfile=DefaultContainer \
  -p ContainerArchiveOutputPath=./containers/my-container.tar.gz
```
