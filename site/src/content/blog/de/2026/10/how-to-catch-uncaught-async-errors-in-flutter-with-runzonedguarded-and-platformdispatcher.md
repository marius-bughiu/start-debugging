---
title: "Unbehandelte asynchrone Fehler in Flutter mit runZonedGuarded und PlatformDispatcher.instance.onError abfangen"
description: "FlutterError.onError sieht nur Fehler, die innerhalb von Framework-Callbacks geworfen werden. Nicht abgewartete Futures, Timer, Streams und Code nach einem await landen woanders. Hier steht, welcher Handler welchen Fehler abfängt, gemessen mit Flutter 3.44.8, und welches main()-Setup alle abfängt, auch im Web."
pubDate: 2026-10-18
template: how-to
tags:
  - "flutter"
  - "dart"
  - "error-handling"
  - "how-to"
lang: "de"
translationOf: "2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher"
translatedBy: "claude"
translationDate: 2026-10-18
---

**Kurze Antwort:** In Flutter 3.44 brauchen Sie zwei Handler, nicht einen. `FlutterError.onError` erhält Fehler, die innerhalb von Framework-Callbacks geworfen werden (build, Layout, Paint, ein synchroner `onPressed`). `PlatformDispatcher.instance.onError` erhält alles andere, was im Root-Isolate niemand abgefangen hat: ein nicht abgewartetes `Future`, einen `Timer`-Callback, einen Stream ohne `onError` und jeden Code, der nach einem `await` läuft, einschließlich des Rumpfs eines `async`-Button-Handlers. Setzen Sie beide am Anfang von `main()` und geben Sie im Dispatcher-Callback `true` zurück. `runZonedGuarded` ist der ältere Weg, die zweite Gruppe abzufangen, und auf Flutter Web weiterhin der einzige, weil die Web-Engine `PlatformDispatcher.onError` nie aufruft. Fehler in einem Isolate, das Sie selbst starten, erreichen keinen der beiden Handler, solange Sie keinen `onError`-Port übergeben.

Alles Folgende wurde mit Flutter 3.44.8 (stable) und Dart 3.12.2 gemessen, an einem Release-Build einer macOS-Desktop-App, die jede Fehlerart auslöst und protokolliert, welcher Handler sie erhalten hat. Das Routing der Handler ist auf Android und iOS dasselbe, da es im gemeinsamen Engine- und Framework-Code liegt.

## Warum FlutterError.onError asynchrone Fehler verpasst

Die meisten Fragen der Art "mein Crash-Reporter sieht diesen Fehler nicht" entstehen durch die Annahme, `FlutterError.onError` sei ein globaler Auffangpunkt. Das ist es nicht. Das Framework ruft ihn aus seinen eigenen `try`/`catch`-Blöcken auf: wenn das `build` eines Widgets wirft, wenn ein `RenderObject` beim Layout oder Paint wirft, wenn der Callback eines Gesture Recognizers wirft, wenn ein Scheduler-Callback wirft und wenn ein Handler für Plattformnachrichten wirft. Jede dieser Stellen verpackt den Fehler in ein `FlutterErrorDetails` mit einem `context`-String wie "while handling a gesture" oder "during a platform message callback" und übergibt es an `FlutterError.reportError`, das `FlutterError.onError` aufruft.

Ein Fehler, der geworfen wird, wenn kein Framework-Frame auf dem Aufrufstapel liegt, durchläuft keinen dieser `try`/`catch`-Blöcke. Betrachten Sie diesen Button:

```dart
// Flutter 3.44.8, Dart 3.12.2
ElevatedButton(
  onPressed: () async {
    await api.save();          // throws SocketException
    showSnackBar('Saved');
  },
  child: const Text('Save'),
)
```

Der Gesture Recognizer ruft `onPressed` auf, die Closure läuft bis zum ersten `await`, gibt ein `Future` zurück, und der `try`-Block des Recognizers wird sauber verlassen. Wenn `api.save()` später fehlschlägt, schließt die Exception dieses `Future` mit einem Fehler ab. Niemand wartet darauf (der Recognizer ignorierte den Rückgabewert), also gilt der Fehler als "unbehandelt" und wandert die Zonenkette nach oben. In der Root-Zone leitet die Flutter-Engine ihn an `PlatformDispatcher.instance.onError` weiter. Ist dieser nicht gesetzt, wird er ins Log geschrieben und ignoriert. Die App läuft weiter, weshalb diese Fehler oft unbemerkt bleiben, bis ein Benutzer einen Button meldet, der "nichts tut".

## Die Handler-Matrix, gemessen

Ich habe eine kleine macOS-App mit Flutter 3.44.8 gebaut, die nach ihrem ersten Frame pro Durchlauf eine Fehlerart auslöst und protokolliert, welcher Handler sie erhalten hat. Das Setup war das dokumentierte: `FlutterError.onError` plus `PlatformDispatcher.instance.onError` in `main()`, keine Zonen.

| Was geworfen hat | Handler, der es erhalten hat |
| --- | --- |
| Synchroner Throw in `onPressed` | `FlutterError.onError` (context: "while handling a gesture") |
| Throw in `build` | `FlutterError.onError` |
| Throw nach einem `await` in einem `async` `onPressed` | `PlatformDispatcher.instance.onError` |
| Nicht abgewartetes `Future.delayed(..., () => throw ...)` | `PlatformDispatcher.instance.onError` |
| `Timer`-Callback | `PlatformDispatcher.instance.onError` |
| `Stream.error(...).listen((_) {})` ohne `onError` | `PlatformDispatcher.instance.onError` |
| Nicht abgewartetes `MethodChannel.invokeMethod` auf einem fehlenden Kanal | `PlatformDispatcher.instance.onError` (`MissingPluginException`) |
| Nicht abgewartetes `Isolate.run(() => throw ...)` | `PlatformDispatcher.instance.onError` |
| `Isolate.spawn`-Einstiegspunkt, der wirft, ohne `onError`-Port | Keiner. Die Engine gab `Unhandled exception` aus `dart_isolate.cc` aus |
| Dasselbe, mit `onError: port.sendPort` | Der Listener des `RawReceivePort` |

`Isolate.run` landet im Dispatcher, weil es den Fehler des Kindes in das zurückgegebene `Future` im Root-Isolate erneut wirft, und dieses `Future` wurde nicht abgewartet. Ein rohes `Isolate.spawn` tut das nicht: Der Fehler stirbt mit dem Kind-Isolate. Der Doc-Kommentar der Engine zu `onError` sagt das ausdrücklich: Er "is not directly invoked by errors in child isolates of the root isolate."

## Die empfohlene main(), Schritt für Schritt

Dieses Setup fängt jede Zeile der Tabelle auf Android, iOS, macOS, Windows und Linux ab.

1. Rufen Sie zuerst `WidgetsFlutterBinding.ensureInitialized()` auf, wenn Sie vor `runApp` asynchrone Arbeit erledigen (Crash-Reporter initialisieren, Einstellungen lesen).
2. Weisen Sie `FlutterError.onError` zu. Rufen Sie darin `FlutterError.presentError(details)` auf, damit in Debug-Builds weiterhin die rote Fehlerbox und der Konsolen-Dump erscheinen, und leiten Sie dann `details.exception` und `details.stack` an Ihren Reporter weiter.
3. Weisen Sie `PlatformDispatcher.instance.onError` zu. Leiten Sie Fehler und Stack weiter und geben Sie `true` zurück.
4. Rufen Sie `runApp` auf.
5. Übergeben Sie für jedes Isolate, das Sie mit `Isolate.spawn` erzeugen, einen `onError`-Port und leiten Sie das Eingehende an denselben Reporter weiter.

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:isolate';
import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await ErrorReporter.instance.initialize();

  FlutterError.onError = (FlutterErrorDetails details) {
    FlutterError.presentError(details); // keep the debug console output
    ErrorReporter.instance.report(
      details.exception,
      details.stack ?? StackTrace.empty,
      fatal: false,
      context: details.context?.toDescription(),
    );
  };

  PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
    ErrorReporter.instance.report(error, stack, fatal: true);
    return true; // handled: do not print the default "Unhandled Exception"
  };

  runApp(const MyApp());
}

// For isolates you spawn yourself.
Future<Isolate> spawnReported<T>(void Function(T) entry, T message) {
  final errors = RawReceivePort((Object? pair) {
    final list = pair! as List<Object?>;
    ErrorReporter.instance.report(
      list[0]!,
      StackTrace.fromString(list[1]! as String),
      fatal: false,
    );
  });
  return Isolate.spawn(entry, message, onError: errors.sendPort);
}
```

Der `onError`-Port erhält eine Liste mit zwei Elementen: das `toString()` des Fehlers und den Stack Trace als String. An der Isolate-Grenze geht der ursprüngliche Exception-Typ verloren. Protokollieren Sie den String daher unverändert, statt ihn per `is` zu prüfen.

Wenn Sie Firebase Crashlytics verwenden, hat dessen dokumentiertes Setup dieselbe Form: `FlutterError.onError = FirebaseCrashlytics.instance.recordFlutterFatalError` und `PlatformDispatcher.instance.onError`, das `recordError(error, stack, fatal: true)` aufruft und `true` zurückgibt. Andere Crash-SDKs, darunter Sentry, installieren bei ihrer eigenen Initialisierung gleichwertige Handler. Überschreiben Sie diese daher nicht nachträglich, ohne den vorherigen Handler weiterzuverketten.

## Was der Rückgabewert von PlatformDispatcher.onError bewirkt

Der Rückgabetyp des Callbacks ist `bool`, und das ist wichtig. Die Engine dokumentiert es so: Geben Sie `true` zurück, wenn Sie den Fehler behandelt haben, andernfalls `false`, und "a fallback mechanism such as printing to stderr will be used". Ich habe den Fall des nicht abgewarteten `Future` mit einem Callback ausgeführt, der `false` zurückgibt. Der Callback lief, und danach gab die Engine zusätzlich `[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: Bad state: unawaited Future` mit vollständigem Stack aus. Mit `true` lief nur mein Handler.

In keinem der beiden Fälle wurde der Prozess beendet. Ein unbehandelter Dart-Fehler lässt eine Flutter-App nicht abstürzen: Die Event Loop macht mit dem nächsten Ereignis weiter. Das ist gut für die Benutzer, aber schlecht für die Sichtbarkeit, weil das einzige Symptom eine halb fertige Aktion ist. Wenn Sie eine Fail-fast-Strategie wollen, setzen Sie sie selbst im Handler um (zum Beispiel `if (kReleaseMode) exit(1);`, wie es die Flutter-Dokumentation für `FlutterError.onError` zeigt), und überlegen Sie gut, bevor Sie das ausliefern.

## runZonedGuarded: wann Sie es noch brauchen

Bevor Flutter 3.3 (August 2022) `PlatformDispatcher.onError` einführte, lautete der Standardrat, `runApp` in `runZonedGuarded` zu verpacken, damit jeder asynchrone Fehler von Code in dieser Zone dessen `onError`-Callback statt der Root-Zone erreicht. Das funktioniert weiterhin, und ich habe überprüft, dass es dieselben Zeilen abfängt wie der Dispatcher:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:async';

import 'package:flutter/material.dart';

void main() {
  runZonedGuarded(() {
    WidgetsFlutterBinding.ensureInitialized();
    FlutterError.onError = (details) {
      FlutterError.presentError(details);
      ErrorReporter.instance.report(details.exception, details.stack ?? StackTrace.empty);
    };
    runApp(const MyApp());
  }, (Object error, StackTrace stack) {
    ErrorReporter.instance.report(error, stack, fatal: true);
  });
}
```

Mit diesem Setup erreichten das nicht abgewartete `Future`, der Throw nach einem `await` in `onPressed` und das nicht abgewartete `Isolate.run` alle den Zonen-Callback. Der `build`-Fehler ging weiterhin an `FlutterError.onError`, weil das Framework ihn abfängt, bevor er zu einem Zonenfehler werden kann. Die Zone ersetzt also den Dispatcher, nicht `FlutterError.onError`.

Wenn Sie beides setzen (Dispatcher innerhalb der geschützten Zone zugewiesen), gewinnt die Zone. In meinem Durchlauf feuerte für das nicht abgewartete `Future` nur der `runZonedGuarded`-Callback, und `PlatformDispatcher.instance.onError` wurde nie aufgerufen, weil der Fehler behandelt war, bevor er die Root-Zone erreichte. Das ist harmlos, bedeutet aber, dass ein Crash-SDK, das sich auf den Dispatcher stützt, für Fehler innerhalb Ihrer Zone nichts sieht. Wählen Sie einen Mechanismus.

Es gibt drei Gründe, 2026 weiterhin eine Zone zu verwenden:

- **Flutter Web.** Die Web-Engine speichert den Callback und ruft ihn nie auf. Im Quellcode von 3.44.8 steht in `lib/web_ui/lib/src/engine/platform_dispatcher.dart` über dem Setter `// TODO(dnfield): make this work on web.`, und das Tracking-Issue [flutter/flutter#100277](https://github.com/flutter/flutter/issues/100277) ist weiterhin offen. Im Web ist `runZonedGuarded` der einzige Weg, asynchrone Fehler global abzufangen.
- **Zonenwerte.** Wenn Sie `zoneValues` nutzen (ein anfragebezogener Logger, eine Test-Uhr), forken Sie ohnehin eine Zone und können dort den Fehler-Handler ergänzen.
- **Begrenzte Behandlung.** Eine Zone kann ein einzelnes Teilsystem umschließen, zum Beispiel einen Sync-Job, sodass dessen Fehler getrennt vom Rest der App markiert und weitergeleitet werden.

Für eine plattformübergreifende App, die auch für das Web erscheint, sieht das pragmatische Setup so aus: den Dispatcher-Handler zuweisen (er deckt Mobilgeräte und Desktop ab) und den Rumpf von `main` nur dann in `runZonedGuarded` verpacken, wenn `kIsWeb` wahr ist. Lassen Sie beide Callbacks auf denselben Reporter zeigen.

## Die Warnung "Zone mismatch"

Seit Flutter 3.10 prüfen Debug-Builds, ob das Binding in derselben Zone initialisiert wurde, die später `runApp` aufruft. Das ist die verbreitete fehlerhafte Variante:

```dart
// Flutter 3.44.8: triggers "Zone mismatch" in debug builds
void main() {
  WidgetsFlutterBinding.ensureInitialized(); // root zone
  runZonedGuarded(() => runApp(const MyApp()), reportError); // child zone
}
```

Mein Debug-Build meldete sie über `FlutterError.onError` mit dem Kontext "during runApp":

```text
Zone mismatch.
The Flutter bindings were initialized in a different zone than is now being used.
```

Es ist eine Warnung, kein Absturz, und in meinem Durchlauf erreichte das nicht abgewartete `Future` weiterhin den Zonen-Callback, weil `initState` innerhalb der Zone von `runApp` lief. Gefährlich sind die Callbacks, die das Binding bei der Engine registriert hat, während es in der Root-Zone war: Pointer-Ereignisse, Plattformnachrichten und Frame-Callbacks werden in der Zone aufgerufen, die bei ihrer Registrierung aktuell war. Fehler aus diesen Pfaden können Ihre geschützte Zone umgehen, genau die Inkonsistenz, die die Warnung beschreibt. Die Lösung ist, `ensureInitialized()` (und jedes `await`, das es braucht) in den Rumpf von `runZonedGuarded` zu verlegen, wie im vorigen Abschnitt. Setzen Sie `BindingBase.debugZoneErrorsAreFatal = true` als erste Anweisung von `main`, wenn die CI daran fehlschlagen soll.

## Fallstricke, die Fehler trotzdem verbergen

- **`catchError`, das nichts zurückgibt.** `future.catchError((e) => log(e))` auf einem `Future<int>` wirft in Dart 3 zur Laufzeit einen `ArgumentError`, weil der Handler einen Wert vom Typ des Futures zurückgeben muss. Verwenden Sie stattdessen `try`/`await`/`catch`.
- **`unawaited()` verbirgt Absicht, nicht Fehler.** Ein Aufruf in `unawaited(...)` bringt die Lint-Regel `unawaited_futures` zum Schweigen, aber der Fehler geht weiterhin an den Dispatcher. Das ist meist gewünscht, sollte aber nicht als Fehlerbehandlung gelten.
- **Eine `StreamSubscription` ohne `onError`.** Jedes Fehlerereignis auf einem solchen Abonnement wird als unbehandelt gemeldet. Bei einem langlebigen Stream, der wiederholt Fehler liefert, erhält Ihr Reporter pro Ereignis eine Meldung. Fügen Sie `onError` zu Abonnements hinzu, die Ihnen gehören, und brechen Sie sie ab, wie in [der Anleitung zum Abbrechen einer StreamSubscription in dispose](/de/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/) beschrieben.
- **Native Abstürze.** Ein Segfault im Kotlin-, Swift- oder C-Code eines Plugins erreicht Dart nie. Dafür brauchen Sie den nativen Teil Ihres Crash-SDKs.
- **`flutter test`.** Das Test-Framework führt jeden Test in einer eigenen Zone aus und lässt den Test bei jedem unbehandelten Fehler fehlschlagen, daher werden in `main()` gesetzte Handler von Widget-Tests nicht ausgeführt. Testen Sie Ihr Reporting, indem Sie die Handler-Funktionen direkt aufrufen.
- **Reihenfolge der Handler mit SDKs.** Wenn ein SDK `FlutterError.onError` setzt und Sie es danach erneut zuweisen, ersetzen Sie es stillschweigend. Speichern Sie den vorherigen Wert (`final previous = FlutterError.onError;`) und rufen Sie ihn aus Ihrem Handler auf.

## Verwandte Artikel

- [How to handle network errors gracefully in a Flutter app](/de/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) behandelt das Abfangen von Fehlern dort, wo sie entstehen, was immer besser ist, als sich auf den globalen Handler zu verlassen.
- [How to write a Dart isolate for CPU-bound work](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) erklärt `Isolate.run` im Vergleich zu `Isolate.spawn`, was entscheidet, ob der Fehler eines Isolates überhaupt das Root-Isolate erreicht.
- [What is the difference between a Dart isolate and a thread](/de/2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread/) erklärt, warum Fehler eine Isolate-Grenze nicht als Objekte überqueren können.
- [How to use BuildContext safely after an await in Flutter](/de/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) behandelt den anderen klassischen Fehler in `async`-Button-Handlern.

## Quellen

- Flutter docs: [Handling errors in Flutter](https://docs.flutter.dev/testing/errors)
- Flutter docs: [Zone mismatch message](https://docs.flutter.dev/release/breaking-changes/zone-errors) und [flutter/flutter#122836](https://github.com/flutter/flutter/pull/122836)
- API reference: [PlatformDispatcher.onError](https://api.flutter.dev/flutter/dart-ui/PlatformDispatcher/onError.html), [FlutterError.onError](https://api.flutter.dev/flutter/foundation/FlutterError/onError.html), [runZonedGuarded](https://api.dart.dev/stable/dart-async/runZonedGuarded.html), [Isolate.spawn](https://api.dart.dev/stable/dart-isolate/Isolate/spawn.html)
- Issue: [Implement PlatformDispatcher.onError for web (flutter/flutter#100277)](https://github.com/flutter/flutter/issues/100277)
- Firebase: [Customize your Crashlytics crash reports (Flutter)](https://firebase.google.com/docs/crashlytics/flutter/customize-crash-reports)
