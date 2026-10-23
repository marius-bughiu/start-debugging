---
title: "Flutter アプリを WidgetsBindingObserver.didChangeAppLifecycleState から AppLifecycleListener に移行する (Flutter 3.13+)"
description: "手書きの WidgetsBindingObserver によるライフサイクル処理を AppLifecycleListener に置き換えます。コールバックの対応表、強制される状態遷移、網羅的な switch を壊す新しい hidden 状態、デスクトップの終了リクエスト、突然アサートに失敗するテストまでを扱います。Flutter 3.44.8 と Dart 3.12.2 で検証しています。"
pubDate: 2026-10-23
updatedDate: 2026-10-23
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "app-lifecycle"
lang: "ja"
translationOf: "2026/10/migrate-a-flutter-app-from-widgetsbindingobserver-to-applifecyclelistener"
translatedBy: "claude"
translationDate: 2026-10-23
---

Flutter アプリで `didChangeAppLifecycleState` をオーバーライドするためだけに `State` に `WidgetsBindingObserver` をミックスインしているなら、その置き換え先は Flutter 3.13.0 で追加された `AppLifecycleListener` です。`initState` でリスナーオブジェクトを 1 つ作り、必要なコールバック (`onResume`、`onPause`、`onHide`、`onShow`、`onInactive`、`onRestart`、`onDetach`、`onStateChange`、`onExitRequested`) だけを渡し、最後に `dispose()` を呼びます。ミックスインも `addObserver`/`removeObserver` の対も、`AppLifecycleState` に対する `switch` も不要です。オブザーバー 1 つの移行にかかる時間は約 10 分で、次の 2 点を押さえていれば動作は変わりません。3.13 以降はフレームワークが中間状態を挿入すること (`resumed` から `paused` への遷移は `inactive`、`hidden`、`paused` の順で届きます)、そして新しい `AppLifecycleState.hidden` の値によって、`default` のない網羅的な `switch` がすべてコンパイルエラーになることです。以下の内容はすべて Flutter 3.44.8 (Dart 3.12.2) で実行して確認しています。

## 生のオブザーバーをやめる理由

- **コードが減り、リークも減ります。** オブザーバーパターンでは、ミックスイン、`initState` での `WidgetsBinding.instance.addObserver(this)`、`dispose` での `removeObserver(this)` という 3 つを連携させる必要があります。最後の 1 つを忘れると、破棄済みの `State` がバインディングのオブザーバーリストに残り続け、アンマウント後にもコールバックを受け取ります。`AppLifecycleListener` はコンストラクターで自身を登録し、`dispose()` で登録を解除するため、覚えておく呼び出しは 1 つだけです。コントローラーですでに行っている呼び出しと同じです。
- **状態ではなく遷移を扱えます。** `didChangeAppLifecycleState` はアプリが今どこにいるかを教えてくれます。ただ、アプリのロジックの多くが知りたいのは、どうやってそこに至ったかです。"アプリがバックグラウンドから戻ってきた"は `paused` から `hidden` への遷移 (`onRestart`) であり、"システムダイアログが閉じた"(`inactive` から `resumed`、`onResume`) とは別物です。リスナーは直前の状態を記憶しており、遷移の名前に対応するコールバックを呼びます。
- **デスクトップの終了リクエストも同じオブジェクトで扱えます。** `onExitRequested` を使うと、Windows、macOS、Linux のアプリで、閉じる操作をキャンセルして"未保存の変更"のプロンプトを表示できます。生のオブザーバーでは、これは `didRequestAppExit` という別のオーバーライドになります。
- **ウィジェットツリーの外に置けます。** リスナーは `WidgetsBinding` だけを必要とする素の Dart オブジェクトです。リポジトリ、分析サービス、Riverpod のプロバイダーが 1 つ所有し、サービスと一緒に破棄できます。

## アプリで変わる点

| 領域 | 変更内容 | 重大度 |
| --- | --- | --- |
| `switch (state)` 文 | `AppLifecycleState.hidden` (3.13 で追加) により、`default` のない switch が `non_exhaustive_switch_statement` で失敗します | 高 |
| `handleAppLifecycleStateChanged` を直接呼ぶウィジェットテスト | `resumed` から `paused` へ直接遷移させると、リスナー内部でアサーションに失敗します | 高 |
| オブザーバーの `State` クラス | ミックスインと `addObserver`/`removeObserver` を削除し、フィールド 1 つと `dispose()` に置き換えます | 中 |
| コールバックの順序 | `onStateChange` は遷移コールバックの後に、中間状態ごとに 1 回ずつ呼ばれます | 低 |
| 終了処理 | `didRequestAppExit` のオーバーライドは `onExitRequested` に移ります。`AppExitResponse` は `dart:ui` から取得します | 低 |

## 事前チェックリスト

- Flutter 3.13.0 以降であること (`flutter --version`)。`AppLifecycleListener` は 3.10 以前には存在せず、ファイル `packages/flutter/lib/src/widgets/app_lifecycle_listener.dart` は 3.13.0 のタグで初めて登場します。
- コードベースで `with WidgetsBindingObserver` と `didChangeAppLifecycleState` を grep します。`didChangeMetrics`、`didChangePlatformBrightness`、`didChangeLocales`、`didHaveMemoryPressure` など、ほかのコールバックもオーバーライドしているオブザーバーを控えておきます。それらはライフサイクル以外のコールバックのためにミックスインを残し、移すのはライフサイクルの部分だけです。
- `AppLifecycleState` に対する `switch` 文と `if` の連鎖も grep します。それぞれで `hidden` の扱いを決める必要があります。
- テストで `handleAppLifecycleStateChanged` を grep します。これらが失敗し始めるテストです。
- 先にコミットまたはスタッシュしておきます。データを扱わないコードだけの移行なので、ロールバックは `git revert` で済みます。

## 移行手順

1. **各 `case` をコールバックに対応させます。** リスナーのコールバックは状態ではなく遷移にちなんで名付けられています。次の対応表は、Flutter 3.44.8 の `AppLifecycleListener.didChangeAppLifecycleState` のソースから取ったものです。

   | 新しい状態 | 直前の状態 | コールバック |
   | --- | --- | --- |
   | `resumed` | `inactive` (またはなし) | `onResume` |
   | `inactive` | `resumed` (またはなし) | `onInactive` |
   | `inactive` | `hidden` | `onShow` |
   | `hidden` | `inactive` (またはなし) | `onHide` |
   | `hidden` | `paused` | `onRestart` |
   | `paused` | `hidden` (またはなし) | `onPause` |
   | `detached` | `paused` (またはなし) | `onDetach` |
   | 任意 | 任意 | `onStateChange(state)`、個別のコールバックの後 |

   `case AppLifecycleState.paused:` は `onPause` に、`case AppLifecycleState.resumed:` は `onResume` になります。古いコードが遷移の方向に関係なく `inactive` で何かを行っていた場合は、`onStateChange` を使って `if` を残してください。`inactive` は 2 つの方向から到達し得て、別々の 2 つのコールバックに対応するためです。確認: 古い `switch` のすべての分岐について、移行先がメモ上でちょうど 1 つに決まっていること。

2. **ミックスインをリスナーのフィールドに置き換えます。** 典型的な移行前のコードは次のとおりです。

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

   移行後は次のようになります。

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

   コンストラクターが `binding.addObserver(this)` を自分で呼ぶため、オブジェクトを作ること自体が購読になります。確認: `flutter analyze` が未使用の `WidgetsBindingObserver` のインポートに関する問題を報告せず、クラスに `with` 句がなくなっていること (ほかのオブザーバーコールバックがまだ必要な場合は除きます。手順 4 を参照)。

3. **`hidden` がロジックにとって何を意味するかを決めます。** `AppLifecycleState.hidden` は Flutter 3.13 で、デスクトップと Web 向けに追加されました。これらの環境では、モバイルの意味で"paused"にならなくても、アプリが最小化されたり、バックグラウンドのタブに入ったりすることがあります。iOS と Android では、フレームワークが `inactive` と `paused` の間にこの状態を合成します。動画の停止に `onPause` を使っていた場合、これまで動作していたすべての環境で引き続き動作します。デスクトップのウィンドウが最小化されたときにも動画を止めたいなら、`onHide` がすべてのプラットフォームで発火するコールバックで、対になるのが `onShow` です。モバイルでユーザーがアプリを離れたときにだけ行いたい処理 (下書きの保存、分析データのフラッシュなど) には、`onPause` と `onRestart` の組を使います。確認: コールバックごとに、リリース対象のプラットフォームと、そこで発火するかどうかを書き出すこと (`onRestart` と `onDetach` はモバイル専用と文書化されています)。

4. **ライフサイクル以外のコールバックのためにだけミックスインを残します。** `AppLifecycleListener` がカバーするのは `didChangeAppLifecycleState` と `didRequestAppExit` だけで、それ以外はありません。オブザーバーがキーボードインセットに反応するために `didChangeMetrics` もオーバーライドしている場合は、そのオーバーライドのためにミックスインを残し、ライフサイクルのメソッドだけを外に出してください。確認: 編集後にクラス内の `WidgetsBindingObserver` 由来の `@override` メソッドを grep し、1 つも残っていなければ、ミックスインと `addObserver`/`removeObserver` の呼び出しを削除すること。

5. **`didRequestAppExit` を `onExitRequested` に移します** (デスクトップのみ)。このコールバックは `Future<AppExitResponse>` を返し、その列挙型は `package:flutter/widgets.dart` や `services.dart` ではなく `dart:ui` にあります。インポートがないと `Undefined name 'AppExitResponse'` になります。

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

   このコールバックに届くのはキャンセル可能な終了だけです。`ServicesBinding.instance.exitApplication(AppExitType.required)` は確認なしで終了します。なお、`WidgetsBinding.handleRequestAppExit` は、あるオブザーバーが `cancel` と答えた後でもすべてのオブザーバーに問い合わせ、1 つでもキャンセルしたら終了を取り消します。アプリ内のどこか 1 つのリスナーが終了を拒否でき、ほかのすべてのリスナーの `onExitRequested` も実行されます。そのため、元に戻せない後始末をここに置かないでください。確認: デスクトップで実行し、エディターを変更済みの状態にしてウィンドウを閉じ、ダイアログが表示されて "Cancel" でウィンドウが開いたままになること。

6. **`hidden` の値で壊れた `switch` 文を直します。** `switch` を残す場合 (たとえば `onStateChange` の中)、`hidden` も網羅する必要があります。次のコードは Flutter 3.10 ではコンパイルできますが、3.13 以降では失敗します。

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

   アナライザーは次のように報告します。"The type 'AppLifecycleState' isn't exhaustively matched by the switch cases since it doesn't match the pattern 'AppLifecycleState.hidden'" (`non_exhaustive_switch_statement`)。`default` ではなく、明示的に `case AppLifecycleState.hidden:` を追加してください。そうすれば、Flutter が次に列挙値を追加したときに、黙ってフォールスルーするのではなく、再びコンパイルエラーになります。確認: `flutter analyze` がクリーンであること。

7. **ライフサイクルの変更を駆動するテストを更新します。** 次のセクションを参照してください。移行が実際につまずくのは、たいていここです。確認: `flutter test` が通ること。

## 検証

動作が変わっていないことを最も手早く証明する方法は、エンジンと同じやり方、つまり `flutter/lifecycle` チャンネルへの文字列としてライフサイクルの変更を送るウィジェットテストです。この経路はバインディングの遷移ジェネレーターを通るため、実機とまったく同じ動きになります。

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

このテストは 3.44.8 で通り、3 つの事実を 1 か所にまとめて示しています。プラットフォームから `resumed` を飛ばして直接 `paused` に移ると、3 ステップに分かれて届くこと。戻る方向では `onRestart`、`onShow`、`onResume` の順に実行されること。そして `onStateChange` は同じステップの名前付きコールバックより必ず後に来ること。`resumed` を 2 回続けて送っても、バインディングもリスナーも同じ状態の繰り返しを捨てるため、2 回目は何も起きません。

次に手動で確認します。Android と iOS では、アプリをバックグラウンドにして戻し、`onPause` と `onResume` に移した処理がそれぞれ 1 回ずつ実行されることを確かめてください。デスクトップでは、`onHide`/`onShow` に何かを移したなら最小化と復元を、`onExitRequested` を実装したならウィンドウを閉じる操作を確認します。

## ロールバック

この移行は純粋なコード変更で、永続化された状態は関係しません。コミットを `git revert` すれば、オブザーバーの状態に戻ります。きれいに元に戻らないのは、`hidden` のために直した `switch` だけです。古いコードは 3.13 以降ですでに壊れていたため、その修正は残してください。

## 実際の移行で出会った落とし穴

### `handleAppLifecycleStateChanged` を呼ぶテストがアサートに失敗するようになります

多くのテストスイートは、`tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused)` でバックグラウンド化を再現しています。このメソッドは、合成された中間状態を挟まずに、指定された状態を直接ディスパッチします。素のオブザーバーなら問題になりませんが、リスナーはすべての遷移を検証します。そのため、アプリが `resumed` の状態にあるとき、次のテストは失敗します。

```dart
// Flutter 3.44.8, Dart 3.12.2 - fails
testWidgets('direct jump', (tester) async {
  final listener = AppLifecycleListener(onPause: () {});
  addTearDown(listener.dispose);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
});
```

失敗の内容は、オブザーバーへのディスパッチ中に投げられるアサーションです。"Invalid state transition from AppLifecycleState.resumed to AppLifecycleState.paused" と表示され、`onPause` は一度も呼ばれません。中間の状態 (`inactive`、`hidden`、`paused`) を自分で順に送るか、検証セクションの `flutter/lifecycle` チャンネルのヘルパーを使って、フレームワークに生成させてください。このアサーションはデバッグビルドにしか存在しないため、リリース時の動作には影響しません。リスクはテストスイートが赤くなることだけです。

### リスナーが見るのは作成後の変更だけです

コンストラクターは `binding.lifecycleState` のスナップショットを取り、それを直前の状態として扱います。起動からかなり後に push される画面でリスナーを作った場合、現在の状態に対する `onResume` は発火しません。遷移がなかったからです。古いオブザーバーも同じ挙動でしたが、`initState` の呼び出しに頼って"再開時のロジックを 1 回だけ実行する"コードが書かれていることがあります。それは明示的にしてください。現在の状態が必要なら、以前と同じように `initState` で `WidgetsBinding.instance.lifecycleState` を読みます。

### 古いオブザーバーも合成された状態を受け取ります

中間状態の生成はリスナーではなく `ServicesBinding` にあります。上の再現では、リスナーと並べて登録した素の `WidgetsBindingObserver` も、1 回のプラットフォームの `paused` メッセージに対して `inactive`、`hidden`、`paused` を受け取りました。したがって、まだ移行していないオブザーバーが"`resumed` 以外なら再生を止める"という処理をしている場合、バックグラウンド化のたびにそのコードが 3 回実行されます。そのようなハンドラーは冪等にするか、名前付きコールバック 1 つに移行してください。

### `runApp` の前にリスナーを作る場合

`AppLifecycleListener()` は `binding` の既定値を `WidgetsBinding.instance` にしており、バインディングがまだ初期化されていないと例外を投げます。`runApp` の前に `main()` で構築されるサービスがリスナーを所有する場合は、先に `WidgetsFlutterBinding.ensureInitialized()` が必要です。どのウィジェットよりも長く生きるサービスでは、`dispose()` を呼ぶ仕組みも用意してください。Riverpod なら、リスナーを作るプロバイダーで `ref.onDispose(listener.dispose)` とします。

### `onExitRequested` はモバイルの戻るボタン用フックではありません

`onExitRequested` を Android の"アプリがまもなく閉じる"と考えたくなりますが、そうではありません。エンジンのソースでは、終了リクエストを送るのは Windows、macOS、Linux のエンベダーだけで、Android や iOS では発火しません。Android の戻るジェスチャーを横取りするには `PopScope` を使います。モバイルアプリが終了するときの後始末を実行するには `onPause` を使ってください。`onDetach` は、バックグラウンドのプロセスが OS に終了させられる前に実行されることが保証されていません。

## 関連記事

- リスナーの `dispose()` は、ほかの後始末と同じ場所に置くのが適切です。[how to dispose controllers in Flutter to avoid memory leaks](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) を参照してください。
- アプリがバックグラウンドに移ったときにストリームを一時停止するのは、`onPause` のよくある用途です。もう半分は [cancelling a StreamSubscription in dispose](/ja/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/) で扱っています。
- `onPause` は Android での最後の機会ではありません。その後で OS がプロセスを終了することがあります。戻ってくる状態の扱いは [Restoring UI state after Android process death with RestorationMixin](/ja/2026/10/how-to-restore-ui-state-after-android-process-death-in-flutter-with-restorationmixin/) で解説しています。
- 非推奨 API をまとめて整理する場合は、[running dart fix across a whole repo](/ja/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) で機械的に直せるものを自動化できます (この移行はその対象ではありません)。
- `onExitRequested` が最も重要になるのは、複数のウィンドウを持つデスクトップアプリです。[enabling multi-window support in a Flutter desktop app](/ja/2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app/) を参照してください。

## 参考資料

- [`AppLifecycleListener` class](https://api.flutter.dev/flutter/widgets/AppLifecycleListener-class.html) (api.flutter.dev)
- [`AppLifecycleState` enum and state diagram](https://api.flutter.dev/flutter/dart-ui/AppLifecycleState.html) (api.flutter.dev)
- [`WidgetsBindingObserver` class](https://api.flutter.dev/flutter/widgets/WidgetsBindingObserver-class.html) (api.flutter.dev)
- [`ServicesBinding.exitApplication`](https://api.flutter.dev/flutter/services/ServicesBinding/exitApplication.html) (api.flutter.dev)
- [`app_lifecycle_listener.dart` source](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/widgets/app_lifecycle_listener.dart) and [`ServicesBinding` transition generation](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/services/binding.dart) (flutter/flutter)
- [Breaking change: new `AppLifecycleState.hidden` enum value](https://docs.flutter.dev/release/breaking-changes/add-applifecyclestate-hidden) (docs.flutter.dev)
