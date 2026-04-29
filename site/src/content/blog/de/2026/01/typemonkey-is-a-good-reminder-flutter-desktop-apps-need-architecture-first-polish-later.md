---
title: "TypeMonkey ist eine gute Erinnerung: Flutter-Desktop-Apps brauchen zuerst Architektur, dann Feinschliff"
description: "TypeMonkey, eine Flutter-Desktop-Tipp-App, zeigt, warum Desktop-Projekte vom ersten Tag an saubere Architektur brauchen: sealed States, Schnittstellen-Grenzen und testbare Logik."
pubDate: 2026-01-18
tags:
  - "dart"
  - "flutter"
lang: "de"
translationOf: "2026/01/typemonkey-is-a-good-reminder-flutter-desktop-apps-need-architecture-first-polish-later"
translatedBy: "claude"
translationDate: 2026-04-29
---
Heute ist auf r/FlutterDev ein kleines Flutter-Desktop-Projekt aufgetaucht: **TypeMonkey**, eine MonkeyType-ähnliche Tipp-App, die sich ausdrücklich als "früh, aber strukturiert" positioniert.

Quelle: der ursprüngliche Beitrag und das Repository: [r/FlutterDev-Thread](https://www.reddit.com/r/FlutterDev/comments/1qgc72p/typemonkey_yet_another_typing_app_available_on/) und [BaldGhost-git/typemonkey](https://github.com/BaldGhost-git/typemonkey).

## Auf dem Desktop hört "einfach UI ausliefern" auf zu funktionieren

Auf Mobile kommen Sie manchmal mit einem einzigen State-Objekt und einem Stapel Widgets durch. Auf dem Desktop (Flutter **3.x** + Dart **3.x**) treffen Sie schnell auf andere Anforderungen:

-   **Tastatur-zentrische Abläufe**: Shortcuts, Fokus-Management, vorhersagbares Tastenhandling.
-   **Latenz-Empfindlichkeit**: Ihre UI darf nicht hängen, wenn Sie Statistiken aktualisieren, Historie laden oder WPM berechnen.
-   **Feature-Wachstum**: Profile, Übungsmodi, Wortlisten, Themes, Offline-Persistenz.

Deshalb mag ich Projekte, die mit Struktur beginnen. Saubere Architektur ist keine Religion, sondern eine Methode, das zweite und dritte Feature weniger schmerzhaft als das erste zu machen.

## Modellieren Sie den Tipp-Loop als explizite Zustände

Dart 3 bietet `sealed`-Klassen. Für den App-Zustand ist das eine praktische Möglichkeit, "Nullable-Suppe" und beliebige Boolean-Flags zu vermeiden.

Hier ist eine minimale State-Form für eine Tipp-Sitzung, die testbar und UI-freundlich bleibt:

```dart
sealed class TypingState {
  const TypingState();
}

final class Idle extends TypingState {
  const Idle();
}

final class Running extends TypingState {
  final DateTime startedAt;
  final int typedChars;
  final int errorChars;

  const Running({
    required this.startedAt,
    required this.typedChars,
    required this.errorChars,
  });
}

final class Finished extends TypingState {
  final Duration duration;
  final double wpm;

  const Finished({required this.duration, required this.wpm});
}
```

In Flutter 3.x können Sie das an jede beliebige State-Lösung hängen (einfacher `ValueNotifier`, Provider, Riverpod, BLoC). Entscheidend ist, dass Ihre UI einen Zustand rendert und nicht eine Sammlung über Widgets verteilter Bedingungen.

## Halten Sie "Wortliste" und "Statistiken" hinter einer Schnittstelle

Desktop-Apps bekommen Persistenz oft erst später. Wenn Sie mit einer Grenze wie der folgenden starten:

-   `WordSource` (jetzt in-memory, später dateibasiert)
-   `SessionRepository` (jetzt no-op, später SQLite)

können Sie die Tipp-Logik deterministisch und unit-testbar halten und trotzdem früh UI ausliefern.

Wenn Sie eine Flutter-3.x-Desktop-App bauen und ein echtes Repo als Strukturvorlage suchen, lohnt sich die Beobachtung. Selbst wenn Sie es nie klonen, ist die Kernaussage einfach: Auf dem Desktop ist Architektur kein Overkill, sondern der Weg, in Bewegung zu bleiben.
