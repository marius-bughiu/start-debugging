---
title: "Fix: Riverpod 3.0 wirft ProviderException statt des ursprünglichen Fehlers"
description: "Riverpod 3.0 verpackt Fehler, die beim Lesen eines Providers auftreten, in eine ProviderException. Fangen Sie diesen Typ ab und lesen Sie e.exception, um Ihren ursprünglichen Fehler zurückzubekommen, oder verwenden Sie AsyncValue.error, das nicht verpackt ist."
pubDate: 2026-07-06
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "de"
translationOf: "2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error"
translatedBy: "claude"
translationDate: 2026-07-06
---

Ihr `on NotFoundException catch` löste nach dem Upgrade auf Riverpod 3.0 nicht mehr aus, weil das Lesen eines fehlgeschlagenen Providers Ihre ursprüngliche Exception nicht mehr erneut wirft. Es wirft eine `ProviderException`, die diese umschließt. Um ein defektes `try`/`catch` zu reparieren, fangen Sie `ProviderException` ab und prüfen `e.exception` auf Ihren echten Fehler, oder wechseln Sie zu `AsyncValue.error`, das bewusst nicht verpackt bleibt. Dies wurde mit `flutter_riverpod` 3.x getestet (die 3.0-Reihe erschien im September 2025; die aktuelle Version ist 3.3.2, Juni 2026), Flutter 3.44 und Dart 3.x.

Das Upgrade hat keinen neuen Fehler eingeführt. Ihr Provider wirft weiterhin dieselbe Exception wie immer. Was sich geändert hat, ist der Typ, der auf der anderen Seite herauskommt, wenn ein anderer Teil des Codes diesen Provider imperativ liest.

## Der Fehler im Kontext

Sie haben einen Provider, dessen `build` eine Domänen-Exception wirft, und einen Aufrufer, der ihn innerhalb eines `try`/`catch` liest:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
try {
  final user = await ref.read(userProvider.future);
  showProfile(user);
} on NotFoundException catch (e) {
  showNotFound(e.id); // never runs on Riverpod 3.0
}
```

Unter Riverpod 2.x fing dies `NotFoundException` direkt ab. Unter 3.0 wird die `on NotFoundException`-Klausel übersprungen, und wenn Sie kein umfassenderes `catch` haben, propagiert die Exception ungefangen. Wenn Sie den tatsächlichen Laufzeittyp protokollieren, sehen Sie:

```
Unhandled exception:
ProviderException: An exception/error was thrown while building UserProvider.
  <original NotFoundException and its stack trace nested here>
```

Die `NotFoundException` steckt weiterhin darin. Sie ist jetzt ein Passagier in der `ProviderException`, statt das Objekt zu sein, das geworfen wird.

## Warum Riverpod 3.0 den Fehler verpackt

Ein Provider kann sich aus zwei sehr unterschiedlichen Gründen in einem Fehlerzustand befinden, und Riverpod 2.x konnte sie an der Stelle, an der Sie den Fehler abfingen, nicht unterscheiden.

Der erste Grund: **dieser Provider ist fehlgeschlagen**. Sein eigenes `build` hat geworfen. Der zweite Grund: **dieser Provider ist in Ordnung, aber ein Provider, von dem er abhängt, ist fehlgeschlagen**, und der Fehler propagierte im Graphen nach unten. In einer Abhängigkeitskette wie `dashboardProvider`, der `userProvider` beobachtet, der `authProvider` beobachtet, taucht eine Exception in `authProvider` bei jedem nachgelagerten Lesevorgang auf. Wenn alle drei die rohe `AuthException` erneut würfen, könnte ein `catch` um `dashboardProvider` nicht zwischen "das Dashboard selbst ist kaputt" und "etwas drei Ebenen darüber ist kaputt und ich sehe das Echo" unterscheiden.

Riverpod 3.0 löst dies durch Verpacken. Wenn Sie einen Provider lesen, dessen Wert nicht berechnet werden konnte, wird der Fehler in eine `ProviderException` eingeschlossen, die festhält, **welcher Provider** geworfen hat, und den ursprünglichen Fehler samt seinem Stack Trace mitträgt. Der Wrapper ist das Signal dafür, dass Sie ein propagiertes Provider-Versagen betrachten, und die `.exception`-Eigenschaft ist die Notausstiegsluke zurück zu Ihrem echten Fehler. Dieses Verhalten ist im [Riverpod-3.0-Migrationsleitfaden](https://riverpod.dev/docs/3.0_migration) beschrieben und in [Riverpod-Issue 4320](https://github.com/rrousselGit/riverpod/issues/4320) nachverfolgt.

Es gibt hier ein kleines Stück Geschichte, das man kennen sollte. Frühes Riverpod (vor 2.0) verpackte ebenfalls in `ProviderException`, dann entfernte `2.0.0-dev.1` das Verpacken und wechselte dazu, die rohe Exception erneut zu werfen, und `3.0.0-dev.16` brachte den Wrapper bewusst zurück. Wenn Sie sich erinnern, dass `ProviderException` vor Jahren verschwand, erinnern Sie sich nicht falsch; 3.0 hat sie absichtlich wieder eingeführt.

## Minimale Reproduktion

Zwei Dateien. Ein Provider, der wirft, und ein Widget, das ihn imperativ liest.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- reproduces the wrap.
import 'package:flutter_riverpod/flutter_riverpod.dart';

class NotFoundException implements Exception {
  const NotFoundException(this.id);
  final String id;
}

final userProvider = FutureProvider.autoDispose<User>((ref) async {
  final user = await ref.read(apiProvider).findUser('42');
  if (user == null) throw const NotFoundException('42');
  return user;
});
```

```dart
// The caller. On 2.x this printed "not found: 42".
// On 3.0 nothing prints and the ProviderException escapes.
Future<void> load(WidgetRef ref) async {
  try {
    await ref.read(userProvider.future);
  } on NotFoundException catch (e) {
    debugPrint('not found: ${e.id}');
  }
}
```

Führen Sie `load` aus, wenn der Benutzer fehlt. Unter 3.0 passt die `on NotFoundException`-Klausel nicht, weil das geworfene Objekt eine `ProviderException` ist, keine `NotFoundException`.

## Der Fix im Detail

Wählen Sie den Ansatz, der dazu passt, wie Sie den Provider konsumieren. In der Reihenfolge der Präferenz:

### 1. ProviderException abfangen und auf e.exception verzweigen

Wenn Sie den Provider imperativ lesen müssen (innerhalb eines Event-Handlers, einer Mutation, eines `ref.read` in einem Callback), fangen Sie den Wrapper ab und ziehen Sie den ursprünglichen Fehler aus `.exception`:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- the direct fix.
Future<void> load(WidgetRef ref) async {
  try {
    await ref.read(userProvider.future);
  } on ProviderException catch (e) {
    switch (e.exception) {
      case NotFoundException(:final id):
        debugPrint('not found: $id');
      case SocketException():
        debugPrint('offline');
      default:
        rethrow; // do not swallow errors you did not plan for
    }
  }
}
```

`e.exception` ist das ursprüngliche Objekt, das Sie geworfen haben, sodass ein Dart-Pattern-`switch` darauf sauber lesbar ist und Ihnen erlaubt, Felder (`:final id`) in derselben Zeile zu binden. Behalten Sie immer ein `default: rethrow`, damit ein unerwarteter Fehler nicht stillschweigend verschluckt wird; ein nacktes `on ProviderException catch` ohne rethrow verschluckt jeden zukünftigen Fehlertyp, den Sie zu enumerieren vergessen.

Wenn Sie `is`-Prüfungen gegenüber Patterns bevorzugen, ist das Äquivalent:

```dart
} on ProviderException catch (e) {
  if (e.exception is NotFoundException) {
    final id = (e.exception as NotFoundException).id;
    debugPrint('not found: $id');
  } else {
    rethrow;
  }
}
```

### 2. Den Fehler über AsyncValue lesen, das nicht verpackt ist

Dies ist der bessere Fix, wenn der Code in einem Widget liegt, weil es auch die idiomatische Riverpod-Form ist. `AsyncValue.error` trägt Ihre **ursprüngliche** Exception, nicht den Wrapper. Das Verpacken passiert nur auf dem imperativen rethrow-Pfad (`ref.read`/`ref.watch`, die werfen); der reaktive `AsyncValue`, den Sie durch das Beobachten eines Providers erhalten, bleibt unangetastet:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- no ProviderException here.
class UserView extends ConsumerWidget {
  const UserView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(userProvider);
    return switch (async) {
      AsyncData(:final value) => ProfileCard(value),
      AsyncError(:final error) when error is NotFoundException =>
        NotFoundCard(error.id), // error is the raw NotFoundException
      AsyncError(:final error) => ErrorCard('$error'),
      _ => const CircularProgressIndicator(),
    };
  }
}
```

Beachten Sie, dass `error is NotFoundException` direkt passt. Kein Auspacken, weil `AsyncValue.error` von vornherein nie eine `ProviderException` enthielt. Wenn Sie ohnehin Lade- und Fehler-UI rendern, ziehen Sie dies einem imperativen `try`/`catch` vor; dasselbe Muster liegt dem [Anzeigen von Lade- und Fehlerzuständen mit AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) zugrunde.

### 3. Den Fehler im onError von ref.listen behandeln, ebenfalls nicht verpackt

Für Seiteneffekte (eine Snackbar, eine Navigation, Analytics), die durch ein fehlgeschlagenes Provider ausgelöst werden, empfängt der `onError`-Callback von `ref.listen` den rohen Fehler ebenfalls:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
ref.listen<AsyncValue<User>>(userProvider, (prev, next) {}, onError: (error, stack) {
  // error is the original NotFoundException, not a ProviderException.
  if (error is NotFoundException) showSnack('User ${error.id} is gone');
});
```

## Welche APIs verpacken und welche nicht

Die eine nützlichste Tabelle, die man im Kopf behalten sollte. Der Wrapper erscheint nur, wenn ein Provider imperativ in Ihren Code **erneut wirft**.

Verpackt in `ProviderException` (lesen Sie `.exception`):

- `ref.read(p.future)`, wobei `p` beim Bauen fehlgeschlagen ist.
- `ref.watch(p)` auf einem synchronen Provider, der geworfen hat, wenn der Lesevorgang erneut wirft.
- `await container.read(p.future)` in Tests.

Nicht verpackt (Sie erhalten den ursprünglichen Fehler direkt):

- `AsyncValue.error` von `ref.watch(asyncProvider)`. Prüfen Sie `value.error is MyException`.
- `ref.listen(p, ..., onError: (e, s) => ...)`. Das `e` ist roh.
- `ProviderObserver.providerDidFail` (und die Observer-Hooks im Allgemeinen). Observer sehen den unveränderten Fehler und Stack.

Wenn Ihre Behandlung im build eines Widgets über `AsyncValue`, in einem Listener oder in einem Observer lebt, müssen Sie wahrscheinlich nichts ändern. Der Migrationsschmerz konzentriert sich auf imperative `try`/`catch` um `ref.read(...future)`.

## Fallstricke und Versionsfallen

**Sie können ProviderException auf einigen frühen 3.0-Builds nicht importieren.** [Issue 4320](https://github.com/rrousselGit/riverpod/issues/4320) dokumentiert ein Zeitfenster, in dem die Dokumentation das Verpacken beschrieb, ein Build aber einen `StateError` warf und `ProviderException` noch nicht exportiert war. Wenn `on ProviderException` nicht kompiliert oder Sie stattdessen `StateError` abfangen, sind Sie auf einer betroffenen Vorabversion. Aktualisieren Sie auf ein aktuelles Stable (`flutter_riverpod` 3.3.2 oder neuer), wo der Typ exportiert ist und das Verhalten mit der Dokumentation übereinstimmt. Schreiben Sie kein dauerhaftes `on StateError` catch, um es zu umgehen; das bricht erneut, wenn Sie aktualisieren.

**Verpacken Sie nicht doppelt in Ihrem eigenen Fehler-Mapping.** Wenn Sie einen Interceptor haben, der alles abfängt und eine normalisierte `AppException` erneut wirft, stellen Sie sicher, dass er `ProviderException` zuerst auspackt, sonst verschachteln Sie beim nächsten Lesevorgang eine `ProviderException` innerhalb Ihrer `AppException` innerhalb einer weiteren `ProviderException`. Packen Sie an der Grenze aus: `final real = e is ProviderException ? e.exception : e;`.

**Retry ignoriert den Wrapper.** Der automatische Retry von Riverpod 3.0 (exponentielles Backoff, 200 ms verdoppeln bis zu einer Obergrenze von 6,4 s) wiederholt echte Provider-Build-Fehler, wiederholt aber keine `ProviderException`, die lediglich von einer Abhängigkeit propagiert wurde, was verhindert, dass ein fehlschlagendes Blatt-Provider einen Retry-Sturm über jeden nachgelagerten Provider auslöst. Sie konfigurieren dies nicht; wissen Sie einfach, dass eine gefangene und erneut geworfene `ProviderException` als "bereits berücksichtigt" behandelt wird.

**Der Wrapper ist kein Schutz für Async-Gaps.** Das Abfangen von `ProviderException` behandelt das *Fehlschlagen* des Providers; es tut nichts gegen den Provider, der mitten im await *entsorgt* wird. Das sind separate Abstürze. Wenn Sie nach einem await zusätzlich `UnmountedRefException` sehen, ist das das [ref.mounted-Problem](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/), nicht dieses, und es braucht einen `if (!ref.mounted) return;`-Schutz statt eines catch.

**`rethrow` innerhalb von `on ProviderException` wirft den Wrapper erneut, nicht den inneren Fehler.** Wenn Ihr `default`-Zweig ein `rethrow` ausführt, sieht der Aufrufer weiter oben im Stack weiterhin eine `ProviderException`. Das ist normalerweise das, was Sie wollen (die Herkunft bleibt erhalten), aber wenn eine äußere Schicht rohe Domänen-Exceptions erwartet, werfen Sie die innere explizit erneut: `Error.throwWithStackTrace(e.exception, e.stackTrace)`.

## Wo dies in einem Upgrade von 2.x auf 3.0 hineinpasst

Dies ist ein Einzelposten der größeren 3.0-Migration, neben der `Ref.mounted`-Lebenszyklusänderung und dem Wechsel zu vereinheitlichten `Notifier`-Klassen. Wenn Sie das Upgrade jetzt durchführen, durchsuchen Sie Ihre Codebasis mit grep nach `ref.read(`-Aufrufen, die in `try` mit einem typisierten `on SomeException catch` eingeschlossen sind, und nach `.future`-Lesevorgängen innerhalb von `catch`-Blöcken. Das sind die Aufrufstellen, die stillschweigend aufhörten zu passen. Widget-Code, der `AsyncValue` rendert, ist sicher. Für das umfassendere Bild, warum Notifier-eigener Lebenszyklus und Fehlersemantik der moderne Standard sind, siehe [Provider vs. Riverpod vs. Bloc im Jahr 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/), und wenn Sie noch auf dem älteren `provider`-Paket sind, deckt die [Migration von provider zu Riverpod](/2026/06/migrate-from-provider-to-riverpod-in-flutter/) den Wechsel ab, bevor Sie auf all dies stoßen.

Das mentale Modell, das es geradlinig hält: Eine `ProviderException` bedeutet "ein Provider im Graphen ist fehlgeschlagen und Sie haben ihn imperativ gelesen." Greifen Sie in `.exception` nach der echten Ursache, oder, besser, konsumieren Sie das Versagen reaktiv über `AsyncValue`, wo überhaupt kein Verpacken passiert. Dieselbe Disziplin, die [Netzwerkfehler elegant behandelt](/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) hält, gilt auch hier: Entscheiden Sie pro Aufrufstelle, ob Sie auf einen Wert reagieren oder auf ein geworfenes Versagen, und wählen Sie die API, die Ihnen den Fehler in der Form übergibt, die Sie erwarten.

## Verwandt

- [Wie man Ref.mounted nach einem Async-Gap in Flutter Riverpod 3 prüft](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/) ist der andere Riverpod-3.0-Fehler, der erst nach dem Upgrade auftaucht, auf dem Async-Gap-Pfad statt dem Wurf-Pfad.
- [Wie man Lade- und Fehlerzustände mit AsyncValue in Flutter Riverpod anzeigt](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) ist die reaktive Alternative zu imperativem try/catch, und es ist vom Verpacken nicht betroffen.
- [Fix: Cannot use "ref" after the widget was disposed in Flutter Riverpod](/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/) ist ein anderer Riverpod-Absturz, den Leute mit diesem verwechseln.
- [Provider vs. Riverpod vs. Bloc für Flutter-State-Management im Jahr 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) behandelt, warum Riverpods Fehler- und Lebenszyklusmodell der aktuelle Standard ist.
- [Migration von provider zu Riverpod in Flutter](/2026/06/migrate-from-provider-to-riverpod-in-flutter/) ist der Schritt vor diesem, wenn Sie noch auf dem alten Paket sind.

## Quellen

- [Migrating from 2.0 to 3.0](https://riverpod.dev/docs/3.0_migration) -- die offizielle Aussage, dass Provider-Lesefehler als `ProviderException` erneut geworfen werden, und das `e.exception`-catch-Muster.
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- die Begründung für das Verpacken (Unterscheidung zwischen einem fehlschlagenden Provider und der Abhängigkeit von einem fehlgeschlagenen Provider), plus das Retry-Verhalten, das `ProviderException` ignoriert.
- [rrousselGit/riverpod issue 4320](https://github.com/rrousselGit/riverpod/issues/4320) -- die frühe-3.0-Diskrepanz, bei der ein `StateError` geworfen wurde und `ProviderException` nicht importiert werden konnte.
- [riverpod package changelog](https://pub.dev/packages/riverpod/changelog) -- die Geschichte: `2.0.0-dev.1` entfernte den Wrapper, `3.0.0-dev.16` führte ihn wieder ein; aktuelles Stable 3.3.2 (Juni 2026).
