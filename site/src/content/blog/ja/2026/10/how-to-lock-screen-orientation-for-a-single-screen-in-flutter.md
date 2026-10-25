---
title: "Flutter で 1 つの画面だけ画面の向きを固定する方法 (iPad のマルチタスクで無視される理由も解説)"
description: "SystemChrome.setPreferredOrientations で Flutter の 1 つのルートだけを横向きまたは縦向きに固定し、アプリの他の部分を壊さない方法を解説します。pushReplacement を乗り越えて pop 時に復元されるスタック方式のロック、空のリストがリセットに向かない理由、iPad のマルチタスクと Android 16 の大画面でロックが無視される理由、iPadOS 26 と iOS 27 SDK 以降の UIRequiresFullScreen の扱いを取り上げます。Flutter 3.47.8、Dart 3.13.7、Xcode 27.1 で検証しています。"
pubDate: 2026-10-25
template: how-to
tags:
  - "flutter"
  - "dart"
  - "ios"
  - "android"
  - "how-to"
lang: "ja"
translationOf: "2026/10/how-to-lock-screen-orientation-for-a-single-screen-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-25
---

Flutter で 1 つの画面だけを固定するには、ルートが表示されたときに `SystemChrome.setPreferredOrientations` を呼び、ルートが去るときにアプリ本来の向きに戻します。素朴なバージョン、つまり `initState` で横向きにして `dispose` で縦向きに戻す方法は書かないでください。Flutter 3.47.8 (Dart 3.13.7) のウィジェットテストでは、そのバージョンは pop アニメーションが終わってからようやく縦向きに戻ります。さらに悪いことに、ロックされた 2 つの画面の間で `pushReplacement` を行うと、新しい画面が縦向きのままになります。以下の小さなスタック方式のロックを使い、`PopScope.onPopInvokedWithResult` で復元してください。それでも、ロックは要求であって保証ではありません。アプリがマルチタスクに対応している間 (Split View、Slide Over、iPadOS 26 のウィンドウシステム) は、iPadOS がロックを無視します。API 36 をターゲットにすると、Android 16 は幅 600 dp 以上のディスプレイでロックを無視しますが、Flutter 3.47.8 はデフォルトで API 36 をターゲットにします。iPad の従来の回避策だった `UIRequiresFullScreen` は iPadOS 26 から非推奨になっており、iOS 27 SDK でビルドするとリサイズを拒否する設定として機能しなくなります。

## setPreferredOrientations が各プラットフォームで実際に行うこと

`SystemChrome.setPreferredOrientations(List<DeviceOrientation>)` は、列挙値の名前のリストを運ぶ単一のプラットフォームチャネル呼び出し `SystemChrome.setPreferredOrientations` です。これはアプリ全体の状態を保持します。ウィジェットやルートにスコープされるものは何もありません。最後に設定した値は、何かが再び設定するまで有効なままです。ホットリスタートも含まれます。この設定は Dart ではなく、ネイティブのビューコントローラーまたはアクティビティに保持されるためです。

プラットフォームごとに扱いが異なり、ロックを "元に戻す" ときにその違いが問題になります。

- **Android**: エンジンの `PlatformChannel.decodeOrientations` がリストをビットマスクに変換し、`ActivityInfo.SCREEN_ORIENTATION_*` 定数に対応付けて `activity.setRequestedOrientation(...)` を呼びます。`[portraitUp]` は `SCREEN_ORIENTATION_PORTRAIT` に、`[landscapeLeft, landscapeRight]` は `SCREEN_ORIENTATION_USER_LANDSCAPE` に、空のリストは `SCREEN_ORIENTATION_UNSPECIFIED` になります。実行時の要求はマニフェストの `android:screenOrientation` 属性を上書きします。そのため、マニフェストが `portrait` でも `[]` で "リセット" すると、その後アクティビティは自由に回転できます。
- **iOS**: `FlutterPlatformPlugin` が `UIInterfaceOrientationMask` を作成して通知を投稿します。すべての `FlutterViewController` はそのマスクを保存し、`supportedInterfaceOrientations` から返します。iOS 16 以降では、接続されている各 `UIWindowScene` に対して `requestGeometryUpdateWithPreferences:` を呼び、その後 `setNeedsUpdateOfSupportedInterfaceOrientations` を呼びます。空のリストは `UIInterfaceOrientationMaskAll` になり、UIKit はそれを `Info.plist` の向きと交差させます。ジオメトリ要求が失敗してもログ ("Failed to change device orientation") に出るだけです。Dart の future は通常どおり完了します。

ここから 2 つのことが言えます。1 つ目は、`[]` は "アプリのデフォルト" ではなく "OS が許す任意の向き" を意味することです。復元は必ず明示的なリストで行ってください。2 つ目は、この呼び出しが投げっぱなしであることです。future を待機してわかるのはメッセージが届いたことだけで、画面が回転したかどうかはわかりません。

## 素朴な画面単位のロックとその破綻

多くの回答が提案するのは次のバージョンです。

```dart
// Flutter 3.47.8, Dart 3.13.7 -- naive, do not ship
class _VideoPageState extends State<VideoPage> {
  @override
  void initState() {
    super.initState();
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
  }

  @override
  void dispose() {
    SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
    super.dispose();
  }
}
```

`SystemChannels.platform` を横取りし、ナビゲーションイベントの間に各向き呼び出しをログに記録するウィジェットテストで実行しました。Flutter 3.47.8 でのログは次のとおりです。

```text
naive push/pop: [landscapeLeft,landscapeRight] -- pop -- first frame of pop animation [portraitUp] -- pop animation done
naive replace:  [landscapeLeft,landscapeRight] -- replace [landscapeLeft,landscapeRight] [portraitUp]  => final [portraitUp]
```

1 行目はタイミングのバグを示しています。`dispose` はルートの終了トランジションが完了した後にしか実行されないため、デバイスが横向きにロックされたまま前の画面がスライドして戻り、その後で縦向きに切り替わります。実機では、pop トランジションの間ずっと、前の画面が横向きのレイアウトでアニメーションして戻るのをユーザーが見ることになり、その後ようやく回転します。

2 行目は正しさのバグです。`pushReplacement` (または `go_router` の `replace` や兄弟ルートへの `go`) では、新しいルートの `initState` が古いルートの `dispose` より先に実行されます。入ってくる動画ページが横向きを要求します。その後、出ていく動画ページが "後片付け" をして縦向きを強制します。最終状態は、横向きを求める画面での縦向きです。ロックされた 2 つの画面の寿命が重なるときは、いつでも同じことが起こります。たとえば、隣のページを生かしておく `TabBarView` や `PageView` です。

## 所有され、積み重ねられ、pop で解放されるロック

解決策は、向きを各画面が設定したりリセットしたりするものとして扱うのをやめることです。代わりに、アプリ全体で 1 つの要求スタックを保持します。各画面は自分のエントリを push し、自分のエントリだけを削除します。プラットフォームに送られるのはスタックの先頭 (またはアプリのデフォルト) です。

```dart
// Flutter 3.47.8, Dart 3.13.7
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// App-wide orientation stack. The top entry wins; when it is empty the
/// app default applies.
class OrientationLocks {
  OrientationLocks._();

  static List<DeviceOrientation> appDefault = const [DeviceOrientation.portraitUp];
  static final List<(Object, List<DeviceOrientation>)> _stack = [];

  static void push(Object owner, List<DeviceOrientation> orientations) {
    _stack.removeWhere((e) => identical(e.$1, owner));
    _stack.add((owner, orientations));
    _apply();
  }

  static void remove(Object owner) {
    final before = _stack.length;
    _stack.removeWhere((e) => identical(e.$1, owner));
    if (_stack.length != before) _apply();
  }

  static void _apply() {
    final target = _stack.isEmpty ? appDefault : _stack.last.$2;
    SystemChrome.setPreferredOrientations(target);
  }
}
```

これを使うウィジェットは、ルートが現在のルートになったときにロックを push します。ロックの解放は 2 か所で行います。pop が始まったとき (`PopScope` 経由) と、pop なしで削除されたルート (たとえば `pushReplacement` の古いルート) のためのフォールバックとして `dispose` です。

```dart
// Flutter 3.47.8, Dart 3.13.7
/// Locks orientation while this widget's route is the current route.
class OrientationLock extends StatefulWidget {
  const OrientationLock({
    super.key,
    required this.orientations,
    required this.child,
  });

  final List<DeviceOrientation> orientations;
  final Widget child;

  @override
  State<OrientationLock> createState() => _OrientationLockState();
}

class _OrientationLockState extends State<OrientationLock> {
  ModalRoute<Object?>? _route;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final route = ModalRoute.of(context);
    if (route != _route) {
      _route = route;
      // isCurrent is false while another route covers this one.
      if (route == null || route.isCurrent) {
        OrientationLocks.push(this, widget.orientations);
      }
    }
  }

  @override
  void didUpdateWidget(OrientationLock oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!listEquals(oldWidget.orientations, widget.orientations)) {
      OrientationLocks.push(this, widget.orientations);
    }
  }

  @override
  void dispose() {
    OrientationLocks.remove(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope<Object?>(
      onPopInvokedWithResult: (didPop, result) {
        // Release the lock when the pop starts, not when the exit
        // animation ends, so the previous screen does not animate in
        // under the wrong orientation.
        if (didPop) OrientationLocks.remove(this);
      },
      child: widget.child,
    );
  }
}
```

ルートでの使い方はラッパー 1 つです。

```dart
// Flutter 3.47.8, Dart 3.13.7
Navigator.of(context).push(MaterialPageRoute<void>(
  builder: (_) => const OrientationLock(
    orientations: [DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight],
    child: VideoPage(),
  ),
));
```

同じテストハーネスをこのバージョンに対して実行した結果です。

```text
stack push/pop: [landscapeLeft,landscapeRight] -- pop [portraitUp] -- first frame of pop animation -- pop animation done
stack replace:  [landscapeLeft,landscapeRight] -- replace [landscapeLeft,landscapeRight] [landscapeLeft,landscapeRight]  => final [landscapeLeft,landscapeRight]
```

縦向きは pop が始まるのと同じフレームで要求されるため、回転と逆方向のトランジションが一緒に進みます。置き換えの後も動画は横向きのままです。出ていくページのエントリを削除すると、デフォルトではなく入ってくるページのエントリが再適用されるためです。

ここには設計上の選択が組み込まれています。独自の `OrientationLock` を持たないルートは、スタックでその下にある最も近いロックを引き継ぎます。横向きのプレーヤーが単純な設定シートを push すると、そのシートも横向きになります。"ロックのないものはすべて縦向き" にしたい場合は、それらのルートを明示的な `OrientationLock(orientations: [DeviceOrientation.portraitUp])` でラップしてください。`go_router` では、ラッパーをルートの `builder` または `pageBuilder` に置きます。`ModalRoute.of` と `PopScope` は `ShellRoute` のネストされたナビゲーター内でも同じように動作します。これについては [go_router によるネストされたルートとディープリンク](/ja/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) の記事で説明しています。

## アプリのデフォルトは Dart だけでなくネイティブプロジェクトにも設定する

1 つの画面を除いてアプリ全体が縦向きなら、起動画面と最初のフレームがすでに正しくなるよう、縦向きをネイティブ側でも宣言してください。

1. `android/app/src/main/AndroidManifest.xml` で、`MainActivity` 要素に `android:screenOrientation="portrait"` を追加します。
2. `ios/Runner/Info.plist` では、`UISupportedInterfaceOrientations` (iPhone) と `UISupportedInterfaceOrientations~ipad` に、いずれかの画面が必要とするすべての向きを残しておきます。Flutter は `Info.plist` が許可するものを狭めることしかできず、追加はできません。3.47.8 のテンプレートは、iPhone では縦向きと両方の横向き、iPad では 4 つすべての向きを列挙しています。
3. `main` で `OrientationLocks.appDefault` を設定し、`runApp` の前に適用します。

```dart
// Flutter 3.47.8, Dart 3.13.7
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  OrientationLocks.appDefault = const [DeviceOrientation.portraitUp];
  await SystemChrome.setPreferredOrientations(OrientationLocks.appDefault);
  runApp(const MyApp());
}
```

iPhone の `Info.plist` を縦向きのみに制限しておきながら、Dart から横向きを要求しないでください。iOS 16 以降では、シーンが要求された向きを 1 つもサポートしていないためジオメトリ要求が失敗します。Xcode にログが 1 行出る以外は、黙って失敗します。

## iPad のマルチタスクがロックを無視する理由

Flutter 3.47.8 の `setPreferredOrientations` のドキュメントコメントにははっきり書かれています。"This setting will only be respected on iPad if multitasking is disabled." 理由は Flutter ではなく UIKit にあります。アプリが画面を共有できる場合 (Split View、Slide Over、Stage Manager、iPadOS 26 で登場した自由にリサイズ可能なウィンドウ)、シーンのサイズと向きはシステムのものになります。ユーザーはアプリが並べて表示されている状態で iPad を回転できます。システムは 1 つのアプリのために画面全体を回転させないので、`supportedInterfaceOrientations` は尊重されなくなります。Flutter は要求を送り続けますが、UIKit はそれに従いません。

長年、文書化された回避策であり、Flutter のドキュメントが今も触れているのは、マルチタスクをオプトアウトすることでした。Xcode で "Requires full screen" にチェックを入れると、`Info.plist` に `UIRequiresFullScreen = YES` が書き込まれます。これはもう長期的な答えではありません。Apple の [TN3192](https://developer.apple.com/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key) には次のように書かれています。

- iPadOS 26 以降、`UIRequiresFullScreen` とその互換モードは非推奨であり、将来のリリースで無視されます。
- iOS 27 と iPadOS 27 以降、iOS 27 SDK でビルドされ、このキーを設定しているアプリは、フルスクリーンのまま維持されるのではなく、段階的にリサイズされます。唯一の例外は、`UIRequiresFullScreenIgnoredStartingWithVersion` がバージョン 27 以前を指定している場合です。
- リサイズ可能なシーンをサポートするには、アプリはすべてのインターフェースの向きをサポートする必要があります。

Xcode 27.1 には iOS 27 SDK が含まれています。そのため、今ビルドする Flutter アプリでは、"Requires full screen" にチェックを入れても iOS 27 でリサイズをオプトアウトできず、Apple は開発者にこれに頼るのをやめるよう伝えています。iPadOS 26.x の期間の開発者フォーラムのスレッドにも、デバイスの回転ロックがオフのとき、横向き専用のアプリが縦向きで表示されるという報告があります。iPad の向きのロックは、ベストエフォートとして扱ってください。

Apple が代わりに提供しているのは *一時的な* ロックです。ビューコントローラーは `prefersInterfaceOrientationLocked` をオーバーライドし、`setNeedsUpdateOfPrefersInterfaceOrientationLocked()` を呼べます。これは、そのコントローラーが表示されている間、シーンの現在の向きを維持するようシステムに求めるもので、たとえばカメラのキャプチャ中やゲームでのステアリング操作中に使います。TN3192 は、システムがこの設定を尊重することを "保証しない" と明言しています。Flutter 3.47.8 の `FlutterViewController` はこのプロパティをオーバーライドしていません。サブクラスで行い、メソッドチャネルで制御できます。

```swift
// Flutter 3.47.8, Xcode 27.1, iOS 26+ for prefersInterfaceOrientationLocked
import Flutter
import UIKit

class LockableFlutterViewController: FlutterViewController {
  private var locked = false
  private var channel: FlutterMethodChannel?

  override func viewDidLoad() {
    super.viewDidLoad()
    channel = FlutterMethodChannel(
      name: "app/orientation_lock", binaryMessenger: engine.binaryMessenger)
    channel?.setMethodCallHandler { [weak self] call, result in
      guard let self, call.method == "setLocked", let value = call.arguments as? Bool else {
        result(FlutterMethodNotImplemented)
        return
      }
      self.locked = value
      if #available(iOS 26.0, *) {
        self.setNeedsUpdateOfPrefersInterfaceOrientationLocked()
      }
      result(nil)
    }
  }

  override var prefersInterfaceOrientationLocked: Bool {
    locked
  }
}
```

`ios/Runner/Base.lproj/Main.storyboard` で、ルートのビューコントローラーの `customClass` を `FlutterViewController` から `LockableFlutterViewController` (`customModuleProvider="target"` 付き) に変更します。その後、Dart から呼び出します。

```dart
// Flutter 3.47.8, Dart 3.13.7
const _lockChannel = MethodChannel('app/orientation_lock');

Future<void> setIpadOrientationLocked(bool locked) =>
    _lockChannel.invokeMethod<void>('setLocked', locked);
```

これはシーンがすでに持っている向きを維持するだけです。横向きに回転させることはないため、`setPreferredOrientations` を置き換えるのではなく補完します。このサブクラスは、Xcode 27.1 の `flutter build ios --simulator` で Flutter 3.47.8 のアプリにコンパイルして確認しました (デプロイメントターゲットは iOS 15 なので `#available` チェックがあります)。物理 iPad でのマルチタスクの動作はテストしていないので、頼る前に実機で確認してください。

## Android 16 も大画面で同じことをする

Android も同じ道をたどりました。[Android 16 の動作変更](https://developer.android.com/about/versions/16/behavior-changes-16#ignore-orientation)によると、API 36 をターゲットにするアプリは、最小幅が 600 dp 以上のディスプレイで `screenOrientation`、`resizableActivity`、`minAspectRatio`、`maxAspectRatio`、`setRequestedOrientation()`、`getRequestedOrientation()` を無視します。これにはタブレット、展開したときの折りたたみ端末、デスクトップウィンドウが含まれます。Flutter の `setPreferredOrientations` は `setRequestedOrientation()` 呼び出しであり、Flutter 3.47.8 の Gradle プラグインは `flutter.targetSdkVersion` を 36 に設定します。そのため、新しく作成した Flutter アプリはタブレットで向きをロックしません。Flutter 自身のドキュメントにもこの制限が記載されるようになりました。

例外は、ゲーム (`android:appCategory="game"` で宣言)、デバイスのアスペクト比設定でアプリのデフォルトの動作を選んだユーザー、600 dp より狭い画面です。スマートフォンは影響を受けません。一時的なオプトアウトがあります。

```xml
<!-- android/app/src/main/AndroidManifest.xml, targetSdk 36 only -->
<activity android:name=".MainActivity" ...>
    <property
        android:name="android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY"
        android:value="true" />
</activity>
```

Google は、API レベル 37 をターゲットにするとこのオプトアウトは適用されなくなると述べています。これは修正ではなく、タブレットのレイアウトを直すための猶予期間として扱ってください。同じルールは MAUI アプリにも影響しました。マニフェスト側については、[MAUI の API レベル 36 への移行](/ja/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/)の記事でより詳しく説明しています。

## 画面が実際に回転するときの注意点

- **ロックではなく制約からレイアウトする。** 回転は呼び出しから 1 フレーム以上遅れて届き、iPad や Android 16 のタブレットでは届かないこともあります。ロックされた画面は `OrientationBuilder` または `LayoutBuilder` で構築し、実際に得られるサイズで正しく描画されるようにしてください。
- **ロックするかどうかの判断には `MediaQuery.size` ではなくディスプレイを使う。** Android ではレターボックス表示により、`MediaQueryData.size` はレターボックスされた領域を報告します。Flutter のドキュメントは、`View.of(context).display.size / display.devicePixelRatio` を 600 論理ピクセルのブレークポイントと比較することを推奨しています。ロックするのはスマートフォンだけにし、タブレットでは `[]` を送ってください。
- **`landscapeLeft` はデバイスが反時計回りに回された状態を意味する。** `DeviceOrientation.landscapeLeft` は "90 degrees counterclockwise from portraitUp" です。特定の向きに固定する理由がない限り、両方の横向きを要求してください。そうしないと、スマートフォンを逆向きに回したユーザーには画面が上下逆さまに反転して見えます。
- **ホームボタンのない iPhone では `portraitDown` は決して使われない。** TN3192 によると、そうした機種では、宣言内容にかかわらず、システムが `portraitUpsideDown` をサポート対象から外します。
- **バックグラウンドからの復帰。** ネイティブの設定はバックグラウンド化しても保持されるため、復帰時に再適用する必要はありません。他にライフサイクル関連のコードがある場合は、`WidgetsBindingObserver` よりも [AppLifecycleListener への移行](/ja/2026/10/migrate-a-flutter-app-from-widgetsbindingobserver-to-applifecyclelistener/)の方がその置き場所として適切です。
- **`mounted` を確認せずに `await` の後で呼ばない。** 非同期の動画読み込みの後にロックするのはよくあることです。ユーザーがすでにルートを pop していた場合、破棄済みの `State` から遅れて呼ばれた `OrientationLocks.push` は、誰も削除しないロックを残します。[await の後に BuildContext を安全に使う](/ja/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)ためのルールはここでも当てはまります。

## 関連記事

- [go_router によるネストされたルートとディープリンク](/ja/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/): ルートツリーのどこに `OrientationLock` ラッパーを置くかについて。
- [Flutter における go_router、auto_route、Navigator 2.0 の比較](/ja/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/): ルーターを選んでいて、置換ルートがどう破棄されるかが気になる場合。
- [WidgetsBindingObserver から AppLifecycleListener への移行](/ja/2026/10/migrate-a-flutter-app-from-widgetsbindingobserver-to-applifecyclelistener/)。
- [.NET MAUI Android アプリを API レベル 36 に対応させる移行](/ja/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/): MAUI 側から見た、同じ Android 16 の大画面ルールについて。

## 参考資料

- [`SystemChrome.setPreferredOrientations` API ドキュメント](https://api.flutter.dev/flutter/services/SystemChrome/setPreferredOrientations.html)と [3.47.8 のソース](https://github.com/flutter/flutter/blob/3.47.8/packages/flutter/lib/src/services/system_chrome.dart)。
- 3.47.8 時点の Flutter エンジン: [`FlutterViewController.mm`](https://github.com/flutter/flutter/blob/3.47.8/engine/src/flutter/shell/platform/darwin/ios/framework/Source/FlutterViewController.mm)、[`FlutterPlatformPlugin.mm`](https://github.com/flutter/flutter/blob/3.47.8/engine/src/flutter/shell/platform/darwin/ios/framework/Source/FlutterPlatformPlugin.mm)、[`PlatformChannel.java`](https://github.com/flutter/flutter/blob/3.47.8/engine/src/flutter/shell/platform/android/io/flutter/embedding/engine/systemchannels/PlatformChannel.java)。
- [TN3192: Migrating your app from the deprecated UIRequiresFullScreen key](https://developer.apple.com/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key)。
- [Android 16 behavior changes: ignore orientation, resizability, and aspect ratio restrictions](https://developer.android.com/about/versions/16/behavior-changes-16#ignore-orientation)。
- Apple Developer Forums: [iPadOS 26.x ignores supportedInterfaceOrientations when orientation lock is off](https://developer.apple.com/forums/thread/811216)。
