---
title: "Flutter アプリのローカルストレージを Hive から Drift へ移行する (hive_ce 2.22 から drift 2.35 へ)"
description: "既存の Hive box を、ユーザーの端末上の drift SQLite データベースへ一度だけ安全にインポートする方法です。スキーマ設計、インポート関数、冪等性、box の削除に加えて、データを黙って壊す 2 つの落とし穴 (DateTime の精度とクラス名の衝突) を扱います。Flutter 3.44.8、hive_ce 2.22.0、drift 2.35.2 で検証しています。"
pubDate: 2026-10-15
updatedDate: 2026-10-15
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "hive"
  - "drift"
  - "sqlite"
lang: "ja"
translationOf: "2026/10/migrate-a-flutter-app-from-hive-to-drift"
translatedBy: "claude"
translationDate: 2026-10-15
---

リリース済みの Flutter アプリを Hive から drift へ移すのは、コードのリファクタリングではなく、すべてのユーザーのスマートフォン上で実行されるデータ移行です。ユーザーが既に持っているデータはアプリのドキュメントディレクトリの `.hive` ファイルにあり、新バージョンはそれを SQLite データベースへちょうど一度だけコピーしなければなりません。途中でアプリが強制終了されても何も失ってはいけません。有効な方法は次のとおりです。数リリースの間は Hive を読み取り専用の依存として残し、起動時にインポート関数を実行して、単一の drift トランザクション内ですべての box を読み込み、同じトランザクション内でフラグ行を書いて完了を記録し、コミット後にだけ box ファイルを削除します。box が 2 から 5 個程度の一般的なアプリなら、テストを含めて半日の作業です。黙って壊れるのは 2 点で、drift の既定の `DateTime` 保存形式 (秒単位、ローカル時刻) と、生成される行クラスが Hive モデルの名前と衝突する問題です。以下はすべて Flutter 3.44.8 (Dart 3.12.2)、`hive_ce` 2.22.0、`drift` 2.35.2、`drift_flutter` 0.3.1、`drift_dev` 2.35.1 で検証しました。

## そもそもなぜ Hive から移るのか

- **元のパッケージは更新が止まっています。** `hive` 2.2.3 は 2022 年 6 月 30 日に公開されたもので、今も pub.dev の最新版です。`hive_flutter` 1.1.0 は 2021 年 6 月のものです。コミュニティのフォークである `hive_ce` は保守されており (2.22.0 が今週公開されました)、保守だけが目的なら import を `hive_ce` に切り替えるほうが手軽です。私のテストでは、`hive` 2.2.3 で書き込んだ box を `hive_ce` 2.22.0 で正しく開いて読み取れたため、この入れ替えにデータ移行は不要です。
- **必要なのはルックアップではなくクエリです。** Hive はキーバリューストアです。フィルタ、並べ替え、ページング、結合は、値をメモリに読み込んだあとで Dart 側で行うことになります。drift ならコンパイル時に検査される Dart のクエリとしての SQL、インデックス、そして基になるテーブルが変わったときにだけ更新されるリアクティブな `watch()` ストリームが使えます。
- **スキーマの進化が明示的になります。** Hive でフィールドを追加すると、`@HiveField` のインデックスと null 許容の読み取りを延々とやりくりすることになります。drift には `schemaVersion`、`onUpgrade` コールバック、そして型付きでテスト可能な段階的マイグレーションを生成するツール (`drift_dev schema steps`) があります。
- **トランザクション。** Hive の書き込みはキー単位です。drift は任意の数の書き込みを SQLite のトランザクションにまとめられ、これこそが以下のインポートをクラッシュに強くしている仕組みです。

## アプリ内で何が変わるか

| 領域 | 変更内容 | 重大度 |
| --- | --- | --- |
| モデルクラス | `@HiveType` クラスは drift のテーブルと生成された行クラスに置き換わります | 高 |
| `DateTime` 列 | テキスト保存を選ばない限り、drift は秒単位で保存し、ローカル時刻として返します | 高 |
| キー | Hive の自動採番キー (`box.add`) は `int`、独自キーは `String` です。drift では型付きの主キーが必要です | 中 |
| リストとマップ | ネイティブのリスト列はないため、`TypeConverter` か子テーブルが必要です | 中 |
| 起動処理 | `Hive.initFlutter()` と `openBox` が、1 つの `AppDatabase` インスタンスに置き換わります | 中 |
| リアクティブな UI | `ValueListenableBuilder(box.listenable())` が `StreamBuilder(query.watch())` になります | 低 |
| 保存場所 | どちらも `getApplicationDocumentsDirectory()` を使います。drift は `.hive` ファイルの隣に `<name>.sqlite` を書き込みます | 低 |

## 事前チェックリスト

- すべての box を洗い出します。名前、値の型 (`Box<Note>`、`Box<dynamic>`、`LazyBox`)、キーの型、暗号化の有無、そしてヘビーユーザーのおおよそのエントリ数です。
- すべての `TypeAdapter` とその `typeId` を一覧にします。インポートのコードでそれらを登録しないと、未知の型 ID に遭遇した時点で `openBox` が例外を投げます。
- 実機の `.hive` ファイルのコピーを (デバッグビルドから、`adb pull` か Xcode のコンテナのダウンロードで) 取得し、テスト用のフィクスチャとして使います。
- 移行元として引き続きサポートする最小のアプリバージョンを決めます。そのサポートを終了するまで、Hive は `pubspec.yaml` に残します。
- CI で `dart run build_runner build` を実行できることを確認します。drift はコード生成を使うためです。

## 移行手順

1. **Hive の代わりではなく、Hive の隣に drift を追加します。** インポートで古いファイルを読む必要があるため、古いパッケージは残します。なお `sqlite3_flutter_libs` はもう不要です。`drift_flutter` 0.3.x は `sqlite3` 3.x に依存しており、これはビルドフックで SQLite を同梱します。そして `sqlite3_flutter_libs` 0.6.0 は中身のない "end of life" リリースです。

   ```yaml
   # pubspec.yaml - Flutter 3.44.8, Dart 3.12.2
   dependencies:
     drift: ^2.35.2
     drift_flutter: ^0.3.1
     hive_ce: ^2.22.0          # kept read-only until the import window closes
     hive_ce_flutter: ^2.5.0
     path_provider: ^2.1.6

   dev_dependencies:
     build_runner: ^2.15.1
     drift_dev: ^2.35.1
   ```

   `flutter pub get` で確認し、`pubspec.lock` に `sqlite3_flutter_libs` の 0.5.x 系が残っていないことを確かめます。

2. **データを書き込む前に、drift を `DateTime` のテキスト保存に切り替えます。** 既定では、drift は `DateTime` を秒単位の整数の Unix タイムスタンプとして保存し、読み戻すときは常にローカル時刻にします。私のテストでは、Hive の値 `2026-10-15T09:30:12.345Z` は drift から `isUtc=false` の `2026-10-15T12:30:12.000` として返ってきました (マシンは +03:00 で動作しています)。ミリ秒と UTC フラグが失われ、生の列の値は `1792056612` でした。Hive は両方を保持します。`pubspec.yaml` の隣に `build.yaml` を追加します。

   ```yaml
   # build.yaml - drift_dev 2.35.1
   targets:
     $default:
       builders:
         drift_dev:
           options:
             store_date_time_values_as_text: true
   ```

   このオプションを付けると、同じ値が `2026-10-15T09:30:12.345Z` として保存され、`isUtc=true` で読み戻されます。今やれば手間はかかりませんが、あとから切り替えると、すべての日付列に対するスキーママイグレーションが必要になります。

3. **テーブルをモデル化し、古い Hive のキーを残します。** 一意制約付きの `legacyKey` 列が、インポートを冪等にします。生成される行クラスの名前は `@DataClassName` で変更してください。drift は `Notes` というテーブルから `Note` を導出するため、1 つのファイルが両方を import した時点で、既存の Hive の `Note` クラスと衝突するからです (`Error: 'Note' is imported from both ...`)。

   ```dart
   // lib/data/database.dart - Flutter 3.44.8, drift 2.35.2, drift_flutter 0.3.1
   import 'package:drift/drift.dart';
   import 'package:drift_flutter/drift_flutter.dart';

   part 'database.g.dart';

   @DataClassName('NoteRow')
   class Notes extends Table {
     IntColumn get id => integer().autoIncrement()();
     // The old Hive key, kept so the import is idempotent.
     TextColumn get legacyKey => text().nullable().unique()();
     TextColumn get title => text()();
     TextColumn get body => text()();
     DateTimeColumn get createdAt => dateTime()();
     BoolColumn get pinned => boolean().withDefault(const Constant(false))();
     TextColumn get tags => text().map(const TagsConverter())();
   }

   class Settings extends Table {
     TextColumn get key => text()();
     TextColumn get value => text()();

     @override
     Set<Column> get primaryKey => {key};
   }

   class TagsConverter extends TypeConverter<List<String>, String> {
     const TagsConverter();
     @override
     List<String> fromSql(String fromDb) => fromDb.isEmpty ? [] : fromDb.split('\u001f');
     @override
     String toSql(List<String> value) => value.join('\u001f');
   }

   @DriftDatabase(tables: [Notes, Settings])
   class AppDatabase extends _$AppDatabase {
     AppDatabase([QueryExecutor? executor]) : super(executor ?? driftDatabase(name: 'app'));

     @override
     int get schemaVersion => 1;
   }
   ```

   `Settings` テーブルは、型のない `Box<dynamic>` の設定値を、JSON 値を持つ単純なキーバリューテーブルとして置き換えます。`dart run build_runner build` を実行し、`database.g.dart` が警告なしに生成されることを確認します。

4. **インポートは、完了フラグ付きの 1 つのトランザクションとして書きます。** 重要な処理はすべてこの関数の中にあります。古い box を開き、1 つの `transaction` 内の 1 つの `batch` ですべてのエントリを挿入し、同じトランザクション内で `hive_import_done` 行を書き、コミット後にだけ box ファイルを削除します。

   ```dart
   // lib/data/hive_migration.dart - Flutter 3.44.8, hive_ce 2.22.0, drift 2.35.2
   import 'dart:convert';

   import 'package:drift/drift.dart';
   import 'package:hive_ce/hive.dart';

   import '../legacy/note.dart';
   import 'database.dart';

   const _doneFlag = 'hive_import_done';

   Future<void> migrateFromHive(AppDatabase db, {String? hivePath}) async {
     final done = await (db.select(db.settings)..where((s) => s.key.equals(_doneFlag))).getSingleOrNull();
     if (done != null) return;

     final hasNotes = await Hive.boxExists('notes', path: hivePath);
     final hasSettings = await Hive.boxExists('settings', path: hivePath);

     if (hasNotes || hasSettings) {
       if (!Hive.isAdapterRegistered(0)) Hive.registerAdapter(NoteAdapter());
       final notes = hasNotes ? await Hive.openBox<Note>('notes', path: hivePath) : null;
       final settings = hasSettings ? await Hive.openBox('settings', path: hivePath) : null;

       await db.transaction(() async {
         await db.batch((b) {
           if (notes != null) {
             for (final key in notes.keys) {
               final n = notes.get(key)!;
               b.insert(
                 db.notes,
                 NotesCompanion.insert(
                   legacyKey: Value(key.toString()),
                   title: n.title,
                   body: n.body,
                   createdAt: n.createdAt,
                   pinned: Value(n.pinned),
                   tags: n.tags,
                 ),
                 mode: InsertMode.insertOrIgnore,
               );
             }
           }
           if (settings != null) {
             for (final key in settings.keys) {
               b.insert(
                 db.settings,
                 SettingsCompanion.insert(key: key.toString(), value: jsonEncode(settings.get(key))),
                 mode: InsertMode.insertOrReplace,
               );
             }
           }
         });
         await db.into(db.settings).insert(
               SettingsCompanion.insert(key: _doneFlag, value: DateTime.now().toUtc().toIso8601String()),
             );
       });

       // Only after the transaction committed.
       await notes?.deleteFromDisk();
       await settings?.deleteFromDisk();
     } else {
       await db.into(db.settings).insert(
             SettingsCompanion.insert(key: _doneFlag, value: 'fresh-install'),
             mode: InsertMode.insertOrReplace,
           );
     }
   }
   ```

   アプリに組み込む前に、下の "検証" セクションのテストで確認してください。

5. **起動時に一度だけ、最初の画面がデータを読む前に呼び出します。** 古いバージョンと同じ方法で Hive を初期化して box が同じディレクトリで見つかるようにし、次にインポートを実行して、データベースをアプリの残りの部分へ渡します。

   ```dart
   // lib/main.dart - Flutter 3.44.8, hive_ce_flutter 2.5.0
   import 'package:flutter/material.dart';
   import 'package:hive_ce_flutter/hive_flutter.dart';

   import 'data/database.dart';
   import 'data/hive_migration.dart';

   Future<void> main() async {
     WidgetsFlutterBinding.ensureInitialized();
     await Hive.initFlutter(); // same (sub)directory as the old release used
     final db = AppDatabase();
     await migrateFromHive(db);
     runApp(MyApp(db: db));
   }
   ```

   古いリリースが `Hive.initFlutter('some_subdir')` を呼んでいた場合は同じ値を渡してください。そうしないと `boxExists` が `false` を返し、インポートが "fresh install" と記録して、ユーザーのデータが黙って無視されます。古いリリースをインストールしてデータを作成し、その上から新しいビルドをインストールして確認します。

6. **読み取りと書き込みを画面ごとに置き換えます。** `box.values.where(...)` は drift のクエリに、`box.put` は insert または update に、`box.listenable()` は `watch()` になります。

   ```dart
   // Flutter 3.44.8, drift 2.35.2
   Stream<List<NoteRow>> watchPinned(AppDatabase db) =>
       (db.select(db.notes)
             ..where((n) => n.pinned.equals(true))
             ..orderBy([(n) => OrderingTerm.desc(n.createdAt)]))
           .watch();
   ```

   `flutter analyze` で確認します。`legacy/` と `hive_migration.dart` の外に `package:hive_ce` を import しているファイルがなくなれば、アプリのロジックは完全に drift に移行できています。

7. **インポート期間の終了後に Hive を削除します。** アクティブなインストールのほぼすべてでインポートが実行されたことを分析データで確認できたら (または、サポート対象の最も古いバージョンが配布対象から外れたら)、`hive_migration.dart`、`lib/legacy/` のアダプター、そして 2 つの Hive 依存を削除します。`hive_import_done` 行は残してください。コストはかからず、何が起きたかの記録になります。

## 検証

drift は `flutter test` の中で `NativeDatabase.memory()` を使って Dart VM 上で動き、Hive は `Hive.init(path)` で任意のディレクトリ上で動くため、インポート全体を実機なしでテストできます。

```dart
// test/migration_test.dart - Flutter 3.44.8, hive_ce 2.22.0, drift 2.35.2
import 'dart:io';

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hive_ce/hive.dart';
import 'package:myapp/data/database.dart';
import 'package:myapp/data/hive_migration.dart';
import 'package:myapp/legacy/note.dart';

void main() {
  test('imports once, deletes boxes, keeps milliseconds', () async {
    final dir = await Directory.systemTemp.createTemp('hive2drift');
    final created = DateTime.utc(2026, 10, 15, 9, 30, 12, 345);
    Hive.init(dir.path);
    Hive.registerAdapter(NoteAdapter());
    final box = await Hive.openBox<Note>('notes');
    await box.add(Note(title: 'first', body: 'hello', createdAt: created, tags: ['a', 'b']));
    await box.put('custom-key', Note(title: 'second', body: 'world', createdAt: created, pinned: true));
    await Hive.close();

    final db = AppDatabase(NativeDatabase.memory());
    await migrateFromHive(db);
    await migrateFromHive(db); // second run must be a no-op

    final rows = await db.select(db.notes).get();
    expect(rows, hasLength(2));
    expect(rows.first.createdAt, created);
    expect(rows.first.tags, ['a', 'b']);
    expect(dir.listSync(), isEmpty);
    await db.close();
  });
}
```

私の実行結果は次のとおりでした。レガシーキーが `0` と `custom-key` の 2 行、元の UTC 値に等しい `createdAt`、box のディレクトリが `[notes.hive, settings.hive]` から `[]` になったこと、そして 2 回目の呼び出し後も行数が変わらなかったことです。

クラッシュに強いことを証明するため、`hive_import_done` 行の挿入を中断させる SQLite のトリガーを追加しました。これは、最後のごく間際にアプリが終了する状況をシミュレートします。インポートは `SqliteException(1811): ... simulated crash` を投げ、`notes` テーブルは 0 行のままで、両方の `.hive` ファイルはディスク上に残っていました。次回の起動時には、インポートが単純にもう一度実行されます。フラグをトランザクションの内側に、削除を外側に置く理由はまさにこれです。

そのうえで実機で確認します。直前のストア版ビルドをインストールしてデータを作成し、その上から新しいビルドをインストールして、データが表示されること、ドキュメントディレクトリに `app.sqlite` が存在すること、そして `.hive` ファイルがなくなっていることを確かめます。

## ロールバック

インポート期間が終わるまでの間でも、この移行は時間の一方向にしか戻せません。古いバージョンのアプリは `app.sqlite` を読めず、インポートが成功すると `.hive` ファイルは削除されます。安全なロールバック経路が必要なら、削除を 1 リリース遅らせてください (手順 4 はそのままにして、`deleteFromDisk` の呼び出しを省きます)。そうすれば、ダウングレードしたユーザーも古い box を見つけられます。インポート後に書き込まれたデータはダウングレード先のアプリには表示されないため、QA には強く周知してください。box を削除してしまったあとは、移行は後戻りできません。

## 実際の移行で出会った落とし穴

### Hive がネイティブに保存した値で `jsonEncode` が例外を投げる

`Box<dynamic>` には `DateTime`、`Uint8List`、あるいはカスタムアダプターの型を入れられます。`jsonEncode` が扱えるのはマップ、リスト、文字列、数値、真偽値、null だけなので、`lastSync` の日付を含む設定の box があると、トランザクション内で `JsonUnsupportedObjectError` が発生し、起動のたびにインポート全体がロールバックされます。該当するキーを明示的に変換するか、`toEncodable: (o) => o is DateTime ? o.toUtc().toIso8601String() : throw ...` を渡してください。

### 暗号化された box には暗号が必要です

古いバージョンが `encryptionCipher: HiveAesCipher(key)` で box を開いていた場合、インポートでも同じ暗号を渡す必要があります。通常は `flutter_secure_storage` から読み取ります。これがないと、エントリのデコードに失敗します。drift のデータベースにも暗号化が必要かどうかは検討してください。drift の SQLCipher サポートは別途のセットアップであり、`drift_flutter` が自動で有効にすることはありません。

### 大きな box とメモリ

`Box` は開いたときにすべての値をメモリに読み込みます。古いアプリも既にそうしていたため、通常の box なら問題ありません。データが大きいために古いコードが `LazyBox` を使っていた場合は、`await lazy.get(key)` で読み取り、1 回の `batch` あたり数千行ずつに分けて挿入してください。完了フラグをアトミックに保つため、それでもすべてを 1 つのトランザクションに入れておきます。

### 整数のキー

`box.add` は自動採番の `int` キーを割り当て、`box.put` は `int` か `String` を受け付けます。`key.toString()` を `legacyKey` に保存すれば両方に対応できますが、他の box がキーでエントリを参照している場合 (ノートのキーを保持する "favorites" box など) は、drift の `id` が Hive のキーと等しいと仮定せず、メインの挿入のあとで `legacyKey` を検索してそれらの参照を解決してください。

### インポートを UI スレッドの外で実行する

数万件のエントリがある場合、box のデコードは起動中にメイン isolate 上で行われる CPU 処理になります。`driftDatabase()` は既に SQLite をバックグラウンド isolate で実行します (`NativeDatabase.createBackgroundConnection` を通じてファイルを開きます) が、Hive のデコードは `openBox` を呼び出した場所で行われます。起動時間が問題になる場合は、固まったスプラッシュ画面ではなく移行用の画面を表示するか、デコードを別の isolate に移して、プレーンなデータだけを返してください。

## 関連記事

- インポートが遅く、起動がカクつく場合は、[how to write a Dart isolate for CPU-bound work](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) と [the difference between a Dart isolate and a thread](/ja/2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread/) を参照してください。
- インポートを待機してから画面遷移する移行画面には、[using BuildContext safely after an await in Flutter](/ja/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) のパターンが必要です。
- `drift_dev` と `build_runner` を追加するとロックファイルが変わります。CI が突然ロックファイルの変更を報告した場合は、[why pubspec.lock changes after a Flutter upgrade](/ja/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/) を読んでください。

## 参考資料

- [`drift_flutter` README](https://pub.dev/packages/drift_flutter) (pub.dev)
- [Drift: DateTime storage and migrating between modes](https://drift.simonbinder.eu/guides/datetime-migrations/) (drift.simonbinder.eu)
- [Drift: migrations and `schemaVersion`](https://drift.simonbinder.eu/migrations/) (drift.simonbinder.eu)
- [`sqlite3` upgrading to v3 notes](https://github.com/simolus3/sqlite3.dart/blob/main/UPGRADING_TO_V3.md) (simolus3/sqlite3.dart)
- [`hive_ce` package](https://pub.dev/packages/hive_ce) and [`hive` package](https://pub.dev/packages/hive) (pub.dev)
- [Hive CE source](https://github.com/IO-Design-Team/hive_ce) (IO-Design-Team/hive_ce)
