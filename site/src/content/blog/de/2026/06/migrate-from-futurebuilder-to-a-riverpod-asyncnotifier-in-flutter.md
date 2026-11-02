---
title: "Von FutureBuilder zu einem Riverpod AsyncNotifier in Flutter migrieren (flutter_riverpod 3.3.2)"
description: "FutureBuilder zu Riverpod 3 AsyncNotifier migrieren: geprüfter manueller Family-Provider, explizite Cache-Lebensdauer, Wiederholungen und sichere Mutationen."
pubDate: 2026-06-18
updatedDate: 2026-11-02
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

Verschiebe eine `FutureBuilder`-Anfrage in einen `AsyncNotifier`, wenn mehrere Widgets denselben Zustand benötigen oder Mutationen einen gemeinsamen Ort brauchen. Ein gespeicherter Future, den nur ein Widget verwendet, bleibt ein guter Fall für `FutureBuilder`. Problematisch ist das Erzeugen einer neuen Anfrage in `build()`, nicht das Widget selbst.

Dieses Beispiel verwendet die manuelle Riverpod-3-API mit **flutter_riverpod 3.3.2**, geprüft auf **Flutter 3.44.8 / Dart 3.12.2**. Es benötigt keine Codegenerierung. Beide Dart-Blöcke gehören in dieselbe Datei. Mit `flutter_riverpod: 3.3.2` reproduzierst du die geprüfte Version; sie wird hier nicht als neueste Version bezeichnet.

## Anfrage und Mutation in einen Provider verschieben

`UserRepository` bildet die Schnittstelle zur Anwendung. Implementiere sie mit deinem API-Client und überschreibe `userRepositoryProvider` im `ProviderScope` an der Wurzel. Die Vorgabe löst absichtlich einen Fehler aus, wenn die Implementierung fehlt. Tests verwenden stattdessen ein Fake im Speicher.

Ein manuell definierter Family-Notifier erbt in Riverpod 3 von `AsyncNotifier<User>`, erhält die ID im Konstruktor und verwendet `build()` ohne Parameter. `FamilyAsyncNotifier<User, String>` gehört zur alten API. Der folgende Provider aktiviert die automatische Freigabe und deaktiviert automatische Wiederholungen, damit der Retry-Button das Beispiel steuert.

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class User {
  const User(this.name);
  final String name;
}

abstract class UserRepository {
  Future<User> fetchUser(String id);
  Future<void> rename(String id, String name);
}

final userRepositoryProvider = Provider<UserRepository>(
  (ref) => throw UnimplementedError('Override with your repository'),
);

final profileControllerProvider =
    AsyncNotifierProvider.autoDispose.family<ProfileController, User, String>(
  ProfileController.new,
  retry: (retryCount, error) => null,
);

class ProfileController extends AsyncNotifier<User> {
  ProfileController(this.userId);
  final String userId;

  @override
  Future<User> build() {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }

  Future<void> rename(String newName) async {
    if (state.isLoading) return;
    final repo = ref.read(userRepositoryProvider);
    state = const AsyncLoading();
    final next = await AsyncValue.guard(() async {
      await repo.rename(userId, newName);
      return repo.fetchUser(userId);
    });
    if (!ref.mounted) return;
    state = next;
  }
}
```

`AsyncValue.guard` macht aus einer fehlgeschlagenen Mutation einen Fehlerzustand. Nach dem await verhindert `ref.mounted` das Schreiben in einen freigegebenen Notifier. Die Prüfung des Ladezustands vermeidet überlappende rename-Aufrufe dieser Methode; sie ist weder eine Transaktion noch HTTP-Abbruchlogik.

## Gemeinsamen Zustand anzeigen

Ersetze den Bildschirm durch dieses `ConsumerWidget`. `ref.watch` registriert die Abhängigkeit während build; Button-Callbacks verwenden `ref.read` oder `ref.invalidate`. `skipLoadingOnRefresh: false` sorgt dafür, dass eine Invalidierung auch bei vorhandenen alten Daten den Ladezustand zeigt.

```dart
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ref.watch(profileControllerProvider(userId)).when(
      skipLoadingOnRefresh: false,
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, stack) => Column(
        children: [
          Text('Failed: $error'),
          ElevatedButton(
            onPressed: () => ref.invalidate(profileControllerProvider(userId)),
            child: const Text('Retry'),
          ),
        ],
      ),
      data: (user) => Column(
        children: [
          Text(user.name),
          ElevatedButton(
            onPressed: () => ref
                .read(profileControllerProvider(userId).notifier)
                .rename('Grace'),
            child: const Text('Rename'),
          ),
        ],
      ),
    );
  }
}
```

## Die Lebensdauer festlegen

- Widgets mit demselben Family-Schlüssel im selben Provider-Scope teilen den aktiven Zustand. Schlüssel brauchen stabile Gleichheit und `hashCode`.
- `.autoDispose` erlaubt die Freigabe, wenn kein Listener mehr vorhanden ist. Nach der Freigabe lädt eine Rückkehr erneut. Auch geänderte Abhängigkeiten oder Invalidierungen können `build()` erneut ausführen.
- Ohne Codegenerierung ist automatische Freigabe optional; generierte `@riverpod`-Provider aktivieren sie standardmäßig. Die Vorgaben sind nicht gleich. `ref.keepAlive()` oder eine Cache-Strategie setzt bewusste Aufbewahrung voraus.
- Riverpod 3 wiederholt geeignete Initialisierungsfehler standardmäßig automatisch. Das Beispiel schaltet dies mit `retry: (_, _) => null` ab. Wähle für die Anwendung eine passende Strategie. `AsyncValue.guard` wiederholt Mutationsmethoden nicht automatisch.
- `ref.onDispose` ist ein Hook, kein automatischer Request-Abbruch. Verbinde ihn bei Bedarf mit der Abbruch- oder Aufräumfunktion deines HTTP-Clients.

Ein Switch nur über `AsyncData` und `AsyncError` garantiert keine Anzeige alter Daten während eines Refreshs. Wähle die Darstellung ausdrücklich; auch `.when()` bietet Lade- und Refresh-Optionen. Bei Pull-to-refresh warte auf `ref.refresh(profileControllerProvider(userId).future)`, damit die Geste mit der Anfrage endet.

## Migration prüfen

Der korrigierte Code bestand Analyse sowie Provider- und Widget-Tests für geteilte Lesezugriffe, Invalidierung, Freigabe mit erneutem Laden, Fehler und manuelle Wiederholung, erfolgreiche und fehlgeschlagene Umbenennung sowie Abschluss nach Freigabe. Die Tests verwenden ein Fake-Repository und prüfen weder deinen Netzwerkdienst noch die Anmeldung. Führe entsprechende Prüfungen in deiner Anwendung aus:

```bash
flutter analyze
flutter test
```

Migriere einen Bildschirm nach dem anderen. Für einen Rollback stelle dessen Implementierung mit gespeichertem Future wieder her und entferne den ungenutzten Provider. Erzeuge nicht bei jedem Build einen neuen Future.

**Korrektur vom 2. November 2026:** Riverpod-2-Family-API ersetzt, Freigabe und Wiederholungen explizit gemacht, Aussagen zu Navigation, Cache und Abbruch korrigiert und Lebenszyklusprüfung nach await ergänzt. Die alte Version-2-Anleitung wird nicht mehr als Riverpod-3-Dokumentation verlinkt.

## Quellen und weitere Artikel

- [Flutter: FutureBuilder](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html)
- [Riverpod 3: migration](https://riverpod.dev/docs/3.0_migration)
- [Riverpod: families](https://riverpod.dev/docs/concepts2/family)
- [Riverpod: automatic disposal](https://riverpod.dev/docs/concepts2/auto_dispose)
- [Riverpod: automatic retry](https://riverpod.dev/docs/concepts2/retry)
- [Riverpod: request cancellation](https://riverpod.dev/docs/how_to/cancel)
- [flutter_riverpod 3.3.2](https://pub.dev/packages/flutter_riverpod/versions/3.3.2)

- [FutureBuilder / Future](/de/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)
- [AsyncValue](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [Ref / dispose](/de/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/)
- [provider → Riverpod](/de/2026/06/migrate-from-provider-to-riverpod-in-flutter/)
- [FutureBuilder / Riverpod](/de/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)
