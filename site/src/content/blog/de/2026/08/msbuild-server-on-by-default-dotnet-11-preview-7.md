---
title: "Der MSBuild-Server ist in .NET 11 Preview 7 standardmäßig aktiv"
description: "Preview 7 stellt den MSBuild-Server von opt-in auf standardmäßig aktiv um, sodass aufeinanderfolgende Aufrufe von dotnet build und dotnet test einen warmen Worker-Prozess wiederverwenden. Was sich geändert hat, wie Sie das abschalten und wie Sie nachweisen, dass der Server tatsächlich verwendet wurde."
pubDate: 2026-08-18
tags:
  - "dotnet-11"
  - "msbuild"
  - "dotnet-sdk"
  - "build-performance"
lang: "de"
translationOf: "2026/08/msbuild-server-on-by-default-dotnet-11-preview-7"
translatedBy: "claude"
translationDate: 2026-08-18
---

.NET 11 Preview 7 erschien am 2026-08-11, und im SDK-Abschnitt versteckt sich eine geänderte Voreinstellung, die jeden einzelnen Build betrifft: Der MSBuild-Server ist nun aktiv, sofern Sie ihn nicht ausdrücklich abschalten ([dotnet/sdk#55231](https://github.com/dotnet/sdk/pull/55231)).

Der MSBuild-Server hält zwischen CLI-Aufrufen einen warmen MSBuild-Worker-Prozess am Leben. Ohne ihn zahlt jeder `dotnet build`, `dotnet test` und `dotnet run` für den Start des MSBuild-Prozesses, das Aufwärmen des JIT und die SDK-Auflösung von Grund auf. Mit ihm überspringen der zweite Aufruf und alle weiteren diesen Aufwand. Die Funktion existierte seit mehreren Releases hinter `MSBUILDUSESERVER`, und Preview 7 bringt sie zu Ende, indem "aktiv" zur Voreinstellung wird.

## Abschalten, und welche Variable wirklich gewinnt

Zwei Umgebungsvariablen schalten den Server ab, und sie sind nicht gleichwertig:

```bash
# Either of these keeps the classic single-shot MSBuild behavior
export DOTNET_CLI_USE_MSBUILD_SERVER=false
export MSBUILDUSESERVER=0
```

`DOTNET_CLI_USE_MSBUILD_SERVER=false` ist jetzt maßgeblich. Die Variable reicht `MSBUILDUSESERVER=0` weiter, sodass der Server nicht stillschweigend durch eine Antwortdatei, durch `MSBUILDFORCEMULTITHREADED=1` oder durch die Übergabe von `/mt` wieder aktiviert werden kann ([dotnet/sdk#55393](https://github.com/dotnet/sdk/pull/55393)). Wenn eine CI-Stufe pro Build garantiert einen kalten Prozess benötigt, ist das die Variable Ihrer Wahl. Wer nur `MSBUILDUSESERVER=0` setzt, lässt die Tür offen, dass etwas weiter unten den Server wieder einschaltet.

## Warum sich die Voreinstellung jetzt geändert hat

Die Voreinstellung hat sich nicht von selbst geändert. Preview 7 hat den Server gehärtet, weil der experimentelle Multithread-Build-Modus (`-mt`) ihn als Voraussetzung behandelt, und im selben Release wurden mehrere langjährige Schwachstellen behoben:

- Garbage Collection im Server-Modus steht nun auch mit `-nr:false` zur Verfügung. Da der MSBuild-Server der einzige Weg zum Server GC ist, verwendet `-mt` jetzt einen kurzlebigen Server, der sich direkt nach dem Build selbst beendet und damit die Absicht "keine Wiederverwendung" respektiert ([dotnet/msbuild#14248](https://github.com/dotnet/msbuild/pull/14248)).
- Verschachtelte MSBuild-Prozesse führen nicht mehr zum Deadlock. Ein Build, der von einer Task gestartet wird, die ihrerseits MSBuild aufruft, läuft weiter, ohne auf den äußeren Koordinator zu warten ([dotnet/msbuild#14224](https://github.com/dotnet/msbuild/pull/14224)).
- Unerwartete Ausnahmen während des ersten Verbindungs-Handshakes werden abgefangen und sauber gemeldet, statt den Client abzubrechen ([dotnet/msbuild#14292](https://github.com/dotnet/msbuild/pull/14292)).

Am deutlichsten zahlt sich das bei `-mt`-Builds aus, die für JIT- und SDK-Auflösungszustand auf den warmen Server setzen. Im Performance-Dashboard von MSBuild lief ein `-t:Rebuild` der OrchardCore-Solution von Grund auf im Schnitt 26% schneller mit `-mt` unter Windows (von 146,2 s auf 107,8 s) und 23% schneller unter Linux (von 118,8 s auf 91,5 s).

## Nachweisen, dass der Server verwendet wurde

Ein stiller Kaltstart sieht genauso aus wie ein warmer, nur langsamer. Preview 7 ergänzt ein strukturiertes Build-Ereignis `MSBuildServerLifecycleEventArgs`, das meldet, ob der Server gestartet, kurzlebig gestartet, wiederverwendet oder gar nicht genutzt wurde, samt Prozess-ID des Servers ([dotnet/msbuild#14156](https://github.com/dotnet/msbuild/pull/14156)). Es wird mit niedriger Wichtigkeit protokolliert und erscheint daher in Binärlogs und bei diagnostischer Ausführlichkeit, ohne die normale Konsolenausgabe zu verändern:

```bash
dotnet build -v:diag
# or capture it for later
dotnet build -bl
```

Wenn Sie einen sauberen Ausgangszustand brauchen, etwa nach der Installation eines neuen SDK oder nach der Änderung einer globalen MSBuild-Eigenschaft, die der warme Prozess zwischengespeichert hat, beenden Sie den Server ausdrücklich, statt nach dem Prozess zu suchen:

```bash
dotnet build-server shutdown --msbuild
```

Der Befehl ist nicht neu, gewinnt aber deutlich an Bedeutung, nun da ein warmer Server die Voreinstellung ist. Er gehört auf Ihre gedankliche Liste direkt neben "obj und bin löschen", wenn sich ein Build seltsam verhält.

Alle Details stehen in den [SDK-Releasenotes zu .NET 11 Preview 7](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/sdk.md). Wer den Rest von Preview 7 durcharbeitet, findet in der [Unterstützung für passwortgeschützte ZIP-Archive](/de/2026/08/dotnet-11-preview-7-password-protected-zip-archives/) die andere lesenswerte Änderung.
