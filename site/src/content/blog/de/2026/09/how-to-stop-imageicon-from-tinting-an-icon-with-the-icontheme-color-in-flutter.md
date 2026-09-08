---
title: "So verhindern Sie, dass ImageIcon ein Icon mit der umgebenden IconTheme-Farbe einfärbt in Flutter"
description: "ImageIcon reduziert ein mehrfarbiges PNG auf eine Silhouette, weil es immer ColorFilter.mode(iconThemeColor, BlendMode.srcIn) anwendet. Flutter 3.47 ergänzt useOriginalColors, um das abzuschalten. Warum color: null nie funktioniert hat, was useOriginalColors stillschweigend verwirft und der handgeschriebene Ersatz für ältere SDKs."
pubDate: 2026-09-08
template: how-to
tags:
  - "flutter"
  - "dart"
  - "material-design"
  - "how-to"
lang: "de"
translationOf: "2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter"
translatedBy: "claude"
translationDate: 2026-09-08
---

`ImageIcon` reicht Ihr Bild mit `color: IconTheme.of(context).color` an `Image` weiter, und das Render-Objekt macht daraus `ColorFilter.mode(color, BlendMode.srcIn)`, was den RGB-Anteil jedes Pixels verwirft und nur den Alphakanal behält. Eine mehrfarbige Bildmarke kommt als flache Silhouette heraus, meist schwarz oder weiß. Seit Flutter 3.47 besteht die Lösung aus einem einzigen Argument: `ImageIcon(AssetImage('assets/logo.png'), useOriginalColors: true)`. `color: null` zu übergeben bewirkt nichts und hat nie etwas bewirkt, weil `IconTheme.of` vertraglich zugesichert eine konkrete Farbe zurückgibt und auf deckendes Schwarz zurückfällt. In 3.44 und älter gibt es das Flag nicht, also ersetzen Sie das Widget durch ein einfaches `Image` und bilden die vier Layout-Argumente von ImageIcon selbst nach. Alles Folgende zielt auf den aktuellen Stable-Kanal, Flutter 3.47.2 mit Dart 3.13.2.

## Warum color: null die Einfärbung nicht abschaltet

Das gesamte Widget umfasst etwa dreißig Zeilen. Das ist `build`, wie es in 3.47 ausgeliefert wird:

```dart
// package:flutter/src/widgets/image_icon.dart, Flutter 3.47.2
@override
Widget build(BuildContext context) {
  final IconThemeData iconTheme = IconTheme.of(context);
  final double? iconSize = size ?? iconTheme.size;

  if (image == null) {
    return Semantics(
      label: semanticLabel,
      child: SizedBox(width: iconSize, height: iconSize),
    );
  }

  final double? iconOpacity = iconTheme.opacity;
  Color iconColor = color ?? iconTheme.color!;

  if (iconOpacity != null && iconOpacity != 1.0) {
    iconColor = iconColor.withOpacity(iconColor.opacity * iconOpacity);
  }

  return Semantics(
    label: semanticLabel,
    child: Image(
      image: image!,
      width: iconSize,
      height: iconSize,
      color: useOriginalColors ? null : iconColor,
      fit: BoxFit.scaleDown,
      excludeFromSemantics: true,
    ),
  );
}
```

Die tragende Zeile ist `Color iconColor = color ?? iconTheme.color!`. Dieses `!` ist kein Optimismus, sondern eine Zusicherung, die `IconTheme.of` ausdrücklich gibt. Die Suche löst das nächstgelegene umgebende `IconTheme` auf, prüft, ob das Ergebnis konkret ist, und füllt andernfalls jedes null-Feld aus `IconThemeData.fallback()` auf:

```dart
// package:flutter/src/widgets/icon_theme.dart, Flutter 3.47.2
static IconThemeData of(BuildContext context) {
  final IconThemeData iconThemeData = _getInheritedIconThemeData(context).resolve(context);
  return iconThemeData.isConcrete
      ? iconThemeData
      : iconThemeData.copyWith(
          size: iconThemeData.size ?? const IconThemeData.fallback().size,
          // ...
          color: iconThemeData.color ?? const IconThemeData.fallback().color,
          opacity: iconThemeData.opacity ?? const IconThemeData.fallback().opacity,
          // ...
        );
}
```

Und `IconThemeData.fallback()` setzt `color = const Color(0xFF000000)`. Es gibt keinen Zustand des Widget-Baums, in dem `IconTheme.of(context).color` null ist. Der Dokumentationskommentar, der weiterhin an `ImageIcon.color` hängt und behauptet, ohne `IconTheme` gelte "defaults to not recolorizing the image", beschreibt also ein Verhalten, das das Widget seit langem nicht mehr hat. Ganz ohne umgebendes Theme erhalten Sie deckendes Schwarz, genau das Ergebnis, das als "mein farbiges Icon wird als schwarzer Klecks gerendert" gemeldet wird.

`color: Colors.transparent` zu setzen ist der andere instinktive Versuch und schlimmer. `BlendMode.srcIn` komponiert die Quellfarbe in den Alphakanal des Ziels, eine vollständig transparente Quelle erzeugt also ein vollständig transparentes Ergebnis: Das Icon verschwindet, statt seine eigenen Farben zu zeigen. Auf Theme-Ebene gibt es ebenfalls nichts zu greifen, weil sich "keine Farbe" in einem `IconThemeData` nicht ausdrücken lässt, das `IconTheme.of` unverändert zurückgibt.

## Die Reproduktion: ein PNG, drei Stellen, an denen es grau wird

Jedes Material-Widget, dem sein Icon-Platz gehört, installiert ein `IconTheme` über diesem Platz, dasselbe Asset wird also überall reduziert. Das läuft auf 3.47 wie geschrieben; tauschen Sie den Import gegen `package:flutter/material.dart`, falls Sie den Umzug auf die [eigenständigen Pakete material_ui und cupertino_ui](/de/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/) noch nicht gemacht haben.

```dart
// Flutter 3.47.2, Dart 3.13.2
import 'package:material_ui/material_ui.dart';

const AssetImage brandMark = AssetImage('assets/brand/logo.png');

class TintDemo extends StatelessWidget {
  const TintDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Tinting'),
        // Flattened to ColorScheme.onSurface.
        actions: const <Widget>[ImageIcon(brandMark)],
      ),
      body: Column(
        children: <Widget>[
          // Flattened to the button's resolved foreground color.
          ElevatedButton.icon(
            onPressed: () {},
            icon: const ImageIcon(brandMark),
            label: const Text('Open'),
          ),
          // Flattened to ListTileThemeData.iconColor.
          const ListTile(
            leading: ImageIcon(brandMark),
            title: Text('Account'),
          ),
          // Not flattened: no IconTheme is being applied to raw images.
          const Image(image: brandMark, width: 24, height: 24),
        ],
      ),
    );
  }
}
```

Die letzte Zeile ist der Hinweis. Gleiches Asset, gleiche Größe, kein Farbfilter, korrekte Farben. Mit dem PNG stimmt nichts nicht, und mit der Asset-Auflösung ebenfalls nicht, die sonst der erste Verdacht ist, wenn ein Bild falsch aussieht; jener Fehlerfall sieht völlig anders aus und wird in [unable to load asset in Flutter nach dem Hinzufügen eines Bildes zur pubspec.yaml](/de/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/) behandelt.

## Schritte, um ein ImageIcon auf seine Originalfarben umzustellen

1. Prüfen Sie Ihr SDK mit `flutter --version`. `useOriginalColors` kam mit [PR 180491](https://github.com/flutter/flutter/pull/180491) am 2026-04-27 und wurde im Stable-Release Flutter 3.47 ausgeliefert. Bei allem Älteren springen Sie zum handgeschriebenen Ersatz weiter unten.
2. Entfernen Sie das Argument `color` an der Aufrufstelle. Der Konstruktor sichert per Assert zu, dass `color` null ist, sobald `useOriginalColors` true ist, beides stehen zu lassen ist also ein harter Fehler.
3. Ergänzen Sie `useOriginalColors: true`. Das ist die gesamte Änderung: `build` reicht dann `color: null` an `Image` weiter, es wird kein `ColorFilter` auf dem Render-Objekt installiert, und die dekodierten Pixel erreichen die Zeichenfläche unverändert.
4. Prüfen Sie jede zustandsabhängige Variante dieses Icons erneut. Ausgewählt, nicht ausgewählt, deaktiviert und gedrückt werden alle als unterschiedliche `IconThemeData`-Farben ausgedrückt, und Sie haben sich gerade aus allen gleichzeitig ausgeklinkt.
5. Entscheiden Sie, was jetzt das deaktivierte Erscheinungsbild trägt. Verließ sich das Widget auf eine durchscheinende Einfärbungsfarbe, um ausgegraut zu wirken, umschließen Sie das Icon mit `Opacity` oder liefern ein separates entsättigtes Asset.

Die fertige Aufrufstelle:

```dart
// Flutter 3.47.2, Dart 3.13.2
const ImageIcon(
  AssetImage('assets/brand/logo.png'),
  useOriginalColors: true,
  semanticLabel: 'Acme',
)
```

Die Größe kommt weiterhin aus dem umgebenden `IconTheme`, das Icon bleibt also mit den `Icon`-Widgets daneben ausgerichtet. Nur der Farbfilter ist weg.

## Was useOriginalColors zusammen mit der Einfärbung verwirft

Sehen Sie sich die beiden entscheidenden Zeilen von `build` noch einmal an:

```dart
if (iconOpacity != null && iconOpacity != 1.0) {
  iconColor = iconColor.withOpacity(iconColor.opacity * iconOpacity);
}
// ...
color: useOriginalColors ? null : iconColor,
```

`IconTheme.opacity` wird in den Alphakanal der Einfärbungsfarbe eingerechnet, und diese Farbe ist der einzige Kanal, über den sie das Bild erreicht. Setzen Sie `useOriginalColors: true`, wird die gesamte berechnete `iconColor` verworfen, die Deckkraft eingeschlossen. Ein Vorfahre, der seinen Teilbaum mit `IconTheme(data: IconThemeData(opacity: 0.38), ...)` abdunkelt, dimmt jedes `Icon` ringsum und lässt Ihr Bild in voller Stärke stehen.

Dasselbe gilt für durchscheinende Einfärbungsfarben, und genau so drückt Material deaktivierte Icons heute aus. Die Vorgaben von `NavigationBar` lösen den deaktivierten Zustand auf `onSurfaceVariant` mit 38 Prozent Alpha auf, und dieses Alpha wandert über `srcIn` in das gerenderte Ergebnis. Klinken Sie sich aus dem Filter aus, sieht das deaktivierte Ziel aktiviert aus.

Wenn Sie die umgebende Deckkraft zurückbrauchen, lesen und wenden Sie sie selbst an:

```dart
// Flutter 3.47.2, Dart 3.13.2
class BrandIcon extends StatelessWidget {
  const BrandIcon({super.key, required this.image});

  final ImageProvider image;

  @override
  Widget build(BuildContext context) {
    final double opacity = IconTheme.of(context).opacity ?? 1.0;
    final Widget icon = ImageIcon(image, useOriginalColors: true);
    return opacity == 1.0 ? icon : Opacity(opacity: opacity, child: icon);
  }
}
```

`Opacity` ist eine echte Kompositionsebene und nicht kostenlos, deshalb lohnt sich die Absicherung gegen den häufigen Fall `1.0`, statt bedingungslos zu umschließen.

## Der Ersatz vor 3.47

Es gibt kein Flag zum Zurückportieren und keine Kombination von `color`-Werten, die dasselbe Ergebnis erreicht, in 3.44 und älter verzichten Sie also auf `ImageIcon`. Der Ersatz ist kurz, weil ImageIcon selbst kurz ist: Erhaltenswert sind die Größenabfrage, `BoxFit.scaleDown` und die semantische Aufteilung, die das Label auf die Hülle legt und das Bild aus dem Baum ausschließt.

```dart
// Flutter 3.44 or older. Drop-in for ImageIcon that keeps the image's colors.
import 'package:flutter/widgets.dart';

class OriginalColorImageIcon extends StatelessWidget {
  const OriginalColorImageIcon(
    this.image, {
    super.key,
    this.size,
    this.semanticLabel,
  });

  final ImageProvider image;
  final double? size;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final double? iconSize = size ?? IconTheme.of(context).size;
    return Semantics(
      label: semanticLabel,
      child: Image(
        image: image,
        width: iconSize,
        height: iconSize,
        fit: BoxFit.scaleDown,
        excludeFromSemantics: true,
      ),
    );
  }
}
```

Zwei Details gehen leicht verloren, wenn Sie stattdessen ein nacktes `Image.asset` einsetzen. `BoxFit.scaleDown` vergrößert nie: Ein Asset, dessen intrinsische Größe kleiner als die Icon-Box ist, bleibt bei seiner intrinsischen Größe und wird zentriert, genau wie `ImageIcon` sich verhält, und vermeidet die Unschärfe, die `BoxFit.contain` einbrächte. Und `excludeFromSemantics: true` am inneren `Image` verhindert, dass der Accessibility-Baum sowohl das Label der Hülle als auch das des Bildes trägt, und genau das tut `ImageIcon` aus demselben Grund.

## Welche Widgets das IconTheme installieren, das Sie trifft

| Widget | Was es in das umgebende IconTheme legt |
| --- | --- |
| `AppBar`, `SliverAppBar` | `iconTheme` für das Leading-Widget und `actionsIconTheme` für die Actions, standardmäßig `ColorScheme.onSurface` |
| `ElevatedButton.icon` und die anderen `ButtonStyleButton`-Varianten | ein `AnimatedTheme`, dessen `iconTheme` mit der aufgelösten Vordergrundfarbe und Icon-Größe gemergt wird |
| `IconButton` | die aufgelöste Vordergrundfarbe für den aktuellen Widget-Zustand |
| `NavigationBar`, `NavigationRail` | ein `WidgetStateProperty<IconThemeData>`, getrennt aufgelöst für ausgewählt, nicht ausgewählt und deaktiviert |
| `BottomNavigationBar` | die Farben für ausgewählte und nicht ausgewählte Elemente |
| `ListTile` | `ListTileThemeData.iconColor` oder eine deaktivierte Farbe bei `enabled: false` |
| `Chip` und seine Varianten | das eigene Icon-Theme des Chips |
| `TabBar` | `labelColor` und `unselectedLabelColor` |

Deshalb wird der Bugreport, der üblicherweise eingeht, am bekanntesten [flutter/flutter#81643](https://github.com/flutter/flutter/issues/81643), als ungültig geschlossen. Das Widget tut genau das, was ein Icon-Widget tun soll. Das Theming-System von Material geht davon aus, dass Icons monochrome Silhouetten sind, die es umfärben darf, dieselbe Annahme steckt hinter der Art, wie [das ColorScheme von Material 3 die Akzentfarben in einer Flutter-App steuert](/de/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/).

## Ausgewählte und nicht ausgewählte Ziele brauchen zwei getrennte Widgets

`NavigationBar` tauscht nicht ein Icon gegen ein anderes. Es baut beide, umschließt jedes mit einem eigenen `IconTheme.merge` und blendet sie in einem `Stack` ineinander über:

```dart
// package:flutter/src/material/navigation_bar.dart, Flutter 3.47.2
final Widget selectedIconWidget = IconTheme.merge(
  data: enabled ? selectedIconTheme : disabledIconTheme,
  child: selectedIcon ?? icon,
);
final Widget unselectedIconWidget = IconTheme.merge(
  data: enabled ? unselectedIconTheme : disabledIconTheme,
  child: icon,
);
```

Weil `icon` für den nicht ausgewählten Platz verwendet wird und auch für den ausgewählten, wenn `selectedIcon` null ist, klinkt ein einzelnes Widget mit `useOriginalColors: true` beide Zustände aus. Wollen Sie die Markenfarben nur, wenn das Ziel aktiv ist, übergeben Sie zwei Widgets:

```dart
// Flutter 3.47.2, Dart 3.13.2
NavigationDestination(
  icon: const ImageIcon(AssetImage('assets/brand/logo_mono.png')),
  selectedIcon: const ImageIcon(
    AssetImage('assets/brand/logo.png'),
    useOriginalColors: true,
  ),
  label: 'Acme',
)
```

Das monochrome Asset im nicht ausgewählten Platz wird weiterhin eingefärbt, und das ist gewollt: Es folgt dem Theme wie jedes andere Ziel, und die vollfarbige Bildmarke erscheint nur bei Auswahl.

## Details, die Sie vor dem Ausliefern kennen sollten

**Das Assert ist eine Debug-Prüfung, kein Compilerfehler, außer Sie machen einen daraus.** `ImageIcon` hat einen `const`-Konstruktor, `const ImageIcon(image, useOriginalColors: true, color: Colors.red)` wird also zur Compilezeit ausgewertet und vom Analyzer rundweg abgelehnt. Ohne `const` geschrieben wirft es nur in Debug- und Profile-Builds. Im Release wird das Assert entfernt, `build` wertet weiterhin `useOriginalColors ? null : iconColor` aus, und Ihre Farbe wird stillschweigend ignoriert. Bevorzugen Sie `const` an diesen Aufrufstellen.

**`Icon` hat kein Gegenstück und braucht keines.** Schriftbasierte Icons sind Umrisse eines einzelnen Glyphen; es gibt keine Originalfarben zu erhalten. Brauchen Sie einen mehrfarbigen Glyphen, brauchen Sie ein Bild oder eine Vektorgrafik, kein `IconFont`.

**`flutter_svg` funktioniert andersherum.** `SvgPicture.asset` liest `IconTheme` überhaupt nicht, ein SVG behält also standardmäßig seine eigenen Farben, und Sie entscheiden sich mit einem expliziten `colorFilter: ColorFilter.mode(IconTheme.of(context).color!, BlendMode.srcIn)` für die Einfärbung. Ist Ihr SVG unerwartet einfarbig, suchen Sie nach einem fest in der Datei hinterlegten `fill`, nicht nach einem umgebenden Theme.

**Sichern Sie es in einem Widget-Test ab, statt einen Screenshot zu begutachten.** Die gerenderten Pixel sind schwer zu prüfen, die Widget-Konfiguration nicht:

```dart
// Flutter 3.47.2, Dart 3.13.2
testWidgets('brand mark ignores the ambient icon color', (WidgetTester tester) async {
  await tester.pumpWidget(
    const IconTheme(
      data: IconThemeData(color: Color(0xFFFF0000)),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: ImageIcon(
          AssetImage('assets/brand/logo.png'),
          useOriginalColors: true,
        ),
      ),
    ),
  );

  expect(tester.widget<Image>(find.byType(Image)).color, isNull);
});
```

Ein Golden-Test fängt die Regression ebenfalls ab, aber dieser scheitert mit einer lesbaren Meldung und läuft, ohne dass sich das Asset-Bundle wohlverhalten muss.

**Liefern Sie die richtige Dichte aus.** `BoxFit.scaleDown` skaliert nicht hoch, ein Icon-Platz von 24 logischen Pixeln auf einem 3x-Gerät verlangt also ein Asset mit 72 Pixeln in `assets/brand/3.0x/`. Ein einzelnes 24-Pixel-PNG, das gut aussah, solange es zur Silhouette reduziert wurde, wirkt deutlich weich, sobald Sie seine tatsächlichen Pixel sehen.

### Weiterlesen

- [Flutter Material- und Cupertino-Imports auf die Pakete material_ui und cupertino_ui migrieren](/de/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/)
- [Akzentfarbe in Flutter mit dem Material 3 ColorScheme setzen](/de/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)
- [Fix: unable to load asset in Flutter nach dem Hinzufügen eines Bildes zur pubspec.yaml](/de/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/)
- [Fix: cannot provide both a color and a decoration in einem Flutter Container](/de/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/)
- [Was ist ein Flutter Key und wann verursacht sein Weglassen Fehler?](/de/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)

### Quellen

- [Klasse ImageIcon, Flutter API-Referenz](https://api.flutter.dev/flutter/widgets/ImageIcon-class.html)
- [Added useOriginalColors flag which allows ImageIcon to bypass IconTheme colorization, flutter/flutter PR 180491](https://github.com/flutter/flutter/pull/180491)
- [Flutter 3.47.0 Release Notes](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0)
- [IconTheme.of, Flutter API-Referenz](https://api.flutter.dev/flutter/widgets/IconTheme/of.html)
- [BlendMode.srcIn, dart:ui API-Referenz](https://api.flutter.dev/flutter/dart-ui/BlendMode.html)
- [ImageIcon displays a colourful icon as black & white, flutter/flutter issue 81643](https://github.com/flutter/flutter/issues/81643)
