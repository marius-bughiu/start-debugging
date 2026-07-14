---
title: "So fügen Sie eine Hero-Animation zwischen zwei Bildschirmen in Flutter hinzu"
description: "Umschließen Sie dasselbe Widget auf beiden Routen mit einem Hero mit identischem tag, und Flutter animiert seine Position und Größe während der Navigation. Vollständige Anleitung: Bilder, flightShuttleBuilder, createRectTween, RectTween-Bögen, Gesten-Übergänge und die tag-Kollisionen, die alles brechen. Getestet mit Flutter 3.44, Dart 3.12."
pubDate: 2026-07-14
tags:
  - "flutter"
  - "dart"
  - "animation"
  - "navigation"
  - "how-to"
lang: "de"
translationOf: "2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-14
---

Kurze Antwort: Umschließen Sie das zu animierende Widget auf dem ersten Bildschirm mit einem `Hero`, umschließen Sie das Ziel-Widget mit einem zweiten `Hero` mit demselben `tag` und pushen Sie die Zielroute mit dem normalen `Navigator`. Flutters `HeroController` (standardmäßig in `MaterialApp` und `CupertinoApp` installiert) findet die beiden Heroes mit dem übereinstimmenden tag während des Routenübergangs, hebt den Quell-Hero in ein Overlay und interpoliert seine Position und Größe, bis er auf dem Ziel landet. Für den Basisfall schreiben Sie keinen `AnimationController`, keinen `Tween` und keine explizite Dauer. Verifiziert mit Flutter 3.44, Dart 3.12.

Das ist der ganze Trick, und es sind wirklich zwei `Hero`-Widgets und ein `Navigator.push`. Der Rest dieser Anleitung ist der Teil, über den Menschen stolpern: die tag-Regeln, das Animieren eines Bildes oder eines `Icon`, das zwischen den Bildschirmen die Form ändert, das Anpassen des Flug-Widgets, damit es nicht zwischen Themes flackert, das Krümmen der Flugbahn und die Handvoll Fehler, die einen flüssigen Übergang in einen harten Sprung verwandeln.

## Das minimale funktionierende Beispiel

Zwei Bildschirme. Eine farbige Box auf dem ersten, dieselbe Box größer auf dem zweiten. Die Box fliegt zwischen ihnen.

```dart
// Flutter 3.44, Dart 3.12
import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(home: FirstScreen());
  }
}

class FirstScreen extends StatelessWidget {
  const FirstScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('First')),
      body: Center(
        child: GestureDetector(
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const SecondScreen()),
          ),
          child: Hero(
            tag: 'box-hero',
            child: Container(width: 80, height: 80, color: Colors.indigo),
          ),
        ),
      ),
    );
  }
}

class SecondScreen extends StatelessWidget {
  const SecondScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Second')),
      body: Center(
        child: Hero(
          tag: 'box-hero',
          child: Container(width: 240, height: 240, color: Colors.indigo),
        ),
      ),
    );
  }
}
```

Tippen Sie auf die kleine Box, und sie wächst und gleitet in die Mitte des zweiten Bildschirms. Tippen Sie auf Zurück, und sie kehrt um. Der `tag`-String `'box-hero'` ist die gesamte Bindung zwischen den beiden Widgets. Unterscheiden sich die tags um ein einziges Zeichen, wird nichts animiert, und beide Boxen erscheinen und verschwinden einfach normal.

## Warum übereinstimmende tags der ganze Mechanismus sind

`Hero` hält keine Referenz auf sein Gegenstück. Stattdessen durchläuft der `HeroController` in dem Moment, in dem ein Routenübergang startet, den Widget-Baum der ausgehenden und der eingehenden Route und baut eine Zuordnung von tag zu Hero auf. Für jeden tag, der auf **beiden** Routen vorhanden ist, startet er einen "Flug": Der Quell-Hero wird aus seiner normalen Position entfernt (ein `placeholderBuilder` füllt die Lücke, standardmäßig leer), eine Kopie wird in den Overlay-`Stack` des `Navigator` platziert, und diese Kopie wird vom Quell-`Rect` zum Ziel-`Rect` animiert, wobei die eigene Übergangsanimation der Route als Taktgeber dient.

Aus diesem Design ergeben sich zwei Konsequenzen, und beide sind die Quelle der meisten Hero-Bugs:

1. **Ein tag muss innerhalb einer einzelnen Route eindeutig sein.** Hat ein Bildschirm zwei `Hero`-Widgets mit `tag: 'box-hero'`, kann Flutter nicht entscheiden, welches fliegen soll, und wirft `There are multiple heroes that share the same tag within a subtree`. Das trifft am härtesten, wenn Sie einen `Hero` in ein `ListView`-Element setzen und jedem Element denselben literalen tag geben. Verwenden Sie die id des Elements: `tag: 'photo-${photo.id}'`.
2. **Der Hero muss im ersten Frame der Zielroute existieren.** Der Controller inspiziert die Zielroute, während sie aufgebaut wird. Steht Ihr Ziel-Hero hinter einem `FutureBuilder`, der noch nicht aufgelöst hat, innerhalb eines `Offstage` oder gesperrt durch ein `if`, das beim ersten Build falsch ist, gibt es kein Ziel-`Rect`, zu dem geflogen werden kann, und die Animation wird stillschweigend übersprungen.

## Ein Bild oder Icon animieren, das die Form ändert

Der häufigste reale Einsatz ist ein Thumbnail, das sich zu einem bildschirmfüllenden Header ausdehnt. Das child muss auf beiden Routen nicht identisch sein, nur identisch getaggt. Hier ist die Quelle ein abgerundetes 80x80-Thumbnail und das Ziel ein Bild über die volle Breite.

```dart
// Flutter 3.44, Dart 3.12
// Source: a grid thumbnail
Hero(
  tag: 'photo-${photo.id}',
  child: ClipRRect(
    borderRadius: BorderRadius.circular(12),
    child: Image.network(photo.url, width: 80, height: 80, fit: BoxFit.cover),
  ),
);

// Destination: a full-width header
Hero(
  tag: 'photo-${photo.id}',
  child: Image.network(
    photo.url,
    width: double.infinity,
    height: 300,
    fit: BoxFit.cover,
  ),
);
```

Zwei Dinge sind zu beachten, wenn das child eine `Image` ist. Erstens: Verwenden Sie dieselbe Bild-`url` (idealerweise denselben `ImageProvider` im Speicher) auf beiden Routen, damit der Netzwerk-Abruf bereits im Cache liegt und der Flug keinen halb geladenen Frame zeigt. Zweitens: Ein abweichendes `BoxFit` oder ein `ClipRRect` auf nur einer Seite erzeugt einen sichtbaren Sprung, wenn der Eckenradius oder der Zuschnitt am Ende des Flugs schlagartig einrastet. Wenn die abgerundeten Ecken wichtig sind, umschließen Sie beide Seiten mit demselben `ClipRRect`, oder verwenden Sie einen `flightShuttleBuilder` (weiter unten), um den Radius zu interpolieren.

Für ein `Icon` oder einen gestylten `Text` gilt dieselbe Regel: Das Framework interpoliert das begrenzende `Rect` und skaliert das Rendering des Quell-child, damit es während des Flugs in dieses Rect passt. Ein 24px-Icon, das zu einem 96px-Icon fliegt, sieht korrekt aus, weil das child skaliert und nicht mitten im Flug neu ausgelegt wird.

## Das Flug-Widget mit flightShuttleBuilder anpassen

Standardmäßig zeigt der Flug das child des Ziel-Hero, skaliert. Dieses Standardverhalten bricht in zwei Situationen: wenn das child ein `InheritedWidget` liest (ein `Theme`, `DefaultTextStyle` oder `MediaQuery`), das sich zwischen den beiden Routen unterscheidet, und wenn Sie möchten, dass sich das Widget während des Flugs sichtbar verwandelt, nicht nur skaliert. `flightShuttleBuilder` gibt Ihnen volle Kontrolle darüber, was gerendert wird, während der Hero in der Luft ist.

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'photo-${photo.id}',
  flightShuttleBuilder: (
    flightContext,
    animation,
    flightDirection,
    fromHeroContext,
    toHeroContext,
  ) {
    // Render the destination hero's widget, but wrapped in the
    // destination route's Material so text/icon theming is stable.
    return DefaultTextStyle(
      style: DefaultTextStyle.of(toHeroContext).style,
      child: toHeroContext.widget as Hero,
    );
  },
  child: Text(photo.title, style: Theme.of(context).textTheme.titleLarge),
);
```

Das Argument `flightDirection` ist `HeroFlightDirection.push` oder `HeroFlightDirection.pop`, sodass Sie beim Hin- und beim Rückweg ein anderes shuttle rendern können. Die `animation` ist die `Animation<double>` des Flugs von 0 bis 1; verwenden Sie sie für eine Überblendung oder um einen `BorderRadius` zu interpolieren, wenn Sie möchten, dass sich die Ecken sanft abrunden, statt zu springen. Das ist die richtige Lösung für das Problem "abgerundete Ecken springen am Ende": Steuern Sie den Radius aus `animation.value` innerhalb des shuttle.

## Die Flugbahn mit createRectTween krümmen

Standardmäßig bewegt sich der Hero in gerader Linie zwischen den beiden Rects, und seine Größe wird linear interpoliert. Materials eigene Detail-Übergänge verwenden oft einen **Bogen**: Das Widget folgt einer gekrümmten Bahn, was sich für eine Karte, die sich zu einer Seite ausdehnt, natürlicher liest. Flutter liefert `MaterialRectArcTween` genau dafür, und Sie aktivieren es pro Hero mit `createRectTween`.

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'box-hero',
  createRectTween: (begin, end) {
    return MaterialRectArcTween(begin: begin, end: end);
  },
  child: const SizedBox(width: 80, height: 80),
);
```

`createRectTween` läuft auf dem Hero, der das Ziel des Flugs ist. Wenn Sie den Bogen sowohl beim push als auch beim pop möchten, setzen Sie ihn auf den Heroes beider Routen. Der Standard ist ein einfacher `RectTween` (linear). `MaterialRectArcTween` krümmt die obere linke und die untere rechte Ecke entlang von Bögen, weshalb eine sich ausdehnende Karte ins Ziel zu "schwenken" scheint, statt diagonal zu schießen. Ab Flutter 3.44 können Sie auch eine Kurve direkt über die Route an den Übergang übergeben, aber `createRectTween` bleibt der Weg, die geometrische Bahn zu formen, statt das Timing.

## Die iOS-Zurück-Geste den Hero animieren lassen

Auf einer `CupertinoPageRoute` (oder einer `MaterialPageRoute` unter iOS) kann der Benutzer vom linken Rand ziehen, um die Route zu poppen. Standardmäßig fliegt der Hero während dieses interaktiven Ziehens **nicht**; er fliegt nur bei einem bestätigten pop. Setzen Sie `transitionOnUserGestures: true` auf beiden Heroes, damit das geteilte Element dem Ziehen folgt.

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'box-hero',
  transitionOnUserGestures: true,
  child: Container(width: 80, height: 80, color: Colors.indigo),
);
```

Setzen Sie es sowohl auf dem Quell- als auch auf dem Ziel-Hero. Setzen Sie es nur auf einem, animiert der push, aber der interaktive pop nicht, was sich inkonsistent anfühlt. Das ist günstig hinzuzufügen, und es gibt selten einen Grund, es bei einem echten Paar geteilter Elemente ausgeschaltet zu lassen.

## Hero-Animation mit go_router und anderen Routern

Nichts an `Hero` ist an das imperative `Navigator.push` gebunden. Die Animation wird vom Routenübergang gesteuert, sie funktioniert also unter `go_router`, `auto_route` oder jedem Router, der auf `Navigator` 2.0 aufbaut, gleich, solange die Zielseite eine übergangsfähige Seite verwendet (`MaterialPage`, `CupertinoPage` oder eine `CustomTransitionPage`). Geben Sie den beiden Widgets denselben tag und navigieren Sie, wie Ihre App es normalerweise tut:

```dart
// Flutter 3.44, Dart 3.12, go_router 14.x
GoRoute(
  path: '/photo/:id',
  builder: (context, state) => PhotoDetailScreen(id: state.pathParameters['id']!),
);

// Trigger it from the grid:
onTap: () => context.go('/photo/${photo.id}'),
```

Ein Vorbehalt bei deklarativen Routern: Wenn Sie eine `CustomTransitionPage` mit Dauer null oder eine `NoTransitionPage` verwenden, gibt es keine Übergangsanimation, die der `HeroController` steuern könnte, sodass der Hero nicht fliegt. Behalten Sie einen echten Übergang (auch nur ein kurzes Fade) auf jeder Route, auf der Sie eine Animation geteilter Elemente möchten. Für einen tieferen Vergleich der Router selbst siehe die Notizen zu [verschachtelten Routen und Deep Links mit go_router](/de/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) und die Aufschlüsselung von [go_router vs. auto_route vs. Navigator 2.0](/de/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/).

## Die Fehler, die Hero-Animationen brechen

Dies sind die Fehlschläge, die in Bug-Reports auftauchen, geordnet danach, wie viel Suchverkehr sie anziehen.

1. **`There are multiple heroes that share the same tag within a subtree`.** Zwei Heroes auf derselben Route teilen sich einen tag. Fast immer eine Liste, in der jedes Element einen konstanten tag verwendet hat. Lösung: Leiten Sie den tag aus einem eindeutigen Schlüssel wie `'item-${item.id}'` ab. Wenn Sie tatsächlich dasselbe Bild zweimal auf dem Bildschirm brauchen, kann nur eines davon am Flug teilnehmen; geben Sie den anderen unterschiedliche tags oder gar keinen `Hero`.
2. **Der Hero erscheint einfach, ohne Flug.** Der Ziel-Hero ist im ersten Frame nicht vorhanden. Er steht hinter einem nicht aufgelösten `FutureBuilder`, innerhalb eines `Offstage` oder gesperrt durch ein Flag, das beim ersten Build falsch ist. Stellen Sie sicher, dass das getaggte Widget sofort im Baum ist, auch wenn seine Daten später laden, damit es ein Rect zum Hinfliegen gibt. Eine verwandte Falle ist, diesen `Future` innerhalb von `build` zu initialisieren, was ihn bei jedem Rebuild neu erzeugt; siehe [einen Future so initialisieren, dass der FutureBuilder ihn nicht neu erzeugt](/de/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).
3. **Das child springt oder flackert am Ende des Flugs.** Abweichendes `BoxFit`, `ClipRRect`-Radius oder ein von einem `InheritedWidget` abhängiger Stil zwischen den beiden Routen. Beheben Sie es mit einem `flightShuttleBuilder`, der ein stabiles Widget rendert und die abweichende Eigenschaft aus `animation.value` interpoliert.
4. **`Navigator.pop` wirft oder der Zurück-Pfeil tut nichts.** Das ist kein Hero-Problem, sieht aber wie eines aus, weil es auf dem Bildschirm mit dem Hero passiert. Bestätigen Sie, dass die Route mit einem `Navigator` gepusht wurde, der einen `HeroController` besitzt. Benutzerdefinierte verschachtelte `Navigator`s brauchen ihren eigenen `HeroController` in `observers`, sonst fliegen Heroes nicht zwischen ihnen.
5. **Das Layout springt, weil der Hero eine unbegrenzte Größe hat.** Ein `Hero`, der einen `Text` oder eine `Row` innerhalb einer `Column` umschließt, kann während des Flugs in eine Situation unbegrenzter Breite geraten, wenn er in den Overlay-`Stack` gehoben wird. Umschließen Sie das Hero-child mit einem `Material` mit `type: MaterialType.transparency`, oder geben Sie ihm explizite Constraints. Wenn Sie allgemeiner auf Fehler unbegrenzter Höhe stoßen, ist das Muster dieselbe Familie von Layout-Bugs, die in [einen ListView in einer Column verschachteln](/de/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) behandelt wird.

## Text braucht während des Flugs einen Material-Vorfahren

Ein subtiler, der seine eigene Notiz verdient: Während ein Hero im Flug ist, lebt er im Overlay des `Navigator`, getrennt vom `Scaffold` und seinem `Material`. `Text` und `Ink`-basierte Widgets suchen einen `Material`-Vorfahren für ihren Standard-Textstil und ihre Ink-Splashes. Während des Flugs finden sie ihn möglicherweise nicht, sodass gestylter Text für einen Frame mit dem Standard-Debug-Stil (schwarze Unterstreichung) rendern kann. Umschließen Sie das Flug-child mit einem `Material`:

```dart
// Flutter 3.44, Dart 3.12
Hero(
  tag: 'title-hero',
  flightShuttleBuilder: (ctx, anim, dir, fromCtx, toCtx) {
    return Material(
      type: MaterialType.transparency,
      child: toCtx.widget,
    );
  },
  child: Material(
    type: MaterialType.transparency,
    child: Text('Details', style: Theme.of(context).textTheme.headlineSmall),
  ),
);
```

`MaterialType.transparency` gibt dem Text einen `Material`-Vorfahren, um seinen Stil aufzulösen, ohne einen Hintergrund zu zeichnen, was den Flug visuell sauber hält.

## Wann Sie keinen Hero verwenden sollten

Ein `Hero` ist das richtige Werkzeug, wenn dasselbe *konzeptionelle Element* auf beiden Bildschirmen existiert: ein Thumbnail, das zu einem Header wird, ein Avatar, der zu einem Profilfoto wird, eine Karte, die zu einer Detailseite wird. Es ist das falsche Werkzeug für dekorative Bewegung, bei der nichts geteilt wird. Wenn Sie möchten, dass die ganze Seite gleitet, überblendet oder skaliert, ist das ein `transitionsBuilder` der Route (oder ein `PageRouteBuilder`), kein `Hero`. Wenn Sie möchten, dass sich ein Widget *innerhalb* eines Bildschirms animiert, greifen Sie zu `AnimatedContainer`, `AnimatedPositioned` oder einem expliziten `AnimationController`. Hero besitzt speziell den Fall geteilter Elemente über Routen hinweg, und es für etwas anderes zu verwenden, kämpft gegen das Framework.

Für umfassendere Flutter-Performance- und UI-Arbeit, die oft zusammen mit dem Hinzufügen von Übergängen auftaucht, decken die Anleitungen zu [Jank mit DevTools profilen](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) und [eine Akzentfarbe mit Material 3 ColorScheme festlegen](/de/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) die beiden Dinge ab, die man üblicherweise gleich poliert, nachdem sich die Navigation gut anfühlt: das Frame-Budget und das Theming.

## Quellen

- Flutter API: [`Hero`-Klasse](https://api.flutter.dev/flutter/widgets/Hero-class.html)
- Flutter-Doku: [Hero animations](https://docs.flutter.dev/ui/animations/hero-animations)
- Flutter-Cookbook: [Animate a widget across screens](https://docs.flutter.dev/cookbook/navigation/hero-animations)
- Flutter API: [`MaterialRectArcTween`](https://api.flutter.dev/flutter/material/MaterialRectArcTween-class.html)
- Flutter API: [`HeroController`](https://api.flutter.dev/flutter/widgets/HeroController-class.html)
