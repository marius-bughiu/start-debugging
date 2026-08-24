---
title: "Ein Flutter-Widget zu einem festen Zeitpunkt testen, ohne withClock-Closure"
description: "Innerhalb von testWidgets ist die ambiente clock aus package:clock bereits gefälscht, startet aber zu der Systemzeit, zu der der Test begonnen hat. Fixieren Sie sie für die gesamte Suite, indem Sie runTest in einem eigenen AutomatedTestWidgetsFlutterBinding überschreiben und dieses aus flutter_test_config.dart installieren. Verifiziert mit Flutter 3.44.2, clock 1.1.2, fake_async 1.3.3."
pubDate: 2026-08-24
template: how-to
tags:
  - "flutter"
  - "dart"
  - "testing"
  - "how-to"
  - "clock"
lang: "de"
translationOf: "2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time"
translatedBy: "claude"
translationDate: 2026-08-24
---

Wenn ein Widget "vor 3 Stunden" anzeigt oder mit "Guten Abend" begrüßt, muss dessen Vorstellung von `now` eine Konstante sein, bevor sich die Ausgabe prüfen lässt. Der übliche Rat lautet, jeden Testrumpf in `withClock(Clock.fixed(...), () async { ... })` zu verpacken, was schnell unübersichtlich wird. Es gibt einen besseren Weg, und er beginnt mit einer Tatsache, die die meisten falsch einschätzen: **innerhalb von `testWidgets` ist die ambiente `clock` aus `package:clock` bereits gefälscht**. `FakeAsync.run` installiert sie, und sie läuft nur weiter, wenn Sie `tester.pump` aufrufen. Was sie nicht tut: zu einem vorhersagbaren Zeitpunkt starten, denn `FakeAsync()` initialisiert sich aus der echten Systemuhr. Korrigieren Sie diesen einen Startwert, und die gesamte Suite wird deterministisch, ohne Closure pro Test. Alles Folgende wurde gegen Flutter 3.44.2 (Dart 3.12.2), `clock` 1.1.2 und `fake_async` 1.3.3 ausgeführt.

## Was clock.now() innerhalb von testWidgets tatsächlich zurückgibt

Beginnen wir mit der kleinstmöglichen Probe. Keine Konfigurationsdateien, keine eigenen Bindings:

```dart
// Flutter 3.44.2, Dart 3.12.2, clock 1.1.2
import 'package:clock/clock.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('the ambient clock is already fake', (WidgetTester tester) async {
    final a = clock.now();
    await tester.pump(const Duration(hours: 1));
    final b = clock.now();
    print('a=$a');
    print('b=$b delta=${b.difference(a)}');
    print('DateTime.now delta=${DateTime.now().difference(a)}');
  });
}
```

Ausgabe von `flutter test`:

```text
a=2026-08-24 09:19:57.248297
b=2026-08-24 10:19:57.248297 delta=1:00:00.000000
DateTime.now delta=0:00:00.094231
```

Zwei Dinge lassen sich daran ablesen. Die Differenz zwischen den beiden `clock.now()`-Aufrufen ist *genau* eine Stunde, mikrosekundengenau, was keine echte Uhr je liefert. Und `DateTime.now()` ist um 94 Millisekunden weitergelaufen, also um die tatsächliche Testdauer. `clock` ist demnach gefälscht und `DateTime.now()` echt.

Die Verkabelung steckt in `fake_async`. `FakeAsync.run` verpackt seinen eigenen Callback in `withClock`:

```dart
// fake_async 1.3.3, lib/fake_async.dart
T run<T>(T Function(FakeAsync self) callback) => runZoned(
      () => withClock(_clock, () => callback(this)),
      // ...timer and microtask interception...
    );
```

Und `AutomatedTestWidgetsFlutterBinding.runTest` (in `packages/flutter_test/lib/src/binding.dart`) führt den gesamten Testrumpf genau darin aus:

```dart
final fakeAsync = FakeAsync();
_currentFakeAsync = fakeAsync; // reset in postTest
_clock = fakeAsync.getClock(DateTime.utc(2015));
fakeAsync.run((FakeAsync localFakeAsync) { /* test body */ });
```

Beachten Sie die zwei verschiedenen Uhren. `fakeAsync.getClock(DateTime.utc(2015))` wird als die eigene Uhr des Bindings gespeichert, weshalb `tester.binding.clock.now()` in einem frischen Test `2015-01-01T00:00:00.000Z` meldet und mit `pump` weiterläuft:

```text
binding.clock            = 2015-01-01T00:00:00.000Z
binding.clock after pump(10m) = 2015-01-01T00:10:00.000Z
```

Die Uhr, die Ihre Widgets über `package:clock` sehen, ist eine *andere* `Clock` über demselben `FakeAsync`, und ihr Ursprung stammt aus dem `FakeAsync`-Konstruktor:

```dart
// fake_async 1.3.3
FakeAsync({DateTime? initialTime, this.includeTimerStackTrace = true}) {
  final nonNullInitialTime = initialTime ?? clock.now();
  _clock = Clock(() => nonNullInitialTime.add(elapsed));
}
```

`initialTime ?? clock.now()`. Das Binding ruft `FakeAsync()` ohne Argument auf, also ist der Ursprung der gefälschten Uhr genau das, was die *ambiente* Uhr zum Startzeitpunkt des Tests gemeldet hat. Außerhalb jeder Zone ist das die Systemuhr. Das ist die einzige Stelle mit Nichtdeterminismus, und genau diese Stelle können Sie steuern.

## Warum withClock in flutter_test_config.dart nichts bewirkt

Der häufigste Vorschlag für suiteweites Setup ist `flutter_test_config.dart`. Es sieht aus, als müsste es funktionieren:

```dart
// test/flutter_test_config.dart -- DOES NOT WORK
import 'dart:async';
import 'package:clock/clock.dart';

Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  await withClock(
    Clock.fixed(DateTime.utc(2026, 3, 14, 9, 26, 53)),
    () async => testMain(),
  );
}
```

Hier lauern zwei Fallen. Die erste ist ein Compile-Fehler, wenn Sie das offensichtliche `return withClock(fixed, testMain)` schreiben: `withClock<T>` leitet `T` aus dem Rückgabetyp ab und verlangt daher eine `Future<void> Function()`, während `testExecutable` Ihnen eine `FutureOr<void> Function()` übergibt. Sie müssen eine eigene Closure einschieben.

Die zweite Falle: selbst wenn es kompiliert, hat es keine Wirkung. Prints auf beiden Seiten machen die Reihenfolge deutlich:

```text
CFG before testMain, zone clock=2026-08-24T09:16:56.269316
CFG inside zone, clock=2026-03-14T09:26:53.000Z
MAIN body, clock=2026-03-14T09:26:53.000Z
CFG testMain returned, still inside zone
CFG after zone
P12 body, clock=2026-08-24T09:16:56.295534
```

Die Zone umfasst das `main()` der Testdatei auf oberster Ebene, das Tests mit `test` und `testWidgets` lediglich *deklariert*. `package:test` führt jeden deklarierten Rumpf später aus, aus einer eigenen Zonen-Abstammung, lange nachdem `testExecutable` zurückgekehrt ist. `withClock` ist zonenbasiert, und eine bereits verlassene Zone kann nichts mehr beeinflussen. Jeder Artikel, der Ihnen sagt, `testMain` in `withClock` zu verpacken, hat das nie verifiziert.

Wofür `flutter_test_config.dart` *tatsächlich* gut ist: Code einmal vor der Suite auszuführen. Ein Binding zu konstruieren ist genau solcher Code.

## Die drei Schritte, um die Uhr für eine ganze Suite zu fixieren

1. Deklarieren Sie die Pakete, die Sie importieren werden. `clock` gehört in `dependencies`, weil Produktionscode `clock.now()` aufrufen wird; `meta` gehört nur dann in `dev_dependencies`, wenn Sie zusätzlich die `@isTest`-Annotation aus dem letzten Abschnitt wollen, sonst meldet der Analyzer `depend_on_referenced_packages`.

   ```yaml
   # pubspec.yaml -- Flutter 3.44.2
   dependencies:
     flutter:
       sdk: flutter
     clock: ^1.1.2
   ```

2. Leiten Sie von `AutomatedTestWidgetsFlutterBinding` ab und überschreiben Sie `runTest` so, dass `super.runTest` innerhalb einer Zone mit fixierter Uhr läuft. Das ist der ganze Trick: `super.runTest` konstruiert `FakeAsync()`, und `FakeAsync` liest die ambiente Uhr für seine `initialTime`.

   ```dart
   // test/flutter_test_config.dart -- Flutter 3.44.2
   import 'dart:async';
   import 'package:clock/clock.dart';
   import 'package:flutter/foundation.dart';
   import 'package:flutter_test/flutter_test.dart';

   final DateTime kTestEpoch = DateTime.utc(2026, 3, 14, 9, 26, 53);

   class FixedStartBinding extends AutomatedTestWidgetsFlutterBinding {
     @override
     Future<void> runTest(
       Future<void> Function() testBody,
       VoidCallback invariantTester, {
       String description = '',
     }) {
       return withClock(
         Clock.fixed(kTestEpoch),
         () => super.runTest(testBody, invariantTester, description: description),
       );
     }
   }
   ```

3. Instanziieren Sie das Binding in `testExecutable`, bevor irgendein Test läuft. `TestWidgetsFlutterBinding.ensureInitialized()` liefert `_instance ?? binding.ensureInitialized(...)`, und der Konstruktor von `AutomatedTestWidgetsFlutterBinding` setzt `_instance` über `initInstances`. Das zuerst konstruierte Binding gewinnt also, und `testWidgets` greift auf Ihres zu.

   ```dart
   Future<void> testExecutable(FutureOr<void> Function() testMain) async {
     FixedStartBinding();
     await testMain();
   }
   ```

Das war es. Keine Änderung in irgendeiner Testdatei. Ein Widget, das die ambiente Uhr liest:

```dart
// Flutter 3.44.2
class AmbientClockBanner extends StatelessWidget {
  const AmbientClockBanner({super.key});

  @override
  Widget build(BuildContext context) => Text(
        'ambient:${clock.now().toIso8601String()}',
        textDirection: TextDirection.ltr,
      );
}
```

rendert nun auf jeder Maschine und in jedem Lauf identisch:

```text
binding      = FixedStartBinding
ambient      = 2026-03-14T09:26:53.000Z
binding.clock= 2015-01-01T00:00:00.000Z
rendered     = ambient:2026-03-14T09:26:53.000Z
```

Und weil Sie `FakeAsync` mit einem Startwert versehen statt seine Uhr zu ersetzen, bewegt sich die gefälschte Zeit weiterhin unter Ihrer Kontrolle:

```dart
testWidgets('advances with pump only', (WidgetTester tester) async {
  final a = clock.now();
  await tester.pump(const Duration(hours: 3, minutes: 30));
  final b = clock.now();
  print('a=$a b=$b delta=${b.difference(a)}');
});
// a=2026-03-14 09:26:53.000Z
// b=2026-03-14 12:56:53.000Z delta=3:30:00.000000
```

`clock.stopwatch()` hängt an derselben gefälschten Uhr, also ergibt `pump(Duration(seconds: 42))` eine verstrichene Zeit von genau `0:00:42.000000`. Jeder Test startet wieder bei der gewählten Epoche, weil `runTest` jedes Mal ein frisches `FakeAsync` baut.

## Fester Start gegen eingefrorene Uhr: die Platzierung von withClock entscheidet

Es gibt eine zweite Variante, und der Unterschied ist eine Verschachtelungszeile. Verpacken Sie `testBody` statt `super.runTest`, dann wird Ihre Zone *innerhalb* von `FakeAsync.run` etabliert und verdeckt die gefälschte Uhr vollständig:

```dart
// test/frozen/flutter_test_config.dart -- Flutter 3.44.2
class FrozenClockBinding extends AutomatedTestWidgetsFlutterBinding {
  @override
  Future<void> runTest(
    Future<void> Function() testBody,
    VoidCallback invariantTester, {
    String description = '',
  }) {
    return super.runTest(
      () => withClock(Clock.fixed(kFrozen), testBody),
      invariantTester,
      description: description,
    );
  }
}
```

Jetzt bewegt `pump` die Animationszeit des Frameworks vorwärts, aber `clock.now()` rührt sich nie:

```text
a=2026-03-14 09:26:53.000Z b=2026-03-14 09:26:53.000Z delta=0:00:00.000000
```

Keine der beiden Varianten stört Animationen, denn `Ticker` und `SchedulerBinding` richten sich nach den Frame-Zeitstempeln von `FakeAsync`, nicht nach `package:clock`. Ein `showDialog` plus `pumpAndSettle` löst sich unter dem eingefrorenen Binding weiterhin auf und findet den Dialog. Wählen Sie danach, was Sie prüfen:

| | `super.runTest` verpacken | `testBody` verpacken |
| --- | --- | --- |
| Startzeitpunkt | fest | fest |
| Läuft mit `pump` weiter | ja | nein |
| Mechanismus | setzt `FakeAsync.initialTime` | verdeckt die Uhr von `FakeAsync` |
| Gut für | relative Zeitstempel, Countdowns, Debounce | Begrüßungen wie "Guten Abend", Datumsformatierung |

Eines sollten Sie vermeiden: bauen Sie keine lazy Uhr, die an die eigene Uhr des Bindings delegiert, etwa `withClock(Clock(() => this.clock.now()), ...)`. Der Konstruktor von `FakeAsync` ruft `clock.now()` auf, bevor das Binding den Test betreten hat, und `AutomatedTestWidgetsFlutterBinding.clock` prüft `inTest` per Assertion:

```text
'package:flutter_test/src/binding.dart': Failed assertion: line 2223 pos 12: 'inTest': is not true.
package:clock/src/clock.dart 44:26   Clock.now
package:fake_async/fake_async.dart 106:53   new FakeAsync
package:flutter_test/src/binding.dart 2482:23   AutomatedTestWidgetsFlutterBinding.runTest
```

Ein einfaches `Clock.fixed` umgeht das Problem komplett.

## Ein Wrapper pro Test, wenn Sie es nur in wenigen Dateien brauchen

Wenn ein eigenes Binding mehr Maschinerie ist, als Sie wollen, schreiben Sie die Closure einmalig als Wrapper. Die Annotation `@isTest` aus `package:meta` hält Analyzer und Testerkennung der IDE zufrieden:

```dart
// Flutter 3.44.2, clock 1.1.2, meta 1.18.0
import 'package:clock/clock.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meta/meta.dart';

final DateTime kEpoch = DateTime.utc(2026, 3, 14, 9, 26, 53);

@isTest
void testWidgetsAt(
  String description,
  WidgetTesterCallback callback, {
  DateTime? at,
  bool skip = false,
}) {
  testWidgets(
    description,
    (WidgetTester tester) =>
        withClock(Clock.fixed(at ?? kEpoch), () => callback(tester)),
    skip: skip,
  );
}
```

Weil die Zone des Wrappers den gesamten Testrumpf umspannt, sieht jeder Rebuild während des Tests die fixierte Uhr, auch die von `tap` und `setState` nach einem `await` ausgelösten. Das ist der entscheidende Unterschied dazu, nur einen Teil eines Tests zu verpacken. Wenn Sie `await withClock(fixed, () async { await tester.pumpWidget(w); })` schreiben und das Widget nach dem Verlassen der Closure neu bauen, entkommt der Rebuild der Zone und fällt stillschweigend auf die gefälschte, aber mit Systemzeit initialisierte Uhr zurück. Ich habe das gemessen: innerhalb der Closure renderte das Widget `2026-03-14T09:26:53.000Z`, ein `pumpWidget` danach renderte `2026-08-24T09:15:30.029972`.

Ein lokales `withClock` überschreibt weiterhin das bindingweite, die beiden Techniken lassen sich also kombinieren. Unter `FixedStartBinding` rendert ein Test, der seinen Rumpf in `withClock(Clock.fixed(DateTime.utc(2031, 5, 2, 7)))` verpackt, `2031-05-02T07:00:00.000Z`.

## DateTime.now() lässt sich nicht fälschen, und kein Binding rettet Sie

`package:clock` ist reine Zonen-Abfrage. Die komplette Implementierung des Top-Level-Getters lautet:

```dart
// clock 1.1.2, lib/src/default.dart
Clock get clock => Zone.current[_clockKey] as Clock? ?? const Clock();
```

Es gibt keine setzbare globale Variable. Es gibt auch kein Gegenstück für `DateTime.now()`, das direkt zur VM geht. Ein Widget, das es aufruft, ignoriert gefälschte Zeit vollständig, selbst ein ganzes Jahr davon:

```text
raw:2026-08-24T09:19:57.370144
after pump(365 days) -> raw:2026-08-24T09:19:57.376244
```

Sechs Mikrosekunden Abstand, beide echt. Wenn Ihr Widget oder Ihr Modell also `DateTime.now()` direkt aufruft, hilft nichts davon. Entweder migrieren Sie diese Aufrufstellen auf `clock.now()`, oder Sie nehmen die Uhr als Abhängigkeit und lassen Zonen ganz beiseite:

```dart
// Flutter 3.44.2
class InjectedClockBanner extends StatelessWidget {
  const InjectedClockBanner({required this.now, super.key});

  final DateTime Function() now;

  @override
  Widget build(BuildContext context) => Text(
        'injected:${now().toIso8601String()}',
        textDirection: TextDirection.ltr,
      );
}

// test
await tester.pumpWidget(InjectedClockBanner(now: () => kEpoch));
```

In neuem Code greife ich zur Injektion, aus dem gleichen Grund, aus dem [TimeProvider und FakeTimeProvider ambiente Statics in .NET schlagen](/de/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/): die Abhängigkeit ist im Konstruktor sichtbar statt in einer Zone versteckt. Das Überschreiben des Bindings ist die pragmatische Antwort für eine bestehende Codebasis, die sich bereits auf `clock.now()` stützt, oder für Fremdpakete, die Sie nicht ändern können.

Wenn Sie Riverpod nutzen, ist ein im `ProviderScope` des Tests überschriebener `Provider<Clock>` dieselbe Idee mit der Verkabelung, die Sie schon haben, und passt gut zu den Mustern aus [Notifier vs AsyncNotifier vs StreamNotifier](/de/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/).

## Vier Details, die Sie vor dem Commit kennen sollten

**Einfache `test()`-Rümpfe bekommen die echte Uhr.** `FakeAsync` existiert nur innerhalb von `testWidgets`, also meldet ein `test('...')` in derselben Datei für `clock.now()` und `DateTime.now()` die Systemzeit. Wenn Sie eine fixierte Uhr auch in Unit-Tests brauchen, verpacken Sie diese Rümpfe mit `withClock` oder verwenden `fakeAsync` aus `package:fake_async` direkt.

**`integration_test` und über `flutter run` getriebene Tests laufen in Echtzeit.** Fehlt `FLUTTER_TEST`, wählt `flutter_test` `LiveTestWidgetsFlutterBinding`, dessen Uhr im Code fest verdrahtet ist:

```dart
// packages/flutter_test/lib/src/binding.dart
@override
Clock get clock => const Clock();
```

Kein `FakeAsync`, keine gefälschte Uhr. Legen Sie die Konfigurationsdatei in `test/` und nicht in das Projektwurzelverzeichnis, denn der Suchlauf prüft ein Verzeichnis auf `flutter_test_config.dart`, bevor er dasselbe Verzeichnis auf die `pubspec.yaml`-Markierung prüft: eine Konfiguration im Wurzelverzeichnis gilt auch für `integration_test/`, wo das Konstruieren eines `AutomatedTestWidgetsFlutterBinding` mit `IntegrationTestWidgetsFlutterBinding` kollidieren würde. Verlassen Sie sich in Integrationstests nicht auf eine fixierte Uhr.

**Die Suche nach der Konfigurationsdatei geht vom Nächstliegenden aus.** `flutter_tools` läuft von der Testdatei aufwärts und sucht `flutter_test_config.dart`, bis zum ersten Verzeichnis mit einer `pubspec.yaml`. `test/frozen/flutter_test_config.dart` verdeckt daher `test/flutter_test_config.dart` für alles unter `test/frozen/`, und für einen gegebenen Test gilt immer nur eine Konfigurationsdatei. So können Sie eine Suite mit eingefrorener Uhr und eine mit festem Start nebeneinander betreiben, aber Sie können sie eben auch nicht schichten.

**Im Web funktioniert es genauso.** `flutter test --platform chrome` läuft über `_binding_web.dart`, dessen `ensureInitialized` ebenfalls `AutomatedTestWidgetsFlutterBinding.ensureInitialized()` zurückgibt, und der Web-Bootstrap ruft `testExecutable` genauso auf. Das eigene Binding gilt unverändert.

Das Modell, das Sie behalten sollten: `testWidgets` gibt Ihnen bereits eine gefälschte Uhr, `FakeAsync` entscheidet, wo sie beginnt, und der einzige Hebel auf diese Entscheidung ist die ambiente Uhr im Moment, in dem `runTest` das `FakeAsync` baut. Alles Übrige ist die Wahl, auf welcher Seite von `super.runTest` Ihr `withClock` sitzt.

## Verwandte Beiträge

- [Zeitabhängigen Code mit TimeProvider und FakeTimeProvider in .NET 11 testen](/de/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/) behandelt dasselbe Problem im .NET-Ökosystem, wo die Abstraktion in der BCL enthalten ist.
- [setState mit der mounted-Prüfung nach einer asynchronen Lücke in Flutter absichern](/de/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) ist die andere Hälfte davon, Widget-Tests zu schreiben, die `await`-Grenzen überleben.
- [Ein StreamSubscription in dispose in Flutter abbrechen](/de/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/) ist hier relevant, weil ein beim Teardown offener Timer dieselbe `_verifyInvariants`-Assertion auslöst wie offene gefälschte Timer.
- [Riverpod Notifier vs AsyncNotifier vs StreamNotifier in Flutter](/de/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/) für die Verkabelung einer injizierten Uhr über ein Provider-Override statt über eine Zone.
- [Fix: A TextEditingController was used after being disposed in Flutter](/de/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) für die Klasse von Testfehlern, die auftauchen, sobald gefälschte Zeit in großen Sprüngen läuft.

## Quellen

- [API-Dokumentation von `package:clock`](https://pub.dev/documentation/clock/latest/) und die [Implementierung von `withClock`](https://pub.dev/packages/clock), Version 1.1.2.
- [`package:fake_async`](https://pub.dev/packages/fake_async) 1.3.3, insbesondere der `FakeAsync`-Konstruktor und `FakeAsync.run`.
- [`AutomatedTestWidgetsFlutterBinding`](https://api.flutter.dev/flutter/flutter_test/AutomatedTestWidgetsFlutterBinding-class.html) und [`TestWidgetsFlutterBinding.clock`](https://api.flutter.dev/flutter/flutter_test/TestWidgetsFlutterBinding/clock.html) in der API-Referenz von Flutter 3.44.
- [Die Dokumentation der `flutter_test`-Bibliothek](https://api.flutter.dev/flutter/flutter_test/flutter_test-library.html) zu `flutter_test_config.dart` und `testExecutable`.
- Quellcode des Flutter SDK am Tag 3.44.2: `packages/flutter_test/lib/src/binding.dart`, `packages/flutter_test/lib/src/_binding_web.dart` und `packages/flutter_tools/lib/src/test/test_config.dart`.
