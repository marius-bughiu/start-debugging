---
title: "Eigene Seitenübergänge nach der Neuorganisation der Flutter Page Transition Builders migrieren (Flutter 3.44 bis 3.47)"
description: "Flutter hat PageTransitionsBuilder und zwei eingebaute Builder in die Widgets-Schicht verschoben und CupertinoPageTransitionsBuilder aus Material herausgelöst. Was tatsächlich bricht (ein Import, mit der irreführenden Fehlermeldung 'Not a constant expression'), was dart fix leistet und bei material_ui-Projekten falsch macht, und wie Sie eigene Builder und Routen so umschreiben, dass sie überhaupt nicht mehr von Material abhängen."
pubDate: 2026-10-08
updatedDate: 2026-10-08
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "navigation"
  - "cupertino"
lang: "de"
translationOf: "2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization"
translatedBy: "claude"
translationDate: 2026-10-08
---

Für die meisten Apps ist das eine Migration von fünf Minuten mit genau einer inkompatiblen Änderung im Quellcode: Seit Flutter 3.44 liegt `CupertinoPageTransitionsBuilder` in der Cupertino-Bibliothek. Jede Datei, die nur `package:flutter/material.dart` (oder `package:material_ui/material_ui.dart`) importiert und diesen Builder in ein `PageTransitionsTheme` einträgt, lässt sich deshalb nicht mehr kompilieren. Fügen Sie den Cupertino-Import hinzu, und die Sache ist erledigt. Der Rest der Neuorganisation, bei der die Basisklasse `PageTransitionsBuilder` sowie `FadeUpwardsPageTransitionsBuilder` und `OpenUpwardsPageTransitionsBuilder` in Flutter 3.38 und 3.41 nach `package:flutter/widgets.dart` verschoben wurden, ist nicht inkompatibel, aber genau dieser Teil lohnt sich: Ihre eigenen Builder können ihre Material-Abhängigkeit komplett abwerfen, und nur so funktionieren sie weiter, wenn Sie auf die eigenständigen Design-Pakete umsteigen. Alles Folgende wurde mit Flutter 3.44.8 und Dart 3.12.2 kompiliert und getestet und gegen die aktuelle Stable-Version Flutter 3.47.6 mit [`material_ui`](https://pub.dev/packages/material_ui) 1.6.0 und [`cupertino_ui`](https://pub.dev/packages/cupertino_ui) 1.1.2 geprüft.

## Warum die Builder verschoben wurden

`PageTransitionsBuilder` war ursprünglich eine Material-Klasse, weil `PageTransitionsTheme` und `MaterialPageRoute` ihre einzigen Verbraucher waren. Für eine Cupertino-App oder ein Team mit eigenem, auf `WidgetsApp` aufgebautem Designsystem ergab das keinen Sinn: Um ein Übergangsobjekt wiederzuverwenden, musste man Material importieren. Flutters [Issue #172929](https://github.com/flutter/flutter/issues/172929) ("Move platform specific page transitions outside of Material and Cupertino") hat diese Entflechtung verfolgt, als Teil des größeren Vorhabens, Material und Cupertino als getrennte Pakete auszuliefern.

Die konkreten Ergebnisse:

- **Eigene Builder brauchen kein Material mehr.** Eine Unterklasse von `PageTransitionsBuilder` kann ausschließlich `package:flutter/widgets.dart` importieren und von einer handgeschriebenen `PageRoute`, einer `WidgetsApp`, einer `CupertinoApp` oder von `PageTransitionsTheme` verwendet werden.
- **Cupertino-Apps erhalten den iOS-Builder, ohne Material einzubinden.** `CupertinoPageTransitionsBuilder` steht jetzt neben `CupertinoPageRoute` in `cupertino/route.dart`.
- **Builder überstehen die Migration zu `material_ui`.** Da die Basisklasse in der Widgets-Schicht liegt, die das SDK nicht verlässt, ist ein gegen `widgets.dart` geschriebener Builder derselbe Typ für das `PageTransitionsTheme` im SDK und für das in `material_ui`.

## Was bricht

| Bereich | Änderung | In Stable seit | Schweregrad |
| ------- | -------- | -------------- | ----------- |
| `PageTransitionsBuilder` | Von Material nach `widgets.dart` verschoben ([PR #174321](https://github.com/flutter/flutter/pull/174321)) | 3.38 | keiner, Material exportiert Widgets erneut |
| `FadeUpwardsPageTransitionsBuilder` | Nach `widgets.dart` verschoben ([PR #175560](https://github.com/flutter/flutter/pull/175560)) | 3.41 | keiner |
| `OpenUpwardsPageTransitionsBuilder` | Nach `widgets.dart` verschoben ([PR #177080](https://github.com/flutter/flutter/pull/177080)) | 3.41 | keiner |
| `CupertinoPageTransitionsBuilder` | Von Material nach `cupertino.dart` verschoben ([PR #179776](https://github.com/flutter/flutter/pull/179776)) | 3.44 | hoch für reine Material-Dateien, ein Import behebt es |
| `ZoomPageTransitionsBuilder`, `FadeForwardsPageTransitionsBuilder`, `PredictiveBackPageTransitionsBuilder`, `PageTransitionsTheme` | Unverändert, weiterhin Material | n/a | keiner |

Die ersten drei Zeilen sind für eine Material-App unsichtbar, weil `material.dart` ein `export 'package:flutter/widgets.dart'` enthält. Eine Datei, die nur mit Material-Import `extends PageTransitionsBuilder` schreibt, löst die Klasse wie bisher über diesen Re-Export auf. Die offizielle [Seite zur inkompatiblen Änderung](https://docs.flutter.dev/release/breaking-changes/decouple-page-transition-builders) führt `FadeUpwardsPageTransitionsBuilder` und `OpenUpwardsPageTransitionsBuilder` aus demselben Grund unter "Material" auf: Bei einem Material-Import scheinen sie von dort zu stammen.

## Checkliste vor dem Start

- Prüfen Sie, welche Flutter-Version Sie verwenden: `flutter --version`. Der Bruch tritt ab 3.44 auf. 3.47.x ist die aktuelle Stable-Version.
- Finden Sie alle Fundstellen, bevor Sie etwas anfassen:

  ```bash
  # Any Flutter version
  grep -rn "PageTransitionsBuilder\|PageTransitionsTheme" lib test packages
  ```

- Notieren Sie, ob das Projekt die SDK-Bibliotheken (`package:flutter/material.dart`) oder die eigenständigen Pakete (`package:material_ui/material_ui.dart`) verwendet. Die Lösung folgt derselben Idee, aber die Importzeile unterscheidet sich, und `dart fix` macht bei einer der beiden Varianten einen Fehler (siehe Schritt 3).
- Prüfen Sie auch Ihre Pfad- und Git-Abhängigkeiten. Ein Paket, das `CupertinoPageTransitionsBuilder` nur mit einem Material-Import referenziert, bricht Ihren Build auf dieselbe Weise, und Sie können das aus Ihrer App heraus nicht beheben.

## Migrationsschritte

1. **Aktualisieren und den Fehler reproduzieren.** Wechseln Sie auf das Ziel-SDK und führen Sie den Analyzer aus, der eine deutlich klarere Meldung liefert als der Compiler:

   ```bash
   # Flutter 3.44.8 or later
   flutter upgrade
   flutter analyze
   ```

   Nehmen Sie dieses `ThemeData` aus einer typischen App, das unter 3.41 noch fehlerfrei kompiliert wurde:

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 -- fails to compile
   import 'package:flutter/material.dart';

   final ThemeData theme = ThemeData(
     pageTransitionsTheme: const PageTransitionsTheme(
       builders: <TargetPlatform, PageTransitionsBuilder>{
         TargetPlatform.android: PredictiveBackPageTransitionsBuilder(),
         TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
         TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
       },
     ),
   );
   ```

   `flutter analyze` meldet die eigentliche Ursache, `undefined_method`: "The method 'CupertinoPageTransitionsBuilder' isn't defined", dazu Rauschen durch `invalid_constant` und `non_constant_map_value` für jeden Eintrag. Prüfen: Sie sehen pro Verwendung von `CupertinoPageTransitionsBuilder` ein `undefined_method` und keine weiteren neuen Fehler.

2. **Den Cupertino-Import in jeder betroffenen Datei ergänzen.** Bei den SDK-Bibliotheken:

   ```dart
   // Flutter 3.44+, SDK libraries
   import 'package:flutter/cupertino.dart';
   import 'package:flutter/material.dart';
   ```

   Bei den eigenständigen Paketen:

   ```dart
   // Flutter 3.47.6, material_ui 1.6.0, cupertino_ui 1.1.2
   import 'package:cupertino_ui/cupertino_ui.dart';
   import 'package:material_ui/material_ui.dart';
   ```

   `material_ui` hängt bereits von `cupertino_ui` ab, aber der Import einer transitiven Abhängigkeit löst die Lint-Regel `depend_on_referenced_packages` aus. Fügen Sie das Paket daher ausdrücklich mit `flutter pub add cupertino_ui` hinzu. Prüfen: `flutter analyze` meldet für diese Dateien nichts mehr.

3. **Oder `dart fix` die Arbeit machen lassen und das Ergebnis prüfen.** Beide Bibliotheken liefern für diese Verschiebung einen datengetriebenen Fix mit (der Eintrag `replacedBy` in `fix_material.yaml`):

   ```bash
   # Flutter 3.44+
   dart fix --dry-run
   dart fix --apply
   ```

   In einem Projekt mit SDK-Bibliotheken fügt das `import 'package:flutter/cupertino.dart';` ein und sonst nichts, was korrekt ist. In einem Projekt mit `material_ui` 1.6.0 verweisen die Fix-Daten weiterhin auf `package:flutter/cupertino.dart`, die eingefrorene SDK-Kopie, und nicht auf `cupertino_ui`. Ihr Code kompiliert, weil der SDK-Builder dieselbe Basisklasse aus der Widgets-Schicht erweitert, aber Sie haben damit einen Import der SDK-Designbibliothek in ein Projekt zurückgeholt, das Sie davon wegmigriert hatten. Ersetzen Sie diese Zeile von Hand durch den Import von `cupertino_ui`. Prüfen: `grep -rn "package:flutter/cupertino.dart" lib` liefert in einem migrierten Projekt nichts.

4. **Eigene Builder auf die Widgets-Schicht umstellen.** Ein Builder, der nur `SlideTransition`, `FadeTransition`, `ScaleTransition` und Kurven kombiniert, hat keinen Grund mehr, Material zu importieren:

   ```dart
   // Flutter 3.44+, Dart 3.12 -- no Material import needed
   import 'package:flutter/widgets.dart';

   class FadeSlidePageTransitionsBuilder extends PageTransitionsBuilder {
     const FadeSlidePageTransitionsBuilder();

     @override
     Duration get transitionDuration => const Duration(milliseconds: 250);

     @override
     Widget buildTransitions<T>(
       PageRoute<T> route,
       BuildContext context,
       Animation<double> animation,
       Animation<double> secondaryAnimation,
       Widget child,
     ) {
       final Animation<Offset> position = animation.drive(
         Tween<Offset>(begin: const Offset(0.0, 0.08), end: Offset.zero)
             .chain(CurveTween(curve: Curves.easeOutCubic)),
       );
       return FadeTransition(
         opacity: animation,
         child: SlideTransition(position: position, child: child),
       );
     }
   }
   ```

   Dieselbe Klasse lässt sich unverändert in ein Material-Theme einsetzen, weil `PageTransitionsTheme.builders` genau gegen diese Basisklasse typisiert ist. Prüfen: Der einzige Flutter-Import der Datei ist `widgets.dart`, und `flutter analyze` meldet nichts.

5. **`PageRouteBuilder`-Boilerplate durch eine Route ersetzen, die an einen Builder delegiert.** Für dieses Muster wurde die Neuorganisation entworfen: eine Routenklasse, beliebige Übergänge, kein Material:

   ```dart
   // Flutter 3.44+, Dart 3.12
   import 'package:flutter/widgets.dart';

   class BuilderPageRoute<T> extends PageRoute<T> {
     BuilderPageRoute({
       required this.builder,
       this.transitionsBuilder = const FadeSlidePageTransitionsBuilder(),
       super.settings,
     });

     final WidgetBuilder builder;
     final PageTransitionsBuilder transitionsBuilder;

     @override
     Duration get transitionDuration => transitionsBuilder.transitionDuration;

     @override
     Duration get reverseTransitionDuration =>
         transitionsBuilder.reverseTransitionDuration;

     @override
     DelegatedTransitionBuilder? get delegatedTransition =>
         transitionsBuilder.delegatedTransition;

     @override
     Color? get barrierColor => null;

     @override
     String? get barrierLabel => null;

     @override
     bool get maintainState => true;

     @override
     Widget buildPage(
       BuildContext context,
       Animation<double> animation,
       Animation<double> secondaryAnimation,
     ) => builder(context);

     @override
     Widget buildTransitions(
       BuildContext context,
       Animation<double> animation,
       Animation<double> secondaryAnimation,
       Widget child,
     ) => transitionsBuilder.buildTransitions<T>(
       this,
       context,
       animation,
       secondaryAnimation,
       child,
     );
   }
   ```

   Die Weiterleitung von `transitionDuration`, `reverseTransitionDuration` und `delegatedTransition` ist wichtig. Das [offizielle Beispiel](https://api.flutter.dev/flutter/widgets/PageTransitionsBuilder-class.html) legt 300 ms fest und ignoriert damit stillschweigend die vom Builder deklarierte Dauer. Ohne `delegatedTransition` animiert ein an diese Route übergebener `CupertinoPageTransitionsBuilder` zwar die eingehende Seite, lässt die vorherige Seite aber eingefroren stehen, statt sie nach links zu schieben. Prüfen Sie das mit einem Widget-Test (nächster Abschnitt).

6. **Die Route in das jeweils verwendete App-Widget einhängen.** Für ein auf `WidgetsApp` basierendes Designsystem übergeben Sie sie als `pageRouteBuilder`:

   ```dart
   // Flutter 3.44+
   WidgetsApp(
     color: const Color(0xFF0B57D0),
     pageRouteBuilder: <T>(RouteSettings settings, WidgetBuilder builder) =>
         BuilderPageRoute<T>(builder: builder, settings: settings),
     home: const HomeScreen(),
   );
   ```

   In einer Material-App verwenden Sie für den Standard weiterhin `PageTransitionsTheme` und pushen `BuilderPageRoute` nur dort, wo ein Bildschirm einen anderen Übergang braucht. Prüfen: Die Navigation zu einem gepushten Bildschirm zeigt die neue Animation, und `flutter analyze` meldet nichts.

## Überprüfung

Verlassen Sie sich bei einer 250-ms-Animation nicht auf Ihre Augen. Pumpen Sie die Route bis zur Hälfte und prüfen Sie das Übergangs-Widget per Assertion:

```dart
// Flutter 3.44.8, flutter_test
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:my_app/transitions.dart';

void main() {
  testWidgets('BuilderPageRoute uses the builder duration', (tester) async {
    final navigator = GlobalKey<NavigatorState>();
    await tester.pumpWidget(WidgetsApp(
      navigatorKey: navigator,
      color: const Color(0xFF000000),
      pageRouteBuilder: <T>(RouteSettings s, WidgetBuilder b) =>
          BuilderPageRoute<T>(builder: b, settings: s),
      home: const Text('home', textDirection: TextDirection.ltr),
    ));

    navigator.currentState!.push(BuilderPageRoute<void>(
      builder: (_) => const Text('second', textDirection: TextDirection.ltr),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 125));

    final fade = tester.widget<FadeTransition>(find
        .ancestor(of: find.text('second'), matching: find.byType(FadeTransition))
        .first);
    expect(fade.opacity.value, 0.5);

    await tester.pumpAndSettle();
    expect(find.text('second'), findsOneWidget);
  });
}
```

Unter Flutter 3.44.8 besteht dieser Test mit einer Deckkraft von exakt `0.5` bei 125 ms, was belegt, dass die Route die 250-ms-Dauer des Builders übernommen hat. Legt jemand erneut 300 ms fest, sinkt der Wert auf etwa `0.42`, und der Test schlägt fehl. Darüber hinaus gilt:

- `flutter analyze` meldet keine Diagnosen vom Typ `undefined_method` oder `undefined_hidden_name`.
- `flutter test` besteht, einschließlich Golden-Tests, die Frames mitten im Übergang erfassen, falls Sie solche haben.
- Wischen Sie im iOS-Simulator auf einem Bildschirm mit `CupertinoPageTransitionsBuilder` vom linken Rand zurück und bestätigen Sie, dass sich die vorherige Seite mit der Geste bewegt.

## Rollback-Plan

Die Codeänderungen sind rein additiv: ein zusätzlicher Import und ein paar Klassen, die kein Material mehr brauchen. Alle kompilieren auch unter 3.41, nur dass dort `CupertinoPageTransitionsBuilder` über den Material-Import aufgelöst wird und der hinzugefügte Import von `cupertino.dart` bloß überflüssig ist. Ein Rollback des SDKs mit `flutter downgrade` oder einer festgelegten Version in der CI erfordert nicht, dass Sie davon etwas zurücknehmen. Nur ein Builder, der ausschließlich `widgets.dart` importiert, kann nicht unter 3.38 zurück, da die Basisklasse dort noch nicht existierte.

## Stolperfallen

**Die Compiler-Fehlermeldung zeigt auf das falsche Problem.** In einer `const`-Map, wie fast jedes `PageTransitionsTheme` geschrieben wird, meldet das Frontend nicht, dass der Name undefiniert ist. `flutter build` und `flutter test` geben nur Folgendes aus:

```text
lib/main.dart:14:33: Error: Not a constant expression.
            TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

Viele löschen daraufhin `const`, was zu "The method 'CupertinoPageTransitionsBuilder' isn't defined for the type 'App'" führt, und suchen dann nach einer Methode. Führen Sie zuerst `flutter analyze` aus; es zeigt die Diagnose `undefined_method` neben dem Rauschen durch die Konstanten.

**Eine partielle `builders`-Map wird nicht mit den Standardwerten zusammengeführt.** Wer `builders:` übergibt, ersetzt die gesamte Standard-Map, und fehlende Plattformen greifen zur Laufzeit auf `CupertinoPageTransitionsBuilder` nur unter iOS und auf `ZoomPageTransitionsBuilder` überall sonst zurück, macOS eingeschlossen. Wenn Sie nur Android und iOS auflisten, erhält macOS den Zoom-Übergang. Da Sie ohnehin in dieser Datei sind, listen Sie jede Plattform auf, die Sie ausliefern.

**SDK- und Paket-Imports von Cupertino in einer Datei mischen.** In einem `material_ui`-Projekt führt eine Datei, die sowohl `package:flutter/cupertino.dart` (von `dart fix` zurückgelassen) als auch `package:cupertino_ui/cupertino_ui.dart` importiert, für jeden Cupertino-Namen zu `ambiguous_import`-Fehlern. Behalten Sie genau einen.

**Veraltete `hide`-Klauseln.** Manche Codebasen haben `import 'package:flutter/material.dart' hide CupertinoPageTransitionsBuilder;` geschrieben, um einen Konflikt mit einer lokalen Klasse gleichen Namens zu vermeiden. Ab 3.44 existiert dieser Name im Material-Namensraum nicht mehr, und der Analyzer meldet `undefined_hidden_name`. Löschen Sie die Klausel.

**Builder von Drittanbietern funktionieren weiter.** `SharedAxisPageTransitionsBuilder` aus [`animations`](https://pub.dev/packages/animations) und ähnliche Klassen erweitern die Basisklasse über ihren eigenen Material-Import, der den Typ aus der Widgets-Schicht erneut exportiert, sodass sie sich weiterhin in Ihr Theme einfügen. Nur Pakete, die `CupertinoPageTransitionsBuilder` selbst mit einem reinen Material-Import referenzieren, brechen, und dort braucht es ein Release des Pakets, keine Änderung in Ihrer App.

**Die Unterklasse eines Material-Builders braucht weiterhin Material.** `ZoomPageTransitionsBuilder`, `FadeForwardsPageTransitionsBuilder` und die Predictive-Back-Builder sind in Material geblieben. Erweitert Ihr eigener Builder einen davon, um eine Dauer anzupassen, behält er seinen Import von Material (oder `material_ui`).

## Verwandte Artikel

- Die Änderung der Imports ist hier ein Ausschnitt aus dem größeren Umbau, den [die Migration der Flutter-Imports von Material und Cupertino auf die Pakete material_ui und cupertino_ui](/de/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/) behandelt.
- Zum Release, das die Entkopplung angestoßen hat, siehe [Flutter 3.44 teilt Material und Cupertino in Pakete auf](/de/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Ein weiterer Kompilierfehler unter 3.44 mit derselben Ursache: [Behebung von "Undefined name 'awaitNotRequired'" mit material_ui und cupertino_ui](/de/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/).
- Ist Ihr eigener Übergang eigentlich ein Shared Element, ist [eine Hero-Animation zwischen zwei Bildschirmen](/de/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/) womöglich das bessere Werkzeug.
- Router, die ihre eigenen Seiten bauen, etwa `CustomTransitionPage` von go_router, werden in [go_router vs auto_route vs Navigator 2.0](/de/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/) verglichen.

## Quellen

- [Page transition builders reorganization](https://docs.flutter.dev/release/breaking-changes/decouple-page-transition-builders), Flutter Breaking Changes.
- [`PageTransitionsBuilder` API reference](https://api.flutter.dev/flutter/widgets/PageTransitionsBuilder-class.html).
- [flutter/flutter#172929](https://github.com/flutter/flutter/issues/172929), das Tracking-Issue.
- PRs [#174321](https://github.com/flutter/flutter/pull/174321), [#175560](https://github.com/flutter/flutter/pull/175560), [#177080](https://github.com/flutter/flutter/pull/177080) und [#179776](https://github.com/flutter/flutter/pull/179776).
- [Data-driven fixes](https://dart.dev/tools/fix) in der Dart-Dokumentation.
