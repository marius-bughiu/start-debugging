---
title: "Fix: Flutter-UI überlappt die Android-Systemnavigationsleiste nach dem Wechsel auf SDK 35"
description: "Mit SDK 35 als Ziel läuft Ihre Flutter-App im Edge-to-Edge-Modus, also zeichnet der Scaffold-Body hinter der Navigationsleiste. Verarbeiten Sie die Insets mit SafeArea und MediaQuery-Padding, statt den Modus abzuschalten, denn diese Abmeldung ist unter Android 16 bereits tot."
pubDate: 2026-08-21
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "layout"
lang: "de"
translationOf: "2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35"
translatedBy: "claude"
translationDate: 2026-08-21
---

Ihre Buttons funktionierten im letzten Release. Jetzt sitzt die untere Zeile Ihres `Scaffold` unter der Android-Navigationsleiste, halb sichtbar und halb antippbar, und an Ihrem Layout-Code hat sich nichts geändert. Geändert hat sich das Ziel-SDK: Sobald eine Flutter-App auf Android SDK 35 (API 35, Android 15) zielt, führt Android sie edge-to-edge aus, und das Fenster Ihrer App umfasst nun die volle Displayhöhe einschließlich des Streifens, den die Systemleisten belegen. Die Lösung besteht nicht darin, diesen Streifen zurückzuholen, sondern darin, das von Android gemeldete Inset zu lesen und den eigenen Inhalt entsprechend abzusetzen. Umschließen Sie unten verankerte Inhalte mit `SafeArea` und geben Sie Scrollables ein Padding von `MediaQuery.paddingOf(context).bottom`, damit die Liste unter der Leiste scrollt, aber davor stehen bleibt. Greifen Sie nicht zu `android:windowOptOutEdgeToEdgeEnforcement`: Flutters Standard-`targetSdkVersion` liegt schon lange vor dem aktuellen Stable bei 36, und unter API 36 ist diese Abmeldung veraltet und deaktiviert.

Alles Folgende wurde gegen Flutter 3.44.2 (Dart 3.12.2) verifiziert, die SDK-Standardwerte zusätzlich gegen das aktuelle Stable, Flutter 3.47.1 (veröffentlicht am 2026-08-19, Dart 3.13.1).

## Warum 48 logische Pixel am unteren Rand Ihrer App verschwunden sind

Vor Android 15 bekam eine App, die nicht ausdrücklich edge-to-edge ging, ein Fenster, das dort endete, wo die Systemleisten begannen. Die Navigationsleiste war undurchsichtig, sie gehörte dem System, und Ihr `Scaffold` sah diese Pixel schlicht nie. Layout war einfach, weil das Betriebssystem das Absetzen für Sie erledigte.

Android 15 hat diesen Standard umgedreht. In Androids Edge-to-Edge-Leitfaden heißt es: "Edge-to-edge is enforced on Android 15 (API level 35) and higher once your app targets SDK 35." Ihr Fenster umfasst jetzt das gesamte Display. Die Statusleiste wird transparent, die Gestennavigationsleiste wird transparent, und die Dreitasten-Navigationsleiste wird durchscheinend. Android teilt Ihnen über die Window Insets weiterhin exakt mit, wie viel Platz diese Leisten einnehmen, zieht diesen Platz aber nicht mehr für Sie ab.

Flutter hat das in dem Moment geerbt, in dem sich sein Standardziel verschoben hat. Der Migrationshinweis des Frameworks ist bei der Abfolge deutlich: "Prior to Flutter 3.27, Flutter apps targeted Android 14 by default and didn't opt into edge-to-edge mode automatically." Ab Flutter 3.27 zielen Apps, die `flutter.targetSdkVersion` verwenden, auf Android 15 und sind automatisch dabei. Die Änderung landete in `3.26.0-0.0.pre` und wurde mit 3.27 stabil.

Dieser Standard hat sich seitdem erneut verschoben, und genau an dieser Stelle sind die meisten Texte zu diesem Fehler veraltet. Im Gradle-Plugin von Flutter 3.44.2, und identisch im Tag 3.47.1, lauten die Standardwerte:

```kotlin
// packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt
// Identical in Flutter 3.44.2 and 3.47.1
val compileSdkVersion: Int = 36
val minSdkVersion: Int = 24
val targetSdkVersion: Int = 36
```

Eine frisch mit `flutter create` erzeugte App zielt heute also nicht nur auf das SDK, in dem Edge-to-Edge der Standard ist. Sie zielt auf jenes, in dem Edge-to-Edge die einzige Option ist.

## Wie die Überlappung in Zahlen tatsächlich aussieht

Es lohnt sich, das mit Messungen statt mit Screenshots festzuhalten, denn "auf meinem Pixel sieht es falsch aus" ist keine debugbare Aussage. Ein Widget-Test kann das Gerät präzise modellieren: Setzen Sie das `viewPadding` der View auf eine 24dp-Statusleiste und eine 48dp-Dreitasten-Navigationsleiste, setzen Sie `devicePixelRatio` auf 1, damit logische Pixel den physischen entsprechen, und messen Sie, wo Widgets in einem 800dp hohen Fenster landen.

```dart
// Flutter 3.44.2 / Dart 3.12.2
void setNavBarView(WidgetTester tester) {
  tester.view.devicePixelRatio = 1.0;
  tester.view.physicalSize = const Size(400, 800);
  tester.view.viewInsets = FakeViewPadding.zero;
  tester.view.viewPadding = const FakeViewPadding(top: 24, bottom: 48);
  tester.view.padding = const FakeViewPadding(top: 24, bottom: 48);
  addTearDown(tester.view.reset);
}

testWidgets('bare Scaffold body is not inset from the nav bar', (t) async {
  setNavBarView(t);
  await t.pumpWidget(MaterialApp(
    home: Scaffold(
      body: Align(
        alignment: Alignment.bottomCenter,
        child: SizedBox(key: const Key('marker'), height: 10, width: 10),
      ),
    ),
  ));
  print('BODY_BOTTOM=${t.getRect(find.byKey(const Key('marker'))).bottom}');
});
```

Das gibt `BODY_BOTTOM=800.0` aus. Die Unterkante des Markers liegt bei 800, ganz unten am Display, das heißt seine unteren 48 logischen Pixel liegen unter der Navigationsleiste. `Scaffold.body` erhält das gesamte Fenster und unternimmt nichts, um sein Kind zu schützen. Das ist der ganze Fehler, und er funktioniert wie entworfen.

## Die Lösung in vier Schritten

1. Lassen Sie Edge-to-Edge aktiviert und suchen Sie nicht länger nach einem Schalter zum Abschalten. Unter API 36 gibt es keinen unterstützten Weg, es abzuschalten, also ist Zeit für die Abmeldung Zeit für etwas, das Sie wieder entfernen müssen.

    ```dart
    // Flutter 3.44.2: nothing to add. edgeToEdge is already the default.
    ```

2. Umschließen Sie oben und unten verankerte Inhalte mit `SafeArea`. Das ist das richtige Werkzeug für Inhalte, die nie unter einer Leiste liegen dürfen: untere Button-Zeilen, eigene Toolbars, schwebende Panels, alles, was mit `Align` oder `Positioned` platziert wird.

    ```dart
    // Flutter 3.44.2
    Scaffold(
      body: SafeArea(
        child: Align(
          alignment: Alignment.bottomCenter,
          child: ElevatedButton(onPressed: _submit, child: const Text('Save')),
        ),
      ),
    )
    ```

3. Geben Sie Scrollables ein Padding, statt sie zu umschließen. Eine `ListView` innerhalb einer `SafeArea` bekommt einen Viewport, der über der Navigationsleiste endet, der Inhalt wird also an einer harten Kante beschnitten und die durchscheinende Leiste zeigt leeren Hintergrund. Übergeben Sie das Inset stattdessen als Listen-Padding: Der Viewport bleibt randlos, und der Inhalt scrollt unter der Leiste durch, kommt aber trotzdem darüber zum Stehen.

    ```dart
    // Flutter 3.44.2
    ListView(
      padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom),
      children: rows,
    )
    ```

4. Prüfen Sie mit einem Widget-Test statt mit dem Auge und verwenden Sie den `setNavBarView`-Helper von oben wieder. Gerätespezifische Leistenhöhen sind genau die Art von Sache, die auf einem Telefon, das Sie nicht besitzen, still regrediert.

Der Unterschied in Schritt 3 ist messbar. Mit einer `ListView` innerhalb von `SafeArea` misst die Unterkante des Scrollable-Viewports 752.0, der Viewport selbst bleibt also 48 hinter dem Fenster zurück. Beim Padding-Ansatz liegt die Unterkante des Viewports bei 800.0 (randlos, der Inhalt scrollt sichtbar unter der durchscheinenden Leiste), während die Unterkante der letzten Zeile bei 752.0 landet und damit exakt 48 logische Pixel Abstand ergibt. Gleicher Abstand für den Inhalt, korrektes Verhalten beim Scrollen.

## Materials eigene untere Widgets erledigen das bereits, Ihre nicht

Die häufigste verlorene Stunde besteht hier darin, Padding hinzuzufügen, das Material bereits hinzugefügt hat, und sich dann zu fragen, warum der Abstand doppelt wirkt. `Scaffold` setzt einige seiner Slots tatsächlich ab, aber nur für Widgets, die das anfordern. Jeder Slot gegen dieselbe simulierte 48dp-Navigationsleiste gemessen:

| Widget | Gerenderte Höhe | Oberkante | Ergebnis |
| --- | --- | --- | --- |
| `SizedBox(height: 56)` als `bottomNavigationBar` | 56.0 | 744.0 | überlappt, kein Abstand |
| `NavigationBar` (2 Ziele) | 128.0 | 672.0 | Icons halten 86.0 Abstand |
| `BottomAppBar` | 128.0 | 672.0 | nimmt das 48dp-Inset auf |
| `FloatingActionButton` | Standard | | Unterkante bei 736.0, Abstand 64.0 |
| `AppBar` | 80.0 | 0.0 | Titeloberkante bei 38.0 |

Lesen Sie die ersten beiden Zeilen zusammen, darin steckt die ganze Lehre. Eine rohe `SizedBox` der Höhe 56 im Slot `bottomNavigationBar` rendert exakt 56 hoch und reicht bis y=800, ihre unteren 48 Pixel liegen also unter der Leiste. Eine echte `NavigationBar` mit einer Nennhöhe von 80 rendert mit 128, also 80 plus das 48dp-Inset, das sie selbst aufgenommen hat. `BottomAppBar` verhält sich genauso. Der `FloatingActionButton` endet bei 736 und lässt 64 Abstand: das 48dp-Inset plus Scaffolds übliche 16dp Rand. `AppBar` rendert 80 hoch, also 56dp Toolbar plus 24dp Statusleiste, der obere Bildschirmrand war somit lange vor alldem erledigt.

Daraus folgt die Regel: Materials untere Widgets wachsen um das Inset, eigene Widgets im selben Slot nicht. Wenn Sie eine eigene untere Leiste gebaut haben, gehört Ihnen ihr Padding. Wenn Sie bereits `NavigationBar` verwenden und sie in eine `SafeArea` packen, erhalten Sie 96dp toten Raum und eine Leiste, die kaputt aussieht.

## Die Tastaturfalle, die SafeArea unzuverlässig wirken lässt

Das ist der Teil, der Fehlermeldungen der Art "SafeArea funktioniert, aber nur manchmal" hervorbringt. Es ist nicht unzuverlässig. Es ist `MediaQueryData.padding`, das genau das tut, was es dokumentiert.

Android meldet zwei verwandte Werte. `viewPadding` ist das rohe Inset, das die Systemleisten belegen. `padding` ist dasselbe Inset, bei dem `viewInsets` (die Tastatur) bereits abgezogen und bei null begrenzt wurde. Wenn die Bildschirmtastatur aufgeht, verdeckt sie die Navigationsleiste, das für das Layout maßgebliche untere Inset ist also weg. Gemessen bei einer 300dp hohen Tastatur:

```text
KEYBOARD_UP padding.bottom=0.0 viewPadding.bottom=48.0
```

`SafeArea` liest standardmäßig `padding`, sein unteres Inset fällt also in dem Moment auf null, in dem die Tastatur erscheint, und was Sie unten verankert haben, rutscht um 48 logische Pixel nach unten. Manchmal ist das korrekt, weil die Leiste tatsächlich verdeckt ist. Wenn nicht, hat `SafeArea` ein Flag dafür, und die Implementierung des Frameworks ist ein Zweizeiler:

```dart
// packages/flutter/lib/src/widgets/safe_area.dart, Flutter 3.44.2
EdgeInsets padding = MediaQuery.paddingOf(context);
// Bottom padding has been consumed - i.e. by the keyboard
if (maintainBottomViewPadding) {
  padding = padding.copyWith(bottom: MediaQuery.viewPaddingOf(context).bottom);
}
```

`maintainBottomViewPadding: true` hält den Abstand stabil. Direkt nebeneinander gemessen liefert eine schlichte `SafeArea` bei aufgeklappter Tastatur einen unteren Abstand von 0.0, eine mit dem Flag 48.0. Verwenden Sie es, wenn ein unteres Bedienelement mit der Tastatur animiert und nicht sichtbar springen soll. Das gehört zur selben Problemfamilie wie [ein RenderFlex, der unten überläuft, wenn die Tastatur aufgeht](/de/2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter/), wo die Tastatur die Constraints ändert statt des Paddings.

## Verschachtelte SafeArea verdoppelt das Padding nicht

Gut zu wissen, bevor Sie einen Phantomabstand jagen: `SafeArea` entfernt das aufgenommene Padding aus dem `MediaQuery`, das es an seinen Teilbaum weitergibt. Eine `SafeArea` innerhalb einer `SafeArea` erzeugt einen unteren Abstand von 48.0, nicht von 96.0. Die innere sieht null Padding und fügt nichts hinzu.

Das ist gut für die Komposition, denn Sie können eine `SafeArea` in ein gemeinsames Seiten-Scaffold setzen und jeden Screen seine eigene ergänzen lassen, ohne den ganzen Baum zu prüfen. Für das Debugging ist es schlecht, denn ein falscher Abstand kommt nie von doppelter Verschachtelung. Stimmt Ihr Abstand nicht, liegt die Ursache woanders, meist bei einem eigenen Widget in einem `Scaffold`-Slot wie oben beschrieben.

## Die Abmeldung existiert, läuft aus und kann Sie zum Absturz bringen

Der Vollständigkeit halber, da es bei den meisten Suchen nach diesem Symptom das erste Ergebnis ist. Flutter dokumentiert eine Abmeldung für Apps, die auf SDK 35 zielen: Fügen Sie `android:windowOptOutEdgeToEdgeEnforcement` sowohl zu `LaunchTheme` als auch zu `NormalTheme` in `android/app/src/main/res/values/styles.xml` hinzu, ebenso zur passenden `values-night/styles.xml`.

```xml
<!-- android/app/src/main/res/values/styles.xml -->
<style name="NormalTheme" parent="@android:style/Theme.Light.NoTitleBar">
    <item name="android:windowOptOutEdgeToEdgeEnforcement">true</item>
</style>
```

Drei Gründe, darauf nicht aufzubauen. Erstens hat Android 16 sie abgeschafft: Die Seite zu den Verhaltensänderungen hält fest, dass `R.attr#windowOptOutEdgeToEdgeEnforcement` für Apps mit Ziel API 36 "is deprecated and disabled, and your app can't opt-out of going edge-to-edge." Zweitens setzt Flutter Sie bereits standardmäßig auf `targetSdkVersion = 36`, Sie müssten Ihr Ziel also aktiv herabstufen, damit das Attribut überhaupt eine Bedeutung hat. Drittens warnt Flutters eigener Migrationshinweis, dass die Nutzung der Abmeldung unter Android 16 oder höher "might cause your app to crash," und die vorgeschlagene Abhilfe ist ein versionsspezifisches Ressourcenverzeichnis `your_app/android/app/src/main/res/values-35` mit Styles ohne das Attribut. Das ist echte Ressourcen-Klempnerei im Tausch gegen ein Verhalten, das auf aktuellen Geräten ohnehin verschwunden ist.

Dieselbe Überlegung gilt für `SystemChrome.setEnabledSystemUIMode`. Unter API 36 werden die anderen Modi schlicht nicht beachtet, und das Framework sagt das in der API-Dokumentation zu `SystemUiMode`: Zielt Ihre App auf SDK 36 oder höher, nutzt sie unter Android standardmäßig `edgeToEdge`, und "There is no way to opt out." `leanBack`, `immersive` und `immersiveSticky` werden vom Android-System bei diesem Ziel ignoriert.

## Systemleistenfarben werden jetzt ignoriert, der Kontrast ist automatisch

Ein weiteres Opfer, das eine Nennung verdient, weil es ein anderes Symptom erzeugt: Nichts stürzt ab, Ihre Farbe greift nur nicht. Unter Edge-to-Edge wirken `SystemUiOverlayStyle.statusBarColor` und `SystemUiOverlayStyle.systemNavigationBarColor` nicht. Unter API 35 kommen sie zurück, wenn Sie die Abmeldung nutzen, unter API 36 sind sie dauerhaft weg.

Was weiterhin funktioniert, ist die Icon-Helligkeit. `statusBarIconBrightness` und `systemNavigationBarIconBrightness` steuern, ob die systemeigenen Glyphen hell oder dunkel gerendert werden, und genau das brauchen Sie, wenn der Inhalt hinter der Leiste seinen Ton wechselt:

```dart
// Flutter 3.44.2
AppBar(
  systemOverlayStyle: SystemUiOverlayStyle(
    statusBarIconBrightness:
        MediaQuery.platformBrightnessOf(context) == Brightness.dark
            ? Brightness.light
            : Brightness.dark,
  ),
)
```

Setzen Sie bevorzugt `AppBar.systemOverlayStyle` oder eine `AnnotatedRegion<SystemUiOverlayStyle>`, wenn keine App-Bar vorhanden ist, statt `SystemChrome.setSystemUIOverlayStyle` direkt aufzurufen. Die annotierte Region wird in jedem Frame gegen das getestet, was tatsächlich unter Status- und Navigationsleiste liegt, und bleibt damit korrekt, während der Nutzer scrollt oder navigiert. Eine `AppBar` erzeugt automatisch eine, umschließen Sie eine `AppBar` also nicht mit einer weiteren `AnnotatedRegion`.

Schließlich zeichnet Android seit API 29 einen durchscheinenden Schleier hinter einer transparenten Navigationsleiste, damit die drei Tasten über beliebigem Inhalt lesbar bleiben. Wenn Ihr Design den Kontrast bereits sicherstellt und der Schleier ihn trübt, schaltet `systemNavigationBarContrastEnforced: false` (und `systemStatusBarContrastEnforced` für oben) ihn ab. Geräte mit API 28 oder darunter haben ihn nie angewendet.

Wenn Sie den randlosen Look absichtlich bauen statt ihn zu reparieren, brauchen Sie als Nächstes die physische Rundung des Displays, die Flutter inzwischen [als physische Eckenradien aus MediaQuery liest](/de/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/), damit Ihr Inhalt am Glas beschnitten wird statt an einem geratenen Radius.

## Verwandte Artikel

- [Fix: A RenderFlex overflowed by N pixels on the bottom beim Öffnen der Tastatur in Flutter](/de/2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter/) -- die andere Hälfte der Geschichte um das untere Inset, wo die Tastatur die Constraints ändert statt des Paddings.
- [Flutter 3.44: Den physischen Eckenradius des Bildschirms aus MediaQuery lesen](/de/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/) -- die passende API für randlose Layouts auf abgerundeten Displays.
- [Wie man eine ListView und eine GridView mit Slivern in einer Scroll-Ansicht kombiniert in Flutter](/de/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) -- wo das untere Inset anzuwenden ist, wenn Ihre Scroll-Ansicht ein `CustomScrollView` statt einer `ListView` ist.
- [shrinkWrap vs Expanded vs Slivers für lange Listen in Flutter: Was sollten Sie wählen?](/de/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/) -- das richtige Scrollable wählen, bevor Sie ihm Padding geben.
- [Fix: Google Play lehnt eine Flutter- oder .NET-MAUI-App wegen fehlender Unterstützung für 16-KB-Speicherseiten ab](/de/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) -- eine weitere vom Store getriebene Android-Anforderung, die als Überraschung zur Build-Zeit auftaucht.

## Quellen

- [Set default of SystemUiMode to edge-to-edge](https://docs.flutter.dev/release/breaking-changes/default-systemuimode-edge-to-edge) -- Flutters Migrationsleitfaden, inklusive der Abmelde-Styles und des Hinweises zu `values-35`.
- [Display content edge-to-edge in your app](https://developer.android.com/develop/ui/views/layout/edge-to-edge) -- Androids Aussage zur Durchsetzung ab API 35.
- [Behavior changes: Apps targeting Android 16 or higher](https://developer.android.com/about/versions/16/behavior-changes-16) -- die Abkündigung und Deaktivierung von `windowOptOutEdgeToEdgeEnforcement`.
- [SystemUiMode API documentation](https://api.flutter.dev/flutter/services/SystemUiMode.html) -- Hinweise je Modus dazu, was API 35 und API 36 beachten.
- [Issue 168635: App UI overlaps with 3-button navigation bar on Samsung One UI 7 / Android 15](https://github.com/flutter/flutter/issues/168635) -- die Diskussion, auf die Flutters eigene Dokumentation verweist.
