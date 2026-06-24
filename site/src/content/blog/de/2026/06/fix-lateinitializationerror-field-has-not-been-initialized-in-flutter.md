---
title: "Fix: LateInitializationError: Field '...' has not been initialized in Flutter"
description: "Dieser Absturz bedeutet, dass Sie ein late-Feld gelesen haben, bevor ihm etwas zugewiesen wurde. Initialisieren Sie es synchron in initState, oder verzichten Sie auf late und modellieren Sie den asynchronen Wert als nullbaren Zustand."
pubDate: 2026-06-24
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

Ein `late`-Feld wurde gelesen, bevor irgendein Code ihm einen Wert zugewiesen hat. Das Feld hat keinen Initialisierungsausdruck, also kann Dart es nicht verzögert berechnen, und der Lesezugriff erfolgte vor der von Ihnen beabsichtigten Zuweisung. Die häufigste Ursache in Flutter ist ein `late`-Feld, das Sie aus einer asynchronen Methode (ein Netzwerkabruf, ein Datenbank-Lesezugriff) zuweisen, während `build()` zuerst läuft und das Feld berührt, bevor das Future abgeschlossen ist. Die Lösung hängt vom Timing ab: Wenn der Wert synchron verfügbar ist, weisen Sie ihn in `initState()` vor dem ersten Build zu; wenn er erst später eintrifft, verwenden Sie `late` überhaupt nicht -- deklarieren Sie das Feld nullbar (`Type?`) und rendern Sie einen Ladezustand, bis es gesetzt ist. Dieser Leitfaden verwendet Flutter 3.44 (stable, Mai 2026) und Dart 3.x. Den `late`-Modifikator selbst gibt es seit Dart 2.12.

## Der Fehler im Kontext

Die vollständige Meldung, die Dart wirft, sieht so aus:

```
LateInitializationError: Field '_user' has not been initialized.
#0      _MyScreenState._user (package:my_app/screens/my_screen.dart)
#1      _MyScreenState.build (package:my_app/screens/my_screen.dart:42:25)
#2      StatefulElement.build (package:flutter/src/widgets/framework.dart)
...
```

Der oberste Frame, der synthetische `_user`-Getter, ist der Lesezugriff, der fehlgeschlagen ist. Der Frame direkt darunter, hier `build`, ist die Zeile in Ihrem Code, die das Feld berührt hat. An dieser Zeile tritt der Absturz zutage, aber der Fehler ist das Fehlen einer Zuweisung, die vorher hätte laufen sollen. `LateInitializationError` ist ein Subtyp von `Error`, nicht von `Exception`, was Darts Art ist, Ihnen mitzuteilen, dass dies ein Programmierfehler ist und keine behebbare Laufzeitbedingung. Sie korrigieren den Kontrollfluss; Sie fangen ihn nicht ab.

Die Meldung hat drei nahe Verwandte, und der Wortlaut sagt Ihnen, welchen Sie getroffen haben:

```
LateInitializationError: Field '_user' has not been initialized.
LateInitializationError: Local 'result' has not been initialized.
LateInitializationError: Field '_id' has already been initialized.
```

"Field" bedeutet ein Instanz- oder statisches Feld; "Local" bedeutet eine lokale Variable innerhalb einer Funktion. "has already been initialized" ist der umgekehrte Fehler: ein `late final`-Feld zweimal zuzuweisen. Sie teilen eine gemeinsame Ursachenfamilie, aber nicht dieselbe Lösung, und der Abschnitt über Varianten weiter unten behandelt die anderen.

## Warum das passiert

Es gibt vier Ursachen, grob nach Häufigkeit geordnet, mit der sie zuschlagen.

Der Wert wird asynchron zugewiesen, aber synchron gelesen. Sie haben `late User _user;` deklariert und weisen es innerhalb einer `async`-Methode zu, die Sie aus `initState()` anstoßen. Aber `initState()` kehrt sofort zurück, das erste `build()` läuft, während der Abruf noch unterwegs ist, und `build()` liest `_user`. Nichts hat es bisher zugewiesen, also wirft der Lesezugriff. Dies ist mit Abstand die häufigste Form des Fehlers, und sie ist tückisch, weil es ein garantierter Absturz ist, kein sporadischer: Das Future wird nie vor dem ersten Frame abgeschlossen, also schlägt es jedes Mal fehl, wenn der Screen geöffnet wird.

Die Zuweisung liegt in einem Zweig, der nicht ausgeführt wurde. Sie haben `late String _label;` geschrieben und weisen es nur innerhalb eines `if` oder eines `switch`-Arms zu. Wenn die Bedingung falsch ist oder kein Arm zutrifft, bleibt das Feld unzugewiesen, und der nächste Lesezugriff wirft. Der Dart-Compiler akzeptiert das, weil `late` ein Versprechen von Ihnen an den Analyzer ist, dass Sie vor dem Lesen zuweisen werden; der Analyzer hört auf, die definitive Zuweisung zu prüfen, und vertraut Ihnen.

Sie haben die Zuweisung ganz vergessen. Das Feld wurde während eines Refactorings als `late` deklariert, die Zeile, die es gesetzt hat, wurde gelöscht oder nie geschrieben, und der Analyzer hat nichts gesagt, weil `late` die definitive Zuweisungsprüfung abschaltet. Dies ist der Fall, in dem die Lösung einfach darin besteht, das Ding zuzuweisen.

Das Feld benötigt `InheritedWidget`-Daten, und Sie haben es zu früh zugewiesen. Wenn der Wert von `Theme.of(context)`, `MediaQuery.of(context)`, einem `Provider` oder einem beliebigen `InheritedWidget` stammt, können Sie ihn nicht im Konstruktor oder in Feld-Initialisierern lesen, weil das Element noch nicht im Baum eingehängt ist. Die Zuweisung in `initState()` ist für vererbte Daten ebenfalls zu früh. Der richtige Hook ist `didChangeDependencies()`, und wenn man das falsch macht, bleibt das `late`-Feld beim ersten Build unzugewiesen.

Der zugrunde liegende Vertrag, aus der Dart-Sprachdokumentation zum [`late`-Modifikator](https://dart.dev/language/variables#late-variables): Ein `late`-Feld ohne Initialisierer muss zugewiesen werden, bevor es gelesen wird, und es zuerst zu lesen ist ein Laufzeitfehler. Ein `late`-Feld mit Initialisierer ist anders: Der Initialisierer läuft verzögert beim ersten Lesezugriff, also kann es nie "not initialized" sein. Diese Unterscheidung ist der Schlüssel zu den saubersten Lösungen weiter unten.

## Eine minimale Reproduktion

Dieser Screen stürzt jedes Mal ab, wenn er geöffnet wird. Er kompiliert ohne Warnung.

```dart
// Flutter 3.44, Dart 3.x -- throws "LateInitializationError: Field '_user' has not been initialized".
import 'package:flutter/material.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late User _user; // promise: I will assign this before reading it

  @override
  void initState() {
    super.initState();
    _load(); // fire-and-forget async; returns before _user is set
  }

  Future<void> _load() async {
    final fetched = await fetchUser(); // ~300ms network round trip
    setState(() => _user = fetched);
  }

  @override
  Widget build(BuildContext context) {
    // First build runs while _load() is still awaiting. This read throws.
    return Text(_user.name);
  }
}

class User {
  final String name;
  User(this.name);
}

Future<User> fetchUser() =>
    Future.delayed(const Duration(milliseconds: 300), () => User('Ada'));
```

Die Reihenfolge ist: `initState()` läuft und startet `_load()`, `_load()` trifft auf sein erstes `await` und gibt nach, Flutter geht zum ersten `build()` über, `build()` liest `_user`, und nichts hat es bisher zugewiesen. Das `setState(() => _user = fetched)`, das es gesetzt hätte, läuft 300ms später. Der erste Frame verliert das Rennen jedes Mal.

## Lösung, im Detail

Die Lösungen sind danach geordnet, wie sehr ich sie empfehle. Wählen Sie diejenige, die zu Ihrer Ursache passt.

### 1. Wenn der Wert asynchron ist, verzichten Sie auf late -- modellieren Sie ihn als nullbaren Zustand (empfohlen)

`late` ist das falsche Werkzeug für einen Wert, der nach dem ersten Build eintrifft. Es verspricht, dass der Wert synchron bereit ist; ein abgewarteter Abruf ist es nicht. Deklarieren Sie das Feld nullbar und rendern Sie einen Ladezustand, solange es null ist. Jetzt zwingt Sie das Typsystem, "noch nicht geladen" zu behandeln, statt daran abzustürzen.

```dart
// Flutter 3.44, Dart 3.x -- correct: nullable field, explicit loading state.
class _ProfileScreenState extends State<ProfileScreen> {
  User? _user; // null means "not loaded yet"

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final fetched = await fetchUser();
    if (!mounted) return; // the screen may be gone by now
    setState(() => _user = fetched);
  }

  @override
  Widget build(BuildContext context) {
    final user = _user;
    if (user == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return Text(user.name);
  }
}
```

Der `if (!mounted) return;`-Schutz vor `setState` ist hier nicht optional: Ein asynchroner Callback, der aufgelöst wird, nachdem der Benutzer den Screen verlassen hat, wirft andernfalls einen anderen Fehler. Dieser Schutz ist dieselbe Disziplin, die Sie beim [sicheren Verwenden von BuildContext nach einem await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) benötigen, und er begleitet jeden abgewarteten Callback in einem `State`.

Für alles, was über einen einzelnen Wert hinausgeht, bevorzugen Sie einen `FutureBuilder` oder, wenn Sie Riverpod verwenden, einen `AsyncValue`, der Laden, Fehler und Daten als drei explizite Fälle kodiert. Das Ergebnis direkt nach einem await in ein Feld zu schreiben, ist genau das Muster, das diesen Absturz und seine Geschwister zur Dispose-Zeit erzeugt; das Modellieren der Anfrage als Zustand stattdessen wird im Beitrag [Lade- und Fehlerzustände mit AsyncValue anzeigen](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) behandelt.

### 2. Wenn der Wert synchron ist, weisen Sie ihn in initState vor dem ersten Build zu

`late` ist korrekt, wenn der Wert wirklich vor dem Build verfügbar ist, Sie ihn aber nicht im Feld-Initialisierer berechnen können (zum Beispiel, weil er `widget` benötigt). Weisen Sie ihn in `initState()` zu, das einmal vor dem ersten `build()` läuft.

```dart
// Flutter 3.44, Dart 3.x -- correct: late assigned synchronously, before build.
class _EditorState extends State<Editor> {
  late final TextEditingController _controller;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.initialText);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => TextField(controller: _controller);
}
```

Dies ist die legitime Verwendung von `late final` in einem `State`: Sie benötigen `widget.initialText`, das in einem Feld-Initialisierer nicht verfügbar ist, aber in `initState()` verfügbar ist, das immer noch vor jedem Build läuft. Da der Controller genau einmal erstellt und nie neu zugewiesen wird, ist `late final` der richtige Modifikator, und Sie schulden ihm immer noch ein `dispose()`, wie der [Leitfaden zur Controller-Entsorgung](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) darlegt.

### 3. Verwenden Sie einen Lazy-Initialisierer, damit das Feld nie unzugewiesen sein kann

Wenn der Wert bei Bedarf berechnet werden kann und nicht von `widget` oder `context` abhängt, geben Sie dem `late`-Feld einen Initialisierungsausdruck. Dart führt diesen Ausdruck dann verzögert beim ersten Lesezugriff aus, sodass sich das Feld selbst initialisiert, sobald jemand es zum ersten Mal berührt. Ein `late`-Feld mit Initialisierer kann nicht "has not been initialized" werfen.

```dart
// Flutter 3.44, Dart 3.x -- correct: lazy initializer, computed on first read.
class Report {
  // Expensive to build; only built if something actually reads it.
  late final List<int> histogram = _buildHistogram();

  List<int> _buildHistogram() {
    // ...expensive work...
    return List<int>.filled(256, 0);
  }
}
```

Dies ist der eine Fall, in dem `late` sich rein aus Performance-Gründen lohnt: Die Arbeit wird aufgeschoben, bis sie benötigt wird, und vollständig übersprungen, wenn `histogram` nie gelesen wird. Wenn der Initialisierer günstig ist, verzichten Sie auf `late` und initialisieren Sie stattdessen bei der Deklaration; verzögerte Initialisierung ist den Modifikator nur wert, wenn die Berechnung teuer ist oder Seiteneffekte hat, die Sie aufschieben möchten.

### 4. Lesen Sie InheritedWidget-Daten in didChangeDependencies, nicht früher

Wenn das `late`-Feld von `Theme.of`, `MediaQuery.of` oder einem Provider gespeist wird, verschieben Sie die Zuweisung nach `didChangeDependencies()`. Es läuft nach `initState()` und erneut, wann immer sich eine vererbte Abhängigkeit ändert, und es ist der früheste Punkt, an dem `context` vererbte Widgets sicher auflösen kann.

```dart
// Flutter 3.44, Dart 3.x -- correct: inherited data resolved in didChangeDependencies.
class _BannerState extends State<Banner> {
  late Color _accent;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _accent = Theme.of(context).colorScheme.primary;
  }

  @override
  Widget build(BuildContext context) => ColoredBox(color: _accent);
}
```

Dies in `initState()` zu tun, wirft entweder (älteres Flutter) oder liefert veraltete Daten, die sich nie aktualisieren, wenn sich das Theme ändert. `didChangeDependencies()` behebt beides: Das Feld wird vor dem ersten Build zugewiesen und neu zugewiesen, wann immer das Theme es tut.

## Fallstricke und Varianten

`LateInitializationError: Field '...' has already been initialized.` Das Spiegelbild. Sie haben ein `late final`-Feld zweimal zugewiesen. `late final` erlaubt genau einen Schreibzugriff; der zweite wirft dies. Es passiert üblicherweise, wenn `initState()` das Feld zuweist und ein späterer Codepfad (ein `didUpdateWidget`, ein Callback, ein zweites `_load`) es erneut zuweist. Wenn Sie wirklich neu zuweisen müssen, verzichten Sie auf `final` und behalten Sie nur `late`; wenn nicht, finden Sie den doppelten Schreibzugriff und löschen Sie ihn.

`LateInitializationError: Local '...' has not been initialized.` Derselbe Fehler bei einer lokalen Variable statt eines Feldes. Sie haben `late int total;` innerhalb einer Funktion geschrieben, und ein Zweig hat sie vor einem Lesezugriff unzugewiesen gelassen. Lokales `late` lohnt sich selten: Bevorzugen Sie es, die Variable bei ihrer Deklaration zu initialisieren, oder strukturieren Sie um, sodass jeder Pfad sie vor der Verwendung zuweist. Die definitive Zuweisungsprüfung des Analyzers hätte dies für Sie abgefangen, wenn die Variable nicht `late` wäre -- genau diese Prüfung schaltet `late` ab.

Es wirft im Release, aber die Meldung ist verschwunden. In Release-Builds wird die Assertion-Maschinerie entfernt, aber ein `late`-Lesezugriff ohne Initialisierer wirft immer noch `LateInitializationError`; nur die ausführliche Debug-Meldung wird reduziert. Gehen Sie nicht davon aus, dass `late`-Abstürze nur im Debug auftreten. Sie gehen in den Versand.

`late` versus der Null-Check-Operator. Zu `late` zu greifen, um "the non-nullable field must be initialized" zum Schweigen zu bringen, ist derselbe Instinkt, der Leute dazu bringt, `!` zu verteilen, um Nullbarkeit zum Schweigen zu bringen. Beide verlagern eine Garantie zur Compile-Zeit in einen Laufzeitabsturz. Wenn ein Wert legitim fehlen kann, modellieren Sie ihn als nullbar und behandeln Sie das null; `late` ist nur für Werte, die immer vorhanden sind, aber etwas nach der Deklaration zugewiesen werden. Das umfassendere Null-Safety-Denkmodell, einschließlich der Frage, wann `late` die richtige Notlösung ist und wann nicht, finden Sie in der [Null-Safety-Checkliste für Flutter 2 zu 3.x](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/).

Ein `late`-Feld, das innerhalb seines eigenen Initialisierers gelesen wird. Wenn ein verzögerter `late final x = ...x...;`-Initialisierer `x` liest, erhalten Sie einen `LateInitializationError` über das Lesen während der Initialisierung. Der Zyklus ist der Fehler; brechen Sie ihn, indem Sie den Wert berechnen, ohne das Feld zu referenzieren.

Die einzige Disziplin, die diese ganze Fehlerklasse beseitigt: Verwenden Sie `late` nur für einen Wert, der immer vorhanden ist und synchron vor dem ersten Lesezugriff zugewiesen wird (typischerweise in `initState()` oder `didChangeDependencies()`), und modellieren Sie alles, was asynchron eintrifft, als nullbaren Zustand mit einem expliziten Ladezweig. Verdrahten Sie diese Unterscheidung in Ihren Reflex, und der Fehler hört auf zu erscheinen. In dem Moment, in dem Sie feststellen, dass Sie ein `late`-Feld nach einem `await` zuweisen, ist das das Signal, es auf `Type?` umzustellen und stattdessen den Zwischenzustand zu rendern.

## Verwandt

- [How to use BuildContext safely after an await in Flutter](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) behandelt den `mounted`-Schutz, von dem die obige asynchrone Lösung abhängt.
- [How to show loading and error states with AsyncValue in Flutter Riverpod](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) ist die strukturierte Alternative zum Schreiben asynchroner Ergebnisse in ein `late`-Feld.
- [Fix: A TextEditingController was used after being disposed in Flutter](/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) ist die andere Hälfte des Controller-Lebenszyklus, an dem `late final`-Controller teilnehmen.
- [How to dispose controllers in Flutter to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) passt zum `late final TextEditingController`-Muster in Lösung 2.
- [Migrate a Flutter 2 app to Flutter 3.x: null safety checklist](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) erklärt, wo `late` in die Null-Safety passt und wo nullbare Typen die bessere Wahl sind.

## Quellen

- [late variables, Dart language tour](https://dart.dev/language/variables#late-variables) -- der Vertrag für `late`-Felder mit und ohne Initialisierer.
- [Understanding null safety, dart.dev](https://dart.dev/null-safety/understanding-null-safety#late-variables) -- die Begründung für `late` und wie es mit der definitiven Zuweisung interagiert.
- [State.initState and State.didChangeDependencies, Flutter API reference](https://api.flutter.dev/flutter/widgets/State/didChangeDependencies.html) -- welcher Lebenszyklus-Hook vererbte Daten sicher lesen kann.
- [LateInitializationError, Dart core library API](https://api.dart.dev/stable/dart-core/LateInitializationError-class.html) -- der Fehlertyp und was ihn auslöst.
