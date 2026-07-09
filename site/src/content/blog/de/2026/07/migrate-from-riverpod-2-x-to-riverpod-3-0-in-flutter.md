---
title: "Von Riverpod 2.x auf Riverpod 3.0 in Flutter migrieren"
description: "Ein Schritt-für-Schritt-Upgrade von flutter_riverpod 2.x auf 3.x: die Pakete anheben, StateProvider und Verwandte auf den Legacy-Import umziehen, die AutoDispose- und Family-Ref-Typen loswerden, ProviderException-Wrapping und automatische Wiederholung handhaben und das ==-Benachrichtigungsfiltern beheben, das StreamProvider-Events stillschweigend verwirft. Getestet mit Flutter 3.44, Dart 3.x, flutter_riverpod 3.3.2."
pubDate: 2026-07-09
updatedDate: 2026-07-09
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "de"
translationOf: "2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-09
---

Eine echte App von `flutter_riverpod` 2.x auf 3.x zu aktualisieren ist üblicherweise eine Aufgabe für einen halben Tag, und das meiste davon ist mechanisches Suchen und Ersetzen. Die 3.0-Linie erschien im September 2025, und die aktuelle Version ist 3.3.2 (Juni 2026); dieser Leitfaden ist mit dieser Version unter Flutter 3.44 (stabil, Mai 2026) und Dart 3.x getestet. Was tatsächlich bricht: `StateProvider`, `StateNotifierProvider` und `ChangeNotifierProvider` ziehen hinter einen `legacy.dart`-Import um, jeder `Ref`-Subtyp (`FutureProviderRef`, `AutoDisposeNotifier`, `FamilyNotifier`) kollabiert in einen einzigen Typ, Provider-Fehler kommen jetzt in einer `ProviderException` gewrappt heraus, und Provider filtern Benachrichtigungen jetzt mit `==`. Die letzten beiden sind diejenigen, die eher Laufzeitüberraschungen als Kompilierfehler verursachen, also lesen Sie diese Abschnitte aufmerksam. Wenn Ihre Codebasis bereits Codegenerierung (`@riverpod`) verwendet, haben Sie weniger zu ändern, als wenn Sie Provider-Deklarationen von Hand geschrieben haben.

## Warum überhaupt aktualisieren

Riverpod 2.x funktioniert weiterhin, also muss das Argument für einen Umstieg konkret sein:

- **Automatische Wiederholung** mit exponentiellem Backoff ist eingebaut. Ein `FutureProvider`, der bei einem instabilen Netzwerk fehlschlägt, bleibt nicht mehr fehlgeschlagen, bis Sie ihn manuell mit `ref.invalidate` zurücksetzen.
- **`Ref.mounted`** ersetzt das selbstgebaute "lebt dieser Provider nach dem await noch"-Mixin, das jede nicht-triviale App früher mitschleppen musste. Siehe [Ref.mounted nach einer async-Lücke prüfen](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/) für das vollständige Muster.
- **Ein einheitlicher `Ref`-Typ** und ein `Notifier` pro Form. Keine `AutoDisposeFamilyAsyncNotifier`-Typnamen mehr, die sich wie ein Compiler-Belastungstest lesen.
- **Offline-Persistenz** und **Mutationen** kommen als experimentelle APIs, sodass Formular-Übermittlungszustand und Cache-über-Neustart hinweg nicht mehr etwas sind, das Sie von Hand bauen.

## Was bricht

| Bereich                     | Änderung                                                                            | Schweregrad |
| --------------------------- | ----------------------------------------------------------------------------------- | -------- |
| Legacy-Provider             | `StateProvider`, `StateNotifierProvider`, `ChangeNotifierProvider` benötigen `legacy.dart` | hoch     |
| Ref-Subtypen                | `FutureProviderRef`, `StreamProviderRef` usw. werden alle zu einem einzigen `Ref`   | hoch     |
| AutoDispose- / Family-Typen | `AutoDisposeNotifier`, `FamilyNotifier` entfernt; Modifier auf `Notifier` verwenden | hoch     |
| Fehlerweitergabe            | Reads werfen `ProviderException` erneut, die Ihren ursprünglichen Fehler wrappt      | hoch     |
| Benachrichtigungsfilterung  | Alle Provider verwenden `==`, um zu entscheiden, ob Listener benachrichtigt werden   | mittel   |
| Automatische Wiederholung   | Fehlgeschlagene Provider wiederholen standardmäßig mit Backoff                       | mittel   |
| `ProviderObserver`          | Callbacks nehmen einen einzigen `ProviderObserverContext`                            | mittel   |
| `AsyncValue.valueOrNull`    | Umbenannt in `value`; der alte werfende `value`-Getter ist weg                       | niedrig  |

## Pre-Flight-Checkliste

Bevor Sie einen einzigen Provider anfassen:

1. Committen oder stashen Sie alles. Diese Migration berührt viele Dateien, und Sie wollen ein sauberes `git diff` zum Prüfen.
2. Bestätigen Sie, dass Ihr Dart SDK 3.x ist. Riverpod 3.0 erfordert es. Führen Sie `dart --version` aus und prüfen Sie.
3. Wenn Sie Codegenerierung verwenden, stellen Sie sicher, dass `build_runner` zuerst auf dem aktuellen 2.x-Code sauber läuft. Sie wollen nicht Generator-Fehler und Migrationsfehler gleichzeitig debuggen.
4. Notieren Sie, ob Sie `riverpod_lint` verwenden. Es liefert Lint-Regeln und einen `dart fix`-Migrationshelfer, der mehrere der folgenden Schritte automatisiert, sodass eine Installation manuelle Bearbeitungen spart.

## Schritt 1: Die Pakete anheben

Aktualisieren Sie jedes Riverpod-Paket in `pubspec.yaml` in einem Zug auf die 3.x-Linie. Ein 2.x- und ein 3.x-Paket zu mischen wird nicht auflösen.

```yaml
# pubspec.yaml -- flutter_riverpod 3.3.2, Dart 3.x
dependencies:
  flutter_riverpod: ^3.3.2
  riverpod_annotation: ^3.3.2   # only if you use code-generation

dev_dependencies:
  riverpod_generator: ^3.3.2    # only if you use code-generation
  riverpod_lint: ^3.3.2
  custom_lint: ^0.8.0
  build_runner: ^2.4.0
```

Dann auflösen:

```bash
# Flutter 3.44
flutter pub get
```

**Prüfen:** `flutter pub deps | grep riverpod` zeigt jedes Riverpod-Paket auf einer 3.x-Version. Wenn pub über einen Versionskonflikt klagt, pinnt eine transitive Abhängigkeit noch `riverpod` 2.x; führen Sie `flutter pub deps` aus, um den Übeltäter zu finden.

## Schritt 2: Zuerst die automatisierten Fixes ausführen

Riverpod 3.0 liefert `dart fix`-Migrationsregeln über `riverpod_lint`. Führen Sie sie aus, bevor Sie etwas von Hand tun, denn sie erledigen die mühsamen mechanischen Umschreibungen (die `Ref`-Subtyp-Umbenennungen, das Entfernen des `AutoDispose`-Präfixes) über jede Datei auf einmal.

```bash
# preview the changes without writing them
dart fix --dry-run

# apply them
dart fix --apply
```

**Prüfen:** Führen Sie `dart fix --dry-run` erneut aus und bestätigen Sie, dass die Riverpod-spezifischen Fixes aus der Liste verschwunden sind. Dann `git diff` und lesen Sie, was es geändert hat. Das Werkzeug ist gut, aber nicht allwissend, also sind die verbleibenden Schritte die Teile, die es nicht ableiten kann.

## Schritt 3: Legacy-Provider hinter den Legacy-Import verschieben

`StateProvider`, `StateNotifierProvider` und `ChangeNotifierProvider` existieren weiterhin, aber sie leben jetzt in einer separaten Bibliothek, sodass die Haupt-Import-Oberfläche nur die moderne API freilegt. Wenn Sie sie aus dem Hauptpaket importieren, erhalten Sie einen "undefined name"-Fehler.

```dart
// Riverpod 3.x
// Add this import wherever you still use the legacy providers:
import 'package:flutter_riverpod/legacy.dart';

// StateProvider itself is unchanged in behaviour:
final counterProvider = StateProvider<int>((ref) => 0);
```

Das ist ein bewusster Anstoß, keine Deprecation-Warnung, die Sie für immer ignorieren können. Der langfristige Schritt ist, jeden `StateProvider` als `Notifier` und jeden `StateNotifierProvider` als `Notifier` oder `AsyncNotifier` umzuschreiben, dieselbe Zielform, auf der Sie beim [Migrieren vom provider-Paket](/2026/06/migrate-from-provider-to-riverpod-in-flutter/) landen würden. Aber Sie müssen diese Umschreibung nicht während der Versionsanhebung erledigen. Fügen Sie den Import hinzu, werden Sie grün, und konvertieren Sie später.

**Prüfen:** Die App kompiliert. Greppen Sie nach `legacy.dart` und bestätigen Sie, dass jede Datei, die einen Legacy-Provider verwendet, den Import hat, und keine Datei ihn ohne Bedarf importiert (der Linter markiert den ungenutzten Import).

## Schritt 4: Die Ref-Subtypen und Notifier-Varianten kollabieren

In 2.x übergab Ihnen ein codegenerierter Provider eine typisierte Ref wie `CounterRef`, und handgeschriebene Provider verwendeten `FutureProviderRef<T>`, `StreamProviderRef<T>` und so weiter. In 3.0 gibt es einen einzigen `Ref`. Der `dart fix`-Durchlauf erledigt das üblicherweise, aber handgeschriebene Deklarationen, die das Werkzeug übersprungen hat, müssen bearbeitet werden.

```dart
// Riverpod 2.x
int example(ExampleRef ref) => 0;

Future<User> user(UserRef ref) async => fetchUser();
```

```dart
// Riverpod 3.x -- one Ref type for everything
int example(Ref ref) => 0;

Future<User> user(Ref ref) async => fetchUser();
```

Dieselbe Vereinheitlichung trifft die klassenbasierten Notifier. `AutoDisposeNotifier`, `FamilyNotifier` und die kombinatorische Explosion an Namen dazwischen sind weg. Sie drücken dasselbe Verhalten mit Modifiern auf dem Basis-`Notifier` aus:

```dart
// Riverpod 2.x
class TodosNotifier extends AutoDisposeAsyncNotifier<List<Todo>> {
  @override
  Future<List<Todo>> build() => fetchTodos();
}
final todosProvider =
    AutoDisposeAsyncNotifierProvider<TodosNotifier, List<Todo>>(
  TodosNotifier.new,
);
```

```dart
// Riverpod 3.x -- autoDispose is a modifier, not a base class
class TodosNotifier extends AsyncNotifier<List<Todo>> {
  @override
  Future<List<Todo>> build() => fetchTodos();
}
final todosProvider =
    AsyncNotifierProvider.autoDispose<TodosNotifier, List<Todo>>(
  TodosNotifier.new,
);
```

Family-Parameter, die früher in `FamilyNotifier` lebten, kommen jetzt als reguläre `build`-Argumente (Codegen) oder über den `.family`-Modifier (manuell) an. Wenn Sie `@riverpod` verwenden, übernimmt der Generator die Verdrahtung, und Sie führen ihn nur erneut aus.

**Prüfen (Codegen-Nutzer):** Löschen Sie die generierten Dateien und kompilieren Sie neu.

```bash
dart run build_runner build --delete-conflicting-outputs
```

Bestätigen Sie null Generator-Fehler und dass die neu generierten `.g.dart`-Dateien `Ref` referenzieren, nicht die alten typisierten Refs.

## Schritt 5: ProviderException-Wrapping handhaben

Das ist die Änderung, die am ehesten an einer Kompilierprüfung vorbeirutscht und zur Laufzeit bricht. In 3.0, wenn das `build` eines Providers wirft und ein anderes Stück Code ihn imperativ liest, wirft der Read nicht Ihre ursprüngliche Exception erneut. Er wirft eine `ProviderException`, die sie wrappt. Jeder `on MyException catch`-Block, der den ursprünglichen Typ abfing, feuert nicht mehr.

```dart
// Riverpod 2.x -- this used to work
try {
  final user = await ref.read(userProvider.future);
} on NotFoundException catch (e) {
  showNotFound();
}
```

```dart
// Riverpod 3.x -- catch the wrapper, inspect .exception
try {
  final user = await ref.read(userProvider.future);
} on ProviderException catch (e) {
  if (e.exception is NotFoundException) {
    showNotFound();
  } else {
    rethrow;
  }
}
```

Der ungewrappte Pfad ist `AsyncValue`. Wenn Sie einen Provider mit `.when(error: ...)` rendern oder gegen einen `AsyncError` matchen, ist der Fehler, den Sie dort erhalten, Ihre ursprüngliche Exception, nicht der Wrapper. Also ist UI-Code, der Zustand reaktiv liest, unbetroffen; nur imperatives `ref.read(...future)` innerhalb eines `try`/`catch` benötigt die Änderung. Der spezielle Beitrag zu [Riverpods 3.0 ProviderException](/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/) behandelt die Randfälle.

**Prüfen:** Greppen Sie nach `ref.read(` kombiniert mit `.future` innerhalb von `try`-Blöcken und nach jeder `catch`-Klausel, die eine Domänen-Exception benennt. Fügen Sie einen Test hinzu, der einen Provider werfen lässt und bestätigt, dass Ihr Handler noch läuft.

## Schritt 6: Das ==-Benachrichtigungsfiltern beheben

In 2.x hatten verschiedene Provider-Typen unterschiedliche Regeln, um zu entscheiden, wann Listener benachrichtigt werden. In 3.0 verwenden sie alle `==`. Für `Notifier`-Zustand ist das üblicherweise in Ordnung, aber es beißt hart bei `StreamProvider` und `StreamNotifier`: Wenn Ihr Stream Objekte emittiert, die per `==` gleich sind (zum Beispiel veränderliche Klassen, die Gleichheit nicht überschreiben, oder zwei Werte, die zufällig gleich vergleichen), wird die zweite Emission jetzt als Duplikat verworfen.

Der Fehlermodus ist eine UI, die aufhört zu aktualisieren, obwohl der Stream eindeutig emittiert. Der Fix ist, sicherzustellen, dass der emittierte Typ korrekte Gleichheitssemantik hat. Wenn Sie Domänenobjekte emittieren, geben Sie ihnen Wertgleichheit (ein `record`, eine Freezed-Klasse oder ein handgeschriebenes `==`/`hashCode`). Siehe [Dart records vs Freezed classes](/2026/05/dart-records-vs-freezed-classes/) dazu, wozu man greifen sollte.

```dart
// Riverpod 3.x -- two distinct ticks that are == would be collapsed.
// A record gives structural equality so each tick is treated as new.
Stream<({int count, DateTime at})> ticks(Ref ref) async* {
  var n = 0;
  await for (final _ in Stream.periodic(const Duration(seconds: 1))) {
    yield (count: n++, at: DateTime.now());
  }
}
```

Wenn Sie wirklich jede Emission unabhängig von Gleichheit durchlassen müssen, überschreiben Sie `updateShouldNotify` auf einem `StreamNotifier`, sodass es `true` zurückgibt.

**Prüfen:** Führen Sie die App aus, beobachten Sie ein beliebiges stream-gestütztes Widget und bestätigen Sie, dass es bei jeder erwarteten Emission noch aktualisiert. Dies hat kein Kompiliersignal, also benötigt es einen manuellen Rauchtest.

## Schritt 7: Über automatische Wiederholung entscheiden

Fehlgeschlagene Provider wiederholen jetzt automatisch: eine anfängliche Verzögerung von 200 ms, die sich bis auf 6,4 Sekunden verdoppelt. Für die meisten netzwerkgestützten Provider ist das eine Verbesserung. Aber wenn Sie einen Provider haben, dessen Fehlschlag dauerhaft ist (ein Validierungsfehler, ein 404, der nie ein 200 wird), verschwenden die stillen Wiederholungen Aufrufe und können den Fehler in der UI für mehrere Sekunden maskieren.

Steigen Sie global am Scope aus, oder pro Provider:

```dart
// Riverpod 3.x -- disable retry everywhere
ProviderScope(
  retry: (retryCount, error) => null, // null delay = do not retry
  child: MyApp(),
)
```

```dart
// Or keep it, but stop retrying non-transient errors
ProviderScope(
  retry: (retryCount, error) {
    if (error is NotFoundException) return null;
    if (retryCount >= 3) return null;
    return Duration(milliseconds: 200 * (1 << retryCount));
  },
  child: MyApp(),
)
```

**Prüfen:** Richten Sie einen Provider auf einen Endpunkt, der ein 404 zurückgibt, und bestätigen Sie, dass er den Server nicht hämmert, oder dass Ihr Retry-Prädikat wie beabsichtigt kurzschließt.

## Schritt 8: ProviderObserver und die valueOrNull-Umbenennung aktualisieren

Wenn Sie einen benutzerdefinierten `ProviderObserver` (Analytics, Logging) haben, änderte sich die Signatur seiner Callbacks. Die Container- und Provider-Argumente wurden zu einem einzigen `ProviderObserverContext` zusammengeführt.

```dart
// Riverpod 3.x
class LoggingObserver extends ProviderObserver {
  @override
  void didUpdateProvider(
    ProviderObserverContext context,
    Object? previousValue,
    Object? newValue,
  ) {
    debugPrint('${context.provider.name} -> $newValue');
  }
}
```

Und die kleine: `AsyncValue.valueOrNull` wird in `value` umbenannt. Der alte `value`-Getter (der bei Laden/Fehler warf) ist weg. Wenn Sie sich auf das werfende Verhalten verlassen haben, matchen Sie stattdessen gegen den `AsyncData`-Fall.

**Prüfen:** Der Analyzer markiert jede `valueOrNull`-Aufrufstelle; der `dart fix`-Durchlauf aus Schritt 2 schreibt sie üblicherweise um, aber bestätigen Sie, dass keine übrig bleibt.

## Verifikation: der vollständige Rauchtest

Führen Sie nach allen Schritten die Checkliste von Anfang bis Ende durch:

- `flutter pub get` löst mit jedem Riverpod-Paket auf 3.x auf.
- `dart run build_runner build --delete-conflicting-outputs` erzeugt null Fehler (Codegen-Nutzer).
- `flutter analyze` ist sauber, keine verbliebenen `AutoDispose`-/`valueOrNull`-/typisierten-Ref-Referenzen.
- `flutter test` besteht, einschließlich der neuen Tests, die Sie für die `ProviderException`-Handhabung und Stream-Emission hinzugefügt haben.
- Üben Sie manuell aus: einen stream-gestützten Bildschirm, einen Fehler-Bildschirm und einen Bildschirm, der einen Provider-Fehlschlag auslöst, um zu bestätigen, dass Wiederholung, Wrapping und `==`-Filterung sich alle korrekt verhalten.

## Rollback-Plan

Diese Migration ist in der Praxis eine Einbahntür. In dem Moment, in dem Sie `import 'package:flutter_riverpod/legacy.dart'` schreiben und den einzigen `Ref`-Typ übernehmen, bedeutet Zurücksetzen, jede Datei rückgängig zu machen. Der saubere Rollback ist `git`, nicht Code: Erledigen Sie die gesamte Migration auf einem Branch, lassen Sie den 2.x-Branch unangetastet und mergen Sie erst, wenn der Rauchtest besteht. Machen Sie keine Halbmigration und liefern Sie sie aus; eine Codebasis mit einigen Dateien auf 3.x-Semantik und einigen auf 2.x-Annahmen (besonders rund um das Fehler-Wrapping) ist schlimmer als jede Version für sich allein.

## Fallstricke, auf die wir stießen

- **Das `==`-Filtern ist unsichtbar, bis es das nicht mehr ist.** Ein `StreamProvider<List<Item>>`, der von einer Liste gestützt wird, die derselbe Code an Ort und Stelle verändert, emittiert dieselbe Listen-Instanz zweimal, und 3.0 verwirft die zweite Benachrichtigung. Emittieren Sie jedes Mal eine frische Liste (oder einen wertgleichen Typ).
- **`ref.read(provider.future)` in einem `catch` ist der heimtückische Fall.** Es kompiliert einwandfrei und offenbart sich erst, wenn der Provider in der Produktion tatsächlich einen Fehler wirft. Suchen Sie proaktiv danach.
- **`dart fix` fasst string-typisierte oder dynamisch aufgebaute Provider-Referenzen nicht an.** Alles, was der Analyzer nicht statisch sehen kann, bearbeiten Sie von Hand.
- **Aktualisieren Sie `riverpod` nicht, ohne `riverpod_generator` im Gleichschritt zu aktualisieren.** Eine 3.x-Laufzeit mit einem 2.x-Generator erzeugt Code, der die alten `Ref`-Subtypen referenziert und auf verwirrende Weise nicht kompiliert.

## Verwandt

- [Migrate from provider to Riverpod in Flutter](/2026/06/migrate-from-provider-to-riverpod-in-flutter/)
- [How to check Ref.mounted after an async gap in Flutter Riverpod 3](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/)
- [Fix: Riverpod 3.0 throws ProviderException instead of the original error](/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/)
- [Provider vs Riverpod vs Bloc for Flutter state management in 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)
- [Migrate from FutureBuilder to a Riverpod AsyncNotifier in Flutter](/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/)

## Quellen

- [Migrating from 2.0 to 3.0, Riverpod docs](https://riverpod.dev/docs/3.0_migration)
- [What's new in Riverpod 3.0, Riverpod docs](https://riverpod.dev/docs/whats_new)
- [riverpod on pub.dev](https://pub.dev/packages/flutter_riverpod)
