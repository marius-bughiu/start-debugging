---
title: "Flutter の設定保存に shared_preferences と path_provider の JSON ファイルのどちらを使うべきか"
description: "少数のフラットなフラグには shared_preferences (SharedPreferencesWithCache) を、構造化された設定オブジェクトには getApplicationSupportDirectory に置く JSON ファイルを使います。アトミックな書き込みパターン、同時保存の競合状態、Windows と Linux での Documents フォルダーの罠、Web 対応、Flutter 3.44.8 で計測した書き込みコストを解説します。"
pubDate: 2026-10-30
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "shared-preferences"
  - "path-provider"
  - "local-storage"
lang: "ja"
translationOf: "2026/10/shared-preferences-vs-json-file-for-persisting-settings-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-30
---

設定が十数個のフラットで互いに独立した値 (テーマ、"オンボーディング表示済み" フラグ、最後に選択したタブなど) であれば、`shared_preferences` の `SharedPreferencesWithCache` API を使ってください。同期読み取り、Web 対応、ファイル管理不要という利点があります。設定がネストした map やリスト、マイグレーションが必要なスキーマを持つ 1 つの構造化オブジェクトになった時点で、`getApplicationDocumentsDirectory()` ではなく `getApplicationSupportDirectory()` に、アトミックに (一時ファイルに書いてから rename し、書き込みを直列化して) 保存する単一の JSON ファイルに切り替えます。以下の内容はすべて Flutter 3.44.8 (Dart 3.12.2)、`shared_preferences` 2.5.6、`path_provider` 2.1.6 を使い、Apple M4 上の実際の macOS デバッグビルドで検証しました。

## 比較表

| | `shared_preferences` 2.5.6 | `path_provider` 2.1.6 による JSON ファイル |
| --- | --- | --- |
| 値の型 | `bool`、`int`、`double`、`String`、`List<String>` | `jsonEncode` が扱えるものすべて (ネストした map、リスト、null) |
| 読み取り API | 同期 (`SharedPreferencesWithCache`) または非同期 (`SharedPreferencesAsync`) | 一度だけ非同期で読み込み、以降は自前のメモリ上のオブジェクト |
| 書き込みの永続性 | 戻った時点でディスクに書かれている "保証はない" (README) | 自分で制御できます: `flush: true` + アトミックな rename |
| 部分更新 | キー単位で標準対応 | ファイル全体を書き直し (数百 KB 未満なら問題なし) |
| スキーマのマイグレーション | キーごとに手動 | `schemaVersion` フィールド 1 つとマイグレーション関数 1 つ |
| Web | 対応 (`localStorage`) | 非対応: `path_provider` に Web 実装はありません |
| Android での保存先 | DataStore Preferences (新 API) または `SharedPreferences` (レガシー) | アプリのプライベートなデータディレクトリ内のファイル |
| iOS/macOS での保存先 | `NSUserDefaults` の plist | Application Support 内のファイル |
| ネイティブコードやウィジェットからの読み取り | 可能 (プラットフォームの保存領域そのもの) | ネイティブコードがそのファイルを読む場合のみ |
| 並行処理の落とし穴 | isolate ごとのキャッシュが古くなる | 直列化しないと同時保存が一時ファイルを壊す |
| 自分で書くコード | ほぼなし | 約 60 行 |

どちらも "データベース" ではありません。ユーザーのコンテンツ、増え続けるリスト、クエリする必要があるデータを保存するなら、これらではなく SQLite (drift、sqflite) を使うべきです。

## shared_preferences を選ぶべき場面

- **少数のフラットで独立したフラグ。** `onboardingDone`、`themeMode`、`lastTabIndex`、`analyticsOptIn` などです。各キーは単独で読み書きされ、キー同士に関係はなく、書き込みが失われてもダイアログが 2 回表示される程度で済みます。
- **起動時に値を同期的に必要とする場合。** `SharedPreferencesWithCache` は `create()` で一度すべてを読み込み、その後のゲッターはすべて同期です。そのため `FutureBuilder` なしで `build()` の中でテーマを読めます。
- **Web 向けにも配布する場合。** `shared_preferences_web` 2.4.3 は `localStorage` に対応付けられます。JSON ファイル方式はブラウザーでは一切動きません。`dart:io` の `File` がブラウザーに存在せず、`path_provider` も Web をサポート対象に挙げていないためです。
- **ネイティブコードが同じ値を必要とする場合。** ホーム画面ウィジェット、通知拡張、移行元の既存ネイティブアプリは `NSUserDefaults` や Android の `SharedPreferences` を直接読みます。独自の JSON ファイルはそのどれからも見えません。

今日リリースするならこのバージョンにします。README がレガシーな `SharedPreferences` クラスの代わりに新規コードで推奨している `SharedPreferencesWithCache` を、allow list 付きで使っています。

```dart
// Flutter 3.44.8, Dart 3.12.2, shared_preferences 2.5.6
import 'package:shared_preferences/shared_preferences.dart';

class PrefsSettingsStore {
  PrefsSettingsStore._(this._prefs);

  final SharedPreferencesWithCache _prefs;

  static const _themeMode = 'themeMode';
  static const _fontScale = 'fontScale';
  static const _onboardingDone = 'onboardingDone';

  static Future<PrefsSettingsStore> open() async {
    final prefs = await SharedPreferencesWithCache.create(
      cacheOptions: const SharedPreferencesWithCacheOptions(
        allowList: {_themeMode, _fontScale, _onboardingDone},
      ),
    );
    return PrefsSettingsStore._(prefs);
  }

  // Synchronous reads after open(): safe to call from build().
  String get themeMode => _prefs.getString(_themeMode) ?? 'system';
  double get fontScale => _prefs.getDouble(_fontScale) ?? 1.0;
  bool get onboardingDone => _prefs.getBool(_onboardingDone) ?? false;

  Future<void> setThemeMode(String value) => _prefs.setString(_themeMode, value);
  Future<void> setFontScale(double value) => _prefs.setDouble(_fontScale, value);
  Future<void> completeOnboarding() => _prefs.setBool(_onboardingDone, true);
}
```

allow list は飾りではありません。これがあると、`getString('themMode')` のようなタイプミスは黙って `null` を返すのではなく `ArgumentError` ("themMode is not included in the PreferencesFilter allowlist") を投げます。また `clear()` はプラグインから見えるすべてではなく、自分のキーだけを削除します。

## JSON ファイルを選ぶべき場面

- **設定がキーの寄せ集めではなく 1 つのオブジェクトである場合。** チャンネルごとの通知設定、保存済みフィルターのリスト、アカウントごとの上書き設定などです。これを `notifications.replies`、`notifications.digest`、`filters.0.name` のようなキーに平坦化すると、2 回の `setString` 呼び出しの間にアプリが終了したとき、中途半端に更新された状態が残ります。
- **スキーマバージョンが必要な場合。** ファイルなら `"schemaVersion": 2` を一度書き、読み込み時にマイグレーション関数を 1 つ実行するだけです。キー方式ではキーを 1 つずつマイグレーションし、その間に古いビルドがどれも書き込んでいないことを祈ることになります。
- **本当の永続性の保証が欲しい場合。** `shared_preferences` の README は、戻った時点で書き込みがディスクに永続化される保証はなく、重要なデータの保存には使うべきでないとはっきり書いています。自前のファイルなら、`flush: true` とアトミックな rename によって、クラッシュ後も古い設定か新しい設定のどちらかが残り、途中で切れた混合状態にはなりません。
- **設定をテキストとしてエクスポート、バックアップ、デバッグしたい場合。** サポート担当者はデスクトップのユーザーに `settings.json` を添付してもらえます。DataStore の protobuf の場所をユーザーに案内する人はいません。

以下が私の使っているストアです。多くのチュートリアルが省略している 3 つの点、つまりディレクトリ、アトミックな書き込み、書き込みキューに注目してください。

```dart
// Flutter 3.44.8, Dart 3.12.2, path_provider 2.1.6
import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

class AppSettings {
  const AppSettings({
    this.themeMode = 'system',
    this.fontScale = 1.0,
    this.notifications = const {'replies': true, 'digest': 'weekly'},
  });

  final String themeMode;
  final double fontScale;
  final Map<String, Object?> notifications;

  static const schemaVersion = 2;

  AppSettings copyWith({String? themeMode, double? fontScale}) => AppSettings(
        themeMode: themeMode ?? this.themeMode,
        fontScale: fontScale ?? this.fontScale,
        notifications: notifications,
      );

  Map<String, Object?> toJson() => {
        'schemaVersion': schemaVersion,
        'themeMode': themeMode,
        'fontScale': fontScale,
        'notifications': notifications,
      };

  factory AppSettings.fromJson(Map<String, dynamic> json) => AppSettings(
        themeMode: json['themeMode'] as String? ?? 'system',
        fontScale: (json['fontScale'] as num?)?.toDouble() ?? 1.0,
        notifications:
            (json['notifications'] as Map<String, dynamic>?) ?? const {},
      );
}

class JsonSettingsStore {
  JsonSettingsStore._(this._file);

  final File _file;
  Future<void> _tail = Future<void>.value();

  static Future<JsonSettingsStore> open() async {
    // Application Support, not Documents: see the Windows/Linux gotcha below.
    final dir = await getApplicationSupportDirectory();
    await dir.create(recursive: true);
    return JsonSettingsStore._(File('${dir.path}/settings.json'));
  }

  Future<AppSettings> load() async {
    if (!await _file.exists()) return const AppSettings();
    try {
      final json = jsonDecode(await _file.readAsString()) as Map<String, dynamic>;
      return AppSettings.fromJson(_migrate(json));
    } on FormatException {
      // Truncated or hand-edited file: keep a copy for diagnostics, start fresh.
      await _file.copy('${_file.path}.corrupt');
      return const AppSettings();
    }
  }

  Future<void> save(AppSettings settings) {
    // Chain every write so two saves never share the temp file.
    return _tail = _tail.then((_) => _writeAtomic(settings.toJson()));
  }

  Future<void> _writeAtomic(Map<String, Object?> data) async {
    final tmp = File('${_file.path}.tmp');
    await tmp.writeAsString(jsonEncode(data), flush: true);
    await tmp.rename(_file.path);
  }

  static Map<String, dynamic> _migrate(Map<String, dynamic> json) {
    final version = json['schemaVersion'] as int? ?? 1;
    if (version < 2) {
      // v1 stored a bool 'darkMode'; v2 stores a 'themeMode' string.
      json['themeMode'] = (json.remove('darkMode') as bool? ?? false) ? 'dark' : 'light';
    }
    return json;
  }
}
```

起動時に一度読み込み、`AppSettings` を状態管理レイヤー (`ValueNotifier`、Riverpod の `Notifier` など、すでに使っているもの) に保持し、変更のたびに `save()` を呼びます。起動後の読み取りはディスクに触れません。これは `SharedPreferencesWithCache` が代わりに行っているのと同じトレードオフです。

## 素朴な JSON ストアを壊す同時保存の競合状態

ネットでよく見かけるこのパターンは、`.tmp` ファイルに `writeAsString` してから `rename` するだけで、キューがありません。アトミックに見えますし、呼び出し元が 1 つならその通りです。しかしスライダーの `onChanged` につなぐと、同じ一時パスを共有する保存が何度も重なります。素の Dart 3.12.2 で `await` なしの保存を 50 回同時に発行してみました。

```dart
// Dart 3.12.2
await Future.wait([
  for (var i = 0; i < 50; i++)
    writeAtomic(file, {'counter': i}).catchError((Object e) { errors++; }),
]);
```

結果は、50 回中 49 回の書き込みが `PathNotFoundException: Cannot rename file ... (OS Error: No such file or directory, errno = 2)` を投げました。最初の rename が一時ファイルを移動してしまい、残りの保存はもう存在しないファイルを rename しようとしたのです。タイミングによっては、別の保存が同じパスにまだ書き込んでいる最中に、ある保存のバイト列が所定の場所に rename されることもあります。上のストアの `_tail = _tail.then(...)` チェーンを使うと、同じ 50 回の保存でエラーは 0 件、ファイルには最後の値が入っていました。私の実行では壊れたケースでも最終的なファイルは正しかったのですが、だからこそこのバグはコードレビューをすり抜けます。クラッシュレポートに例外として現れるだけなのです。

キー入力やスライダーの動きごとに保存するなら、debounce も入れてください (300 ms で十分です)。キューは同時保存を安全にし、debounce はそれを安くします。

## 書き込みに実際にかかるコスト

どちらの方式も十分に速いので、パフォーマンスで選ぶべきではありません。とはいえ "十分に速い" には数字が必要です。JSON ストアの書き込み経路 (エンコード、一時ファイルの書き込み、rename) を、927 バイトの設定ペイロード (約 40 キー、ネストした map 1 つ、20 要素のリスト 1 つ) で計測しました。ウォームアップ 200 回の後に 2,000 回を計測し、Apple M4、macOS、APFS 上で JIT の `dart run` (Dart 3.12.2) と `Stopwatch` を使っています。

| 操作 | 中央値 | p95 | p99 |
| --- | --- | --- | --- |
| エンコード + 書き込み + `flush: true` + rename | 177 µs | 235 µs | 318 µs |
| エンコード + 書き込み + rename (flush なし) | 155 µs | 247 µs | 328 µs |
| 読み取り + `jsonDecode` | 62 µs | 69 µs | n/a |

注意点が 2 つあります。M4 の SSD では flush による中央値の増加は約 20 µs にとどまりましたが、ローエンドの Android のフラッシュストレージではかなり高くつくと考えてください。これも debounce を入れる理由の 1 つです。また `shared_preferences` の書き込みは計測していません。platform channel を経由して `NSUserDefaults` や DataStore に届くため、コストはプラグインではなくプラットフォームに依存するからです。設定程度のサイズであれば、どちらもフレーム予算に影響しません。ファイル方式が問題になるのは "設定" が数 MB のキャッシュデータにまで膨らんだ場合だけで、その時点でもはや設定ファイルにすべきではありません。

## 選択を決定づける落とし穴

**デスクトップでは `getApplicationDocumentsDirectory()` はユーザーのドキュメントフォルダーです。** Windows では `path_provider_windows` がこれを `WindowsKnownFolder.Documents` に対応付けます。Linux では XDG のユーザーディレクトリ `DOCUMENTS` です。あなたの `settings.json` はユーザーの確定申告書類の隣に置かれ、OneDrive に同期され、フォルダーを整理する人に削除されます。iOS では `UIFileSharingEnabled` を有効にした瞬間にユーザーから見えるようになります。`path_provider` のドキュメントも同じことを述べています。Documents はユーザーが生成したデータ用であり、そうでなければ `getApplicationSupportDirectory()` を検討すべきだ、ということです。Application Support は Windows ではローミング AppData、Linux では `XDG_DATA_HOME/<app id>`、macOS ではサンドボックス内の `Library/Application Support/<bundle id>` に対応します (macOS ビルドで `settings.json` が `~/Library/Containers/com.example.settingsDemo/Data/Library/Application Support/com.example.settingsDemo/` に作られることを確認しました)。Documents を使う JSON 設定のチュートリアルは、デスクトップではすべて間違っています。

**Web ではファイル方式は使えません。** アプリが Web を対象にするなら答えは決まっています。`shared_preferences` を使い、ネストが必要なら構造化オブジェクトを `jsonEncode` した 1 つの文字列として 1 つのキーに保存します。永続性の保証は失いますが、単一オブジェクトのモデルは保てます。

**バックグラウンドの isolate や engine は古いキャッシュを見ます。** `shared_preferences` の README には、`SharedPreferences` と `SharedPreferencesWithCache` が isolate ごとにキャッシュを持つと明記されています。そのため `firebase_messaging` のバックグラウンドハンドラーや 2 つ目の engine から書き込んだ値は、`reload()` を呼ぶまでメインの isolate からは見えません。複数の isolate が同じ設定を書き込むなら、キャッシュを使わない `SharedPreferencesAsync` を使ってください。JSON ファイルはさらに悪い形で同じ問題を抱えます。それぞれ独自の書き込みキューを持つ 2 つの isolate は、依然として処理が交錯し得ます。書き込みはすべて 1 つの isolate に集め、他の isolate からはメッセージを送るようにしてください。すでに [CPU バウンドな処理用のバックグラウンド isolate](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) で重い処理をしているなら、その isolate に設定ファイルを持たせないでください。

**レガシーのキーにはプレフィックスがあり、新しいキーにはありません。** レガシーの `SharedPreferences` クラスはすべてのキーを `flutter.` プレフィックス付きで保存します。`SharedPreferencesWithCache` と `SharedPreferencesAsync` は付けません。私の macOS ビルドでは plist にプレフィックスなしの `themeMode` キーが入っていました。Android では新 API がデフォルトで DataStore を使うため、ファイル自体がまったく別物です。つまり、リリース済みアプリで API を切り替えるのはリファクタリングではなくデータのマイグレーションです。起動時に `package:shared_preferences/util/legacy_to_async_migration_util.dart` の `migrateLegacySharedPreferencesToSharedPreferencesAsyncIfNecessary` を実行しないと、アップデート時にユーザーの設定が失われます。

**Android のバックアップはどちらにも適用されます。** Auto Backup はデフォルトでアプリのプライベートファイルと設定の保存領域を含むため、JSON ファイルに移ってもクラウドバックアップの対象から外れるわけではありません。デバイス固有の設定 (キャッシュしたサーバー URL、デバッグ用トグルなど) は、どちらの方式でもバックアップルールで除外してください。

## 私の推奨

フラットなフラグには `shared_preferences` と `SharedPreferencesWithCache` から始めてください。ほとんどのアプリにとって正しいデフォルトであり、Flutter が対象とするすべてのプラットフォームで動き、Web では唯一の選択肢です。ドット区切りのキー名を考え出していたり、一緒に変更しなければならない関連キーを 3 つ書いていたり、スキーマバージョンが欲しくなったりしたら、その時点で構造化された部分を `getApplicationSupportDirectory()` に置く単一の JSON ファイルへ移し、flush、rename、直列化キューで書き込んでください。多くのアプリは最終的に両方を使います。ネイティブコードや最初のフレームが必要とする少数のフラグは `shared_preferences` に、本来の設定オブジェクトは 1 つの `settings.json` に置く形です。

データがそもそも設定ではない場合 (ユーザーのコンテンツ、履歴、増え続けるもの) は、どちらも使わずに SQLite を使ってください。その方法でアプリのローカルデータを移行する手順は、[Flutter アプリを Hive から drift へ移行する](/ja/2026/10/migrate-a-flutter-app-from-hive-to-drift/) で解説しています。

### 次に読む

- プラグインを追加した後に `getAll` が `MissingPluginException` を投げる場合は、[shared_preferences の MissingPluginException を修正する方法](/ja/2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall/) を参照してください。
- 設定と一時的な UI の状態は別物です。OS がアプリを終了しても残す必要があるスクロール位置やフォーム入力には、[RestorationMixin で Android のプロセス終了後に UI の状態を復元する](/ja/2026/10/how-to-restore-ui-state-after-android-process-death-in-flutter-with-restorationmixin/) 方法を使ってください。
- 設定オブジェクトにポリモーフィックな型が含まれる場合は、[Dart の sealed class 階層を JSON にシリアライズ、デシリアライズする](/ja/2026/10/how-to-serialize-and-deserialize-a-dart-sealed-class-hierarchy-to-and-from-json/) で使うべき `toJson`/`fromJson` の形を紹介しています。
- 設定の読み込みは非同期なので、設定を変更する画面は保存を待機します。必要な `mounted` チェックについては [await の後で BuildContext を安全に使う方法](/ja/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) を参照してください。

### 参考資料

- [`shared_preferences` の README: API の比較、キャッシュの注意点、保存先](https://pub.dev/packages/shared_preferences)
- [`path_provider` パッケージとプラットフォーム対応表](https://pub.dev/packages/path_provider)
- [`getApplicationDocumentsDirectory` のドキュメントコメント (flutter/packages)](https://github.com/flutter/packages/blob/main/packages/path_provider/path_provider/lib/path_provider.dart)
- [`path_provider_windows` の known folder の対応付け](https://github.com/flutter/packages/blob/main/packages/path_provider/path_provider_windows/lib/src/path_provider_windows_real.dart)
- [`dart:io` の `File.rename` と `File.writeAsString`](https://api.dart.dev/dart-io/File-class.html)
- [Android DataStore](https://developer.android.com/topic/libraries/architecture/datastore) と [アプリの Auto Backup](https://developer.android.com/identity/data/autobackup)
