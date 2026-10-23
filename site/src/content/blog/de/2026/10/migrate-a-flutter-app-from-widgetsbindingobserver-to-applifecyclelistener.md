---
title: "Eine Flutter-App von WidgetsBindingObserver.didChangeAppLifecycleState auf AppLifecycleListener migrieren (Flutter 3.13+)"
description: "Handgeschriebenen WidgetsBindingObserver-Lifecycle-Code durch AppLifecycleListener ersetzen: die Zuordnung der Callbacks, die erzwungene Zustandsmaschine, der neue Zustand hidden, der exhaustive switch-Anweisungen bricht, Exit-Anfragen auf dem Desktop und der Test, der plötzlich eine Assertion auslöst. Getestet mit Flutter 3.44.8 und Dart 3.12.2."
pubDate: 2026-10-23
updatedDate: 2026-10-23
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "app-lifecycle"
lang: "de"
translationOf: "2026/10/migrate-a-flutter-app-from-widgetsbindingobserver-to-applifecyclelistener"
translatedBy: "claude"
translationDate: 2026-10-23
---

Wenn Ihre Flutter-App `WidgetsBindingObserver` noch in einen `State` einmischt, nur um `didChangeAppLifecycleState` zu überschreiben, ist `AppLifecycleListener` der Ersatz, hinzugefügt in Flutter 3.13.0. Sie erzeugen in `initState` ein Listener-Objekt, übergeben nur die Callbacks, die Sie brauchen (`onResume`, `onPause`, `onHide`, `onShow`, `onInactive`, `onRestart`, `onDetach`, `onStateChange`, `onExitRequested`), und rufen `dispose()` darauf auf. Kein Mixin, kein `addObserver`/`removeObserver`-Paar, kein `switch` über `AppLifecycleState`. Die Migration eines Observers dauert etwa 10 Minuten und erhält das Verhalten, solange Sie zwei Dinge wissen: Seit 3.13 fügt das Framework die Zwischenzustände ein (`resumed` nach `paused` kommt jetzt als `inactive`, `hidden`, `paused` an), und der neue Wert `AppLifecycleState.hidden` macht jeden exhaustive `switch` ohne `default` zu einem Kompilierfehler. Alles Folgende wurde mit Flutter 3.44.8 (Dart 3.12.2) ausgeführt.

## Warum der rohe Observer ausgedient hat

- **Weniger Code, weniger Lecks.** Das Observer-Muster braucht drei aufeinander abgestimmte Teile: das Mixin, `WidgetsBinding.instance.addObserver(this)` in `initState` und `removeObserver(this)` in `dispose`. Wer das letzte vergisst, hält einen entsorgten `State` in der Observer-Liste des Bindings am Leben, und er erhält nach dem Unmount weiter Callbacks. `AppLifecycleListener` registriert sich im Konstruktor und meldet sich in `dispose()` ab. Es ist also ein einziger Aufruf zu merken, derselbe, den Sie schon für Controller machen.
- **Übergänge statt Zustände.** `didChangeAppLifecycleState` sagt Ihnen, wo die App ist. Die meiste App-Logik interessiert sich dafür, wie sie dorthin gekommen ist: "Die App kommt aus dem Hintergrund zurück" ist `paused` nach `hidden` (`onRestart`), was etwas anderes ist als "ein System-Dialog wurde geschlossen" (`inactive` nach `resumed`, `onResume`). Der Listener merkt sich den vorherigen Zustand und ruft den Callback auf, der den Übergang benennt.
- **Exit-Anfragen auf dem Desktop im selben Objekt.** Mit `onExitRequested` kann eine Windows-, macOS- oder Linux-App das Schließen abbrechen, um eine Rückfrage zu ungespeicherten Änderungen zu zeigen. Mit dem rohen Observer ist das eine separate Überschreibung, `didRequestAppExit`.
- **Er kann außerhalb des Widget-Baums leben.** Der Listener ist ein einfaches Dart-Objekt, das nur ein `WidgetsBinding` braucht. Ein Repository, ein Analytics-Dienst oder ein Riverpod-Provider kann einen besitzen und ihn zusammen mit dem Dienst entsorgen.

## Was sich in der App ändert

| Bereich | Änderung | Schweregrad |
| --- | --- | --- |
| `switch (state)`-Anweisungen | `AppLifecycleState.hidden` (hinzugefügt in 3.13) lässt Switches ohne `default` mit `non_exhaustive_switch_statement` fehlschlagen | hoch |
| Widget-Tests, die `handleAppLifecycleStateChanged` direkt aufrufen | Der Sprung von `resumed` nach `paused` löst jetzt eine Assertion im Listener aus | hoch |
| Observer-`State`-Klassen | Mixin und `addObserver`/`removeObserver` entfallen, ersetzt durch ein Feld und `dispose()` | mittel |
| Reihenfolge der Callbacks | `onStateChange` feuert nach dem Übergangs-Callback, einmal pro Zwischenzustand | niedrig |
| Exit-Behandlung | Die Überschreibung `didRequestAppExit` wandert nach `onExitRequested`; `AppExitResponse` kommt aus `dart:ui` | niedrig |

## Checkliste vor dem Start

- Flutter 3.13.0 oder neuer (`flutter --version`). `AppLifecycleListener` existiert in 3.10 und früher nicht, und die Datei `packages/flutter/lib/src/widgets/app_lifecycle_listener.dart` erscheint erstmals im Tag 3.13.0.
- Durchsuchen Sie die Codebasis nach `with WidgetsBindingObserver` und `didChangeAppLifecycleState`. Notieren Sie, welche Observer auch andere Callbacks wie `didChangeMetrics`, `didChangePlatformBrightness`, `didChangeLocales` oder `didHaveMemoryPressure` überschreiben. Diese behalten das Mixin für die Nicht-Lifecycle-Callbacks; nur der Lifecycle-Teil zieht um.
- Durchsuchen Sie den Code nach `switch`-Anweisungen und `if`-Ketten über `AppLifecycleState`. Für jede braucht es eine Entscheidung zu `hidden`.
- Durchsuchen Sie die Tests nach `handleAppLifecycleStateChanged`. Das sind die Tests, die anfangen werden zu scheitern.
- Zuerst committen oder stashen. Dies ist eine reine Code-Migration ohne Daten, daher ist `git revert` der Rollback.

## Migrationsschritte

1. **Jeden `case` einem Callback zuordnen.** Die Callbacks des Listeners sind nach Übergängen benannt, nicht nach Zuständen. Das ist die Zuordnung, entnommen dem Quelltext von `AppLifecycleListener.didChangeAppLifecycleState` in Flutter 3.44.8:

   | Neuer Zustand | Vorheriger Zustand | Callback |
   | --- | --- | --- |
   | `resumed` | `inactive` (oder keiner) | `onResume` |
   | `inactive` | `resumed` (oder keiner) | `onInactive` |
   | `inactive` | `hidden` | `onShow` |
   | `hidden` | `inactive` (oder keiner) | `onHide` |
   | `hidden` | `paused` | `onRestart` |
   | `paused` | `hidden` (oder keiner) | `onPause` |
   | `detached` | `paused` (oder keiner) | `onDetach` |
   | beliebig | beliebig | `onStateChange(state)`, nach dem spezifischen Callback |

   Ein `case AppLifecycleState.paused:` wird zu `onPause`, und `case AppLifecycleState.resumed:` wird zu `onResume`. Wenn der alte Code bei `inactive` unabhängig von der Richtung etwas tat, verwenden Sie `onStateChange` und behalten das `if`, denn `inactive` wird aus zwei Richtungen erreicht und entspricht zwei verschiedenen Callbacks. Prüfen: Jeder Zweig des alten `switch` hat in Ihren Notizen genau ein Ziel.

2. **Das Mixin durch ein Listener-Feld ersetzen.** So sieht das typische Vorher aus:

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 - BEFORE
   class PlayerScreen extends StatefulWidget {
     const PlayerScreen({super.key});
     @override
     State<PlayerScreen> createState() => _PlayerScreenState();
   }

   class _PlayerScreenState extends State<PlayerScreen>
       with WidgetsBindingObserver {
     @override
     void initState() {
       super.initState();
       WidgetsBinding.instance.addObserver(this);
     }

     @override
     void didChangeAppLifecycleState(AppLifecycleState state) {
       switch (state) {
         case AppLifecycleState.resumed:
           _player.resume();
         case AppLifecycleState.paused:
           _player.pause();
           _saveProgress();
         default:
           break;
       }
     }

     @override
     void dispose() {
       WidgetsBinding.instance.removeObserver(this);
       super.dispose();
     }

     // _player, _saveProgress and build() omitted
   }
   ```

   Und das Nachher:

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 - AFTER
   class _PlayerScreenState extends State<PlayerScreen> {
     late final AppLifecycleListener _lifecycle;

     @override
     void initState() {
       super.initState();
       _lifecycle = AppLifecycleListener(
         onResume: () => _player.resume(),
         onPause: () {
           _player.pause();
           _saveProgress();
         },
       );
     }

     @override
     void dispose() {
       _lifecycle.dispose();
       super.dispose();
     }

     // _player, _saveProgress and build() unchanged
   }
   ```

   Der Konstruktor ruft `binding.addObserver(this)` selbst auf, das Erzeugen des Objekts ist also bereits das Abonnement. Prüfen: `flutter analyze` meldet keine Probleme mit ungenutzten `WidgetsBindingObserver`-Imports, und die Klasse hat keine `with`-Klausel mehr (es sei denn, sie braucht weiterhin andere Observer-Callbacks, siehe Schritt 4).

3. **Entscheiden, was `hidden` für Ihre Logik bedeutet.** `AppLifecycleState.hidden` kam in Flutter 3.13 für Desktop und Web hinzu, wo eine App minimiert sein oder in einem Hintergrund-Tab laufen kann, ohne im mobilen Sinn "paused" zu sein. Auf iOS und Android synthetisiert das Framework ihn zwischen `inactive` und `paused`. Wenn Sie `onPause` benutzt haben, um ein Video zu stoppen, funktioniert das weiterhin überall dort, wo es bisher funktionierte. Soll das Video auch stoppen, wenn ein Desktop-Fenster minimiert wird, ist `onHide` der Callback, der auf jeder Plattform feuert, mit `onShow` als Gegenstück. Für alles, was nur passieren soll, wenn der Benutzer die App auf Mobilgeräten verlässt (einen Entwurf speichern, Analytics ausleeren), ist `onPause` plus `onRestart` das passende Paar. Prüfen: Notieren Sie pro Callback, auf welche Plattformen Sie ausliefern und ob er dort feuert (`onRestart` und `onDetach` sind als nur mobil dokumentiert).

4. **Das Mixin nur für Nicht-Lifecycle-Callbacks behalten.** `AppLifecycleListener` deckt `didChangeAppLifecycleState` und `didRequestAppExit` ab und sonst nichts. Wenn ein Observer auch `didChangeMetrics` überschreibt, um auf Tastatur-Insets zu reagieren, lassen Sie das Mixin für diese Überschreibung bestehen und verschieben nur die Lifecycle-Methode. Prüfen: Durchsuchen Sie die Klasse nach der Änderung nach `@override`-Methoden von `WidgetsBindingObserver`; wenn keine übrig sind, entfernen Sie das Mixin und die Aufrufe von `addObserver`/`removeObserver`.

5. **`didRequestAppExit` nach `onExitRequested` verschieben** (nur Desktop). Der Callback gibt ein `Future<AppExitResponse>` zurück, und dieses Enum lebt in `dart:ui`, nicht in `package:flutter/widgets.dart` oder `services.dart`. Ohne den Import erhalten Sie `Undefined name 'AppExitResponse'`.

   ```dart
   // Flutter 3.44.8, Dart 3.12.2
   import 'dart:ui' show AppExitResponse;
   import 'package:flutter/material.dart';

   class _EditorState extends State<Editor> {
     late final AppLifecycleListener _lifecycle;
     bool _dirty = false;

     @override
     void initState() {
       super.initState();
       _lifecycle = AppLifecycleListener(
         onExitRequested: () async {
           if (!_dirty) return AppExitResponse.exit;
           final discard = await showDialog<bool>(
             context: context,
             builder: (context) => AlertDialog(
               title: const Text('Discard unsaved changes?'),
               actions: [
                 TextButton(
                   onPressed: () => Navigator.pop(context, false),
                   child: const Text('Cancel'),
                 ),
                 TextButton(
                   onPressed: () => Navigator.pop(context, true),
                   child: const Text('Discard'),
                 ),
               ],
             ),
           );
           return discard == true ? AppExitResponse.exit : AppExitResponse.cancel;
         },
       );
     }

     @override
     void dispose() {
       _lifecycle.dispose();
       super.dispose();
     }

     @override
     Widget build(BuildContext context) => const Placeholder();
   }
   ```

   Nur abbrechbare Exits erreichen diesen Callback. `ServicesBinding.instance.exitApplication(AppExitType.required)` beendet die App, ohne zu fragen. Beachten Sie, dass `WidgetsBinding.handleRequestAppExit` jeden Observer fragt, auch nachdem einer mit `cancel` geantwortet hat, und den Exit abbricht, wenn auch nur einer das getan hat. Ein einziger Listener irgendwo in der App kann den Exit also mit einem Veto belegen, und das `onExitRequested` jedes anderen Listeners läuft trotzdem, legen Sie dort also keine unumkehrbaren Aufräumarbeiten ab. Prüfen: Auf dem Desktop den Editor verändern, das Fenster schließen und bestätigen, dass der Dialog erscheint und "Cancel" das Fenster offen hält.

6. **Die `switch`-Anweisungen reparieren, die der Wert `hidden` gebrochen hat.** Wenn Sie einen `switch` behalten (zum Beispiel in `onStateChange`), muss er `hidden` abdecken. Das kompiliert in Flutter 3.10 und schlägt ab 3.13 fehl:

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 - fails flutter analyze
   String describe(AppLifecycleState state) {
     switch (state) {
       case AppLifecycleState.resumed:
         return 'resumed';
       case AppLifecycleState.inactive:
         return 'inactive';
       case AppLifecycleState.paused:
         return 'paused';
       case AppLifecycleState.detached:
         return 'detached';
     }
   }
   ```

   Der Analyzer meldet: "The type 'AppLifecycleState' isn't exhaustively matched by the switch cases since it doesn't match the pattern 'AppLifecycleState.hidden'" (`non_exhaustive_switch_statement`). Fügen Sie ein explizites `case AppLifecycleState.hidden:` hinzu statt eines `default`, damit der nächste von Flutter ergänzte Enum-Wert wieder ein Kompilierfehler ist und nicht stillschweigend durchfällt. Prüfen: `flutter analyze` ist sauber.

7. **Die Tests aktualisieren, die Lifecycle-Änderungen auslösen.** Siehe den nächsten Abschnitt; hier bleiben die meisten Migrationen tatsächlich hängen. Prüfen: `flutter test` läuft durch.

## Überprüfung

Der schnellste Beweis, dass sich das Verhalten nicht geändert hat, ist ein Widget-Test, der Lifecycle-Änderungen so sendet wie die Engine: als String auf dem Kanal `flutter/lifecycle`. Dieser Weg läuft durch den Übergangsgenerator des Bindings, genau wie auf einem echten Gerät.

```dart
// Flutter 3.44.8, Dart 3.12.2 - test/lifecycle_test.dart
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> sendLifecycle(WidgetTester tester, AppLifecycleState state) async {
  final message = const StringCodec().encodeMessage(state.toString());
  await tester.binding.defaultBinaryMessenger
      .handlePlatformMessage('flutter/lifecycle', message, (_) {});
}

void main() {
  testWidgets('background and foreground', (tester) async {
    final log = <String>[];
    final listener = AppLifecycleListener(
      onResume: () => log.add('onResume'),
      onInactive: () => log.add('onInactive'),
      onHide: () => log.add('onHide'),
      onShow: () => log.add('onShow'),
      onPause: () => log.add('onPause'),
      onRestart: () => log.add('onRestart'),
      onStateChange: (s) => log.add('state:${s.name}'),
    );
    addTearDown(listener.dispose);

    await sendLifecycle(tester, AppLifecycleState.resumed);
    await sendLifecycle(tester, AppLifecycleState.paused);
    await sendLifecycle(tester, AppLifecycleState.resumed);

    expect(log, [
      'onResume', 'state:resumed',
      'onInactive', 'state:inactive',
      'onHide', 'state:hidden',
      'onPause', 'state:paused',
      'onRestart', 'state:hidden',
      'onShow', 'state:inactive',
      'onResume', 'state:resumed',
    ]);
  });
}
```

Das besteht auf 3.44.8 und dokumentiert drei Fakten an einer Stelle. Ein Plattformsprung von `resumed` direkt nach `paused` kommt als drei Schritte an. Der Rückweg führt `onRestart`, `onShow`, `onResume` aus, in genau dieser Reihenfolge. Und `onStateChange` kommt immer nach dem benannten Callback desselben Schritts. Wird `resumed` zweimal hintereinander gesendet, passiert beim zweiten Mal nichts, weil sowohl das Binding als auch der Listener wiederholte Zustände verwerfen.

Danach die manuellen Prüfungen: Schicken Sie die App auf Android und iOS in den Hintergrund, holen Sie sie zurück und bestätigen Sie, dass die nach `onPause` und `onResume` verschobene Arbeit weiterhin je einmal stattfindet. Auf dem Desktop minimieren und wiederherstellen, wenn Sie etwas nach `onHide`/`onShow` verschoben haben, und das Fenster schließen, wenn Sie `onExitRequested` implementiert haben.

## Rollback

Die Migration ist eine reine Code-Änderung; es ist kein persistierter Zustand beteiligt. Mit `git revert` auf den Commit sind Sie wieder beim Observer. Das Einzige, was sich nicht sauber zurücknehmen lässt, ist ein für `hidden` repariertes `switch`: Behalten Sie diese Korrektur, denn der alte Code war ab 3.13 ohnehin kaputt.

## Stolpersteine aus einer echten Migration

### Tests, die `handleAppLifecycleStateChanged` aufrufen, lösen jetzt eine Assertion aus

Viele Test-Suites simulieren das Wechseln in den Hintergrund mit `tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused)`. Diese Methode liefert den übergebenen Zustand direkt aus, ohne die synthetisierten Zwischenzustände. Ein einfacher Observer stört sich nicht daran. Der Listener validiert jeden Übergang, sodass dieser Test fehlschlägt, wenn die App in `resumed` ist:

```dart
// Flutter 3.44.8, Dart 3.12.2 - fails
testWidgets('direct jump', (tester) async {
  final listener = AppLifecycleListener(onPause: () {});
  addTearDown(listener.dispose);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
});
```

Der Fehler ist eine Assertion, die beim Ausliefern an die Observer geworfen wird: "Invalid state transition from AppLifecycleState.resumed to AppLifecycleState.paused", und `onPause` wird nie aufgerufen. Senden Sie entweder jeden Zwischenzustand selbst (`inactive`, `hidden`, `paused`) oder nutzen Sie den Kanal-Helfer `flutter/lifecycle` aus dem Abschnitt Überprüfung, der das Framework die Zustände erzeugen lässt. Die Assertion existiert nur in Debug-Builds, das Release-Verhalten ist also nicht betroffen; das Risiko ist allein eine rote Test-Suite.

### Der Listener sieht Änderungen erst nach seiner Erzeugung

Der Konstruktor erfasst `binding.lifecycleState` und behandelt es als vorherigen Zustand. Wenn Sie den Listener auf einem Screen erzeugen, der lange nach dem Start gepusht wird, feuert für den aktuellen Zustand kein `onResume`, weil es keinen Übergang gab. Der alte Observer verhielt sich genauso, doch manchmal verließ sich Code auf einen Aufruf in `initState`, um "die Resume-Logik einmal auszuführen". Machen Sie das explizit: Lesen Sie `WidgetsBinding.instance.lifecycleState` in `initState`, wenn Sie den aktuellen Zustand brauchen, genau wie zuvor.

### Alte Observer sehen die synthetisierten Zustände ebenfalls

Die Erzeugung der Zwischenzustände sitzt in `ServicesBinding`, nicht im Listener. Im obigen Repro erhielt ein einfacher `WidgetsBindingObserver`, der neben dem Listener registriert war, für eine einzige Plattformnachricht `paused` ebenfalls `inactive`, `hidden`, `paused`. Wenn also ein noch nicht migrierter Observer bei "allem außer `resumed`" die Wiedergabe pausiert, läuft dieser Code jetzt dreimal pro Wechsel in den Hintergrund. Machen Sie solche Handler idempotent oder migrieren Sie sie auf einen einzelnen benannten Callback.

### Einen Listener vor `runApp` erzeugen

`AppLifecycleListener()` setzt `binding` standardmäßig auf `WidgetsBinding.instance`, was eine Exception wirft, wenn das Binding noch nicht initialisiert ist. Ein Listener, der einem Dienst gehört, der in `main()` vor `runApp` gebaut wird, braucht vorher `WidgetsFlutterBinding.ensureInitialized()`. Bei Diensten, die jedes Widget überdauern, sorgen Sie außerdem dafür, dass irgendetwas `dispose()` aufruft; mit Riverpod ist das `ref.onDispose(listener.dispose)` im Provider, der ihn erzeugt.

### `onExitRequested` ist kein Hook für die mobile Zurück-Taste

Man ist versucht, `onExitRequested` unter Android als "die App wird gleich geschlossen" zu behandeln. Das ist es nicht: Im Engine-Quelltext senden nur die Embedder für Windows, macOS und Linux Exit-Anfragen, er feuert also nie unter Android oder iOS. Um die Android-Zurück-Geste abzufangen, verwenden Sie `PopScope`. Um aufzuräumen, wenn eine mobile App verschwindet, verwenden Sie `onPause`; `onDetach` läuft nicht garantiert, bevor das Betriebssystem einen Hintergrundprozess beendet.

## Weiterführend

- Das `dispose()` des Listeners gehört zum restlichen Aufräumen; siehe [wie man Controller in Flutter entsorgt, um Speicherlecks zu vermeiden](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).
- Einen Stream zu pausieren, wenn die App in den Hintergrund geht, ist eine typische `onPause`-Aufgabe, und [eine StreamSubscription in dispose abbrechen](/de/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/) deckt die andere Hälfte ab.
- `onPause` ist unter Android nicht Ihre letzte Chance: Das Betriebssystem kann den Prozess danach beenden. [UI-Zustand nach dem Prozesstod unter Android mit RestorationMixin wiederherstellen](/de/2026/10/how-to-restore-ui-state-after-android-process-death-in-flutter-with-restorationmixin/) kümmert sich darum, was zurückkommt.
- Wenn Sie mehrere veraltete APIs auf einmal bereinigen, automatisiert [dart fix über ein ganzes Repository](/de/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) die mechanischen (diese Migration gehört nicht dazu).
- `onExitRequested` ist vor allem in Desktop-Apps mit mehreren Fenstern wichtig; siehe [Multi-Window-Unterstützung in einer Flutter-Desktop-App aktivieren](/de/2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app/).

## Quellen

- [`AppLifecycleListener` class](https://api.flutter.dev/flutter/widgets/AppLifecycleListener-class.html) (api.flutter.dev)
- [`AppLifecycleState` enum and state diagram](https://api.flutter.dev/flutter/dart-ui/AppLifecycleState.html) (api.flutter.dev)
- [`WidgetsBindingObserver` class](https://api.flutter.dev/flutter/widgets/WidgetsBindingObserver-class.html) (api.flutter.dev)
- [`ServicesBinding.exitApplication`](https://api.flutter.dev/flutter/services/ServicesBinding/exitApplication.html) (api.flutter.dev)
- [`app_lifecycle_listener.dart` source](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/widgets/app_lifecycle_listener.dart) und [`ServicesBinding` transition generation](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/services/binding.dart) (flutter/flutter)
- [Breaking change: new `AppLifecycleState.hidden` enum value](https://docs.flutter.dev/release/breaking-changes/add-applifecyclestate-hidden) (docs.flutter.dev)
