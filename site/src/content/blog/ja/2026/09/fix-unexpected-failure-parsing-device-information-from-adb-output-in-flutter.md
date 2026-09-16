---
title: "修正: Flutter で Unexpected failure parsing device information from adb output が表示される"
description: "Flutter 3.47.0 はシリアルが 22 文字以上の adb 行を解析できないため、ワイヤレス接続や一部の USB 接続の Android デバイスが表示されなくなります。3.47.1 以降にアップグレードするか、IP を指定して adb connect してください。"
pubDate: 2026-09-16
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "adb"
  - "flutter-tools"
lang: "ja"
translationOf: "2026/09/fix-unexpected-failure-parsing-device-information-from-adb-output-in-flutter"
translatedBy: "claude"
translationDate: 2026-09-16
---

これは Flutter 3.47.0 のパーサーのバグで、改めて報告する必要はありません。`adb devices -l` はシリアル列を 22 文字までパディングしてからスペースを 1 つ追加するため、22 文字以上のシリアル (ワイヤレスデバッグの `adb-...._adb-tls-connect._tcp` という名前はすべて該当し、一部の USB シリアルも該当します) の後ろにはスペースが 1 つしか続きません。3.47.0 のパーサーはそこにスペース 2 つ以上かタブを要求するため、その行を拒否し、デバイスを一覧から外してしまいます。`flutter upgrade` を実行して 3.47.1 以降 (現在の stable は 3.47.4) にしてください。3.47.0 のままにする必要がある場合は、ワイヤレスデバイスを `adb connect <ip>:<port>` で接続してください。IP の短いシリアルなら解析に成功します。

以下の内容はすべて、macOS 上で Flutter 3.44.8、3.47.0、3.47.4 (Dart 3.13.0 と 3.13.3) を使って再現したものです。各バージョンを、`platform-tools/adb` が偽のスクリプトになっている検証用の Android SDK に向け、同じ 9 行のデバイス行を与えました。

## エラーが発生する状況

`flutter devices` はデスクトップと Web のターゲットを表示しますが、`adb devices` からははっきり見えているスマートフォンが表示されません。

```text
Found 2 connected devices:
  macOS (desktop) • macos  • darwin-arm64   • macOS 26.6.1 25G76 darwin-arm64
  Chrome (web)    • chrome • web-javascript • Google Chrome 151.0.7922.140

No wireless devices were found.

Unexpected failure parsing device information from adb output:
adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp device product:oriole model:Pixel_6 device:oriole transport_id:1
Please report a bug at https://github.com/flutter/flutter/issues.
```

`flutter doctor` では見落としがちです。"Connected device" セクションには緑のチェックが付いたままで、警告はその下に表示されるからです。

```text
[✓] Connected device (2 available)
    ! Unexpected failure parsing device information from adb output:
      9b01005930533036340043eb2a5c2c device usb:17907712X product:serenity_p_in model:25028PC03I device:serenity transport_id:1
      Please report a bug at https://github.com/flutter/flutter/issues.
```

2 つ目の例はワイヤレスではなく USB 接続のスマートフォンです。そのため、一部のスレッドで見かける「ワイヤレスデバッグのときだけ起きる」というアドバイスは不完全です。Android Studio と VS Code も同じデバイス検出コードからデバイス一覧を取得するので、IDE のデバイス選択からもデバイスが消え、`flutter run -d <serial>` も一致する対象がありません。

報告は [flutter/flutter#191167](https://github.com/flutter/flutter/issues/191167) (USB、macOS 上の Flutter 3.47.0)、[#191119](https://github.com/flutter/flutter/issues/191119) (Fedora での Wi-Fi ペアリング)、[#191343](https://github.com/flutter/flutter/issues/191343) (Ubuntu)、および上流の [#189430](https://github.com/flutter/flutter/issues/189430) と [#189972](https://github.com/flutter/flutter/issues/189972) です。

## Flutter 3.47.0 が有効な adb 行を拒否する理由

adb は `transport.cpp` の `append_transport` で、詳細一覧の各行を組み立てます。

```cpp
// adb (platform/packages/modules/adb), transport.cpp
android::base::StringAppendF(result, "%-22s %s", serial.c_str(),
                             to_string(t->GetConnectionState()).c_str());
```

`%-22s` は最小幅であり、列ではありません。`ZN52278M76` のような 10 文字のシリアルには 12 個のパディングと固定のスペースが付き、合計 13 個のスペースになります。21 文字のシリアルなら 2 個です。22 文字以上のシリアルではちょうど 1 個になります。ワイヤレスデバッグのシリアルは mDNS のサービス名で、`._adb-tls-connect._tcp` というサフィックスだけで 22 文字あります。USB シリアルにも該当するものが多く、#191167 の 30 文字のシリアルがその一例です。

Flutter 3.44.x は `^(\S+)\s+(\S+)(.*)` で行を解析していました。最初のトークン、任意の空白、2 番目のトークンという形です。これはスペース 1 つでも問題なく扱えますが、シリアル自体にスペースが含まれると壊れます。ワイヤレスデバッグを素早くオン/オフすると、mDNS が競合回避のサフィックスを付け、シリアルは `adb-26151FDF60083B-9tP4nl (2)._adb-tls-connect._tcp` になります。すると Flutter 3.44.8 は最初のスペースでシリアルを切ってしまいます。偽の adb が受け取った呼び出しは `adb -s adb-26151FDF60083B-9tP4nl shell getprop` と記録されており、実際の adb サーバーはこの切り詰められたシリアルを知りません。

これを修正するために、3.47 サイクル中に 3 回の試みがありました。

1. [#187943](https://github.com/flutter/flutter/pull/187943) は最短一致のシリアルマッチ `^(.*?)\s+(no permissions|\S+)...` に切り替え、3.47.0-0.1.pre に含まれました。これにより、`key:` プレフィックスのない devpath を持つ行が壊れました。
2. [#189369](https://github.com/flutter/flutter/pull/189369) は、既知の adb の状態を明示的に列挙し、状態の前に `(?:\s{2,}|\t+)` を要求することでそれを修正しました。beta にチェリーピックされ、3.47.0 に含まれました。このスペース 2 つのルールこそが、この記事で扱うバグです。
3. [#189973](https://github.com/flutter/flutter/pull/189973) は、既知の状態を表す単語をアンカーにした最長一致のシリアルキャプチャに切り替え、その後パディングを削除するようにしました。[#191296](https://github.com/flutter/flutter/pull/191296) として stable にチェリーピックされ、2026 年 8 月 19 日に 3.47.1 でリリースされました。

以下は `packages/flutter_tools/lib/src/android/android_device_discovery.dart` にある 3.47.0 の正規表現です。

```dart
// Flutter 3.47.0, android_device_discovery.dart
static final _kDeviceRegex = RegExp(
  r'^(.*?)(?:\s{2,}|\t+)'
  r'(device|offline|unauthorized|no permissions|bootloader|recovery|sideload|rescue|connecting|authorizing|host|unknown)'
  r'(?:\s+(.*)|$)',
);
```

3.47.1 での変更は、1 行目が `r'^(.*)\s+'` になったことと、キャプチャしたシリアルに `trimRight()` を適用するようになったことだけです。このファイルは 3.47.1 から 3.47.4 まで、そして 3.48.0-0.5.pre beta でも同一です。

## 偽の adb を使った最小限の再現

これを確認するのにスマートフォンは必要ありません。Flutter は `adb` を `$ANDROID_HOME/platform-tools/adb` で探すので、そのパスにシェルスクリプトを置けば好きな行を出力させられます。このスクリプトは adb と同じ `%-22s %s` 形式を使います。

```bash
#!/bin/bash
# Fake adb for Flutter 3.44.8 / 3.47.0 / 3.47.4 repros: $SDK/platform-tools/adb
if [ "$1" = "devices" ]; then
  echo "List of devices attached"
  printf '%-22s %s\n' "adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp" \
    "device product:oriole model:Pixel_6 device:oriole transport_id:2"
  echo
  exit 0
fi
if [ "$1" = "-s" ] && [ "$3" = "shell" ] && [ "$4" = "getprop" ]; then
  printf '[ro.build.characteristics]: [phone]\n[ro.build.version.release]: [16]\n'
  printf '[ro.build.version.sdk]: [36]\n[ro.product.cpu.abi]: [arm64-v8a]\n'
  exit 0
fi
exit 0
```

```bash
# Flutter 3.47.0 vs 3.47.4, same fake SDK
chmod +x sdk/platform-tools/adb
ANDROID_HOME=$PWD/sdk XDG_CONFIG_HOME=$PWD/xdg flutter devices
```

`XDG_CONFIG_HOME` は、以前 `flutter config --android-sdk` で保存したパスが `ANDROID_HOME` を上書きしないようにするためのものです。各バージョンで 9 行を試しました。表は `flutter devices` の出力結果を示しています。

| adb の行 | 3.44.8 | 3.47.0 | 3.47.4 |
|---|---|---|---|
| USB、10 文字のシリアル `ZN52278M76` | 表示される | 表示される | 表示される |
| USB、21 文字のシリアル | 表示される | 表示される | 表示される |
| USB、22 文字のシリアル | 表示される | 解析失敗 | 表示される |
| USB、30 文字のシリアル | 表示される | 解析失敗 | 表示される |
| ワイヤレス mDNS `adb-...._adb-tls-connect._tcp` | 表示される | 解析失敗 | 表示される |
| `(2)` サフィックス付きのワイヤレス mDNS | 切り詰められたシリアルで表示される | 解析失敗 | 表示される |
| ワイヤレス `192.168.1.3:36809` | 表示される | 表示される | 表示される |
| ワイヤレス mDNS、`unauthorized` | "is not authorized" のヒント | 解析失敗 | "is not authorized" のヒント |
| USB、`detached` | デバイスとして表示される | 解析失敗 | 解析失敗 |

21 文字と 22 文字の境界がすべてです。最後の行は別の問題で、後述の注意点で扱います。

## 修正 1: Flutter を 3.47.1 以降にアップグレードする

まず現在のバージョンを確認します。

```bash
# Flutter 3.47.x
flutter --version
```

1 行目が `Flutter 3.47.0` なら、stable チャネルでアップグレードします。

```bash
# moves 3.47.0 to the latest 3.47.x hotfix (3.47.4 as of 2026-09-16)
flutter upgrade
flutter devices
```

修正は [3.47.1 の CHANGELOG エントリ](https://github.com/flutter/flutter/blob/3.47.4/CHANGELOG.md) に "Fix ADB device list parsing for long wireless mDNS serials separated from state by a single space" として記載されています。文面ではワイヤレスのシリアルに触れていますが、表のとおり長い USB シリアルにも効きます。FVM や CI マトリクスでバージョンを固定している場合は、`flutter upgrade` を実行するのではなく、固定バージョンを `3.47.4` に上げてください。固定された各レッグはそれぞれ独自のツールのスナップショットを持つので、3.47.0 のレッグは単独で失敗し続けます。[1 つのパイプラインから複数の Flutter バージョンをターゲットにする](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) 場合も同様です。

`bin/cache/flutter_tools.snapshot` を手動で削除する必要はありません。`flutter upgrade` がツールを再ビルドします。代わりに git でタグをチェックアウトした場合も、次の `flutter` コマンドが新しいリビジョンを検出してスナップショットを再ビルドします。

## 修正 2: 3.47.0 のままワイヤレスデバイスを IP で接続する

リリースブランチが 3.47.0 に固定されているなどの理由ですぐにアップグレードできない場合は、シリアルを短くします。IP とポートを指定した `adb connect` は、`192.168.1.3:36809` のようなシリアルを持つトランスポートを作成します。これは 17 文字なので 2 個以上のスペースでパディングされ、3.47.0 でも解析できます。

```bash
# Android 11+ wireless debugging, Flutter 3.47.0
# IP address & Port from Settings > Developer options > Wireless debugging
adb connect 192.168.1.3:36809
adb devices -l
flutter devices
```

"Pair device with pairing code" ダイアログに表示される 1 回限りのポートではなく、ワイヤレスデバッグ画面に表示される接続用ポートを使ってください。Issue #191343 には実機での結果があります。mDNS の行では引き続き警告が表示されますが、デバイスは IP のシリアルで一覧に表示されます。

adb が mDNS トランスポートを自動接続しないようにして警告も消すには、adb サーバーの起動前に `ADB_MDNS_AUTO_CONNECT=0` を設定します。adb の `adb_mdns.cpp` では、値 `0` によって自動接続の許可リストが空になります。このリストのデフォルトは `adb-tls-connect` のみです。この変数はサーバープロセスが読み取るので、サーバーを再起動してください。

```bash
# adb (platform-tools), macOS/Linux shell
adb kill-server
ADB_MDNS_AUTO_CONNECT=0 adb start-server
adb connect 192.168.1.3:36809
```

Windows では、`adb start-server` の前に cmd で `set ADB_MDNS_AUTO_CONNECT=0` を、PowerShell なら `$env:ADB_MDNS_AUTO_CONNECT = "0"` を実行してください。Android Studio は adb サーバーが動いていなければ独自に起動するので、先に自分のサーバーを起動しておきます。

長いシリアルを持つ USB デバイスには同様の回避策はありません。ハードウェアのシリアルは短くできないからです。その場合はアップグレードが修正方法です。どうしてもアップグレードできない場合は、上記のようにそのデバイスをワイヤレスの IP 接続で使ってください。

## 自分の adb 出力を両方のパーサーで確認する

自分の行がこのバグに該当するかわからない場合は、この Dart スクリプトを使ってください。ツールからそのままコピーした 3.47.0 と 3.47.1 の正規表現を、`adb devices -l` の出力に対して実行します。

```dart
// Dart 3.13 (Flutter 3.47). Run: adb devices -l | dart run check_adb_rows.dart
import 'dart:convert';
import 'dart:io';

const states =
    r'(device|offline|unauthorized|no permissions|bootloader|recovery|sideload|rescue|connecting|authorizing|host|unknown)';

final flutter3470 = RegExp(r'^(.*?)(?:\s{2,}|\t+)' + states + r'(?:\s+(.*)|$)');
final flutter3471 = RegExp(r'^(.*)\s+' + states + r'(?:\s+(.*)|$)');

Future<void> main() async {
  final lines = await stdin.transform(utf8.decoder).transform(const LineSplitter()).toList();
  for (final raw in lines) {
    final line = raw.trim();
    if (line.isEmpty || line.startsWith('List of devices') || line.startsWith('* daemon ')) {
      continue;
    }
    final old = flutter3470.firstMatch(line);
    final fixed = flutter3471.firstMatch(line);
    print(line);
    print('  3.47.0:  ${old == null ? 'PARSE FAILURE' : 'serial="${old[1]}" state=${old[2]}'}');
    print('  3.47.1+: ${fixed == null ? 'PARSE FAILURE' : 'serial="${fixed[1]!.trimRight()}" state=${fixed[2]}'}');
  }
}
```

9 行のテスト行すべてで、実際のツールと結果が一致しました。ワイヤレスの行では次のように出力されます。

```text
adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp device product:oriole model:Pixel_6 device:oriole transport_id:2
  3.47.0:  PARSE FAILURE
  3.47.1+: serial="adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp" state=device
```

## 注意点と似たエラー

**`detached` のデバイスは 3.47.1 から 3.47.4 でも失敗します。** 最近の platform-tools には `adb detach` と `adb attach` があり、USB デバイスを解放して別のプロセスが使えるようにします。adb はこの接続状態を `detached` と呼びます (`adb.cpp` の `to_string(ConnectionState)` を参照)。この単語は Flutter の状態リストにないため、修正済みのパーサーでも "Unexpected failure parsing device information" と報告されます。Flutter 3.44.8 は同じ行を通常のデバイスとして表示していました。`adb -s <serial> attach` を実行すると、行は `device` に戻ります。3.48.0-0.5.pre beta も同じ状態リストなので、これはまだ修正されていません。

**アップグレード後に "is not authorized" が表示されることがあります。** 3.47.0 では、USB デバッグの承認待ちになっている長いシリアルのデバイスも解析失敗として表示され、本当の問題が隠れてしまいます。3.47.1 以降で行が解析されると、"Device ... is not authorized. You might need to check your device for an authorization dialog." が表示されます。スマートフォンのロックを解除し、RSA キーの確認を許可してください。

**`(2)` サフィックスは実在する別のシリアルです。** `adb devices -l` に `adb-XXXX._adb-tls-connect._tcp` と `adb-XXXX (2)._adb-tls-connect._tcp` の両方が表示される場合、mDNS の名前競合の後に、adb が同じスマートフォンへのトランスポートを 2 つ持っています。Flutter 3.47.1 以降は各行を個別に解析するので、両方が別々のエントリとして表示されます。`-d` でどちらかを選ぶか、スマートフォンでワイヤレスデバッグをもう一度オン/オフしてエントリを 1 つに戻してください。3.44.x ではサフィックス付きのものが切り詰められたシリアルで表示され、adb コマンドがそれを見つけられずに失敗します。これが #187943 で修正しようとしたバグです。

**adb の行が正常なのに "No supported devices connected" と表示されるのは別の問題です。** 行は解析されているのにデバイスが表示されない場合は、パーサーではなく ABI と API レベルを確認してください。MAUI での同等の問題は [doesn't support required ABI](/ja/2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app/) で扱っています。`adb` 自体が見つからない場合は SDK の検索が問題で、[cmdline-tools component is missing の記事](/ja/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) で Flutter の SDK 解決順序を説明しています。

**`adb server version doesn't match this client` は解析失敗ではありません。** Flutter はこの行を別の診断として報告します。通常は 2 つの platform-tools のインストールが競合していることを意味し、Homebrew のものと Android Studio のものであることがよくあります。どちらか一方を `PATH` の先頭に置き、`adb kill-server` を実行してください。

## 関連記事

- [修正: cmdline-tools 23 で flutter doctor --android-licenses が失敗する](/ja/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/) も、本当の修正が 3.47.x のホットフィックスである Android ツールのバグです。
- [Flutter 3.47.1 ホットフィックスに含まれたその他の変更](/ja/2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection/)。プラグインレジストラントの検証の変更も含まれます。
- `adb install` でインストールしたアプリにアタッチする場合は、[flutter attach でホットリスタート後も appFlavor を保持する方法](/ja/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/) を参照してください。
- [flutter upgrade 後の Could not create Dart VM instance](/ja/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/) は、特定の壊れたリリースから移行することが修正になるケースです。
- 実機デバッグの iOS 側については、[Windows から実機の iPhone で Flutter をデバッグする](/ja/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) を参照してください。

## 出典

- [flutter/flutter#189972](https://github.com/flutter/flutter/issues/189972) と [#189430](https://github.com/flutter/flutter/issues/189430) (上流の Issue)、およびユーザーからの報告 [#191167](https://github.com/flutter/flutter/issues/191167)、[#191119](https://github.com/flutter/flutter/issues/191119)、[#191343](https://github.com/flutter/flutter/issues/191343)。
- [flutter/flutter#189973](https://github.com/flutter/flutter/pull/189973) (修正) と [#191296](https://github.com/flutter/flutter/pull/191296) (その stable へのチェリーピック)。
- [flutter/flutter#189369](https://github.com/flutter/flutter/pull/189369) と [#187943](https://github.com/flutter/flutter/pull/187943) (それ以前のパーサーの変更)。
- [3.47.0 の `android_device_discovery.dart`](https://github.com/flutter/flutter/blob/3.47.0/packages/flutter_tools/lib/src/android/android_device_discovery.dart) と [3.47.4 のもの](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/android/android_device_discovery.dart)。
- [3.47.4 時点の Flutter CHANGELOG](https://github.com/flutter/flutter/blob/3.47.4/CHANGELOG.md)。
- adb のソース: [`transport.cpp`](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/transport.cpp) (`append_transport`)、[`adb.cpp`](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/adb.cpp) (接続状態の名前)、[`adb_mdns.cpp`](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/adb_mdns.cpp) (`ADB_MDNS_AUTO_CONNECT`)。
- Android 11 以降のワイヤレスデバッグを含む [Android Debug Bridge のドキュメント](https://developer.android.com/tools/adb)。
