---
title: "How to Restore UI State After Android Process Death in Flutter with RestorationMixin"
description: "Android kills backgrounded Flutter apps to reclaim memory, and when the user comes back every StatefulWidget starts from scratch. Here is how to opt in with restorationScopeId, RestorationMixin and Restorable properties, restore text fields, scroll offsets and pushed routes, write a custom RestorableValue, and test it all with restartAndRestore and adb, verified on Flutter 3.44.8 and an Android 16 emulator."
pubDate: 2026-10-19
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "state-restoration"
  - "how-to"
---

**Short answer:** set `restorationScopeId: 'app'` on your `MaterialApp`, mix `RestorationMixin` into every `State` that holds something the user would hate to lose, store that data in `RestorableInt`, `RestorableTextEditingController`, `RestorableEnum` and friends instead of plain fields, register each one in `restoreState`, and push screens with `Navigator.restorablePush` instead of `Navigator.push`. Flutter then serializes those values into Android's saved-instance-state `Bundle`, and when Android recreates the activity in a fresh process the framework puts them back before the first frame. Everything below was verified on Flutter 3.44.8 (Dart 3.12.2) with widget tests and with real process kills on an Android 16 (API 36) emulator; `restoration.dart` has not changed on the `stable` branch since July 2025.

The rest of this post explains what process death actually is and why your state vanishes, builds a small order form that survives it, covers routes and scroll positions, shows how to write a `RestorableValue` for your own class, and lists the gotchas I hit while testing, including one where `restorablePush` fails until you move the route builder to a top-level function.

## What process death is and why Flutter state does not survive it

When the user switches away from your app, Android stops the activity but keeps the process around. If memory gets tight, the system kills that background process. It does not tell the user: the app still shows up in Recents with its last screenshot. When the user taps it, Android starts a new process, creates a new `FlutterActivity`, and hands it the `Bundle` that the old activity wrote in `onSaveInstanceState`.

A Flutter app keeps all of its UI state in Dart objects on the heap of that dead process. A new process means a new Dart isolate, a new `main()`, and fresh `State` objects. Unless something wrote your counters, form fields and navigation stack into that `Bundle`, they are gone, and the user is dropped back on your home screen with an empty form. This is the classic "I took a photo, came back, and the app forgot everything" bug.

Flutter's state restoration framework is the piece that writes into that `Bundle`. On Android, `FlutterActivityAndFragmentDelegate` stores the framework's serialized data as a byte array under the key `"framework"` (and plugin state under `"plugins"`). Nothing is saved unless your widget tree opts in, which is why most apps never notice the feature exists.

Two things that are *not* process death, and therefore restore nothing by design:

- The user swipes the app away from Recents. The task is removed and the saved state with it.
- The app is force-stopped (Settings, or `adb shell am force-stop`). Same result.

I checked both on the emulator below. Restoration is only for the "system killed me while I was in the background" case.

## The three pieces you need to opt in

State restoration is a tree of `RestorationBucket`s. Each piece of the tree claims a bucket by ID from its parent, and leaf values are stored inside those buckets. You need:

1. **A root scope.** `MaterialApp(restorationScopeId: 'app')` (or `CupertinoApp`, `WidgetsApp`) creates a `RootRestorationScope` and also turns on restoration for the app's `Navigator`. Without it, there is no bucket to write to and every child gets `null`.
2. **`RestorationMixin` on your `State`.** It claims a child bucket using the `restorationId` getter you override.
3. **Restorable properties.** `RestorableProperty<T>` subclasses wrap a value and know how to turn it into primitives that `StandardMessageCodec` can encode. You register each one with a unique key inside the bucket.

## A minimal order form that survives process death

Here is the screen I used for every test in this post. It has a quantity, a checkbox, an enum, two text fields and a long list, plus one plain `int` field for contrast.

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

A few things worth noticing:

- You read and write `.value`, and you still call `setState`. A `RestorableValue` notifies the mixin so the bucket gets updated, but it does not rebuild your widget for you.
- `restoreState` is the only place you call `registerForRestoration`. The framework calls it once on first build (with `initialRestore: true`) and again whenever the bucket is swapped out underneath you. Registering a property loads its saved value if one exists, or its default if not.
- Restorable properties are `ChangeNotifier`s. Dispose them in `dispose()`, after which `RestorationMixin` cleans up its own bookkeeping in `super.dispose()`.
- `RestorableTextEditingController` gives you a real `TextEditingController` through `.value`. If you only need the text and not the controller, `TextField(restorationId: 'coupon')` does the same thing internally. Built-in widgets that accept a `restorationId` include `TextField`, `TextFormField`, `Scrollable`-based widgets (`ListView`, `GridView`, `CustomScrollView`, `SingleChildScrollView`, `PageView`), `Scaffold` (drawer open state), `FormField`, `DropdownMenu`, and the date and time pickers.

## Verifying it with a real process kill

Widget tests are fast, but the claim worth proving is that this survives an actual kill. I built a release APK of the app above, installed it on an API 36 arm64 emulator, filled in the form, and then simulated low-memory death:

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

`am start` printed "Activity not started, its current task has been brought to the front", which is exactly what a tap in Recents does. The new process had a different PID (5813 before, 6210 after). On screen:

| Field | Before kill | After kill |
| --- | --- | --- |
| `RestorableInt` quantity | 3 | 3 |
| plain `int` counter | 1 | 0 |
| `RestorableBool` gift wrap | checked | checked |
| `RestorableEnum` shipping | express | express |
| `RestorableTextEditingController` note | "leave at door" | "leave at door" |
| `TextField(restorationId:)` coupon | "SAVE10" | "SAVE10" |
| `TextField` with no restorationId | "gone" | empty |
| `ListView(restorationId:)` scroll | scrolled | same offset |

Then the negative cases on the same build: swiping the task out of Recents and relaunching gave quantity 1, and so did `am force-stop` followed by a launch. As expected, only system-initiated death restores.

You can also turn on **Developer options > Don't keep activities** (`adb shell settings put global always_finish_activities 1`). That destroys the activity as soon as you leave it but keeps the process alive (the PID did not change in my run), and state was restored the same way. It is a convenient manual check, but `am kill` is the closer match to real process death because it also throws away the Dart heap.

## Restoring the navigation stack

The app's `Navigator` restores its route history automatically once `restorationScopeId` is set, but only for routes it can recreate. A route pushed with `Navigator.push(context, MaterialPageRoute(...))` holds a closure, and closures cannot be serialized. Use `restorablePush`, which takes a static or top-level function plus arguments that `StandardMessageCodec` can encode:

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

Same emulator, same kill sequence: after `restorablePush` the app came back on the Summary page with "Ordering 3". After a plain `push` it came back on the Order page, with the Summary page silently dropped.

Named routes work the same way with `Navigator.restorablePushNamed`. If you push a route and need its result, wrap it in a `RestorableRouteFuture<T>` and register that like any other property, so the `onComplete` callback is reconnected after restoration. `showDatePicker` and `showTimePicker` dialogs restore through the same mechanism when you open them with a `RestorableRouteFuture` and `DatePickerDialog`'s `restorationId`.

With go_router, pass `restorationScopeId` to the `GoRouter` constructor and to `MaterialApp.router`, and give `ShellRoute` its own `restorationScopeId` for nested navigators. go_router builds the `Page` objects for you, so `restorablePush` is not something you call there, but run a `restartAndRestore` test (below) against your real route table before trusting it.

## Writing a RestorableValue for your own type

The built-ins cover primitives (`RestorableInt`, `RestorableDouble`, `RestorableString`, `RestorableBool` and their nullable `N` variants), `RestorableDateTime`, `RestorableEnum`, `RestorableTimeOfDay` and `RestorableTextEditingController`. For anything else, subclass `RestorableValue<T>` and convert to and from types that `StandardMessageCodec` supports (null, bool, num, String, `Uint8List` and friends, `List`, `Map`):

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

Two details that bite people. `didUpdateValue` must call `notifyListeners()`, otherwise the mixin never learns that the value changed and the bucket keeps the old data. And the map comes back as `Map<Object?, Object?>`, not `Map<String, Object>`, so cast it instead of using `as Map<String, Object>`, which throws. In a widget test, setting the filter to `min: 10, max: 50, inStockOnly: true` and restarting printed `50.0 true` after restore.

## Testing restoration without a device

`flutter_test` can simulate the whole round trip. `restartAndRestore` grabs the current restoration data, tears down the widget tree, and rebuilds it from that data, which is the Dart side of a process restart:

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

The results matched the emulator exactly: restorable fields and the `ListView` offset (580.0 before, 580.0 after) came back, the plain counter and the unregistered `TextField` did not, and a `restorablePush` route survived while a `push` route did not. If the test fails with "The current widget tree did not inject the root bucket of the RestorationManager", you forgot `restorationScopeId` on the app.

## Gotchas I hit while testing

**`restorablePush` with a static method can hang the test.** The Flutter docs show the route builder as a `static` method on the `State` class with `@pragma('vm:entry-point')`. On Flutter 3.44.8 that failed for me under `flutter test` with "To access 'package:restore_demo/main.dart::_OrderPageState' from native code, it must be annotated", and the test never finished. The VM resolves the callback handle through the enclosing class, so the class needs the pragma too. Either annotate the `State` class with `@pragma('vm:entry-point')` as well, or, simpler, make the builder a top-level function as shown above. Both passed.

**Duplicate IDs fail at runtime.** Two widgets that claim the same `restorationId` under the same parent bucket throw "Multiple owners claimed child RestorationBuckets with the same IDs" at the end of the frame. In lists, build the ID from the item's stable key (`'item_${item.id}'`), never the index, or wrap each subtree in its own `RestorationScope`.

**No root scope means no error, just no restoration.** Without `restorationScopeId` your `restoreState` still runs, with `bucket == null`, and the properties work as ordinary in-memory values. Nothing tells you they are not being saved. A single `restartAndRestore` test catches this.

**Keep the data small.** The bytes travel through Android's saved-instance-state `Bundle`, which crosses a Binder transaction. A large payload throws `TransactionTooLargeException`. Store IDs and form inputs, not lists of fetched records; refetch data from your repository after restoration.

**Cached engines do not restore by default.** In add-to-app setups that use `FlutterActivity.withCachedEngine`, `shouldRestoreAndSaveState()` returns `false` so restoration data does not overwrite a live engine's state. Override it in your `FlutterActivity` subclass if you want restoration there.

**Restoration is not persistence.** It survives process death, not app exit, reboot, or a swipe from Recents. Drafts the user expects to find tomorrow belong in `shared_preferences` or a database.

**iOS needs extra setup.** The same Dart code works on iOS, but you also have to give the `FlutterViewController` a restoration identifier in the iOS project. The official "Restore state on iOS" page covers the steps.

**Riverpod, Bloc and other state holders are not restored for you.** A provider's state lives on the same Dart heap that died. Either restore the inputs (IDs, filters, form fields) with restorable properties and let the provider recompute, or save the provider's serialized state into a `RestorableValue` and seed it on restore.

## Read next

- [Fix: A TextEditingController was used after being disposed in Flutter](/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)
- [How to set up nested routes and deep links with go_router in Flutter](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/)
- [go_router vs auto_route vs Navigator 2.0 in Flutter](/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/)
- [Migrate a setState StatefulWidget to a Riverpod Notifier in Flutter](/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)
- [How to catch uncaught async errors in Flutter with runZonedGuarded and PlatformDispatcher](/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/)

## Sources

- [Restore state on Android, Flutter docs](https://docs.flutter.dev/platform-integration/android/restore-state-android)
- [Restore state on iOS, Flutter docs](https://docs.flutter.dev/platform-integration/ios/restore-state-ios)
- [RestorationMixin, Flutter API docs](https://api.flutter.dev/flutter/widgets/RestorationMixin-mixin.html)
- [RestorableValue, Flutter API docs](https://api.flutter.dev/flutter/widgets/RestorableValue-class.html)
- [Navigator.restorablePush, Flutter API docs](https://api.flutter.dev/flutter/widgets/Navigator/restorablePush.html)
- [WidgetTester.restartAndRestore, Flutter API docs](https://api.flutter.dev/flutter/flutter_test/WidgetTester/restartAndRestore.html)
- [GoRouter constructor, go_router API docs](https://pub.dev/documentation/go_router/latest/go_router/GoRouter/GoRouter.html)
- [Save UI states, Android Developers](https://developer.android.com/topic/libraries/architecture/saving-states)
