---
title: "UI-Zustand nach dem Android-Prozesstod in Flutter mit RestorationMixin wiederherstellen"
description: "Android beendet Flutter-Apps im Hintergrund, um Speicher freizugeben, und wenn der Nutzer zurückkehrt, beginnt jedes StatefulWidget bei null. So aktivieren Sie die Wiederherstellung mit restorationScopeId, RestorationMixin und Restorable-Eigenschaften, stellen Textfelder, Scroll-Positionen und gepushte Routen wieder her, schreiben ein eigenes RestorableValue und testen alles mit restartAndRestore und adb, verifiziert mit Flutter 3.44.8 und einem Android-16-Emulator."
pubDate: 2026-10-19
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "state-restoration"
  - "how-to"
lang: "de"
translationOf: "2026/10/how-to-restore-ui-state-after-android-process-death-in-flutter-with-restorationmixin"
translatedBy: "claude"
translationDate: 2026-10-19
---

**Kurze Antwort:** Setzen Sie `restorationScopeId: 'app'` auf Ihrer `MaterialApp`, binden Sie `RestorationMixin` in jeden `State` ein, der etwas hält, dessen Verlust den Nutzer ärgern würde, speichern Sie diese Daten in `RestorableInt`, `RestorableTextEditingController`, `RestorableEnum` und Verwandten statt in einfachen Feldern, registrieren Sie jedes davon in `restoreState` und öffnen Sie Bildschirme mit `Navigator.restorablePush` statt mit `Navigator.push`. Flutter serialisiert diese Werte dann in das saved-instance-state-`Bundle` von Android, und wenn Android die Activity in einem neuen Prozess neu erstellt, setzt das Framework sie vor dem ersten Frame wieder ein. Alles Folgende wurde mit Flutter 3.44.8 (Dart 3.12.2) mit Widget-Tests und mit echten Prozess-Kills auf einem Android-16-Emulator (API 36) verifiziert; `restoration.dart` hat sich auf dem `stable`-Branch seit Juli 2025 nicht geändert.

Der Rest dieses Beitrags erklärt, was Prozesstod eigentlich ist und warum Ihr Zustand verschwindet, baut ein kleines Bestellformular, das ihn übersteht, behandelt Routen und Scroll-Positionen, zeigt, wie man ein `RestorableValue` für die eigene Klasse schreibt, und listet die Stolperfallen auf, auf die ich beim Testen gestoßen bin, darunter eine, bei der `restorablePush` fehlschlägt, bis Sie den Route-Builder in eine Top-Level-Funktion verschieben.

## Was Prozesstod ist und warum Flutter-Zustand ihn nicht überlebt

Wenn der Nutzer von Ihrer App wegwechselt, stoppt Android die Activity, behält den Prozess aber bei. Wird der Speicher knapp, beendet das System diesen Hintergrundprozess. Es informiert den Nutzer nicht: Die App erscheint weiterhin in den zuletzt verwendeten Apps mit ihrem letzten Screenshot. Tippt der Nutzer darauf, startet Android einen neuen Prozess, erstellt eine neue `FlutterActivity` und übergibt ihr das `Bundle`, das die alte Activity in `onSaveInstanceState` geschrieben hat.

Eine Flutter-App hält ihren gesamten UI-Zustand in Dart-Objekten auf dem Heap dieses toten Prozesses. Ein neuer Prozess bedeutet ein neues Dart-Isolate, ein neues `main()` und frische `State`-Objekte. Wenn nichts Ihre Zähler, Formularfelder und den Navigationsstapel in dieses `Bundle` geschrieben hat, sind sie weg, und der Nutzer landet auf Ihrem Startbildschirm mit einem leeren Formular. Das ist der klassische Fehler "Ich habe ein Foto gemacht, bin zurückgekommen, und die App hatte alles vergessen".

Das State-Restoration-Framework von Flutter ist der Teil, der in dieses `Bundle` schreibt. Unter Android speichert `FlutterActivityAndFragmentDelegate` die serialisierten Daten des Frameworks als Byte-Array unter dem Schlüssel `"framework"` (und den Plugin-Zustand unter `"plugins"`). Es wird nichts gespeichert, solange Ihr Widget-Baum sich nicht dafür entscheidet, weshalb die meisten Apps nie bemerken, dass es die Funktion gibt.

Zwei Dinge sind *kein* Prozesstod und stellen daher bewusst nichts wieder her:

- Der Nutzer wischt die App aus den zuletzt verwendeten Apps weg. Der Task wird entfernt, und der gespeicherte Zustand mit ihm.
- Die App wird zwangsweise beendet (Einstellungen oder `adb shell am force-stop`). Gleiches Ergebnis.

Beides habe ich unten auf dem Emulator geprüft. Die Wiederherstellung gilt nur für den Fall "das System hat mich im Hintergrund beendet".

## Die drei Bausteine für die Aktivierung

State Restoration ist ein Baum aus `RestorationBucket`s. Jedes Element des Baums beansprucht einen Bucket per ID von seinem Elternelement, und Blattwerte werden in diesen Buckets gespeichert. Sie benötigen:

1. **Einen Root-Scope.** `MaterialApp(restorationScopeId: 'app')` (oder `CupertinoApp`, `WidgetsApp`) erzeugt einen `RootRestorationScope` und aktiviert außerdem die Wiederherstellung für den `Navigator` der App. Ohne ihn gibt es keinen Bucket zum Schreiben, und jedes Kind erhält `null`.
2. **`RestorationMixin` auf Ihrem `State`.** Es beansprucht einen Kind-Bucket über den von Ihnen überschriebenen Getter `restorationId`.
3. **Restorable-Eigenschaften.** Unterklassen von `RestorableProperty<T>` umhüllen einen Wert und wissen, wie sie ihn in Primitive umwandeln, die `StandardMessageCodec` kodieren kann. Jede registrieren Sie mit einem eindeutigen Schlüssel innerhalb des Buckets.

## Ein minimales Bestellformular, das den Prozesstod übersteht

Dies ist der Bildschirm, den ich für alle Tests in diesem Beitrag verwendet habe. Er hat eine Menge, eine Checkbox, ein Enum, zwei Textfelder und eine lange Liste, dazu zum Vergleich ein einfaches `int`-Feld.

```dart
// Flutter 3.44.8, Dart 3.12
import 'package:flutter/material.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      restorationScopeId: 'app',
      home: OrderPage(),
    );
  }
}

enum Shipping { standard, express }

class OrderPage extends StatefulWidget {
  const OrderPage({super.key});

  @override
  State<OrderPage> createState() => _OrderPageState();
}

class _OrderPageState extends State<OrderPage> with RestorationMixin {
  final RestorableInt _quantity = RestorableInt(1);
  final RestorableBool _giftWrap = RestorableBool(false);
  final RestorableEnum<Shipping> _shipping =
      RestorableEnum(Shipping.standard, values: Shipping.values);
  final RestorableTextEditingController _note = RestorableTextEditingController();
  int _plainCounter = 0; // not restorable, for contrast

  @override
  String? get restorationId => 'order_page';

  @override
  void restoreState(RestorationBucket? oldBucket, bool initialRestore) {
    registerForRestoration(_quantity, 'quantity');
    registerForRestoration(_giftWrap, 'gift_wrap');
    registerForRestoration(_shipping, 'shipping');
    registerForRestoration(_note, 'note');
  }

  @override
  void dispose() {
    _quantity.dispose();
    _giftWrap.dispose();
    _shipping.dispose();
    _note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Order')),
      body: ListView(
        restorationId: 'order_list',
        children: [
          ListTile(
            title: Text('Quantity: ${_quantity.value}'),
            trailing: IconButton(
              icon: const Icon(Icons.add),
              onPressed: () => setState(() => _quantity.value++),
            ),
          ),
          CheckboxListTile(
            title: const Text('Gift wrap'),
            value: _giftWrap.value,
            onChanged: (v) => setState(() => _giftWrap.value = v ?? false),
          ),
          SwitchListTile(
            title: Text('Shipping: ${_shipping.value.name}'),
            value: _shipping.value == Shipping.express,
            onChanged: (v) => setState(() =>
                _shipping.value = v ? Shipping.express : Shipping.standard),
          ),
          TextField(
            controller: _note.value,
            decoration: const InputDecoration(labelText: 'Note'),
          ),
          TextField(
            restorationId: 'coupon',
            decoration: const InputDecoration(labelText: 'Coupon'),
          ),
          // ... more rows
        ],
      ),
    );
  }
}
```

Einige bemerkenswerte Punkte:

- Sie lesen und schreiben `.value` und rufen weiterhin `setState` auf. Ein `RestorableValue` benachrichtigt das Mixin, damit der Bucket aktualisiert wird, baut Ihr Widget aber nicht für Sie neu auf.
- `restoreState` ist die einzige Stelle, an der Sie `registerForRestoration` aufrufen. Das Framework ruft es einmal beim ersten Build auf (mit `initialRestore: true`) und erneut, wann immer der Bucket unter Ihnen ausgetauscht wird. Das Registrieren einer Eigenschaft lädt ihren gespeicherten Wert, falls vorhanden, andernfalls ihren Standardwert.
- Restorable-Eigenschaften sind `ChangeNotifier`. Geben Sie sie in `dispose()` frei, danach räumt `RestorationMixin` in `super.dispose()` seine eigene Buchführung auf.
- `RestorableTextEditingController` liefert über `.value` einen echten `TextEditingController`. Wenn Sie nur den Text und nicht den Controller brauchen, leistet `TextField(restorationId: 'coupon')` intern dasselbe. Zu den eingebauten Widgets, die eine `restorationId` akzeptieren, gehören `TextField`, `TextFormField`, `Scrollable`-basierte Widgets (`ListView`, `GridView`, `CustomScrollView`, `SingleChildScrollView`, `PageView`), `Scaffold` (geöffneter Zustand der Schublade), `FormField`, `DropdownMenu` sowie die Datums- und Zeitauswahl.

## Verifizierung mit einem echten Prozess-Kill

Widget-Tests sind schnell, aber die Behauptung, die sich zu beweisen lohnt, ist, dass dies einen echten Kill übersteht. Ich habe ein Release-APK der obigen App gebaut, auf einem arm64-Emulator mit API 36 installiert, das Formular ausgefüllt und dann den Tod bei Speichermangel simuliert:

```bash
# Flutter 3.44.8 release APK on an Android 16 (API 36) emulator
flutter build apk --release
adb install -r build/app/outputs/flutter-apk/app-release.apk
# ...interact with the app, then send it to the background:
adb shell input keyevent KEYCODE_HOME
adb shell am kill net.startdebugging.restore_demo     # only kills background processes
adb shell pidof net.startdebugging.restore_demo        # prints nothing: the process is gone
adb shell am start -n net.startdebugging.restore_demo/.MainActivity
```

`am start` gab "Activity not started, its current task has been brought to the front" aus, was genau dem entspricht, was ein Tippen in den zuletzt verwendeten Apps bewirkt. Der neue Prozess hatte eine andere PID (5813 vorher, 6210 nachher). Auf dem Bildschirm:

| Feld | Vor dem Kill | Nach dem Kill |
| --- | --- | --- |
| `RestorableInt` quantity | 3 | 3 |
| einfacher `int`-Zähler | 1 | 0 |
| `RestorableBool` gift wrap | angehakt | angehakt |
| `RestorableEnum` shipping | express | express |
| `RestorableTextEditingController` note | "leave at door" | "leave at door" |
| `TextField(restorationId:)` coupon | "SAVE10" | "SAVE10" |
| `TextField` ohne restorationId | "gone" | leer |
| `ListView(restorationId:)` scroll | gescrollt | gleiche Position |

Danach die Negativfälle mit demselben Build: Das Wegwischen des Tasks aus den zuletzt verwendeten Apps und ein erneuter Start ergaben quantity 1, ebenso `am force-stop` mit anschließendem Start. Wie erwartet stellt nur der vom System ausgelöste Tod wieder her.

Sie können auch **Entwickleroptionen > Aktivitäten nicht beibehalten** einschalten (`adb shell settings put global always_finish_activities 1`). Das zerstört die Activity, sobald Sie sie verlassen, hält den Prozess aber am Leben (die PID änderte sich in meinem Durchlauf nicht), und der Zustand wurde auf dieselbe Weise wiederhergestellt. Das ist eine bequeme manuelle Prüfung, aber `am kill` entspricht dem echten Prozesstod besser, weil es auch den Dart-Heap verwirft.

## Den Navigationsstapel wiederherstellen

Der `Navigator` der App stellt seinen Routenverlauf automatisch wieder her, sobald `restorationScopeId` gesetzt ist, aber nur für Routen, die er neu erzeugen kann. Eine mit `Navigator.push(context, MaterialPageRoute(...))` gepushte Route hält eine Closure, und Closures lassen sich nicht serialisieren. Verwenden Sie `restorablePush`, das eine statische oder Top-Level-Funktion sowie Argumente erwartet, die `StandardMessageCodec` kodieren kann:

```dart
// Flutter 3.44.8
@pragma('vm:entry-point')
Route<void> _summaryRoute(BuildContext context, Object? arguments) {
  return MaterialPageRoute<void>(
    builder: (_) => SummaryPage(quantity: arguments! as int),
  );
}

// in the button's onPressed:
Navigator.restorablePush(context, _summaryRoute, arguments: _quantity.value);
```

Gleicher Emulator, gleiche Kill-Sequenz: Nach `restorablePush` kam die App mit "Ordering 3" auf der Summary-Seite zurück. Nach einem einfachen `push` kam sie auf der Order-Seite zurück, wobei die Summary-Seite stillschweigend verworfen wurde.

Benannte Routen funktionieren genauso mit `Navigator.restorablePushNamed`. Wenn Sie eine Route pushen und ihr Ergebnis benötigen, verpacken Sie sie in ein `RestorableRouteFuture<T>` und registrieren dieses wie jede andere Eigenschaft, damit der `onComplete`-Callback nach der Wiederherstellung wieder verbunden wird. `showDatePicker`- und `showTimePicker`-Dialoge werden über denselben Mechanismus wiederhergestellt, wenn Sie sie mit einem `RestorableRouteFuture` und der `restorationId` von `DatePickerDialog` öffnen.

Bei go_router übergeben Sie `restorationScopeId` an den `GoRouter`-Konstruktor und an `MaterialApp.router` und geben `ShellRoute` für verschachtelte Navigatoren eine eigene `restorationScopeId`. go_router erzeugt die `Page`-Objekte für Sie, daher rufen Sie dort `restorablePush` nicht auf, aber führen Sie einen `restartAndRestore`-Test (unten) gegen Ihre echte Routentabelle aus, bevor Sie ihm vertrauen.

## Ein RestorableValue für den eigenen Typ schreiben

Die eingebauten Typen decken Primitive ab (`RestorableInt`, `RestorableDouble`, `RestorableString`, `RestorableBool` und ihre nullbaren `N`-Varianten), außerdem `RestorableDateTime`, `RestorableEnum`, `RestorableTimeOfDay` und `RestorableTextEditingController`. Für alles andere leiten Sie von `RestorableValue<T>` ab und konvertieren von und zu Typen, die `StandardMessageCodec` unterstützt (null, bool, num, String, `Uint8List` und Verwandte, `List`, `Map`):

```dart
// Flutter 3.44.8
class PriceFilter {
  const PriceFilter({required this.min, required this.max, required this.inStockOnly});
  final double min;
  final double max;
  final bool inStockOnly;
}

class RestorablePriceFilter extends RestorableValue<PriceFilter> {
  RestorablePriceFilter(this._defaultValue);
  final PriceFilter _defaultValue;

  @override
  PriceFilter createDefaultValue() => _defaultValue;

  @override
  void didUpdateValue(PriceFilter? oldValue) => notifyListeners();

  @override
  PriceFilter fromPrimitives(Object? data) {
    final map = (data! as Map<Object?, Object?>).cast<String, Object?>();
    return PriceFilter(
      min: map['min']! as double,
      max: map['max']! as double,
      inStockOnly: map['inStock']! as bool,
    );
  }

  @override
  Object toPrimitives() => <String, Object>{
        'min': value.min,
        'max': value.max,
        'inStock': value.inStockOnly,
      };
}
```

Zwei Details, über die man leicht stolpert. `didUpdateValue` muss `notifyListeners()` aufrufen, sonst erfährt das Mixin nie, dass sich der Wert geändert hat, und der Bucket behält die alten Daten. Und die Map kommt als `Map<Object?, Object?>` zurück, nicht als `Map<String, Object>`, also casten Sie sie, statt `as Map<String, Object>` zu verwenden, was eine Exception wirft. In einem Widget-Test gab das Setzen des Filters auf `min: 10, max: 50, inStockOnly: true` und ein Neustart nach der Wiederherstellung `50.0 true` aus.

## Wiederherstellung ohne Gerät testen

`flutter_test` kann den gesamten Hin- und Rückweg simulieren. `restartAndRestore` greift die aktuellen Restoration-Daten ab, baut den Widget-Baum ab und erstellt ihn aus diesen Daten neu, was der Dart-Seite eines Prozessneustarts entspricht:

```dart
// Flutter 3.44.8, flutter_test
testWidgets('order state survives restart', (tester) async {
  await tester.pumpWidget(const App());
  await tester.tap(find.byIcon(Icons.add));
  await tester.tap(find.byIcon(Icons.add));
  await tester.pump();

  await tester.restartAndRestore();

  expect(find.text('Quantity: 3'), findsOneWidget);
});
```

Die Ergebnisse stimmten exakt mit dem Emulator überein: Restorable-Felder und die `ListView`-Position (580.0 vorher, 580.0 nachher) kamen zurück, der einfache Zähler und das nicht registrierte `TextField` nicht, und eine `restorablePush`-Route überlebte, während eine `push`-Route es nicht tat. Schlägt der Test mit "The current widget tree did not inject the root bucket of the RestorationManager" fehl, haben Sie `restorationScopeId` an der App vergessen.

## Stolperfallen beim Testen

**`restorablePush` mit einer statischen Methode kann den Test hängen lassen.** Die Flutter-Dokumentation zeigt den Route-Builder als `static`-Methode der `State`-Klasse mit `@pragma('vm:entry-point')`. Unter Flutter 3.44.8 schlug das bei mir unter `flutter test` mit "To access 'package:restore_demo/main.dart::_OrderPageState' from native code, it must be annotated" fehl, und der Test wurde nie beendet. Die VM löst das Callback-Handle über die umschließende Klasse auf, daher braucht auch die Klasse das Pragma. Annotieren Sie entweder zusätzlich die `State`-Klasse mit `@pragma('vm:entry-point')` oder, einfacher, machen Sie den Builder wie oben gezeigt zu einer Top-Level-Funktion. Beides lief durch.

**Doppelte IDs schlagen zur Laufzeit fehl.** Zwei Widgets, die dieselbe `restorationId` unter demselben Eltern-Bucket beanspruchen, lösen am Ende des Frames "Multiple owners claimed child RestorationBuckets with the same IDs" aus. Bilden Sie die ID in Listen aus dem stabilen Schlüssel des Elements (`'item_${item.id}'`), niemals aus dem Index, oder verpacken Sie jeden Teilbaum in einen eigenen `RestorationScope`.

**Kein Root-Scope bedeutet keinen Fehler, nur keine Wiederherstellung.** Ohne `restorationScopeId` läuft Ihr `restoreState` trotzdem, mit `bucket == null`, und die Eigenschaften funktionieren als gewöhnliche In-Memory-Werte. Nichts weist Sie darauf hin, dass sie nicht gespeichert werden. Ein einziger `restartAndRestore`-Test deckt das auf.

**Halten Sie die Daten klein.** Die Bytes wandern durch das saved-instance-state-`Bundle` von Android, das eine Binder-Transaktion durchquert. Eine große Nutzlast löst `TransactionTooLargeException` aus. Speichern Sie IDs und Formulareingaben, nicht Listen abgerufener Datensätze; laden Sie Daten nach der Wiederherstellung erneut aus Ihrem Repository.

**Gecachte Engines stellen standardmäßig nicht wieder her.** In Add-to-App-Setups mit `FlutterActivity.withCachedEngine` gibt `shouldRestoreAndSaveState()` `false` zurück, damit Restoration-Daten den Zustand einer laufenden Engine nicht überschreiben. Überschreiben Sie es in Ihrer `FlutterActivity`-Unterklasse, wenn Sie dort Wiederherstellung wünschen.

**Wiederherstellung ist keine Persistenz.** Sie übersteht Prozesstod, nicht aber das Beenden der App, einen Neustart oder das Wegwischen aus den zuletzt verwendeten Apps. Entwürfe, die der Nutzer morgen wiederfinden soll, gehören in `shared_preferences` oder eine Datenbank.

**iOS erfordert zusätzliche Einrichtung.** Derselbe Dart-Code funktioniert unter iOS, aber Sie müssen dem `FlutterViewController` im iOS-Projekt außerdem eine Restoration-Kennung geben. Die offizielle Seite "Restore state on iOS" beschreibt die Schritte.

**Riverpod, Bloc und andere State-Holder werden nicht für Sie wiederhergestellt.** Der Zustand eines Providers lebt auf demselben Dart-Heap, der gestorben ist. Stellen Sie entweder die Eingaben (IDs, Filter, Formularfelder) mit Restorable-Eigenschaften wieder her und lassen Sie den Provider neu berechnen, oder speichern Sie den serialisierten Zustand des Providers in einem `RestorableValue` und initialisieren Sie ihn bei der Wiederherstellung damit.

## Weiterlesen

- [Fix: A TextEditingController was used after being disposed in Flutter](/de/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)
- [How to set up nested routes and deep links with go_router in Flutter](/de/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/)
- [go_router vs auto_route vs Navigator 2.0 in Flutter](/de/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/)
- [Migrate a setState StatefulWidget to a Riverpod Notifier in Flutter](/de/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)
- [How to catch uncaught async errors in Flutter with runZonedGuarded and PlatformDispatcher](/de/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/)

## Quellen

- [Restore state on Android, Flutter docs](https://docs.flutter.dev/platform-integration/android/restore-state-android)
- [Restore state on iOS, Flutter docs](https://docs.flutter.dev/platform-integration/ios/restore-state-ios)
- [RestorationMixin, Flutter API docs](https://api.flutter.dev/flutter/widgets/RestorationMixin-mixin.html)
- [RestorableValue, Flutter API docs](https://api.flutter.dev/flutter/widgets/RestorableValue-class.html)
- [Navigator.restorablePush, Flutter API docs](https://api.flutter.dev/flutter/widgets/Navigator/restorablePush.html)
- [WidgetTester.restartAndRestore, Flutter API docs](https://api.flutter.dev/flutter/flutter_test/WidgetTester/restartAndRestore.html)
- [GoRouter constructor, go_router API docs](https://pub.dev/documentation/go_router/latest/go_router/GoRouter/GoRouter.html)
- [Save UI states, Android Developers](https://developer.android.com/topic/libraries/architecture/saving-states)
