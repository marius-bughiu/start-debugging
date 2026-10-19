---
title: "Eigene Design-Tokens mit ThemeExtension definieren und zwischen hellem und dunklem Theme in Flutter animieren"
description: "Leiten Sie von ThemeExtension ab, registrieren Sie pro ThemeData eine Instanz über die Liste extensions, lesen Sie sie mit Theme.of(context).extension<T>() und schreiben Sie ein echtes lerp, damit das AnimatedTheme von MaterialApp Ihre Tokens beim Wechsel zwischen hell und dunkel interpoliert. Behandelt Farben, Radien, Schatten, Textstile und Booleans, den Absturz bei fehlender Extension, die copyWith-Falle, die alle anderen Extensions verwirft, und warum == und hashCode nötig sind. Alles mit Widget-Tests unter Flutter 3.44.8 verifiziert."
pubDate: 2026-10-19
template: how-to
tags:
  - "flutter"
  - "dart"
  - "theming"
  - "material-3"
  - "how-to"
lang: "de"
translationOf: "2026/10/how-to-define-custom-design-tokens-with-themeextension-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-19
---

**Kurze Antwort:** Erstellen Sie eine `@immutable`-Klasse, die `ThemeExtension<AppTokens>` erweitert, geben Sie ihr die Felder, die Ihr Designsystem braucht (Farben, Radien, Abstände, Schatten, Textstile), und implementieren Sie `copyWith` und `lerp`. Legen Sie eine Instanz in `ThemeData(extensions: [...])` für `theme` und eine weitere für `darkTheme`, und lesen Sie sie überall mit `Theme.of(context).extension<AppTokens>()!`. `MaterialApp` umschließt Ihre App bereits mit einem `AnimatedTheme`, das bei einem Theme-Wechsel in jedem Frame `ThemeData.lerp` aufruft, und dieses ruft wiederum Ihr `lerp` auf. Wenn Ihr `lerp` jedes Feld mit `Color.lerp`, `lerpDouble`, `BorderRadius.lerp` und Co. interpoliert, blenden Ihre eigenen Tokens zwischen hell und dunkel in exakt denselben 200 ms über wie das eingebaute `ColorScheme`. Alles unten wurde mit Widget-Tests unter Flutter 3.44.8 (Dart 3.12.2) verifiziert.

Der Rest dieses Beitrags behandelt, was `ThemeExtension` innerhalb von `ThemeData` tatsächlich ist, eine vollständige Token-Klasse mit sieben verschiedenen Feldtypen, die Verdrahtung in `MaterialApp`, die Steuerung der Animation und vier Fallstricke aus meinen Tests: eine Extension, die nur in einem Theme existiert, `copyWith`, das stillschweigend Ihre anderen Extensions löscht, eine Animation, die bei jedem Rebuild neu startet, und Booleans, die genau zur Halbzeit umspringen.

## Warum ColorScheme für Design-Tokens nicht ausreicht

Das `ColorScheme` von Material 3 hat etwa 45 Rollen, und wenn Sie Ihre Markenfarbe über `ColorScheme.fromSeed` setzen, erhalten Sie kostenlos eine stimmige Palette (siehe [wie Sie die Akzentfarbe mit einem Material-3-ColorScheme setzen](/de/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)). Ein echtes Designsystem hat jedoch Tokens, an die Material nie gedacht hat: ein "Success"-Grün, das nicht `tertiary` ist, eine erhöhte Kartenfläche, die sich um ein paar Prozent von `surfaceContainerHigh` unterscheidet, einen Textstil für Codeblöcke, einen Kartenradius, einen Schatten, der im hellen Modus existiert und im dunklen verschwindet.

Die üblichen Behelfslösungen sind alle schlecht. Eine globale Klasse `AppColors` mit statischen Konstanten kann sich nicht mit der Helligkeit ändern. Ein überall in den Widgets verstreutes `context.isDark ? x : y` springt beim Theme-Wechsel sofort um, während der Rest der App animiert, was kaputt aussieht. Ein eigenes `InheritedWidget` funktioniert, aber Sie müssen die Animationsinfrastruktur nachbauen, die `ThemeData` bereits mitbringt.

`ThemeExtension` wurde in Flutter 3.0 (PR #98033) genau dafür eingeführt. Damit können Sie eigene typisierte Objekte an `ThemeData` hängen, und weil `ThemeData.lerp` sie kennt, nehmen sie an Theme-Animationen teil.

## Was ThemeData mit Ihrer Extension macht

Der gesamte Mechanismus ist klein genug, um ihn in einem Rutsch zu lesen. Aus `packages/flutter/lib/src/material/theme_data.dart` in Flutter 3.44.8:

```dart
// Flutter 3.44.8, theme_data.dart (abridged)
abstract class ThemeExtension<T extends ThemeExtension<T>> {
  const ThemeExtension();

  Object get type => T;

  ThemeExtension<T> copyWith();

  ThemeExtension<T> lerp(covariant ThemeExtension<T>? other, double t);
}

// On ThemeData:
final Map<Object, ThemeExtension<dynamic>> extensions;

T? extension<T>() => extensions[T] as T?;
```

Daraus ergeben sich drei Fakten:

1. Extensions werden in einer `Map` gespeichert, deren Schlüssel `type` ist, also das generische Argument `T`. Pro Typ kann es höchstens eine Extension geben, und der Zugriff ist ein Map-Lesezugriff.
2. `extension<T>()` gibt `T?` zurück. Wenn das aktuelle Theme keinen Eintrag für `T` hat, erhalten Sie `null`, keine Exception.
3. `lerp` liegt in Ihrer Verantwortung. Das Framework prüft Ihre Felder nie.

Und so kombiniert `ThemeData.lerp` die beiden Maps:

```dart
// Flutter 3.44.8, ThemeData._lerpThemeExtensions
final Map<Object, ThemeExtension<dynamic>> newExtensions = a.extensions.map((
  Object id,
  ThemeExtension<dynamic> extensionA,
) {
  final ThemeExtension<dynamic>? extensionB = b.extensions[id];
  return MapEntry<Object, ThemeExtension<dynamic>>(id, extensionA.lerp(extensionB, t));
});
// Add [b]-only extensions.
newExtensions.addEntries(
  b.extensions.entries.where(
    (MapEntry<Object, ThemeExtension<dynamic>> entry) => !a.extensions.containsKey(entry.key),
  ),
);
```

Für jede Extension im "von"-Theme wird `lerp(matching, t)` aufgerufen, wobei `matching` `null` sein kann. Extensions, die nur im "nach"-Theme existieren, werden ohne Interpolation übernommen. Merken Sie sich das für den Abschnitt zu den Fallstricken.

## Schritt für Schritt: ein animiertes Token-Set bauen

1. Definieren Sie eine `@immutable`-Unterklasse von `ThemeExtension<AppTokens>` mit ausschließlich nicht-nullbaren Feldern.
2. Implementieren Sie `copyWith`, damit Aufrufer einzelne Tokens überschreiben können.
3. Implementieren Sie `lerp` mit dem passenden `lerp`-Helfer für jeden Feldtyp.
4. Überschreiben Sie `==` und `hashCode`, damit gleiche Token-Sets als gleich verglichen werden.
5. Registrieren Sie eine helle Instanz für `theme` und eine dunkle für `darkTheme`.
6. Lesen Sie die Tokens über einen Getter in einer `BuildContext`-Extension.

### Schritte 1 bis 4: die Token-Klasse

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:ui' show lerpDouble;

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';

@immutable
class AppTokens extends ThemeExtension<AppTokens> {
  const AppTokens({
    required this.surfaceRaised,
    required this.success,
    required this.cardRadius,
    required this.cardElevationShadow,
    required this.gap,
    required this.codeStyle,
    required this.useHairlineBorders,
  });

  final Color surfaceRaised;
  final Color success;
  final BorderRadius cardRadius;
  final List<BoxShadow> cardElevationShadow;
  final double gap;
  final TextStyle codeStyle;
  final bool useHairlineBorders;

  static const light = AppTokens(
    surfaceRaised: Color(0xFFFFFFFF),
    success: Color(0xFF1B873F),
    cardRadius: BorderRadius.all(Radius.circular(12)),
    cardElevationShadow: [
      BoxShadow(color: Color(0x1F000000), blurRadius: 12, offset: Offset(0, 4)),
    ],
    gap: 16,
    codeStyle: TextStyle(fontFamily: 'monospace', fontSize: 13, color: Color(0xFF24292F)),
    useHairlineBorders: false,
  );

  static const dark = AppTokens(
    surfaceRaised: Color(0xFF1E2228),
    success: Color(0xFF4ADE80),
    cardRadius: BorderRadius.all(Radius.circular(12)),
    cardElevationShadow: [
      BoxShadow(color: Color(0x00000000), blurRadius: 0, offset: Offset.zero),
    ],
    gap: 16,
    codeStyle: TextStyle(fontFamily: 'monospace', fontSize: 13, color: Color(0xFFE6EDF3)),
    useHairlineBorders: true,
  );

  @override
  AppTokens copyWith({
    Color? surfaceRaised,
    Color? success,
    BorderRadius? cardRadius,
    List<BoxShadow>? cardElevationShadow,
    double? gap,
    TextStyle? codeStyle,
    bool? useHairlineBorders,
  }) {
    return AppTokens(
      surfaceRaised: surfaceRaised ?? this.surfaceRaised,
      success: success ?? this.success,
      cardRadius: cardRadius ?? this.cardRadius,
      cardElevationShadow: cardElevationShadow ?? this.cardElevationShadow,
      gap: gap ?? this.gap,
      codeStyle: codeStyle ?? this.codeStyle,
      useHairlineBorders: useHairlineBorders ?? this.useHairlineBorders,
    );
  }

  @override
  AppTokens lerp(AppTokens? other, double t) {
    if (other is! AppTokens) return this;
    return AppTokens(
      surfaceRaised: Color.lerp(surfaceRaised, other.surfaceRaised, t)!,
      success: Color.lerp(success, other.success, t)!,
      cardRadius: BorderRadius.lerp(cardRadius, other.cardRadius, t)!,
      cardElevationShadow:
          BoxShadow.lerpList(cardElevationShadow, other.cardElevationShadow, t)!,
      gap: lerpDouble(gap, other.gap, t)!,
      codeStyle: TextStyle.lerp(codeStyle, other.codeStyle, t)!,
      useHairlineBorders: t < 0.5 ? useHairlineBorders : other.useHairlineBorders,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AppTokens &&
          other.surfaceRaised == surfaceRaised &&
          other.success == success &&
          other.cardRadius == cardRadius &&
          listEquals(other.cardElevationShadow, cardElevationShadow) &&
          other.gap == gap &&
          other.codeStyle == codeStyle &&
          other.useHairlineBorders == useHairlineBorders;

  @override
  int get hashCode => Object.hash(
        surfaceRaised,
        success,
        cardRadius,
        Object.hashAll(cardElevationShadow),
        gap,
        codeStyle,
        useHairlineBorders,
      );
}
```

Einige Entscheidungen hier sind bewusst getroffen:

- **Nicht-nullbare Felder.** Das offizielle Beispiel im Flutter-Repository (`examples/api/lib/material/theme/theme_extension.1.dart`) verwendet `Color?`. Das kompiliert, aber dann braucht jede Aufrufstelle ein `!` oder einen Fallback, und `Color.lerp(null, x, t)` blendet von Transparent aus ein, was selten gewünscht ist. Wenn ein Token in Ihrem Designsystem immer existiert, machen Sie es zum Pflichtfeld.
- **Der Parametertyp von `lerp` ist `AppTokens?`, nicht `ThemeExtension<AppTokens>?`.** Die Basissignatur markiert den Parameter als `covariant`, daher können Sie ihn einengen. `other is! AppTokens` deckt den Fall `null` ab.
- **Jeder Feldtyp hat ein passendes statisches `lerp`.** `Color.lerp`, `lerpDouble`, `BorderRadius.lerp`, `EdgeInsets.lerp`, `TextStyle.lerp`, `BoxShadow.lerpList`, `Gradient.lerp`, `Offset.lerp` und `Size.lerp` existieren alle. Sie geben nullbare Typen zurück, weil sie nullbare Eingaben akzeptieren, daher das `!`, wenn beide Eingaben nicht null sind.
- **Diskrete Werte wechseln am Mittelpunkt.** Zwischen `true` und `false` gibt es keinen sinnvollen Zwischenwert. `ThemeData` selbst verwendet das Muster `t < 0.5 ? a : b` für Dinge wie `platform` und `useMaterial3`, also übernehme ich es.
- **Ein Schatten, der "verschwindet", ist ein transparenter Schatten, keine leere Liste.** `BoxShadow.lerpList` kann Listen unterschiedlicher Länge interpolieren, aber ein Schatten mit gleicher Geometrie und Alpha null liefert eine saubere Überblendung. In meinem Test lag das Schatten-Alpha zur Halbzeit bei `0.0608`, ungefähr die Hälfte des hellen Werts `0x1F` (`0.1216`), also genau die gewünschte Überblendung.

### Schritt 5: beide Instanzen registrieren

```dart
// Flutter 3.44.8
MaterialApp(
  theme: ThemeData(
    colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
    extensions: const <ThemeExtension<dynamic>>[AppTokens.light],
  ),
  darkTheme: ThemeData(
    colorScheme: ColorScheme.fromSeed(
      seedColor: Colors.teal,
      brightness: Brightness.dark,
    ),
    extensions: const <ThemeExtension<dynamic>>[AppTokens.dark],
  ),
  themeMode: themeMode, // ThemeMode.system, .light or .dark
  home: const HomePage(),
);
```

Mehr Animationsverdrahtung brauchen Sie nicht. `_MaterialAppState._materialBuilder` wählt anhand von `themeMode` und der Plattformhelligkeit `theme` oder `darkTheme` aus und umschließt dann den Teilbaum mit `AnimatedTheme(data: theme, duration: ..., curve: ...)`. Ändert sich das gewählte `ThemeData`, startet `AnimatedTheme` einen `ThemeDataTween`, dessen `lerp` buchstäblich `ThemeData.lerp(begin!, end!, t)` ist. Ihre Tokens sind damit Teil dieses Tweens.

Das funktioniert sowohl, wenn Ihr eigener Code `themeMode` umschaltet, als auch, wenn der Benutzer im Betriebssystem den Dunkelmodus umschaltet, während `themeMode` auf `ThemeMode.system` steht.

### Schritt 6: Tokens ohne Umstände lesen

`Theme.of(context).extension<AppTokens>()!` ist lang. Eine `BuildContext`-Extension lässt die Aufrufstellen wie Designsystem-Code lesen:

```dart
// Flutter 3.44.8
extension AppTokensContext on BuildContext {
  AppTokens get tokens => Theme.of(this).extension<AppTokens>()!;
}

class TokenCard extends StatelessWidget {
  const TokenCard({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Container(
      padding: EdgeInsets.all(tokens.gap),
      decoration: BoxDecoration(
        color: tokens.surfaceRaised,
        borderRadius: tokens.cardRadius,
        boxShadow: tokens.cardElevationShadow,
        border: tokens.useHairlineBorders
            ? Border.all(color: Theme.of(context).colorScheme.outlineVariant, width: 0.5)
            : null,
      ),
      child: DefaultTextStyle.merge(style: tokens.codeStyle, child: child),
    );
  }
}
```

Da `Theme.of` eine Abhängigkeit vom geerbten Theme registriert, wird `TokenCard` in jedem Frame der Theme-Animation neu aufgebaut und sieht die interpolierten Werte. Beachten Sie, dass `Container` mit `color` und `decoration` zusammen eine Exception wirft, weshalb die Farbe innerhalb von `BoxDecoration` liegt (die ganze Geschichte steht in [der Lösung für "Cannot provide both a color and a decoration"](/de/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/)).

## Beweisen, dass die Tokens wirklich animieren

Visuelle Kontrolle ist bei 200 ms unzuverlässig. Ein Widget-Test, der zur Hälfte der Animation pumpt, ist es nicht:

```dart
// Flutter 3.44.8, flutter_test
AppTokens? seen;

class Probe extends StatelessWidget {
  const Probe({super.key});
  @override
  Widget build(BuildContext context) {
    seen = Theme.of(context).extension<AppTokens>();
    return const SizedBox();
  }
}

Widget app(ThemeMode mode) => MaterialApp(
      theme: ThemeData(extensions: const [AppTokens.light]),
      darkTheme: ThemeData(
        brightness: Brightness.dark,
        extensions: const [AppTokens.dark],
      ),
      themeMode: mode,
      home: const Probe(),
    );

testWidgets('tokens interpolate during a theme switch', (tester) async {
  await tester.pumpWidget(app(ThemeMode.light));
  expect(seen!.surfaceRaised, AppTokens.light.surfaceRaised);

  await tester.pumpWidget(app(ThemeMode.dark));
  await tester.pump(const Duration(milliseconds: 100)); // halfway of 200 ms
  expect(seen!.surfaceRaised, isNot(AppTokens.light.surfaceRaised));
  expect(seen!.surfaceRaised, isNot(AppTokens.dark.surfaceRaised));

  await tester.pumpAndSettle();
  expect(seen!.surfaceRaised, AppTokens.dark.surfaceRaised);
});
```

Bei 100 ms lag die Oberflächenfarbe bei `Color(red: 0.5588, green: 0.5667, blue: 0.5784)`, fast exakt der Mittelpunkt zwischen Weiß und `#1E2228`. Die Standardkurve ist `Curves.linear`, daher entspricht `t` der verstrichenen Zeit geteilt durch die Dauer.

## Dauer und Kurve steuern

`MaterialApp` stellt die Animation über zwei ältere Parameter und einen neueren bereit:

```dart
// Flutter 3.44.8
MaterialApp(
  // Older API, still supported:
  themeAnimationDuration: const Duration(milliseconds: 350),
  themeAnimationCurve: Curves.easeInOut,

  // Newer API, takes precedence when non-null:
  themeAnimationStyle: AnimationStyle(
    duration: const Duration(milliseconds: 350),
    curve: Curves.easeInOutCubic,
  ),
  // ...
);
```

Der Standard ist `kThemeAnimationDuration`, also 200 ms. Mit `themeAnimationStyle: AnimationStyle.noAnimation` wird `AnimatedTheme` durch ein einfaches `Theme` ersetzt, sodass der Wechsel sofort erfolgt. Ich habe bestätigt, dass in diesem Modus bereits der allererste Frame nach dem Wechsel das dunkle `surfaceRaised` meldet. Das ist die richtige Einstellung für Golden-Tests und für Benutzer, die "Bewegung reduzieren" aktivieren, was Sie über `MediaQuery.disableAnimationsOf(context)` auslesen können.

## Fallstricke, die in Tests aufgetaucht sind

### Eine Extension, die in einem Theme fehlt, stürzt am Ende der Animation ab

Angenommen, Sie registrieren `AppTokens.light` für `theme`, vergessen es aber bei `darkTheme`. Während der Animation ruft `_lerpThemeExtensions` `AppTokens.light.lerp(null, t)` auf, was `this` zurückgibt, sodass Widgets weiterhin helle Tokens sehen. In meinem Test lieferte der Frame zur Halbzeit eine `AppTokens`-Instanz. Dann erreicht der Tween `t == 1.0`, `Tween.transform` gibt direkt `end` zurück, und `end` hat überhaupt kein `AppTokens`. `extension<AppTokens>()` gibt `null` zurück, und `context.tokens` wirft im letzten Frame einen Null-Check-Fehler.

Das Ergebnis ist ein Absturz, der erst nach einem Theme-Wechsel auftritt, also die Art, die man am leichtesten übersieht. Die Lösung ist strukturell: Bauen Sie beide Themes aus einer Funktion, damit die Liste der Extensions immer vorhanden ist.

```dart
// Flutter 3.44.8
ThemeData buildTheme(Brightness brightness) {
  final isDark = brightness == Brightness.dark;
  return ThemeData(
    colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal, brightness: brightness),
    extensions: <ThemeExtension<dynamic>>[
      isDark ? AppTokens.dark : AppTokens.light,
    ],
  );
}
```

### ThemeData.copyWith(extensions: ...) ersetzt die gesamte Map

Das trifft Sie, wenn Sie für einen Teilbaum ein einzelnes Token überschreiben. Der Quelltext von `ThemeData.copyWith` lautet:

```dart
extensions: (extensions != null) ? _themeExtensionIterableToMap(extensions) : this.extensions,
```

Es gibt kein Zusammenführen. In meinem Test lieferte ein Theme mit `AppTokens` und `BrandTokens`, das durch `copyWith(extensions: [BrandTokens(...)])` ging, für `extension<AppTokens>()` den Wert `null`. Um eine Extension zu überschreiben und die übrigen zu behalten, spreaden Sie zuerst die vorhandenen Werte. Spätere Einträge gewinnen, weil die Map in einer `for`-Schleife über `type` aufgebaut wird:

```dart
// Flutter 3.44.8
final theme = Theme.of(context);
return Theme(
  data: theme.copyWith(
    extensions: [
      ...theme.extensions.values,
      context.tokens.copyWith(gap: 8), // overrides AppTokens only
    ],
  ),
  child: const CompactSection(),
);
```

Lassen Sie das Listenliteral hier untypisiert. Die Schreibweise `<ThemeExtension<dynamic>>[...]` lässt sich unter Dart 3.12.2 nicht kompilieren und meldet "Can't assign spread elements of type 'ThemeExtension<dynamic>' to collection elements of type 'ThemeExtension<ThemeExtension<dynamic>>'", eine Eigenheit der selbstreferenziellen Schranke `T extends ThemeExtension<T>`. Wenn die Inferenz den Elementtyp wählt, kompiliert der Code und verhält sich korrekt: In meinem Test sah der Teilbaum `gap: 8.0` und die unveränderte `BrandTokens`-Extension.

Ein einfaches `Theme`-Widget animiert nicht. Wenn die Überschreibung selbst übergehen soll (zum Beispiel ein "Gefahrenbereich", der sich beim Hover einfärbt), verwenden Sie direkt `AnimatedTheme`.

### Ohne == und hashCode startet die Theme-Animation bei jedem Rebuild neu

`ThemeData.==` vergleicht `extensions` mit `mapEquals`, was auf jeder Extension `==` aufruft. Wenn Ihre Klasse `==` nicht überschreibt, sind zwei Instanzen mit identischen Werten nicht gleich. Das spielt eine Rolle, sobald Sie Tokens zur Laufzeit statt als `const`-Instanzen erzeugen, etwa aus einer vom Benutzer gewählten Akzentfarbe oder mit `AppTokens.light.copyWith()` innerhalb von `build`.

Ich habe das getestet, indem ich `MaterialApp` mit einer frischen, aber identischen `copyWith()`-Instanz neu aufgebaut habe, nachdem die erste Animation abgeschlossen war. Ohne `==` war `tester.hasRunningAnimations` `true`: `AnimatedTheme` sah ein "neues" Theme und startete einen weiteren 200-ms-Tween, der alle themenabhängigen Widgets 12 Frames lang ohne sichtbare Änderung neu aufbaute. Nach dem Hinzufügen der oben gezeigten Überschreibungen von `==` und `hashCode` meldete derselbe Test `false`. Wenn Sie diese nicht von Hand schreiben möchten, generieren Pakete wie `theme_extensions_builder` `copyWith`, `lerp`, `==` und `hashCode` aus einer Annotation.

### Booleans und Enums springen genau bei t = 0.5 um

Mit dem Muster `t < 0.5` war `useHairlineBorders` im Frame bei 100 ms bereits `true`, weil `t` genau `0.5` betrug. Das entspricht der Art, wie `ThemeData` seine eigenen diskreten Felder interpoliert, bedeutet aber, dass ein Rahmen mitten in einer Farbüberblendung aufpoppen kann. Wenn das falsch aussieht, drücken Sie das Visuelle stattdessen als kontinuierliches Token aus: Ersetzen Sie den Boolean durch eine Rahmen-`Color`, die von Transparent zu `outlineVariant` läuft, und lassen Sie `Color.lerp` den Rest erledigen.

### Der Schlüssel ist das generische Argument, nicht der Laufzeittyp

`type` gibt `T` zurück, das Typargument, das Sie an `ThemeExtension` übergeben haben, nicht `runtimeType`. Wenn Sie `class BrandAppTokens extends AppTokens` schreiben, wird eine Instanz davon unter `AppTokens` gespeichert und ersetzt die Basisinstanz. Für White-Labeling ist das meist gewünscht, es bedeutet aber, dass Sie eine Basisklasse und eine Unterklasse nicht nebeneinander registrieren können.

## Wo ThemeExtension neben anderen Theming-Werkzeugen steht

Verwenden Sie zuerst `ColorScheme` für alles, was Material-Komponenten auswerten, denn Buttons, Chips und App-Leisten lesen Ihre Extension nie. Verwenden Sie Komponenten-Themes (`CardThemeData`, `FilledButtonThemeData`), wenn Sie ein Material-Widget überall umgestalten möchten. Verwenden Sie `ThemeExtension` für alles, was Ihre eigenen Widgets brauchen und wofür Material keinen Platz vorsieht. Wenn Sie zusätzlich Schriften über `google_fonts` laden, belassen Sie das `TextTheme` in `ThemeData.textTheme` und legen Sie nur nicht standardmäßige Stile (Codeblöcke, Zahlenanzeigen) in die Extension; der Typkonflikt, der dort manchmal auftritt, wird in [der Lösung zum google_fonts-TextTheme](/de/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/) behandelt.

Dasselbe Modell eines "Umgebungswerts vom nächsten geerbten Widget" steckt hinter `IconTheme`, was erklärt, warum Icons Farben übernehmen, die Sie nie gesetzt haben, wie in [wie Sie verhindern, dass ImageIcon mit der IconTheme-Farbe eingefärbt wird](/de/2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter/) beschrieben. Und wenn Ihr Theme-Umschalter ein Sonnen-Icon gegen ein Mond-Icon tauscht, [braucht AnimatedSwitcher einen Key, um diesen Tausch zu animieren](/de/2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change/).

### Weiterlesen

- [Wie Sie die Akzentfarbe in einer Flutter-App mit Material 3 ColorScheme setzen](/de/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)
- [Wie Sie AnimatedSwitcher animieren lassen, wenn sich der Typ des Child-Widgets nicht ändert](/de/2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change/)
- [Wie Sie verhindern, dass ImageIcon ein Icon mit der Umgebungsfarbe des IconTheme einfärbt](/de/2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter/)
- [Fix: The argument type 'TextTheme' can't be assigned to the parameter type 'TextTheme?' with google_fonts](/de/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/)

## Quellen

- [`ThemeExtension` class, Flutter API docs](https://api.flutter.dev/flutter/material/ThemeExtension-class.html)
- [`ThemeData.extensions` property, Flutter API docs](https://api.flutter.dev/flutter/material/ThemeData/extensions.html)
- [`MaterialApp.themeAnimationStyle`, Flutter API docs](https://api.flutter.dev/flutter/material/MaterialApp/themeAnimationStyle.html)
- [`theme_data.dart` source on GitHub](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/material/theme_data.dart)
- [Official `ThemeExtension` sample, `theme_extension.1.dart`](https://github.com/flutter/flutter/blob/master/examples/api/lib/material/theme/theme_extension.1.dart)
- [Introduce Theme extensions (flutter/flutter#98033)](https://github.com/flutter/flutter/pull/98033)
