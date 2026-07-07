---
title: "Flutter 3.44: Den physischen Eckenradius des Bildschirms aus MediaQuery lesen"
description: "Flutter 3.44 stellt die abgerundeten Ecken des Geräts über MediaQuery.displayCornerRadiiOf bereit. Schluss mit dem Raten eines magischen Radius: Beschneiden Sie Ihre UI auf die exakte Hardware-Kurve unter Android API 31+."
pubDate: 2026-07-07
tags:
  - "flutter"
  - "dart"
lang: "de"
translationOf: "2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery"
translatedBy: "claude"
translationDate: 2026-07-07
---

Handys haben schon vor Jahren aufgehört, eckige Bildschirme zu haben, aber Flutter hat Ihnen nie verraten, wie rund die Ecken tatsächlich waren. Wenn eine Karte oder ein Vollbild-Sheet sich an die physische Kurve des Displays anschmiegen sollte, haben Sie ein `BorderRadius.circular(24)` fest im Code hinterlegt, das Sie an einem Gerät nach Augenmaß abgestimmt haben, in der Hoffnung, dass es auf den übrigen gut aussieht. Flutter 3.44, die aktuelle stabile Version, liest diesen Wert endlich direkt aus der Hardware und übergibt ihn Ihnen über `MediaQuery`.

## Der Wert, den das Betriebssystem längst kannte

Android stellt die Radien pro Ecke seit API-Level 31 über seine `RoundedCorner`-API bereit, aber das Framework hat sie nie sichtbar gemacht. [PR #179219](https://github.com/flutter/flutter/pull/179219) leitet diese Radien aus den Fenster-Metriken der Engine bis hinauf in `MediaQueryData`. Sie lesen sie genauso wie Padding oder View Insets:

```dart
final BorderRadius? corners = MediaQuery.displayCornerRadiiOf(context);
```

Der Rückgabetyp ist ein nullbares `BorderRadius`. Jede Ecke ist ein `Radius` in logischen Pixeln, sodass er sich direkt mit den Widgets kombinieren lässt, die Sie bereits verwenden. Unter Android vor API 31, unter iOS und auf jeder anderen Plattform ist der Wert `null`, sodass eine null-Prüfung Ihr Fallback-Pfad ist und kein nachträglicher Einfall.

## Auf die Hardware-Kurve beschneiden

Der naheliegende Einsatz ist eine Vollbild-Oberfläche, deren Rundung zum Glas passt. Früher haben Sie eine Zahl erfunden. Jetzt fragen Sie das Display:

```dart
@override
Widget build(BuildContext context) {
  final BorderRadius radius =
      MediaQuery.displayCornerRadiiOf(context) ?? BorderRadius.circular(16);

  return ClipRRect(
    borderRadius: radius,
    child: ColoredBox(
      color: Theme.of(context).colorScheme.surface,
      child: content,
    ),
  );
}
```

Da `displayCornerRadii` ein echtes `BorderRadius` ist, können sich seine vier Ecken unterscheiden. Das ist bei Geräten wichtig, deren untere Rundung enger ist als die obere, oder bei denen ein Faltscharnier einer Kante ein anderes Profil verleiht. Sie können auch eine einzelne Ecke abrufen, wenn Sie nur eine brauchen:

```dart
final Radius topLeft =
    (MediaQuery.displayCornerRadiiOf(context) ?? BorderRadius.zero).topLeft;
```

## Physische Pixel, wenn Sie sie brauchen

`MediaQuery` liefert logische Pixel, was der Layout-Code will. Wenn Sie auf reiner Pixel-Ebene arbeiten, etwa in einem eigenen `RenderObject` oder einem Shader, liegen dieselben Daten auf der View: `FlutterView.displayCornerRadii` gibt die Werte in physischen Pixeln zurück. Wählen Sie den, der zum Koordinatenraum passt, in dem Sie zeichnen, und Sie vermeiden eine Multiplikation mit `devicePixelRatio`, die man leicht falsch herum ansetzt.

## Wo sich das wirklich lohnt

Die meisten Apps brauchen keine pixelgenaue Eckenübereinstimmung, und `SafeArea` deckt weiterhin den häufigen Fall ab, Inhalte aus dem Notch herauszuhalten. Dies ist für die Oberflächen, die als Teil des Geräts selbst gelesen werden: Bottom Sheets, die bis zur Glaskante hochgleiten, immersive Media-Player, Kiosk-Layouts und die neuen Predictive-Back-Übergänge, die Flutter 3.44 bereits an `displayCornerRadii` anbindet, damit der ausgehende Bildschirm zu einem korrekt abgerundeten Rechteck schrumpft.

Die Funktion ist klein, aber sie schließt eine Lücke, die jede Übergabe von Designer zu Entwickler mit einer geratenen Zahl enden ließ. Behandeln Sie `null` als "nimm eckig an, greife auf deine eigene Konstante zurück", und der Rest ist nur das Auslesen eines Werts, den das Betriebssystem die ganze Zeit vorhielt. Siehe die [Dokumentation zu MediaQueryData.displayCornerRadii](https://api.flutter.dev/flutter/widgets/MediaQueryData/displayCornerRadii.html) für den vollständigen Vertrag.
