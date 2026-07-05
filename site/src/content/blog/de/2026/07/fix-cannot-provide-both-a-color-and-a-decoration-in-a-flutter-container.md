---
title: "Lösung: Cannot provide both a color and a decoration in einem Flutter Container"
description: "Verschieben Sie die Farbe in die Decoration: verwenden Sie decoration: BoxDecoration(color: ...) statt color und decoration an denselben Container zu übergeben."
pubDate: 2026-07-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "container"
lang: "de"
translationOf: "2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container"
translatedBy: "claude"
translationDate: 2026-07-05
---

Die Lösung in einer Zeile: Löschen Sie das Argument `color:` an Ihrem `Container` und legen Sie diese Farbe stattdessen in das `BoxDecoration`, als `decoration: BoxDecoration(color: Colors.blue, ...)`. Die Assertion wird ausgelöst, weil der Parameter `color` von `Container` nichts weiter ist als eine Kurzform für `decoration: BoxDecoration(color: color)`. Beide zu übergeben, würde dem Widget also zwei konkurrierende Definitionen seines Hintergrunds geben, und Flutter weigert sich zu raten, welche gewinnt.

```text
Cannot provide both a color and a decoration
The color argument is just a shorthand for "decoration: BoxDecoration(color: color)".

'package:flutter/src/widgets/container.dart':
Failed assertion: line 273 pos 15: 'color == null || decoration == null'
```

Dieser Beitrag ist für Flutter 3.x (getestet mit 3.44) und Dart 3.x geschrieben. Die `Container`-Assertion liest sich seit den 1.x-Zeiten gleich, sodass hier alles sauber über die gesamte 3.x-Linie und zurück bis 2.x gilt. Die Prüfung befindet sich in `package:flutter/src/widgets/container.dart`; die Zeilennummer in Ihrem Stack Trace kann zwischen SDK-Versionen um ein paar abweichen, aber der Assertion-Ausdruck `color == null || decoration == null` ist stabil.

## Warum Container color und decoration zusammen verbietet

`Container` ist ein Komfort-Widget. Es zeichnet nichts selbst; es setzt sich aus einem Stapel einfacherer Widgets (`Padding`, `DecoratedBox`, `ConstrainedBox`, `Transform` und Kollegen) zusammen, je nachdem, welche Argumente Sie übergeben. Das Argument `color` ist das kleinstmögliche Stück dieser Zusammensetzung: Wenn Sie es setzen, baut `Container` intern eine `DecoratedBox` mit einem `BoxDecoration(color: color)`. Das ist die vollständige Bedeutung von `color`. Es ist syntaktischer Zucker.

`decoration` ist die Vollversion derselben Sache. Ein `BoxDecoration` kann eine Hintergrundfarbe, einen Rahmen, abgerundete Ecken, einen Verlauf, einen Schatten und ein Hintergrundbild gleichzeitig tragen. Da ein `BoxDecoration` bereits ein eigenes `color`-Feld hat, würde es ein mehrdeutiges Widget erzeugen, wenn Sie auch eine `color` auf oberster Ebene übergeben dürften: Welche Farbe zeichnet, die am `Container` oder die am `BoxDecoration`? Statt stillschweigend einen Gewinner zu wählen (und die halbe Community die entgegengesetzte Regel annehmen zu lassen), löst das Framework die Assertion zur Konstruktionszeit aus und zwingt Sie, explizit zu sein. Der Konstruktor enthält ein schlichtes `assert(color == null || decoration == null, ...)`, weshalb dies nur in Debug- und Profile-Builds ausgelöst wird, in denen Assertions ausgeführt werden.

Es gibt einen zweiten, subtileren Grund in den eigenen Worten des Frameworks: Eine `decoration` kann über die Hintergrundfarbe zeichnen. Ein `BoxDecoration` mit einem `DecorationImage` oder einem Verlauf zeichnet über die Füllung der Box, sodass eine separate `color` darunter je nach Deckkraft der Decoration mal sichtbar und mal nicht wäre. Beides in ein einziges `BoxDecoration` zusammenzuführen, beseitigt diese ganze Klasse der "Warum wird meine Farbe nicht angezeigt"-Verwirrung.

## Das kleinste Repro, das ihn auslöst

Jeder `Container`, der sowohl einen soliden Hintergrund als auch einen Rahmen möchte, stößt sofort darauf. Dies ist der kanonische Fall, denn der natürliche erste Versuch ist, für die Füllung zu `color` und für den Rahmen zu `decoration` zu greifen:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: DecorationDemo()));

class DecorationDemo extends StatelessWidget {
  const DecorationDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Container(
          width: 200,
          height: 120,
          // Both set at once -> assertion throws before the first frame.
          color: Colors.blue,
          decoration: BoxDecoration(
            border: Border.all(color: Colors.black, width: 2),
            borderRadius: BorderRadius.circular(12),
          ),
          child: const Center(child: Text('Card')),
        ),
      ),
    );
  }
}
```

Führen Sie es aus, und die App zeichnet nie einen Frame. Die Assertion wird im Konstruktor von `Container` ausgelöst, sodass der Fehler in dem Moment auftritt, in dem `build` läuft, nicht später während des Layouts. Dieser Zeitpunkt ist ein nützliches Signal: Anders als ein `RenderFlex overflowed` oder ein `RenderBox was not laid out`, die während der Layout-Phase geschehen, ist dies eine Vertragsverletzung zur Konstruktionszeit.

## Die Lösung, in der Reihenfolge, wie oft Sie sie brauchen

### Lösung 1: Verschieben Sie die Farbe in das BoxDecoration

Das ist praktisch jedes Mal richtig. Wenn Sie eine `decoration` übergeben, entfernen Sie das Argument `color` und setzen Sie stattdessen `BoxDecoration.color`:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Container(
  width: 200,
  height: 120,
  decoration: BoxDecoration(
    color: Colors.blue,               // was the top-level `color:`
    border: Border.all(color: Colors.black, width: 2),
    borderRadius: BorderRadius.circular(12),
  ),
  child: const Center(child: Text('Card')),
)
```

Ein einziges `BoxDecoration` besitzt nun das gesamte Erscheinungsbild: Füllung, Rahmen und Eckradius. Das ist die Form, die Sie für jede Karte, jeden Chip, jedes Badge oder jeden Button-Hintergrund wollen, denn in dem Moment, in dem Sie einen Rahmen oder abgerundete Ecken brauchen, wären Sie ohnehin in einem `BoxDecoration` gelandet.

### Lösung 2: Wenn Sie nur eine flache Farbe brauchen, behalten Sie color und löschen Sie die decoration

Wenn Sie zu `decoration` gegriffen haben, nur um abgerundete Ecken oder einen Rahmen hinzuzufügen, ist das beabsichtigt und Lösung 1 ist richtig. Aber wenn sich die `decoration` aus einem Copy-Paste eingeschlichen hat und Sie eigentlich nur eine solide Füllung ohne Rahmen, Verlauf oder Radius brauchen, tun Sie das Gegenteil: Behalten Sie die `color` auf oberster Ebene und löschen Sie die `decoration` vollständig.

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Container(
  width: 200,
  height: 120,
  color: Colors.blue,   // fine on its own; no decoration present
  child: const Center(child: Text('Card')),
)
```

Die Kurzform `color` ist für den Fall der flachen Füllung nicht veraltet oder abgeraten. Sie liest sich sauberer, als eine einzelne Farbe in ein `BoxDecoration` zu packen, und erzeugt darunter dieselbe `DecoratedBox`. Greifen Sie nur dann zum vollen `BoxDecoration`, wenn Sie eine seiner zusätzlichen Funktionen brauchen.

### Lösung 3: Verzichten Sie ganz auf Container für eine einfache farbige Box

Wenn Ihr `Container` kein Padding, keine Constraints über eine Größe hinaus und keine Transformation hat und Sie nur ein Rechteck aus Farbe wollen, ist `ColoredBox` das schlankere Widget und hat diese Mehrdeutigkeit nie, weil es eine erforderliche `color` und keine Decoration nimmt:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
const ColoredBox(
  color: Colors.blue,
  child: SizedBox(
    width: 200,
    height: 120,
    child: Center(child: Text('Card')),
  ),
)
```

`ColoredBox` kann `const` sein, wenn sein Kind `const` ist, wodurch Flutter dessen Neuaufbau und Neuzeichnen überspringen kann. Das ist ein echter, wenn auch kleiner Gewinn in einer Liste vieler statischer Kacheln. Für alles mit einem Rahmen oder Radius gehen Sie zurück zu Lösung 1; `ColoredBox` kann das nicht zeichnen.

## Wo das in echtem Code tatsächlich zubeißt

### Ein Widget durch Verbreiten einer geteilten Decoration mit einem Theme versehen

Design-Systeme führen oft ein geteiltes `BoxDecoration` und versuchen dann, nur die Farbe pro Instanz zu überschreiben:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
// WRONG: passes both the reused decoration AND a color override.
Container(
  color: theme.colorScheme.surfaceContainerHigh,
  decoration: cardDecoration, // already a BoxDecoration
  child: content,
)
```

Sie können keine `color` auf oberster Ebene über ein bestehendes `BoxDecoration` legen. Verwenden Sie stattdessen `copyWith` auf der Decoration, wofür es genau da ist:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Container(
  decoration: cardDecoration.copyWith(
    color: theme.colorScheme.surfaceContainerHigh,
  ),
  child: content,
)
```

Wenn Sie hier Farben aus einem Material-3-`ColorScheme` ziehen, sind die Rollen (`surface`, `surfaceContainerHigh`, `primaryContainer`) für den Kontrast sowohl im hellen als auch im dunklen Modus wichtig; siehe [wie man die Akzentfarbe in einer Flutter-App mit dem Material-3-ColorScheme setzt](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/), um zu erfahren, zu welcher Rolle man greift.

### AnimatedContainer hat genau dieselbe Regel

`AnimatedContainer` teilt den Konstruktor-Vertrag von `Container`, sodass die identische Assertion dort ausgelöst wird. Die Falle ist schlimmer, weil man eine Farbe animiert, indem man die `color` auf oberster Ebene tweent, während eine statische `decoration` den Rahmen liefert:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
// WRONG: AnimatedContainer with both color and decoration.
AnimatedContainer(
  duration: const Duration(milliseconds: 200),
  color: _selected ? Colors.blue : Colors.grey,
  decoration: BoxDecoration(border: Border.all()),
)
```

Animieren Sie die Farbe innerhalb des `BoxDecoration`, und `AnimatedContainer` interpoliert die gesamte Decoration für Sie, Rahmen inklusive:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
AnimatedContainer(
  duration: const Duration(milliseconds: 200),
  decoration: BoxDecoration(
    color: _selected ? Colors.blue : Colors.grey,
    border: Border.all(),
  ),
)
```

`BoxDecoration` implementiert das nötige Lerp, damit Rahmen und Farbe zusammen animieren, was die Zwei-Argument-Version niemals könnte.

### Eine Bedingung, die beide gesetzt lässt

Die übelste Variante kompiliert einwandfrei und wird nur in einem Zweig ausgelöst. Jemand fügt bedingt einen Rahmen hinzu, vergisst aber, die Farbe zu verschieben:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
// WRONG on the highlighted branch only.
Container(
  color: Colors.white,
  decoration: isHighlighted
      ? BoxDecoration(border: Border.all(color: Colors.amber, width: 2))
      : null,
  child: child,
)
```

Wenn `isHighlighted` false ist, ist `decoration` `null` und die Assertion geht durch, sodass der Code in jedem Screenshot korrekt aussieht, bis ein Nutzer eine Zeile hervorhebt. Schieben Sie die Farbe in beide Zweige (oder in ein einziges `BoxDecoration`, das mit einem bedingten Rahmen gebaut wird), damit es keinen Zustand gibt, in dem beide nicht null sind.

## Herausfinden, welcher Container in einem großen Baum schuldig ist

Die Assertion-Meldung nennt die Datei und Zeile innerhalb von `container.dart`, nicht Ihr Widget. So finden Sie Ihren schuldigen `Container`:

1. Lesen Sie den Stack Trace unterhalb der Assertion. Der erste Frame in Ihrem eigenen Code (eine Datei unter `lib/`) ist die `build`-Methode, die den fehlerhaften `Container` erstellt hat. Flutter gibt in den meisten Versionen "The relevant error-causing widget was" gefolgt von Ihrem Widget und seiner Quellposition aus.
2. Wenn der Trace nicht hilft, weil der `Container` in einer Schleife oder einem geteilten Builder gebaut wird, durchsuchen Sie Ihr Projekt nach `color:` und `decoration:`, die nah beieinander erscheinen. Die Regex `Container\([^)]*color:[^)]*decoration:` fängt die meisten einzeiligen Fälle; mehrzeilige brauchen einen manuellen Durchgang der geteilten Karte oder Kachel.
3. Da dies zur Konstruktionszeit ausgelöst wird, bringt Hot Reload es sofort zum Vorschein. Fügen Sie den Rahmen oder die Decoration hinzu, speichern Sie, und wenn der Frame rot wird, haben Sie das richtige Widget auf dem Bildschirm.

Dieses Verhalten zur Konstruktionszeit ist das Gegenteil von Layout-Assertions wie [RenderBox was not laid out](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/), die erst auftauchen, wenn die Layout-Pipeline läuft, und oft mehrere Widgets von der eigentlichen Ursache entfernt zeigen.

## Fallstricke und ähnlich aussehende Fehler

- **`BoxDecoration.color` versus `Container.color` und die Zeichenreihenfolge.** Sie sind nicht in jedem Fall identisch. `Container.color` zeichnet hinter dem Kind, aber auch hinter jeder `decoration`, wäre eine erlaubt; `BoxDecoration.color` zeichnet als Teil der Decoration, die hinter `foregroundDecoration` sitzt. Für eine flache Füllung ist das Ergebnis derselbe Pixel, aber wenn Sie auch `foregroundDecoration` verwenden, ist die Schichtung wichtig.
- **`Ink`- und `InkWell`-Splashes verschwinden über einem farbigen Container.** Wenn Sie einem `Container` eine `color` gegeben und dann ein Kind in `InkWell` gewickelt haben, zeichnet die Welligkeit hinter der Farbe des `Container` und verschwindet. Die Lösung ist derselbe Zug: Entfernen Sie `Container.color` und verwenden Sie ein `Ink`-Widget mit einer `decoration` oder ein `Material` mit einer Farbe, damit die Ink-Schicht über der Füllung sitzt.
- **`The following assertion was thrown building` mit einer anderen Meldung.** Wenn Ihr Fehler `Incorrect use of ParentDataWidget` statt color und decoration erwähnt, ist das ein separater Layout-Vertrags-Bug; siehe [Incorrect use of ParentDataWidget: Expanded muss innerhalb von Flex stehen](/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/).
- **Release-Builds verbergen ihn, sie beheben ihn nicht.** Da die Prüfung ein `assert` ist, entfernt ein Release-Build sie und zeichnet mit dem Argument, das der Konstruktor gespeichert hat. Liefern Sie nicht in der Annahme aus, "es funktioniert im Release". Es funktioniert zufällig, und der nächste SDK-Sprung kann ändern, welches Argument gewinnt.
- **`DecoratedBox` löst denselben konzeptionellen Fehler anders aus.** `DecoratedBox` hat überhaupt kein `color`-Argument, nur `decoration`, sodass Sie dort nicht auf diese Assertion stoßen können. Wenn Sie `DecoratedBox` verwendet und eine Farbe wollten, geht sie immer in das `BoxDecoration`.

## Verwandt

- [Lösung: A RenderFlex overflowed in Flutter](/2026/05/fix-renderflex-overflowed-in-flutter/) ist die andere Assertion, auf die Einsteiger beim Bauen von Karten- und Zeilen-Layouts zuerst stoßen.
- [Lösung: RenderBox was not laid out in Flutter](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) behandelt einen Fehler zur Layout-Zeit, der anders als dieser von der eigentlichen Ursache wegzeigt.
- [Lösung: Incorrect use of ParentDataWidget: Expanded muss innerhalb von Flex stehen](/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) ist eine verwandte Konstruktionsvertrags-Assertion, die zu erkennen sich lohnt.
- [Wie man die Akzentfarbe in einer Flutter-App mit dem Material-3-ColorScheme setzt](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) erklärt, welche `ColorScheme`-Rolle Sie in Ihr `BoxDecoration.color` einspeisen.

## Quellen

- [Container.new-Konstruktor -- Flutter-API](https://api.flutter.dev/flutter/widgets/Container/Container.html), der die `color`-Kurzform und die "cannot provide both"-Regel wörtlich dokumentiert.
- [BoxDecoration-Klassenreferenz](https://api.flutter.dev/flutter/painting/BoxDecoration-class.html), die Decoration, die `color`, `border`, `borderRadius`, `gradient` und `boxShadow` besitzt.
- [flutter/flutter issue #119484](https://github.com/flutter/flutter/issues/119484), das Tracking-Issue, das diskutiert, wie die Fehlermeldung klarer sein könnte.
- [flutter/flutter issue #31312](https://github.com/flutter/flutter/issues/31312), der ursprüngliche Bericht, der die exakte Assertion und den Stack Trace aus `container.dart` zeigt.
