---
title: "Eine paginierte Liste mit unendlichem Scrollen in Flutter mit ScrollController bauen"
description: "Hängen Sie einen ScrollController an einen ListView.builder, fordern Sie die nächste Seite an, sobald position.extentAfter unter die Prefetch-Schwelle fällt, und sichern Sie die Anfrage mit isLoading-, hasMore- und error-Flags ab. Vollständige Implementierung plus die Falle der zu kurzen ersten Seite."
pubDate: 2026-08-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "listview"
  - "scrollcontroller"
  - "pagination"
  - "how-to"
lang: "de"
translationOf: "2026/08/how-to-build-an-infinite-scrolling-paginated-list-in-flutter-with-scrollcontroller"
translatedBy: "claude"
translationDate: 2026-08-04
---

Für eine Liste mit unendlichem Scrollen in Flutter hängen Sie einen `ScrollController` an einen `ListView.builder`, lauschen auf Scroll-Änderungen und fordern die nächste Seite an, sobald `position.extentAfter` unter eine Prefetch-Schwelle von einigen hundert Pixeln fällt. Der Listener selbst muss idempotent sein: Er feuert in jedem Scroll-Frame, deshalb gehört die eigentliche Anfrage hinter eine Absicherung aus `isLoading`/`hasMore`/`error`, sonst starten Sie während eines einzigen Wischens ein Dutzend identischer Anfragen. Dieser Beitrag baut das Ganze auf Flutter 3.44.8 (Dart 3.12.2) und behandelt danach die beiden Fehlerbilder, die in Produktion auftreten: die erste Seite, die zu kurz zum Scrollen ist, und die Wiederholungsschleife, die eine tote API überrennt.

## Warum `pixels >= maxScrollExtent` der falsche Auslöser ist

Fast jedes Tutorial fängt hier an:

```dart
// Flutter 3.44.8, Dart 3.12.2 -- do not ship this
_controller.addListener(() {
  if (_controller.position.pixels >= _controller.position.maxScrollExtent) {
    _loadMore();
  }
});
```

Daran sind drei Dinge falsch.

Erstens benachrichtigt ein `ScrollController` seine Listener bei jeder Änderung der Scroll-Position, während eines Wischens also einmal pro Frame bei 60Hz oder 120Hz. Ist `_loadMore()` ein ungesichertes `await api.fetch(...)`, bleibt die Bedingung die ganze Zeit wahr, in der die Liste am unteren Rand klebt, und Sie feuern in jedem Frame eine neue Anfrage, bis die erste Antwort eintrifft. Auf einem 120Hz-Gerät mit 300ms Umlaufzeit sind das rund 36 doppelte Anfragen.

Zweitens ist `maxScrollExtent` exakt der untere Anschlag. Darauf zu warten heißt, dass dem Nutzer der Inhalt bereits ausgegangen ist, bevor Sie überhaupt nachfordern, er starrt also für die Dauer eines Netzwerk-Umlaufs auf eine leere Fläche. Flutters Viewport baut über den sichtbaren Rand hinaus einen `cacheExtent` von `RenderAbstractViewport.defaultCacheExtent`, also `250.0` logische Pixel. Wer auslöst, solange in diesem Band noch Inhalt liegt, legt die Anfrage über den Scroll statt hinter ihn.

Drittens lässt sich `ScrollController.position` nicht bedingungslos anfassen. Der Getter steckt hinter zwei Asserts:

```dart
ScrollPosition get position {
  assert(_positions.isNotEmpty, 'ScrollController not attached to any scroll views.');
  assert(_positions.length == 1, 'ScrollController attached to multiple scroll views.');
  return _positions.single;
}
```

Beide feuern in Debug-Builds und beide sind aus gewöhnlichem Code erreichbar, wie die Stolperfallen weiter unten zeigen.

Die Korrektur der ersten beiden Punkte ist, auf `extentAfter` auszulösen. Die `ScrollPosition`-Dokumentation definiert das als die Menge an Inhalt, die konzeptionell unterhalb des Viewports liegt. Bei `extentAfter` von 400 hat der Nutzer noch 400 logische Pixel bereits gebauter Zeilen vor sich, was in der Regel genug Anlauf ist, um die Anfrage vollständig zu verbergen.

## In vier Schritten aufgebaut

Das ganze Muster besteht aus vier beweglichen Teilen. Alles andere ist Darstellung.

1. **Halten Sie den Paginierungszustand im `State`, nicht im Builder.** Sie brauchen die angesammelte `List<T>`, den Cursor oder die Seitennummer für die nächste Anfrage und drei Flags: `_isLoading`, `_hasMore` und `_error`. Genau diese drei Flags machen es sicher, den Scroll-Listener in jedem Frame aufzurufen.
2. **Hängen Sie einen `ScrollController` in `initState` an und lösen Sie ihn in `dispose` wieder.** Rufen Sie `removeListener` vor `dispose()` auf dem Controller auf und stoßen Sie die erste Seite aus `initState` an, damit die Liste im ersten Frame nie ohne Ladeanzeige leer bleibt.
3. **Lösen Sie über `extentAfter` aus, nicht über `pixels`.** Steigen Sie im Listener sofort aus, wenn der Controller keine Clients hat, wenn bereits eine Anfrage läuft, wenn der Server keine weiteren Seiten gemeldet hat oder wenn der letzte Versuch fehlgeschlagen ist. Erst danach vergleichen Sie `extentAfter` mit Ihrer Prefetch-Schwelle.
4. **Rendern Sie eine zusätzliche Zeile für den Endzustand.** Setzen Sie `itemCount` auf `items.length + 1`, solange es mehr zu laden oder einen Fehler anzuzeigen gibt, und lassen Sie `itemBuilder` für diesen letzten Index eine Ladeanzeige, eine Wiederholen-Zeile oder nichts liefern. Das macht aus dem Ladezustand etwas, das der Nutzer sieht und worauf er reagieren kann.

## Die vollständige Implementierung

```dart
// Flutter 3.44.8, Dart 3.12.2
class FeedPage extends StatefulWidget {
  const FeedPage({super.key});

  @override
  State<FeedPage> createState() => _FeedPageState();
}

class _FeedPageState extends State<FeedPage> {
  // Default viewport cacheExtent is 250.0 px, so 400 leaves runway.
  static const double _prefetchExtent = 400;
  static const int _pageSize = 20;

  final ScrollController _controller = ScrollController();
  final List<Post> _items = [];

  String? _cursor;
  bool _isLoading = false;
  bool _hasMore = true;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onScroll);
    _loadMore();
  }

  @override
  void dispose() {
    _controller.removeListener(_onScroll);
    _controller.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_controller.hasClients) return;
    if (_isLoading || !_hasMore || _error != null) return;
    if (_controller.position.extentAfter > _prefetchExtent) return;
    _loadMore();
  }

  Future<void> _loadMore() async {
    if (_isLoading || !_hasMore) return;

    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final page = await api.fetchFeed(after: _cursor, limit: _pageSize);
      if (!mounted) return;
      setState(() {
        _items.addAll(page.items);
        _cursor = page.nextCursor;
        _hasMore = page.nextCursor != null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e);
    } finally {
      _isLoading = false;
      if (mounted) setState(() {});
    }
  }

  @override
  Widget build(BuildContext context) {
    final bool showTail = _hasMore || _error != null;

    return ListView.builder(
      controller: _controller,
      itemCount: _items.length + (showTail ? 1 : 0),
      itemBuilder: (context, index) {
        if (index < _items.length) {
          return PostTile(post: _items[index]);
        }
        if (_error != null) {
          return _RetryTile(error: _error!, onRetry: _retry);
        }
        return const Padding(
          padding: EdgeInsets.all(16),
          child: Center(child: CircularProgressIndicator()),
        );
      },
    );
  }

  void _retry() {
    setState(() => _error = null);
    _loadMore();
  }
}
```

Beachten Sie die Trennung zwischen `_onScroll` und `_loadMore`. `_onScroll` verweigert die Ausführung, wenn `_error != null` gilt; `_loadMore` nicht. Diese Asymmetrie ist Absicht und unterbindet die weiter unten beschriebene Wiederholungsschleife. Der Scroll-Listener wiederholt eine fehlgeschlagene Seite nie automatisch, der Wiederholen-Button dagegen schon, weil er zuerst `_error` zurücksetzt.

Der `finally`-Block setzt `_isLoading = false` als einfache Zuweisung, bevor `mounted` geprüft wird. Steckt die Zuweisung in einem `setState`, das nur im gemounteten Zustand läuft, bleibt das Flag bei einem Unmount während der Anfrage auf true hängen. Für ein zerstörtes Widget ist das harmlos, es erschwert aber das Nachvollziehen der Zustandsmaschine, sobald dieselbe Controller-Logik später in einen Riverpod-Notifier wandert.

## Die zu kurze erste Seite, die nie scrollt

Das ist der Fehler, der am häufigsten in Produktion landet, weil er nur auf hohen Bildschirmen auftritt. Liefert Seite eins 20 Zeilen und passen 30 in den Viewport, dann ist `maxScrollExtent` gleich `0.0`, es lässt sich nicht scrollen, der `ScrollController` benachrichtigt nie, und die Liste bleibt dauerhaft bei 20 Einträgen. Auf einem Smartphone im Hochformat funktioniert das einwandfrei, auf einem Tablet, auf dem Desktop und im Web bei maximiertem Fenster sieht es kaputt aus.

`ScrollController` hilft hier nicht, weil nichts gescrollt wurde. Die günstigste Korrektur ist eine erneute Prüfung nach dem Frame, der die neuen Zeilen gelayoutet hat:

```dart
// Flutter 3.44.8: run after layout so maxScrollExtent is real.
void _fillViewportIfNeeded() {
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!mounted || !_controller.hasClients) return;
    if (_error != null || !_hasMore) return;
    if (_controller.position.maxScrollExtent == 0) _loadMore();
  });
}
```

Rufen Sie das am Ende des Erfolgszweigs von `_loadMore` auf. Es terminiert: Jeder Durchgang macht den Inhalt entweder höher als den Viewport (dann gilt `maxScrollExtent > 0`) oder erschöpft den Feed (dann wird `_hasMore` false).

Die vollständigere Lösung ist `ScrollMetricsNotification`. Flutter versendet diese Benachrichtigung, wenn sich die `ScrollMetrics` eines Scrollables ändern, ohne dass gescrollt wurde, unter anderem wenn der Inhalt wächst oder schrumpft und wenn das übergeordnete Fenster seine Größe ändert. Die Liste darin zu verpacken deckt den Tablet-Fall ab, das Ändern der Fenstergröße auf dem Desktop und den Fall, dass die Bildschirmtastatur schließt und der Viewport schlagartig höher wird:

```dart
// Flutter 3.44.8, Dart 3.12.2
NotificationListener<ScrollMetricsNotification>(
  onNotification: (notification) {
    if (notification.metrics.maxScrollExtent == 0 && _error == null) {
      _loadMore();
    }
    return false; // let it keep bubbling
  },
  child: ListView.builder(/* ... */),
)
```

Geben Sie aus `onNotification` `false` zurück. `true` beendet den Weg der Benachrichtigung nach oben durch den Baum und zerstört damit stillschweigend jeden Vorfahren, der darauf angewiesen ist, etwa einen `Scrollbar` oder einen `RefreshIndicator`.

## Die Wiederholungsschleife, die eine tote API überrennt

Angenommen, die Absicherung in `_onScroll` wäre nur `if (_isLoading || !_hasMore) return;`. Der Nutzer ist am unteren Rand, die Anfrage schlägt fehl, `_isLoading` wird false, `_hasMore` ist weiterhin true, und die Position hat sich nicht bewegt. Die nächste Scroll-Benachrichtigung, die schon bei der nächsten Mikrobewegung des Daumens eintrifft, ruft `_loadMore` erneut auf. Jeder Fehlschlag erzeugt sofort die nächste Anfrage, aus einem Netzausfall wird also eine Anfrageflut, die das Funkmodul wachhält und den Akku leert.

`_error != null` in der Scroll-Absicherung macht den Fehlschlag zu einem Endzustand, den nur eine ausdrückliche Nutzeraktion auflöst. Wenn Sie automatische Erholung möchten, legen Sie sie hinter einen Backoff statt hinter den Scroll-Listener und begrenzen Sie die Versuche. Die allgemeine Form davon, samt der Frage, welche Exceptions eine Wiederholung wert sind, steht in [Netzwerkfehler in einer Flutter-App sauber behandeln](/de/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/).

## Stolperfallen, die Sie treffen werden

1. **`ScrollController not attached to any scroll views.`** `.position` vor dem ersten Layout zu lesen oder nachdem der `ListView` verschwunden ist, löst dieses Assert aus. Leicht zu treffen aus einem Post-Frame-Callback, der ein `Navigator.pop` überlebt. Sichern Sie jeden Zugriff mit `hasClients` ab, das nichts anderes ist als `_positions.isNotEmpty`.
2. **`ScrollController attached to multiple scroll views.`** Ein Controller kann nur dann eine Position melden, wenn genau ein Scrollable ihn nutzt. Denselben `_controller` an zwei `ListView` in einer `TabBarView` zu geben ist der klassische Einstieg. Jeder Tab braucht seinen eigenen Controller und seinen eigenen Paginierungszustand.
3. **Offset-Paginierung verschiebt sich in einem lebenden Feed.** Fügt der Server eine Zeile ein, während der Nutzer zwischen Seite 2 und 3 steht, liefert `?page=3&size=20` ein Fenster, das sich mit Seite 2 überlappt, der Nutzer sieht also einen Eintrag doppelt und einen gar nicht. Cursor-Paginierung kennt dieses Fehlerbild nicht, deshalb reicht das Beispiel oben einen `nextCursor` durch statt eines Seitenindex. Die serverseitige Hälfte samt SQL und benötigtem Index steht in [Keyset-Paginierung (Cursor) in EF Core 11](/de/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/).
4. **`setState` nach `dispose`.** Jedes `await` in `_loadMore` ist eine Stelle, an der der Nutzer zurück tippen kann. Das `if (!mounted) return;` nach jedem await ist nicht optional; ohne es erhalten Sie `setState() called after dispose()`. Die vollständige Regel, samt der Begründung, warum `mounted` nach jeder Unterbrechung erneut geprüft werden muss statt nur einmal am Anfang, steht in [setState mit der mounted-Prüfung nach einer asynchronen Unterbrechung absichern](/de/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/).
5. **Der Controller ist eine Ressource, die Ihnen gehört.** `ScrollController` erweitert `ChangeNotifier`; entsorgt der erzeugende `State` ihn nicht, hält das Listener-Closure den `State` und alles darin Erfasste am Leben. Das ist dieselbe Klasse von Speicherleck wie ein nicht entsorgter `TextEditingController` oder `AnimationController`, behandelt in [Controller in Flutter entsorgen und Speicherlecks vermeiden](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).
6. **`shrinkWrap: true` zerstört den ganzen Zweck.** Eine Liste mit Shrink Wrap baut zur eigenen Vermessung alle Kinder im ersten Frame, eine unendliche Liste wird damit zu einem unbegrenzt wachsenden Erst-Frame-Aufwand. Wenn Sie danach gegriffen haben, um einen Fehler wegen unbegrenzter Höhe stillzulegen, sind die richtigen Alternativen aufgeschlüsselt in [shrinkWrap vs Expanded vs Slivers für lange Listen](/de/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).

## Wann `NotificationListener` statt eines Controllers

`ScrollController` ist nicht der einzige Weg, Scroll-Metriken zu lesen. Ein `NotificationListener<ScrollNotification>` bekommt dieselben Zahlen über `notification.metrics`, ohne überhaupt einen Controller zu besitzen:

```dart
// Flutter 3.44.8, Dart 3.12.2
NotificationListener<ScrollEndNotification>(
  onNotification: (notification) {
    if (notification.metrics.extentAfter < 400) _loadMore();
    return false;
  },
  child: ListView.builder(/* ... */),
)
```

Das ist die bessere Wahl, wenn Ihnen das Scrollable nicht gehört: innerhalb eines `NestedScrollView`, unter einem `PrimaryScrollController`, oder wenn die Liste ein `CustomScrollView` mit mehreren Sliver-Abschnitten ist und ein einzelner Controller nicht eindeutig sagt, welchen davon Sie meinen. `ScrollEndNotification` feuert zudem deutlich seltener als ein Controller-Listener, was die Frage nach dem Aufwand pro Frame erledigt, allerdings um den Preis, dass mitten im Wisch nicht vorgeladen wird.

Der Controller ist besser, wenn Sie den Scroll auch *steuern* müssen: `jumpTo`, `animateTo`, einen Offset wiederherstellen oder zu einem frisch eingefügten Element scrollen. Teilt sich Ihre Liste den Viewport mit anderem Inhalt, gelten die Sliver-Entsprechungen unverändert; die Paginierungslogik ist identisch, es ändert sich nur das umschließende Widget, wie in [einen ListView und einen GridView in einem Scroll mit Slivers mischen](/de/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/).

## Ob sich das Paket lohnt

`infinite_scroll_pagination` 5.1.1 verpackt diese Zustandsmaschine als `PagingController` plus `PagedListView` und `PagingListener` und übernimmt die Endzustände, den Fall der zu kurzen ersten Seite und die Anbindung an Pull-to-Refresh. Für eine App mit vielen paginierten Bildschirmen ist das eine vernünftige Abhängigkeit, denn die Alternative ist, den obigen `State` fünfmal zu kopieren.

Schreiben Sie es von Hand, wenn Sie ein oder zwei paginierte Listen haben, wenn Ihr Paginierungszustand ohnehin in Riverpod oder Bloc liegt (dann ist der Controller nur noch ein Auslöser und der paketeigene Controller überflüssig), oder wenn der Paging-Vertrag Ihrer API ungewöhnlich genug ist, dass Sie gegen die Abstraktion arbeiten würden. Wenn Sie das an Riverpod anbinden, bilden sich Lade- und Fehlerzweig sauber auf `AsyncValue` ab, behandelt in [Lade- und Fehlerzustände mit AsyncValue in Flutter Riverpod anzeigen](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## Quellen

- [ScrollPosition class](https://api.flutter.dev/flutter/widgets/ScrollPosition-class.html), Flutter-API-Dokumentation (`extentAfter`, `maxScrollExtent`, `atEdge`)
- [ScrollController class](https://api.flutter.dev/flutter/widgets/ScrollController-class.html), Flutter-API-Dokumentation (`hasClients`, `position`, `keepScrollOffset`)
- [ScrollMetricsNotification class](https://api.flutter.dev/flutter/widgets/ScrollMetricsNotification-class.html), Flutter-API-Dokumentation
- [RenderAbstractViewport.defaultCacheExtent](https://api.flutter.dev/flutter/rendering/RenderAbstractViewport/defaultCacheExtent-constant.html), Flutter-API-Dokumentation
- [Flutter 3.44.0 Release Notes](https://docs.flutter.dev/release/release-notes/release-notes-3.44.0), Flutter-Dokumentation
- [infinite_scroll_pagination auf pub.dev](https://pub.dev/packages/infinite_scroll_pagination)
