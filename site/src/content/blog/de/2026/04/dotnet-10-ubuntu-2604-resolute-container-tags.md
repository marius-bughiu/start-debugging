---
title: ".NET 10 auf Ubuntu 26.04: resolute Container-Tags und Native AOT im Archive"
description: "Ubuntu 26.04 Resolute Raccoon liefert .NET 10 im Archive aus, führt -resolute Container-Tags ein, die -noble ersetzen, und paketiert Native AOT-Tooling via dotnet-sdk-aot-10.0."
pubDate: 2026-04-24
tags:
  - "dotnet"
  - "dotnet-10"
  - "ubuntu"
  - "containers"
  - "native-aot"
  - "linux"
lang: "de"
translationOf: "2026/04/dotnet-10-ubuntu-2604-resolute-container-tags"
translatedBy: "claude"
translationDate: 2026-04-24
---

Ubuntu 26.04 "Resolute Raccoon" erreichte am 23. April 2026 die allgemeine Verfügbarkeit, und das Microsoft .NET-Team veröffentlichte den begleitenden Blogpost am selben Tag. Die Schlagzeile: .NET 10 liegt ab Tag eins im Distro-Archive, die Container-Tag-Benennung hat rotiert, und Native AOT bekommt endlich ein richtiges apt-Paket. Wenn Sie .NET auf Linux betreiben, ist das die Release, die verändert, wie Ihre `FROM`-Zeilen in den nächsten zwei Jahren aussehen.

## Resolute ersetzt noble in den Container-Tags

Ab .NET 10 referenzieren die Standard-Container-Tags Ubuntu-Images statt Debian. Mit 26.04 draußen hat Microsoft eine neue Ubuntu-26.04-basierte Variante unter dem Tag `resolute` hinzugefügt. Die Migration ist mechanisch:

```dockerfile
# Before
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble

# After
FROM mcr.microsoft.com/dotnet/aspnet:10.0-resolute
```

Die `noble`-Images existieren weiter und bekommen weiterhin 24.04-Base-Updates, es gibt also keinen erzwungenen Wechsel. Die `chiseled`-Varianten ziehen im Gleichschritt mit: `10.0-resolute-chiseled` wird parallel zum vollen Image veröffentlicht. Wenn Sie schon auf chiseled noble für distroless-artige Deployments waren, ist das Upgrade ein Tag-Tausch und ein Rebuild.

## .NET 10 aus dem Archive installieren

Auf 26.04 ist kein Microsoft-Paket-Feed nötig. Das Ubuntu-Archive bringt das SDK direkt mit:

```bash
sudo apt update
sudo apt install dotnet-sdk-10.0
```

.NET 10 ist LTS, also bekommt die Archive-Version Security-Servicing über Ubuntu bis zum End-of-Life der Distro. Das ist wichtig für gehärtete Umgebungen, die Drittanbieter-apt-Quellen blockieren.

## Native AOT als erstklassiges apt-Paket

Das ist die leise, aber wichtige Änderung. Bis 26.04 hieß Native AOT auf Ubuntu bauen, `clang`, `zlib1g-dev` und die richtigen Toolchain-Teile selbst zu installieren. Das 26.04-Archive liefert jetzt `dotnet-sdk-aot-10.0` aus, das die Linker-Teile mitzieht, die das `PublishAot`-Target des SDK erwartet.

```bash
sudo apt install -y dotnet-sdk-aot-10.0 clang
dotnet publish -c Release -r linux-x64
```

Microsoft nennt ein 1,4 MB Binary für eine Hello-World-App mit 3 ms Cold Start und ein 13 MB self-contained Binary für einen minimalen Web-Service. Die Größen- und Startup-Zahlen sind bekannt für alle, die AOT seit .NET 8 benutzt haben, aber dass sie aus einem einzigen `apt install` auf einem Standard-LTS fallen, ist neu.

## .NET 8 und 9 via dotnet-backports

Wenn Sie noch nicht bereit sind, auf 10 zu rebuilden, ist die `dotnet-backports` PPA der unterstützte Pfad für ältere noch-im-Support-Versionen auf 26.04:

```bash
sudo apt install -y software-properties-common
sudo add-apt-repository ppa:dotnet/backports
sudo apt install dotnet-sdk-9.0
```

Microsoft nennt das Best-Effort-Support, also behandeln Sie es als Brücke, nicht als Langzeitplan. Dass Ubuntu 26.04 .NET 10 am Launch-Tag parat hatte, kommt daher, dass `dotnet/runtime` CI seit Ende 2025 gegen Ubuntu 26.04 läuft. Wenn Sie die Mechanik nachvollziehen wollen, hat der [offizielle .NET-Blogpost](https://devblogs.microsoft.com/dotnet/whats-new-for-dotnet-in-ubuntu-2604/) die komplette Geschichte.
