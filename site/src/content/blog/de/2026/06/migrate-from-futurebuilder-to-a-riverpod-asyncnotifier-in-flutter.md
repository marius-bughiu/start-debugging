---
title: "Von FutureBuilder zu einem Riverpod AsyncNotifier in Flutter migrieren (flutter_riverpod 3.3.2)"
description: "Eine schrittweise Migration von einem inline FutureBuilder-Widget zu einem Riverpod AsyncNotifier in einer echten Flutter-App: die asynchrone Arbeit aus build herausziehen, als Provider bereitstellen, mit .when() oder switch-Mustervergleich rendern sowie Refresh- und Mutationsmethoden ergänzen. Getestet mit Flutter 3.44, Dart 3.x, flutter_riverpod 3.3.2."
pubDate: 2026-06-18
updatedDate: 2026-06-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "riverpod"
lang: "de"
translationOf: "2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-18
---

Einen Screen von `FutureBuilder` zu einem Riverpod `AsyncNotifier` umzustellen ist pro Screen üblicherweise eine Aufgabe von 30 bis 60 Minuten, und die meiste Zeit verbringen Sie damit, Code zu löschen, statt ihn zu schreiben. Was sich ändert: Das Future, das Sie früher innerhalb von `build` erzeugt haben, wandert in einen Provider, das Widget verliert seinen `StatefulWidget`-Boilerplate, und jede manuelle `setState`-Retry-Logik wird durch `ref.invalidate` ersetzt. Es lohnt sich in dem Moment, in dem ein zweites Widget dieselben Daten benötigt, Sie über Navigation hinweg zwischenspeichern wollen oder einen Refresh von einer anderen Stelle als dem Widget aus auslösen müssen, das den `FutureBuilder` besitzt. Wenn ein Screen tatsächlich ein einmaliges Future besitzt, das nichts anderes berührt, lassen Sie es als `FutureBuilder` -- diese Migration bringt Ihnen dort nichts.

Diese Anleitung verwendet Flutter 3.44, Dart 3.x und `flutter_riverpod` 3.3.2. Die Codegenerierungs-Snippets setzen `riverpod_annotation` 3.x und `riverpod_generator` 3.x mit `build_runner` voraus.

## Warum von FutureBuilder weg

- **Das Future wird nicht mehr bei jedem Rebuild neu erzeugt.** Ein `FutureBuilder`, dessen `future:` inline aufgebaut wird, führt seine asynchrone Arbeit jedes Mal erneut aus, wenn das übergeordnete Widget neu kompiliert wird. Ein `AsyncNotifier` kompiliert einmal und speichert das Ergebnis zwischen, bis Sie es invalidieren. (Falls Sie vorerst bei `FutureBuilder` bleiben, wird die Behebung dieses speziellen Bugs unter [FutureBuilder davon abhalten, sein Future neu zu erzeugen](/de/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/) behandelt.)
- **Die Daten werden teilbar.** Zwei Widgets, die denselben Provider beobachten, treffen auf den Cache, nicht auf zwei getrennte Netzwerkaufrufe.
- **Refresh und Mutation erhalten ein echtes Zuhause.** Pull-to-Refresh, Retry-on-Error und optimistische Updates werden zu Methoden auf dem Notifier statt zu `setState`-Verrenkungen im Widget.
- **Fehler sind typisiert, nicht verschluckt.** `AsyncValue` trägt `loading`, `data` und `error` (mit Stack Trace) als erstklassige Zustände, auf denen Sie einen Mustervergleich durchführen.

## Was sich ändert

| Bereich | Vorher (`FutureBuilder`) | Nachher (`AsyncNotifier`) | Schweregrad |
| --- | --- | --- | --- |
| Wo das Future lebt | In `build` oder `initState` erzeugt | `build()`-Methode des Notifiers | hoch |
| Widget-Typ | Üblicherweise `StatefulWidget` | `ConsumerWidget` (stateless) | mittel |
| Loading-/Error-Rendering | `snapshot.connectionState` + `snapshot.hasError` | `AsyncValue.when` oder `switch` | mittel |
| Retry | Rebuild + Future neu erzeugen | `ref.invalidate(provider)` | niedrig |
| Mutationen | `setState` nach `await` | Methode + `AsyncValue.guard` | mittel |
| Abbruch bei Dispose | Manuelle `mounted`-Prüfungen | Automatisch über `ref.onDispose` | niedrig |

Der einzige wirklich schwerwiegende Punkt ist, wo das Future lebt: Alles andere folgt aus dessen Verschiebung.

## Pre-flight-Checkliste

- `flutter --version` meldet 3.44 oder neuer, Dart 3.x.
- `flutter_riverpod: ^3.3.2` steht in `pubspec.yaml`. Wenn Sie Codegenerierung möchten, fügen Sie außerdem `riverpod_annotation: ^3.0.0` hinzu und unter `dev_dependencies` `riverpod_generator: ^3.0.0` sowie `build_runner`.
- Ihre App ist an der Wurzel in einen `ProviderScope` gewickelt. Falls nicht, ist das Schritt null:

```dart
// Flutter 3.44, flutter_riverpod 3.3.2
void main() {
  runApp(const ProviderScope(child: MyApp()));
}
```

- Wählen Sie ein Widget aus, das Sie zuerst migrieren. Konvertieren Sie nicht die gesamte App in einem einzigen Commit. Führen Sie für jeden Screen im Verlauf einen Smoke-Test durch.

## Der Ausgangspunkt: ein inline FutureBuilder

Hier ist das Muster, von dem wir wegmigrieren. Ein Profil-Screen ruft einen Benutzer ab und rendert drei Zustände von Hand. Der eingebaute Bug ist der klassische: `repo.fetchUser(userId)` läuft bei jedem Rebuild erneut, weil das Future innerhalb von `build` erzeugt wird.

```dart
// Flutter 3.44, Dart 3.x -- the BEFORE
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context) {
    final repo = UserRepository();
    return FutureBuilder<User>(
      future: repo.fetchUser(userId), // re-runs on every rebuild
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return Center(child: Text('Failed: ${snapshot.error}'));
        }
        final user = snapshot.data!;
        return Text(user.name);
      },
    );
  }
}
```

## Migrationsschritte

1. **Den Provider deklarieren.** Verschieben Sie den asynchronen Aufruf in einen Notifier. Es gibt zwei Schreibweisen; wählen Sie eine und bleiben Sie über die Codebasis hinweg konsistent.

**Codegenerierungs-Stil (empfohlen für neuen Code):**

```dart
// flutter_riverpod 3.3.2, riverpod_annotation 3.x
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'profile_controller.g.dart';

@riverpod
class ProfileController extends _$ProfileController {
  @override
  Future<User> build(String userId) {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }
}
```

Der Parameter `userId` auf `build` macht dies zu einer Family: `profileControllerProvider(userId)` gibt Ihnen einen zwischengespeicherten Notifier pro id. Führen Sie den Generator aus und prüfen Sie, dass er die `.g.dart`-Datei ohne Fehler erzeugt:

```bash
# verify: the build completes and emits profile_controller.g.dart
dart run build_runner build --delete-conflicting-outputs
```

**Manueller Stil (keine Codegenerierung):**

```dart
// flutter_riverpod 3.3.2
final profileControllerProvider =
    AsyncNotifierProvider.family<ProfileController, User, String>(
  ProfileController.new,
);

class ProfileController extends FamilyAsyncNotifier<User, String> {
  @override
  Future<User> build(String userId) {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }
}
```

Beide erzeugen einen Provider, dessen Wert ein `AsyncValue<User>` ist. Das `build` des Notifiers läuft einmal pro `userId`, und das Ergebnis wird zwischengespeichert, bis es invalidiert wird. Beachten Sie, dass Sie `UserRepository()` nicht mehr von Hand konstruieren: Injizieren Sie es über einen anderen Provider, damit es testbar und geteilt ist.

2. **Das Widget in ein `ConsumerWidget` umwandeln.** Aus dem `StatefulWidget`/`StatelessWidget` wird ein `ConsumerWidget`, und `build` erhält eine `WidgetRef`. Lesen Sie den Provider mit `ref.watch` und rendern Sie dann das `AsyncValue`.

```dart
// flutter_riverpod 3.3.2 -- the AFTER
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final userAsync = ref.watch(profileControllerProvider(userId));
    return userAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (err, stack) => Center(child: Text('Failed: $err')),
      data: (user) => Text(user.name),
    );
  }
}
```

Prüfen: Führen Sie einen Hot-Restart des Screens durch. Er sollte genau einmal abrufen. Navigieren Sie weg und zurück -- er sollte nicht erneut abrufen (der Cache lebt, solange etwas den Provider eingehängt hält). Dieses Einmal-Abruf-Verhalten ist der gesamte Sinn der Migration.

3. **Mit switch-Mustervergleich rendern (optional, aber sauberer).** Der Mustervergleich von Dart 3 liest sich für manche Teams besser als `.when()` und erlaubt Ihnen, während eines Refreshs veraltete Daten sichtbar zu halten. Die vollständige Behandlung dieser Muster findet sich unter [Loading- und Error-Zustände mit AsyncValue anzeigen](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/), aber die Kurzfassung:

```dart
// Dart 3.x switch over AsyncValue
final userAsync = ref.watch(profileControllerProvider(userId));
return switch (userAsync) {
  AsyncData(:final value) => Text(value.name),
  AsyncError(:final error) => Text('Failed: $error'),
  _ => const Center(child: CircularProgressIndicator()),
};
```

Prüfen: Dies kompiliert ohne eine `non-exhaustive switch`-Warnung. Das `_` als Catch-all behandelt `AsyncLoading`.

4. **Retry durch `ref.invalidate` ersetzen.** Der alte Retry-Pfad erzeugte das Future durch einen Rebuild neu. Jetzt ist Retry eine Zeile. Fügen Sie dem Error-Zweig eine Schaltfläche hinzu:

```dart
// flutter_riverpod 3.3.2
error: (err, stack) => Center(
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Text('Failed: $err'),
      ElevatedButton(
        onPressed: () => ref.invalidate(profileControllerProvider(userId)),
        child: const Text('Retry'),
      ),
    ],
  ),
),
```

`ref.invalidate` verwirft den zwischengespeicherten Wert und führt `build` erneut aus, was das `AsyncValue` zurück auf `loading` und dann auf `data` oder `error` schaltet. Prüfen: Erzwingen Sie einen Fehler (schalten Sie das Netzwerk aus), tippen Sie bei wiederhergestelltem Netzwerk auf Retry und bestätigen Sie, dass es von loading zu data übergeht.

5. **Mutationen mit `AsyncValue.guard` ergänzen.** Das ist die Fähigkeit, die `FutureBuilder` nie hatte. Um den Benutzer zu aktualisieren und das Ergebnis abzubilden, fügen Sie dem Notifier eine Methode hinzu. `AsyncValue.guard` umschließt den asynchronen Aufruf, sodass eine geworfene Exception zu einem `AsyncError` wird statt zu einem unbehandelten Absturz.

```dart
// flutter_riverpod 3.3.2
@riverpod
class ProfileController extends _$ProfileController {
  @override
  Future<User> build(String userId) {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }

  Future<void> rename(String newName) async {
    final repo = ref.read(userRepositoryProvider);
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(() async {
      await repo.rename(userId, newName);
      return repo.fetchUser(userId);
    });
  }
}
```

Rufen Sie sie aus dem Widget mit `ref.read(...).rename(...)` innerhalb eines Callbacks auf (verwenden Sie `read`, nicht `watch`, in Callbacks). Prüfen: Lösen Sie ein Rename aus, beobachten Sie, wie die UI in loading geht und dann den neuen Namen anzeigt; lösen Sie ein fehlschlagendes Rename aus und bestätigen Sie, dass der Error-Zustand gerendert wird, statt eine Exception zu werfen.

## Verifizierung

Arbeiten Sie diese Checkliste nach der Migration eines Screens ab:

- `flutter analyze` meldet keine neuen Warnungen, und falls Sie Codegen verwendet haben, läuft `dart run build_runner build` sauber durch.
- Der Screen ruft beim ersten Öffnen genau einmal ab (fügen Sie ein print im Repository hinzu oder beobachten Sie den Network-Tab).
- Wegnavigieren und zurück führt nicht zu einem erneuten Abruf, sofern Sie nicht invalidieren.
- Der Error-Zweig rendert bei einem erzwungenen Fehlschlag, und Retry stellt wieder her.
- `flutter test` läuft durch. Provider sind trivial testbar: Überschreiben Sie `userRepositoryProvider` mit einem Fake in einem `ProviderContainer` und prüfen Sie das `AsyncValue`.

```dart
// flutter_test + flutter_riverpod 3.3.2
test('loads the user', () async {
  final container = ProviderContainer(overrides: [
    userRepositoryProvider.overrideWithValue(FakeUserRepository()),
  ]);
  addTearDown(container.dispose);

  final user = await container.read(profileControllerProvider('42').future);
  expect(user.name, 'Ada');
});
```

## Rollback-Plan

Diese Migration ist pro Screen umkehrbar, weil Sie ein Widget nach dem anderen konvertieren können. Um einen einzelnen Screen zurückzurollen, stellen Sie das `FutureBuilder`-Widget wieder her und löschen Sie dessen Provider; nichts anderes hängt davon ab, wenn Sie inkrementell migriert haben. Die einzige Einbahnstraße ist das Entfernen der alten `StatefulWidget`-Verkabelung über viele Screens hinweg in einem einzigen Commit -- tun Sie das nicht. Halten Sie die Migration jedes Screens in einem eigenen Commit, damit ein Revert ein einzeiliges `git revert` ist.

## Stolpersteine, auf die wir gestoßen sind

**`ref.watch` innerhalb von Callbacks kompiliert nichts Nützliches neu.** Verwenden Sie in einem `onPressed`-Handler `ref.read`. `watch` ist für `build`; es in einem Callback zu verwenden, abonniert zum falschen Zeitpunkt und ist eine häufige Quelle der Verwirrung "meine Schaltfläche aktualisiert den Screen nicht".

**Der Family-Parameter muss stabil sein.** `profileControllerProvider(userId)` schlüsselt den Cache anhand von `userId`. Wenn Sie versehentlich ein frisch konstruiertes Objekt (eine neue `User`-Instanz, eine Map) statt eines wertgleichen Schlüssels übergeben, erhalten Sie bei jedem Rebuild einen frischen Notifier, und der Cache trifft nie. Verwenden Sie Primitive oder Typen mit ordentlichem `==`.

**Disposed `ref` nach einem await.** Wenn eine Mutation wartet und der Provider mitten im Flug disposed wird (der Benutzer ist weggenavigiert), führt das Berühren von `ref` danach zu einer Exception. Riverpod 3 macht dies klar sichtbar; die Behebung und die genaue Meldung finden sich unter [Behebung von "Cannot use ref after the widget was disposed"](/de/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/). Schützen Sie mit `ref.mounted`, falls Sie `ref` nach einem await in einer langen Mutation berühren müssen.

**Der Provider wird zu früh disposed.** Standardmäßig wird ein Provider ohne Listener disposed. Wenn Sie wegnavigieren und zurückkehren und einen erneuten Abruf sehen, den Sie nicht wollten, dann macht Auto-Dispose seine Arbeit. Halten Sie ihn bewusst mit `ref.keepAlive()` innerhalb von `build` am Leben oder akzeptieren Sie den erneuten Abruf als korrektes Cache-Verhalten.

**Mischen Sie dies nicht mit Zustand aus dem `provider`-Paket.** Wenn Ihre App anderswo noch das alte `provider`-Paket verwendet, migrieren Sie das separat; die beiden koexistieren, verwischen aber das mentale Modell. Die [Migration von provider zu Riverpod](/de/2026/06/migrate-from-provider-to-riverpod-in-flutter/) behandelt diesen Weg. Und falls Sie noch entscheiden, ob `AsyncNotifier` für ein bestimmtes Widget überhaupt die richtige Wahl ist, zieht der [Entscheidungsleitfaden FutureBuilder vs. Riverpod AsyncValue](/de/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) die Grenze.

## Quellen

- [Migrating from 2.0 to 3.0](https://riverpod.dev/docs/3.0_migration) -- offizieller Riverpod-Migrationsleitfaden für die vereinheitlichte `Ref` und die Notifier-Änderungen.
- [(Async)NotifierProvider](https://riverpod.dev/docs/providers/notifier_provider) -- der kanonische `AsyncNotifier`- und `build()`-Vertrag.
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- die Liste der 3.0-Funktionen und Breaking Changes.
- [flutter_riverpod on pub.dev](https://pub.dev/packages/flutter_riverpod) -- Bestätigung der Version 3.3.2.
