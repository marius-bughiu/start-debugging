---
title: "Flutter デスクトップアプリでマルチウィンドウ対応を有効にする方法"
description: "Flutter 3.44.8 stable には公開されたマルチウィンドウ API がまだありません。main チャンネルで実験的な windowing 機能フラグを有効にし、RegularWindowController と WindowManager で本物のトップレベルウィンドウを開く手順と、stable で今日リリースする場合の代替手段を解説します。"
pubDate: 2026-08-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "desktop"
  - "multi-window"
  - "windowing"
  - "how-to"
lang: "ja"
translationOf: "2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app"
translatedBy: "claude"
translationDate: 2026-08-04
---

Flutter のマルチウィンドウ対応は存在しますし、動作もします。ただし stable のビルドからは使えません。Flutter 3.44.8（2026-07-23 リリース）の時点で、フレームワークは `packages/flutter/lib/src/widgets/_window.dart` に完全な windowing API を同梱していますが、その中のクラスはすべて `@internal` が付いており、ファイルは `package:flutter/widgets.dart` からエクスポートされておらず、`windowing` 機能フラグが有効でない限りどのコンストラクターも `UnsupportedError` をスローします。このフラグは `main` チャンネルでしか利用できません。したがって誠実な答えはちょうど 2 つです。`main` に切り替えて `flutter config --enable-windowing` を実行し、本物のフレームワーク API でプロトタイプを作るか、stable にとどまって `desktop_multi_window` プラグインを使うかです。後者はエンジンと isolate が分かれる代償を払ってウィンドウを分離します。この記事では両方を、3.44 時点の正確な API 表面とともに扱います。

## なぜ `runApp` では 1 つのウィンドウしか得られないのか

シングルウィンドウが長く既定であり続けたのは怠慢だからではありません。`runApp` はウィジェットツリーを *暗黙のビュー*、つまり Dart が起動する前にプラットフォームの embedder が用意した唯一の `FlutterView` に接続するからです。この呼び出しには 2 つ目のビューを差し込む継ぎ目がなく、これまでも存在しませんでした。

逃げ道はしばらく前から `runWidget` でした。これは暗黙のビューを前提とせず、`View` または `ViewCollection` をルートとするウィジェットツリーを受け取ります。足りなかったのはもう半分、つまりプラットフォームにネイティブウィンドウを *作らせて*、それに結び付いた `FlutterView` を受け取る方法です。windowing API が追加するのはまさにそこです。Canonical が実装を主導しており、Flutter 3.44 ではデスクトップ 3 プラットフォームでのツールチップウィンドウ、macOS でのポップアップウィンドウ、サテライトウィンドウのコントローラー、そして windowing を裏側に持つ `showDialog` が入りました。

アーキテクチャーにとって最も重要な設計判断はこれです。**すべてのウィンドウが 1 つのエンジンと 1 つの isolate を共有します**。2 つのウィンドウは同じウィジェットツリーの 2 つのサブツリーです。共通の祖先が保持する `ValueNotifier` は両方から見えます。シリアライズも method channel も `SendPort` も不要です。これがプラグインベースのあらゆる手法との最大の違いであり、この API を待つのが正解になりやすい理由でもあります。

## windowing 機能フラグを有効にする

フラグは `flutter_tools` で次のように定義されています。

```dart
// packages/flutter_tools/lib/src/features.dart, Flutter 3.44.8
const windowingFeature = Feature(
  name: 'support for windowing on macOS, Linux, and Windows',
  configSetting: 'enable-windowing',
  environmentOverride: 'FLUTTER_WINDOWING',
  runtimeId: 'windowing',
  master: FeatureChannelSetting(available: true),
);
```

欠けているものに注目してください。`beta:` の項目も `stable:` の項目もないため、どちらも既定値の `FeatureChannelSetting()`、すなわち `available: false` になります。beta でも動きません。`main` か、さもなくば何もなしです。

有効化は 3 ステップです。

1. **main チャンネルに切り替えます。** `flutter channel main` を実行し、続いて `flutter upgrade` を実行します。既存の stable のツールチェーンをそのまま残したい場合は、唯一のチェックアウトを移動させるのではなく FVM で 2 つ目の SDK を固定してください。[1 つのプロジェクトを複数の Flutter SDK で CI 実行する](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)で説明した手法は、ローカルでもそのまま使えます。
2. **フラグをオンにします。** `flutter config --enable-windowing` を実行します。これは永続的な設定を書き込むので、SDK ごとに一度だけで済みます。CI では代わりに環境変数 `FLUTTER_WINDOWING=true` を設定してください。ツールはこれを上書き指定として読み取ります。
3. **hot restart ではなく再ビルドします。** ツールは有効な機能フラグを `FLUTTER_ENABLED_FEATURE_FLAGS` という名前のコンパイル時 define としてフレームワークに渡します。フレームワークは `packages/flutter/lib/src/foundation/_features.dart` でこれを読み取ります。

```dart
// packages/flutter/lib/src/foundation/_features.dart, Flutter 3.44.8
final Set<String> debugEnabledFeatureFlags = <String>{
  ...const String.fromEnvironment('FLUTTER_ENABLED_FEATURE_FLAGS').split(','),
};

bool isWindowingEnabled = debugEnabledFeatureFlags.contains('windowing');
```

`String.fromEnvironment` はビルド時に定数として評価されるため、設定を切り替えた後の hot restart では拾われません。アプリを終了し、`flutter run -d windows`（または `macos`、`linux`）をあらためて実行してください。

ステップ 2 を飛ばすと、覚えておく価値のある非常に具体的なエラーが出ます。レンダリング時ではなくコンストラクターからスローされるためです。

```
Windowing APIs are not enabled.

Windowing APIs are currently experimental. Do not use windowing APIs in
production applications or plugins published to pub.dev.

To try experimental windowing APIs:
1. Switch to Flutter's main release channel.
2. Turn on the windowing feature flag.
```

## エクスポートされていない API をインポートする

`_window.dart` は `package:flutter` 内部のプライベートなライブラリなので、`package:flutter/widgets.dart` 経由では到達できません。実装ファイルを直接インポートし、2 つの静的解析ルールを抑制します。これは Flutter 自身の `examples/multiple_windows` アプリがやっていることそのものです。

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
// ignore_for_file: invalid_use_of_internal_member
// ignore_for_file: implementation_imports

import 'package:flutter/material.dart';
import 'package:flutter/src/widgets/_window.dart';
```

見た目は良くありませんが、現時点で公式に認められた試用方法です。`implementation_imports` ルールは公開パッケージでこれをやらせないために存在しており、それはファイル冒頭の指示そのものでもあります。破壊的変更がパッチバージョンでも入るため、本番アプリや pub.dev に公開するものにはインポートしないでください。

## 最小構成の 2 ウィンドウアプリ

完結する最小のプログラムはこうです。`RegularWindowController` を作り、`RegularWindow` で包み、それ全体を `runApp` ではなく `runWidget` に渡します。

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
// ignore_for_file: invalid_use_of_internal_member, implementation_imports
import 'package:flutter/material.dart';
import 'package:flutter/src/widgets/_window.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  final RegularWindowController controller = RegularWindowController(
    preferredSize: const Size(900, 640),
    preferredConstraints: const BoxConstraints(minWidth: 640, minHeight: 480),
    title: 'Main window',
  );

  runWidget(
    WindowManager(
      child: RegularWindow(
        controller: controller,
        child: const MaterialApp(home: HomePage()),
      ),
    ),
  );
}
```

ここで効いているのは 3 点です。

`WidgetsFlutterBinding.ensureInitialized()` を最初に置く必要があります。`RegularWindowController` のファクトリーは即座に `WidgetsBinding.instance.windowingOwner` を解決し、プラットフォーム側の `WindowingOwner` はエンジンが初期化済みであることをアサートします。binding が存在する前にコントローラーを構築することが、flutter/flutter#178706 で追跡されているアサーション `WindowingOwner[Platform] must be created after the engine has been initialized` の原因です。

コントローラーはウィジェットのマウント時ではなく、コンストラクターでネイティブウィンドウを作成します。`RegularWindow` はすでに存在するウィンドウに描画するだけです。だからこそドキュメントは、ライフタイムの所有者は呼び出し側であり `destroy()` は自分で呼ぶ必要があると明記しています。

`WindowManager` はウィンドウが 1 つだけなら省略できますが、最初から入れておくべきです。これはツリーに `WindowRegistry` を設置します。子孫がコントローラーを手作業で受け渡すことなく別のウィンドウを開けるのは、この仕組みのおかげです。

## 実行時に 2 つ目のウィンドウを開く

パターンはこうです。コントローラーを作り、その内容を作る builder とともに `WindowEntry` に包み、登録します。`WindowManager` はレジストリーを監視し、各エントリーをコントローラーの型に応じた正しいウィジェットで描画します。

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    final WindowRegistry registry = WindowRegistry.of(context);

    return Scaffold(
      body: Center(
        child: FilledButton(
          onPressed: () {
            late final WindowEntry entry;
            final RegularWindowController controller = RegularWindowController(
              title: 'Inspector',
              preferredSize: const Size(480, 720),
              delegate: _UnregisterOnDestroy(
                onDestroyed: () => registry.unregister(entry),
              ),
            );
            entry = WindowEntry(
              controller: controller,
              builder: (BuildContext context) => const InspectorPane(),
            );
            registry.register(entry);
          },
          child: const Text('Open inspector'),
        ),
      ),
    );
  }
}

class _UnregisterOnDestroy with RegularWindowControllerDelegate {
  _UnregisterOnDestroy({required this.onDestroyed});

  final VoidCallback onDestroyed;

  @override
  void onWindowDestroyed() {
    super.onWindowDestroyed();
    onDestroyed();
  }
}
```

`late final WindowEntry entry` という回りくどい書き方は偶然ではありません。デリゲートはエントリーの登録解除を必要とし、エントリーはそのデリゲートが結び付いているコントローラーを必要とするためです。Flutter 自身のリファレンスアプリも同じ前方参照を使っています。

登録解除は重要です。`WindowRegistry.unregister` は `WindowManager` が描画をやめるようリストからエントリーを外すだけで、ウィンドウは破棄しません。逆に `destroy()` はネイティブウィンドウを破棄しますが、レジストリーには古いエントリーが残ります。デリゲートが両者をつなぐ地点です。既定の `onWindowCloseRequested` にウィンドウを破棄させ、`onWindowDestroyed` でレジストリーを片付けてください。

## クローズの横取りと、コントローラーの残りの API

`RegularWindowControllerDelegate` のフックはちょうど 2 つで、1 つ目の既定実装こそが実際にウィンドウを閉じている部分です。

```dart
// packages/flutter/lib/src/widgets/_window.dart, Flutter 3.44.8
void onWindowCloseRequested(RegularWindowController controller) {
  controller.destroy();
}

void onWindowDestroyed() { }
```

未保存の変更を確認したい場合は `onWindowCloseRequested` をオーバーライドし、`super` を呼ば *ない* でください。そのうえでユーザーが確認したら自分で `controller.destroy()` を呼びます。ウィンドウを閉じているのが `super` であることを忘れるのが、誰も閉じられないウィンドウを出荷してしまう一番ありがちな経路です。

コントローラー自体は期待どおりの状態を公開しており、`BaseWindowController` が `ChangeNotifier` を継承しているためすべて変更通知されます。`contentSize`、`title`、`isActivated`、`isMaximized`、`isMinimized`、`isFullscreen`、`rootView` です。変更用のメソッドは `setSize`、`setConstraints`、`setTitle`、`setMaximized`、`setMinimized`、`setFullscreen(bool fullscreen, {Display? display})`、`activate`、`destroy` です。いずれも *要求* としてドキュメント化されています。プラットフォームは無視して構わないので、UI は要求した内容ではなく通知された状態で駆動してください。

ウィンドウのサブツリー内からは、inherited model である `WindowScope` 経由でコントローラーに到達します。

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
final BaseWindowController window = WindowScope.of(context);

// Rebuilds only on size changes, not on title or activation changes.
final Size size = WindowScope.contentSizeOf(context);
```

`WindowScope` はアスペクト（コンテンツサイズ、タイトル、アクティブ、最大化、最小化、全画面）をキーとする `InheritedModel` なので、`contentSizeOf` はウィンドウが単にフォーカスを得ただけではウィジェットを再ビルドしません。サブツリーが暗黙のウィンドウでも動きうる場合は `maybeOf` を使ってください。`runApp` が接続するネイティブのエントリーポイントが作ったウィンドウには `WindowScope` がなく、そこでは `of` が例外をスローします。

## 残り 4 つのウィンドウ種別

通常ウィンドウは 5 種類あるコントローラーの 1 つで、いずれも `BaseWindowController` の下に sealed されており、`WindowManager` が switch で描画します。

- `DialogWindowController({BaseWindowController? parent, ...})`。`parent` が非 null ならダイアログはそれに対してモーダルになり、システムメニューを持たず、ウィンドウスイッチャーから隠され、親が閉じると一緒に閉じます。`parent: null` ならモードレスとなり、最小化はできても最大化はできず、**閉じるボタンが無効化された状態**になります。この最後の点は意外に思われがちです。閉じられる独立したウィンドウが欲しいなら、親のないダイアログではなく通常ウィンドウを選んでください。
- `PopupWindowController`。アンカー矩形を基準に配置されます。3.44 では macOS 向けに実装済みで、Windows と Linux はまだ進行中です。
- `TooltipWindowController`。3.44 でデスクトップ 3 プラットフォームすべてに実装されました。
- `SatelliteWindowController`。この一群で最も新しく、親ウィンドウに追従するパレットやツールバー向けです。

Flutter 3.44 は、オーバーレイではなく本物のネイティブウィンドウを開く windowing ベースの `showDialog` も追加しました。`MaterialApp` の `useWindowing` フラグの背後にあります。

## stable でこれが必要な場合にどうするか

いま出荷するなら、フレームワークの API は選択肢から外れます。implementation imports に加えて `@internal`、さらにパッチバージョンでの破壊的変更が明記されている以上、本番アプリの土台にはなりません。現実的な答えは引き続き `desktop_multi_window` 0.3.0（2025-10-28 公開）で、Windows、Linux、macOS に対応しています。

```dart
// desktop_multi_window 0.3.0, Flutter 3.44.8 stable
Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();

  final windowController = await WindowController.fromCurrentEngine();
  final arguments = parseArguments(windowController.arguments);

  switch (arguments.type) {
    case WindowType.main:
      runApp(const MainWindow());
    case WindowType.inspector:
      runApp(const InspectorWindow());
  }
}
```

新しいウィンドウは `WindowController.create(WindowConfiguration(...))` から生まれ、ウィンドウ間の通信は `WindowMethodChannel` を通ります。これは method channel なので非同期であり、コーデックの制約を受けます。

```dart
// desktop_multi_window 0.3.0
const channel = WindowMethodChannel('inspector');
channel.setMethodCallHandler((call) async {
  return switch (call.method) {
    'refresh' => 'ok',
    _ => throw MissingPluginException('Not implemented: ${call.method}'),
  };
});
```

計画時に織り込むべきはアーキテクチャー上のコストです。各ウィンドウはそれぞれ独自の Flutter エンジンであり、つまり独自の isolate、独自のヒープ、そして `main` で初期化したすべてのシングルトンの独自のコピーを持ちます。共有状態はチャンネル越しにシリアライズする必要があり、これは [MethodChannel でプラットフォーム固有のコードと話す](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)のとまったく同じです。[SendPort と ReceivePort を使う長命な Dart isolate](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)を中心にアプリを組んだ経験があれば、制約は見慣れたものに感じられるはずです。共有される可変オブジェクトはなく、すべてがメッセージ経由になります。

いまからそれを前提に設計しておけば、将来の移行は安く済みます。アプリケーション状態の所有者を 1 つに保ち、インターフェース越しに公開し、トランスポート（フレームワーク API なら直接参照、プラグインなら method channel）はそのインターフェースの背後に置いてください。これは [Flutter のデスクトップアプリが繰り返し証明している](/ja/2026/01/typemonkey-is-a-good-reminder-flutter-desktop-apps-need-architecture-first-polish-later/)「まずアーキテクチャー、磨きは後」と同じ主張です。

## 実際に時間を奪う落とし穴

**コントローラーは `ChangeNotifier` であり、破棄の責任は呼び出し側にあります。** `State` に保持した `RegularWindowController` は、ネイティブウィンドウ用の `destroy()` に加えて `dispose()` 内での `controller.dispose()` が必要です。すでに [`AnimationController` などに適用している](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)のと同じ規律が、ネイティブリソースが 1 つ増えた形でここでも通用します。

**ウィジェットテストに windowing はありません。** テスト用の binding には `WindowingOwner` が存在しないため、windowing のコンストラクターに到達したテストは `UnsupportedError` をスローします。Flutter 自身の API サンプルが `main` を `try`/`on UnsupportedError` で包んでいるのは、まさにスモークテストを通すためです。ウィンドウ生成はウィジェット層のコードから外し、差し替え可能な継ぎ目の背後に置いてください。

**`preferredSize` と `preferredConstraints` は矛盾してはいけません。** 両方が非 null のとき、ファクトリーは `preferredConstraints.isSatisfiedBy(preferredSize)` をアサートします。release ビルドではアサーションが消え、プラットフォームが黙って別の値を選びます。

**`decorated: false` は自分で装飾を描くという意味です。** 装飾なしウィンドウは 3.44 で入りました（`Allow windows to be created undecorated`）。タイトルバーも枠もドラッグ領域も、自分で作るまで一切ありません。

この取り組み全体の追跡 issue は flutter/flutter#30701 で、API 公開までに残っている作業は励みになるほど小さいものです。公開前チェックリストである flutter/flutter#177586 は、ドキュメントのスニペットから TODO を削除することと、サンプルから `invalid_use_of_internal_member` の ignore を外すことに絞られています。アーキテクチャーに関わる項目は 1 つもありません。この API の形に合わせて書き、インターフェースの背後に置いておけば、stable に載る日の移行はインポートの差し替えだけで済みます。

## 関連記事

- [プラグインなしで Flutter にプラットフォーム固有のコードを追加する方法](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)
- [CPU バウンドな処理のために Dart の isolate を書く方法](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)
- [Flutter でコントローラーを破棄してメモリリークを防ぐ方法](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [1 つの CI パイプラインから複数の Flutter バージョンを対象にする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [TypeMonkey が思い出させてくれること：Flutter のデスクトップアプリはまずアーキテクチャー、磨きは後](/ja/2026/01/typemonkey-is-a-good-reminder-flutter-desktop-apps-need-architecture-first-polish-later/)

## 参考資料

- [flutter/flutter#30701、マルチウィンドウの追跡 issue](https://github.com/flutter/flutter/issues/30701)
- [flutter/flutter#177586、マルチウィンドウの公開前チェックリスト](https://github.com/flutter/flutter/issues/177586)
- [3.44.0 タグ時点の `packages/flutter/lib/src/widgets/_window.dart`](https://github.com/flutter/flutter/blob/3.44.0/packages/flutter/lib/src/widgets/_window.dart)
- [`windowingFeature` が宣言されている `packages/flutter_tools/lib/src/features.dart`](https://github.com/flutter/flutter/blob/3.44.0/packages/flutter_tools/lib/src/features.dart)
- [Flutter のリファレンスアプリ `examples/multiple_windows`](https://github.com/flutter/flutter/tree/3.44.0/examples/multiple_windows)
- [Flutter 3.44.0 リリースノート](https://docs.flutter.dev/release/release-notes/release-notes-3.44.0)
- [Flutter デスクトップへの複数ウィンドウ導入に関する Canonical の記事](https://canonical.com/blog/multiple-window-flutter-desktop)
- [pub.dev の `desktop_multi_window`](https://pub.dev/packages/desktop_multi_window)
