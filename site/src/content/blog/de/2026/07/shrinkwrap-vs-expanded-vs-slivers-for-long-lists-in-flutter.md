---
title: "shrinkWrap vs Expanded vs Slivers für lange Listen in Flutter: Was sollten Sie wählen?"
description: "Für eine lange Liste sollten Sie niemals shrinkWrap verwenden. Nutzen Sie Expanded, wenn die Liste das einzige Scrollable ist, und Slivers (CustomScrollView), wenn sie sich das Scrollen mit anderen Abschnitten teilt. Hier ist das Warum, mit einem Build-Count-Benchmark."
pubDate: 2026-07-07
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "layout"
  - "listview"
  - "slivers"
lang: "de"
translationOf: "2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-07
---

Für eine lange Liste in Flutter ist die Rangfolge eindeutig: Verwenden Sie `Expanded`, wenn die Liste das einzige Scrollable unter einer Kopfzeile ist, und wechseln Sie zu Slivers (einem `CustomScrollView`), sobald sich die Liste das Scrollen mit anderen Abschnitten teilt. Greifen Sie bei einer langen Liste niemals zu `shrinkWrap: true`. Es ist das kürzeste Diff und bringt den Layout-Fehler zum Schweigen, zwingt die Liste aber auch dazu, jedes Element im ersten Frame zu erstellen, und wirft damit das faule Recycling weg, das ein Scrollen bei 60fps hält. Dieser Artikel lässt die drei auf Flutter 3.x gegeneinander antreten (getestet auf 3.44, Dart 3.x), mit einer Feature-Matrix, einem Build-Count-Benchmark, der die genauen Kosten zeigt, und dem einen Detail, das für Sie entscheidet.

Die drei sind keine austauschbaren Regler desselben Widgets. `Expanded` und `shrinkWrap` sind zwei Wege, die Frage "Wie hoch ist dieses `ListView` in einem `Column`?" zu beantworten, während Slivers die Form `Column` plus `ListView` vollständig ersetzen. Sie kollidieren, weil sie die drei Antworten sind, die Leute ausprobieren, wenn ein `ListView` in einem `Column` `Vertical viewport was given unbounded height` wirft. Wenn diese Assertion Sie hierher gebracht hat, finden Sie die vollständige Ursachenanalyse in [wie man ein ListView in einem Column ohne einen Unbounded-Height-Fehler verschachtelt](/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/); dieser Artikel ist die schärfere Frage, welche Lösung man behält, sobald der rote Bildschirm verschwunden ist.

## Die Feature-Matrix

| Eigenschaft                                | `shrinkWrap: true`     | `Expanded`          | Slivers (`CustomScrollView`) |
| ------------------------------------------ | ---------------------- | ------------------- | ---------------------------- |
| Erstellt nur sichtbare Elemente (lazy)     | Nein, erstellt alles   | Ja                  | Ja                           |
| First-Frame-Kosten für N Elemente          | O(N)                   | O(viewport)         | O(viewport)                  |
| Der Speicher skaliert mit                  | Elementanzahl          | Viewport-Größe      | Viewport-Größe               |
| Funktioniert für unbegrenzte / wachsende Liste | Nein               | Ja                  | Ja                           |
| Benötigt begrenzte Höhe des Elternteils    | Nein                   | Ja (Elternteil muss)| Ja (Scaffold liefert sie)    |
| Mehrere scrollbare Abschnitte in einem     | Kämpft mit sich selbst | Nur eine Liste      | Ja, nativ                    |
| Einklappbare Kopfzeile (`SliverAppBar`)    | Nein                   | Nein                | Ja                           |
| Zeilen Boilerplate                         | 1                      | 3                   | ~6 pro Abschnitt             |

Lesen Sie zuerst die oberen drei Zeilen. Sie sind das gesamte Argument. `shrinkWrap` ist das einzige der drei, dessen Kosten mit der Anzahl der Elemente wachsen, und "lange Liste" ist genau der Fall, in dem diese Kosten zubeißen.

## Warum shrinkWrap O(N) ist und die anderen beiden nicht

Ein normales `ListView` ist ein fauler Viewport: Es erstellt und layoutet nur die in seinem Fenster sichtbaren Elemente plus eine kleine Cache-Erweiterung und recycelt diese Widgets dann beim Scrollen. Erstellen Sie eine Liste mit 10.000 Zeilen, und es existieren zu jedem Zeitpunkt nur ~15 Zeilen. Diese Faulheit ist die gesamte Performance-Geschichte von Flutter-Listen.

`shrinkWrap: true` schaltet das ab. Um sich an seinen Inhalt anzupassen (statt seine Achse zu füllen), muss der Viewport seine Gesamthöhe kennen, und der einzige Weg, das zu wissen, ist, jedes Kind im Voraus zu erstellen und zu messen. `shrinkWrap` verwandelt also eine faule Liste in eine eifrige: N Elemente bedeuten N Build-Aufrufe im ersten Frame, N `RenderBox`-Layouts und Speicher proportional zu N. Für die drei Einstellungszeilen, an denen Leute es üblicherweise testen, ist das nichts. Für einen Feed ist es ein Stillstand im ersten Frame, den Sie in der Zeitachse sehen können (siehe [wie man Jank in einer Flutter-App mit DevTools profiliert](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)).

`Expanded` hält die Liste faul. Es ist ein `Flex`-Kind, das eine feste Höhe erzwingt, die dem Platz entspricht, der übrig bleibt, nachdem das `Column` seine anderen Kinder gemessen hat. Das `ListView` erhält eine begrenzte `maxHeight`, füllt genau dieses Fenster und recycelt darin Zeilen. Die Kosten sind O(viewport), unabhängig von der Elementanzahl.

Slivers halten die Liste ebenfalls faul, durch einen anderen Mechanismus: Ein `SliverList` muss seine Gesamthöhe nie kennen. Es verhandelt direkt mit dem übergeordneten Viewport ("du bist zum Offset X gescrollt, ich zeichne die Kinder in diesem Bereich"), sodass es keinen Unbounded-Height-Handshake gibt und keinen Grund, Kinder außerhalb des Bildschirms zu erstellen. Die Kosten sind erneut O(viewport).

## Der Build-Count-Benchmark

Der sauberste Weg, dies zu messen, sind nicht Millisekunden (die je nach Maschine variieren), sondern die Anzahl der Element-Builds im ersten Frame, die deterministisch und mechanismusbasiert ist. Instrumentieren Sie jedes Element mit einem Zähler:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
int buildCount = 0;

Widget itemBuilder(BuildContext context, int index) {
  buildCount++;                 // increment on every item build
  return ListTile(title: Text('Row $index'));
}
```

Rendern Sie eine Liste mit 5.000 Elementen auf drei Arten und lesen Sie `buildCount` nach dem ersten Frame (`WidgetsBinding.instance.addPostFrameCallback`). Die Ergebnisse sind eindeutig:

| Layout für 5.000 Elemente          | Element-Builds im ersten Frame | Skaliert mit    |
| ---------------------------------- | ------------------------------ | --------------- |
| `ListView(shrinkWrap: true)`       | 5.000                          | Elementanzahl   |
| `Expanded(child: ListView)`        | ~12 bis 15                     | nur Viewport    |
| `SliverList` in `CustomScrollView` | ~12 bis 15                     | nur Viewport    |

Die genaue Zahl im faulen Modus hängt von der Zeilenhöhe und der Standard-`cacheExtent` ab (250 logische Pixel über den Viewport hinaus auf jeder Seite), aber die Form ist fest: `shrinkWrap` erstellt alle 5.000, die anderen beiden erstellen nur, was hineinpasst, plus den Cache. Auf einem Pixel 7 im Profile-Modus überschritt der `shrinkWrap`-First-Frame das 16ms-Budget deutlich, um diese 5.000 Tiles zu erstellen, während die `Expanded`- und Sliver-Versionen den ersten Frame innerhalb des Budgets rendern und beim Scrollen dabei blieben. Die Zahl, die zählt, ist das Verhältnis: ~5.000 Builds gegenüber ~15, ein Unterschied, der jedes Mal wächst, wenn die Liste wächst.

Um dies selbst zu reproduzieren, führen Sie im Profile-Modus aus (`flutter run --profile`), nicht im Debug-Modus, da die Messungen im Debug-Modus von Assertions dominiert werden und nicht repräsentativ sind. Das Build-Count-Verhältnis ist in jedem Modus identisch; nur die Wanduhrzeit unterscheidet sich.

## Wann Sie Expanded wählen sollten

`Expanded` ist die richtige Antwort, wenn die Liste die einzige scrollbare Region des Bildschirms ist und unter (oder über) einem festen Chrome sitzt.

- **Eine Kopfzeile über einem Feed, getestet auf Flutter 3.44.** Ein Titel oder eine Suchleiste in einem `Column`, dann füllt die Liste den Rest. `Expanded` gibt der Liste die gesamte übrige Höhe und hält sie faul.
- **Eine Liste, die mit dem Bildschirm wächst und schrumpft.** Da `Expanded` den verfügbaren Platz aufteilt, statt ihn im Code fest zu verdrahten, passt sich die Liste an unterschiedliche Gerätehöhen und Textskalierungseinstellungen an, anders als eine `SizedBox(height: ...)`.
- **Sie wollen den kürzesten Code, der korrekt bleibt.** Drei Zeilen, kein neues Widget-Vokabular, volle Faulheit. Für eine einzelne Liste schlägt das den Griff zu Slivers.

Die eine Voraussetzung: Das `Column` selbst muss eine begrenzte Höhe haben, damit `Expanded` etwas zum Aufteilen hat. Im Body eines `Scaffold` hat es das. Wenn das `Column` selbst in einem unbegrenzten Kontext steht, haben Sie das Problem nur eine Ebene nach oben verschoben.

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const SearchBar(),
    Expanded(
      child: ListView.builder(       // stays lazy
        itemCount: items.length,
        itemBuilder: (context, i) => ItemTile(items[i]),
      ),
    ),
  ],
)
```

## Wann Sie Slivers wählen sollten

Greifen Sie zu einem `CustomScrollView` mit Slivers, wenn die lange Liste nicht allein ist: Sie teilt sich ein Scrollen mit anderen Abschnitten, oder der Bildschirm braucht eine Kopfzeile, die aus dem Sichtbereich scrollt.

- **Zwei oder mehr scrollbare Abschnitte in einem Scrollen**, zum Beispiel eine Liste, die in ein Grid übergeht. Dieser Fall wird von Anfang bis Ende in [wie man ein ListView und ein GridView in einem Scroll mit Slivers mischt](/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) behandelt. Zwei `ListView` in einem `Column` zu stapeln und ihre Physics zu deaktivieren, ist das Antipattern, das Slivers ersetzen sollen.
- **Eine einklappbare oder schwebende Kopfzeile.** `SliverAppBar` mit `pinned`, `floating` oder `expandedHeight` ist fast kostenlos, sobald Sie bereits ein `CustomScrollView` haben. Es gibt kein auf `Column` basierendes Äquivalent.
- **Eine Kopfzeile, die mit dem Inhalt aus dem Sichtbereich scrollen soll.** `SliverToBoxAdapter` umschließt ein einzelnes Box-Widget zwischen faulen Abschnitten, sodass es auf natürliche Weise aus dem Sichtbereich scrollt.

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverAppBar(title: Text('Explore'), floating: true),
    SliverList.builder(              // lazy, shares the one scroll position
      itemCount: items.length,
      itemBuilder: (context, i) => ItemTile(items[i]),
    ),
  ],
)
```

Slivers sind ausführlicher, etwa sechs Zeilen pro Abschnitt statt drei, und diese Ausführlichkeit ist der einzige Grund, sie nicht für eine einzelne Liste zu verwenden. Wenn es genau ein Scrollable gibt, liefert `Expanded` dieselbe Faulheit mit weniger Zeremonie.

## Wann shrinkWrap tatsächlich in Ordnung ist

`shrinkWrap: true` ist kein Bug, es ist ein Werkzeug mit einem engen korrekten Einsatzbereich: eine **kurze, begrenzte** Liste, deren Elementanzahl Sie kontrollieren und die sich an ihren Inhalt anpassen muss, damit Widgets im selben `Column` über und unter ihr sitzen können.

- Ein Einstellungsbildschirm mit einer festen Handvoll Zeilen.
- Ein Dropdown oder Menü mit einer bekannten kleinen Menge an Optionen.
- Jede Liste, bei der N klein ist (einstellig, niedrige Zehnerbereiche) und durch das Design festgelegt, nicht durch Daten.

Sobald N durch Daten bestimmt wird, die wachsen können (Posts, Fotos, Suchergebnisse, Nachrichten), ist `shrinkWrap` das falsche Werkzeug, da seine Kosten mit diesen Daten wachsen. Wenn Sie es für eine kurze Liste in einem scrollbaren `Column` verwenden, setzen Sie außerdem `physics: const NeverScrollableScrollPhysics()`, damit die innere Liste nicht mit dem äußeren `SingleChildScrollView` um die Scroll-Geste kämpft.

```dart
// Flutter 3.x (tested 3.44) -- fine ONLY because this list is short and fixed
Column(
  children: [
    const Text('Settings'),
    ListView(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      children: const [
        SwitchListTile(title: Text('Notifications'), value: true, onChanged: null),
        SwitchListTile(title: Text('Dark mode'), value: false, onChanged: null),
      ],
    ),
  ],
)
```

## Das Detail, das für Sie entscheidet

Zwei Einschränkungen überstimmen die Vorliebe vollständig.

**Wenn die Liste unbegrenzt wachsen kann, ist `shrinkWrap` vom Tisch.** Es ist keine Frage des Geschmacks oder einiger verlorener Frames, die man tolerieren könnte. Ein unbegrenzter eifriger Build ist ein Korrektheits- und Speicherproblem: Build-Zeit und Speicher skalieren beide mit der Elementanzahl, sodass eine Liste, die im Test mit 20 Zeilen in Ordnung ist, den ersten Frame in der Produktion mit 2.000 für Hunderte von Millisekunden blockieren kann. Das Framework warnt Sie nicht, denn `shrinkWrap` hat genau das getan, worum Sie gebeten haben. Dies ist der häufigste Weg, auf dem eine Flutter-Liste still regrediert.

**Wenn Sie mehr als einen scrollbaren Abschnitt haben, sind Slivers die einzige saubere Antwort.** `Expanded` handhabt genau eine Liste. Zwei `Expanded`-Listen in einem `Column` teilen die Höhe zwischen sich in zwei separate Scroll-Views auf, was fast nie das ist, was Sie wollen. In dem Moment, in dem Sie eine Liste plus ein Grid haben, oder eine Liste plus eine weitere Liste, oder einen beliebigen Abschnitt, der als eine Fläche mit der Liste scrollen muss, ist ein `CustomScrollView` die strukturell korrekte Form und alles andere ist ein Workaround.

Alles andere, Bildschirmanpassbarkeit, Boilerplate, eine einklappbare Kopfzeile, ist ein Tiebreaker innerhalb dieser beiden harten Regeln.

## Die Empfehlung, erneut formuliert

Für eine lange Liste ordnen Sie sie: **Slivers, wenn sich die Liste das Scrollen mit irgendetwas anderem teilt, `Expanded`, wenn sie das einzige Scrollable ist, und `shrinkWrap` niemals.** Behalten Sie `shrinkWrap: true` nur für kurze, feste Listen in Ihrem Werkzeugkasten, die sich in einem `Column` an ihren Inhalt anpassen müssen. Die Falle ist, dass alle drei den Unbounded-Height-Fehler verschwinden lassen, sodass es leicht ist, jene auszuliefern, die auch still eine laute Layout-Assertion gegen eine Performance-Regression eintauscht, die erst unter echten Daten auftaucht. Lesen Sie die Wahl als "Wie halte ich die Liste faul?", und die Antwort ist immer `Expanded` oder Slivers, niemals `shrinkWrap`.

Wenn eine Zeile in einem dieser Fälle jemals ihre eigene Breite überläuft, ist das ein separates [RenderFlex overflowed](/2026/05/fix-renderflex-overflowed-in-flutter/)-Problem auf Tile-Ebene, das nichts mit der äußeren Layout-Wahl zu tun hat. Und welches Layout Sie auch wählen, wenn es einen `ScrollController` verwendet, denken Sie daran, ihn [zu disposen](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/), damit Sie ihn nicht lecken, wenn das Widget ausgehängt wird.

## Quellen

- [ListView class, Flutter API reference](https://api.flutter.dev/flutter/widgets/ListView-class.html) -- `shrinkWrap`, Viewport-Verhalten und der explizite Hinweis, dass eine Shrink-Wrap-Liste alle ihre Kinder erstellt.
- [Expanded class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Expanded-class.html) -- Flex-Fit und wie ein `Column` den verbleibenden Platz aufteilt.
- [CustomScrollView class, Flutter API reference](https://api.flutter.dev/flutter/widgets/CustomScrollView-class.html) -- mehrere Slivers in einem einzigen faulen Viewport hosten.
- [Using slivers to achieve fancy scrolling, Flutter docs](https://docs.flutter.dev/ui/layout/scrolling/slivers) -- das Sliver-Protokoll und wie ein Viewport die Zeichen-Erweiterung aushandelt.
- [Flutter docs: Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) -- das Modell begrenzter vs unbegrenzter Höhe hinter dem gesamten Vergleich.
