---
title: "unawaited_futures vs. discarded_futures in Dart: welcher Lint welchen nicht abgewarteten Aufruf findet"
description: "unawaited_futures prüft nur async-Bodies, discarded_futures nur synchrone Bodies, und beide übersehen Arrow-Funktionen, Tear-offs und Collection-Literale. Fall für Fall gemessen mit Dart 3.12.2 und Flutter 3.44.8, dazu die analysis_options.yaml, die ich empfehle."
pubDate: 2026-10-22
template: vs
tags:
  - "comparison"
  - "dart"
  - "flutter"
  - "lints"
  - "async"
lang: "de"
translationOf: "2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart"
translatedBy: "claude"
translationDate: 2026-10-22
---

**Kurze Antwort:** Die beiden Lints teilen sich die Arbeit danach auf, in welcher Art von Funktionsrumpf der Aufruf steht. `unawaited_futures` meldet ein `Future`, das in einem `async`-Body verworfen wird. `discarded_futures` meldet ein `Future` (oder `FutureOr`), das in einem synchronen Body verworfen wird, in Flutter also in `initState`, `dispose` und jedem `onPressed: () { ... }`-Block. Sie schlagen nie in derselben Zeile an. Wenn Sie nur einen aktivieren, aktivieren Sie `unawaited_futures`: Er ist günstig, und jeder Treffer ist ein wahrscheinlicher Fehler. Ergänzen Sie `discarded_futures`, wenn Sie bereit sind, in Widget-Code bei jedem beabsichtigten Fire-and-forget-Aufruf `unawaited(...)` zu schreiben. Alles unten wurde mit `dart analyze` auf Dart 3.12.2 gemessen (Flutter 3.44.8, `meta` 1.19.0).

Keine der beiden Regeln ist in `package:lints` (core oder recommended) oder in `package:flutter_lints` 6.0.0 enthalten, ein frisches `flutter create`-Projekt meldet also keine von beiden, bis Sie sie aktivieren.

## Der Vergleich auf einen Blick

| | `unawaited_futures` | `discarded_futures` |
| --- | --- | --- |
| Wo geprüft wird | Anweisungen in `async`- / `async*`-Bodies | Anweisungen in synchronen Bodies |
| Gemeldete Typen | `Future` und Untertypen (inkl. `TickerFuture`) | `Future`, Untertypen und `FutureOr` |
| Verfügbar seit | schon lange, vor Dart 2.18 | Dart 2.18 |
| In `lints` / `flutter_lints` | nein / nein | nein / nein |
| Typischer Treffer in Flutter | `Navigator.pushNamed(...)` in `onPressed: () async { ... }` | `_load();` in `initState`, `_controller.forward();` |
| Stumm geschaltet durch `unawaited(...)` | ja | ja |
| Stumm geschaltet durch `@awaitNotRequired` (`meta` 1.17.0+) | ja | ja |
| Sammelkorrektur mit `dart fix --apply` | nein (nur IDE-Schnellkorrektur) | nein (nur IDE-Schnellkorrektur) |
| Rauschpegel in einer Flutter-App | niedrig | mittel bis hoch |

## Warum es zwei Regeln statt einer gibt

Beide Regeln sind dünne Hüllen um denselben Visitor, `UnusedFuturesVisitor` in `pkg/linter/lib/src/util/unused_futures.dart`. Der Visitor durchläuft drei Arten von Knoten: Ausdrucksanweisungen, Cascade-Abschnitte und String-Interpolationen. Für jeden Ausdruck fragt er die Regel, ob der Ausdruck "interessant" ist, und dieser Filter ist der gesamte Unterschied zwischen den beiden Lints. Hier der Filter aus `unawaited_futures.dart` am Tag `3.12.2`:

```dart
// dart-lang/sdk, tag 3.12.2, pkg/linter/lib/src/rules/unawaited_futures.dart
isInteresting: (node) {
  var type = node.staticType;
  // This rule is not currently concerned with `FutureOr`.
  if (type == null || !type.isOrImplementsFuture) {
    return false;
  }
  // This rule is only concerned with code in async functions.
  return node.thisOrAncestorOfType<FunctionBody>()?.isAsynchronous ?? false;
},
```

Und aus `discarded_futures.dart`:

```dart
// dart-lang/sdk, tag 3.12.2, pkg/linter/lib/src/rules/discarded_futures.dart
isInteresting: (node) {
  var type = node.staticType;
  // This rule does concern itself with `FutureOr`.
  if (type == null || !type.isOrImplementsFutureOrFutureOr) {
    return false;
  }
  // This rule is only concerned with code in sync functions.
  return node.thisOrAncestorOfType<FunctionBody>()?.isSynchronous ?? false;
},
```

Aus diesem Code folgen zwei Konsequenzen. Erstens entscheidet der nächstgelegene umschließende `FunctionBody`, nicht die äußere Methode. Ein Block-Closure `() { save(); }` innerhalb einer `async`-Methode ist ein synchroner Body und gehört daher zu `discarded_futures`. Zweitens wird `FutureOr` nur auf der synchronen Seite abgedeckt. Ein `FutureOr<int>`, das in einer `async`-Methode verworfen wird, meldet keine der beiden Regeln.

Auch die Motivation unterscheidet sich. `unawaited_futures` zielt auf das vergessene `await`: Sie sind bereits in einer `async`-Funktion, die Korrektur ist also ein einziges Schlüsselwort. `discarded_futures` zielt auf das vergessene `async`: Eine synchrone Funktion, die asynchrone Arbeit startet, sollte meist selbst `async` sein, und ihre Aufrufer sollten darauf warten. Die offizielle Dokumentation von `discarded_futures` sagt genau das und verweist auf `unawaited_futures` als die Regel, die übernimmt, sobald die Funktion `async` ist.

## Die Fallsammlung: was wo anschlägt

Ich habe jede Aufrufform, die mir eingefallen ist, in eine Datei gepackt und `dart analyze` mit beiden Regeln auf Basis von `package:lints/recommended.yaml` ausgeführt:

```yaml
# analysis_options.yaml, Dart 3.12.2
include: package:lints/recommended.yaml
linter:
  rules:
    - unawaited_futures
    - discarded_futures
```

```dart
// Dart 3.12.2, meta 1.19.0
import 'dart:async';
import 'package:meta/meta.dart';

Future<void> save() async {}
FutureOr<int> maybeAsync() => 1;
@awaitNotRequired
Future<void> log(String m) async {}

class Repo {
  Future<void> flush() async {}
}

Future<void> asyncCaller() async {
  save(); // A1
  maybeAsync(); // A2 FutureOr in async
  final f = save(); // A3 assigned
  unawaited(save()); // A4
  log('x'); // A5 awaitNotRequired
  Repo()..flush(); // A6 cascade
  print('${save()}'); // A7 interpolation
  var list = [save()]; // A8 collection
  Future.delayed(Duration.zero, () => 1); // A9
  <String, Future<void>>{}.putIfAbsent('k', save); // A10
  void inner() {
    save(); // A11 sync closure inside async
  }
  [1].forEach((_) async {
    save(); // A12 async closure
  });
  save().then((_) {}); // A13 .then chain
  save().ignore(); // A14 ignore()
  await f;
  inner();
  list.length;
}

void syncCaller() {
  save(); // S1
  maybeAsync(); // S2 FutureOr in sync
  final f = save(); // S3 assigned
  unawaited(save()); // S4
  log('x'); // S5 awaitNotRequired
  Repo()..flush(); // S6 cascade
  takesFuture(save()); // S7 argument
  f.ignore();
}

Future<void> syncReturn() {
  return save(); // S8 returned
}

void takesFuture(Future<void> f) {}

void Function() handler = () => save(); // S9 arrow in sync closure
void Function() handler2 = () {
  save(); // S10 block sync closure
};
Future<void> Function() handler3 = () async {
  save(); // S11 async closure
};
```

Die Ergebnisse, aus der Ausgabe von `dart analyze` abgelesen:

| Fall | Code | `unawaited_futures` | `discarded_futures` |
| --- | --- | --- | --- |
| A1 | `save();` in `async` | gemeldet | - |
| A2 | `maybeAsync();` (`FutureOr`) in `async` | - | - |
| A3, S3 | `final f = save();` | - | - |
| A4, S4 | `unawaited(save());` | - | - |
| A5, S5 | aufgerufene Funktion mit `@awaitNotRequired` | - | - |
| A6 | `Repo()..flush();` in `async` | gemeldet | - |
| A7 | `'${save()}'` in `async` | gemeldet | - |
| A8 | `[save()]` Collection-Literal | - | - |
| A9 | `Future.delayed(d, computation)` | - | - |
| A10 | `Map.putIfAbsent` | - | - |
| A11 | Block-Closure in einer `async`-Methode | - | gemeldet |
| A12 | `async`-Closure | gemeldet | - |
| A13 | `save().then((_) {});` | gemeldet (bei `then`) | - |
| A14 | `save().ignore();` | - | - |
| S1 | `save();` in sync | - | gemeldet |
| S2 | `maybeAsync();` in sync | - | gemeldet |
| S6 | `Repo()..flush();` in sync | - | gemeldet |
| S7 | `takesFuture(save());` | - | - |
| S8 | `return save();` | - | - |
| S9 | `() => save()` Arrow-Closure | - | - |
| S10 | `() { save(); }` | - | gemeldet |
| S11 | `() async { save(); }` | gemeldet | - |

Ein paar Zeilen verdienen je einen Satz.

- **A9 und A10 sind fest verdrahtete Ausnahmen.** Der Visitor überspringt `Future.delayed`, wenn es mit einem Computation-Argument aufgerufen wird, sowie `Map.putIfAbsent`, weil beide Rückgabewerte liefern, die man routinemäßig absichtlich ignoriert.
- **A13 wird bei `then` gemeldet, nicht bei `save`.** `save().then(...)` gibt ein neues `Future` zurück, und dieses wird verworfen. Ein angehängtes `.then` ersetzt nicht den Umgang mit dem Ergebnis.
- **A14 ist sauber, weil `Future.ignore()` den Typ `void` zurückgibt.** Es ist die Methodenaufruf-Alternative zu `unawaited(...)`, verfügbar seit Dart 2.14. Anders als `unawaited` verschluckt es auch jeden Fehler, mit dem das Future abgeschlossen wird. Verwenden Sie es daher nur, wenn Ihnen das Ergebnis wirklich egal ist.
- **S7 ist absichtlich sauber.** Wer das Future an einen Parameter vom Typ `Future<void>` übergibt, überträgt die Verantwortung an die aufgerufene Funktion.

## Die blinden Flecken, die beide Regeln teilen

Zwei Zeilen in dieser Tabelle sind echte False Negatives, und beide werden upstream verfolgt.

**Arrow-Bodies (S9).** `() => save()` ist ein synchroner Ausdrucks-Body, der das `Future` zurückgibt. Der Visitor betrachtet nur Anweisungen, also schlägt nichts an, selbst wenn der Closure einem `void Function()` zugewiesen wird und der Aufrufer das Future wegwirft. Das ist [dart-lang/sdk#61155](https://github.com/dart-lang/sdk/issues/61155).

**Tear-offs in `void`-Callbacks.** Ich habe außerdem Folgendes ausgeführt:

```dart
// Dart 3.12.2
void execute(void Function() cb) => cb();

void tearoffs() {
  execute(save); // Future<void> Function() passed as void Function()
}
```

Keine der beiden Regeln hat das gemeldet. Dart erlaubt ein `Future<void> Function()` dort, wo ein `void Function()` erwartet wird, das Future wird also innerhalb von `execute` verworfen, und kein Lint sieht es. [dart-lang/sdk#56921](https://github.com/dart-lang/sdk/issues/56921) behandelt das. Der verwandte Lint ist `avoid_void_async`, der nur `async`-Funktionen erfasst, die als `void` deklariert sind, nicht aber Tear-offs.

Rechnen Sie Collection-Literale (A8) und `FutureOr` in `async`-Bodies (A2) hinzu, dann haben Sie die vollständige Liste der Formen, in denen ein verworfenes Future nicht gemeldet wird. `unawaited` akzeptiert heute auch kein `FutureOr` ([dart-lang/sdk#63818](https://github.com/dart-lang/sdk/issues/63818)); für S2 ist die saubere Lösung daher `final _ = maybeAsync();` oder darauf zu warten.

## Wie es in einem Flutter-Widget aussieht

Dieselbe Aufteilung bestimmt den Rauschpegel in einer Flutter-App, denn die meisten Widget-Callbacks sind synchron. Auf Flutter 3.44.8 mit beiden Regeln auf Basis von `package:flutter_lints/flutter.yaml`:

```dart
// Flutter 3.44.8, Dart 3.12.2
class _HomeState extends State<Home> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this);

  Future<void> _load() async {}

  @override
  void initState() {
    super.initState();
    _load(); // F1: discarded_futures
    _c.forward(); // F2: discarded_futures (TickerFuture implements Future)
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      TextButton(
        onPressed: () => Navigator.of(context).push(
            MaterialPageRoute<void>(builder: (_) => const Home())), // F3: nothing
        child: const Text('a'),
      ),
      TextButton(
        onPressed: () {
          Navigator.of(context).pushNamed('/x'); // F4: discarded_futures
        },
        child: const Text('b'),
      ),
      TextButton(
        onPressed: () async {
          await _load();
          if (!context.mounted) return;
          Navigator.of(context).pushNamed('/x'); // F5: unawaited_futures
        },
        child: const Text('c'),
      ),
    ]);
  }
}
```

F2 ist der Fall, der die Leute ärgert. `AnimationController.forward()`, `reverse()`, `repeat()` und `animateTo()` geben alle ein `TickerFuture` zurück, und fast niemand wartet darauf. Mit aktiviertem `discarded_futures` braucht jeder dieser Aufrufe `unawaited(...)`. F1 dagegen ist genau der Fehler, für den die Regel existiert: `_load()` in `initState` wirft seinen Fehler in die Zone statt in ein `try`/`catch`, das Sie geschrieben haben, und wenn es `setState` aufruft, nachdem das Widget verschwunden ist, sind Sie im Gebiet der [Mounted-Prüfungen](/de/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).

F3 und F4 tun dasselbe. Nur die Blockform wird gemeldet, das heißt: Wer einen Callback von `{ ... }` auf `=>` umstellt, bringt `discarded_futures` zum Schweigen, ohne etwas zu beheben.

## Wann unawaited_futures die richtige Wahl ist

- **Sie wollen eine Regel mit nahezu null False Positives.** Ein verworfenes `Future` in einer `async`-Funktion ist fast immer ein vergessenes `await`, und der Fehler, den es trägt, umgeht Ihr `try`/`catch` und landet in [`PlatformDispatcher.onError` oder Ihrer geschützten Zone](/de/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/).
- **Sie schreiben Server- oder CLI-Dart.** `main` ist meist `async`, daher ist der Großteil Ihres Codes abgedeckt, und der übrige synchrone Code startet selten asynchrone Arbeit.
- **Ihr Team nutzt bereits `async`-Callbacks.** Wenn Ihre Handler `onPressed: () async { ... }` sind, deckt diese Regel sie ab (F5).

## Wann discarded_futures dazukommen sollte

- **Sie veröffentlichen ein Paket.** Eine synchrone öffentliche Methode, die stillschweigend asynchrone Arbeit startet, ist ein API-Smell, und diese Regel findet jede davon.
- **Sie wollen, dass Fire-and-forget im Review sichtbar ist.** Mit aktivierter Regel liest sich jedes beabsichtigte Verwerfen als `unawaited(...)` oder trägt `@awaitNotRequired` an der aufgerufenen Funktion, und genau das ist der Sinn.
- **Sie hatten schon einen Fehler durch Arbeit in `initState`, auf die niemand gewartet hat.** Das ist der Fall F1, und nur diese Regel sieht ihn.

Wenn Sie sie in einer bestehenden Flutter-App aktivieren, rechnen Sie damit, dass die meisten Treffer `AnimationController`-Aufrufe und Navigation in Block-Callbacks sind. Für keine der beiden Regeln gibt es in Dart 3.12.2 eine `dart fix`-Sammelkorrektur (`dart fix --dry-run` schlug in meinem Repro nichts dafür vor). Anders als bei den [Migrationen, die Sie mit `dart fix` repoweit anwenden können](/de/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/), ist diese Bereinigung also eine IDE-Schnellkorrektur nach der anderen.

## APIs mit @awaitNotRequired als sicher zum Verwerfen markieren

Für eigene APIs, die als Fire-and-forget gedacht sind (Logging, Analytics, Cache-Aufwärmung), annotieren Sie die Deklaration, statt jede Aufrufstelle zu umhüllen:

```dart
// Dart 3.12.2, meta 1.19.0
import 'package:meta/meta.dart';

@awaitNotRequired
Future<void> track(String event) async {
  // send to analytics, errors handled inside
}

void onTap() {
  track('tap'); // neither rule reports this
}
```

`@awaitNotRequired` wurde mit `package:meta` 1.17.0 eingeführt, und 1.18.1 erlaubte es auf Typedefs, sodass auch ein Callback-Parameter, der mit einem annotierten Typedef typisiert ist, ausgenommen ist. Beide Lints beachten es (A5 und S5 oben), und die Prüfung durchläuft auch überschriebene Member, sodass eine Überschreibung einer annotierten Methode ebenfalls ausgenommen bleibt. Verwenden Sie es nur, wenn die Funktion ihre Fehler selbst behandelt: Die Annotation teilt dem Analyzer mit, dass das Verwerfen des Futures sicher ist, und es liegt an Ihnen, dies sicherzustellen. Flutter 3.47 exportiert die Annotation aus `package:flutter/foundation.dart` erneut; wenn ein Paket, das sie verwendet, Ihren 3.44-Build bricht, lesen Sie [die Behebung des undefinierten Namens `awaitNotRequired`](/de/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/).

## Der Stolperstein, der die Wahl trifft

Wenn Ihre Codebasis auf Arrow-Callbacks setzt (`onPressed: () => doThing()`), bringt `discarded_futures` weniger, als sein Rauschen vermuten lässt, weil die Arrow-Form für ihn unsichtbar ist (S9, F3). In dieser Codebasis liefert `unawaited_futures` allein plus eine Teamregel "asynchrone Arbeit gehört in `async`-Callbacks" den größten Teil des Nutzens. Wenn Ihre Codebasis Block-Callbacks und Loader in `initState` verwendet, ist `discarded_futures` die einzige Regel, die diese Aufrufe überhaupt sieht, und die `unawaited`-Änderungen sind es wert.

C#-Entwickler erkennen die Form des Problems wieder: Es ist die Dart-Version von [CS4014, "this call is not awaited"](/de/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/), nur dass C# es ausschließlich in `async`-Methoden meldet, also die Hälfte von `unawaited_futures`. Dart lässt Sie die andere Hälfte zusätzlich aktivieren.

## Meine Empfehlung

Aktivieren Sie `unawaited_futures` noch heute in jedem Dart- und Flutter-Projekt. Ergänzen Sie `discarded_futures` in Paketen und in Apps, in denen Fire-and-forget explizit sein soll, und nehmen Sie in Kauf, `unawaited(_controller.forward())` zu schreiben. Das ist die Konfiguration, die ich verwende:

```yaml
# analysis_options.yaml, Flutter 3.44.8 / Dart 3.12.2
include: package:flutter_lints/flutter.yaml

linter:
  rules:
    - unawaited_futures
    - discarded_futures
    - avoid_void_async
```

`avoid_void_async` ist der Begleiter: Er meldet `void bad() async {}` und zwingt Sie, `Future<void>` zu deklarieren, sodass das Future im Typsystem existiert, wo die anderen beiden Regeln (und Ihre Aufrufer) es sehen können. Die Tear-off-Lücke schließt er nicht, aber er verhindert, dass Sie neue `async`-Funktionen anlegen, auf deren Futures niemand warten kann.

## Verwandte Artikel

- [How to catch uncaught async errors in Flutter with runZonedGuarded and PlatformDispatcher](/de/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/)
- [How to use BuildContext safely after an await in Flutter](/de/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)
- [How to run dart fix across a whole repo to apply Flutter migrations](/de/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/)
- [Fix: Undefined name 'awaitNotRequired' from material_ui or cupertino_ui on Flutter 3.44](/de/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/)
- [Fix CS4014: because this call is not awaited, execution continues](/de/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/)

## Quellen

- [unawaited_futures](https://dart.dev/tools/linter-rules/unawaited_futures) und [discarded_futures](https://dart.dev/tools/linter-rules/discarded_futures) auf dart.dev.
- Regelquellen am Tag 3.12.2: [unawaited_futures.dart](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/rules/unawaited_futures.dart), [discarded_futures.dart](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/rules/discarded_futures.dart), [unused_futures.dart](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/util/unused_futures.dart).
- [`awaitNotRequired` in package:meta](https://pub.dev/documentation/meta/latest/meta/awaitNotRequired-constant.html) und das [meta-Changelog](https://pub.dev/packages/meta/changelog).
- Upstream-Issues: [#61155](https://github.com/dart-lang/sdk/issues/61155) (Arrow-Bodies), [#56921](https://github.com/dart-lang/sdk/issues/56921) (Tear-offs), [#63818](https://github.com/dart-lang/sdk/issues/63818) (`unawaited` und `FutureOr`).
