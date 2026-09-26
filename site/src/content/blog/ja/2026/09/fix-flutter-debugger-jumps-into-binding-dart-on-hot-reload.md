---
title: "修正: Flutter のデバッガーがホットリロードのたびにエラー表示なしで binding.dart に飛ぶ"
description: "Flutter 3.35 の Web では、dwds のバグによりホットリロードのたびに偽の一時停止が送られていました。Flutter 3.38 以降にアップグレードするか、VS Code を 'Debug my code' に戻してパッケージのフレームをスキップさせてください。"
pubDate: 2026-09-26
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-web"
  - "hot-reload"
  - "vs-code"
  - "debugging"
lang: "ja"
translationOf: "2026/09/fix-flutter-debugger-jumps-into-binding-dart-on-hot-reload"
translatedBy: "claude"
translationDate: 2026-09-26
---

VS Code や Android Studio から Flutter の Web アプリを実行していて、ホットリロードのたびに例外もないまま `package:flutter/src/foundation/binding.dart` (たいてい 845 行目付近) が開く場合、あなたの操作に問題があるわけではありません。これは Flutter 3.35 に同梱された Web デバッグサービス dwds のバグです。ホットリロード中にブレークポイントを再登録するため Chrome を一時停止し、その内部的な一時停止を本物の一時停止として IDE に報告していました。修正は dwds 25.1.0+1 で入り、stable に初めて届いたのは Flutter 3.38.0 です。アップグレードしてください (現在の stable は 3.47.5 です)。3.35.x から動けない場合は、ステータスバーで VS Code のデバッグモードを "Debug my code" に戻すか、`--no-web-experimental-hot-reload` を渡してください。

以下の内容はすべて、Flutter 3.35.4、3.35.7、3.38.0、3.47.5 のソース、dwds 24.4.0+2 と 25.1.0+1 の変更履歴、Dart-Code 3.144 の設定スキーマと照合して確認しています。

## エラーの状況

エラーテキストは一切表示されず、そこが紛らわしい点です。ファイルを保存する (またはホットリロードボタンを押す) と、リロードは完了し、その後エディターが開いた覚えのないファイルに切り替わります。

```text
package:flutter/src/foundation/binding.dart   (line 845, highlighted as the current frame)

  @protected
  void postEvent(String eventKind, Map<String, dynamic> eventData) {
    developer.postEvent(eventKind, eventData);   // <- debugger "paused" here
  }
```

CALL STACK パネルには isolate が一時停止中と表示されますが、例外でもブレークポイントでもありません。Continue を押すとアプリはそのまま動き続け、次のリロードで再び同じことが起きます。人によっては別のファイルが表示され、ソースの代わりにメッセージが出ます。

```text
Could not load source 'package:flutter/src/foundation/binding.dart': Bad state: source reference is no longer valid.
```

同じ報告の別パターンでは `package:flutter/src/painting/decoration_image.dart` や `package:provider/src/devtool.dart` が挙がっています。実はこの一覧こそが、何が起きているかを知る最大の手がかりです。

典型的な報告は、stable チャンネルの Flutter 3.35.4 または 3.35.5、Dart 3.9.2、Chrome 上で実行し、VS Code からデバッグしているケースです。Android Studio でも同じ症状が確認されています。ターミナルで `flutter run -d chrome` を実行した場合は発生しません。ターミナルにはソースファイルへジャンプする仕組みがないためです。

## デバッガーが binding.dart で停止する理由

Flutter 3.35 では Web のステートフルホットリロードがデフォルトで有効になりました (`--web-experimental-hot-reload` フラグが `defaultsTo: true` に切り替わりました)。リロードをまたいでブレークポイントを機能させるため、dwds は Chrome 内の JavaScript isolate を一時停止し、新しいコードに対してブレークポイントを再登録してから再開します。この一時停止は実装上の詳細にすぎません。バグは、dwds 24.4.x が一時停止のたびに、この内部的なものも含めて必ず `PauseInterrupted` イベントを送出していたことです。

IDE にはその違いを見分けられません。Dart-Code のメンテナーである Danny Tuppeny が [flutter/flutter#176693](https://github.com/flutter/flutter/issues/176693) で述べているように、リロード中に送られる `PauseInterrupted` イベントは "to DAP/VS Code looks like a legitimate pause" (DAP/VS Code からは正当な一時停止に見える) のです。そのため VS Code はあらゆる一時停止で行うのと同じ動作をします。呼び出しスタックの最上位フレームを選び、そのファイルを開きます。

どのファイルかというと、Chrome が一時停止した瞬間に実行されていた Dart コードです。デバッグビルドの Flutter は VM service イベントを絶えず送っています。`SchedulerBinding` はフレームの後に `Flutter.Frame` を送り、service extension は `Flutter.ServiceExtensionStateChanged` を送り、それらはすべて `BindingBase` の 1 つのメソッドに集約されます。

```dart
// Flutter 3.35.4, packages/flutter/lib/src/foundation/binding.dart, lines 843-846
@protected
void postEvent(String eventKind, Map<String, dynamic> eventData) {
  developer.postEvent(eventKind, eventData);
}
```

3.35.4 のソースでは、`developer.postEvent(eventKind, eventData);` がちょうど 845 行目にあり、多くの報告がこの行に言及しているのはそのためです。ほかに開かれるファイルもやはり `postEvent` の呼び出し元です。`decoration_image.dart` は `developer.postEvent('Flutter.ImageSizesForFrame', ...)` を呼び出し、`provider` の `devtool.dart` は Provider DevTools 拡張向けに独自のイベントを送っています。一時停止は、その瞬間にたまたま VM service と通信していたコードの上で起きるのです。

"source reference is no longer valid" のパターンは、同じ一時停止がさらに悪いタイミングで起きたものです。リロードで新しいスクリプトに差し替わった直後なので、古いフレームに紐づくスクリプト参照がもう解決できません。

### 一部の開発者だけに発生した理由

VS Code が一時停止したフレームへジャンプするのは、それが自分のコードとみなされる場合だけです。Dart-Code はこれを 2 つの設定で判断しており、どちらもデフォルトは `false` です。

- `dart.debugSdkLibraries`: `dart:*` ライブラリをデバッグ対象にします。
- `dart.debugExternalPackageLibraries`: 外部の pub パッケージをデバッグ対象にします。Dart-Code のスキーマには、これに `package:flutter` が含まれると明記されています。

これらは、デバッグセッション実行中にステータスバーの項目で切り替えられる設定と同じものです: "Debug my code"、"Debug my code + packages"、"Debug my code + packages + SDK"。デフォルトの "Debug my code" では、偽の一時停止のフレームはすべて `package:flutter` に属し、どれもユーザーコードとみなされないため、VS Code にはジャンプ先がありません。フレームワークのメソッドにステップインするために一度でも "+ packages" に切り替えていた場合、`binding.dart` が "自分の" コードになり、リロードのたびにエディターがそこへジャンプしていました。Flutter チームのメンバーが最初に 3.35.6 で試して問題なしと判断し、issue を修正済みにしたのもこれが理由です。その後 Danny が、録画が "Debug my code" で行われていたことを指摘しました。

## 最小の再現手順

この手順が必要なのは、別の問題ではなくこのバグに当たっていることを確認したい場合だけです。

```bash
# Flutter 3.35.4 stable, Dart 3.9.2, Chrome, VS Code with Dart-Code
flutter create repro_binding
cd repro_binding
code .
```

```jsonc
// .vscode/settings.json -- Flutter 3.35.x, Dart-Code extension
{
  "dart.debugExternalPackageLibraries": true
}
```

デバイスに Chrome を選び、F5 を押し、`lib/main.dart` のカウンターのテキストを変更して保存します。3.35.x では、エディターが `binding.dart` を `developer.postEvent` の行で開きます。設定を削除する (またはステータスバーで "Debug my code" を選ぶ) とジャンプは止まりますが、isolate は依然として一瞬一時停止します。Flutter 3.38.0 以降ではどちらも起きません。

## 修正 1: Flutter 3.38 以降にアップグレードする

これが本当の修正です。dwds の変更は [dart-lang/webdev#2695](https://github.com/dart-lang/webdev/pull/2695) "Don't send PauseInterrupted event during a hot reload" で、2025-10-09 にマージされました。通常の一時停止イベントを送る代わりに、`ChromeProxyService` がデバッガーに一時停止が内部的なものであることを伝え、デバッガーはイベントではなく completer を通じて完了を通知するようになりました。これは dwds の `25.1.0+1` ホットフィックスとして出荷され、変更履歴には "Fix an issue in `reloadSources` where a `PauseInterrupted` event was sent" と記載され、[dart-lang/sdk#61560](https://github.com/dart-lang/sdk/issues/61560) へのリンクがあります。

重要なのは、お使いの Flutter SDK が `packages/flutter_tools/pubspec.yaml` でどの dwds を固定しているかです。

| Flutter | 固定されている dwds | Web のホットリロードでの偽の一時停止 |
| --- | --- | --- |
| 3.32.8 | 24.3.10 | なし (Web のステートフルホットリロードはデフォルトで無効) |
| 3.35.4 | 24.4.0+2 | あり |
| 3.35.7 (3.35 の最後のホットフィックス) | 24.4.0+2 | あり |
| 3.38.0 | 25.1.0+2 | なし |
| 3.47.5 (stable、2026 年 9 月) | 27.1.2 | なし |

この修正は 3.35 系にはチェリーピックされなかったため、3.35 のホットフィックスでは解決しません。現在のバージョンを確認し、先へ進めてください。

```bash
# any Flutter version
flutter --version
flutter channel stable
flutter upgrade
```

プロジェクトが FVM や `.flutter-version` ファイルで SDK を固定している場合は、そちらを更新してください。そうしないと、グローバルの SDK をアップグレードしても IDE は古い SDK を起動し続けます。

```bash
# FVM 3.x
fvm install 3.47.5
fvm use 3.47.5
```

その後、デバッグセッションを再起動します。実行中のセッションは元の `flutter run` プロセスを保持しており、そのプロセスが古い dwds を抱えています。

## 修正 2: VS Code を "Debug my code" に戻す

まだアップグレードできない場合 (CI イメージが固定されている、新しい Dart に対応していないプラグインがあるなど) は、症状を隠します。デバッグセッションの実行中に、ステータスバー左側のデバッグモード項目をクリックして "Debug my code" を選んでください。あるいはワークスペースで設定します。

```jsonc
// .vscode/settings.json -- Flutter 3.35.x workaround, Dart-Code extension
{
  "dart.debugExternalPackageLibraries": false,
  "dart.debugSdkLibraries": false
}
```

これは Danny が issue で推奨した回避策です。リロード中に isolate は依然として一瞬一時停止しますが、すべてのフレームが `package:flutter` か `dart:*` にあるため、VS Code はそれらをすべて外部コードとして扱い、フォーカスを奪いません。どうしてもパッケージにステップインする必要があるときは、そのセッションだけ "+ packages" に切り替え、戻すまではジャンプを受け入れてください。

Android Studio や IntelliJ にはこのケースに相当する切り替えがないため、この方法は役に立ちません。そちらでは修正 3 を使ってください。

## 修正 3: 3.35 で Web のステートフルホットリロードを無効にする

力技の選択肢は、3.35 以前の Web モジュール形式に戻すことです。この形式では一時停止と再登録の手順そのものが発生しません。

```bash
# Flutter 3.35.x, terminal
flutter run -d chrome --no-web-experimental-hot-reload
```

VS Code では、このプロジェクトにだけ適用されるよう `launch.json` に記述します。

```jsonc
// .vscode/launch.json -- Flutter 3.35.x, Dart-Code extension
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "web (no stateful reload)",
      "type": "dart",
      "request": "launch",
      "program": "lib/main.dart",
      "deviceId": "chrome",
      "toolArgs": ["--no-web-experimental-hot-reload"]
    }
  ]
}
```

ユーザー設定の `dart.flutterRunAdditionalArgs` でも機能しますが、マシン上のすべてのプロジェクトに適用されるため、1 年後にはその存在を忘れてしまう原因になります。Android Studio では Run > Edit Configurations を開き、Flutter の構成を選んで、"Additional run args" に `--no-web-experimental-hot-reload` を入力します。

代償は小さくありません。新しいモジュール形式がないと、Web ターゲットは古い動作に戻り、リロードでアプリが再起動して保存のたびに状態が失われます。アップグレードできるまでのつなぎとして扱い、その後は削除してください。Flutter 3.47.5 ではこのフラグのヘルプテキストにすでに "(deprecated; will be removed in a future release)" と書かれているため、残ったままの `toolArgs` のエントリはいずれ起動構成を壊すことになります。

## 落とし穴と似た症状

**3.38 以降なのにまだ発生する。** まず CALL STACK パネルのヘッダーを確認してください。"Paused on exception" と表示されている場合、これは dwds のバグではなく本物の例外で、Breakpoints パネルでは "Uncaught Exceptions" か "All Exceptions" にチェックが入っているはずです。"All Exceptions" の場合、デバッガーはフレームワークやパッケージのコードが自分で throw して catch する例外でも停止します。チェックを外し、リロードして、一時停止が消えるか確認してください。"Paused on breakpoint" と表示されている場合は、Breakpoints パネルを開いてください。VS Code はワークスペースごとにブレークポイントを保持しており、何か月も前にフレームワークをステップ実行したときに `binding.dart` 内に設定したものも残っています。それを削除してください。

**Android、iOS、デスクトップで発生する。** 偽の一時停止は Web 限定でした。原因は dwds にあり、dwds は Web ターゲットでしか動作しないためです。ネイティブの VM service は、リロード時にブレークポイントを再登録するために isolate を一時停止しません。モバイルやデスクトップのターゲットで `binding.dart` で停止する場合は、例外か残ったブレークポイントなので、上記の確認を行ってください。

**ホットリロードで一時停止ではなくデバッグセッションがクラッシュする。** Flutter 3.35.2 には、ホットリロードが `dwds/src/injected/client.js` から例外を投げてセッションを壊す別の Web のバグがありました ([flutter/flutter#174932](https://github.com/flutter/flutter/issues/174932))。別のバグですが、対処法は同じくアップグレードです。

**リロード後もページに古いコードが表示される。** リロードは "成功" しているのにブラウザーが古いビルドを実行している場合、見ているのはデバッガーではなくキャッシュの問題です。[Flutter Web がリロード後に古いキャッシュ済みビルドを配信する理由](/ja/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/)を参照してください。

**ブレークポイントを設定するとホットリロードが止まる。** `State.reassemble` のオーバーライド (またはそこから呼ばれるコード) の中にブレークポイントがあると、`ext.flutter.reassemble` のサービス呼び出しがリロードのたびにそこで停止し、ツールがその待機でタイムアウトすることがあります ([flutter/flutter#23285](https://github.com/flutter/flutter/issues/23285))。これは本物のブレークポイントが役目を果たしているだけで、dwds のバグではありません。続行して通過するか、ブレークポイントを移動してください。

## 関連記事

- デバッグではなくプロファイリングをしている場合は、[DevTools で Flutter アプリのジャンクをプロファイリングする方法](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)で、これらの `Flutter.Frame` イベントを利用する Performance ビューを解説しています。
- [`flutter attach` でホットリスタートした後に `appFlavor` が null になる理由](/ja/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/)も、リロードの経路が通常の起動とは異なる動作をするケースです。
- [Dart and Flutter MCP サーバー](/ja/2026/05/dart-flutter-mcp-server-claude-code-cursor/)は、Web で dwds が前面に立つのと同じ VM service と DTD と通信します。
- アップグレードと同時に Web レンダラーも選んでいるなら、[2026 年の Flutter Web における CanvasKit と skwasm の比較](/ja/2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026/)でトレードオフを解説しています。

## 参考資料

- [dart-lang/sdk#61560: Hot Reload opens `binding.dart` at line 845 on every reload (no errors shown)](https://github.com/dart-lang/sdk/issues/61560)
- [flutter/flutter#176693: [Web] Hot Reload jumping on binding.dart file even if "uncaught exceptions" are turned off](https://github.com/flutter/flutter/issues/176693)
- [flutter/flutter#174951: Error when hot reload since latest versions](https://github.com/flutter/flutter/issues/174951)
- [dart-lang/webdev#2695: Don't send PauseInterrupted event during a hot reload](https://github.com/dart-lang/webdev/pull/2695)
- [pub.dev の dwds 変更履歴](https://pub.dev/packages/dwds/changelog)
- [BindingBase.reassembleApplication API ドキュメント](https://api.flutter.dev/flutter/foundation/BindingBase/reassembleApplication.html)
- [Flutter ドキュメント: Hot reload](https://docs.flutter.dev/tools/hot-reload)
- [What's new in Flutter 3.38](https://blog.flutter.dev/whats-new-in-flutter-3-38-3f7b258f7228)
