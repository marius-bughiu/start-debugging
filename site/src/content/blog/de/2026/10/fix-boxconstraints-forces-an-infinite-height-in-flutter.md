---
title: "Fix: BoxConstraints forces an infinite height in Flutter"
description: "Ein Widget hat height: double.infinity angefordert, obwohl der Parent keine Höhenbegrenzung hat, etwa eine Column oder ListView. Verwenden Sie stattdessen Expanded, eine endliche Höhe, LimitedBox oder SliverFillRemaining."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "constraints"
lang: "de"
translationOf: "2026/10/fix-boxconstraints-forces-an-infinite-height-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-06
---

`BoxConstraints forces an infinite height` bedeutet, dass ein Widget exakt `double.infinity` Pixel Höhe angefordert hat und sein Parent keine Höhenbegrenzung hatte, auf die sich diese Anforderung zurechtstutzen ließe. Die üblichen Verdächtigen sind `SizedBox(height: double.infinity)`, `Container(height: double.infinity)`, `SizedBox.expand` oder `BoxConstraints.expand()`, direkt in einer `Column`, einer `ListView` oder einer `SingleChildScrollView` platziert. Die Lösung: Fordern Sie nichts "Unendliches" an, wo nichts endlich ist. Verwenden Sie `Expanded` innerhalb einer `Column`, geben Sie der Box eine konkrete Zahl, packen Sie sie in eine `LimitedBox`, oder wechseln Sie zu `SliverFillRemaining`, wenn der Rest des Bildschirms gefüllt werden soll, der Inhalt aber trotzdem scrollen muss. Alles Folgende wurde mit Flutter 3.44.8 (stable) und Dart 3.12.2 reproduziert.

Verwirrend ist, dass `height: double.infinity` eine völlig normale Schreibweise ist. Meistens funktioniert sie. Sie scheitert nur dann, wenn der nächste Vorfahre, der die Höhenbeschränkung setzt, sagt "wähle eine beliebige Höhe", und genau das sagen Columns und Scroll-Views.

## Der Fehler im Kontext

Dies ist der erste Block, den Flutter ausgibt. Den Stack Trace habe ich gekürzt, er umfasst etwa 100 Frames von `RenderProxyBoxMixin.performLayout`:

```
══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞═══════════════════════════════
The following assertion was thrown during performLayout():
BoxConstraints forces an infinite height.
These invalid constraints were provided to _RenderColoredBox's layout() function by the following
function, which probably computed the invalid constraints in question:
  RenderConstrainedBox.performLayout (package:flutter/src/rendering/proxy_box.dart:296:14)
The offending constraints were:
  BoxConstraints(0.0<=w<=800.0, h=Infinity)
The relevant error-causing widget was:
  SizedBox
```

Drei Zeilen enthalten alle nötigen Informationen:

- **`h=Infinity`** in den beanstandeten Constraints. Das ist eine *feste* unendliche Höhe: Minimum und Maximum sind beide unendlich. Das kann nichts erfüllen.
- **`RenderConstrainedBox.performLayout`** ist die Funktion, die sie berechnet hat. `RenderConstrainedBox` ist das Render-Objekt hinter `SizedBox`, `ConstrainedBox` und dem Größenanteil von `Container`. Der Übeltäter ist also fast immer eines dieser drei.
- **"The relevant error-causing widget was"** nennt Datei und Zeile dieses Widgets. Klicken Sie in Ihrer IDE darauf.

Unterhalb dieses Blocks folgt eine Kaskade von `RenderBox was not laid out`-Assertions, eine pro Vorfahre, dazu eine für `Scaffold`. Das sind Folgefehler. Beheben Sie den ersten Fehler, und alle verschwinden. Wenn Sie von dieser Kaskade hierhergekommen sind: Die [Erläuterung zu RenderBox was not laid out](/de/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) erklärt, warum sie sich so aufstaut.

Die Schwestermeldung `BoxConstraints forces an infinite width.` ist derselbe Fehler um 90 Grad gedreht, und `BoxConstraints forces an infinite width and infinite height.` sind beide zugleich. Alles in diesem Beitrag gilt für sie mit vertauschter Breite und Höhe.

## Warum das passiert

Das Flutter-Layout folgt einer Regel: Constraints gehen nach unten, Größen gehen nach oben, der Parent legt die Position fest. Jeder Parent übergibt seinem Kind ein `BoxConstraints` mit Minimum und Maximum für Breite und Höhe.

Wenn Sie `SizedBox(height: double.infinity)` schreiben, setzen Sie die Höhe nicht auf unendlich. Sie fordern feste Constraints mit `minHeight: infinity, maxHeight: infinity` an, und `RenderConstrainedBox` gleicht diese Anforderung dann mit dem ab, was sein eigener Parent erlaubt hat, über `BoxConstraints.enforce`:

```dart
// Flutter 3.44.8, package:flutter/src/rendering/box.dart (simplified)
BoxConstraints enforce(BoxConstraints constraints) {
  return BoxConstraints(
    minHeight: clampDouble(minHeight, constraints.minHeight, constraints.maxHeight),
    maxHeight: clampDouble(maxHeight, constraints.minHeight, constraints.maxHeight),
    // width is clamped the same way
  );
}
```

Dieses Begrenzen ist der Grund, warum die Schreibweise normalerweise funktioniert. Im Body eines `Scaffold` sagt der Parent `0 <= h <= 600`, also wird unendlich auf 600 begrenzt und die Box füllt den Bildschirm. Eine `Column` gibt dagegen jedem Kind ohne Flex auf der Hauptachse `0 <= h <= Infinity`, und eine vertikale `ListView` oder `SingleChildScrollView` tut dasselbe. Unendlich auf ein Maximum von unendlich zu begrenzen ergibt unendlich. Die resultierenden Constraints werden an `layout()` des Kindes übergeben, das `debugAssertIsValid(isAppliedConstraint: true)` ausführt, ein unendliches Minimum feststellt und eine Exception wirft.

Die Regel zum Merken: **`double.infinity` bedeutet "so groß, wie mein Parent es erlaubt". Das ist nur sicher, wenn der Parent etwas Endliches erlaubt.**

## Ein minimaler Reproduktionsfall zum Einfügen in eine neue App

Jeder dieser drei Bodies wirft den Fehler unter Flutter 3.44.8. Ich habe sie als Widget-Tests innerhalb von `MaterialApp(home: Scaffold(body: ...))` ausgeführt:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'package:flutter/material.dart';

// 1. A Column gives children unbounded height.
const columnRepro = Column(
  children: [
    Text('Header'),
    SizedBox(
      height: double.infinity,
      child: ColoredBox(color: Colors.red),
    ),
  ],
);

// 2. A vertical ListView gives children unbounded height.
final listRepro = ListView(
  children: [
    Container(height: double.infinity, color: Colors.red),
  ],
);

// 3. SizedBox.expand and BoxConstraints.expand() are the same request in disguise.
const scrollRepro = SingleChildScrollView(
  child: Column(
    children: [
      SizedBox.expand(child: ColoredBox(color: Colors.red)),
    ],
  ),
);
```

Die beanstandeten Constraints unterscheiden sich leicht: Der `Column`-Fall meldet `BoxConstraints(0.0<=w<=800.0, h=Infinity)`, weil die Querachse einer Column lose ist, während die Fälle `ListView` und `SizedBox.expand` `BoxConstraints(w=800.0, h=Infinity)` melden. Derselbe Fehler, dieselbe Lösung.

Ein irreführendes Detail: Hat die `SizedBox` **kein Kind**, erscheint diese Meldung gar nicht. Stattdessen erhalten Sie `RenderConstrainedBox object was given an infinite size during layout`, weil es kein Kind gibt, auf dem `layout()` aufgerufen werden könnte, und die Box versucht, sich selbst auf unendlich zu dimensionieren. Gleiche Ursache, andere Formulierung.

## Lösungen im Detail

Wählen Sie die Lösung danach, was die unendliche Höhe eigentlich bewirken sollte.

### 1. "Den restlichen Platz in der Column füllen": Expanded verwenden

Das ist die häufigste Absicht. Innerhalb einer `Column` sagt man "nimm, was übrig ist" mit einem Flex-Kind, nicht mit einer unendlichen Größe:

```dart
// Flutter 3.44.8, Dart 3.12.2
Column(
  children: [
    const Text('Header'),
    Expanded(
      child: Container(color: Colors.red), // no height at all
    ),
  ],
)
```

In meinem Test mit einer 800x600-Fläche ergab die rote Box `Size(800.0, 580.0)`: die volle Höhe abzüglich der Kopfzeile. `Expanded` funktioniert, weil die `Column` Flex-Kinder zuletzt layoutet, nachdem sie weiß, wie viel Platz die Kinder fester Größe belegt haben, und ihnen eine feste, endliche Höhe übergibt.

Das funktioniert nur, wenn die `Column` selbst eine begrenzte Höhe hat. Steckt diese `Column` in einer `SingleChildScrollView`, tauscht `Expanded` diesen Fehler gegen `RenderFlex children have non-zero flex but incoming height constraints are unbounded`. Das ist dasselbe Problem eine Ebene höher, und die Lösungen 3 und 4 behandeln es.

### 2. "Ich will es einfach hoch": eine endliche Zahl vorgeben

Liegt die Box in einer Scroll-View, wird sie scrollen, "den Bildschirm füllen" war also meist nicht gemeint. Geben Sie ihr eine konkrete Höhe oder leiten Sie eine aus dem Bildschirm ab:

```dart
// Flutter 3.44.8, Dart 3.12.2
Builder(
  builder: (context) => ListView(
    children: [
      SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.5,
        child: const ColoredBox(color: Colors.red),
      ),
      // ... more children
    ],
  ),
)
```

Das ergab eine Box von `Size(800.0, 300.0)` auf einer 600 Pixel hohen Fläche. Bevorzugen Sie `MediaQuery.sizeOf(context)` gegenüber `MediaQuery.of(context).size`: Es löst nur dann einen Rebuild aus, wenn sich die Größe ändert, nicht bei jeder `MediaQuery`-Änderung wie etwa Tastatur-Insets.

Ist das Widget wiederverwendbar und Sie wissen nicht, ob es in einem begrenzten oder unbegrenzten Parent landet, verwenden Sie `LimitedBox`. Sie tut nichts, wenn der Parent begrenzt ist, und deckelt das Maximum, wenn er es nicht ist:

```dart
// Flutter 3.44.8, Dart 3.12.2
ListView(
  children: [
    LimitedBox(
      maxHeight: 200,
      child: Container(height: double.infinity, color: Colors.red),
    ),
  ],
)
```

Innerhalb der `ListView` wurde dieser Container ohne Fehler mit `Size(800.0, 200.0)` gelayoutet. Setzen Sie dasselbe Widget in einen begrenzten Parent, füllt es stattdessen den Parent. Dieses Muster empfiehlt der offizielle Leitfaden "Understanding constraints" für genau diese Situation.

### 3. "Den Bildschirm füllen, aber scrollen, wenn der Inhalt höher ist": SliverFillRemaining

Das ist der Fall des Login-Formulars: Eine Column soll bis zum unteren Rand des Viewports reichen, damit ein Button unten sitzen kann, aber auf kleinen Smartphones oder bei geöffneter Tastatur scrollen. `SliverFillRemaining` mit `hasScrollBody: false` ist das dafür gebaute Widget:

```dart
// Flutter 3.44.8, Dart 3.12.2
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(child: SizedBox(height: 100)),
    SliverFillRemaining(
      hasScrollBody: false,
      child: Container(color: Colors.red),
    ),
  ],
)
```

Die rote Box erhielt `Size(800.0, 500.0)`: genau den Viewport abzüglich der 100 Pixel hohen Kopfzeile. `hasScrollBody: false` teilt dem Sliver mit, dass sein Kind selbst nicht scrollbar ist, sodass er das Kind mindestens auf die verbleibende Ausdehnung dimensioniert, bei größerer Eigenhöhe des Kindes auf diese. Ist das Kind eine `ListView` oder eine andere Scroll-View, lassen Sie `hasScrollBody` auf dem Standardwert `true`.

### 4. Dasselbe ohne Slivers: LayoutBuilder plus ConstrainedBox

Wenn Sie einen Bildschirm noch nicht auf `CustomScrollView` umstellen möchten, beschreibt die Dokumentation zu `SingleChildScrollView` ein Muster, das die Viewport-Höhe einmal ausliest und in ein *Minimum* statt einer festen unendlichen Größe umwandelt:

```dart
// Flutter 3.44.8, Dart 3.12.2
LayoutBuilder(
  builder: (context, viewport) => SingleChildScrollView(
    child: ConstrainedBox(
      constraints: BoxConstraints(minHeight: viewport.maxHeight),
      child: IntrinsicHeight(
        child: Column(
          children: [
            const Text('top'),
            Expanded(child: Container(color: Colors.red)),
            const Text('bottom'),
          ],
        ),
      ),
    ),
  ),
)
```

Der `LayoutBuilder` sitzt außerhalb der Scroll-View, daher ist `viewport.maxHeight` endlich (hier 600). `ConstrainedBox` gibt der Column eine Untergrenze von 600, aber keine Obergrenze, und `IntrinsicHeight` gibt der `Column` eine begrenzte Höhe, sodass `Expanded` zulässig ist. Mein Test ergab eine 560 Pixel hohe rote Box zwischen den beiden Textzeilen. `IntrinsicHeight` kostet einen zusätzlichen Layout-Durchlauf über seinen Teilbaum, was für ein Formular in Ordnung und für eine lange Liste falsch ist. Bei langen Inhalten nehmen Sie Lösung 3 oder die Optionen aus [shrinkWrap vs Expanded vs slivers](/de/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).

### 5. "Die Höhe der Row übernehmen": IntrinsicHeight plus stretch

Eine sehr häufige Quelle dieses Fehlers in Listen ist eine farbige Seitenleiste oder ein vertikaler Trenner, der so hoch sein soll wie sein Nachbar:

```dart
// Flutter 3.44.8, Dart 3.12.2
// Throws: BoxConstraints(w=4.0, h=Infinity)
ListView(
  children: const [
    Row(
      children: [
        SizedBox(width: 4, height: double.infinity, child: ColoredBox(color: Colors.blue)),
        Text('item'),
      ],
    ),
  ],
)
```

Die `Row` reicht ihre eigene unbegrenzte vertikale Beschränkung an die Leiste weiter. Lassen Sie die Row zuerst ihr höchstes Kind ausmessen und dann alles daran angleichen:

```dart
// Flutter 3.44.8, Dart 3.12.2
ListView(
  children: const [
    IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(width: 4, child: ColoredBox(color: Colors.blue)),
          Text('item\nline2'),
        ],
      ),
    ),
  ],
)
```

Die Leiste hat gar keine `height`: `CrossAxisAlignment.stretch` gibt ihr eine feste Höhe gleich der Row, und `IntrinsicHeight` macht diese Höhe endlich. Ein `IntrinsicHeight` pro Listeneintrag ist für typische Listen günstig genug.

## Stolperfallen und ähnliche Fehler

- **`double.maxFinite` ist keine Lösung.** Wer `double.infinity` durch `double.maxFinite` ersetzt, bringt die Assertion zum Schweigen, aber in meinem Test wurde die Box mit `Size(0.0, 1.7976931348623157e+308)` gelayoutet. Sie haben eine Box gebaut, die höher ist als das Universum, und alles unterhalb ist unerreichbar. Finden Sie diese "Lösung" in einem Code-Review, ist es derselbe Fehler, nur versteckt.
- **Die Prüfung gibt es nur im Debug-Modus.** `debugAssertIsValid` läuft innerhalb eines `assert`, Release-Builds überspringen es, und Sie erhalten statt eines roten Bildschirms eine graue Fläche oder fehlende Inhalte. Reproduzieren Sie Layout-Fehler immer im Debug-Modus.
- **Eine horizontale `ListView` ist unproblematisch.** `ListView(scrollDirection: Axis.horizontal)` gibt Kindern eine begrenzte *Höhe* (ihre eigene), also wird `height: double.infinity` darin korrekt begrenzt: Mein Test ergab `Size(100.0, 600.0)`. In dieser Liste ist es `width: double.infinity`, das scheitert.
- **`Vertical viewport was given unbounded height`** ist die umgekehrte Situation: eine Scrollable in einer `Column`, statt einer unendlichen Box in einer Scrollable. Die Lösungen überschneiden sich, und der [Leitfaden zu ListView in einer Column](/de/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) behandelt diesen Fall ausführlich.
- **`TextField` in einer `Row`** erzeugt unter Flutter 3.44.8 als ersten Fehler `An InputDecorator, which is typically created by a TextField, cannot have an unbounded width`, nicht die `BoxConstraints`-Meldung. Packen Sie das Feld in `Expanded` oder eine `SizedBox` fester Breite.
- **`IntrinsicHeight` um eine `ListView`** wirft diesen Fehler nicht. Es wirft `RenderViewport does not support returning intrinsic dimensions`, weil ein Lazy-Viewport sich weigert, alle seine Kinder auszumessen. Packen Sie niemals eine Scrollable in ein Intrinsic-Widget.
- **`UnconstrainedBox`** entfernt die Constraints seines Parents vollständig, daher wirft jedes unendliche Kind darin diesen Fehler selbst auf einem begrenzten Bildschirm. Setzen Sie eine `LimitedBox` dazwischen oder entfernen Sie die `UnconstrainedBox`.
- **Eine `Column`, die überläuft, statt zu werfen,** ist ein anderes Problem: Der Inhalt ist endlich, aber zu hoch. Siehe den [Leitfaden zu RenderFlex overflowed](/de/2026/05/fix-renderflex-overflowed-in-flutter/).

## Den Verursacher in einem großen Widget-Baum finden

Verweist das "relevant error-causing widget" auf eine geteilte Komponente, öffnen Sie Flutter DevTools, wählen das Widget im Widget Inspector aus und betrachten die Constraints im Layout Explorer. Gehen Sie den Baum nach oben, bis Sie den ersten Vorfahren finden, dessen Höhenbeschränkung `Infinity` ist: Das ist die `Column`, `ListView`, `Row` oder `UnconstrainedBox`, die die Begrenzung entfernt hat. Die Lösung gehört entweder an diesen Vorfahren (begrenzen) oder an das Kind (nicht mehr unendlich anfordern). Eine Suche im Code nach `double.infinity`, `.expand(` und `BoxConstraints.expand` findet den Kandidaten meist in unter einer Minute.

## Verwandte Beiträge

- [Fix: RenderBox was not laid out in Flutter](/de/2026/06/fix-renderbox-was-not-laid-out-in-flutter/), die Kaskade, die auf diesen Fehler folgt.
- [How to nest a ListView inside a Column without an unbounded-height error](/de/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/).
- [shrinkWrap vs Expanded vs slivers for long lists in Flutter](/de/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).
- [Fix: A RenderFlex overflowed in Flutter](/de/2026/05/fix-renderflex-overflowed-in-flutter/).
- [Fix: RenderViewport expected a RenderSliver in a CustomScrollView](/de/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/), falls Sie darauf stoßen, wenn Sie zu `SliverFillRemaining` wechseln.

## Quellen

- [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) (Flutter-Dokumentation), einschließlich der Beispiele zu `LimitedBox` und `UnconstrainedBox`.
- [Common Flutter errors](https://docs.flutter.dev/testing/common-errors) (Flutter-Dokumentation).
- [BoxConstraints.enforce](https://api.flutter.dev/flutter/rendering/BoxConstraints/enforce.html) und [BoxConstraints.debugAssertIsValid](https://api.flutter.dev/flutter/rendering/BoxConstraints/debugAssertIsValid.html) (API-Referenz).
- [SingleChildScrollView](https://api.flutter.dev/flutter/widgets/SingleChildScrollView-class.html), der Abschnitt "Centering, spacing, or aligning fixed-height content".
- [SliverFillRemaining](https://api.flutter.dev/flutter/widgets/SliverFillRemaining-class.html) und [LimitedBox](https://api.flutter.dev/flutter/widgets/LimitedBox-class.html) (API-Referenz).
- `packages/flutter/lib/src/rendering/box.dart` und `proxy_box.dart` im Flutter-3.44.8-SDK, lokal gelesen.
