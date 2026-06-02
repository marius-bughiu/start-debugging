---
title: "Lade- und Fehlerzustände mit AsyncValue in Flutter Riverpod anzeigen"
description: "Rendern Sie Lade-, Daten- und Fehlerzustände aus einem einzigen AsyncValue in Riverpod 3. Verwenden Sie AsyncNotifier und AsyncValue.guard für Mutationen, .when() und switch-Mustervergleich für die UI, behalten Sie vorherige Daten beim Aktualisieren und migrieren Sie das veraltete StateNotifier-Muster. Getestet mit flutter_riverpod 3.x, Flutter 3.44, Dart 3.x."
pubDate: 2026-06-02
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "how-to"
lang: "de"
translationOf: "2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod"
translatedBy: "claude"
translationDate: 2026-06-02
---

Die Kurzfassung: Ein asynchroner Provider in Riverpod liefert Ihnen einen `AsyncValue<T>`, ein einzelnes Objekt, das sich immer in genau einem von drei Zuständen befindet (Daten, Laden oder Fehler). Sie rendern alle drei an einer Stelle mit `value.when(data: ..., loading: ..., error: ...)` oder einem Dart-3-`switch` über `AsyncData` / `AsyncLoading` / `AsyncError`. Diese Zustände erzeugen Sie aus einem `AsyncNotifier`, dessen `build` ein `Future` zurückgibt, und Sie verändern sie sicher mit `AsyncValue.guard`, das eine geworfene Exception in einen `AsyncError` umwandelt, statt einen Absturz zu verursachen. Wenn Sie noch den alten `StateNotifier` verwenden, ist die Rendering-Seite identisch, sobald Sie einen `AsyncValue` als Zustand bereitstellen. Dieser Leitfaden wurde mit `flutter_riverpod` 3.x getestet (die 3.0-Linie erschien Anfang 2026), Flutter 3.44 und Dart 3.x.

Dieses Muster ist deshalb wichtig, weil fast jeder Bildschirm einer echten App asynchron ist: Er ruft etwas ab, der Abruf kann laufen und der Abruf kann fehlschlagen. Teams, die das von Hand bauen, landen bei drei separaten Feldern (`isLoading`, `data`, `errorMessage`), einem Geflecht aus `if`-Zweigen und dem klassischen Bug, bei dem `isLoading` `false` ist, `data` aber weiterhin `null`, weil ein vorzeitiges Return vergessen hat, eine Flag umzuschalten. `AsyncValue` macht illegale Zustände nicht darstellbar: Es gibt kein "lädt und hat zugleich einen Fehler und hat zugleich Daten", weil der Typ eine versiegelte Union ist. Sie behandeln die drei Fälle, die der Compiler Ihnen vorschreibt, und sind fertig.

## Die drei Zustände, und warum eine Union drei Booleans schlägt

`AsyncValue<T>` ist eine versiegelte Klasse mit drei konkreten Subtypen:

- `AsyncData<T>` trägt einen `value` vom Typ `T`.
- `AsyncLoading<T>` bedeutet, dass ein Ladevorgang läuft.
- `AsyncError<T>` trägt einen `error` (`Object`) und einen `stackTrace`.

Da die Klasse versiegelt ist, weiß der Analyzer, dass die Liste der Subtypen geschlossen ist, weshalb ein `switch` darüber ohne Default-Fall vollständig ist. Das ist das gesamte Design: Statt bei jedem Rebuild "in welchem Zustand bin ich" aus einem Sack nullbarer Felder zu rekonstruieren, führen Sie einen Mustervergleich über einen Wert durch, dessen Typ die Antwort bereits kodiert.

Es gibt außerdem praktische Getter, zu denen Sie ständig greifen werden:

- `isLoading`, `hasValue`, `hasError` sind Booleans.
- `value` ist ein nullbares `T?` (es kann nicht-null sein, selbst während `isLoading` true ist, was beim Aktualisieren wichtig ist, siehe unten).
- `valueOrNull` ist der sichere Zugriff, der nie wirft.
- `requireValue` gibt den Wert zurück oder wirft `AsyncValueIsLoadingException` / wirft den Fehler erneut. Verwenden Sie es nur, wenn Sie bereits nachgewiesen haben, dass Sie sich im Datenzustand befinden.
- `isRefreshing` und `isReloading` unterscheiden eine erzwungene Aktualisierung von einer durch Abhängigkeiten ausgelösten Neuberechnung.

## Ein konkreter Bildschirm: eine Artikelliste, die laden und fehlschlagen kann

Hier ist das kleinste realistische Setup: ein Repository, das eine Liste abruft, ein Provider, der sie bereitstellt, und ein Widget, das alle drei Zustände rendert. Ich verwende die Variante mit Codegenerierung und `riverpod_annotation`, die empfohlene Art, Provider in der 3.x-Linie zu deklarieren.

```dart
// flutter_riverpod 3.x, riverpod_annotation 3.x, Dart 3.x
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'articles_provider.g.dart';

class Article {
  const Article(this.id, this.title);
  final String id;
  final String title;
}

@riverpod
class Articles extends _$Articles {
  @override
  Future<List<Article>> build() async {
    final repo = ref.watch(articleRepositoryProvider);
    return repo.fetchAll(); // may throw on a network failure
  }
}
```

Die `build`-Methode gibt ein `Future<List<Article>>` zurück. Riverpod umhüllt dieses Future für Sie: Solange es ausstehend ist, ist `ref.watch(articlesProvider)` `AsyncLoading`; nach Abschluss `AsyncData`; bei einem Wurf `AsyncError`. Sie konstruieren diese Zustände für das initiale Laden nie von Hand. Sie geben einfach Daten zurück oder lassen eine Exception sich ausbreiten.

Wenn Sie keine Codegenerierung verwenden, ist die manuelle Form dieselbe Klassenstruktur ohne die Annotation:

```dart
// Manual (no code-gen) equivalent. flutter_riverpod 3.x
final articlesProvider =
    AsyncNotifierProvider<Articles, List<Article>>(Articles.new);

class Articles extends AsyncNotifier<List<Article>> {
  @override
  Future<List<Article>> build() async {
    final repo = ref.watch(articleRepositoryProvider);
    return repo.fetchAll();
  }
}
```

## Alle drei Zustände mit `.when()` rendern

`.when()` ist der direkteste Weg, einen `AsyncValue` auf Widgets abzubilden. Es nimmt drei erforderliche Callbacks:

```dart
// flutter_riverpod 3.x
class ArticleListView extends ConsumerWidget {
  const ArticleListView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final articles = ref.watch(articlesProvider);

    return articles.when(
      data: (list) => ListView.builder(
        itemCount: list.length,
        itemBuilder: (_, i) => ListTile(title: Text(list[i].title)),
      ),
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (err, stack) => ErrorView(
        message: _humanMessage(err),
        onRetry: () => ref.invalidate(articlesProvider),
      ),
    );
  }
}
```

Drei Dinge fallen auf. Erstens: `ref.invalidate(articlesProvider)` ist die Art, wie der Wiederholen-Button `build` erneut ausführt; es verwirft den zwischengespeicherten Zustand und berechnet neu. `ref.refresh` macht dasselbe und gibt den neuen Wert zurück, falls Sie ihn brauchen. Zweitens: Der `error`-Callback erhält sowohl das Fehlerobjekt als auch dessen Stack Trace, sodass Sie den Trace protokollieren und dem Benutzer eine freundliche Meldung zeigen können: Setzen Sie niemals `err.toString()` direkt auf den Bildschirm. Drittens ist `_humanMessage` der Ort, an dem Sie Exception-Typen in Text übersetzen, was zur korrekten Klassifizierung des Fehlers passt; siehe [wie man Netzwerkfehler in einer Flutter-App elegant behandelt](/de/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) für die Zuordnung von Exception zu Meldung, die dorthin gehört.

## Die Dart-3-Alternative: `switch`-Mustervergleich

Da `AsyncValue` versiegelt ist, können Sie den Mustervergleich direkt darauf anwenden. Viele Teams bevorzugen das in Riverpod 3, weil es sich natürlich liest und das Destrukturieren in einer Zeile erlaubt:

```dart
// Dart 3.x switch expression over the sealed AsyncValue
Widget build(BuildContext context, WidgetRef ref) {
  final articles = ref.watch(articlesProvider);

  return switch (articles) {
    AsyncData(:final value) => ArticleList(items: value),
    AsyncError(:final error) => ErrorView(message: _humanMessage(error)),
    _ => const Center(child: CircularProgressIndicator()),
  };
}
```

Der `_`-Zweig fängt `AsyncLoading` ab. Funktional ist dies äquivalent zu `.when()`, lässt sich aber besser komponieren, wenn Sie Guards hinzufügen wollen (zum Beispiel `AsyncData(:final value) when value.isEmpty => const EmptyState()`). Verwenden Sie das, was Ihr Team lesbarer findet; beide erzeugen dieselbe UI.

## Mutationen: warum Sie `AsyncValue.guard` brauchen

Das initiale Laden ist automatisch, aber ein Button, der einen Artikel erstellt oder löscht, ist ein manueller Zustandsübergang, und genau dort stürzt ungeschützter Code ab. Der falsche Weg ist, das Repository direkt aufzurufen und die Exception in den Widget-Baum entkommen zu lassen. Der richtige Weg setzt den Zustand auf Laden, führt die Arbeit innerhalb von `AsyncValue.guard` aus und weist das Ergebnis zu:

```dart
// flutter_riverpod 3.x
@riverpod
class Articles extends _$Articles {
  @override
  Future<List<Article>> build() => ref.watch(articleRepositoryProvider).fetchAll();

  Future<void> add(String title) async {
    final repo = ref.read(articleRepositoryProvider);

    // Show loading while keeping the current list visible (see "refresh" below).
    state = const AsyncLoading<List<Article>>().copyWithPrevious(state);

    // guard converts a thrown exception into AsyncError instead of crashing.
    state = await AsyncValue.guard(() async {
      await repo.create(title);
      return repo.fetchAll();
    });
  }
}
```

`AsyncValue.guard` ist das Gegenstück zur automatischen Umhüllung in `build`. Es führt Ihren Callback aus, gibt bei Erfolg `AsyncData` und bei einem Fehlschlag `AsyncError` (mit dem erfassten Stack Trace) zurück, sodass ein Netzwerkaussetzer während `add` den Bildschirm auf Ihre Fehler-UI umschaltet, statt eine unbehandelte Exception zu werfen. Der Aufruf `copyWithPrevious(state)` sorgt dafür, dass die Liste während der Mutation auf dem Bildschirm bleibt, statt einen Vollbild-Spinner aufblitzen zu lassen; das neue `AsyncLoading` trägt den alten Wert, sodass `value` weiterhin gefüllt ist.

## Daten beim Aktualisieren auf dem Bildschirm behalten

Das ist das Detail, über das alle stolpern. Wenn Sie einen asynchronen Provider mit `ref.refresh` aktualisieren, kehrt der Zustand kurz zu Laden zurück. Wenn Sie naiv für jeden Ladezustand einen Spinner anzeigen, lässt ein "Pull-to-Refresh" den gesamten Bildschirm für einen Frame leer werden. Riverpod 3 behandelt das mit zwei Flags an `.when()`:

- `skipLoadingOnRefresh` ist standardmäßig `true`. Während eines `ref.refresh` (einer expliziten, benutzergesteuerten Aktualisierung) ruft `.when()` weiterhin Ihren `data`-Callback mit dem vorherigen Wert auf statt `loading`.
- `skipLoadingOnReload` ist standardmäßig `false`. Wenn der Provider neu lädt, weil sich eine Abhängigkeit geändert hat, erhalten Sie standardmäßig den `loading`-Callback.

Standardmäßig hält ein "Pull-to-Refresh" also die alte Liste sichtbar, während die neue lädt, was genau das ist, was Sie wollen. Wenn Sie stattdessen wollen, dass der Spinner beim Aktualisieren erscheint, deaktivieren Sie es:

```dart
articles.when(
  skipLoadingOnRefresh: false, // show the loading callback even on refresh
  data: (list) => ArticleList(items: list),
  loading: () => const Center(child: CircularProgressIndicator()),
  error: (err, _) => ErrorView(message: _humanMessage(err)),
);
```

Speziell für ein "Pull-to-Refresh"-Element ist die idiomatische Kombination, `skipLoadingOnRefresh: true` beizubehalten (damit die Liste an Ort und Stelle bleibt) und den `RefreshIndicator` über das zurückgegebene Future zu steuern:

```dart
RefreshIndicator(
  onRefresh: () => ref.refresh(articlesProvider.future),
  child: articles.when(
    data: (list) => ListView(/* ... */),
    loading: () => const Center(child: CircularProgressIndicator()),
    error: (err, _) => ErrorView(message: _humanMessage(err)),
  ),
);
```

Das Abwarten von `articlesProvider.future` mit `await` lässt den Spinner des `RefreshIndicator` selbst drehen, bis die neuen Daten eintreffen, während der Inhalt darunter weiterhin die alten Daten zeigt. Das ist das Verhalten, das Benutzer erwarten.

Ein Vorbehalt, den Sie kennen sollten: Es gibt ein [offenes Issue](https://github.com/rrousselGit/riverpod/issues/4670), bei dem `skipLoadingOnRefresh` und `skipLoadingOnReload` sich nicht immer wie dokumentiert verhalten, weil eine Aktualisierung auch ein Neuladen auslösen kann. Wenn Ihre Aktualisierung unerwartet einen Spinner aufblitzen lässt, ist diese Interaktion das Erste, was Sie prüfen sollten.

## Wo der veraltete `StateNotifier` hineinpasst

Die Suchanfrage, die Leute hierher führt, kombiniert `AsyncValue` oft mit `StateNotifier`, daher lohnt es sich, präzise zu sein, wie der Stand 2026 ist. Ab Riverpod 2.0 ersetzten `Notifier` und `AsyncNotifier` den `StateNotifier`, und in Riverpod 3 wurden die alten Typen `StateNotifier` und `StateNotifierProvider` aus der Haupt-Barrel-Datei heraus in `package:flutter_riverpod/legacy.dart` verschoben. Sie funktionieren weiterhin, sind aber nicht mehr die empfohlene API.

Wenn Sie einen `StateNotifier` haben, der asynchrone Daten bereitstellt, besteht der Kniff, der das Rendering mit allem oben Genannten identisch macht, darin, seinen Zustand selbst zu einem `AsyncValue` zu machen:

```dart
// Legacy pattern. Import from the legacy barrel in flutter_riverpod 3.x.
import 'package:flutter_riverpod/legacy.dart';

class ArticlesNotifier extends StateNotifier<AsyncValue<List<Article>>> {
  ArticlesNotifier(this._repo) : super(const AsyncLoading()) {
    _load();
  }
  final ArticleRepository _repo;

  Future<void> _load() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(_repo.fetchAll);
  }
}

final articlesProvider =
    StateNotifierProvider<ArticlesNotifier, AsyncValue<List<Article>>>(
  (ref) => ArticlesNotifier(ref.watch(articleRepositoryProvider)),
);
```

Da `state` ein `AsyncValue<List<Article>>` ist, ändert sich der Widget-Code überhaupt nicht: `ref.watch(articlesProvider).when(...)` funktioniert genau wie zuvor. Die Lektion ist, dass `AsyncValue` der UI-Vertrag ist; `AsyncNotifier` gegenüber `StateNotifier` betrifft nur, wie Sie ihn erzeugen. Wenn Sie migrieren, entfernt `AsyncNotifier` den Boilerplate (kein manueller Konstruktor `_load`, kein manuelles `AsyncLoading` im Konstruktor), weil `build` das für Sie erledigt. Der [offizielle Migrationsleitfaden von StateNotifier](https://riverpod.dev/docs/migration/from_state_notifier) führt durch die mechanische Ersetzung, und der umfassendere Leitfaden [wie man eine Flutter-App von GetX zu Riverpod migriert](/de/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) behandelt dieselbe `Notifier`- / `AsyncNotifier`-Übersetzung im Kontext einer vollständigen Migration.

## Häufige Stolperfallen

**Lesen Sie `requireValue` nicht in einem Ladezustand.** Es wirft `AsyncValueIsLoadingException`. Verwenden Sie es nur innerhalb des `data`-Zweigs oder nach Prüfung von `hasValue`. Wenn Sie nur einen Fallback wollen, verwenden Sie `valueOrNull ?? const []`.

**`isLoading` ist beim Aktualisieren true, nicht nur beim initialen Laden.** Wenn Sie `if (value.isLoading) return Spinner()` vor der Prüfung von `hasValue` schreiben, leeren Sie bei jeder Aktualisierung den Bildschirm. Bevorzugen Sie `.when()` (das `skipLoadingOnRefresh` respektiert) oder prüfen Sie `value.isLoading && !value.hasValue`, um "erstes Laden" von "Aktualisieren mit bereits vorhandenen Daten" zu unterscheiden.

**Eine leere Liste sind Daten, kein Laden.** Ein erfolgreicher Abruf, der `[]` zurückgibt, ist `AsyncData([])`, behandeln Sie den leeren Fall also innerhalb Ihres `data`-Zweigs (eine "Fügen Sie Ihren ersten Artikel hinzu"-Ansicht), nicht indem Sie leer als noch-ladend behandeln.

**Fehler während einer Mutation brauchen `guard`, Fehler in `build` nicht.** Innerhalb von `build` einfach `throw` (oder lassen Sie das Repository werfen); Riverpod erfasst es. Innerhalb einer imperativen Methode wie `add` müssen Sie mit `AsyncValue.guard` umhüllen, sonst entkommt die Exception dem Notifier und wird zu einem unbehandelten Fehler.

**Verwenden Sie ein typisiertes Fehlermodell, nicht `toString()`.** Bilden Sie Exception-Typen in einem einzigen Helfer auf benutzerseitigen Text ab. Wenn Ihr Datenmodell versiegelte Klassen oder `Freezed` verwendet, gilt derselbe Vollständigkeitsvorteil, den Sie von `AsyncValue` erhalten, auch für Ihre Domänenfehler; siehe [Dart records vs Freezed-Klassen](/de/2026/05/dart-records-vs-freezed-classes/) dafür, wann welches das richtige Werkzeug zu deren Modellierung ist.

## Die drei Zustände testen

Da der Zustand nur ein Wert ist, sind Tests unkompliziert: Bauen Sie einen `ProviderContainer`, überschreiben Sie das Repository mit einem Fake und stellen Sie Behauptungen über den `AsyncValue` auf.

```dart
// flutter_test + flutter_riverpod 3.x
test('emits AsyncError when the repository throws', () async {
  final container = ProviderContainer(overrides: [
    articleRepositoryProvider.overrideWithValue(ThrowingRepository()),
  ]);
  addTearDown(container.dispose);

  // Wait for the first build to settle.
  await container.read(articlesProvider.future).catchError((_) => <Article>[]);

  final state = container.read(articlesProvider);
  expect(state, isA<AsyncError>());
});
```

Überschreiben Sie das Repository so, dass es Daten, einen Fehler oder ein nie abschließendes Future zurückgibt, und Sie können jeden Zweig prüfen, den Ihre UI rendert. Das ist der praktische Nutzen davon, alle drei Zustände in einen einzigen typisierten Wert zu drücken: Provider, Widget und Test sprechen alle dieselbe Sprache. Wenn Sie verfolgen, warum ein Zustandsübergang ruckelt statt falsch zu sein, sagt Ihnen die Frame-Zeitachse in DevTools, ob ein Rebuild die Ursache ist; siehe [wie man Jank in einer Flutter-App mit DevTools profiliert](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/), um sie zu lesen.

## Quellen

- [AsyncValue-Klassenreferenz](https://pub.dev/documentation/riverpod/latest/riverpod/AsyncValue-class.html), Riverpod-API-Doku (`when`, `guard`, `requireValue`, `copyWithPrevious`).
- [Was ist neu in Riverpod 3.0](https://riverpod.dev/docs/whats_new) und der [Migrationsleitfaden von 2.0 auf 3.0](https://riverpod.dev/docs/3.0_migration), riverpod.dev.
- [Migration von StateNotifier](https://riverpod.dev/docs/migration/from_state_notifier), riverpod.dev.
- [Issue #4670 zum Verhalten von skipLoadingOnRefresh / skipLoadingOnReload](https://github.com/rrousselGit/riverpod/issues/4670), rrousselGit/riverpod.
