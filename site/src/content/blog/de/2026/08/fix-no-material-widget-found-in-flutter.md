---
title: "Fehler beheben: No Material widget found in Flutter"
description: "Umschließen Sie den Teilbaum mit Material(type: MaterialType.transparency) oder platzieren Sie den Bildschirm in einem Scaffold. MaterialApp allein liefert keinen Material-Vorfahren, deshalb schlagen TextField und InkWell fehl."
pubDate: 2026-08-04
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "material"
lang: "de"
translationOf: "2026/08/fix-no-material-widget-found-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-04
---

`No Material widget found` bedeutet, dass das gerade gebaute Widget (`TextField`, `InkWell`, `ListTile`, `Chip`, `Switch`, `Slider` und Verwandte) den Baum nach oben durchlaufen hat, um einen `Material`-Vorfahren zu finden, und keinen gefunden hat. Die schnellste sichere Lösung ist, den Teilbaum mit `Material(type: MaterialType.transparency, child: ...)` zu umschließen, was optisch nichts verändert. Die strukturelle Lösung ist, den Bildschirm in ein `Scaffold` zu setzen. Beachten Sie: `MaterialApp` allein liefert **kein** `Material`. Geprüft mit Flutter 3.44 stable, Dart 3.x.

## Der Fehler im Kontext

Die Assertion wird aus der `build`-Methode des fehlschlagenden Widgets geworfen, daher nennt die erste Zeile das Widget, das seinen Vorfahren nicht finden konnte:

```
======== Exception caught by widgets library ===================================
The following assertion was thrown building TextField(dirty, state: _TextFieldState#3f2a1):
No Material widget found.

TextField widgets require a Material widget ancestor within the closest LookupBoundary.
In Material Design, most widgets are conceptually "printed" on a sheet of
material. In Flutter's material library, that material is represented by the
Material widget. It is the Material widget that renders ink splashes, for
instance. Because of this, many material library widgets require that there be
a Material widget in the tree above them.

To introduce a Material widget, you can either directly include one, or use a
widget that contains Material itself, such as a Card, Dialog, Drawer, or
Scaffold.

The specific widget that could not find a Material ancestor was:
  TextField
The ancestors of this widget were:
  Center
  Semantics
  ...
```

Es gibt eine zweite Formulierung, die Ihnen stattdessen begegnen kann, und sie beschreibt ein wirklich anderes Problem:

```
No Material widget found within the closest LookupBoundary.
There is an ancestor Material widget, but it is hidden by a LookupBoundary.
```

Diese bedeutet, dass oberhalb tatsächlich ein `Material` existiert, eine `LookupBoundary` die Suche aber bewusst blockiert. Dafür gibt es weiter unten einen eigenen Abschnitt.

## Welche Widgets tatsächlich einen Material-Vorfahren benötigen

Das ist wichtig, weil die Liste kürzer ist als "alles aus `package:flutter/material.dart`". Eine Suche nach `assert(debugCheckHasMaterial(context))` in `packages/flutter/lib/src/material/` im stable-Branch von Flutter 3.44 ergibt die tatsächliche Menge:

- `InkWell`, `InkResponse` (über `InkResponse.debugCheckContext`) und `Ink`
- `TextField`
- `ListTile`
- `Chip`, `InputChip`, `ActionChip`, `ChoiceChip`, `FilterChip`
- `Checkbox`, `Radio`, `Switch`, `Slider`
- `DropdownButton`
- `DataTable`
- `TabBar`
- `Stepper`
- `ExpandIcon`

Genauso nützlich ist, was *nicht* auf der Liste steht. `ElevatedButton`, `FilledButton`, `OutlinedButton`, `TextButton`, `FloatingActionButton`, `Card` und `Tooltip` prüfen nicht, weil jedes davon intern ein eigenes `Material` baut und die Tintenfläche dann unter sein eigenes Kind legt. Deshalb funktioniert ein Bildschirm voller Buttons außerhalb eines `Scaffold` einwandfrei, bis Sie ein einziges `TextField` hinzufügen und alles auseinanderfliegt.

`IconButton` ist ein Sonderfall, den man kennen sollte. Seine Assertion liegt ausschließlich im Material-2-Codepfad: `build` kehrt über `_SelectableIconButton` vorzeitig zurück, wenn `theme.useMaterial3` true ist, und das `assert(debugCheckHasMaterial(context))` steht nach diesem Return. Da `useMaterial3` seit Flutter 3.16 standardmäßig `true` ist, benötigt ein normaler `IconButton` keinen `Material`-Vorfahren mehr. Setzen Sie Ihr Theme zurück auf `useMaterial3: false`, und die Prüfung greift wieder.

## Warum MaterialApp nicht ausreicht

Das ist der Teil, der fast alle erwischt, und aus dem Namen ist er nicht ersichtlich. `MaterialApp` liefert ein `Theme`, `MaterialLocalizations`, einen `Navigator`, einen `ScaffoldMessenger` und ein `WidgetsApp`. Es fügt nirgendwo ein `Material` ein. In `packages/flutter/lib/src/material/app.dart` gibt es keine einzige `Material(`-Konstruktion.

Das `Material` kommt vom `Scaffold`. Die `build`-Methode seines State umschließt das gesamte Layout damit:

```dart
// Flutter 3.44, packages/flutter/lib/src/material/scaffold.dart
child: ScrollNotificationObserver(
  child: Material(
    color: widget.backgroundColor ?? themeData.scaffoldBackgroundColor,
    child: Builder(...),
  ),
),
```

Dasselbe gilt für `Card`, `Dialog`, `Drawer` und das von `showModalBottomSheet` gebaute Sheet: jedes konstruiert ein `Material` um sein Kind. Genau diese Liste nennt der Hinweis im Fehlertext, und sie steht dort, weil das die Widgets sind, die es tatsächlich tun.

## Die minimale Reproduktion

Zwölf Zeilen, und es schlägt im ersten Frame fehl:

```dart
// Flutter 3.44, Dart 3.x
import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      home: Center(child: TextField()), // throws: No Material widget found.
    );
  }
}
```

Tauschen Sie `TextField` gegen `ElevatedButton`, und es rendert. Tauschen Sie es gegen `ListTile`, und es schlägt wieder fehl. Die fehlerhafte Zutat ist nie `MaterialApp`, sondern das Fehlen eines `Scaffold` (oder eines anderen `Material`-Trägers) zwischen der App und dem Widget.

## Lösung 1: den Bildschirm in ein Scaffold setzen

Wenn das fehlschlagende Widget Teil eines Bildschirms ist, ist das die richtige Lösung und kein Workaround. Sie erhalten das `Material` sowie die Hintergrundfarbe, den Platz für die App-Bar, die Safe-Area-Behandlung und die Tastatur-Insets, auf denen das Widget implizit aufsetzen sollte:

```dart
// Flutter 3.44, Dart 3.x
class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        appBar: AppBar(title: const Text('Sign in')),
        body: const Padding(
          padding: EdgeInsets.all(16),
          child: TextField(
            decoration: InputDecoration(labelText: 'Email'),
          ),
        ),
      ),
    );
  }
}
```

Greifen Sie nur dann zu einer der anderen Lösungen, wenn ein `Scaffold` wirklich nicht hingehört: ein Overlay-Eintrag, ein Widget-Test, ein Fragment, das außerhalb des normalen Routenbaums gerendert wird.

## Lösung 2: Material mit MaterialType.transparency

Wenn Sie die Tintenfläche brauchen, aber nicht die Optik, kostet diese Lösung nichts:

```dart
// Flutter 3.44, Dart 3.x
Material(
  type: MaterialType.transparency,
  child: InkWell(
    onTap: _handleTap,
    child: const Padding(
      padding: EdgeInsets.all(12),
      child: Text('Tap me'),
    ),
  ),
)
```

Der Typ ist wichtiger, als er aussieht. Zwei Dinge hängen davon ab, beide sichtbar in der build-Methode von `Material`:

```dart
// Flutter 3.44, packages/flutter/lib/src/material/material.dart
final Color? backgroundColor = widget.color ?? switch (widget.type) {
  MaterialType.canvas => theme.canvasColor,
  MaterialType.card => theme.cardColor,
  MaterialType.button || MaterialType.circle || MaterialType.transparency => null,
};
// ...
child: _InkFeatures(
  absorbHitTest: widget.type != MaterialType.transparency,
  color: backgroundColor,
  ...
),
```

Ein nacktes `Material(child: ...)` verwendet standardmäßig `MaterialType.canvas`. Das malt ein deckendes Rechteck in `theme.canvasColor` über alles, was dahinter lag, und setzt `absorbHitTest: true`, wodurch Zeigerereignisse verschluckt werden, die zuvor an darunterliegende Widgets durchgereicht wurden. `MaterialType.transparency` malt nichts und absorbiert nichts. Wenn Sie ein bestehendes Layout reparieren, beginnen Sie immer mit `transparency`, damit Sie einen Absturz nicht gegen eine still kaputte Geste oder einen weißen Kasten über Ihrem Verlauf eintauschen.

Wovon `transparency` Sie nicht befreit: `Material` umschließt sein Kind immer mit einem `AnimatedDefaultTextStyle` auf Basis von `widget.textStyle ?? Theme.of(context).textTheme.bodyMedium`. Wenn ungestylter `Text` im neu umschlossenen Teilbaum plötzlich Größe oder Farbe wechselt, liegt es daran. Übergeben Sie einen expliziten `textStyle`, oder setzen Sie den Stil direkt an den `Text`-Widgets.

## Lösung 3: ein Container-Widget verwenden, das bereits ein Material mitbringt

Manchmal ist die richtige Antwort weder `Scaffold` noch ein rohes `Material`, weil Sie den Container ohnehin wollten:

```dart
// Flutter 3.44, Dart 3.x
Card(
  child: ListTile(                    // ListTile asserts; Card supplies the Material
    leading: const Icon(Icons.person),
    title: const Text('Marius'),
    onTap: _openProfile,
  ),
)
```

`showDialog`, `showModalBottomSheet` und `Drawer` liefern ein `Material` gratis mit, daher funktionieren `ListTile` und `TextField` darin ohne `Scaffold`. Der Fehlerfall, auf den Sie achten müssen, ist `showGeneralDialog`, dessen `pageBuilder` Ihr Widget roh und ganz ohne `Material`-Hülle zurückgibt. Umschließen Sie es selbst, oder verwenden Sie `Dialog`.

`Overlay`-Einträge haben dieselbe Problemform. Der Builder eines `OverlayEntry` wird als Kind des `Overlay` eingehängt, nicht als Kind des `Scaffold` Ihres Bildschirms, und erbt dessen `Material` daher nicht, egal wie tief im Baum der einfügende Code liegt.

## Lösung 4: Wer WidgetsApp nutzt, braucht MaterialApp

Wenn die Wurzel Ihrer App `WidgetsApp` oder `CupertinoApp` ist und Sie trotzdem Material-Widgets einsetzen, bekommen Sie diesen Fehler plus sein Geschwister `No MaterialLocalizations found`. Das wurde in [flutter/flutter#103843](https://github.com/flutter/flutter/issues/103843) als ungültige Verwendung geschlossen, und die Maintainer haben recht: Wechseln Sie zu `MaterialApp`, oder fügen Sie die `Material`- und `Localizations`-Scopes selbst hinzu. `MaterialApp` ist für fast alle die günstigere Antwort.

## Die LookupBoundary-Variante

Die Formulierung `within the closest LookupBoundary` bedeutet, dass die Suche abgefangen wurde. `debugCheckHasMaterial` verwendet `LookupBoundary.findAncestorWidgetOfExactType<Material>(context)` und nicht den einfachen Element-Durchlauf, und eine `LookupBoundary` stoppt ihn sofort, selbst wenn oberhalb ein einwandfreies `Material` sitzt.

Im Framework-Code fügt nur eine Stelle eine solche Grenze ein, nämlich `view.dart`:

```dart
// Flutter 3.44, packages/flutter/lib/src/widgets/view.dart (ViewAnchor.build)
return _MultiChildComponentWidget(
  views: <Widget>[if (view != null) LookupBoundary(child: view!)],
  child: child,
);
```

Wenn Sie also über `ViewAnchor` in eine zweite `FlutterView` rendern (ein Tooltip in einer eigenen Plattform-View, ein zweites Desktop-Fenster), ist die Grenze beabsichtigt: Der Inhalt dieser View ist ein separater Renderbaum und darf nicht still von Vorfahren der Host-View abhängen. Die Lösung besteht darin, der neuen View ein eigenes `Material` (oder ein eigenes `Scaffold`) zu geben, statt über die Grenze hinweg zugreifen zu wollen. Das ist eine der schärfsten Kanten, wenn Sie [Multi-Window-Unterstützung in einer Flutter-Desktop-App aktivieren](/de/2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app/).

Wenn Sie selbst eine `LookupBoundary` eingefügt haben, um einen Teilbaum zu isolieren, gilt dieselbe Regel: Alles, was der Teilbaum braucht, muss darin liegen.

## Fallstricke und Verwechslungen

**Debug wirft, Release nicht.** `debugCheckHasMaterial` ist in `assert(() { ... }())` gekapselt und wird aus Release-Builds vollständig herauskompiliert, die Funktion gibt dann einfach `true` zurück. Ein `TextField` ohne `Material` rendert unter `--release` und stürzt im Debug-Build ab, was genau die Verwirrung hinter Issue 103843 ist. Werten Sie "läuft im Release" nicht als Beleg dafür, dass der Baum in Ordnung ist. Sobald tatsächlich ein Tinteneffekt ausgelöst wird, läuft `Material.of(context)`, und das wirft auch im Release: "Material.of() was called with a context that does not contain a Material widget."

**Der Splash ist unsichtbar, aber es gibt keinen Fehler.** Anderer Bug, gleiche Nachbarschaft. Tinten-Splashes werden auf dem `Material` selbst gemalt, *unter* allem, was darüber gezeichnet wird. Ein `InkWell` innerhalb eines `Container(color: ...)` malt seinen Splash also hinter die deckende Füllung des Containers. Ersetzen Sie `Container(color: x)` durch `Ink(color: x)` (oder setzen Sie die Farbe am `Material`), denn `Ink` malt seine Dekoration auf das übergeordnete `Material`, sodass der Splash darüber landet. Verwandt: [Cannot provide both a color and a decoration in einem Flutter-Container](/de/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/).

**Widget-Tests scheitern dort, wo die App läuft.** `tester.pumpWidget(const TextField())` wirft aus demselben Grund wie `runApp`. Widget-Tests brauchen die Vorfahren ausgeschrieben: `MaterialApp(home: Scaffold(body: TextField()))`, mindestens aber `Material(child: Directionality(textDirection: TextDirection.ltr, child: ...))`. Fehlendes `Directionality` und fehlendes `MediaQuery` erzeugen dieselbe Fehlerform aus `debugCheckHasDirectionality` und `MediaQuery.of`.

**Umschließen Sie nicht die gesamte App mit einem einzigen Material.** Es funktioniert, und es ist eine Falle. Ein einziges `Material` auf App-Ebene lässt sämtliche Tinten-Splashes der App auf einer Fläche rendern, hebelt bildschirmspezifische Hintergrundfarben aus und legt überall denselben `bodyMedium`-Standardtextstil an. Fügen Sie das `Material` im kleinsten Scope ein, der den Fehler behebt.

**Verschachteltes Material ändert, auf welcher Fläche Splashes landen.** `Material.of` löst den *nächstgelegenen* Vorfahren auf, daher beschneidet ein inneres `Material` mit `borderRadius` oder `shape` die Splashes auf diese Form. Für eine eigene Karte ist das meist gewünscht, gelegentlich ist es der Grund, warum ein Splash eckig aussieht, obwohl Sie ihn abgerundet erwartet haben.

**`No MaterialLocalizations found` ist ein anderer fehlender Vorfahre.** Derselbe Aufwärtsmechanismus, anderer Scope, ausgelöst von `debugCheckHasMaterialLocalizations`. Ein `Material` hinzuzufügen hilft nicht; ein `MaterialApp` oder ein `Localizations`-Delegate hilft.

## Verwandte Beiträge

- [Fehler beheben: ScaffoldMessenger.of() was called with a context that does not contain a Scaffold](/de/2026/07/fix-scaffoldmessenger-of-context-does-not-contain-a-scaffold-in-flutter/): dieselbe fehlgeschlagene Vorfahrensuche eine Ebene höher, dazu der `Builder`-Trick für einen Kontext unterhalb des benötigten Widgets.
- [Fehler beheben: Looking up a deactivated widget's ancestor is unsafe in Flutter](/de/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/): wenn der Vorfahre existiert, die Suche aber zum falschen Zeitpunkt im Lebenszyklus stattfindet.
- [Fehler beheben: Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets](/de/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/): eine weitere strukturelle "falscher Platz im Widget-Baum"-Assertion, die Flutter beim Build erkennt.
- [Multi-Window-Unterstützung in einer Flutter-Desktop-App aktivieren](/de/2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app/): wo `LookupBoundary` in echten Apps beginnt, Vorfahrensuchen zu blockieren.
- [Die Akzentfarbe in einer Flutter-App mit dem ColorScheme von Material 3 setzen](/de/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/): die Werte `canvasColor` und `scaffoldBackgroundColor`, die ein `Material` übernimmt, wenn Sie keine Farbe übergeben.

## Quellen

- [debugCheckHasMaterial, Flutter API-Referenz](https://api.flutter.dev/flutter/material/debugCheckHasMaterial.html): die Assertion selbst, samt `LookupBoundary`-Zweig und exaktem Hinweistext.
- [Klasse Material, Flutter API-Referenz](https://api.flutter.dev/flutter/material/Material-class.html): die `MaterialType`-Werte, das Clipping, die Elevation und die Anbindung der Tinteneffekte.
- [Klasse Ink, Flutter API-Referenz](https://api.flutter.dev/flutter/material/Ink-class.html): warum Splashes von einer deckenden, über dem `Material` gezeichneten Dekoration verdeckt werden, und wie `Ink` das vermeidet.
- [flutter/flutter#103843: Error "No Material widget found.", but not in release build](https://github.com/flutter/flutter/issues/103843): die von den Maintainern bestätigte, nur im Debug greifende Assertion, geschlossen als ungültige Verwendung von `WidgetsApp`.
- [flutter/flutter `packages/flutter/lib/src/material/debug.dart` (stable)](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/material/debug.dart): der Quellcode von `debugCheckHasMaterial` und `debugCheckHasMaterialLocalizations`.
