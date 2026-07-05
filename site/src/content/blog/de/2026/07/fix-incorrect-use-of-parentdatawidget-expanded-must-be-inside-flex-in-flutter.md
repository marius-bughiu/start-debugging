---
title: "Fix: Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets (Flutter)"
description: "Dieser Fehler bedeutet, dass ein Expanded oder Flexible kein direktes Kind eines Row, Column oder Flex ist. Verschieben Sie es direkt unter das Flex-Widget, oder entfernen Sie Expanded, wenn der Parent kein Flex ist."
pubDate: 2026-07-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
lang: "de"
translationOf: "2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-05
---

`Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets` bedeutet, dass ein `Expanded` (oder `Flexible`) kein direktes Kind eines `Row`, `Column` oder `Flex` ist. Ein anderes Widget -- ein `Container`, `SizedBox`, `Padding`, `Center`, `Stack` oder `Wrap` -- sitzt dazwischen. Beheben Sie es, indem Sie `Expanded` zum direkten Kind des Flex machen, oder indem Sie `Expanded` ganz entfernen, wenn der Parent kein Flex ist. Getestet mit Flutter 3.x (3.44), Dart 3.x.

## Der Fehler im Kontext

Flutter wirft dies während der Build-Phase, als Assertion, bevor das Layout ausgeführt wird. Die kurze Zusammenfassungszeile ist die, nach der die Leute suchen, aber die vollständige Meldung im aktuellen Flutter sagt Ihnen genau, welches Widget falsch ist und worin es falsch verschachtelt ist:

```
Incorrect use of ParentDataWidget.

The ParentDataWidget Expanded(flex: 1) wants to apply ParentData of type
FlexParentData to a RenderObject, which has been set up to accept ParentData of
incompatible type BoxParentData.

Usually, this means that the Expanded widget has the wrong ancestor
RenderObjectWidget. Typically, Expanded widgets are placed directly inside Flex
widgets.
The offending Expanded is currently placed inside a SizedBox widget.

The ownership chain for the RenderObject that received the incompatible parent data
was:
  SizedBox ← Expanded ← Column ← ...
```

Zwei Zeilen tragen die gesamte Information. "wants to apply ParentData of type `FlexParentData` to a RenderObject, which has been set up to accept ParentData of incompatible type `BoxParentData`" ist die Typinkompatibilität. "The offending Expanded is currently placed inside a `SizedBox` widget" benennt den falschen Parent nach Widget-Typ. In älteren Flutter-Versionen fällt das Ganze auf die Zusammenfassung zusammen, die Sie wahrscheinlich in die Suchleiste getippt haben: `Expanded widgets must be placed inside Flex widgets`.

## Warum ein Flex-Parent zwingend ist, nicht nur empfohlen

`Expanded` zeichnet nichts. Es ist ein `ParentDataWidget`: seine einzige Aufgabe ist es, ein Stück Konfiguration an sein Kind anzuhängen, damit das übergeordnete Render Object weiß, wie es dieses Kind anordnen soll. Für `Expanded` ist diese Konfiguration ein Flex-Faktor, und sie lebt in einem Objekt vom Typ `FlexParentData`.

Hier ist der Mechanismus. Ein `Row`, `Column` oder `Flex` wird von einem `RenderFlex` gestützt. Wenn `RenderFlex` ein Kind aufnimmt, richtet es an diesem Kind einen `FlexParentData`-Slot ein, um den Flex-Wert und den Fit zu speichern. `Expanded` läuft zu seinem übergeordneten Render Object hinauf und ruft `applyParentData` auf, das `flex` und `fit` in diesen Slot schreibt. `RenderFlex` liest den Slot während des Layouts: Kinder mit einem Flex-Faktor teilen den verbleibenden Platz auf der Hauptachse im Verhältnis zu ihren Faktoren auf. Dieser Handschlag ist der einzige Grund, warum `Expanded` funktioniert.

Jedes andere Render Object richtet einen anderen `ParentData`-Typ ein. Ein `SizedBox`, `Container` oder `Padding` gibt seinem einzigen Kind `BoxParentData`. Ein `Stack` gibt den Kindern `StackParentData`. Ein `Wrap` gibt den Kindern `WrapParentData`. Keiner von ihnen hat ein `flex`-Feld, und `FlexParentData` kann nicht in einen `BoxParentData`-Slot geschrieben werden. Wenn `Expanded` also versucht, `applyParentData` auf einem Nicht-Flex-Parent auszuführen, fängt die Prüfung `debugIsValidRenderObject` des Frameworks die Typinkompatibilität von vornherein ab und wirft den Fehler, anstatt den Flex-Faktor stillschweigend zu ignorieren oder später während des Layouts abzustürzen. Die Meldung wird aus dem `debugTypicalAncestorWidgetDescription` des Widgets erzeugt, das für `Expanded` "Flex widgets" ist -- daher kommt die Formulierung "must be placed inside Flex widgets".

Dies ist ein anderer Fehler als ein [RenderFlex-Überlauf](/de/2026/05/fix-renderflex-overflowed-in-flutter/), der auftritt, wenn einem `Row` oder `Column` zur Layout-Zeit der Platz ausgeht. Dieser wird früher ausgelöst, zur Build-Zeit, und ist ein Typfehler: die Flex-Konfiguration hat keinen gültigen Ort, an dem sie landen kann.

## Der minimale Repro

Die kleinste Version ist ein `Expanded`, das in ein beliebiges Widget mit einem einzigen Kind eingewickelt ist:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class Sidebar extends StatelessWidget {
  const Sidebar({super.key});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 200,
      child: Expanded(          // wrong: SizedBox is not a Flex
        child: ListView(
          children: const [Text('a'), Text('b')],
        ),
      ),
    );
  }
}
```

`SizedBox` gibt seinem Kind `BoxParentData`. `Expanded` will `FlexParentData` schreiben. Der Build wirft den Fehler. Der identische Fehler erscheint, wenn Sie `SizedBox` durch `Container`, `Padding`, `Center`, `Align`, `Card`, `Wrap` oder einen `Stack` ersetzen -- alles, was kein `Row`, `Column` oder `Flex` ist.

## Fix 1: Machen Sie Expanded zum direkten Kind des Row, Column oder Flex

Wenn Sie tatsächlich einen Flex-Parent haben und sich ein zwischengeschaltetes Widget eingeschlichen hat, besteht die Lösung darin, umzuordnen, sodass `Expanded` direkt unter dem Flex sitzt. Dies ist bei weitem der häufigste Fall: jemand hat ein Flex-Kind für das Styling in ein `Padding` oder `Container` eingewickelt, und das `Expanded` landete auf der falschen Seite davon.

Falsch -- `Expanded` ist im `Padding`, und `Padding` ist eine Box:

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Header'),
    Padding(
      padding: const EdgeInsets.all(8),
      child: Expanded(child: content),   // throws: parent is Padding
    ),
  ],
)
```

Richtig -- `Expanded` ist das direkte Kind des `Column`, und das `Padding` kommt hinein:

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Header'),
    Expanded(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: content,
      ),
    ),
  ],
)
```

Die Regel, die man verinnerlichen sollte: `Expanded` muss das äußerste Widget in diesem Slot der `children`-Liste sein. Alles, was Sie dekorieren, auffüllen oder dimensionieren möchten, kommt in sein `child`, nicht darum herum.

## Fix 2: Entfernen Sie Expanded, wenn der Parent überhaupt kein Flex ist

Wenn wirklich kein `Row`, `Column` oder `Flex` über dem Widget steht, dann ist `Expanded` das falsche Werkzeug, und kein Grad an Verschachtelung macht es legal. Sie brauchen eine andere Möglichkeit, den Platz aufzufüllen:

- **Um die Breite oder Höhe des Parents auszufüllen**, dimensionieren Sie das Kind direkt. Verwenden Sie `SizedBox(width: double.infinity)`, `SizedBox.expand` oder `double.infinity` in den Constraints eines `Container`:

```dart
// Flutter 3.x (tested 3.44)
// Was: Container(child: Expanded(child: button))  -- illegal
SizedBox(
  width: double.infinity,
  child: button,
)
```

- **Um einen Bruchteil des Parents auszufüllen**, verwenden Sie `FractionallySizedBox`:

```dart
// Flutter 3.x (tested 3.44)
FractionallySizedBox(
  widthFactor: 0.5,
  child: button,
)
```

- **Wenn Sie tatsächlich eine proportionale Aufteilung wollten**, haben Sie aus dem richtigen Grund nach `Expanded` gegriffen, aber den Flex-Parent vergessen. Führen Sie einen ein. Wickeln Sie die Gruppe in ein `Row` oder `Column` und legen Sie die `Expanded`-Kinder direkt hinein:

```dart
// Flutter 3.x (tested 3.44)
Row(
  children: [
    Expanded(flex: 2, child: leftPane),
    Expanded(flex: 1, child: rightPane),
  ],
)
```

Wählen Sie nach der Absicht. Wenn Sie immer nur ein Kind haben, brauchen Sie überhaupt kein Flex -- dimensionieren Sie die Box. Wenn Sie Platz zwischen Geschwistern aufteilen, brauchen Sie einen echten Flex-Parent.

## Fix 3: Achten Sie auf ein RenderObjectWidget, das sich im Pfad versteckt

Der Vertrag von `Expanded` ist strenger als "irgendwo unter einem Column". Die Dokumentation besagt, dass der Pfad von `Expanded` hinauf zu seinem umschließenden `Row`, `Column` oder `Flex` **nur** `StatelessWidget`s oder `StatefulWidget`s enthalten darf. In dem Moment, in dem ein `RenderObjectWidget` in diesem Pfad auftaucht, wird es zum Parent, der die Parent Data empfängt, und die Inkompatibilität wirft den Fehler.

Das beißt auf zwei heimtückische Arten:

**Ein `Container` mit bestimmten Eigenschaften fügt Render-Widgets ein.** `Container` ist eine Komposition: geben Sie ihm `padding`, und es wickelt sein Kind in ein `Padding`; geben Sie ihm ein `color` oder `decoration`, und es fügt ein `DecoratedBox` hinzu; geben Sie ihm `alignment`, und es fügt ein `Align` hinzu. Also setzt `Container(padding: ..., child: Expanded(...))` ein `Padding` (ein `RenderObjectWidget`) direkt über Ihr `Expanded`, obwohl Sie nie `Padding` geschrieben haben. Das ist der Repro aus Fix 1 in Verkleidung.

**Ihr eigenes `RenderObjectWidget` im Pfad.** Wenn Sie ein maßgeschneidertes Render-Widget haben, das die Kinder umwickelt, bevor sie das `Column` erreichen, gilt dieselbe Regel. Eigene `StatelessWidget`- und `StatefulWidget`-Wrapper sind in Ordnung; ein eigenes `RenderObjectWidget` nicht.

Die Erkenntnis: Es reicht nicht, dass ein `Flex` ein Vorfahr ist. `Expanded` muss ihn durch nichts als einfache Kompositions-Widgets erreichen.

## Fallstricke und ähnliche Fälle

**`flex: 0` wirft immer noch den Fehler.** Es ist verlockend zu denken, `Expanded(flex: 0)` sei ein No-op, das das Framework durchgehen lassen würde. Ist es nicht. Die Prüfung des Parent-Data-Typs läuft unabhängig vom Flex-Wert, sodass `Expanded(flex: 0)` in einem `Wrap` mit genau demselben Fehler fehlschlägt und `WrapParentData` als den inkompatiblen Typ benennt. Dies wurde als beabsichtigtes Verhalten in [flutter/flutter Issue 154950](https://github.com/flutter/flutter/issues/154950) bestätigt. Wenn Sie ein Kind wollen, das mit fester Breite an einem `Wrap` teilnimmt, geben Sie ihm ein `SizedBox`, kein `Expanded`.

**`Flexible` hat die identische Regel.** `Expanded` ist einfach `Flexible` mit `fit: FlexFit.tight`. `Flexible` ist ebenfalls ein `ParentDataWidget<FlexParentData>`, sodass das Platzieren eines `Flexible` in einem Nicht-Flex-Parent denselben Fehler "Flexible widgets must be placed inside Flex widgets" wirft. `Expanded` durch `Flexible` zu ersetzen behebt diesen Fehler nie -- es ändert nur den Widget-Namen in der Meldung.

**`Positioned` außerhalb eines `Stack` ist dieselbe Art von Bug.** Wenn Sie `Incorrect use of ParentDataWidget. Positioned widgets must be placed directly inside Stack widgets` sehen, ist es genau derselbe Mechanismus mit anderen Typen: `Positioned` schreibt `StackParentData` und braucht ein `Stack` (gestützt von `RenderStack`) als Parent. Das Lösungsmuster ist identisch -- machen Sie es zum direkten Kind eines `Stack`, oder verwenden Sie ein Layout ohne Positionierung.

**Ein Conditional oder ein Spread, das ein `Expanded` auf oberster Ebene liefert.** Kinder mit einem Helper, einem `...[]`-Spread oder einem Ternär zu erzeugen, kann versehentlich ein `Expanded` an einen Nicht-Flex-Parent übergeben, wenn der Zweig genommen wird, den Sie nicht getestet haben. Der Fehler benennt den Parent zur Laufzeit, vertrauen Sie also "currently placed inside a X widget" mehr als dem, wie der Quellcode auf den ersten Blick aussieht.

**Der Fehler assertiert nur in Debug-Builds.** Die Prüfung `debugIsValidRenderObject` ist eine Assertion im Debug-Modus. In einem Release-Build wird die Assertion herauskompiliert, die Flex-Daten werden stillschweigend verworfen, und Sie erhalten ein subtil falsches Layout statt eines Absturzes -- was schwerer zu diagnostizieren ist. Lösen Sie dies immer im Debug, bevor Sie ausliefern; gehen Sie nicht davon aus, dass ein Release-Build, der "gut aussieht", korrekt ist.

## Verwandt

- [Fix: A RenderFlex overflowed in Flutter](/de/2026/05/fix-renderflex-overflowed-in-flutter/) -- der andere `Row`/`Column`-Fehler, ausgelöst zur Layout-Zeit, wenn Flex-Kinder mehr Platz verlangen, als vorhanden ist.
- [Fix: RenderBox was not laid out in Flutter](/de/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) -- eine Assertion zur Layout-Zeit, die Ihnen oft in derselben Scroll- und Flex-Verrohrung begegnet.
- [Fix: A RenderViewport expected a RenderSliver in einem Flutter-CustomScrollView](/de/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/) -- dieselbe "falsches Protokoll"-Idee, aber für Slivers gegenüber Boxen statt Flex- gegenüber Box-Parent-Data.
- [So verschachteln Sie ein ListView in einem Column ohne den Fehler zur unbegrenzten Höhe](/de/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) -- wo `Expanded` die richtige Antwort ist und einem `ListView` innerhalb eines `Column` eine begrenzte Höhe gibt.

## Quellen

- [Klasse Expanded, Flutter-API-Referenz](https://api.flutter.dev/flutter/widgets/Expanded-class.html) -- besagt, dass `Expanded` ein Nachkomme von `Row`, `Column` oder `Flex` sein muss, mit nur Stateless-/Stateful-Widgets im Pfad.
- [Klasse ParentDataWidget, Flutter-API-Referenz](https://api.flutter.dev/flutter/widgets/ParentDataWidget-class.html) -- `applyParentData`, `debugTypicalAncestorWidgetDescription` und die Gültigkeitsprüfung, die diese Meldung erzeugt.
- [Klasse Flexible, Flutter-API-Referenz](https://api.flutter.dev/flutter/widgets/Flexible-class.html) -- die Basisklasse von `Expanded`, unterliegt derselben Flex-Parent-Anforderung.
- [flutter/flutter Issue 154950](https://github.com/flutter/flutter/issues/154950) -- bestätigt, dass der Fehler für `Expanded(flex: 0)` in einem Nicht-Flex-Parent absichtlich weiterhin ausgelöst wird.
