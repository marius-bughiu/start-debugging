---
title: "Flutter Text: das `leadingDistribution`-Detail, das verändert, wie Ihre UI \"atmet\""
description: "Die Eigenschaft leadingDistribution in Flutters TextHeightBehavior steuert, wie zusätzliches Leading ober- und unterhalb der Glyphen verteilt wird. Hier sehen Sie, wann sie zählt und wie sich vertikal verschoben wirkender Text korrigieren lässt."
pubDate: 2026-01-18
tags:
  - "dart"
  - "flutter"
lang: "de"
translationOf: "2026/01/flutter-text-the-leadingdistribution-detail-that-changes-how-your-ui-breathes"
translatedBy: "claude"
translationDate: 2026-04-29
---
Ein am 2026-01-16 veröffentlichtes Flutter-Tutorialvideo hat mich an eine subtile, aber sehr reale Quelle für "Warum sieht das schief aus?"-Bugs erinnert: Das `Text`-Widget ist einfach, bis Sie eigene Schriftarten, enge Zeilenhöhen und mehrzeilige Layouts kombinieren.

Quelle: [Video](https://www.youtube.com/watch?v=xen-Al9H-4k) und der ursprüngliche [r/FlutterDev-Beitrag](https://www.reddit.com/r/FlutterDev/comments/1qfhug1/how_well_do_you_really_know_the_text_widget/).

## Zeilenhöhe ist nicht nur `TextStyle.height`

In Flutter 3.x justieren Entwickler oft:

-   `TextStyle(height: ...)`, um Zeilen enger oder lockerer zu setzen
-   `TextHeightBehavior(...)`, um zu steuern, wie Leading angewendet wird

Wenn Sie nur `height` setzen, kann der Text trotzdem in einer `Row` vertikal "nicht zentriert" wirken, oder Überschriften fühlen sich gegenüber dem Fließtext zu luftig an. Genau hier kommt `leadingDistribution` ins Spiel.

`leadingDistribution` steuert, wie das zusätzliche Leading (der durch die Zeilenhöhe hinzugefügte Raum) ober- und unterhalb der Glyphen verteilt wird. Der Standardwert ist nicht immer das, was Sie für UI-Typografie wollen.

## Ein kleines Widget, das den Unterschied offensichtlich macht

Hier ist ein minimales Snippet, das Sie in einen Screen einsetzen und visuell vergleichen können:

```dart
import 'package:flutter/material.dart';

class LeadingDistributionDemo extends StatelessWidget {
  const LeadingDistributionDemo({super.key});

  @override
  Widget build(BuildContext context) {
    const style = TextStyle(
      fontSize: 20,
      height: 1.1, // intentionally tight so leading behavior is visible
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: const [
        Text('Default leadingDistribution', style: style),
        SizedBox(height: 8),
        Text(
          'Even leadingDistribution\n(two lines to show it)',
          style: style,
          textHeightBehavior: TextHeightBehavior(
            leadingDistribution: TextLeadingDistribution.even,
          ),
        ),
      ],
    );
  }
}
```

Wenn Sie die beiden Blöcke nebeneinander sehen, fällt es bei echten Schriftarten meist sofort auf: Ein Block sitzt "besser" in seinem vertikalen Raum, besonders wenn Sie ihn an Icons ausrichten oder die Höhe eines Containers begrenzen.

## Wo das in echten Apps wirklich beißt

Dieses Detail tritt vor allem in den Bereichen von Flutter-Apps zutage, die sich am schwersten pixelgenau halten lassen:

-   **Buttons und Chips**: Der Label-Text wirkt im Verhältnis zum Container zu tief oder zu hoch.
-   **Cards mit gemischtem Inhalt**: Ein Stapel aus Überschrift und Untertitel wirkt nicht gleichmäßig verteilt.
-   **Eigene Schriftarten**: Ascent/Descent-Metriken variieren stark zwischen Typografien.
-   **Internationalisierung**: Schriftsysteme mit anderen Glyphen-Metriken bringen Ihre Spacing-Annahmen ans Licht.

Die Lösung lautet nicht "immer `leadingDistribution` setzen". Die Lösung lautet: Wenn Sie Typografie aufräumen, gehört `TextHeightBehavior` ins mentale Modell, nicht nur `fontSize` und `height`.

Wenn Ihre Flutter-3.x-UI zu 95 % steht, sich aber leicht schief anfühlt, ist das einer der ersten Stellschrauben, die ich prüfe.
