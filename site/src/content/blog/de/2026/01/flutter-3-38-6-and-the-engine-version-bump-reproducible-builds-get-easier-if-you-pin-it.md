---
title: "Flutter 3.38.6 und der `engine.version`-Bump: reproduzierbare Builds werden einfacher (wenn Sie sie pinnen)"
description: "Flutter 3.38.6 hat engine.version angehoben, und das ist wichtig für reproduzierbare Builds. Lernen Sie, das SDK in CI zu pinnen, Engine-Drift zu vermeiden und 'was hat sich geändert' zu diagnostizieren, wenn Builds ohne Codeänderungen brechen."
pubDate: 2026-01-08
tags:
  - "flutter"
lang: "de"
translationOf: "2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it"
translatedBy: "claude"
translationDate: 2026-04-30
---
Flutter 3.38.6 ist mit einem Release-Eintrag "engine.version bump" gelandet, und diese kleine Phrase bedeutet mehr, als es aussieht. Wenn Ihre CI-Builds jemals abgedriftet sind, weil eine Maschine ein leicht abweichendes Engine-Artefakt aufgegriffen hat, ist Pinning der Unterschied zwischen "es funktioniert" und "wir können diesen Build nächste Woche reproduzieren".

Release-Eintrag: [https://github.com/flutter/flutter/releases/tag/3.38.6](https://github.com/flutter/flutter/releases/tag/3.38.6)

## `engine.version` ist der versteckte Pin hinter dem SDK

Wenn Sie `flutter --version` ausführen, wählen Sie nicht nur eine Framework-Version. Sie wählen implizit eine bestimmte Engine-Revision, und diese Revision steuert:

-   **Skia- und Rendering-Verhalten**
-   **Plattform-Embedder-Änderungen**
-   **Tooling-Verhalten, das von Engine-Artefakten abhängt**

Ein Update von `engine.version` ist Flutter, das sagt: "Dieses SDK-Tag bildet auf diese Engine-Revision ab". Mit anderen Worten, es ist ein Reproduzierbarkeitssignal, nicht nur eine Aufgabe für den Release-Prozess.

## Flutter 3.38.6 auf die langweilige Art im CI pinnen

Die langweilige Art ist die beste Art: einen Versionsmanager benutzen und die gewünschte Version committen.

Wenn Sie FVM verwenden, pinnen Sie Flutter explizit und lassen Sie CI scheitern, wenn es abdriftet:

```bash
# One-time on your machine
fvm install 3.38.6
fvm use 3.38.6 --force

# In CI (example: verify the version)
fvm flutter --version
```

Wenn Sie FVM nicht verwenden, ist die wichtige Idee dieselbe: Lassen Sie nicht "was auch immer auf dem Runner installiert ist" Ihre Engine entscheiden. Installieren Sie Flutter 3.38.6 als Teil der Pipeline, cachen Sie es und geben Sie `flutter --version` in den Logs aus, damit Sie Drift diagnostizieren können.

## Die "Warum hat sich mein Build geändert"-Checkliste

Wenn sich ein Flutter-Build ohne Codeänderungen ändert, prüfe ich in dieser Reihenfolge:

-   **Flutter-SDK-Tag**: Sind wir noch auf 3.38.6?
-   **Engine-Revision**: Zeigt `flutter --version -v` denselben Engine-Commit?
-   **Dart-Version**: SDK-Drift kann Analyzer- und Laufzeitverhalten ändern.
-   **Build-Umgebung**: Xcode-/Android-Gradle-Plugin-Versionen können Unterschiede erzeugen.

Der Grund, warum ich `engine.version` gerne erwähne, ist, dass es den zweiten Punkt umsetzbar macht. Sobald Sie das Flutter-SDK als unveränderlichen Input behandeln, wird der Rest der Pipeline einfacher zu durchdringen.

Wenn Sie mehrere Apps pflegen, machen Sie den Pin sichtbar. Ein `README`-Snippet oder ein CI-Check, der Flutter 3.38.6 verifiziert, ist günstig und spart Stunden, wenn jemand zum ersten Mal fragt: "Was hat sich geändert?".
