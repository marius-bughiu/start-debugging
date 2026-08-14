---
title: "解決: Flutter の iOS デバッグビルドで発生する mprotect failed: 13 (Permission denied)"
description: "iOS が Dart VM によるメモリページの実行可能化を拒否するため、JIT が起動時に落ちます。iOS 26 では Flutter 3.35.0 以降、iOS 18.4 では 3.32.0 以降に更新してください。entitlement では解決しません。"
pubDate: 2026-08-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "ios"
  - "xcode"
lang: "ja"
translationOf: "2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build"
translatedBy: "claude"
translationDate: 2026-08-14
---

Flutter を更新してください。このクラッシュは、書き込み可能なメモリページを実行可能ページに変える操作を iOS が Dart VM に許可しなくなったために起きます。それはまさに JIT が必要とする動作であり、デバッグモードが動作する土台そのものです。物理的な iOS 26 端末でこれを乗り越える最初の安定版は Flutter 3.35.0 (Dart 3.9.0、2025-08-14) で、iOS 18.4 を乗り越えた最初の安定版は Flutter 3.32.0 (Dart 3.8.0) でした。古い SDK に追加して回避できる entitlement も Info.plist キーもビルドフラグも存在しません。すでに 3.35.0 以降なのにまだクラッシュする場合は、Xcode のスキームに LLDB Init File が設定されていません。それが解決策の後半です。

## クラッシュの全文

アプリは `Dart_Initialize` の途中、ウィジェットが 1 つも構築されないうちに落ちます。

```
../../../flutter/third_party/dart/runtime/vm/virtual_memory_posix.cc: 428: error: mprotect failed: 13 (Permission denied)
version=3.7.0 (stable) (Wed Feb 5 04:53:58 2025 -0800) on "ios_arm64"
pid=726, thread=259, isolate_group=vm-isolate(0x11ea52800), isolate=vm-isolate(0x11ebe5800)
os=ios, arch=arm64, comp=no, sim=no
  pc 0x0000000110302e84 fp 0x000000016eee4f50 Dart_DumpNativeStackTrace+0x18
  pc 0x000000010feb1428 fp 0x000000016eee4f70 dart::Assert::Fail(char const*, ...) const+0x30
  pc 0x000000010ffac33c fp 0x000000016eee5420 dart::Code::FinalizeCode(...)+0x82c
  pc 0x0000000110039cb0 fp 0x000000016eee5a30 dart::StubCode::Init()+0x320
  pc 0x000000010fefc4f4 fp 0x000000016eee64e0 dart::Dart::DartInit(Dart_InitializeParams const*)+0x2b18
  pc 0x00000001102e9754 fp 0x000000016eee6960 Dart_Initialize+0x60
  pc 0x000000010fe71e24 fp 0x000000016eee6f30 flutter::DartVM::Create(...)+0x1d64
=== Crash occurred when compiling unknown function in unoptimized JIT mode in unknown pass
```

このエラーを特定できる手がかりが 3 つあります。フレームが `dart::StubCode::Init()` であること。これはあなたのコードが存在するより前に実行されるため、Dart 側に原因はありません。`13` は POSIX の `mprotect` が返す `EACCES` です。そして最終行が JIT モードを明示しています。

## なぜ iOS は mprotect の呼び出しを拒否するのか

Flutter のデバッグビルドは Dart VM を JIT モードで動かします。これはオプトアウトできる実装の細部ではありません。ホットリロードは実行中のプロセス内で新しい Dart をマシンコードにコンパイルすることで成立しており、VM がページにバイト列を書き込んでからそれを実行する、という手順が前提になっています。

Apple の W^X ポリシーでは、ページは書き込み可能か実行可能のどちらかであり、同時に両方であってはなりません。従来の回避策は、ページを RW で確保し、コンパイル済みコードを書き込み、その後 `mprotect(PROT_READ | PROT_EXEC)` を呼んで切り替えるというものでした。Dart VM は `runtime/vm/virtual_memory_posix.cc` の `VirtualMemory::Protect` でまさにそれを行っていました。

iOS 18.4 のベータから、そして iOS 26 でさらに強化される形で、カーネルはサードパーティアプリに対してこの遷移を許可しなくなりました。開発ビルドが持つ `get-task-allow` entitlement があっても同じです。`mprotect` は `EACCES` を返し、VM の `ASSERT` が発火し、プロセスが中断されます。これが [flutter/flutter#163984](https://github.com/flutter/flutter/issues/163984) の全体像です。P1 として 2025 年 2 月から 7 月まで続き、61 件のコメントが集まりました。

作業を始める前に理解しておきたい帰結が 2 つあります。

**release ビルドと profile ビルドは影響を受けません。** これらは AOT コンパイルされます。マシンコードはすでにアプリバイナリに含まれ、ローダーが実行可能としてマップするため、VM が保護属性の変更を要求することはありません。CI が緑で TestFlight ビルドが動くのは想定どおりであり、設定が正しい証拠にはなりません。

**シミュレーターも影響を受けません。** シミュレーターは macOS のカーネル上で動作し、この制限を適用しません。片方がシミュレーターで、もう片方が実機でテストしているチームでは、症状がきれいに二分されます。調査の最初の 1 時間が混乱しがちなのはこのためです。

## 実際にどの Flutter バージョンが必要なのか

修正は 2 つの部分に分かれ、別々の安定版で入りました。コミットの系譜は issue のスレッドを信じるのではなく、GitHub の compare API を使って Dart SDK のリリースタグと突き合わせて確認しました。

| 対象 | 動作する最初の安定版 | Dart | リリース日 |
| --- | --- | --- | --- |
| iOS 18.4 の実機 | Flutter 3.32.0 | 3.8.0 | 2025-05-20 |
| iOS 26 の実機 | Flutter 3.35.0 | 3.9.0 | 2025-08-14 |
| iOS 26、ツールが LLDB を直接制御 | Flutter 3.38.0 | 3.10.0 | 2025-11-12 |

1 つ目は VM 内の `NOTIFY_DEBUGGER_ABOUT_RX_PAGES` フックで、2025-02-28 の Dart コミット `939699a9` で追加されました。これは `3.8.0` タグの祖先なので、Flutter 3.32.0 以降にはすべて含まれています。

2 つ目はコードページの二重マッピングで、2025 年 6 月の 3 つのコミット (`d194fcec`、`dc0567c0`、`c111f693`) です。これらは `3.9.0` の祖先ですが `3.8.1` の祖先ではありません。3.32.x が iOS 26 でクラッシュし 3.35.0 がクラッシュしないのはこのためです。1 つのマッピングの保護属性を切り替えるのではなく、VM は同じ物理メモリを 2 回マップするようになりました。コンパイラーが書き込む RW のビューと、CPU が実行する別の RX のビューです。`mprotect` の呼び出しは発生せず、カーネルが拒否する対象そのものがなくなります。

したがって実務的な指示は 1 行です。

```bash
# Latest stable at time of writing is 3.47.0 (Dart 3.13.0, 2026-08-12)
flutter upgrade
flutter clean
```

`flutter clean` はおまじないではありません。Flutter のツールは生成した LLDB 用ファイルを `ios/Flutter/ephemeral/` に書き出しており、以前の SDK が残した古いコピーが原因の誤動作は、修正の展開中に issue で繰り返し報告されました。

## Flutter 3.35 以降なのにまだクラッシュする場合

その場合、VM 側は正常でデバッガー側が正常でありません。二重マッピングは必要条件ですが十分条件ではなく、RX マッピングはデバッガーがページに触れて初めて有効になります。つまり LLDB が起動処理の一部でなければなりません。Flutter はこれを Xcode のスキーム経由で接続しており、スキームに設定が欠けていると同じ `mprotect` クラッシュが返ってきます。

ツールは debug ビルドと profile ビルドのたびにスキームの移行を試みます。移行できなかった場合は次のように出力します。

```
Running Flutter in debug mode on new iOS versions requires a LLDB Init File,
but the Runner scheme does not have it set. To ensure debug mode works, please
complete the following:
  * Open Xcode > Product > Scheme > Edit Scheme and for the Run and Test actions,
    set LLDB Init File to:

  $(SRCROOT)/Flutter/ephemeral/flutter_lldbinit
```

指示どおりに設定してください。求められているのは Run アクションと Test アクションの両方である点に注意します。移行処理は 2 つを独立にチェックし、欠けている側について警告します。すでに独自の LLDB Init File を使っている場合、Flutter はそれを上書きせず、あなたのファイルから Flutter のファイルを読み込むよう指示します。

```
command source /path/to/ios/Flutter/ephemeral/flutter_lldbinit
```

add-to-app プロジェクトではパスが異なります。Flutter モジュールが Swift パッケージとしてビルドされ、生成ファイルがパッケージの出力先に置かれるためです。スキームの LLDB Init File に `$(FLUTTER_SWIFT_PACKAGE_OUTPUT)/Scripts/flutter_lldbinit` を設定するか、自分のファイルからの相対パスで読み込んでください。

```
command source --relative-to-command-file "../my_flutter_app/build/ios/SwiftPackages/Scripts/flutter_lldbinit"
```

add-to-app のホスト側ではエラーではなく警告になります。どのスキームから起動しているかをツールが判断できないためです。プロジェクト内のすべての `.xcscheme` を走査して文字列 `customLLDBInitFile` を探し、どれにも無い場合にだけ警告します。スキームが 5 つあり設定されているのが間違ったものである場合、このチェックは通過したうえでクラッシュします。

## mprotect が塞がれているのに、なぜ JIT が動くのか

次の節の制約を理解するうえで役立つので、仕組みを見ておきます。

生成される `ios/Flutter/ephemeral/flutter_lldb_helper.py` は、VM がデバッガーへの合図としてのみエクスポートしているシンボルにブレークポイントを置き、デバッガー側からページに書き込みます。デバッガーはデバッグ対象プロセスの実行可能メモリを変更できるからです。

```python
# Generated by Flutter 3.44.2 into ios/Flutter/ephemeral/flutter_lldb_helper.py
import lldb

def handle_new_rx_page(frame: lldb.SBFrame, bp_loc, extra_args, intern_dict):
    """Intercept NOTIFY_DEBUGGER_ABOUT_RX_PAGES and touch the pages."""
    base = frame.register["x0"].GetValueAsAddress()
    page_len = frame.register["x1"].GetValueAsUnsigned()

    data = bytearray(page_len)
    data[0:8] = b'IHELPED!'

    error = lldb.SBError()
    frame.GetThread().GetProcess().WriteMemory(base, data, error)
    if not error.Success():
        print(f'Failed to write into {base}[+{page_len}]', error)
        return

def __lldb_init_module(debugger: lldb.SBDebugger, _):
    target = debugger.GetDummyTarget()
    bp = target.BreakpointCreateByRegex("^NOTIFY_DEBUGGER_ABOUT_RX_PAGES$")
    bp.SetScriptCallbackFunction('{}.handle_new_rx_page'.format(__name__))
    bp.SetAutoContinue(True)
    print("-- LLDB integration loaded --")
```

`IHELPED!` というマーカーは診断用です。`NOTIFY_DEBUGGER_ABOUT_RX_PAGES` は先頭 8 バイトを読み戻すことで、"デバッガーが処理した" 状態と "ブレークポイントが一度も設定されなかった" 状態を区別できます。それが、正しく動く構成とこの記事の冒頭のクラッシュとの分かれ目です。

Xcode のコンソールに `-- LLDB integration loaded --` が出ていれば、init file は正しく接続されています。

## Flutter 3.38 以降で何が変わったのか

Flutter 3.38.0 以降、ツールは実機について Xcode への委譲をやめ、`devicectl` と `lldb` を自前で制御するようになりました (PR [#173417](https://github.com/flutter/flutter/pull/173417)、[#173443](https://github.com/flutter/flutter/pull/173443)、[#173724](https://github.com/flutter/flutter/pull/173724))。`flutter run` はアプリを停止状態で起動し、LLDB に次のシーケンスを流し込みます。

```
device select <device-id>
breakpoint set --func-regex '^NOTIFY_DEBUGGER_ABOUT_RX_PAGES$'
breakpoint command add --script-type python <breakpoint-id>
device process attach --pid <app-pid>
process continue
```

これは全チャンネルでデフォルト有効な機能フラグの背後にあります。ローカルの Flutter 3.44.2 インストールで確認したところ、`packages/flutter_tools/lib/src/features.dart` には次の宣言があります。

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/features.dart
const lldbDebugging = Feature(
  name: 'support for debugging with LLDB for physical iOS devices',
  configSetting: 'enable-lldb-debugging',
  environmentOverride: 'FLUTTER_LLDB_DEBUGGING',
  master: FeatureChannelSetting(available: true, enabledByDefault: true),
  beta: FeatureChannelSetting(available: true, enabledByDefault: true),
  stable: FeatureChannelSetting(available: true, enabledByDefault: true),
);
```

条件は iOS 17 以降かつ Xcode 26 以降です。どちらかの条件を満たさない場合、ツールは黙って従来の Xcode 経由の起動にフォールバックします。Xcode 16 のままのマシンが、同じ Flutter バージョンの同僚とまったく異なる症状を示すのはこのためです。情報を突き合わせる前に `xcodebuild -version` を確認してください。

挙動がおかしい場合は、グローバルまたはプロジェクト単位で無効化できます。

```bash
flutter config --no-enable-lldb-debugging
```

```yaml
# pubspec.yaml, disables LLDB debugging for this project only
flutter:
  config:
    enable-lldb-debugging: false
```

## Flutter を更新できない場合はどうするか

古い SDK に固定されている場合、issue のスレッドでは 3.7.x への固定がよく見られましたが、バックポートもアプリ内での回避策もありません。取れる選択肢は、シミュレーターでテストする、iOS 18.3 以前の端末でテストする、あるいは AOT コンパイルされるため影響を受けない `flutter run --profile` を使う、の 3 つです。profile モードではホットリロードを失いますが、DevTools、タイムライン、ウィジェットインスペクターは使えるので、反復が多くない UI 作業の当座しのぎとしては実用に耐えます。

長く固定されていた SDK を安定版 4 つ分持ち上げるのは、それ自体が 1 つのプロジェクトです。固定バージョンの異なる複数のアプリを抱えているなら、一度にすべてを更新するより [1 本の CI パイプラインから複数の Flutter バージョンを対象にする](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) ほうが段階的に進めやすく、コストも低く済みます。

## このバグに見えて別物である落とし穴

**デバッグビルドはデバッガーの接続が続いていることを前提にするようになりました。** 端末上で debugserver を起動することが JIT を合法化しているので、デバッガーを接続せずにホーム画面から起動したデバッグビルドは同じように落ちます。これは報告すべきリグレッションではなく、仕組みそのものです。テスターに渡すものには profile ビルドか release ビルドを使ってください。

**iOS 26 のワイヤレスデバッグは遅いだけで壊れてはいません。** Flutter 3.44 は "Wireless debugging on iOS 26 may be slower than expected. For better performance, consider using a wired (USB) connection." と出力します。RX ページの受け渡しは 1 回ごとにデバッガーへの往復を伴い、Wi-Fi ではそれが積み上がります。元の issue にあった 10 秒のストールという報告のいくつかは、実際にはこれでした。バグを立てる前にケーブルを挿してください。

**CI の release ビルドが `customLLDBInitFile` について文句を言う場合。** スキームの移行処理が走るのは debug ビルドと profile ビルドだけですが、設定を誤ったスキームはリリースのパイプラインでも表面化しえます。release ビルドで init file を理由に CI が失敗しているなら、原因はスキームであってこのクラッシュではありません。release ビルドに JIT はなく、LLDB も不要です。

**フレーバーごとにスキームが分かれています。** Flutter が移行するのは、ビルド対象のフレーバーに対応して解決されたスキームだけです。`dev`、`staging`、`prod` のスキームがあり、ローカルでは `dev` しか起動していない場合、残りの 2 つは誰かがビルドするまで未移行のままで、それぞれ 1 回ずつ失敗します。

**Android 側で `mprotect` に言及するものはすべて別の問題です。** メモリページに関連する Android のビルド失敗は、ほぼ常に 16 KB ページサイズの要件であり、JIT ではなくパッケージングとアラインメントの問題です。それには [NDK r28 と zipalign を使う専用の対処法](/ja/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) があります。

## 関連記事

アプリが起動にすら到達しない場合、失敗は VM より手前にあります。[Xcode 16 と Flutter 3.x での Failed to build iOS app](/ja/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/) と [CocoaPods が pod の互換バージョンを見つけられない件](/ja/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/) が、残りの大部分を占める 2 つの失敗を扱っています。このクラッシュは実機でしか再現しないため、Mac が再現の前提条件にならないよう [Windows から Flutter iOS を実機でデバッグするワークフロー](/ja/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) を用意しておく価値もあります。3.35 以降への更新が他の破壊的変更を大量に連れてくる場合は、[Flutter 3.x の null safety チェックリスト](/ja/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) が古いコードベースで私が使っている進め方です。

## 参照元

- [Debug mode and hot reload fail on iOS 26 due to JIT restriction `error: mprotect failed: 13 (Permission denied)`](https://github.com/flutter/flutter/issues/163984)、P1 の追跡 issue。元のクラッシュダンプと修正の時系列について。
- [Add lldb init file](https://github.com/flutter/flutter/pull/164344) (flutter/flutter#164344、2025-03-06 マージ)。[Flutter 3.32.0 のリリースノート](https://docs.flutter.dev/release/release-notes/release-notes-3.32.0) に含まれています。
- [Flutter 3.38.0 のリリースノート](https://docs.flutter.dev/release/release-notes/release-notes-3.38.0)。iOS 17 以降かつ Xcode 26 以降で LLDB と `devicectl` が既定の起動経路になった件について。
- [Integrate a Flutter app into your iOS project](https://docs.flutter.dev/add-to-app/ios/project-setup)。add-to-app における LLDB Init File のパスについて。
- Dart SDK のコミット `939699a9` (`[vm] Add NOTIFY_DEBUGGER_ABOUT_RX_PAGES hook`)、`d194fcec` (`[vm] Use dual mapping of code pages on certain OS versions`)、`dc0567c0`、`c111f693`。タグの系譜はリリースタグ `3.8.1` と `3.9.0` に対して確認しました。
- コードはローカルの Flutter 3.44.2 stable のインストールから引用しました。`packages/flutter_tools/lib/src/features.dart`、`lib/src/ios/lldb.dart`、`lib/src/xcode_project.dart`、`lib/src/migrations/lldb_init_migration.dart`、`lib/src/build_system/targets/ios.dart` です。
