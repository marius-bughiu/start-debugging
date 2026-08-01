---
title: "Fix: A RenderFlex overflowed by N pixels on the bottom beim Öffnen der Tastatur in Flutter"
description: "Die Tastatur verkleinert die maximale Höhe des Scaffold-Body, deshalb läuft eine gerade noch passende Column über. Setzen Sie den Body in ein Scrollable, statt resizeToAvoidBottomInset abzuschalten."
pubDate: 2026-08-01
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "keyboard"
lang: "de"
translationOf: "2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-01
---

Setzen Sie den `Scaffold`-Body in einen `SingleChildScrollView` (oder machen Sie aus der `Column` eine `ListView`). Die Tastatur legt sich nicht über Ihr Layout, sie verkleinert es: `Scaffold` zieht `MediaQuery.viewInsets.bottom` von der maximalen Höhe ab, die es dem Body übergibt, deshalb liegt eine `Column`, die den Bildschirm exakt gefüllt hat, jetzt genau um die Tastaturhöhe über dem Budget. `resizeToAvoidBottomInset: false` bringt den Streifen ebenfalls zum Verschwinden, allerdings dadurch, dass die Tastatur Ihr Textfeld verdeckt, und das ist fast nie erwünscht. Dieser Beitrag ist gegen Flutter 3.x (getestet mit 3.44) und Dart 3.x geschrieben.

```text
The following assertion was thrown during layout:
A RenderFlex overflowed by 291 pixels on the bottom.

The relevant error-causing widget was:
  Column  Column:file:///Users/me/app/lib/screens/login_screen.dart:37:18

The overflowing RenderFlex has an orientation of Axis.vertical.
The edge of the RenderFlex that is overflowing has been marked in the
rendering with a yellow and black striped pattern.
```

Das Erkennungsmerkmal für die Tastaturvariante und nicht für den [allgemeinen RenderFlex-Überlauf](/de/2026/05/fix-renderflex-overflowed-in-flutter/) ist der Zeitpunkt: Das Layout ist sauber, bis Sie ein `TextField` antippen, die Überlaufzahl liegt verdächtig nahe an der Tastaturhöhe (250 bis 350 logische Pixel auf den meisten Telefonen), und sie verschwindet, sobald die Tastatur geschlossen wird.

## Warum die Tastatur den Body verkleinert statt ihn zu verdecken

Unter Android setzt die Flutter-Projektvorlage `android:windowSoftInputMode="adjustResize"` auf der `MainActivity`, die Plattform ändert also die Größe der Flutter-View, statt sie zu verschieben. Die Engine meldet den verdeckten Bereich als `MediaQueryData.viewInsets` an Dart, und die API-Dokumentation definiert das präzise: Wenn die Tastatur eines Mobilgeräts sichtbar ist, entspricht `viewInsets.bottom` der Oberkante der Tastatur.

Den Rest rechnet `Scaffold` aus. In `_ScaffoldState.build` werden die minimalen Insets bestimmt, die frei bleiben müssen:

```dart
// packages/flutter/lib/src/material/scaffold.dart, Flutter 3.x
final EdgeInsets minInsets = MediaQuery.paddingOf(
  context,
).copyWith(bottom: _resizeToAvoidBottomInset ? MediaQuery.viewInsetsOf(context).bottom : 0.0);
```

und in `_ScaffoldLayout.performLayout` wird daraus das Höhenbudget des Body:

```dart
// packages/flutter/lib/src/material/scaffold.dart, Flutter 3.x
final double contentBottom = math.max(
  0.0,
  bottom - math.max(minInsets.bottom, bottomWidgetsHeight),
);

if (hasChild(_ScaffoldSlot.body)) {
  double bodyMaxHeight = math.max(0.0, contentBottom - contentTop);
  // ...
```

`_resizeToAvoidBottomInset` ist `widget.resizeToAvoidBottomInset ?? true`, das ist also der Standardpfad. Auf einem 852 Pixel hohen Bildschirm mit einer 56 Pixel hohen App-Bar und einer 291 Pixel hohen Tastatur fällt die `maxHeight` des Body von 796 auf 505. Ihre `Column` will weiterhin 796. `RenderFlex` schneidet nicht ab und scrollt nicht, also zeichnet es die gestreifte Warnung und meldet die Differenz, und das sind exakt die 291 Pixel aus der Meldung. Die Zahl entspricht der Tastaturhöhe, weil das Layout vorher ohne jede Reserve gepasst hat.

## Ein Repro, das auf einen Bildschirm passt und dann nicht mehr

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: LoginScreen()));

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Sign in')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            const FlutterLogo(size: 160),
            const TextField(decoration: InputDecoration(labelText: 'Email')),
            const TextField(
              obscureText: true,
              decoration: InputDecoration(labelText: 'Password'),
            ),
            FilledButton(onPressed: () {}, child: const Text('Sign in')),
          ],
        ),
      ),
    );
  }
}
```

Das rendert einwandfrei. Tippen Sie eines der beiden Felder an, und der Überlauf erscheint. Am Widget-Baum hat sich nichts geändert, nur die eingehende `maxHeight`.

## Die Lösungen in der Reihenfolge, in der Sie sie ausprobieren sollten

### 1. Machen Sie den Body scrollbar

Das ist die richtige Lösung für so gut wie jedes Formular, und die [Flutter-Dokumentation zu häufigen Fehlern](https://docs.flutter.dev/testing/common-errors) empfiehlt sie für einen Überlauf nach unten. Ein Viewport gibt seinem Kind unbegrenzten Platz entlang der Hauptachse, damit ist der `Column` egal, was die Tastatur mit dem `Scaffold` gemacht hat:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
body: SingleChildScrollView(
  padding: const EdgeInsets.all(24),
  child: Column(
    children: [
      const FlutterLogo(size: 160),
      const SizedBox(height: 24),
      const TextField(decoration: InputDecoration(labelText: 'Email')),
      const SizedBox(height: 12),
      const TextField(
        obscureText: true,
        decoration: InputDecoration(labelText: 'Password'),
      ),
      const SizedBox(height: 24),
      FilledButton(onPressed: () {}, child: const Text('Sign in')),
    ],
  ),
),
```

Zwei Dinge sollten Sie dabei gleich mitändern. Entfernen Sie `mainAxisAlignment: MainAxisAlignment.spaceBetween`: In einem Viewport ist der verfügbare Platz unendlich, die Ausrichtung entlang der Hauptachse hat also nichts zu verteilen und bleibt stillschweigend wirkungslos. Ersetzen Sie die Abstände durch explizite `SizedBox`. Und wenn die Liste lang ist oder aus Daten aufgebaut wird, nehmen Sie `ListView` oder `ListView.builder`, damit Kinder verzögert gebaut werden; die Abwägungen sind dieselben wie in [shrinkWrap vs Expanded vs Slivers für lange Listen](/de/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).

Diese Lösung bringt einen Bonus mit: `EditableText` scrollt das fokussierte Feld über den nächstgelegenen `Scrollable`-Vorfahren in den sichtbaren Bereich, gepolstert durch `TextField.scrollPadding` mit dem Standardwert `EdgeInsets.all(20.0)`. Ohne scrollbaren Vorfahren gibt es nichts zu scrollen, und genau deshalb bleibt das Feld unter Ihrem Daumen manchmal verdeckt, obwohl kein Überlauf sichtbar ist.

### 2. Den Bildschirm füllen, wenn Platz da ist, und scrollen, wenn nicht

Die Scroll-View-Lösung hat einen kosmetischen Preis: Auf einem hohen Bildschirm mit geschlossener Tastatur drängt sich der Inhalt oben zusammen, statt sich zu verteilen. Das Muster aus der [SingleChildScrollView-API-Dokumentation](https://api.flutter.dev/flutter/widgets/SingleChildScrollView-class.html) behebt das, indem es der `Column` eine Mindesthöhe in Viewport-Größe gibt und sie zwingt, exakt so hoch wie ihr Inhalt zu sein, wenn dieser größer ist:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
body: LayoutBuilder(
  builder: (context, viewportConstraints) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: BoxConstraints(minHeight: viewportConstraints.maxHeight - 48),
        child: IntrinsicHeight(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: const [
              FlutterLogo(size: 160),
              TextField(decoration: InputDecoration(labelText: 'Email')),
              TextField(
                obscureText: true,
                decoration: InputDecoration(labelText: 'Password'),
              ),
            ],
          ),
        ),
      ),
    );
  },
),
```

Beide Wrapper sind tragend. Ohne `ConstrainedBox` schmiegt sich die Column an ihren Inhalt und füllt einen hohen Bildschirm nie; ohne `IntrinsicHeight` nimmt sie die Mindesthöhe an, auch wenn die Kinder mehr brauchen, und Sie sind zurück beim Überlauf. `LayoutBuilder` sieht die Constraints nach dem Öffnen der Tastatur, weil es im Body-Slot sitzt, `viewportConstraints.maxHeight` ist also bereits um die Tastatur reduziert.

Die Dokumentation benennt den Preis deutlich: Der Teilbaum wird zweimal gelayoutet, einmal für die intrinsischen Größen und einmal richtig. Für ein Login-Formular in Ordnung, für eine Einstellungsseite mit fünfzig Zeilen nicht.

### 3. SliverFillRemaining statt IntrinsicHeight

Wenn der Intrinsics-Durchlauf in Ihren Frame-Zeiten auftaucht, formulieren Sie dieselbe Absicht mit Slivers. `SliverFillRemaining(hasScrollBody: false)` lässt das Kind den restlichen Viewport füllen, und laut API-Vertrag weicht der Sliver auf die Größe des Kindes aus, statt sie zu überschreiben, sobald dessen Ausdehnung den Viewport übersteigt. Genau dieses Verhalten wollen Sie, wenn die Tastatur erscheint:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
body: CustomScrollView(
  slivers: [
    SliverFillRemaining(
      hasScrollBody: false,
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: const [
            FlutterLogo(size: 160),
            TextField(decoration: InputDecoration(labelText: 'Email')),
            TextField(
              obscureText: true,
              decoration: InputDecoration(labelText: 'Password'),
            ),
          ],
        ),
      ),
    ),
  ],
),
```

Eine Regel dabei: Alles direkt unter `CustomScrollView.slivers` muss ein Sliver sein. Eine `Column` dort ohne Wrapper abzulegen führt zu [RenderViewport expected a RenderSliver child](/de/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/).

### 4. resizeToAvoidBottomInset: false, und nur mit Absicht

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Scaffold(
  resizeToAvoidBottomInset: false,
  body: /* ... */,
)
```

Lesen Sie den Quellcode oben noch einmal: Das setzt `minInsets.bottom` auf `0.0`, der Body behält seine volle Höhe, und die Tastatur wird über alles gezeichnet, was dort unten liegt. Repariert ist nichts, die Überlaufwarnung hat nur nichts mehr zu melden. Legitim ist das auf einem Bildschirm, dessen Eingabefeld im oberen Drittel sitzt, auf einer bildschirmfüllenden Karten- oder Kameraansicht, bei der eine Größenänderung störend wirkt, oder auf einem Chat-Bildschirm, auf dem Sie das Inset selbst steuern. Für ein Formular ist es die falsche Antwort, denn ausgerechnet das Feld, in das der Benutzer tippt, verschwindet hinter der Tastatur.

## Fallstricke, die einen im Kreis laufen lassen

**`viewInsets.bottom` liefert im Scaffold-Body `0`.** Das ist der verwirrendste Teil des ganzen Themas. `Scaffold` übergibt dem Body ein verändertes `MediaQuery`:

```dart
// packages/flutter/lib/src/material/scaffold.dart, Flutter 3.x
if (removeBottomInset) {
  data = data.removeViewInsets(removeBottom: true);
}
```

und der Body-Slot wird mit `removeBottomInset: _resizeToAvoidBottomInset` registriert. Mit den Standardeinstellungen bekommt ein Widget innerhalb von `Scaffold.body`, das `MediaQuery.viewInsetsOf(context).bottom` liest, also `0.0`, selbst bei geöffneter Tastatur, weil `Scaffold` dieses Inset bereits durch das Verkleinern des Body verbraucht hat. Ein von Hand ergänztes `Padding(padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom))` bewirkt dort nichts. Um den echten Wert zu lesen, lesen Sie ihn oberhalb des `Scaffold`, oder setzen Sie `resizeToAvoidBottomInset: false` und übernehmen die Inset-Behandlung selbst.

**Modale Bottom Sheets sind die Ausnahme.** Eine `showModalBottomSheet`-Route ist kein `Scaffold`-Body, dort ist `viewInsets` also intakt und der Padding-Trick die richtige Lösung. Kombinieren Sie ihn mit `isScrollControlled: true`, sonst ist das Sheet auf den halben Bildschirm begrenzt:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
showModalBottomSheet(
  context: context,
  isScrollControlled: true,
  builder: (context) => Padding(
    padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
    child: const ComposeForm(),
  ),
);
```

**Eine bottomNavigationBar addiert sich nicht zur Tastatur.** `contentBottom` verwendet `math.max(minInsets.bottom, bottomWidgetsHeight)`, nicht die Summe. Sobald die Tastatur höher als die Navigationsleiste ist, schrumpft der Body nur um die Tastaturhöhe, und die Leiste behält ihren Platz am unteren Rand des Scaffold, unter der Tastatur. Wenn sie beim Tippen verschwinden soll, blenden Sie sie selbst aus: Lesen Sie `MediaQuery.viewInsetsOf(context).bottom` aus einem `Builder` oberhalb des `Scaffold` und übergeben Sie `bottomNavigationBar: inset > 0 ? null : const MyNavBar()`.

**Jemand hat `windowSoftInputMode` auf `adjustPan` geändert.** Wenn der Überlauf unter Android nie auftaucht, das Feld aber verdeckt bleibt, oder `viewInsets.bottom` dauerhaft `0` ist, prüfen Sie `android/app/src/main/AndroidManifest.xml`. Die Flutter-Vorlage liefert `android:windowSoftInputMode="adjustResize"`; irgendwann hat eine Stack-Overflow-Antwort jemanden zu `adjustPan` überredet, und nun verschiebt die Plattform das Fenster, statt ein Inset zu melden.

**Den Übeltäter in `Expanded` zu packen ist hier der falsche Reflex.** `Expanded` ist die Lösung für den horizontalen Fall, in dem ein gieriges Kind eine `Row` auffrisst. Im Tastaturfall haben alle Kinder bereits ihre natürliche Größe und die Summe übersteigt schlicht das Budget, `Expanded` nimmt also entweder einem Widget Platz weg, das ihn brauchte, oder verschiebt den Überlauf zu einem Geschwisterelement. Und ein `Expanded`, das außerhalb eines `Flex` landet, liefert Ihnen stattdessen [Incorrect use of ParentDataWidget](/de/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/).

**Tastatur beim Ziehen schließen.** Sobald der Body scrollt, ergänzen Sie `keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag` am Scroll-View. Das kostet eine Zeile und beseitigt die häufigste Beschwerde über Formularbildschirme.

**Ähnlich aussehende Fehler.** `Vertical viewport was given unbounded height` ist das Spiegelbild, ein Scrollable in einem unbegrenzten Elternelement, behandelt in [eine ListView in einer Column verschachteln](/de/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/). `RenderBox was not laid out` ist meist die zweite Exception nach einem echten Layout-Fehler; scrollen Sie zur ersten hoch. Und wenn der Überlauf bei 1,5-facher Textskalierung statt beim Öffnen der Tastatur auftritt, ist es derselbe Fehlertyp mit anderem Auslöser, den der [allgemeine Beitrag zum RenderFlex-Überlauf](/de/2026/05/fix-renderflex-overflowed-in-flutter/) ausführlich behandelt.

## Verwandte Beiträge

- [Fix: A RenderFlex overflowed by N pixels in Flutter](/de/2026/05/fix-renderflex-overflowed-in-flutter/) ist der übergeordnete Beitrag für die horizontale Variante und die Textskalierungsvariante derselben Assertion.
- [Eine ListView ohne Unbounded-Height-Fehler in einer Column verschachteln](/de/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) behandelt den Fall, dass das Formular selbst eine Liste enthält.
- [shrinkWrap vs Expanded vs Slivers für lange Listen in Flutter](/de/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/) erklärt, warum `ListView.builder` einen `SingleChildScrollView` schlägt, sobald der Inhalt wächst.
- [Fix: RenderViewport expected a RenderSliver child](/de/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/) ist der Fehler, der auf Sie wartet, wenn Sie den Sliver-Weg gehen.
- [Fix: Incorrect use of ParentDataWidget, Expanded muss in einem Flex stehen](/de/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) beschreibt, was passiert, wenn man zu schnell zu `Expanded` greift.

## Quellen

- [Common Flutter errors](https://docs.flutter.dev/testing/common-errors), die offizielle Seite, die die RenderFlex-Overflow-Assertion und ihre kanonischen Lösungen definiert.
- [Scaffold.resizeToAvoidBottomInset](https://api.flutter.dev/flutter/material/Scaffold/resizeToAvoidBottomInset.html), dokumentiert den Standardwert `true` und die Abhängigkeit von `MediaQueryData.viewInsets`.
- [MediaQueryData.viewInsets](https://api.flutter.dev/flutter/widgets/MediaQueryData/viewInsets.html), Quelle der Definition "viewInsets.bottom entspricht der Oberkante der Tastatur" und der Abgrenzung zu `padding` und `viewPadding`.
- [scaffold.dart im stable-Branch](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/material/scaffold.dart), wo `minInsets`, `contentBottom` und der `removeViewInsets`-Aufruf für den Body stehen.
- [SingleChildScrollView-Klassenreferenz](https://api.flutter.dev/flutter/widgets/SingleChildScrollView-class.html), dokumentiert das Rezept aus `LayoutBuilder` plus `ConstrainedBox` plus `IntrinsicHeight` und dessen Kosten.
- [SliverFillRemaining-Klassenreferenz](https://api.flutter.dev/flutter/widgets/SliverFillRemaining-class.html), für die exakte Semantik von `hasScrollBody: false`.
- [EditableText.scrollPadding](https://api.flutter.dev/flutter/widgets/EditableText/scrollPadding.html), erklärt das automatische Scrollen in den sichtbaren Bereich und den Standardwert `EdgeInsets.all(20.0)`.
