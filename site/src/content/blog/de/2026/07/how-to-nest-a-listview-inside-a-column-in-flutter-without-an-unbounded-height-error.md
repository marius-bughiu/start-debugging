---
title: "Wie man in Flutter eine ListView in eine Column verschachtelt, ohne den Unbounded-Height-Fehler"
description: "Warum eine ListView in einer Column den Fehler 'Vertical viewport was given unbounded height' wirft, und die vier Lösungen (Expanded, Flexible, shrinkWrap, SizedBox) mit den Performance-Kompromissen, die entscheiden, welche Sie wollen."
pubDate: 2026-07-02
tags:
  - "flutter"
  - "dart"
  - "layout"
  - "listview"
  - "constraints"
lang: "de"
translationOf: "2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error"
translatedBy: "claude"
translationDate: 2026-07-02
---

Setzen Sie eine `ListView` direkt in eine `Column`, und Flutter wirft den Fehler, bevor auch nur ein Pixel gezeichnet wird: `Vertical viewport was given unbounded height`, meist gefolgt von einer Wand aus `RenderBox`-Diagnosen. Die kurze Antwort: Eine `Column` übergibt ihren Kindern unbegrenzten vertikalen Raum, und eine scrollbare `ListView` weigert sich, in eine unendliche Höhe zu rendern, weil sie keine Ahnung hätte, wie hoch sie sein soll. Sie beheben das, indem Sie der Liste eine begrenzte Höhe geben, und das richtige Werkzeug ist fast immer `Expanded` (den übrigen Raum füllen), wenn die Liste die einzige scrollbare Fläche ist, oder `shrinkWrap: true`, wenn die Liste kurz und endlich ist. Dieser Beitrag erklärt, warum der Fehler auftritt, zeigt die minimale Reproduktion und geht alle vier Lösungen unter Flutter 3.x durch (getestet mit 3.44), damit Sie die passende wählen, nicht nur die, die die Exception zum Schweigen bringt.

## Warum eine Column ihren Kindern unbegrenzte Höhe gibt

Das Layout von Flutter läuft nach einer einzigen Regel: Constraints gehen nach unten, Größen kommen nach oben. Ein Elternteil teilt jedem Kind die minimale und maximale Breite und Höhe mit, die es einnehmen darf, das Kind wählt eine Größe innerhalb dieser Grenzen, und das Elternteil positioniert es. Das gesamte Framework ist dieser Handschlag, den Baum hinab wiederholt.

Eine `Column` ist ein `Flex`-Widget, das entlang der vertikalen Achse angeordnet ist. Entlang ihrer Hauptachse (vertikal) erzwingt sie **keine** maximale Höhe für ihre nicht flexiblen Kinder. Sie sagt jedem Kind sinngemäß: "Sei so hoch, wie du willst, ich stapele dich und messe die Summe danach." In Constraint-Begriffen erhält das Kind `maxHeight: double.infinity`. Genau das bedeutet "unbounded" (unbegrenzt): Der eingehende Höhen-Constraint hat kein endliches Maximum.

Den meisten Widgets ist das recht. Ein `Text`, eine `Row`, ein `Icon`, ein `Container` mit Kindern: Sie alle bemessen sich nach ihrem Inhalt, sodass eine unendliche Obergrenze nie eine Rolle spielt. Sie melden eine konkrete Höhe zurück, und die `Column` summiert sie.

Eine `ListView` ist anders. Sie ist ein scrollbarer Viewport, und die gesamte Aufgabe eines Viewports besteht darin, ein festes Fenster auf Inhalt zu sein, der weit größer als er selbst sein kann. Dafür muss sie wissen, wie hoch das Fenster ist. Entlang ihrer Scroll-Achse (vertikal) versucht eine `ListView`, sich auszudehnen, um die gesamte angebotene Höhe zu füllen. Bieten Sie ihr unendlich an, würde sie versuchen, unendlich hoch zu werden, was den Zweck des Scrollens zunichtemacht und nicht angeordnet werden kann. Statt also stillschweigend ein kaputtes Layout zu erzeugen, wirft das Framework die Assertion:

```
The following assertion was thrown during performResize():
Vertical viewport was given unbounded height.
Viewports expand in the scrolling direction to fill their container. In this
case, a vertical viewport was given an unlimited amount of vertical space in
which to expand.
```

Klar gesagt: Eine `Column` sagt "nimm so viel Höhe, wie du willst", eine `ListView` sagt "ich funktioniere nur, wenn du mir genau sagst, wie viel Höhe ich bekomme", und die beiden sind unvereinbar, bis Sie ein Widget einfügen, das die Höhe auflöst. Das ist dieselbe Fehlerfamilie wie [RenderBox was not laid out](/de/2026/06/fix-renderbox-was-not-laid-out-in-flutter/), bei der ein fehlender Größen-Constraint das Layout vor dem Zeichnen stoppt.

## Die minimale Reproduktion

Hier ist das kleinste Widget, das das reproduziert. Nichts Exotisches, nur eine Überschrift, die über einer Liste gestapelt ist:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class ProfilePage extends StatelessWidget {
  const ProfilePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const Text('Recent activity'),
        ListView(
          children: const [
            ListTile(title: Text('Item 1')),
            ListTile(title: Text('Item 2')),
            ListTile(title: Text('Item 3')),
          ],
        ),
      ],
    );
  }
}
```

Führen Sie es aus, und Sie erhalten die Unbounded-Height-Assertion in dem Moment, in dem dieser Teilbaum sein Layout durchführt. Die `Column` bot der `ListView` unendliche Höhe an; die `ListView` gab auf. Alles Folgende ist ein Weg, zu ändern, welche Höhe die `ListView` erhält.

## Lösung 1: Expanded, wenn die Liste den übrigen Raum füllen soll

Das ist die Lösung, die Sie meistens wollen. `Expanded` ist ein Flex-Kind, das der `Column` sagt, ihm den gesamten vertikalen Raum zu geben, der übrig bleibt, nachdem die nicht flexiblen Kinder gemessen wurden. Da "der gesamte übrige Raum" eine konkrete Zahl ist, sobald die `Column` ihre eigene Höhe kennt, erhält die `ListView` nun einen begrenzten `maxHeight` und führt ihr Layout normal durch, wobei sie das vollständige, träge Scrollen beibehält.

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Recent activity'),
    Expanded(
      child: ListView(
        children: const [
          ListTile(title: Text('Item 1')),
          ListTile(title: Text('Item 2')),
          ListTile(title: Text('Item 3')),
        ],
      ),
    ),
  ],
)
```

Die Mechanik: `Expanded` setzt den Flex-Faktor seines Kindes und erzwingt eine feste Höhe, die seinem Anteil am freien Raum entspricht. Die `Column` misst zuerst den `Text`, zieht ihn von ihrer eigenen Höhe ab und übergibt den Rest an `Expanded`, das ihn als begrenzten Constraint nach unten weitergibt. Die `ListView` füllt genau dieses Fenster und scrollt ihre Kinder darin. Das ist die korrekte Wahl, wann immer die Liste die wichtigste scrollbare Region des Bildschirms ist und Sie möchten, dass sie mit der verfügbaren Höhe wächst und schrumpft, was der überwiegend häufige Fall ist (eine Überschrift über einem Feed, ein Formularfeld über Ergebnissen, ein Titel über einem Chat-Protokoll).

Eine Voraussetzung: Die `Column` selbst muss eine begrenzte Höhe haben, damit `Expanded` etwas zum Aufteilen hat. Im Body eines `Scaffold`, in einem `SizedBox` mit einer Höhe oder in jedem Elternteil, das den vertikalen Raum bereits begrenzt, hat sie das. Steht die `Column` ihrerseits in einem anderen unbegrenzten Kontext, haben Sie dasselbe Problem eine Ebene nach oben geschoben und müssen zuerst die äußere Box begrenzen.

Wenn Sie möchten, dass die Liste den übrigen Raum einnimmt, aber auch unter ihren Anteil schrumpfen darf, wenn der Inhalt klein ist, verwenden Sie `Flexible` statt `Expanded`. `Expanded` ist `Flexible` mit `fit: FlexFit.tight`; ein einfaches `Flexible` verwendet `FlexFit.loose`, was "bis zu so viel, aber nicht mehr, als dein Inhalt braucht" bedeutet. Für eine `ListView`, die ihre Achse füllen will, verhalten sich die beiden in der Praxis gleich, greifen Sie also zu `Expanded`, es sei denn, Sie haben ein gemischtes Layout, in dem die Lockerheit eine Rolle spielt.

## Lösung 2: shrinkWrap, wenn die Liste kurz und endlich ist

Wenn die Liste eine kleine, einigermaßen bekannte Anzahl von Elementen hat und Sie möchten, dass sie genau so hoch wie ihr Inhalt ist (damit die `Column` weitere Widgets darunter stapeln kann), setzen Sie `shrinkWrap: true`:

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Recent activity'),
    ListView(
      shrinkWrap: true,
      children: const [
        ListTile(title: Text('Item 1')),
        ListTile(title: Text('Item 2')),
        ListTile(title: Text('Item 3')),
      ],
    ),
    const Text('End of list'),
  ],
)
```

`shrinkWrap: true` kehrt das Verhalten des Viewports um: Statt sich auszudehnen, um seine Achse zu füllen, misst er alle seine Kinder, summiert ihre Höhen und bemisst sich nach dieser Summe. Nun meldet er eine endliche Höhe nach oben an die `Column`, die Assertion ist weg, und Sie können Widgets sowohl darüber als auch darunter platzieren.

Die Kosten sind real und es lohnt sich, sie zu verstehen. Eine normale `ListView` ist träge: Sie baut und layoutet nur die aktuell im Viewport sichtbaren Elemente plus einen kleinen Cache. Das hält eine Liste mit 10.000 Zeilen bei 60fps. `shrinkWrap: true` verwirft das, denn um seine Gesamthöhe zu kennen, muss der Viewport **alle** seine Kinder im Voraus bauen und messen. Für eine Handvoll Elemente ist das nichts. Für eine lange oder unbegrenzte Liste bedeutet es, Tausende von Widgets im ersten Frame zu bauen, was die Layout-Zeit in die Höhe treibt und das Jank verursacht, das Sie in der Timeline beobachten können (siehe [wie man Jank in einer Flutter-App mit DevTools profiliert](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)). Eine `shrinkWrap`-Liste scrollt auch nicht unabhängig im üblichen Sinne; sie wächst, um zu passen, und wenn die gesamte `Column` überläuft, sind Sie zurück bei einer [RenderFlex overflowed](/de/2026/05/fix-renderflex-overflowed-in-flutter/)-Warnung. Die Faustregel: `shrinkWrap` ist für kurze, begrenzte Listen (ein paar Einstellungszeilen, ein festes Menü), nicht für Feeds.

Wenn Sie `shrinkWrap` verwenden und die äußere `Column` dennoch scrollen soll, wenn alles zusammen zu hoch ist, umschließen Sie die `Column` mit einem `SingleChildScrollView` und setzen die innere `ListView` auf `physics: const NeverScrollableScrollPhysics()`, damit sich die beiden scrollbaren Flächen nicht streiten:

```dart
// Flutter 3.x (tested 3.44)
SingleChildScrollView(
  child: Column(
    children: [
      const Text('Recent activity'),
      ListView(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        children: const [
          ListTile(title: Text('Item 1')),
          ListTile(title: Text('Item 2')),
        ],
      ),
    ],
  ),
)
```

## Lösung 3: SizedBox, wenn Sie die genaue Höhe kennen

Wenn die Liste einen festen Ausschnitt des Bildschirms einnimmt, umschließen Sie sie mit einem `SizedBox` mit einer konkreten Höhe. Das ist die direkteste Antwort auf den Fehler: Die `ListView` fragte, wie hoch sie sein soll, und Sie haben es ihr gesagt.

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Recent activity'),
    SizedBox(
      height: 240,
      child: ListView(
        children: const [
          ListTile(title: Text('Item 1')),
          ListTile(title: Text('Item 2')),
          ListTile(title: Text('Item 3')),
        ],
      ),
    ),
  ],
)
```

Der `SizedBox` erzwingt `maxHeight: 240` für die `ListView`, die diese 240 logischen Pixel füllt und ihren Inhalt träge darin scrollt, wobei sie den Performance-Vorteil behält, den `shrinkWrap` aufgibt. Das ist richtig für horizontale Karussells (eine Reihe von Karten fester Höhe innerhalb einer vertikalen `Column`) und jedes Design, bei dem die Höhe der Liste eine bewusste Konstante ist. Der Nachteil ist die magische Zahl: Fest verdrahtete Höhen passen sich nicht an verschiedene Bildschirmgrößen oder Textskalierungseinstellungen an, vermeiden Sie es also für eine Liste, die den übrigen Raum füllen soll. Dafür ist `Expanded` die adaptive Version derselben Idee.

## Lösung 4: die Column durch eine CustomScrollView mit Slivers ersetzen

Wenn die "Column" in Wirklichkeit eine scrollende Seite ist, die zufällig eine Liste enthält, ist die sauberste Struktur überhaupt keine `Column` mit einer verschachtelten `ListView`. Es ist eine einzige `CustomScrollView`, deren Abschnitte Slivers sind. Ein Viewport, eine Scroll-Physics, vollständige Trägheit, keine Verschachtelungskonflikte:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(
      child: Text('Recent activity'),
    ),
    SliverList.builder(
      itemCount: 3,
      itemBuilder: (context, index) => ListTile(
        title: Text('Item ${index + 1}'),
      ),
    ),
  ],
)
```

Ein Sliver ist eine scrollbare Region, die direkt mit dem übergeordneten Viewport aushandelt, wie viel sie zeichnet, sodass es keinen "Unbounded-Height"-Handschlag gibt, der scheitern könnte. `SliverToBoxAdapter` umschließt gewöhnliche Box-Widgets (Ihre Überschrift), und `SliverList.builder` ist die träge Liste. Greifen Sie dazu, wenn ein Bildschirm mehrere gestapelte scrollbare Abschnitte hat, eine Überschrift, die weggescrollt werden soll, oder eine Liste plus ein Gitter in einem durchgehenden Scroll. Es ist ausführlicher als eine `Column`, aber es ist das Layout, das Flutter für diese Form tatsächlich will, und es zwingt Sie nie, zwischen Korrektheit und Trägheit zu wählen.

## Welche Lösung verwende ich tatsächlich

- **Die Liste ist der Hauptinhalt unter einer Überschrift, soll den Bildschirm füllen:** `Expanded`. Behält die Trägheit, passt sich jeder Höhe an.
- **Ein paar feste Elemente, Sie wollen Widgets darüber und darunter in derselben `Column`:** `shrinkWrap: true`. Günstig, weil die Liste kurz ist.
- **Die Liste braucht eine bestimmte feste Höhe (Karussell, Mini-Liste):** `SizedBox(height: ...)`. Behält die Trägheit, explizit und einfach.
- **Der gesamte Bildschirm ist ein Scroll mit mehreren Abschnitten:** `CustomScrollView` mit Slivers. Die strukturell korrekte Antwort.

Die zu vermeidende Falle ist, reflexartig zu `shrinkWrap: true` zu greifen, weil es der kürzeste Diff ist. Es lässt den roten Fehler verschwinden, aber bei einer langen Liste tauscht es stillschweigend eine laute Layout-Assertion gegen eine stille Performance-Regression: jede Zeile im ersten Frame gebaut, verlorene Frames beim Laden, und Speicher, der mit der Elementanzahl statt mit der Viewport-Größe skaliert. Wenn die Liste wachsen kann, verwenden Sie `Expanded` oder Slivers, damit das Framework weiterhin Zeilen recyceln kann. Verwandte Debugging-Notizen finden sich in [Fix: RenderBox was not laid out](/de/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) und [Fix: A RenderFlex overflowed](/de/2026/05/fix-renderflex-overflowed-in-flutter/), den beiden Fehlern, auf die Sie beim Zusammenbau dessen am wahrscheinlichsten als Nächstes stoßen. Und wenn die Liste einen `ScrollController` verwendet, denken Sie daran, ihn [freizugeben](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/), damit Sie ihn nicht lecken, wenn das Widget ausgehängt wird.

## Das Ein-Zeilen-Denkmodell, das man behalten sollte

Eine `Column` gibt unbegrenzte Höhe; eine `ListView` verlangt begrenzte Höhe. Jede Lösung oben ist nur eine andere Art, die Frage "wie hoch?" zu beantworten -- `Expanded` sagt "der Rest", `SizedBox` sagt "genau dies", `shrinkWrap` sagt "so hoch wie meine Kinder", und Slivers sagen "lass den äußeren Viewport entscheiden". Sobald Sie den Fehler als "du hast vergessen, der scrollbaren Fläche ihre Höhe mitzuteilen" lesen, ist die Lösung jedes Mal offensichtlich.

## Quellen

- [Flutter-Dokumentation: Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) -- das Modell "Constraints gehen nach unten, Größen kommen nach oben" und die Box, die über begrenzt vs. unbegrenzt entscheidet.
- [Klasse ListView, Flutter-API-Referenz](https://api.flutter.dev/flutter/widgets/ListView-class.html) -- `shrinkWrap`, das Viewport-Verhalten und der Performance-Hinweis zum Bauen aller Kinder.
- [Klasse Expanded, Flutter-API-Referenz](https://api.flutter.dev/flutter/widgets/Expanded-class.html) -- der Flex-Fit und wie der übrige Raum in einer `Column` oder `Row` aufgeteilt wird.
- [Klasse CustomScrollView, Flutter-API-Referenz](https://api.flutter.dev/flutter/widgets/CustomScrollView-class.html) -- Slivers in einem einzigen Viewport kombinieren.
