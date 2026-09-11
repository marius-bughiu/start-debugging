---
title: "Fix: Flutter-Text wird in einem Android WebView außerhalb des Bildschirms gerendert, wenn die System-Schriftskalierung aktiv ist"
description: "Flutter web 3.41 bis 3.44 meldet eine Zeilenhöhen-Überschreibung von etwa 625x, wenn der textZoom eines Android WebView nicht 100 ist. Aktualisieren Sie auf 3.47 oder entfernen Sie die Überschreibung in MaterialApp.builder."
pubDate: 2026-09-11
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-web"
  - "android"
  - "accessibility"
lang: "de"
translationOf: "2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling"
translatedBy: "claude"
translationDate: 2026-09-11
---

Wenn Ihre Flutter-Web-App in einem Android `WebView` läuft und jedes einfache `Text` verschwindet, sobald der Nutzer die Schriftgröße des Systems ändert, handelt es sich um einen bekannten Fehler in der Web-Engine. Flutter 3.41.0 bis 3.44.9 interpretiert den `textZoom` des WebView fälschlich als Zeilenhöhen-Präferenz des Nutzers. `MediaQuery.lineHeightScaleFactorOverride` liefert ungefähr `624.9`, sodass eine Zeile mit 18 px etwa 12.900 px hoch gelayoutet wird und ihre Glyphen weit unterhalb des Viewports gezeichnet werden. Aktualisieren Sie auf Flutter 3.47.0 oder neuer (3.47.3 ist die aktuelle stabile Version), wo der Erkennungscode neu geschrieben wurde. Auf älteren Versionen entfernen Sie die fehlerhafte Überschreibung in `MaterialApp.builder`. Wenn Sie den Android-Host selbst kontrollieren, können Sie `textZoom` auch fest auf 100 setzen.

Dieser Beitrag behandelt Flutter 3.44.8 (Dart 3.12.2), die Version aus dem Fehlerbericht, und vergleicht sie mit dem Engine-Quellcode von 3.47.3. Das unten beschriebene Verhalten auf Widget-Ebene wurde mit `flutter test` auf 3.44.8 reproduziert.

## So sieht der kaputte Bildschirm aus

Es gibt keine Exception und keinen Fehler in der Konsole. Web-Fonts laden mit HTTP 200, das Ereignis `flutter-first-frame` wird ausgelöst und der Scheduler läuft weiter. Die Symptome sind rein geometrisch:

- Jedes `Text`-Widget ist unsichtbar, während Icons, Rahmen, Bilder und `Container`-Hintergründe weiterhin gezeichnet werden.
- Alles unterhalb des ersten `Text` in einer `Column` ist ebenfalls verschwunden, weil der aufgeblähte Text es Tausende Pixel nach unten schiebt.
- Leisten mit fester Höhe wie `NavigationBar` schneiden ihre Beschriftungen ab, und `TextField`s wachsen auf ihre `maxHeight`.
- Im Release-Modus werden manche Routen durch das graue `ErrorWidget` ersetzt. In einem Debug-Build erscheint ein [RenderFlex-Overflow](/de/2026/05/fix-renderflex-overflowed-in-flutter/), der in Tausenden Pixeln gemessen wird, nicht in den üblichen paar Pixeln über den Rand hinaus.

Der Auslöser ist sehr spezifisch. Derselbe Build wird problemlos in Chrome auf dem Desktop, in der Chrome-Browser-App auf demselben Telefon, in GeckoView und in einem WebView auf dem Standard-Emulator mit Standardeinstellungen gerendert. Er bricht nur in einem Android System WebView, dessen `textZoom` nicht exakt 100 ist. Der Schieberegler für die Schriftgröße unter Einstellungen > Bedienungshilfen setzt diesen Wert automatisch für jedes WebView, das ihn nicht überschreibt.

Gibt man die `MediaQuery`-Werte aus der App heraus aus, wird es offensichtlich. In [flutter/flutter#190350](https://github.com/flutter/flutter/issues/190350) hat der Melder eine unveränderte `flutter create`-App auf Flutter 3.44.8 ausgeführt und nur `adb shell settings put system font_scale` geändert:

```text
font_scale  textZoom  lineHeightScaleFactorOverride  textScaler  Text visible
0.85        85        624.9374824709756              0.85        no
1.0         100       null                           1.0         yes
1.15        115       624.9347955648752              1.15        no
1.3         130       624.9375229225718              1.3         no
```

`textScaler` ist bei jedem Schritt korrekt. `lineHeightScaleFactorOverride` ist bei 100 `null` und bei jeder anderen Zoomstufe etwa 624,94, egal ob der Text kleiner oder größer wurde. Ein Wert, der gleich bleibt, egal in welche Richtung sich die Eingabe bewegt, ist keine Messung. Es ist ein Sentinel-Wert, der durchsickert.

## Warum die Web-Engine eine 625-fache Zeilenhöhe meldet

Seit Flutter 3.41 unterstützt die Web-Engine die Präferenzen für [WCAG 1.4.12 Textabstände](https://www.w3.org/WAI/WCAG21/Understanding/text-spacing.html), die Browser-Erweiterungen und Nutzer-Stylesheets anwenden. [PR #178081](https://github.com/flutter/flutter/pull/178081) hat das hinzugefügt. Flutter zeichnet Text in ein Canvas und kann diese CSS-Überschreibungen daher nicht aus dem eigenen Inhalt auslesen. Stattdessen fügt `EnginePlatformDispatcher._addTypographySettingsObserver` ein verstecktes `<p>`-Probe-Element mit absichtlich absurden Inline-Styles zu `document.body` hinzu und beobachtet es mit einem `ResizeObserver`. Auf 3.44.8 sieht der relevante Teil von `engine/src/flutter/lib/web_ui/lib/src/engine/platform_dispatcher.dart` so aus:

```dart
// Flutter 3.44.8, lib/web_ui/lib/src/engine/platform_dispatcher.dart (abridged)
const spacingDefault = 9999.0;
_typographyMeasurementElement!.style
  ..lineHeight = '${spacingDefault}px'
  ..letterSpacing = '${spacingDefault}px'
  ..wordSpacing = '${spacingDefault}px'
  ..margin = '0px 0px ${spacingDefault}px 0px';
domDocument.body!.append(_typographyMeasurementElement!);
final double typographyMeasurementElementFontSize =
    parseFontSize(_typographyMeasurementElement!)?.toDouble() ?? _defaultRootFontSize;
final double defaultLineHeightFactor = spacingDefault / typographyMeasurementElementFontSize;

// Inside the ResizeObserver callback:
final double? computedLineHeightScaleFactor =
    fontSize != null && lineHeight != null && lineHeight != spacingDefault
    ? lineHeight / fontSize
    : null;
_updateLineHeightScaleFactorOverride(
  computedLineHeightScaleFactor == defaultLineHeightFactor
      ? null
      : computedLineHeightScaleFactor,
);
```

Die Idee: Wenn nichts außerhalb von Flutter das Probe-Element angefasst hat, ist seine berechnete `line-height` weiterhin exakt `9999px` und die Überschreibung bleibt `null`. Jeder andere Wert bedeutet eine Nutzerpräferenz, und sein Verhältnis zur Schriftgröße wird zum neuen Zeilenhöhenfaktor.

Der `textZoom` des Android WebView bricht beide Prüfungen. Er skaliert die `font-size` der Wurzel und skaliert zusätzlich die Pixel-`line-height` des Probe-Elements, was überhaupt keine Nutzerpräferenz ist. Rechnen Sie das für `textZoom` 115 und eine Standard-Wurzelgröße von 16 px durch:

1. Die Schriftgröße des Probe-Elements ist `16 * 1.15 = 18.4px`, also `defaultLineHeightFactor = 9999 / 18.4 = 543.4`.
2. Die berechnete `line-height` ist `9999 * 1.15 = 11498.85px`. Das ist nicht `9999`, also behandelt die Engine es als Überschreibung.
3. `computedLineHeightScaleFactor = 11498.85 / 18.4 = 624.9375`, was exakt `9999 / 16` entspricht. Der Zoomfaktor kürzt sich heraus, und deshalb ändert sich der gemeldete Wert zwischen den Zoomstufen kaum.
4. `624.9375` ist nicht gleich `543.4`, also wird es als `MediaQueryData.lineHeightScaleFactorOverride` veröffentlicht.

Das Framework übernimmt diesen Wert unbesehen. `Text.build` liest `MediaQuery.maybeLineHeightScaleFactorOverrideOf(context)` und erzwingt ihn für `TextStyle.height` des Spans sowie für `StrutStyle.height`, wenn ein Strut gesetzt ist, unabhängig von `inherit`. `TextStyle.height` ist ein Multiplikator der Schriftgröße, wie im [Beitrag zu leadingDistribution](/de/2026/01/flutter-text-the-leadingdistribution-detail-that-changes-how-your-ui-breathes/) beschrieben, sodass die Zeilenbox 625-mal höher wird als die Glyphen. Widgets, die direkt ein `RichText` aufbauen, etwa `Icon`, fragen die Überschreibung nie ab. Deshalb überleben Icons auf einem Bildschirm, auf dem jeglicher Text verschwunden ist.

Es handelt sich um eine Variante eines früheren Fehlers. [#178856](https://github.com/flutter/flutter/issues/178856) beschrieb denselben abnormalen Wert nach dem Ändern der Browser-Schriftgröße zur Laufzeit, und [PR #178862](https://github.com/flutter/flutter/pull/178862) hat ihn am 2. Dezember 2025 behoben. Dieser Fix verglich weiterhin exakt mit `9999`, sodass ein Zoom, der bereits beim ersten Zeichnen aktiv ist, durchrutscht. Eine Bisektion im Issue-Thread verortet die Regression zwischen 3.39.0-0.2.pre (gut) und 3.40.0-0.1.pre (schlecht). Unter den stabilen Releases ist der 9999-px-Sentinel in jedem Tag von 3.41.0 bis 3.44.9 vorhanden und fehlt in 3.38.x.

Der Renderer spielt keine Rolle. Der Thread reproduziert den Fehler mit CanvasKit, mit auf CPU erzwungenem CanvasKit und mit skwasm aus einem [`flutter build web --wasm`](/de/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/)-Build, weil der Defekt in gemeinsam genutztem Dart-Code liegt.

## Minimale Reproduktion

Die Web-Seite ist eine Standard-App, die die Überschreibungen mit `RichText` ausgibt, damit die Ausgabe lesbar bleibt, während der Fehler aktiv ist:

```dart
// Flutter 3.44.8, web target. Serve build/web and load it in an Android WebView.
import 'package:flutter/material.dart';

void main() => runApp(
      const MaterialApp(home: Scaffold(body: SafeArea(child: Probe()))),
    );

class Probe extends StatelessWidget {
  const Probe({super.key});

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        RichText(
          text: TextSpan(
            text: 'line=${mq.lineHeightScaleFactorOverride}\n'
                'scale10=${mq.textScaler.scale(10)}',
            style: const TextStyle(fontSize: 15, color: Colors.black),
          ),
        ),
        const Text('PLAIN TEXT', style: TextStyle(fontSize: 18, color: Colors.red)),
      ],
    );
  }
}
```

Kompilieren Sie sie mit `flutter build web --release` und stellen Sie `build/web` bereit. Führen Sie dann `adb shell settings put system font_scale 1.15` aus und öffnen Sie die Seite in einem einfachen `android.webkit.WebView` mit aktiviertem JavaScript. Der Host muss `setTextZoom` nicht aufrufen, weil das WebView die Systemskalierung von selbst übernimmt.

Ohne Gerät lässt sich die Framework-Hälfte in einem Widget-Test reproduzieren, indem man den Wert einspeist, den die Engine meldet:

```dart
// Flutter 3.44.8, flutter_test
testWidgets('engine-reported override inflates Text', (tester) async {
  await tester.pumpWidget(MaterialApp(
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context)
          .copyWith(textScaler: const TextScaler.linear(1.15))
          .applyTextStyleOverrides(
            lineHeightScaleFactorOverride: 624.9375,
            letterSpacingOverride: null,
            wordSpacingOverride: null,
            paragraphSpacingOverride: null,
          ),
      child: child!,
    ),
    home: const Scaffold(
      body: SingleChildScrollView(
        child: Text('plain', key: Key('t'), style: TextStyle(fontSize: 18)),
      ),
    ),
  ));
  debugPrint('${tester.getSize(find.byKey(const Key('t'))).height}');
});
```

Auf 3.44.8 gibt das `12936.0` aus, also dieselbe Zeilenhöhe von 12.936 px, die der Melder im echten WebView gemessen hat.

## Fix 1: auf Flutter 3.47 aktualisieren

[PR #186474](https://github.com/flutter/flutter/pull/186474), gemergt am 19. Mai 2026, hat die Probe-Logik neu geschrieben. Er entstand für einen Safari-Fehler mit der Einstellung "never use font sizes smaller than" ([#185931](https://github.com/flutter/flutter/issues/185931)), der über denselben Mechanismus denselben aufgeblähten Faktor erzeugte. Der Fix erschien erstmals in 3.46.0-0.1.pre und ist in jedem stabilen 3.47-Release enthalten. Die 3.44.x-Hotfix-Linie, einschließlich 3.44.9 vom 5. August 2026, hat ihn nie erhalten. Der neue Code:

```dart
// Flutter 3.47.3, lib/web_ui/lib/src/engine/platform_dispatcher.dart (abridged)
const spacingDefault = 100.0;
final double defaultLineHeightFactor =
    spacingDefault / (typographyMeasurementElementFontSize / findBrowserTextScaleFactor());

bool isDefault(double? value, double defaultValue) {
  if (value == null) {
    return true;
  }
  return (value - defaultValue).abs() < _typographyPrecisionErrorTolerance ||
      (value - defaultValue * computedTextScaleFactor).abs() <
          _typographyPrecisionErrorTolerance;
}
```

`findBrowserTextScaleFactor()` ist die Wurzel-Schriftgröße geteilt durch 16, also 1,15 bei `textZoom` 115. Die gezoomte Zeilenhöhe von `100 * 1.15` gilt nun als "Standard", ebenso der gezoomte Buchstabenabstand, Wortabstand und Absatzrand. Die Überschreibung bleibt `null`, während `textScaler` weiterhin 1,15 meldet. Außerdem sank der Sentinel von 9999 px auf 100 px, sodass eine künftige Fehlerkennung einen Faktor von etwa 6 statt 625 ergäbe.

Eine Einschränkung: #190350 ist noch offen, und niemand im Thread hat einen Gerätetest auf 3.47 gepostet. Die obige Analyse beruht auf dem Lesen des Quellcodes, nicht auf einem Lauf im WebView. Führen Sie nach dem Update die `RichText`-Probe auf einem echten Gerät mit `font_scale` 1.15 aus und bestätigen Sie `line=null`, bevor Sie einen Workaround entfernen. Wenn Sie ohnehin von 3.44 aktualisieren, lohnt sich ein Blick auf die [Änderung des Desktop-Renderers in 3.47](/de/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) für die anderen Zielplattformen Ihrer App.

```bash
flutter upgrade
flutter --version
```

## Fix 2: unplausible Überschreibungen in MaterialApp.builder entfernen

Wenn Sie 3.41 bis 3.44 noch nicht verlassen können oder den Host nicht kontrollieren, beheben Sie es an der Wurzel des Widget-Baums. `MediaQuery.applyTextStyleOverrides` ersetzt die vier Abstands-Überschreibungen für alles darunter. Es setzt jede exakt auf den übergebenen Wert, `null` eingeschlossen, und behält `textScaler` bei, sodass die vom Nutzer gewählte Schriftgröße weiterhin gilt.

Der im Issue gepostete Workaround setzt alle vier auf `null`. Das funktioniert, verwirft aber auch echte WCAG-Präferenzen für Textabstände, also genau die Funktion, für die es das Probe-Element gibt. Eine engere Schutzfunktion verwirft nur Werte, die keine echte Nutzereinstellung erzeugen kann:

```dart
// Flutter 3.41.0 to 3.44.9, workaround for flutter/flutter#190350
import 'package:flutter/widgets.dart';

/// Drops text spacing overrides that no real user preference can produce.
Widget sanitizeTextSpacing(BuildContext context, Widget? child) {
  final mq = MediaQuery.of(context);
  double? sane(double? value, double max) =>
      value == null || value.abs() > max ? null : value;

  final lineHeight = sane(mq.lineHeightScaleFactorOverride, 4);
  final letter = sane(mq.letterSpacingOverride, 100);
  final word = sane(mq.wordSpacingOverride, 100);
  final paragraph = sane(mq.paragraphSpacingOverride, 1000);

  if (lineHeight == mq.lineHeightScaleFactorOverride &&
      letter == mq.letterSpacingOverride &&
      word == mq.wordSpacingOverride &&
      paragraph == mq.paragraphSpacingOverride) {
    return child ?? const SizedBox.shrink();
  }
  return MediaQuery.applyTextStyleOverrides(
    lineHeightScaleFactorOverride: lineHeight,
    letterSpacingOverride: letter,
    wordSpacingOverride: word,
    paragraphSpacingOverride: paragraph,
    child: child ?? const SizedBox.shrink(),
  );
}
```

Binden Sie sie in jede App-Wurzel ein:

```dart
// Flutter 3.44.8
MaterialApp(
  builder: sanitizeTextSpacing,
  home: const HomePage(),
);
```

WCAG 1.4.12 verlangt eine Zeilenhöhe von 1,5 und einen Buchstabenabstand von 0,12em, sodass eine Faktorgrenze von 4 und eine Grenze von 100 px reichlich Spielraum für echte Präferenzen lassen. Auf 3.44.8 habe ich das mit einem Widget-Test geprüft. Eine Überschreibung von `624.9375` wird zu `null`, und das `Text` mit 18 px misst 30 px statt 12.936 px. Eine Überschreibung von `1.5` wird unverändert durchgereicht. `textScaler.scale(10)` liefert in beiden Fällen `11.5`.

Einige Details sind hier wichtig:

- **Jede Wurzel braucht es.** Der Builder deckt nur seine eigene `MaterialApp` ab. Wenn Sie separate Lade-, Wartungs- oder Onboarding-Apps mit eigener `MaterialApp` oder `WidgetsApp` betreiben, umschließen Sie jede davon.
- **Es folgt Änderungen zur Laufzeit.** `MediaQuery.of(context)` abonniert die umgebenden Daten. Ändert der Nutzer die Schriftgröße, während die Seite geöffnet ist, veröffentlicht die Engine neu und die Schutzfunktion läuft erneut.
- **`MediaQuery.withNoTextScaling` hilft nicht.** Es setzt nur `textScaler` zurück, was nie das Problem war. Das Begrenzen der Textskalierung lässt die Zeilenhöhen-Überschreibung bestehen.
- **Nach dem Update ist es harmlos.** Auf 3.47 sollte die Engine im WebView-Fall `null` melden, sodass die Schutzfunktion `child` unverändert zurückgibt. Sie können sie entfernen, sobald das Update auf einem Gerät bestätigt ist.

## Fix 3: textZoom im Android-Host auf 100 festlegen

Wenn Sie auch den nativen Host ausliefern, können Sie sicherstellen, dass das WebView die System-Schriftskalierung nie an die Seite weitergibt. Von den drei Fixes ist dies der gröbste. Der Flutter-Web-Inhalt folgt der Schriftgröße des Nutzers dann überhaupt nicht mehr, weil `textScaler` bei 1,0 bleibt. Setzen Sie ihn nur ein, wenn die Web-App eine eigene Steuerung für die Textgröße in der App hat.

In einem Kotlin-Host:

```kotlin
// Android System WebView, API 14+
webView.settings.javaScriptEnabled = true
webView.settings.textZoom = 100
```

In einem Flutter-Host, der `webview_flutter` 4.14.1 verwendet, befindet sich die Einstellung am Android-Plattform-Controller in `webview_flutter_android` 4.14.1:

```dart
// webview_flutter 4.14.1, webview_flutter_android 4.14.1
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

WebViewController buildController(Uri appUrl) {
  final controller = WebViewController()
    ..setJavaScriptMode(JavaScriptMode.unrestricted)
    ..loadRequest(appUrl);

  final platform = controller.platform;
  if (platform is AndroidWebViewController) {
    // Opt out of Android's system font scale for this WebView.
    platform.setTextZoom(100);
  }
  return controller;
}
```

Das erklärt auch Berichte, wonach sich der Fehler nicht reproduzieren lässt. Laut Issue-Thread sind Hosts auf Basis von `flutter_inappwebview` immun, weil dieses Plugin `textZoom` standardmäßig auf 100 setzt. Hosts auf Basis von einfachem `android.webkit.WebView` oder `webview_flutter` sind betroffen, sobald der Nutzer den Schriftregler von seinem Standardwert wegbewegt.

## Ähnliche Fehler, die nicht dieser Fehler sind

- **Auf Samsung-Geräten mit Xclipse-GPUs wird gar nichts gerendert.** Wenn auch Icons und Hintergründe fehlen, und zwar nur in CanvasKit, haben Sie es mit [#188164](https://github.com/flutter/flutter/issues/188164) zu tun, einer Rendering-Regression von ANGLE auf Vulkan. Sie tritt sogar bei `textZoom` 100 auf.
- **Riesige Lücken zwischen Widgets in Safari 26.5.** Das ist [#185931](https://github.com/flutter/flutter/issues/185931). Die Ursache ist dieselbe, nur über die Safari-Einstellung für die minimale Schriftgröße, und es gelten dieselben Fixes.
- **Text läuft nach `flutter upgrade` auf nativem Android oder iOS über.** Das Typografie-Probe-Element gibt es nur in der Web-Engine. Prüfen Sie auf mobilen Zielplattformen stattdessen `TextScaler` und Ihre Layout-Constraints. Mit den Accessoren pro Aspekt wie `MediaQuery.textScalerOf`, die genauso funktionieren wie der zum [Auslesen des Eckradius des Bildschirms in Flutter 3.44](/de/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/), können Sie genau protokollieren, was die Plattform meldet.

Ein schneller Test, ob Sie auf diesen Fehler stoßen: Protokollieren Sie `PlatformDispatcher.instance.lineHeightScaleFactorOverride` beim Start. Jeder Wert über etwa 3 im Web bedeutet, dass die Engine das Probe-Element falsch gelesen hat, nicht dass der Nutzer ihn angefordert hat.

## Verwandte Beiträge

- [Fix: A RenderFlex overflowed by N pixels in Flutter](/de/2026/05/fix-renderflex-overflowed-in-flutter/), für den Warnstreifen im Debug-Modus, den dieser Fehler erzeugt.
- [Das `leadingDistribution`-Detail in Flutter `Text`](/de/2026/01/flutter-text-the-leadingdistribution-detail-that-changes-how-your-ui-breathes/), dazu, wie `TextStyle.height` zur Geometrie der Zeilenbox wird.
- [So erstellen Sie eine Flutter-Web-App mit WebAssembly](/de/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), da der Fehler unter skwasm identisch ist.
- [Flutter 3.47 macht Impeller zum Standard-Renderer auf dem Desktop](/de/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/), für das Release, das den Engine-Fix enthält.

## Quellen

- [flutter/flutter#190350](https://github.com/flutter/flutter/issues/190350): der Bericht zum `textZoom` im Android WebView, Bisektion und Workarounds.
- [flutter/flutter#178856](https://github.com/flutter/flutter/issues/178856) und [PR #178862](https://github.com/flutter/flutter/pull/178862): die erste Variante mit Schriftgrößenänderung zur Laufzeit und ihr teilweiser Fix.
- [PR #178081](https://github.com/flutter/flutter/pull/178081): die Unterstützung für Textabstands-Überschreibungen im Web, die das Probe-Element eingeführt hat.
- [PR #186474](https://github.com/flutter/flutter/pull/186474) und [flutter/flutter#185931](https://github.com/flutter/flutter/issues/185931): die zoomtolerante Erkennung, ausgeliefert in 3.46 und 3.47.
- [`platform_dispatcher.dart` in 3.44.8](https://github.com/flutter/flutter/blob/3.44.8/engine/src/flutter/lib/web_ui/lib/src/engine/platform_dispatcher.dart) und [in 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/engine/src/flutter/lib/web_ui/lib/src/engine/platform_dispatcher.dart).
- API-Dokumentation zu [`MediaQuery.applyTextStyleOverrides`](https://api.flutter.dev/flutter/widgets/MediaQuery/applyTextStyleOverrides.html) und [`MediaQueryData.lineHeightScaleFactorOverride`](https://api.flutter.dev/flutter/widgets/MediaQueryData/lineHeightScaleFactorOverride.html).
- [`WebSettings.setTextZoom`](https://developer.android.com/reference/android/webkit/WebSettings#setTextZoom(int)) und [`AndroidWebViewController.setTextZoom`](https://pub.dev/documentation/webview_flutter_android/latest/webview_flutter_android/AndroidWebViewController/setTextZoom.html).
