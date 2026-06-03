---
title: "Lösung: RenderBox was not laid out in Flutter"
description: "RenderBox was not laid out ist fast immer ein Folgefehler. Suchen Sie die erste Layout-Assertion darüber, meist ein Scrollable mit unbeschränkten Constraints, und beheben Sie diese."
pubDate: 2026-06-03
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "renderbox"
lang: "de"
translationOf: "2026/06/fix-renderbox-was-not-laid-out-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-03
---

`RenderBox was not laid out` bedeutet, dass Flutter versucht hat, eine Render-Box zu zeichnen oder ein Hit-Test darauf durchzuführen, deren Größe nie berechnet wurde. Es ist fast immer ein Folgefehler: Eine frühere Layout-Assertion hat `performLayout` für einen Teil des Baums abgebrochen, und diese Meldung sind nur die Trümmer. Die eigentliche Lösung besteht darin, in der Konsole zum ersten Fehler hochzuscrollen, der meist ein Scrollable (`ListView`, `GridView`, `SingleChildScrollView`) ist, dem unbeschränkte Constraints auf seiner Scroll-Achse gegeben wurden. Beschränken Sie dieses Widget mit `Expanded`, einer festen Größe oder `shrinkWrap`, und der Fehler verschwindet. Dieser Leitfaden verwendet Flutter 3.44 (stabil, Mai 2026) und Dart 3.x.

Die ausgelöste Assertion ist `hasSize` in `package:flutter/src/rendering/box.dart`. Eine `RenderBox` erhält ihre Größe nur während ihres `performLayout`-Durchlaufs. Wenn das Layout für diese Box nie erfolgreich lief, löst die Abfrage von `.size` (was sowohl das Zeichnen als auch das Hit-Testing tun) die Schutzprüfung aus. Deshalb ist die Meldung zwar präzise, aber für sich genommen wenig hilfreich: Sie benennt das Opfer, nicht den Verursacher.

## Der Fehler im Kontext

Der Konsolenblock sieht so aus. Der genaue Widget-Name und die Hex-IDs ändern sich, aber die Form bleibt konstant:

```
======== Exception caught by rendering library =====================
The following assertion was thrown during performLayout():
RenderBox was not laid out: RenderShrinkWrappingViewport#4aefd
  relayoutBoundary=up13 NEEDS-PAINT NEEDS-COMPOSITING-BITS-UPDATE
'package:flutter/src/rendering/box.dart': Failed assertion: line 1966
  pos 12: 'hasSize'

The relevant error-causing widget was:
  ListView  lib/widgets/feed.dart:58
====================================================================
```

Zwei Details sind wichtig. Erstens sagt das benannte Render-Object (`RenderShrinkWrappingViewport`, `RenderPadding`, `RenderRepaintBoundary`, was auch immer), welcher Teilbaum beim Layout gescheitert ist. Zweitens, und wichtiger: Dies ist selten die einzige Exception. Im Debug-Modus gibt Flutter den ersten Fehler aus und versucht dann weiter zu rendern, was eine Kaskade dieser `hasSize`-Assertions erzeugt. Die Meldung, auf die Sie reagieren sollten, steht oben in der Kaskade, nicht dort, wo Ihr Blick zuerst hängen bleibt.

## Warum das passiert

Eine `RenderBox` hat erst dann eine Größe, wenn `performLayout` ihr eine zuweist. Drei Situationen lassen eine Box ohne Größe zurück:

Der Box wurden Constraints gegeben, die sie nicht erfüllen kann, sodass ihr eigenes `performLayout` eine Exception ausgelöst hat. Der klassische Fall ist ein Scrollable, das eine unbeschränkte Constraint auf seiner Scroll-Achse erhalten hat. Eine vertikale `ListView` braucht eine beschränkte Höhe, um zu wissen, wie viel Viewport sie rendern soll; geben Sie ihr unendliche Höhe, löst sie `Vertical viewport was given unbounded height` aus, das Layout bricht ab, und jeder Vorfahre, der danach seine Größe lesen will, meldet `RenderBox was not laid out`.

Ein Eltern-Element hat ein Kind gezeichnet oder ein Hit-Test darauf durchgeführt, ohne es vorher zu layouten. Das ist der Bug beim eigenen `RenderObject`: Sie haben ein Render-Object geschrieben, dessen `paint` `child.size` liest, dessen `performLayout` aber vergessen hat, `child.layout(...)` aufzurufen. Das Kind hat nie eine Größe erhalten.

Jemand hat `.size` außerhalb der Layout-Phase gelesen. Das Lesen von `context.size` oder `renderBox.size` während `build`, `initState` oder eines synchronen Callbacks, bevor der erste Frame das Widget gelayoutet hat, löst dieselbe Assertion aus. Die Größe existiert schlicht noch nicht.

Die verbindende Regel ist der Layout-Vertrag von Flutter: Constraints gehen nach unten, Größen kommen nach oben zurück, und die Größe einer Box ist nur zwischen dem Ende ihres `performLayout` und dem nächsten `markNeedsLayout` gültig. Mehr dazu auf der offiziellen Seite [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints), dem nützlichsten Dokument für jeden Layout-Fehler in Flutter.

## Eine minimale Reproduktion, die Sie in eine neue App einfügen können

Der mit Abstand häufigste Auslöser: eine `ListView`, die direkt in eine `Column` gesetzt wird. Die `Column` gibt ihren Kindern unbeschränkte Höhe auf der Hauptachse, die `ListView` will eine beschränkte Höhe, und das Layout schlägt fehl.

```dart
// Flutter 3.44, Dart 3.x -- throws, layout aborts, "RenderBox was not laid out" follows.
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: FeedScreen()));

class FeedScreen extends StatelessWidget {
  const FeedScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: [
          const Text('Latest'),
          // ListView inside a Column: unbounded height on the main axis.
          ListView(
            children: const [
              ListTile(title: Text('One')),
              ListTile(title: Text('Two')),
              ListTile(title: Text('Three')),
            ],
          ),
        ],
      ),
    );
  }
}
```

Führen Sie das aus, und der erste Konsolenfehler ist `Vertical viewport was given unbounded height`. Die `RenderBox was not laid out`-Assertions darunter sind die Folge, nicht die Ursache. Die Lösung besteht darin, die `ListView` zu beschränken.

## Die Lösung im Detail

Die Lösungen sind danach geordnet, wie oft sie die richtige Antwort sind. Wählen Sie danach, was die größenlose Box tatsächlich braucht.

### 1. Geben Sie einem Scrollable mit Expanded eine beschränkte Größe (empfohlen)

Wenn ein Scrollable in einer `Column` oder `Row` lebt und den verbleibenden Platz ausfüllen soll, umschließen Sie es mit `Expanded`. `Expanded` übergibt dem Kind eine feste (tight), beschränkte Constraint auf der Hauptachse, genau das, was der Viewport braucht:

```dart
// Flutter 3.44, Dart 3.x -- Expanded gives the ListView a bounded height.
Column(
  children: [
    const Text('Latest'),
    Expanded(
      child: ListView(
        children: const [
          ListTile(title: Text('One')),
          ListTile(title: Text('Two')),
          ListTile(title: Text('Three')),
        ],
      ),
    ),
  ],
)
```

Das hält die `ListView` lazy: Sie baut nur die aktuell sichtbaren Zeilen und scrollt den Rest, was Sie für jede Liste wollen, die wachsen kann. Dies ist die richtige Lösung für einen Feed, eine Suchergebnisliste oder jeden scrollbaren Bereich mit einer Kopfzeile darüber.

### 2. Verwenden Sie shrinkWrap, wenn die Liste kurz ist und sich an ihren Inhalt anpassen soll

Wenn die Liste wirklich klein und endlich ist (eine Handvoll Einstellungszeilen, ein festes Menü) und Sie möchten, dass sie nur so viel Höhe einnimmt wie ihr Inhalt, setzen Sie `shrinkWrap: true`. Das weist die `ListView` an, ihre Kinder zu messen und deren kombinierte Höhe zu melden, statt einen beschränkten Viewport zu verlangen:

```dart
// Flutter 3.44, Dart 3.x -- shrinkWrap sizes the list to its children.
Column(
  children: [
    const Text('Settings'),
    ListView(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      children: const [
        ListTile(title: Text('Profile')),
        ListTile(title: Text('Notifications')),
        ListTile(title: Text('Privacy')),
      ],
    ),
  ],
)
```

Der Kompromiss ist real: `shrinkWrap` layoutet alle Kinder im Voraus und macht damit das lazy Rendering zunichte, das die `ListView` günstig macht. Verwenden Sie es nur für kurze, beschränkte Listen. Für alles, was auf Dutzende Einträge wachsen kann, kehren Sie zu Lösung 1 zurück. Das Hinzufügen von `physics: NeverScrollableScrollPhysics()` verhindert, dass die innere Liste unabhängig scrollt, was meist gewünscht ist, wenn die äußere `Column` die Scroll-Fläche ist.

### 3. Geben Sie der Box eine explizite beschränkte Constraint

Manchmal ist die richtige Antwort eine konkrete Größe. Eine `SizedBox` mit fester Höhe oder eine `ConstrainedBox` mit einer Maximalhöhe gibt dem Scrollable eine Grenze, mit der es arbeiten kann:

```dart
// Flutter 3.44, Dart 3.x -- a fixed viewport height for a horizontal carousel.
SizedBox(
  height: 200,
  child: ListView(
    scrollDirection: Axis.horizontal,
    children: const [/* cards */],
  ),
)
```

Eine horizontale `ListView` in einer `Column` ist das Spiegelbild der Reproduktion: Die `Column` beschränkt die Breite, lässt aber die Höhe unbeschränkt, und der horizontale Viewport braucht eine beschränkte Höhe. Eine feste `height` löst das sauber. Verwenden Sie stattdessen `ConstrainedBox(constraints: BoxConstraints(maxHeight: 300))`, wenn der Inhalt kürzer als die Obergrenze sein kann.

### 4. Layouten Sie das Kind, bevor Sie seine Größe in einem eigenen RenderObject lesen

Wenn Sie ein eigenes `RenderObject` (oder eine `RenderBox`-Unterklasse) geschrieben haben, sagt Ihnen die Assertion, dass `performLayout` auf die Größe eines Kindes zugegriffen hat, bevor es gelayoutet wurde. Rufen Sie immer `child.layout(...)` auf, bevor Sie `child.size` lesen:

```dart
// Flutter 3.44, Dart 3.x -- lay out the child, THEN read its size.
@override
void performLayout() {
  final BoxConstraints childConstraints = constraints.loosen();
  child!.layout(childConstraints, parentUsesSize: true); // must come first
  size = constraints.constrain(child!.size);              // now .size is valid
}
```

Das Flag `parentUsesSize: true` ist erforderlich, wenn die eigene Größe des Eltern-Elements vom Kind abhängt. Lassen Sie es weg, kann Flutter das Relayout überspringen, wenn sich das Kind ändert, was veraltete Layouts erzeugt, die wie genau dieser Fehler aussehen, sporadisch. Der Vertrag ist auf der [API-Seite RenderBox.size](https://api.flutter.dev/flutter/rendering/RenderBox/size.html) dokumentiert: Die Größe ist nur während und nach `performLayout` gültig, und das Lesen aus einem Eltern-Element erfordert `parentUsesSize: true` zum Zeitpunkt von `layout`.

### 5. Verschieben Sie ein Lesen der Größe auf nach dem ersten Frame

Wenn Sie die gerenderte Größe eines Widgets in Dart benötigen (um ein Overlay zu positionieren, ein Geschwister-Widget zu dimensionieren oder eine Messung zurück in den Zustand zu führen), lesen Sie `context.size` nicht während `build`. Die Render-Box wurde noch nicht gelayoutet. Lesen Sie sie nach dem Frame:

```dart
// Flutter 3.44, Dart 3.x -- the size exists only after layout has run.
@override
void initState() {
  super.initState();
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!mounted) return;
    final Size? size = context.size; // valid now: the frame has been laid out
    setState(() => _measuredHeight = size?.height);
  });
}
```

Um während des Layouts statt danach zu messen, greifen Sie zu `LayoutBuilder` (das Ihnen die Eltern-Constraints übergibt) oder zu einem `RenderObject` mit `parentUsesSize: true`, nicht zu einem Post-Frame-Lesen der Größe. Der Post-Frame-Ansatz ist für den Fall "Ich brauche die finalen Pixel nur einmal".

## Fallstricke und ähnlich aussehende Fehler

- `Vertical viewport was given unbounded height` und `Horizontal viewport was given unbounded width` sind die primären Fehler, die die meisten `RenderBox was not laid out`-Kaskaden *verursachen*. Sehen Sie einen davon über der `hasSize`-Assertion, beheben Sie diesen, und der Rest verschwindet. Die Lösung sind die Lösungen 1 bis 3 oben.
- `A RenderFlex overflowed by N pixels` ist ein anderer Fehler: Der Flex wurde korrekt gelayoutet, aber seine Kinder überschritten den verfügbaren Platz. Das zeichnet einen Streifen, statt das Layout abzubrechen. Siehe [den Leitfaden zum RenderFlex-Overflow](/de/2026/05/fix-renderflex-overflowed-in-flutter/) für diesen Fall; er ist nicht dasselbe wie eine größenlose Box.
- `BoxConstraints forces an infinite height`, ausgelöst von `IntrinsicHeight` oder `IntrinsicWidth` um ein Scrollable. Intrinsische Widgets führen einen spekulativen Layout-Durchlauf durch, an dem Scrollables sich nicht beteiligen. Entfernen Sie das `IntrinsicHeight`, oder beschränken Sie das Scrollable direkt mit einer `SizedBox`.
- Ein `TabBarView`, `PageView` oder eine verschachtelte `ListView` in einem anderen Scrollable läuft gegen dieselbe Wand unbeschränkter Constraints. Umschließen Sie das innere Scrollable mit einem `Expanded` (wenn das äußere ein Flex ist) oder geben Sie ihm eine feste Höhe, und setzen Sie `shrinkWrap` nur, wenn die innere Liste kurz ist.
- Das Lesen von `renderBox.size` aus einem `GlobalKey` unmittelbar nach einem `setState` liefert die Größe des *vorherigen* Frames oder löst eine Exception aus, wenn das Widget noch gar nicht gelayoutet wurde. Schützen Sie diese Lesevorgänge immer hinter `addPostFrameCallback` und einer `mounted`-Prüfung, dieselbe Disziplin, die die Disposal-Abstürze verhindert, die in [dem Leitfaden zum Disposen von Controllern](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) behandelt werden.
- Im Release-Modus wird die Assertion herauskompiliert, sodass Sie statt eines roten Bildschirms einen leeren Bereich, ein Widget mit Größe null oder ein stilles Überspringen des Zeichnens bekommen. Deshalb beheben Sie die Ursache im Debug, statt an einer Konsolenwarnung vorbeizugehen: Das Symptom ändert im Release seine Form, aber der Bug ist weiterhin da.

## Den echten Verursacher schnell finden

Da dieser Fehler kaskadiert, ist der schnellste Weg, die Konsole von oben nach unten zu lesen und bei der ersten Exception zu stoppen. Grenzen Sie dann den Teilbaum ein:

1. Der erste Fehler benennt ein Widget und einen Quellort (`lib/widgets/feed.dart:58`). Öffnen Sie diese Datei und sehen Sie nach, was das Eltern-Element des benannten Widgets ist. Ein Scrollable, dessen Eltern-Element eine `Column`, eine `Row`, ein `IntrinsicHeight` oder ein weiteres Scrollable ist, ist Ihr Verdächtiger.
2. Aktivieren Sie `debugPaintSizeEnabled = true;` in `main` (oder schalten Sie Debug Paint im Flutter Inspector um), um den Umriss jeder Box zu sehen. Eine Box, die nichts zeichnet oder zu einer Linie zusammenfällt, ist diejenige, die beim Layout gescheitert ist.
3. Öffnen Sie den Layout Explorer in DevTools und wählen Sie das fehlschlagende Widget. Sein Constraints-Panel zeigt, ob es `h=unbounded` oder `w=unbounded` erhalten hat, was die Diagnose bestätigt. Falls Sie DevTools noch nicht für Layout-Arbeit genutzt haben, behandelt der Durchgang in [Jank in einer Flutter-App mit DevTools profilen](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) das Öffnen einer Sitzung gegen ein echtes Gerät; dieselbe Sitzung steuert den Layout Explorer.

Die tiefere Lehre lautet: `RenderBox was not laid out` ist nie der Bug selbst. Es ist Flutter, das meldet, dass es die Arbeit, die ein früheres Widget begonnen hat, nicht beenden konnte. Trainieren Sie sich darauf, die lauteste Meldung zu ignorieren und die leise erste zu finden, dann hört dieser Fehler auf, rätselhaft zu sein. Halten Sie Ihre Scrollables beschränkt, layouten Sie Kinder, bevor Sie sie messen, und lesen Sie nie eine Größe vor dem Frame, der sie erzeugt, dann wird die Assertion nie ausgelöst.

## Verwandt

- [Lösung: A RenderFlex overflowed by N pixels in Flutter](/de/2026/05/fix-renderflex-overflowed-in-flutter/) ist der verwandte Layout-Fehler: Der Flex wurde gelayoutet, aber seine Kinder passten nicht, was ein anderer Fehlermodus ist als eine größenlose Box.
- [Lösung: setState() or markNeedsBuild() called during build in Flutter](/de/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) ist der andere Fehler vom Typ "ich habe das Framework zum falschen Zeitpunkt berührt", und er teilt die Lösung mit dem Post-Frame-Callback.
- [Jank in einer Flutter-App mit DevTools profilen](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) richtet dieselbe DevTools-Sitzung ein, deren Layout Explorer die unbeschränkte Constraint hinter diesem Fehler aufzeigt.
- [Controller in Flutter disposen, um Speicherlecks zu vermeiden](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) behandelt die `mounted`- und Lebenszyklus-Disziplin, die Post-Frame-Lesevorgänge der Größe sicher hält.

## Quellen

- [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints), die kanonische Erklärung, wie Constraints, Größen und das Layout-Protokoll zusammenpassen.
- [API-Referenz RenderBox.size](https://api.flutter.dev/flutter/rendering/RenderBox/size.html), die festhält, dass die Größe einer Box nur während und nach `performLayout` gültig ist und für Lesevorgänge des Eltern-Elements `parentUsesSize: true` erfordert.
- [Common Flutter errors](https://docs.flutter.dev/testing/common-errors), die offizielle Liste, die die Fehler zu unbeschränktem Viewport und Overflow definiert, die die meisten dieser Kaskaden verursachen.
- [flutter/flutter issue #130967](https://github.com/flutter/flutter/issues/130967), ein repräsentativer Bericht über die `hasSize`-Assertion, die von einem Shrink-Wrapping-Viewport mit unbeschränkten Constraints ausgelöst wird.
