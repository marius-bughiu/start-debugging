---
title: "So reservieren Sie Platz für ein adaptives AdMob-Banner in Flutter, um Layout-Verschiebungen zu vermeiden"
description: "Das offizielle google_mobile_ads-Beispiel rendert nichts bis onAdLoaded, sodass Ihr Inhalt Sekunden nach dem Erscheinen des Bildschirms um 150 dp springt. Fragen Sie zuerst die verankerte adaptive Größe ab, reservieren Sie sie mit einer SizedBox, speichern Sie die Höhe über App-Starts hinweg und laden Sie erst dann die Anzeige. Gemessen mit Flutter 3.44.8 und google_mobile_ads 9.1.0."
pubDate: 2026-10-05
template: how-to
tags:
  - "flutter"
  - "dart"
  - "admob"
  - "android"
  - "layout"
lang: "de"
translationOf: "2026/10/how-to-reserve-space-for-an-adaptive-admob-banner-in-flutter-to-avoid-layout-shift"
translatedBy: "claude"
translationDate: 2026-10-05
---

**Kurze Antwort:** Die Höhe eines verankerten adaptiven Banners ist bekannt, bevor die Anzeige geladen wird, also reservieren Sie sie. Rufen Sie `AdSize.getLargeAnchoredAdaptiveBannerAdSize(width)` auf, sobald Sie eine Breite ungleich null haben, setzen Sie sofort eine `SizedBox` mit genau dieser Höhe in den Banner-Platz und tauschen Sie das `AdWidget` in die Box ein, wenn `onAdLoaded` auslöst. Speichern Sie die Höhe mit `shared_preferences`, damit schon der erste Frame beim nächsten Kaltstart den Platz enthält, und behalten Sie den Platz bei einem fehlgeschlagenen Ladevorgang bei, statt ihn einzuklappen. Alles Folgende wurde mit Flutter 3.44.8 (Dart 3.12.2) und `google_mobile_ads` 9.1.0 auf einem Android-16-Emulator (API 36) gemessen.

## Warum der Bildschirm springt, wenn das Banner eintrifft

Googles Banner-Anleitung für das Flutter-Plugin lädt die Anzeige und fügt sie erst in `onAdLoaded` zum Baum hinzu. Das Anzeige-Snippet wird durch `if (_bannerAd != null)` geschützt, und die Größe der Box stammt aus `_bannerAd!.size`. Bis der Netzwerk-Roundtrip abgeschlossen ist, ist der Banner-Platz null Pixel hoch. Sobald die Anzeige eintrifft, wächst der Platz, der `Scaffold`-Body schrumpft um denselben Betrag, und alles, was der Nutzer weiter unten betrachtet hat, verschiebt sich.

Diese Verschiebung ist aus zwei Gründen schlimmer als früher:

1. **Große verankerte adaptive Banner sind hoch.** Seit `google_mobile_ads` 8.0.0 ist `getCurrentOrientationAnchoredAdaptiveBannerAdSize` zugunsten von `getLargeAnchoredAdaptiveBannerAdSize` als veraltet markiert. Googles Anleitung beschreibt die große Variante mit "up to 20% of screen height, between 50 and 150 dp". Auf einem typischen Smartphone ist das etwa doppelt so viel wie der frühere Streifen von 50 bis 64 dp.
2. **Die Anzeige trifft spät ein.** Die Anfrage geht nach `MobileAds.instance.initialize()`, einer Anzeigenauktion und einem Creative-Download hinaus. Bei einem Kaltstart dauert das Sekunden, nicht Frames, und genau dann beginnen Nutzer zu lesen oder zu tippen.

## Die Verschiebung messen

Für echte Zahlen habe ich eine Probe-App gebaut: ein `Scaffold`, dessen Body eine `ListView` in einem `LayoutBuilder` ist, der jede Änderung der Body-Höhe protokolliert, mit dem Banner in `bottomNavigationBar`. Der Emulator hatte einen Bildschirm mit 1080x2400 bei 420 dpi, was Flutter als 411,43 x 914,29 logische Pixel sieht. Verwendet wurden die offizielle Test-Anzeigenblock-ID für adaptive Banner `ca-app-pub-3940256099942544/9214589741` und ein Release-Build.

Zuerst die Höhen, die das SDK für verschiedene Breiten zurückgibt (alle Werte in dp):

| Angeforderte Breite | Groß verankert (aktuelle Ausrichtung) | Groß, Querformat | Standard verankert (veraltet) |
|---|---|---|---|
| 320 | 100 | 82 | 50 |
| 360 | 113 | 82 | 56 |
| 411 | 128 | 82 | 64 |
| 412 | 129 | 82 | 64 |
| 600 | 150 | 82 | 77 |
| 800 | 150 | 82 | 90 |

Im Hochformat folgt die große Größe dem auf 320x100 hochskalierten Seitenverhältnis 320x50 und wird bei 150 gekappt. Im Querformat ist sie auf 82 festgelegt, das sind 20 % der Querformat-Höhe von 411 dp. Nichts davon benötigt einen Netzwerkaufruf: Die Größe wird auf dem Gerät berechnet und liegt nach wenigen Millisekunden vor.

Dann der Verlauf der Body-Höhe für das Muster aus dem Tutorial im Vergleich zu einem reservierten Platz:

| Muster | Erster echter Frame | Änderung der Body-Höhe | Zeitpunkt |
|---|---|---|---|
| Nichts rendern bis `onAdLoaded` | 302 ms | 914,29 -> 762,29 | 5338 ms, als die Anzeige geladen wurde |
| Größe reservieren, in `didChangeDependencies` abgerufen | 439 ms | 914,29 -> 762,29 | 448 ms, einen Frame später |
| Größe reservieren, Höhe aus `shared_preferences` wiederhergestellt | 546 ms | 0 -> 762,29 direkt | überhaupt keine Verschiebung |

Der Rückgang um 152 dp setzt sich aus dem 128-dp-Banner und dem 24-dp-Einzug der Gestennavigation zusammen, den `SafeArea` darunter hinzufügt. In der naiven Version geschieht er mehr als fünf Sekunden, nachdem der Bildschirm erschienen ist. Das Reservieren der Größe verlegt ihn auf den Frame direkt nach dem ersten, und das Speichern der Höhe beseitigt ihn.

## Schritt 1: Die Größe abrufen, bevor etwas geladen wird

Die Größenmethoden von `AdSize` sind statisch und asynchron, weil sie den Plattformkanal durchqueren, hängen aber nicht davon ab, dass eine Anzeige geladen ist. Rufen Sie sie auf, sobald `MediaQuery` eine Breite liefert:

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0
@override
void didChangeDependencies() {
  super.didChangeDependencies();
  final size = MediaQuery.sizeOf(context);
  final padding = MediaQuery.paddingOf(context);
  final width = (size.width - padding.left - padding.right).truncate();
  // Android can report a 0x0 window on the very first frame.
  if (width <= 0 || width == _width) return;
  _width = width;
  unawaited(_load(width));
}
```

Die Bedingung `width <= 0` ist keine Dekoration. Im Release-Build lief das erste `build` mit einer `MediaQuery`-Größe von 0x0: Android hatte die Fenstermaße noch nicht geliefert. Sogar `platformDispatcher.implicitView` in `main()` meldete vor `runApp` eine `physicalSize` von 0 und ein `devicePixelRatio` von 1.0. Die Anfrage eines großen verankerten Banners mit Breite 0 lieferte `0x100`, und das Laden dieser Größe schlug mit `LoadAdError(code: 3, ... "Ad request doesn't meet size requirements")` fehl. Der Tutorial-Code sendet seine erste Anfrage aus diesem Frame mit Breite null und ist nur erfolgreich, weil `didChangeDependencies` einen Frame später mit echten Maßen erneut läuft.

Ziehen Sie vor der Abfrage den horizontalen Safe-Area-Abstand ab. Googles Anleitung zu Inline-Adaptive betont ausdrücklich, dass die Breite "should take into account the device width and any safe areas that are applicable", und im Querformat auf einem Smartphone mit Display-Aussparung ist `MediaQuery.paddingOf(context).left` nicht null.

## Schritt 2: Einen Platz bauen, der seine Höhe selbst besitzt

Der Platz ist eine `SizedBox` mit der reservierten Höhe, die immer im Baum ist. Das `AdWidget` kommt erst hinein, nachdem die Anzeige geladen wurde, weil `AdWidget` sonst "AdWidget requires Ad.load to be called before AdWidget is inserted into the tree" wirft.

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0, shared_preferences 2.5.5
class AnchoredBannerSlot extends StatefulWidget {
  const AnchoredBannerSlot({super.key, required this.adUnitId});

  final String adUnitId;

  @override
  State<AnchoredBannerSlot> createState() => _AnchoredBannerSlotState();
}

class _AnchoredBannerSlotState extends State<AnchoredBannerSlot> {
  BannerAd? _ad;
  bool _loaded = false;
  int? _width;
  int? _height;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final size = MediaQuery.sizeOf(context);
    final padding = MediaQuery.paddingOf(context);
    final width = (size.width - padding.left - padding.right).truncate();
    // Android can report a 0x0 window on the very first frame.
    if (width <= 0 || width == _width) return;
    _width = width;
    _height = BannerHeightCache.lookup(width);
    unawaited(_load(width));
  }

  Future<void> _load(int width) async {
    final size = await AdSize.getLargeAnchoredAdaptiveBannerAdSize(width);
    if (!mounted || width != _width || size == null) return;
    BannerHeightCache.remember(width, size.height);

    final previous = _ad;
    setState(() {
      _height = size.height;
      _ad = null;
      _loaded = false;
    });
    await previous?.dispose();
    if (!mounted || width != _width) return;

    final ad = BannerAd(
      adUnitId: widget.adUnitId,
      request: const AdRequest(),
      size: size,
      listener: BannerAdListener(
        onAdLoaded: (ad) {
          if (!mounted || ad != _ad) {
            ad.dispose();
            return;
          }
          setState(() => _loaded = true);
        },
        onAdFailedToLoad: (ad, error) {
          ad.dispose();
          // Keep the reserved height: collapsing now would be a layout shift.
          if (mounted && ad == _ad) setState(() => _ad = null);
        },
      ),
    );
    _ad = ad;
    await ad.load();
  }

  @override
  void dispose() {
    _ad?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final height = _height;
    if (height == null) return const SizedBox.shrink();
    final ad = _ad;
    return SafeArea(
      top: false,
      child: SizedBox(
        height: height.toDouble(),
        child: Center(
          child: _loaded && ad != null
              ? SizedBox(
                  width: ad.size.width.toDouble(),
                  height: ad.size.height.toDouble(),
                  child: AdWidget(ad: ad),
                )
              : null,
        ),
      ),
    );
  }
}
```

Einige Details, auf die es ankommt:

- **`width != _width` nach jedem `await`.** Eine Rotation ändert die Breite, während eine Größenabfrage oder ein `dispose()` noch läuft. Ohne die Prüfung kann eine veraltete Hochformat-Anfrage den Querformat-Platz überschreiben.
- **`ad != _ad` in `onAdLoaded`.** Wenn das Widget bereits zu einer neueren Anfrage weitergezogen ist, wird die verspätete Anzeige verworfen, statt angezeigt zu werden.
- **`SafeArea(top: false)` außerhalb der reservierten Box.** Der Platz sitzt in `bottomNavigationBar`, also muss er den unteren Einzug selbst aufnehmen. Da Edge-to-Edge für Apps mit Ziel Android 15 und höher erzwungen wird, wird dieser Einzug nicht mehr automatisch abgezogen.
- **`Center` um das `AdWidget`.** Auf iOS verlangt die Dokumentation des Plugins für das Widget einen Parent "with a specified width and height", sonst wird die Anzeige womöglich nicht angezeigt. Die innere `SizedBox` gibt ihm genau die angeforderte Größe.

Die Verwendung ist eine Zeile im `Scaffold`:

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0
Scaffold(
  body: const ArticleList(),
  bottomNavigationBar: const AnchoredBannerSlot(
    adUnitId: 'ca-app-pub-3940256099942544/9214589741', // test unit
  ),
);
```

## Schritt 3: Die Höhe speichern, damit der erste Frame stimmt

Schritt 2 hinterlässt beim Kaltstart noch eine Lücke von einem Frame: Der erste Frame mit echter Breite wird gerendert, bevor der Plattformkanal antwortet. In den Messungen betrug diese Lücke 9 bis 70 ms, was meist in die Zeit fällt, in der der erste Inhalt noch gezeichnet wird, aber es ist eine Verschiebung, und sie ist in Bildschirmaufnahmen sichtbar.

Die Lösung: Die verankerte Höhe ist eine reine Funktion von Gerät und Breite. Googles eigene Dokumentation sagt, dass die optimale Höhe "remains constant across different ad requests". Die letzte Antwort des SDK ist also eine perfekte erste Schätzung für den nächsten Start:

```dart
// Flutter 3.44.8, shared_preferences 2.5.5
class BannerHeightCache {
  static const _prefix = 'admob.anchoredHeight.';
  static final Map<int, int> _heights = {};

  static Future<void> restore() async {
    final prefs = await SharedPreferences.getInstance();
    for (final key in prefs.getKeys().where((k) => k.startsWith(_prefix))) {
      final width = int.tryParse(key.substring(_prefix.length));
      final height = prefs.getInt(key);
      if (width != null && height != null) _heights[width] = height;
    }
  }

  static int? lookup(int width) => _heights[width];

  static void remember(int width, int height) {
    if (_heights[width] == height) return;
    _heights[width] = height;
    unawaited(
      SharedPreferences.getInstance()
          .then((prefs) => prefs.setInt('$_prefix$width', height)),
    );
  }
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await BannerHeightCache.restore();
  unawaited(MobileAds.instance.initialize());
  runApp(const MyApp());
}
```

Der Platz liest `BannerHeightCache.lookup(width)` bereits in `didChangeDependencies`, sodass beim zweiten Start der erste echte Frame mit einer 128-dp-Box gebaut wird und der Body direkt von 0 auf seine endgültigen 762,29 dp geht. Die Live-Abfrage läuft trotzdem weiter und überschreibt den zwischengespeicherten Wert, sodass eine falsche Schätzung (neue OS-Version, andere Anzeigegrößen-Einstellung) eine Verschiebung kostet und sich dann selbst korrigiert. Die In-Memory-Map hilft auch innerhalb einer Sitzung: Der zweite Bildschirm, der ein Banner hostet, erhält die Höhe synchron.

Versuchen Sie nicht, die Höhe selbst aus der obigen Tabelle zu berechnen. Das Verhältnis 100/320 und die Obergrenzen sind beobachtetes SDK-Verhalten, kein dokumentierter Vertrag, und Google hat die adaptive Größenberechnung schon früher geändert. Die Antwort des SDK zwischenzuspeichern liefert dieselbe Genauigkeit im ersten Frame, ohne auf eine Formel zu wetten.

## Schritt 4: Entscheiden, was passiert, wenn keine Anzeige zurückkommt

Mit einem reservierten Platz hinterlässt ein fehlgeschlagener Ladevorgang einen leeren Streifen am unteren Rand. Sie haben zwei ehrliche Optionen:

1. **Den Streifen behalten.** Das Layout bewegt sich nie, und die nächste Anfrage (bei Navigation, per Timer oder über die automatische Aktualisierung von AdMob, falls konfiguriert) füllt ihn. Das tut das obige Widget.
2. **Den Streifen einklappen.** Sie erhalten den Platz zurück, zum Preis genau einer Layout-Verschiebung, und Sie müssen vor dem nächsten Versuch erneut reservieren.

Bei einem unten verankerten Banner bevorzuge ich die erste Variante. Nutzer nehmen einen leeren 128-dp-Streifen sehr schnell nicht mehr als "fehlend" wahr, aber sie hören nie auf, eine Liste zu bemerken, die ihnen unter dem Daumen wegspringt. Wenn Sie einklappen, animieren Sie es mit einer `AnimatedSize`, damit die Änderung wenigstens beabsichtigt wirkt.

## Die Testanzeige war kleiner als der Platz

Eine weitere Sache, die die Probe zutage gefördert hat. Nach `onAdLoaded` meldete `BannerAd.getPlatformAdSize()` `411x64` für eine Anzeige, die mit `411x128` angefordert wurde. Das Test-Creative ist ein Banner in Standardhöhe. Die native View zentrierte es innerhalb der 128-dp-Anfrage, und das Rendern des `AdWidget` mit 128 dp oder mit der Plattformgröße sah identisch aus. Verkleinern Sie den Platz nach dem Laden nicht auf die Plattformgröße: Das wäre eine Layout-Verschiebung in die andere Richtung, und die nächste Aktualisierung liefert möglicherweise ein Creative in voller Höhe.

## Inline-adaptive Banner in scrollenden Inhalten

Inline-adaptive Banner sind die andere adaptive Familie, gedacht für die Platzierung innerhalb eines Feeds. Ihre Höhe wird vom Server gewählt, daher liefert `AdSize.getCurrentOrientationInlineAdaptiveBannerAdSize(width)` eine Größe mit Höhe 0, und die echte Höhe erfahren Sie erst nach dem Laden aus `getPlatformAdSize()`. Googles Beispiel löst das, indem es bis zum Laden einen leeren `Container()` rendert und dann die Box dimensioniert, was jedes darunterliegende Element verschiebt.

Eine unbekannte Höhe lässt sich nicht reservieren, aber man kann sie begrenzen. Verwenden Sie `AdSize.getInlineAdaptiveBannerAdSize(width, maxHeight)` und reservieren Sie `maxHeight`:

```dart
// Flutter 3.44.8, google_mobile_ads 9.1.0
class InlineBannerSlot extends StatefulWidget {
  const InlineBannerSlot({super.key, required this.adUnitId, this.maxHeight = 250});

  final String adUnitId;
  final int maxHeight;

  @override
  State<InlineBannerSlot> createState() => _InlineBannerSlotState();
}

class _InlineBannerSlotState extends State<InlineBannerSlot> {
  BannerAd? _ad;
  AdSize? _platformSize;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_ad != null) return;
    final width = MediaQuery.sizeOf(context).width.truncate();
    if (width <= 0) return;
    _ad = BannerAd(
      adUnitId: widget.adUnitId,
      request: const AdRequest(),
      size: AdSize.getInlineAdaptiveBannerAdSize(width, widget.maxHeight),
      listener: BannerAdListener(
        onAdLoaded: (ad) async {
          final size = await (ad as BannerAd).getPlatformAdSize();
          if (mounted) setState(() => _platformSize = size);
        },
        onAdFailedToLoad: (ad, error) => ad.dispose(),
      ),
    )..load();
  }

  @override
  void dispose() {
    _ad?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ad = _ad;
    final size = _platformSize;
    return SizedBox(
      height: widget.maxHeight.toDouble(),
      child: Center(
        child: ad != null && size != null
            ? SizedBox(
                width: size.width.toDouble(),
                height: size.height.toDouble(),
                child: AdWidget(ad: ad),
              )
            : null,
      ),
    );
  }
}
```

Der Kompromiss ist Letterboxing, wenn das Creative niedriger ist als `maxHeight`. Wenn das in Ihrem Design falsch aussieht, besteht die Alternative darin, die Anfrage lange vor dem Hineinscrollen des Elements zu starten (eine `ListView` baut Elemente innerhalb von `cacheExtent` des Viewports, standardmäßig 250 Pixel) und in Kauf zu nehmen, dass eine Verschiebung oberhalb des Viewports die Scroll-Position bewegt. Google warnt außerdem, dass Inline-Banner in Scroll-Views unter Android 9 und darunter schlecht performen können, während verankerte Banner davon unberührt sind.

## Stolperfallen

- **Ein `BannerAd`, ein `AdWidget`.** Die Wiederverwendung eines Anzeigenobjekts an zwei Stellen wirft "This AdWidget is already in the Widget tree". Jeder Platz besitzt seine eigene Anzeige.
- **`getLargeAnchoredAdaptiveBannerAdSize` kann `null` zurückgeben.** Das Plugin gibt `null` zurück, wenn das SDK für das Fenster keine Höhe finden kann. Der Platz rendert dann nichts, was dem Nicht-Anzeigen einer Anzeige entspricht.
- **Verwenden Sie die veralteten Größen nicht, um "Platz zu sparen".** `getCurrentOrientationAnchoredAdaptiveBannerAdSize` funktioniert in 9.1.0 noch und liefert bei 411 dp Breite 64 dp statt 128, ist aber veraltet, und das große Format ist das, worauf Google optimiert.
- **Orientierungswechsel sind eine neue Anfrage.** Die Breite ändert sich, der Platz reserviert sofort die neue Höhe (Querformat sind auf diesem Gerät 82 dp), und dafür wird eine neue Anzeige geladen. Diese Verschiebung wird von der Rotation selbst verursacht und ist daher erwartbar.
- **Hot Reload verbirgt den Fehler im ersten Frame.** Der Frame mit Breite null tritt nur bei einem Kaltstart auf. Testen Sie den reservierten Platz mit `flutter run --release` nach einem Force-Stopp, nicht nach einem Hot Restart.
- **Ein Release-Build kann abstürzen, bevor Ihr Anzeigencode läuft.** In der Probe entfernte R8 `androidx.work.impl.WorkDatabase`, das das Ads-SDK über WorkManager mitbringt, und die App starb mit "Failed to create an instance of androidx.work.impl.WorkDatabase". Das Deaktivieren der Minifizierung (`isMinifyEnabled = false`) behob das in der Probe; eine ProGuard-Keep-Regel für die WorkManager-Datenbankklassen ist die gezieltere Lösung. Wenn Ihr Release-Build abstürzt und der Debug-Build nicht, prüfen Sie `adb logcat`, bevor Sie dem Banner-Code die Schuld geben.

Wenn Sie Banner auch aus .NET MAUI betreiben, gilt dieselbe Überlegung dort: Die [MAUI-AdMob-Anleitung für Banner, Interstitials und Rewarded Ads](/2026/07/monetize-a-net-maui-app-with-admob-banner-interstitial-rewarded/) verwendet die nativen Views, die dieselben APIs zur Größenbestimmung vor dem Laden besitzen.

## Verwandte Artikel

- [Fix: Flutter UI overlaps the Android system navigation bar after targeting SDK 35](/de/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) erklärt den unteren Einzug, den der Banner-Platz aufnehmen muss.
- [How to use BuildContext safely after an await in Flutter](/de/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) behandelt die `mounted`-Prüfungen, die der Platz nach jedem asynchronen Schritt durchführt.
- [How to profile jank in a Flutter app with DevTools](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) hilft Ihnen zu bestätigen, dass die Platform View Sie nicht Frames kostet, sobald das Banner eingebunden ist.
- [Monetize a .NET MAUI app with AdMob banners, interstitials and rewarded ads](/2026/07/monetize-a-net-maui-app-with-admob-banner-interstitial-rewarded/) ist die MAUI-Seite desselben AdMob-Setups.

## Quellen

- [Set up banner ads (Flutter)](https://developers.google.com/admob/flutter/banner) für die große verankerte adaptive Größenbestimmung, die Test-Anzeigenblock-IDs und den iOS-Größenhinweis.
- [Use inline adaptive for scrolling banners (Flutter)](https://developers.google.com/admob/flutter/banner/inline-adaptive) für `getInlineAdaptiveBannerAdSize` und `getPlatformAdSize`.
- [Set up banner ads (Android)](https://developers.google.com/admob/android/banner/anchored-adaptive) für den Bereich von 50 bis 150 dp bzw. 20 % der Bildschirmhöhe bei großen adaptiven Bannern.
- [google_mobile_ads on pub.dev](https://pub.dev/packages/google_mobile_ads) und das zugehörige [Changelog](https://pub.dev/packages/google_mobile_ads/changelog), einschließlich der Veraltungen in 8.0.0.
- [shared_preferences on pub.dev](https://pub.dev/packages/shared_preferences).
