---
title: "Flutter で RestorationMixin を使って Android のプロセス終了後に UI 状態を復元する方法"
description: "Android はメモリを確保するためにバックグラウンドの Flutter アプリを終了させ、ユーザーが戻ってくると StatefulWidget はすべて初期状態から始まります。restorationScopeId、RestorationMixin、Restorable プロパティで復元を有効にし、テキストフィールド、スクロール位置、push したルートを復元し、独自の RestorableValue を書き、restartAndRestore と adb ですべてをテストする方法を解説します。Flutter 3.44.8 と Android 16 エミュレーターで検証済みです。"
pubDate: 2026-10-19
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "state-restoration"
  - "how-to"
lang: "ja"
translationOf: "2026/10/how-to-restore-ui-state-after-android-process-death-in-flutter-with-restorationmixin"
translatedBy: "claude"
translationDate: 2026-10-19
---

**結論:** `MaterialApp` に `restorationScopeId: 'app'` を設定し、ユーザーが失いたくないデータを持つすべての `State` に `RestorationMixin` を mixin します。そのデータは通常のフィールドではなく `RestorableInt`、`RestorableTextEditingController`、`RestorableEnum` などに保持し、それぞれを `restoreState` で登録し、画面遷移には `Navigator.push` の代わりに `Navigator.restorablePush` を使います。すると Flutter はこれらの値を Android の saved-instance-state `Bundle` にシリアライズし、Android が新しいプロセスでアクティビティを再作成したときに、最初のフレームより前にフレームワークが値を戻します。以下の内容はすべて Flutter 3.44.8 (Dart 3.12.2) で、ウィジェットテストと Android 16 (API 36) エミュレーター上の実際のプロセス終了によって検証しました。`restoration.dart` は 2025 年 7 月以降 `stable` ブランチで変更されていません。

この記事では、プロセス終了とは実際に何なのか、そしてなぜ状態が消えるのかを説明し、それを乗り越える小さな注文フォームを作ります。さらにルートとスクロール位置の扱い、自作クラス用の `RestorableValue` の書き方、テスト中に遭遇した落とし穴を紹介します。その中には、ルートビルダーをトップレベル関数に移すまで `restorablePush` が失敗する問題も含まれます。

## プロセス終了とは何か、なぜ Flutter の状態は残らないのか

ユーザーがアプリから離れると、Android はアクティビティを停止しますが、プロセス自体は残します。メモリが逼迫すると、システムはそのバックグラウンドプロセスを終了させます。ユーザーには通知されず、アプリは最後のスクリーンショットとともに最近使ったアプリに表示され続けます。ユーザーがそれをタップすると、Android は新しいプロセスを起動し、新しい `FlutterActivity` を作成して、古いアクティビティが `onSaveInstanceState` で書き込んだ `Bundle` を渡します。

Flutter アプリは UI 状態のすべてを、その終了したプロセスのヒープ上にある Dart オブジェクトとして保持しています。新しいプロセスは新しい Dart isolate、新しい `main()`、新しい `State` オブジェクトを意味します。カウンター、フォームのフィールド、ナビゲーションスタックを `Bundle` に書き込んでいなければ、それらは失われ、ユーザーは空のフォームが表示されたホーム画面に戻されます。これは"写真を撮って戻ったら、アプリがすべて忘れていた"という典型的なバグです。

Flutter の状態復元フレームワークが、その `Bundle` に書き込む部分を担当します。Android では `FlutterActivityAndFragmentDelegate` が、フレームワークのシリアライズ済みデータをバイト配列としてキー `"framework"` に (プラグインの状態は `"plugins"` に) 保存します。ウィジェットツリーが明示的に有効にしない限り何も保存されないため、ほとんどのアプリはこの機能の存在に気づきません。

次の 2 つはプロセス終了ではないため、設計上、何も復元されません。

- ユーザーが最近使ったアプリからアプリをスワイプして消した場合。タスクが削除され、保存された状態も一緒に消えます。
- アプリが強制停止された場合 (設定、または `adb shell am force-stop`)。結果は同じです。

どちらも下記のエミュレーターで確認しました。復元が対象とするのは、"バックグラウンドにいる間にシステムに終了された"場合だけです。

## 復元を有効にするために必要な 3 つの要素

状態復元は `RestorationBucket` のツリーです。ツリーの各部分は親から ID でバケットを取得し、末端の値はそのバケットの中に保存されます。必要なものは次のとおりです。

1. **ルートスコープ。** `MaterialApp(restorationScopeId: 'app')` (または `CupertinoApp`、`WidgetsApp`) は `RootRestorationScope` を作成し、アプリの `Navigator` の復元も有効にします。これがないと書き込み先のバケットがなく、すべての子は `null` を受け取ります。
2. **`State` に `RestorationMixin`。** オーバーライドした `restorationId` ゲッターを使って子バケットを取得します。
3. **Restorable プロパティ。** `RestorableProperty<T>` のサブクラスは値をラップし、それを `StandardMessageCodec` がエンコードできるプリミティブに変換する方法を知っています。それぞれをバケット内で一意のキーを付けて登録します。

## プロセス終了を乗り越える最小の注文フォーム

これは、この記事のすべてのテストで使った画面です。数量、チェックボックス、enum、2 つのテキストフィールド、長いリストに加え、対比用の通常の `int` フィールドが 1 つあります。

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

注目すべき点がいくつかあります。

- `.value` を読み書きし、さらに `setState` も呼びます。`RestorableValue` は mixin に通知してバケットを更新させますが、ウィジェットを再ビルドしてはくれません。
- `registerForRestoration` を呼ぶのは `restoreState` の中だけです。フレームワークは最初のビルド時に一度 (`initialRestore: true` で) 呼び出し、その後はバケットが差し替えられるたびに再度呼び出します。プロパティを登録すると、保存済みの値があればそれが読み込まれ、なければデフォルト値が使われます。
- Restorable プロパティは `ChangeNotifier` です。`dispose()` で破棄してください。その後 `super.dispose()` の中で `RestorationMixin` が自身の管理情報をクリーンアップします。
- `RestorableTextEditingController` は `.value` を通じて本物の `TextEditingController` を返します。コントローラーが不要でテキストだけ必要なら、`TextField(restorationId: 'coupon')` が内部で同じことをします。`restorationId` を受け取る組み込みウィジェットには、`TextField`、`TextFormField`、`Scrollable` ベースのウィジェット (`ListView`、`GridView`、`CustomScrollView`、`SingleChildScrollView`、`PageView`)、`Scaffold` (ドロワーの開閉状態)、`FormField`、`DropdownMenu`、日付と時刻のピッカーがあります。

## 実際のプロセス終了で検証する

ウィジェットテストは高速ですが、証明すべきなのは実際の終了を乗り越えられるかどうかです。上のアプリのリリース APK をビルドして API 36 の arm64 エミュレーターにインストールし、フォームに入力してから、低メモリによる終了をシミュレートしました。

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

`am start` は "Activity not started, its current task has been brought to the front" と出力しました。これは最近使ったアプリでタップした場合とまったく同じ挙動です。新しいプロセスの PID は異なっていました (終了前が 5813、終了後が 6210)。画面上の結果は次のとおりです。

| フィールド | 終了前 | 終了後 |
| --- | --- | --- |
| `RestorableInt` quantity | 3 | 3 |
| 通常の `int` カウンター | 1 | 0 |
| `RestorableBool` gift wrap | チェック済み | チェック済み |
| `RestorableEnum` shipping | express | express |
| `RestorableTextEditingController` note | "leave at door" | "leave at door" |
| `TextField(restorationId:)` coupon | "SAVE10" | "SAVE10" |
| restorationId なしの `TextField` | "gone" | 空 |
| `ListView(restorationId:)` スクロール | スクロール済み | 同じオフセット |

次に、同じビルドで否定的なケースも試しました。最近使ったアプリからタスクをスワイプして消してから再起動すると quantity は 1 になり、`am force-stop` の後に起動した場合も同様でした。想定どおり、システムが開始した終了の場合だけ復元されます。

**開発者向けオプション > アクティビティを保持しない** (`adb shell settings put global always_finish_activities 1`) を有効にすることもできます。これはアクティビティから離れた時点で破棄しますがプロセスは生かしたままで (私の実行では PID は変わりませんでした)、状態は同じように復元されました。手動確認には便利ですが、`am kill` は Dart ヒープも破棄するため、実際のプロセス終了により近い方法です。

## ナビゲーションスタックを復元する

アプリの `Navigator` は、`restorationScopeId` を設定すると自動的にルート履歴を復元しますが、再作成できるルートに限られます。`Navigator.push(context, MaterialPageRoute(...))` で push したルートはクロージャを保持しており、クロージャはシリアライズできません。`restorablePush` を使ってください。これは static またはトップレベルの関数と、`StandardMessageCodec` がエンコードできる引数を受け取ります。

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

同じエミュレーター、同じ終了手順で、`restorablePush` を使った場合はアプリが "Ordering 3" と表示された Summary ページに戻ってきました。通常の `push` の場合は Order ページに戻り、Summary ページは何も通知されずに消えていました。

名前付きルートは `Navigator.restorablePushNamed` で同様に動作します。ルートを push して結果が必要な場合は、`RestorableRouteFuture<T>` でラップし、他のプロパティと同様に登録してください。そうすれば復元後に `onComplete` コールバックが再接続されます。`showDatePicker` と `showTimePicker` のダイアログも、`RestorableRouteFuture` と `DatePickerDialog` の `restorationId` で開くと同じ仕組みで復元されます。

go_router では、`GoRouter` コンストラクターと `MaterialApp.router` の両方に `restorationScopeId` を渡し、ネストした Navigator のために `ShellRoute` に専用の `restorationScopeId` を与えます。go_router は `Page` オブジェクトを代わりに構築するので、そこで `restorablePush` を呼ぶことはありませんが、信頼する前に、実際のルートテーブルに対して `restartAndRestore` テスト (後述) を実行してください。

## 独自の型のための RestorableValue を書く

組み込みでカバーされるのは、プリミティブ (`RestorableInt`、`RestorableDouble`、`RestorableString`、`RestorableBool` とその null 許容の `N` バリアント)、`RestorableDateTime`、`RestorableEnum`、`RestorableTimeOfDay`、`RestorableTextEditingController` です。それ以外は `RestorableValue<T>` をサブクラス化し、`StandardMessageCodec` がサポートする型 (null、bool、num、String、`Uint8List` など、`List`、`Map`) との間で変換します。

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

つまずきやすい点が 2 つあります。`didUpdateValue` は `notifyListeners()` を呼ばなければなりません。そうしないと mixin は値の変更を知ることができず、バケットに古いデータが残ります。また、マップは `Map<String, Object>` ではなく `Map<Object?, Object?>` として返ってくるので、`as Map<String, Object>` を使わずにキャストしてください。使うと例外が発生します。ウィジェットテストで、フィルターを `min: 10, max: 50, inStockOnly: true` に設定して再起動すると、復元後に `50.0 true` が出力されました。

## デバイスなしで復元をテストする

`flutter_test` はラウンドトリップ全体をシミュレートできます。`restartAndRestore` は現在の復元データを取得し、ウィジェットツリーを破棄して、そのデータから再構築します。これはプロセス再起動の Dart 側にあたります。

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

結果はエミュレーターと完全に一致しました。restorable なフィールドと `ListView` のオフセット (前が 580.0、後も 580.0) は戻り、通常のカウンターと未登録の `TextField` は戻らず、`restorablePush` のルートは残り、`push` のルートは残りませんでした。テストが "The current widget tree did not inject the root bucket of the RestorationManager" で失敗する場合は、アプリに `restorationScopeId` を設定し忘れています。

## テスト中に遭遇した落とし穴

**static メソッドを使う `restorablePush` はテストをハングさせることがあります。** Flutter のドキュメントでは、ルートビルダーを `@pragma('vm:entry-point')` 付きの `State` クラスの `static` メソッドとして示しています。Flutter 3.44.8 の `flutter test` では、これは "To access 'package:restore_demo/main.dart::_OrderPageState' from native code, it must be annotated" で失敗し、テストが終了しませんでした。VM はコールバックハンドルを外側のクラス経由で解決するため、クラスにも pragma が必要です。`State` クラスにも `@pragma('vm:entry-point')` を付けるか、もっと簡単には、上記のようにビルダーをトップレベル関数にしてください。どちらも成功しました。

**ID の重複は実行時に失敗します。** 同じ親バケットの下で同じ `restorationId` を取得する 2 つのウィジェットがあると、フレームの終わりに "Multiple owners claimed child RestorationBuckets with the same IDs" がスローされます。リストでは、インデックスではなくアイテムの安定したキーから ID を作る (`'item_${item.id}'`) か、各サブツリーを専用の `RestorationScope` で包んでください。

**ルートスコープがなくてもエラーにはならず、復元されないだけです。** `restorationScopeId` がなくても `restoreState` は `bucket == null` で実行され、プロパティは通常のメモリ上の値として動作します。保存されていないことを教えてくれるものはありません。`restartAndRestore` テストを 1 つ書けばこれを検出できます。

**データは小さく保ってください。** バイト列は Android の saved-instance-state `Bundle` を通り、Binder トランザクションを経由します。大きなペイロードは `TransactionTooLargeException` をスローします。取得したレコードのリストではなく、ID とフォームの入力値を保存し、復元後にリポジトリからデータを再取得してください。

**キャッシュされたエンジンはデフォルトでは復元しません。** `FlutterActivity.withCachedEngine` を使う add-to-app 構成では、復元データが稼働中のエンジンの状態を上書きしないように、`shouldRestoreAndSaveState()` が `false` を返します。そこでも復元したい場合は、`FlutterActivity` のサブクラスでオーバーライドしてください。

**復元は永続化ではありません。** 復元されるのはプロセス終了の場合であり、アプリの終了、再起動、最近使ったアプリからのスワイプでは復元されません。ユーザーが翌日も残っていると期待する下書きは `shared_preferences` やデータベースに保存してください。

**iOS では追加の設定が必要です。** 同じ Dart コードが iOS でも動作しますが、iOS プロジェクトで `FlutterViewController` に復元識別子を設定する必要もあります。手順は公式の "Restore state on iOS" ページに記載されています。

**Riverpod、Bloc などの状態保持オブジェクトは自動では復元されません。** プロバイダーの状態は、終了したのと同じ Dart ヒープ上にあります。入力 (ID、フィルター、フォームのフィールド) を restorable プロパティで復元してプロバイダーに再計算させるか、プロバイダーのシリアライズした状態を `RestorableValue` に保存して復元時に反映してください。

## 関連記事

- [Fix: A TextEditingController was used after being disposed in Flutter](/ja/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)
- [How to set up nested routes and deep links with go_router in Flutter](/ja/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/)
- [go_router vs auto_route vs Navigator 2.0 in Flutter](/ja/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/)
- [Migrate a setState StatefulWidget to a Riverpod Notifier in Flutter](/ja/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)
- [How to catch uncaught async errors in Flutter with runZonedGuarded and PlatformDispatcher](/ja/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/)

## 参考資料

- [Restore state on Android, Flutter docs](https://docs.flutter.dev/platform-integration/android/restore-state-android)
- [Restore state on iOS, Flutter docs](https://docs.flutter.dev/platform-integration/ios/restore-state-ios)
- [RestorationMixin, Flutter API docs](https://api.flutter.dev/flutter/widgets/RestorationMixin-mixin.html)
- [RestorableValue, Flutter API docs](https://api.flutter.dev/flutter/widgets/RestorableValue-class.html)
- [Navigator.restorablePush, Flutter API docs](https://api.flutter.dev/flutter/widgets/Navigator/restorablePush.html)
- [WidgetTester.restartAndRestore, Flutter API docs](https://api.flutter.dev/flutter/flutter_test/WidgetTester/restartAndRestore.html)
- [GoRouter constructor, go_router API docs](https://pub.dev/documentation/go_router/latest/go_router/GoRouter/GoRouter.html)
- [Save UI states, Android Developers](https://developer.android.com/topic/libraries/architecture/saving-states)
