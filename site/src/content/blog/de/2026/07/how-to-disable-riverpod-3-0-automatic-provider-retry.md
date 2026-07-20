---
title: "So deaktivieren Sie den automatischen Provider-Retry in Riverpod 3.0"
description: "Riverpod 3.0 wiederholt einen fehlgeschlagenen Provider standardmaessig bis zu 10-mal. Uebergeben Sie eine Retry-Funktion, die null zurueckgibt, an ProviderScope, ProviderContainer oder einen einzelnen Provider, um das abzuschalten oder zu begrenzen."
pubDate: 2026-07-20
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "async"
lang: "de"
translationOf: "2026/07/how-to-disable-riverpod-3-0-automatic-provider-retry"
translatedBy: "claude"
translationDate: 2026-07-20
---

Riverpod 3.0 hat den automatischen Retry eingefuehrt: Wenn ein Provider waehrend seines Aufbaus eine Exception wirft, wiederholt Riverpod ihn stillschweigend bis zu 10-mal mit einem exponentiellen Backoff, der bei 200ms beginnt und sich bis auf 6,4 Sekunden verdoppelt. Um das abzuschalten, uebergeben Sie einen `retry`-Callback, der `null` zurueckgibt. Sie koennen das global auf `ProviderScope` oder `ProviderContainer` tun, oder pro Provider am Provider-Konstruktor oder an der `@Riverpod`-Annotation. Das ist getestet mit `flutter_riverpod` 3.x (die 3.0-Reihe erschien im September 2025; die aktuelle Version ist 3.3.2 vom Juni 2026), Flutter 3.44 und Dart 3.x.

Der Einzeiler, falls Sie es einfach ueberall loswerden wollen:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
ProviderScope(
  retry: (retryCount, error) => null, // never retry
  child: MyApp(),
)
```

Alles andere in diesem Beitrag dreht sich darum, warum der Retry existiert, wann der Standard Ihnen tatsaechlich hilft und wie Sie ihn begrenzen, statt ihn ganz abzuschalten.

## Warum ein Provider, der frueher einmal fehlschlug, jetzt zehnmal fehlschlaegt

In Riverpod 2.x ging ein Provider, dessen `build` eine Exception warf, direkt in `AsyncError` ueber und blieb dort, bis etwas ihn invalidierte. Ein Fehlschlag, ein Fehlerzustand. Vorhersehbar.

Riverpod 3.0 hat diesen Standard geaendert. Die Begruendung ist stichhaltig: Viele Provider-Fehlschlaege sind voruebergehend. Ein `FutureProvider`, der einen HTTP-Endpunkt aufruft, schlaegt fehl, weil das Netzwerk kurz aussetzte, nicht weil der Code falsch ist. Ein Wiederholen mit Backoff bedeutet, dass sich die UI von selbst erholt, statt auf einem Fehlerbildschirm zu verharren, den ein manuelles Aktualisieren beseitigt haette. Die offizielle Dokumentation beschreibt den Standard als Wiederholung "up to 10 times, with an exponential backoff going from 200ms to 6.4 seconds."

Das Problem ist, dass dieses Verhalten unsichtbar bleibt, bis es Sie beisst. Ein Provider, der deterministisch fehlschlaegt, etwa weil er eine fehlerhafte Antwort parst oder auf einen 404 trifft, der niemals ein 200 wird, brennt jetzt alle 10 Versuche durch, bevor er sich in einem Fehlerzustand niederlaesst. Waehrend dieser Versuche dreht sich Ihr Ladeindikator weiter, Ihre Logs fuellen sich zehnmal mit demselben Stacktrace, und jeder Seiteneffekt in `build` (ein Analytics-Event, eine Logzeile, ein Zaehler-Inkrement) feuert zehnmal statt einmal. In Tests ist es schlimmer: Ein Provider, der schnell fehlschlagen soll, haengt stattdessen, waehrend der Retry-Zeitplan abgespielt wird, und Ihr Test laeuft in einen Timeout.

## Den Retry-Sturm reproduzieren

Hier ist der kleinste Provider, der das Verhalten zeigt. Er wirft bedingungslos und loggt jedes Mal, wenn `build` laeuft.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
import 'package:flutter_riverpod/flutter_riverpod.dart';

int _attempts = 0;

final brokenProvider = FutureProvider<int>((ref) async {
  _attempts++;
  print('build attempt #$_attempts');
  throw StateError('this will never succeed');
});
```

Beobachten Sie ihn von einem Widget aus:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
class Screen extends ConsumerWidget {
  const Screen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(brokenProvider);
    return value.when(
      data: (n) => Text('$n'),
      loading: () => const CircularProgressIndicator(),
      error: (e, _) => Text('failed: $e'),
    );
  }
}
```

Bei Riverpod 2.x gibt die Konsole einmal `build attempt #1` aus und das Widget zeigt den Fehler sofort. Bei Riverpod 3.0 gibt die Konsole zehn Versuche aus, verteilt ueber etwa 13 Sekunden (200ms + 400ms + 800ms + ... bis zu 6,4s), und der Ladeindikator bleibt die ganze Zeit oben, bevor der Fehler endlich gerendert wird. Diese Luecke von 13 Sekunden zwischen "die Anfrage ist fehlgeschlagen" und "der Nutzer sieht einen Fehler" ist die Ueberraschung, auf die die meisten Teams zuerst stossen.

## Der Retry-Callback und wie das Zurueckgeben von null ihn deaktiviert

Jeder Retry-Hook in Riverpod 3.0 hat dieselbe Form. Er erhaelt den aktuellen Retry-Zaehler und den Fehler und gibt ein `Duration?` zurueck. Geben Sie eine Dauer zurueck, um so lange zu warten und es erneut zu versuchen; geben Sie `null` zurueck, um aufzugeben und den Fehler sichtbar zu machen.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
Duration? myRetry(int retryCount, Object error) {
  if (retryCount >= 5) return null;                       // cap attempts
  if (error is ProviderException) return null;            // don't retry wrapped deps
  return Duration(milliseconds: 200 * (1 << retryCount)); // 200ms, 400ms, 800ms...
}
```

`1 << retryCount` ist einfach `2^retryCount`, sodass dies die eingebaute exponentielle Kurve reproduziert. Um den Retry vollstaendig zu deaktivieren, faellt die ganze Funktion auf eine Zeile zusammen, die ihre Argumente ignoriert und immer `null` zurueckgibt.

### Fuer die gesamte App abschalten

`ProviderScope` ist das Widget, das Ihren Provider-Zustand in einer Flutter-App beherbergt. Geben Sie ihm ein `retry`, und jeder Provider darunter erbt die Richtlinie, sofern er sie nicht ueberschreibt.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
void main() {
  runApp(
    ProviderScope(
      retry: (retryCount, error) => null,
      child: const MyApp(),
    ),
  );
}
```

In reinem Dart, oder ueberall dort, wo Sie einen Container von Hand aufbauen, liegt derselbe Parameter auf `ProviderContainer`:

```dart
// Dart 3.x, riverpod 3.x
final container = ProviderContainer(
  retry: (retryCount, error) => null,
);
```

### Fuer einen Provider abschalten

Global-aus ist ein grobes Werkzeug. Meist wollen Sie den Retry fuer die beiden Netzwerk-Provider, wo er hilft, und aus fuer den Provider, der lokale Konfiguration parst und nur wegen eines Fehlers fehlschlagen kann. Jeder Provider-Konstruktor nimmt seinen eigenen `retry`-Parameter, und ein Wert pro Provider gewinnt gegenueber dem auf Scope-Ebene.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
final configProvider = FutureProvider<AppConfig>(
  (ref) async => AppConfig.fromAsset(await rootBundle.loadString('config.json')),
  retry: (retryCount, error) => null, // parsing bugs won't fix themselves
);
```

Derselbe Parameter existiert bei den klassenbasierten Providern. Fuer einen `NotifierProvider` oder `AsyncNotifierProvider` sitzt er neben dem Konstruktor-Tear-off:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
final todoListProvider = NotifierProvider<TodoList, List<Todo>>(
  TodoList.new,
  retry: (retryCount, error) => null,
);
```

### In codegenerierten Providern abschalten

Wenn Sie `riverpod_generator` verwenden, traegt die Annotation ein `retry`-Argument. Richten Sie es auf eine benannte Funktion, damit der generierte Provider sie aufgreift.

```dart
// Flutter 3.44, Dart 3.x, riverpod_annotation 3.x
Duration? noRetry(int retryCount, Object error) => null;

@Riverpod(retry: noRetry)
Future<int> counter(Ref ref) async {
  throw StateError('fails once, stays failed');
}
```

Fuehren Sie nach dem Aendern der Annotation `dart run build_runner build` aus. Der generierte `counterProvider` traegt nun die No-Retry-Richtlinie, und Sie fassen die generierte Datei nie an.

## Was der Standard bereits ueberspringt

Bevor Sie den Retry global deaktivieren, sollten Sie wissen, dass der Standard nicht so aggressiv ist wie "alles zehnmal wiederholen". Zwei Kategorien sind von Haus aus ausgeschlossen.

`Error` (im Gegensatz zu `Exception`) wird nie wiederholt. In Dart signalisiert `Error` einen Programmierfehler: eine fehlgeschlagene Assertion, eine Null-Pruefung auf einem Null-Wert, eine falsche Umwandlung. Diese sind durch Warten nicht behebbar, also macht Riverpod sie sofort sichtbar. Wenn Ihr Provider `StateError` oder `TypeError` wirft, greift der Standard-Retry gar nicht erst ein. Der `brokenProvider` oben wirft `StateError`, was ein `Error`-Untertyp ist, sodass er streng genommen sofort sichtbar wuerde; tauschen Sie ihn gegen eine einfache `Exception`, wenn Sie den vollen Sturm aus zehn Versuchen in der Konsole beobachten wollen.

`ProviderException` wird ebenfalls uebersprungen. Wenn Provider A den Provider B liest und B fehlgeschlagen ist, verpackt Riverpod den Fehlschlag von B in eine `ProviderException`, bevor er A erreicht. A zu wiederholen waere sinnlos, weil A selbst in Ordnung ist; es ist B, der sich erholen muss. Der Standard-Retry erkennt diese Verpackung und wiederholt sie nicht, was eine Kaskade vermeidet, bei der jeder Provider in einer Abhaengigkeitskette seinen eigenen Retry-Zeitplan ausfuehrt. Falls Sie sich je gefragt haben, warum der umschliessende Typ eine Rolle spielt: Es ist dieselbe `ProviderException` hinter dem kaputten `try`/`catch`, wenn [Riverpod 3.0 eine ProviderException statt Ihres urspruenglichen Fehlers wirft](/de/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/).

"Retry deaktivieren" bedeutet in der Praxis also "aufhoeren, behebbare `Exception`s zu wiederholen". Errors und Abhaengigkeitsfehler wurden bereits sofort sichtbar gemacht.

## Den Retry begrenzen statt abzuschalten

Den Retry zu deaktivieren ist die richtige Entscheidung fuer Provider, die lokale Daten laden, Assets parsen oder irgendeine Operation ausfuehren, bei der ein Fehlschlag einen Bug statt einen Aussetzer bedeutet. Aber fuer echt wackelige I/O ist ein begrenzter Retry besser als keiner. Das Muster lautet: die Versuche niedrig deckeln, Fehler ueberspringen, von denen Sie wissen, dass sie dauerhaft sind, und einen kurzen Backoff beibehalten.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
Duration? networkRetry(int retryCount, Object error) {
  // Give up after 3 tries.
  if (retryCount >= 3) return null;
  // A 404 will not become a 200 by waiting.
  if (error is NotFoundException) return null;
  // Otherwise back off: 300ms, 600ms, 1.2s.
  return Duration(milliseconds: 300 * (1 << retryCount));
}

final userProvider = FutureProvider<User>(
  (ref) => api.fetchUser(),
  retry: networkRetry,
);
```

Drei Versuche ueber etwa zwei Sekunden reichen ueblicherweise aus, um einen voruebergehenden Fehlschlag zu ueberstehen, ohne dass der Nutzer 13 Sekunden lang auf einen Ladeindikator starren muss. Der Standard von 10 Versuchen ist auf Widerstandsfaehigkeit statt Reaktionsschnelligkeit abgestimmt; die meisten Apps wollen bei nutzerseitigen Providern den umgekehrten Kompromiss.

## Den Retry in jedem Test deaktivieren

Das ist die Aenderung, die die meisten Teams vergessen, und sie erzeugt das verwirrendste Symptom: Ein Test, der frueher auf einen Fehlerzustand pruefte, laeuft jetzt in einen Timeout. Ein auf die normale Weise erstellter `ProviderContainer` erbt den Standard-Retry, sodass ein Provider, den Sie fehlschlagen lassen *wollen*, 13 Sekunden mit Wiederholungen verbringt, bevor Ihr `expect` auf den Fehler ueberhaupt laeuft.

Riverpod 3.0 liefert `ProviderContainer.test`, einen Konstruktor, der automatische Entsorgung fuer Tests hinzufuegt, und Sie sollten ihm einen No-Op-Retry uebergeben.

```dart
// Dart 3.x, riverpod 3.x, flutter_test
import 'package:flutter_test/flutter_test.dart';
import 'package:riverpod/riverpod.dart';

void main() {
  test('brokenProvider surfaces its error immediately', () async {
    final container = ProviderContainer.test(
      retry: (retryCount, error) => null,
    );

    await expectLater(
      container.read(brokenProvider.future),
      throwsA(isA<StateError>()),
    );
  });
}
```

Ohne die `retry`-Ueberschreibung wuerde dieser Test irgendwann bestehen, aber erst nach dem vollen Retry-Zeitplan, was entweder Ihr Test-Timeout sprengt oder die Suite kriechen laesst. Setzen Sie den No-Op-Retry in einem gemeinsamen Test-Helfer, damit jeder Container ihn standardmaessig bekommt und niemand daran denken muss.

## Die Falle mit Seiteneffekten in build

Der Grund, warum es sich lohnt, den Retry zu verstehen, statt ihn blind zu deaktivieren, ist, dass `build`-Methoden von Providern keine extern sichtbaren Seiteneffekte haben sollen, es in der Praxis aber oft doch tun. Wenn Ihr `build` an Analytics loggt, eine Metrik inkrementiert oder in einen Cache schreibt, bevor es wirft, wiederholt jeder Retry diesen Seiteneffekt. Zehn Versuche bedeuten zehn Analytics-Events fuer einen einzigen logischen Fehlschlag. Den Retry auf eine niedrige Anzahl zu begrenzen, oder ihn bei Providern zu deaktivieren, deren `build` nicht idempotent ist, haelt Ihre Telemetrie ehrlich. Wenn Sie nach einem `await` innerhalb dieser Methoden nach Zustand greifen, gilt dieselbe Disziplin, die Sie dazu bringt, [Ref.mounted nach einer async-Luecke zu pruefen](/de/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/), auch fuer retry-lastige Provider, weil ein Retry den gesamten async-Rumpf erneut ausfuehrt.

Noch eine Feinheit: Retry-Zaehler werden zurueckgesetzt, wenn der Provider invalidiert und von Grund auf neu aufgebaut wird. Das Budget von 10 Versuchen gilt pro ununterbrochener Fehlschlagsserie, nicht pro App-Sitzung. Ein Provider, der fehlschlaegt, seine Wiederholungen ausschoepft, durch ein Pull-to-Refresh invalidiert wird und erneut fehlschlaegt, beginnt ein frisches Budget von 10 Versuchen. Wenn Sie sich darauf verlassen, dass der Retry irgendwann stoppt, stellen Sie sicher, dass die Invalidierung ihn nicht stillschweigend zuruecksetzt.

## Ihren Standard waehlen

Fuer eine neue Riverpod-3.0-App ist die pragmatische Einrichtung: einen kurzen begrenzten Retry auf `ProviderScope`-Ebene fuer den haeufigen Fall beibehalten und einzelne Provider auf `null` ueberschreiben, wo ein Retry nicht helfen kann. Das gibt Ihnen Widerstandsfaehigkeit bei Netzwerk-Lesevorgaengen, ohne den 13-Sekunden-Ladeindikator bei deterministischen Fehlschlaegen.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
ProviderScope(
  retry: (retryCount, error) {
    if (retryCount >= 2) return null; // app-wide default: 3 attempts max
    return Duration(milliseconds: 300 * (1 << retryCount));
  },
  child: const MyApp(),
)
```

Wenn Sie von Riverpod 2.x kommen und das alte Verhalten "einmal fehlschlagen, fehlgeschlagen bleiben" ueberall haben wollen, waehrend Sie die Funktion bewerten, ist das globale `retry: (_, __) => null` der ehrliche Ausgangspunkt. Schalten Sie es pro Provider wieder ein, sobald Sie wissen, welche tatsaechlich davon profitieren. Die Migrationshinweise decken den Rest dessen ab, was sich neben dem Retry im [Upgrade von Riverpod 2.x auf 3.0](/de/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/) geaendert hat, und falls Sie noch ueberlegen, ob Riverpod ueberhaupt das richtige Werkzeug ist, ordnet der [Vergleich Provider vs Riverpod vs Bloc](/de/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) das in einen Kontext ein. Fuer die Lade- und Fehlerdarstellungsseite derselben Provider sehen Sie, wie man [Lade- und Fehlerzustaende mit AsyncValue anzeigt](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## Quellen

- [Automatic retry](https://riverpod.dev/docs/concepts2/retry) - Riverpod-Dokumentation zur Signatur des Retry-Callbacks, den Standardwerten und der Konfiguration pro Provider.
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) - die Ankuendigung der Retry-Funktion und das Standard-Backoff-Verhalten.
- [Migrating from 2.0 to 3.0](https://riverpod.dev/docs/3.0_migration) - Migrationsleitfaden einschliesslich `ProviderContainer.test`.
- [riverpod changelog](https://pub.dev/packages/riverpod/changelog) - Versionshistorie fuer die 3.x-Reihe.
