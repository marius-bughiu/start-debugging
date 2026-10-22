---
title: "Expanded vs Flexible in Flutter: FlexFit.tight vs FlexFit.loose erklärt"
description: "Verwenden Sie Expanded, wenn ein Kind seinen Anteil an einer Row oder Column ausfüllen muss, und Flexible, wenn es kleiner als sein Anteil sein darf. Gemessene Layouts mit Flutter 3.44 zeigen, wohin der übrige Platz geht, warum lose Kinder ihn nie an Geschwister abgeben und wann bei unbegrenzten Constraints nur Flexible überlebt."
pubDate: 2026-10-22
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "layout"
  - "constraints"
lang: "de"
translationOf: "2026/10/expanded-vs-flexible-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-22
---

**Kurze Antwort:** `Expanded` ist buchstäblich `Flexible(fit: FlexFit.tight)`. Verwenden Sie `Expanded`, wenn das Kind seinen Anteil an der `Row` oder `Column` ausfüllen muss (Listen, Panels, alles mit Hintergrund). Verwenden Sie `Flexible` (das Standard-`FlexFit.loose`), wenn das Kind kleiner als sein Anteil sein darf, der klassische Fall ist ein `Text`, der bei Überlänge abgeschnitten werden, bei Kürze aber nur so viel Platz wie sein Inhalt einnehmen soll. Beide erhalten dieselbe maximale Größe; nur `Expanded` zwingt das Kind auf diese Größe. Alles Folgende wurde mit `flutter test` unter Flutter 3.44.8 / Dart 3.12.2 gemessen.

Die Verwirrung ist nachvollziehbar, denn in den häufigsten Layouts sehen beide gleich aus. Eine `ListView` oder ein `Container` ohne Kind will den gesamten verfügbaren Platz, daher erzeugt der Wechsel zwischen beiden Widgets dieselben Pixel. Der Unterschied zeigt sich erst, wenn das Kind gern klein ist, und genau dort entstehen ein gestrecktes Chip, ein an den äußersten Rand geschobenes Icon in einer Zeile oder eine Lücke, die sich niemand erklären kann.

## Der Vergleich im Überblick

| Verhalten (Flutter 3.44)                                    | `Expanded`                         | `Flexible` (Standard)                  |
| ----------------------------------------------------------- | ---------------------------------- | -------------------------------------- |
| Fit                                                         | `FlexFit.tight`                    | `FlexFit.loose`                        |
| Auf der Hauptachse übergebener Constraint                   | min = max = Anteil                 | min = 0, max = Anteil                  |
| Kind kleiner als sein Anteil                                | wird auf den Anteil gestreckt      | behält seine eigene Größe              |
| Ungenutzter Teil des Anteils                                | keiner                             | wird zu freiem Platz, nicht an Geschwister vergeben |
| `mainAxisAlignment` hat eine Wirkung                        | nein (kein freier Platz übrig)     | ja                                     |
| `Row(mainAxisSize: MainAxisSize.min)` schrumpft             | nein, die Zeile nimmt die volle Breite | ja                                 |
| In einer unbegrenzten Hauptachse (Scroll View)              | immer eine Assertion               | erlaubt bei `mainAxisSize: MainAxisSize.min` |
| Konfigurierbares `fit`                                      | nein                               | ja                                     |

Wenn Sie sich nur eine Zeile merken, dann die dritte: tight streckt, loose nicht.

## Was das Framework mit den beiden Fits tatsächlich tut

Der Quellcode ist kurz genug zum Zitieren. In `packages/flutter/lib/src/widgets/basic.dart` unter 3.44.8:

```dart
// Flutter 3.44.8, widgets/basic.dart
class Flexible extends ParentDataWidget<FlexParentData> {
  const Flexible({super.key, this.flex = 1, this.fit = FlexFit.loose, required super.child});
  // ...
}

class Expanded extends Flexible {
  const Expanded({super.key, super.flex, required super.child}) : super(fit: FlexFit.tight);
}
```

Keines der beiden Widgets führt ein Layout durch. Es sind `ParentDataWidget`s, die `flex` und `fit` in die `FlexParentData` des Kindes schreiben, welche `RenderFlex` (das Render-Objekt hinter `Row`, `Column` und `Flex`) beim Layout liest. Deshalb lösen beide denselben Fehler "must be placed inside Flex widgets" aus, wenn Sie sie unter einem Nicht-Flex-Elternteil platzieren.

`RenderFlex._computeSizes` in `rendering/flex.dart` läuft in zwei Durchgängen:

1. Alle Kinder mit `flex == 0` (normale Widgets) werden in ihrer natürlichen Größe gelayoutet, und ihre Ausdehnungen auf der Hauptachse werden summiert.
2. `spacePerFlex = (maxMainSize - usedByNonFlexChildren) / totalFlex` wird **einmal** berechnet, danach wird jedes Flex-Kind mit einem Maximum von `spacePerFlex * flex` gelayoutet. Bei `FlexFit.tight` entspricht das Minimum diesem Maximum. Bei `FlexFit.loose` ist das Minimum `0`.

Entscheidend ist das "einmal". Der Anteil steht fest, bevor ein flexibles Kind gemessen wird. Wenn ein loses Kind weniger als seinen Anteil nutzt, wird der Rest nicht an seine Geschwister weitergegeben. Er wird zu freiem Platz für `mainAxisAlignment`, und das ist die Ursache der meisten Fragen der Art "Warum gibt es hier eine Lücke".

## Gemessen: dasselbe Kind unter beiden Fits

Alle folgenden Zahlen stammen aus Widget-Tests, die die `Row` auf eine 400 logische Pixel breite Box festlegen und `tester.getSize` sowie `tester.getTopLeft` auslesen. Hier sind das Test-Gerüst und der erste Fall:

```dart
// Flutter 3.44.8, Dart 3.12.2, flutter_test
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget host(Widget child) => Directionality(
      textDirection: TextDirection.ltr,
      child: Align(
        alignment: Alignment.topLeft,
        child: SizedBox(width: 400, height: 100, child: child),
      ),
    );

const a = Key('a'), b = Key('b');

void main() {
  testWidgets('tight vs loose with a small child', (t) async {
    await t.pumpWidget(host(Row(children: [
      Expanded(child: SizedBox(key: a, width: 50, height: 10)),
      Flexible(child: SizedBox(key: b, width: 50, height: 10)),
    ])));
    print('Expanded=${t.getSize(find.byKey(a))} '
        'Flexible=${t.getSize(find.byKey(b))}');
  });
}
```

Ausgabe: `Expanded=Size(200.0, 10.0) Flexible=Size(50.0, 10.0)`. Beiden Kindern wurden 200 Pixel angeboten (400 geteilt durch eine Gesamt-Flex von 2). Die `SizedBox(width: 50)` unter `Expanded` wurde vom Tight-Constraint überschrieben und wurde 200 breit; unter `Flexible` behielt sie ihre 50. Die `width: 50` ist nur ein Wunsch, und ein Tight-Constraint des Elternteils gewinnt immer.

Der vollständige Satz an Proben, gleiche 400 px breite Zeile:

| Layout (Flutter 3.44.8)                                                        | Ergebnis                                            |
| ------------------------------------------------------------------------------ | --------------------------------------------------- |
| `Expanded(SizedBox(w: 50))` + `Flexible(SizedBox(w: 50))`                      | 200 und 50                                          |
| `Flexible(SizedBox(w: 50))` + `Flexible(SizedBox(w: 1000))`                    | 50 und 200, 150 px am Ende ungenutzt                |
| `SizedBox(w: 100)` + `Expanded(flex: 2)` + `Flexible(flex: 1, SizedBox(w: 40))` | 200 und 40, 60 px ungenutzt                        |
| `Flexible(fit: FlexFit.tight, SizedBox(w: 50))` + `SizedBox(w: 100)`           | 300, identisch mit `Expanded`                       |
| `Flexible(Container(color: ...))` + `SizedBox(w: 100)`                         | 300 x 100, der Loose-Fit änderte nichts             |

Die zweite Zeile sollten Sie verinnerlichen. Das 1000 Pixel breite Kind wurde auf 200 begrenzt, obwohl sein Geschwister nur 50 nutzte, weil die ungenutzten 150 des Geschwisters nie umverteilt wurden. Wenn Sie möchten, dass das kleine Kind nimmt, was es braucht, und das große den Rest bekommt, darf das kleine gar nicht flexibel sein: Machen Sie es zu einem normalen Kind, und nur das große zu `Expanded`.

Die letzte Zeile erklärt, warum so viele zu dem Schluss kommen, "Flexible und Expanded seien dasselbe". Ein `Container` ohne Kind, ohne Breite und ohne Ausrichtung nimmt die größte Größe an, die seine Constraints erlauben. Geben Sie ihm ein loses Maximum von 300, wählt er 300. Dasselbe gilt für `ListView`, `TextField` (das seine Breite ausfüllt) und alles andere, was standardmäßig expandiert. Bei gierigen Kindern ist der Fit unsichtbar.

## Wann Expanded die richtige Wahl ist

- **Ein scrollbares Widget in einer `Column`.** `Column(children: [Header(), Expanded(child: ListView(...))])` ist das kanonische Layout. Die Liste braucht eine begrenzte Höhe, und zwar genau die verbleibende Höhe, damit ihre Scroll-Ausdehnung stimmt. Das ist die erste Lösung in [der Anleitung zu ListView in einer Column](/de/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/), und [der Grund, warum sie bei langen Listen besser ist als `shrinkWrap`](/de/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/), ist, dass die Liste ihre Kinder weiterhin lazy aufbaut.
- **Panels mit Hintergrund, Rahmen oder Trefferfläche.** Eine farbige Seitenleiste und ein Inhaltsbereich im Verhältnis 1:3 sollten `Expanded(flex: 1)` und `Expanded(flex: 3)` verwenden, damit die Farben unabhängig von der Inhaltsgröße von Rand zu Rand reichen.
- **Proportionale Raster aus `Row`s.** Wenn drei Zellen mit drei Zellen der nächsten Zeile fluchten müssen, garantieren Tight-Fits gleiche Breiten. Bei Loose-Fits driftet jede Zeile mit ihrem Inhalt.
- **Dinge auseinanderschieben.** `Spacer()` ist `Expanded(flex: flex, child: SizedBox.shrink())`. In der Probe setzt `SizedBox(w: 50)`, `Spacer()`, `SizedBox(w: 50)` die zweite Box bei x = 350, bündig rechts.

## Wann Flexible die richtige Wahl ist

- **Text, der nur abgeschnitten werden soll, wenn es sein muss.** Das ist der Fall, der in echten Apps am meisten zählt. Vergleichen Sie ein Label mit nachfolgendem Icon:

```dart
// Flutter 3.44.8: label that hugs its text but ellipsizes when long
Row(
  children: [
    Flexible(
      child: Text(
        userName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    ),
    const Icon(Icons.verified, size: 16),
  ],
)
```

Gemessen in einer 400 px breiten Zeile innerhalb eines `Scaffold`, mit `userName = 'Short'`: Unter `Flexible` ist der Text 71,25 px breit, und das Icon sitzt bei x = 71,25, direkt neben dem Namen. Tauschen Sie `Expanded` ein, wird der Text 376 px breit, und das Icon wird nach x = 376 geschoben, an den äußersten Rand der Zeile. Bei einem langen Namen begrenzen beide Varianten den Text auf 376 px und zeigen eine Ellipse, die Lösung für den Überlauf ist also dieselbe, aber nur `Flexible` lässt den kurzen Fall richtig aussehen. Wenn Sie wegen des gelb-schwarzen Streifens hier sind, behandelt die [Anleitung zu RenderFlex overflowed](/de/2026/05/fix-renderflex-overflowed-in-flutter/) die anderen Ursachen.

- **Chips, Badges und Buttons, die ihre natürliche Größe behalten sollen**, aber auf schmalen Bildschirmen oder bei großer Barrierefreiheits-Schrift nicht überlaufen dürfen. Tight-Fits strecken ihre Trefferfläche über die ganze Zeile.
- **Wenn `mainAxisAlignment` funktionieren soll.** Mit zwei losen Kindern von je 50 px und `MainAxisAlignment.spaceBetween` landet das zweite Kind bei x = 350. Mit zwei `Expanded`-Kindern wird die Ausrichtung ignoriert, und das zweite landet bei x = 200, weil ein Tight-Layout keinen freien Platz zum Verteilen hat.
- **Zeilen, die sich an ihren Inhalt anpassen.** `Row(mainAxisSize: MainAxisSize.min, children: [Flexible(child: SizedBox(width: 50)), SizedBox(width: 20)])` maß 70 px Breite. Dieselbe Zeile mit `Expanded` maß die vollen 400 px, weil ein Tight-Kind den gesamten vom Elternteil angebotenen Platz verbraucht und für `MainAxisSize.min` nichts mehr zu minimieren bleibt. Das trifft Leute, die einen pillenförmigen Container bauen, der sein Label umschließen soll.

## Der Stolperstein, der die Wahl für Sie trifft: unbegrenzte Hauptachse

Setzen Sie eine `Column` in eine `SingleChildScrollView` (oder eine `Row` in eine horizontale `ListView`), und das Flex erhält einen unendlichen Constraint auf der Hauptachse. `RenderFlex` kann Unendlich nicht teilen, daher setzt es in `_computeSizes` `canFlex = false` und layoutet jedes Kind, als hätte es gar kein Flex.

Was dann passiert, hängt vom Fit ab. Die Debug-Prüfung `_debugCheckConstraints` wirft einen Fehler, wenn ein Kind ein Flex ungleich null hat **und** entweder das Flex `MainAxisSize.max` verwendet oder das Kind `FlexFit.tight` ist:

```dart
// Flutter 3.44.8: throws in debug
SingleChildScrollView(
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Expanded(child: SizedBox(height: 50)),
    ],
  ),
)
// RenderFlex children have non-zero flex but incoming height constraints are unbounded.
```

```dart
// Flutter 3.44.8: lays out fine, child is 50 px tall
SingleChildScrollView(
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Flexible(child: SizedBox(height: 50)),
    ],
  ),
)
```

Beides wurde in der Probe verifiziert: Die `Expanded`-Variante löste die Assertion aus, die `Flexible`-Variante layoutete ein 10 x 50 großes Kind ohne Exception. Das ist für wiederverwendbare Widgets wichtig. Wenn eine Komponente einen Teil von sich in `Expanded` einwickelt, kann sie nie in eine scrollbare Spalte gesetzt werden. Verwendet sie `Flexible` und ihre Spalte `MainAxisSize.min`, degradiert sie elegant: Bei begrenztem Elternteil flext sie, bei unbegrenztem nimmt sie ihre natürliche Größe an. Beachten Sie, dass im unbegrenzten Fall das `Flexible` faktisch wirkungslos ist, ein gieriges Kind darunter (eine `ListView`) wirft also weiterhin seinen eigenen Fehler "unbounded height".

## Kleinere Stolpersteine und Varianten

**`flex: 0` schaltet das Widget ab.** `RenderFlex` prüft `flex > 0`, bevor es ein Kind als flexibel behandelt. `Flexible(flex: 0, ...)` wird wie ein normales Kind gelayoutet. `Spacer` prüft per Assertion `flex > 0`, damit Ihnen das nicht versehentlich passiert.

**`Flexible(fit: FlexFit.tight)` und `Expanded` sind austauschbar.** Die Probe lieferte identische Größen. Bevorzugen Sie `Expanded` wegen der Lesbarkeit; greifen Sie nur dann zu einem expliziten `fit`, wenn er berechnet wird, zum Beispiel `Flexible(fit: isCompact ? FlexFit.loose : FlexFit.tight, child: ...)`.

**Die Querachse bleibt unberührt.** Beide Widgets beschränken nur die Hauptachse. Wenn das Kind auch die Querachse ausfüllen soll, ist das `crossAxisAlignment: CrossAxisAlignment.stretch` an der `Row` oder `Column`, kein anderes Flex-Widget.

**`spacing` wird zuerst abgezogen.** Seit Flutter 3.27 haben `Row` und `Column` einen Parameter `spacing`. `_computeSizes` setzt den verbrauchten Platz vor der Teilung auf `spacing * (childCount - 1)`, die Abstände werden also abgezogen, bevor ein Flex-Anteil berechnet wird.

**Verketten Sie sie nicht.** `Expanded(child: Flexible(...))` löst den ParentDataWidget-Fehler aus, weil das Elternteil des inneren kein Flex ist. Die vollständige Liste der Wrapper, die das verursachen, steht in [der Lösung zu "Expanded widgets must be placed inside Flex widgets"](/de/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/).

## Die Empfehlung samt Hintergrund

Verwenden Sie standardmäßig `Expanded`. Die meisten flexiblen Kinder in echten Apps sind scrollbare Widgets, Panels oder Felder, die ohnehin den gesamten Platz wollen, und Tight-Fits liefern vorhersagbare, ausgerichtete Layouts ohne Überraschungen durch freien Platz.

Wechseln Sie in genau drei Situationen zu `Flexible`: wenn das Kind eine natürliche Größe hat, die Sie behalten möchten (Text neben einem Icon, ein Chip), wenn `mainAxisAlignment` oder `MainAxisSize.min` weiter funktionieren müssen, oder wenn Sie ein wiederverwendbares Widget schreiben, das in einer Scroll View landen kann. Und wenn Sie sich dabei ertappen, `Flexible` auf zwei Geschwister zu setzen, in der Erwartung, dass das kleine Platz an das große abgibt, halten Sie inne: Machen Sie das kleine zu einem normalen Kind und das große zu `Expanded`, denn `RenderFlex` verteilt den ungenutzten Anteil eines losen Kindes nie um.

## Verwandte Artikel

- [Fix "A RenderFlex overflowed by N pixels" in Flutter](/de/2026/05/fix-renderflex-overflowed-in-flutter/) für die Überlauf-Fälle, in denen die Wahl zwischen den beiden die Lösung ist.
- [Warum eine ListView in einer Column einen Fehler wegen unbegrenzter Höhe auslöst](/de/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) und die vier Wege, sie zu begrenzen.
- [shrinkWrap vs Expanded vs Slivers bei langen Listen](/de/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/), wenn das flexible Kind ein scrollbares Widget ist.
- [Behebung von "Incorrect use of ParentDataWidget"](/de/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/), wenn `Expanded` oder `Flexible` kein direktes Flex-Kind ist.

## Quellen

- [Flexible class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Flexible-class.html)
- [Expanded class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Expanded-class.html)
- [FlexFit enum, Flutter API reference](https://api.flutter.dev/flutter/rendering/FlexFit.html)
- [Spacer class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Spacer-class.html)
- [RenderFlex source, flutter/flutter `rendering/flex.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/rendering/flex.dart)
- [Understanding constraints, Flutter docs](https://docs.flutter.dev/ui/layout/constraints)
