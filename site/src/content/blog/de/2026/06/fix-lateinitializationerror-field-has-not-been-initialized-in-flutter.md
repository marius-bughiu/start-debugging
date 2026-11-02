---
title: "Fix: LateInitializationError: Field '...' has not been initialized in Flutter"
description: "Nicht initialisierte late-Felder in Flutter beheben: synchrone Initialisierung oder expliziter Lade-, Fehler- und Datenzustand mit geprüftem Lebenszyklus-Code."
pubDate: 2026-06-24
updatedDate: 2026-11-02
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "de"
translationOf: "2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-24
---

Wird ein noch nicht zugewiesenes `late`-Feld gelesen, entsteht ein `LateInitializationError`. Suche im ersten Stackframe deines eigenen Codes den Lesezugriff und prüfe, welcher Pfad das Feld vorher hätte setzen sollen. `late` wartet nicht auf asynchrone Vorgänge. Die Beispiele wurden mit Flutter 3.44.8 und Dart 3.12.2 geprüft.

## Den Fehler reproduzieren

Dieses Programm lässt sich kompilieren, scheitert aber beim Lesen von `name`:

```dart
class Profile {
  late String name;
}

void main() {
  print(Profile().name);
}
```

Die Dart-VM meldet `LateInitializationError: Field 'name' has not been initialized.` Das ist eine Diagnose, kein Verweis auf eine öffentliche `dart:core`-Klasse, die importiert oder gezielt abgefangen werden müsste. Behebe die fehlende Initialisierung.

## Laden, Fehler und Daten darstellen

Ein in `initState()` gestarteter Netzwerkaufruf kann beim ersten `build()` noch laufen. Dieses vollständige Widget verwendet nullable Zustand und behandelt Erfolg und Fehler. Übergib die asynchrone Funktion als `loadName`:

```dart
import 'package:flutter/material.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key, required this.loadName});
  final Future<String> Function() loadName;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  String? _name;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final name = await widget.loadName();
      if (!mounted) return;
      setState(() => _name = name);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) return Text('Failed: $_error');
    final name = _name;
    if (name == null) return const CircularProgressIndicator();
    return Text(name);
  }
}
```

Das Beispiel lädt einmal pro `State`-Instanz. Hängt die Anfrage von veränderlichen Widget-Eingaben ab, behandle Änderungen auch in `didUpdateWidget` oder verwende ein Widget beziehungsweise einen Provider mit passendem Schlüssel. `mounted` verhindert Änderungen an bereits freigegebenem Zustand, bricht aber keine Anfrage ab. Ein `FutureBuilder` mit gespeichertem Future oder ein `AsyncValue` ist ebenfalls geeignet. Ein Feld für den Future darf `late final` sein, wenn es vor dem Lesen gesetzt wird; das Ergebnis kann später eintreffen.

## Nach Abhängigkeit initialisieren

- **Synchroner Wert:** vor dem ersten Lesen zuweisen, bei Zugriff auf `widget` meist in `initState()`. Einen `TextEditingController` außerdem in `dispose()` freigeben.
- **Verzögerter Wert:** `late final value = compute();` führt den Initialisierer beim ersten Zugriff aus. Ein late-Instanzinitialisierer darf Instanzmitglieder verwenden, auch `widget` in einem `State`; der erste Zugriff muss zum Lebenszyklus passen. Der Initialisierer kann weiterhin Fehler auslösen oder rekursiv sein.
- **Geerbte Abhängigkeit:** Aufrufe wie `Theme.of(context)`, die eine Abhängigkeit registrieren, gehören in `build()` oder `didChangeDependencies()`, nicht in `initState()`. `didChangeDependencies()` läuft vor dem ersten Build und bei Änderungen der Abhängigkeiten erneut. Das Verbot betrifft die Registrierung, nicht jede Verwendung von `context`.

## Ähnliche Fehler und irreführende Lösungen

Eine zweite Zuweisung an ein `late final`-Feld erzeugt die Variante „already initialized“. Entferne die doppelte Zuweisung oder verwende nur dann ein veränderliches Feld, wenn dies beabsichtigt ist. `late` deaktiviert nicht sämtliche Analyzer-Prüfungen: eindeutig nicht zugewiesene late-Lokalvariablen und bestimmte Mehrfachzuweisungen werden erkannt. Wo die statische Analyse nicht ausreicht, bleiben Laufzeitprüfungen nötig. Sie sind keine reinen Debug-Assertions; Meldungen können je nach Backend und Buildmodus variieren.

Vor dem Lesen muss der Wert bereitstehen oder der Wartezustand ausdrücklich dargestellt werden. `await` macht `late` nicht grundsätzlich falsch, wenn alle Leser zuerst die Bereitschaft abwarten. Fehlerhaft ist der vorzeitige Zugriff des Widgets.

**Korrektur vom 2. November 2026:** Aussagen zu Analyzer-Prüfungen, verzögertem Zugriff auf Instanzmitglieder, geerbten Abhängigkeiten und Release-Diagnosen berichtigt; den Verweis auf eine nicht vorhandene öffentliche Fehlerklasse entfernt. Das überarbeitete Widget wurde analysiert und für Erfolg, Fehler und Freigabe getestet.

## Quellen und weitere Artikel

- [Dart: late variables](https://dart.dev/language/variables#late-variables)
- [Dart: definitely_unassigned_late_local_variable](https://dart.dev/tools/diagnostics/definitely_unassigned_late_local_variable)
- [Flutter: initState](https://api.flutter.dev/flutter/widgets/State/initState.html)
- [Flutter: didChangeDependencies](https://api.flutter.dev/flutter/widgets/State/didChangeDependencies.html)
- [Dart: null safety](https://dart.dev/null-safety/understanding-null-safety#late-variables)

- [BuildContext / await](/de/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)
- [AsyncValue](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [TextEditingController / dispose](/de/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)
- [Controllers / dispose](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Flutter 2 → 3.x / null safety](/de/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)
