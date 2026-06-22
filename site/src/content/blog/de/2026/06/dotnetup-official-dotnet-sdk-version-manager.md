---
title: "dotnetup: .NET bekommt endlich einen SDK-Versionsmanager im Stil von rustup"
description: "Microsoft entwickelt dotnetup, ein offizielles plattformubergreifendes Werkzeug zum Installieren, Verfolgen und Wechseln zwischen .NET-SDKs und -Laufzeiten. Das leistet es, und so weit ist es im Juni 2026."
pubDate: 2026-06-22
tags:
  - "dotnet"
  - "tooling"
  - "sdk"
lang: "de"
translationOf: "2026/06/dotnetup-official-dotnet-sdk-version-manager"
translatedBy: "claude"
translationDate: 2026-06-22
---

Jahrelang bedeutete die Verwaltung von .NET-SDKs, drei verschiedene Dinge unter einen Hut zu bringen: die eigenstandigen Installationsprogramme von der Downloadseite, die `dotnet-install`-Skripte fur CI und das Werkzeug `dotnet-core-uninstall`, um den Berg alter Versionen aufzuraumen, der zuruckbleibt. Es gab nie einen einzigen Befehl, der SDKs installiert, verfolgt und zwischen ihnen wechselt, so wie `rustup` es fur Rust oder `nvm` fur Node tut. Seit Juni 2026 andert sich das. Microsoft entwickelt `dotnetup`, und es ist bereits in die Art und Weise eingebunden, wie sich das .NET-SDK selbst kompiliert.

## Was dotnetup tatsachlich ist

`dotnetup` ist ein offizieller, plattformubergreifender Versionsmanager fur .NET-SDKs und -Laufzeiten. Seine einzige Aufgabe besteht darin, Komponenten in einem benutzerbezogenen Verzeichnis zu installieren, ohne erhohte Rechte zu erfordern, das Installierte in einem Manifest zu verfolgen und die aktive Version sauber zu wechseln. Keine Administratoraufforderung, kein MSI, kein Eingriff in die Registry.

Die wichtigsten Verhaltensweisen:

- Installiert SDKs und Laufzeiten pro Benutzer, sodass Sie nie `sudo` oder ein Terminal mit erhohten Rechten benotigen.
- Liest `global.json`, um das exakte SDK aufzulosen und zu installieren, das ein Repository festlegt.
- Verfolgt die installierten Komponenten in einem Manifest fur nachvollziehbare Updates und saubere Deinstallationen.
- Unterstutzt mehrere Laufzeiten nebeneinander fur Multi-Targeting-Szenarien.
- Wird als AOT-kompiliertes, signiertes Binary ausgeliefert, fur schnellen Start und Sicherheit der Lieferkette.

Der einzige im Tracking-Issue von `dotnet/sdk` bestatigte Befehl ist der Installationspfad, hier verwendet, um in einem Build-Skript ein Vorschau-SDK zu beziehen:

```bash
dotnetup sdk install preview
```

Der umfassendere Befehlssatz (installierte Versionen auflisten, einen Standard festlegen, deinstallieren) wird noch offen finalisiert, behandeln Sie daher jedes langere Beispiel als veranschaulichend und nicht als festgelegt.

## Warum global.json der eigentliche Gewinn ist

Der schmerzhafte Teil der Arbeit mit .NET uber mehrere Repositorys hinweg ist heute die Diskrepanz bei `global.json`. Sie klonen ein Repository, fuhren `dotnet build` aus und erhalten einen Fehler, weil es ein SDK festlegt, das Sie nicht installiert haben. Ihre einzigen Optionen sind, das richtige Installationsprogramm aufzuspuren oder die Datei zu bearbeiten.

```json
{
  "sdk": {
    "version": "10.0.301",
    "rollForward": "latestPatch"
  }
}
```

Mit einem Versionsmanager, der diese Datei versteht, wird die Auflosung zu einem einzigen Schritt: Richten Sie `dotnetup` auf das Repository und lassen Sie es das festgelegte SDK in Ihr Benutzerprofil holen. Das ist dieselbe Ergonomie, die Rust-Entwickler seit Jahren mit `rust-toolchain.toml` haben.

## Wie weit es gerade ist

`dotnetup` befindet sich in einer internen Vorschau. Es gibt noch kein Ein-Zeilen-Installationsprogramm auf der .NET-Website, und der praktische Weg, es heute auszuprobieren, ist, es aus dem Quellcode zu kompilieren. Eine offentliche Vorschau ist fur die kommenden Monate geplant. Bemerkenswert ist, dass der `main`-Branch von `dotnet/sdk` `dotnetup` bereits als Teil seines eigenen Builds verwendet, was ein starkes Signal dafur ist, dass dies die vorgesehene Zukunft der .NET-Installation ist und kein Experiment.

Wenn Sie CI-Pipelines pflegen oder Entwickler in Repositorys mit streng festgelegten SDKs einarbeiten, ist dies das Werkzeug, das Sie im Auge behalten sollten. Verfolgen Sie den Fortschritt im [dotnet/sdk-Issue zur Verwendung von dotnetup in Build-Skripten](https://github.com/dotnet/sdk/issues/52699) und im [Hinweis-Issue, das festhalt, dass der main-Branch jetzt damit kompiliert wird](https://github.com/dotnet/sdk/issues/54601).
