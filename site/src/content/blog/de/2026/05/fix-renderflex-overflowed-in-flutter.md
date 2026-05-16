---
title: "Fix: A RenderFlex overflowed by N pixels in Flutter"
description: "Der Fix in 30 Sekunden: verpacken Sie das überlaufende Kind in Expanded oder Flexible. Danach lesen Sie den Rest, um zu verstehen, warum Row und Column nicht stillschweigend abschneiden, was unbeschränkte Constraints bedeuten und welcher Fix zu welchem Layout passt."
pubDate: 2026-05-16
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "renderflex"
lang: "de"
translationOf: "2026/05/fix-renderflex-overflowed-in-flutter"
translatedBy: "claude"
translationDate: 2026-05-16
---

Der Fix in einem Satz: verpacken Sie das Kind, das zu breit (oder zu hoch) geworden ist, in ein `Expanded` oder `Flexible`, setzen Sie `mainAxisSize: MainAxisSize.min` an dem umgebenden `Row` oder `Column`, oder verpacken Sie das Ganze in ein `SingleChildScrollView`, wenn der Inhalt wirklich scrollbar sein soll. Der gelb-schwarze Streifen ist kein Rendering-Bug, sondern Flutters Hinweis, dass ein unbeschränktes Kind innerhalb eines `Row`, `Column` oder `Flex` mehr Platz angefordert hat, als sein Eltern-Widget geben konnte.

```text
A RenderFlex overflowed by 124 pixels on the right.

The overflowing RenderFlex has an orientation of Axis.horizontal.
The edge of the RenderFlex that is overflowing has been marked in the rendering
with a yellow and black striped pattern. This is usually caused by the contents
being too big for the RenderFlex.

The relevant error-causing widget was:
  Row  lib/widgets/profile_header.dart:42
```

Dieses Handbuch ist gegen Flutter 3.27.1, Dart 3.11 und die Material-3-Widgets aus dem Stable-Channel geschrieben. Alles hier gilt unverändert ab Flutter 3.10 und durch die gesamte 3.x-Reihe. Die Widget-API für `Row`, `Column`, `Expanded`, `Flexible` und `Flex` hat sich seit Jahren nicht geändert; der zugrundeliegende `RenderFlex` liegt in `package:flutter/src/rendering/flex.dart`, und dort wird die Assertion ausgelöst.

## Warum Row und Column nicht stillschweigend abschneiden

Flutter macht Layout in einem einzigen Durchgang. Jeder Eltern-Knoten reicht ein `BoxConstraints`-Objekt an seine Kinder weiter, die Kinder wählen eine Größe, die diese Constraints erfüllt, und der Eltern-Knoten positioniert sie. Die meisten Widgets akzeptieren, was ihr Kind wählt, doch `Row`, `Column` und das zugrundeliegende `Flex`-Widget sind anders: sie legen erst die nicht flexiblen Kinder mit ihrer intrinsischen Größe aus und teilen dann den verbleibenden Platz unter den `Expanded`- und `Flexible`-Kindern auf. Wenn die nicht flexiblen Kinder zusammen den Platz auf der Hauptachse übersteigen, gibt es nichts zu verteilen und das Layout liegt über dem Budget.

`RenderFlex` könnte den Überlauf stillschweigend abschneiden, doch das würde Layout-Fehler verbergen, die nur auf dem kleinsten Gerät Ihrer Flotte auftreten. Daher gibt Flutter im Debug-Modus die Assertion aus, malt das gestreifte Warnrechteck auf die überlaufende Kante und rendert weiter. Im Release-Modus verschwindet der Streifen, doch das Layout bleibt falsch: Text wird abgeschnitten, Tap-Bereiche liegen außerhalb des Bildschirms, und Screen Reader lesen Inhalte vor, die der Benutzer nicht sehen kann. Das ist auf der [Common-Flutter-errors-Seite](https://docs.flutter.dev/testing/common-errors) dokumentiert und stimmt mit dem Kommentar am Anfang von [flex.dart im Flutter-SDK](https://github.com/flutter/flutter/blob/3.27.1/packages/flutter/lib/src/rendering/flex.dart) überein.

## Eine minimale Reproduktion zum Einfügen in eine frische App

```dart
// Flutter 3.27.1, Dart 3.11
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: OverflowDemo()));

class OverflowDemo extends StatelessWidget {
  const OverflowDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            const Icon(Icons.message),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('Title', style: Theme.of(context).textTheme.headlineMedium),
                const Text(
                  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, '
                  'sed do eiusmod tempor incididunt ut labore et dolore '
                  'magna aliqua.',
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
```

Das ist der kanonische Fall. Das äußere `Row` hat seine Breite vom `Scaffold` beschränkt, `Icon` und `SizedBox` sind nicht flexibel und klein, doch das innere `Column` ist ebenfalls nicht flexibel und umschließt einen `Text`, der so breit sein möchte wie der gesamte Absatz auf einer einzigen Zeile. Führen Sie das auf einem Telefon-Layout aus und Sie erhalten den Überlauf an der rechten Kante.

## Den richtigen Fix wählen: Expanded, Flexible oder scrollbar

Es gibt drei richtige Fixes, und sie sind nicht austauschbar.

### Fix 1: verpacken Sie das gefräßige Kind in `Expanded`

Verwenden Sie dies, wenn das Kind den gesamten verbleibenden Platz auf der Hauptachse einnehmen soll. In der Reproduktion ist das `Column` das gefräßige Kind:

```dart
// Flutter 3.27.1, Dart 3.11
Row(
  children: [
    const Icon(Icons.message),
    const SizedBox(width: 8),
    Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('Title', style: Theme.of(context).textTheme.headlineMedium),
          const Text(
            'Lorem ipsum dolor sit amet, consectetur adipiscing elit, '
            'sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
          ),
        ],
      ),
    ),
  ],
)
```

`Expanded` ist `Flexible` mit `flex: 1` und `fit: FlexFit.tight`. "Tight" bedeutet, dass das Kind den zugewiesenen Platz exakt füllen muss. Innerhalb eines `Row` gibt das dem inneren `Text` eine beschränkte Breite, sodass die Text-Engine den Inhalt auf mehrere Zeilen umbrechen kann. Der Überlauf ist weg, weil die intrinsische Breite des `Text` nicht mehr in die Breitenberechnung des `Row` einfließt.

In 80 Prozent der Fälle ist das der richtige Fix. Setzen Sie ihn ein, wann immer Sie ein führendes Icon plus einen Text-Körper in einer Zeile haben oder einen Header plus einen scrollbaren Körper in einer Spalte. Siehe die [Referenz der Expanded-Klasse](https://api.flutter.dev/flutter/widgets/Expanded-class.html) für den formalen Vertrag.

### Fix 2: verpacken Sie ein Kind in `Flexible`, wenn es kleiner als sein Anteil sein darf

`Flexible` verwendet standardmäßig `fit: FlexFit.loose`, was bedeutet "Sie dürfen bis zu so viel Platz nutzen, müssen ihn aber nicht füllen." Setzen Sie es ein, wenn Sie zwei Kinder haben, die den verbleibenden Platz proportional teilen sollen, aber keines davon seinen Anteil ausfüllen muss. Der Klassiker sind zwei gleich wichtige `TextField` nebeneinander, die jeweils die Hälfte der Zeile einnehmen:

```dart
// Flutter 3.27.1, Dart 3.11
Row(
  children: [
    Flexible(child: TextField(decoration: const InputDecoration(labelText: 'First'))),
    const SizedBox(width: 8),
    Flexible(child: TextField(decoration: const InputDecoration(labelText: 'Last'))),
  ],
)
```

Würden Sie hier `Expanded` einsetzen, teilten die Felder die Zeile zwar weiter 50/50, doch wäre eines davon ein `Chip` statt eines `TextField`, würde `Expanded` die Trefferfläche des Chips über die volle Breite spannen, was kaputt aussieht. `Flexible` mit der natürlichen Breite des Chips behält die richtige visuelle Größe bei und löst trotzdem den Überlauf.

Die Faustregel: `Expanded` für "fülle den Rest", `Flexible` für "du darfst bis zum Rest wachsen". Die falsche Wahl führt meist nicht zum Überlauf, sondern zu einem hässlich gestreckten Widget.

### Fix 3: machen Sie die Achse scrollbar, wenn der Inhalt wirklich nicht passt

Überläufe am unteren Rand eines `Column` innerhalb eines Telefonbildschirms sind fast immer ein Zeichen dafür, dass der Benutzer scrollen soll. Der Fix ist nicht `Expanded`, sondern das `Column` in ein `SingleChildScrollView` zu setzen (oder durch ein `ListView` zu ersetzen):

```dart
// Flutter 3.27.1, Dart 3.11
Scaffold(
  body: SingleChildScrollView(
    padding: const EdgeInsets.all(16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final section in sections) SectionCard(section),
      ],
    ),
  ),
)
```

Für eine lange Liste mit bekannter Elementanzahl und gleichartigen Kindern bevorzugen Sie `ListView.builder`, das nur die sichtbaren Elemente lazy aufbaut. Ein `SingleChildScrollView` mit einem `Column` baut jedes Kind in jedem Frame neu auf, was bei einer Einstellungsseite mit acht Zeilen kein Problem ist, bei einem Feed mit tausend Zeilen jedoch ruinös wird. Die [Scrolling-Dokumentation von Flutter](https://docs.flutter.dev/ui/layout/scrolling) zieht diese Grenze klar.

## Ursache für Ursache: die vier Wege, auf denen sich dieser Fehler einschleicht

### Ein `Text`-Widget in einem `Row` ohne beschränkte Breite

Die häufigste Ursache, in der Reproduktion oben gezeigt. Lange Strings, lange Produktnamen und übersetzte UI-Strings (Deutsch ist bekanntlich breiter als Englisch) sprengen `Row`s, die auf der Entwicklermaschine funktionierten. Verpacken Sie vom Benutzer eingegebenen oder lokalisierten Text in einem `Row` immer in `Expanded` oder `Flexible`. Soll der Text statt umzubrechen abgeschnitten werden, ergänzen Sie `overflow: TextOverflow.ellipsis` und `maxLines: 1` direkt am `Text`-Widget:

```dart
// Flutter 3.27.1, Dart 3.11
Row(
  children: [
    const Icon(Icons.person),
    const SizedBox(width: 8),
    Expanded(
      child: Text(
        user.fullName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    ),
  ],
)
```

### Unbeschränkte Hauptachse: ein `Column` in einem `Column` oder ein `Row` in einem `Row`

Ist ein `Column` Kind eines anderen `Column`, erhält das innere unbeschränkte Höhe. Alles darin, das "so viel wie ich will" anfordert, bekommt Unendlich, worüber RenderFlex sich dann beschwert. Der Fix besteht darin, das innere `Column` in `Expanded` zu verpacken, oder `mainAxisSize: MainAxisSize.min` zu setzen und das Ganze in ein scrollbares Element zu legen.

Dasselbe gilt für ein `Row` in einem `Row`, ein `ListView` in einem `Column` oder jede Kombination, in der die Hauptachse unbeschränkt ist. Lesen Sie [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) einmal durch, und der Rest verliert seine Überraschung; es erklärt das Mantra "constraints go down, sizes go up, parent sets position", auf dem das gesamte Layout-System fußt. Dieselbe Constraint-Propagation verursacht auch Jank bei Resize-Stürmen, was wir in [Jank in einer Flutter-App mit DevTools profilen](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) behandeln.

### Hartkodierte `width` oder `height` von einem SizedBox oder Container

Ein `SizedBox(width: 400)` innerhalb eines telefonbreiten `Row` läuft rechts um `400 - rowWidth + remaining children` Pixel über. Das ist der einzige Fall, in dem der Fix nicht `Expanded` heißt, sondern "Breite nicht hartkodieren." Verwenden Sie ein Layout, das sich anpasst: `Expanded`, `Flexible`, `FractionallySizedBox(widthFactor: 0.5)` oder berechnen Sie die Größe aus `MediaQuery.sizeOf(context)`.

Dasselbe gilt für Bilder. Ein `Image.network` ohne Breiten-Constraint meldet seine intrinsische Größe, die für ein serverseitig geliefertes Asset bei 2000 Pixeln liegen kann. Geben Sie dem `Image` entweder eine beschränkte Breite (`Image.network(url, width: 64)`) oder verpacken Sie es in `Expanded`.

### Lokalisierung, Schriftskalierung und Barrierefreiheits-Textgrößen

Ein `Row`, das bei Standard-Schriftskalierung perfekt passt, läuft bei 1.4x oder 2.0x Text-Skalierung über. Das ist der Bug, der im App Store landet und eine Ein-Stern-Bewertung von einem Nutzer mit großen Schriften bekommt. Testen Sie jede Seite mit `MediaQuery`-Overrides bei barrierefreien Skalen:

```dart
// Flutter 3.27.1, Dart 3.11
MaterialApp(
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.5)),
    child: child!,
  ),
  home: const MyHomePage(),
)
```

`TextScaler` ersetzt seit Flutter 3.16 die ältere `textScaleFactor`-API und ist der unterstützte Weg, Textskalierung zu testen. Läuft das Layout unter diesem `MediaQuery`-Wrapper über, läuft es auch auf echten Geräten über, und der Fix ist derselbe: `Expanded`, `Flexible` oder scrollbar.

## Herausfinden, welches Widget überläuft

Die Assertion nennt immer ein Widget und eine Quellcode-Position, doch die Position zeigt auf das `Row` oder `Column`, das überläuft, nicht auf das Kind, das den Ärger verursacht. Drei Werkzeuge grenzen das ein:

1. Der gelb-schwarze Streifen im Debug-Modus verrät die Kante (rechts, unten usw.), was die Suche bereits eingrenzt.
2. Schalten Sie "Debug Paint" im Flutter Inspector ein (auch verfügbar als `debugPaintSizeEnabled = true;` in `main`), um die Umrisse jeder Render-Box zu sehen. Das gefräßige Kind ragt meist sichtbar über den Eltern-Knoten hinaus.
3. Aktivieren Sie den Widget-Auswahlmodus des Inspectors und klicken Sie im Simulator auf den fraglichen Bereich. Das `RenderObject`-Panel des gewählten Widgets zeigt Größe und Constraints. Vergleichen Sie sie mit denen des Eltern-Knotens.

Für tiefergehende Werkzeuge unterstützt dieselbe DevTools-Sitzung, die Sie für Performance-Arbeit nutzen, Layout-Debugging im Tab Layout Explorer. Falls Sie diesen Workflow nicht kennen, führt der Beitrag zu [Jank in einer Flutter-App mit DevTools profilen](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) durch das Öffnen von DevTools im Profile-Modus gegen ein echtes Gerät.

## Fallstricke und ähnlich aussehende Fehler

- `Vertical viewport was given unbounded height` ist der Schwesterfehler, wenn ein `ListView` in einem `Column` ohne `Expanded` lebt. Der Fix hat dieselbe Form: Kind beschränken oder Eltern-Knoten scrollbar machen. Setzen Sie nicht `shrinkWrap: true` am `ListView` als "Fix"; das deaktiviert das Lazy Rendering und reproduziert den ursprünglichen Überlauf bei höheren Scroll-Positionen.
- `RenderBox was not laid out` heißt, dass weiter oben eine RenderFlex-Überlauf-Assertion ausgelöst wurde und die Layout-Pipeline nie zur Paint-Geometrie kam. Scrollen Sie im Fehler-Log nach oben zur ersten Überlauf-Meldung; dort sitzt der echte Bug.
- `BoxConstraints forces an infinite width` von `Text` bedeutet, dass `Text` in etwas liegt, das eine unbeschränkte Hauptachse liefert, typischerweise ein `Row` in einem horizontalen `ListView`. Verpacken Sie `Text` in einen Container mit fester Breite oder verwenden Sie `Flexible`.
- `A RenderFlex overflowed by Infinity pixels` ist die Variante mit unbeschränkter Constraint. Der Fix ist nie "die Zahl kleiner machen", sondern "dem Eltern-Knoten eine beschränkte Constraint geben", typischerweise durch `Expanded` weiter oben im Baum.
- Das Unterdrücken des Warnstreifens mit `clipBehavior: Clip.hardEdge` am `Row` oder `Column` lässt den Streifen verschwinden, der zugrundeliegende Layout-Bug bleibt. Greifen Sie nur dann zu Clipping, wenn Sie bewiesen haben, dass der Überlauf gewollt ist (etwa eine bewusst beschnittene Lauftext-Leiste).

## Verwandtes

- [Jank in einer Flutter-App mit DevTools profilen](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) behandelt das Setup von DevTools, das gleichzeitig Ihr schnellster Layout-Debugger ist.
- [Akzentfarbe in einer Flutter-App mit Material 3 ColorScheme setzen](/de/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) ist der Ort, an dem die meisten Anfänger-Überlaufprobleme beginnen, da der Wechsel zu M3-Widgets intrinsische Größen ändert.
- [Plattformspezifischen Code in Flutter ohne Plugins ergänzen](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) wird relevant, sobald Sie Zeilen auf kleineren Geräten ausblenden.
- [Mehrere Flutter-Versionen aus einer CI-Pipeline ansteuern](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) ist wichtig, weil sich die exakte Pixelzahl in der Überlaufmeldung zwischen SDK-Versionen ändert, wenn sich Textmetriken verschieben.

## Quellen

- [Common Flutter errors -- A RenderFlex overflowed](https://docs.flutter.dev/testing/common-errors), der offizielle Abschnitt der Flutter-Dokumentation, der den Fehler und den kanonischen Fix definiert.
- [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints), die Erläuterung des Layout-Protokolls hinter jeder Flex-Layout-Entscheidung in diesem Beitrag.
- [Referenz der Expanded-Klasse](https://api.flutter.dev/flutter/widgets/Expanded-class.html), das API-Dokument, das `Expanded` als `Flexible(flex: 1, fit: FlexFit.tight)` festlegt.
- [Referenz der Flexible-Klasse](https://api.flutter.dev/flutter/widgets/Flexible-class.html), das API-Dokument, das `FlexFit.loose` vs `FlexFit.tight` erklärt.
- [Referenz der Row-Klasse](https://api.flutter.dev/flutter/widgets/Row-class.html) und [Referenz der Column-Klasse](https://api.flutter.dev/flutter/widgets/Column-class.html), die den Hauptachsen-Sizing-Algorithmus wörtlich beschreiben.
- [flex.dart am Tag 3.27.1](https://github.com/flutter/flutter/blob/3.27.1/packages/flutter/lib/src/rendering/flex.dart), die Quelle, in der die Überlauf-Assertion ausgelöst wird.
