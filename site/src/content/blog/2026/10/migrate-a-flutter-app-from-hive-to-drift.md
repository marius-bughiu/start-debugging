---
title: "Migrate a Flutter App's Local Storage from Hive to Drift (hive_ce 2.22 to drift 2.35)"
description: "A one-time, crash-safe import of existing Hive boxes into a drift SQLite database on the user's device: schema design, the import function, idempotency, deleting the boxes, and the two gotchas that silently corrupt data (DateTime precision and class-name collisions). Tested on Flutter 3.44.8 with hive_ce 2.22.0 and drift 2.35.2."
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
---

Moving a shipped Flutter app from Hive to drift is not a code refactor, it is a data migration that runs on every user's phone. The data your users already have lives in `.hive` files in the app documents directory, and the new version has to copy it into a SQLite database exactly once, without losing anything if the app is killed halfway. The approach that works: keep Hive as a read-only dependency for a few releases, run an import function at startup that reads every box inside a single drift transaction, mark completion with a flag row in the same transaction, and delete the box files only after the commit. For a typical app with 2 to 5 boxes this is half a day of work plus tests. The two things that break silently are drift's default `DateTime` storage (whole seconds, local time) and the generated row class colliding with your Hive model's name. Everything below was tested on Flutter 3.44.8 (Dart 3.12.2) with `hive_ce` 2.22.0, `drift` 2.35.2, `drift_flutter` 0.3.1 and `drift_dev` 2.35.1.

## Why move off Hive at all

- **The original package is frozen.** `hive` 2.2.3 was published on 30 June 2022 and is still the latest version on pub.dev; `hive_flutter` 1.1.0 dates from June 2021. The community fork `hive_ce` is maintained (2.22.0 shipped this week), so if you only need maintenance, switching the import to `hive_ce` is the cheaper move. A box written by `hive` 2.2.3 opened and read correctly with `hive_ce` 2.22.0 in my test, so that swap does not need a data migration.
- **You need queries, not lookups.** Hive is a key-value store. Filtering, sorting, paging and joins all happen in Dart after loading the values into memory. Drift gives you SQL with compile-time checked Dart queries, indexes, and reactive `watch()` streams that update only when the underlying tables change.
- **Schema evolution becomes explicit.** In Hive, adding a field means juggling `@HiveField` indexes and nullable reads forever. Drift has a `schemaVersion`, an `onUpgrade` callback and tooling (`drift_dev schema steps`) that generates typed, testable step-by-step migrations.
- **Transactions.** Hive writes are per key. Drift wraps any number of writes in an SQLite transaction, which is exactly what makes the import below crash-safe.

## What changes in the app

| Area | Change | Severity |
| --- | --- | --- |
| Model classes | `@HiveType` classes are replaced by drift tables plus generated row classes | high |
| `DateTime` columns | Drift stores whole seconds and returns local time unless you opt into text storage | high |
| Keys | Hive auto-increment keys (`box.add`) are `int`, custom keys are `String`; drift wants a typed primary key | medium |
| Lists and maps | No native list column; need a `TypeConverter` or a child table | medium |
| Startup | `Hive.initFlutter()` + `openBox` replaced by one `AppDatabase` instance | medium |
| Reactive UI | `ValueListenableBuilder(box.listenable())` becomes `StreamBuilder(query.watch())` | low |
| Storage location | Both use `getApplicationDocumentsDirectory()`; drift writes `<name>.sqlite` next to the `.hive` files | low |

## Pre-flight checklist

- Inventory every box: name, value type (`Box<Note>`, `Box<dynamic>`, `LazyBox`), key type, whether it is encrypted, and roughly how many entries a heavy user has.
- List every `TypeAdapter` and its `typeId`. The import code must register them, or `openBox` throws when it meets an unknown type ID.
- Keep a copy of a real device's `.hive` files (from a debug build, via `adb pull` or the Xcode container download) to use as test fixtures.
- Decide the minimum app version you will still migrate from. Hive stays in `pubspec.yaml` until you drop that support.
- Make sure CI can run `dart run build_runner build`, since drift is code-generated.

## Migration steps

1. **Add drift next to Hive, not instead of it.** The old package stays because the import has to read the old files. Note that `sqlite3_flutter_libs` is no longer needed: `drift_flutter` 0.3.x depends on `sqlite3` 3.x, which bundles SQLite through build hooks, and `sqlite3_flutter_libs` 0.6.0 is an empty "end of life" release.

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

   Verify with `flutter pub get` and confirm no `sqlite3_flutter_libs` 0.5.x line is left in `pubspec.lock`.

2. **Switch drift to text `DateTime` storage before you write any data.** By default drift stores a `DateTime` as an integer Unix timestamp in seconds and always reads it back as local time. In my test a Hive value of `2026-10-15T09:30:12.345Z` came back from drift as `2026-10-15T12:30:12.000` with `isUtc=false` (the machine runs at +03:00): the milliseconds and the UTC flag were gone, and the raw column held `1792056612`. Hive keeps both. Add a `build.yaml` next to `pubspec.yaml`:

   ```yaml
   # build.yaml - drift_dev 2.35.1
   targets:
     $default:
       builders:
         drift_dev:
           options:
             store_date_time_values_as_text: true
   ```

   With this option the same value is stored as `2026-10-15T09:30:12.345Z` and reads back with `isUtc=true`. Doing it now is free; switching later needs a schema migration over every date column.

3. **Model the tables, and keep the old Hive key.** A `legacyKey` column with a unique constraint is what makes the import idempotent. Rename the generated row class with `@DataClassName`, because drift derives `Note` from a table called `Notes`, and that collides with your existing Hive `Note` class the moment one file imports both (`Error: 'Note' is imported from both ...`).

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

   The `Settings` table replaces an untyped `Box<dynamic>` of preferences as a simple key-value table with JSON values. Run `dart run build_runner build` and verify that `database.g.dart` is generated without warnings.

4. **Write the import as one transaction with a completion flag.** Everything that matters happens in this function: it opens the old boxes, inserts every entry in one `batch` inside one `transaction`, writes the `hive_import_done` row in the same transaction, and deletes the box files only after the commit.

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

   Verify with the test in the Verification section below before you wire it into the app.

5. **Call it once at startup, before the first screen reads data.** Initialize Hive the same way the old version did, so the boxes are found in the same directory, then run the import, then hand the database to the rest of the app.

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

   If the old release called `Hive.initFlutter('some_subdir')`, pass the same value, otherwise `boxExists` returns `false`, the import marks a "fresh install", and the user's data is silently ignored. Verify by installing the old release, creating data, then installing the new build over it.

6. **Replace reads and writes screen by screen.** `box.values.where(...)` becomes a drift query, `box.put` becomes an insert or update, and `box.listenable()` becomes `watch()`:

   ```dart
   // Flutter 3.44.8, drift 2.35.2
   Stream<List<NoteRow>> watchPinned(AppDatabase db) =>
       (db.select(db.notes)
             ..where((n) => n.pinned.equals(true))
             ..orderBy([(n) => OrderingTerm.desc(n.createdAt)]))
           .watch();
   ```

   Verify with `flutter analyze`: once no file outside `legacy/` and `hive_migration.dart` imports `package:hive_ce`, the app logic is fully on drift.

7. **Remove Hive after the import window.** Once analytics show nearly all active installs have run the import (or after the oldest supported version is out of rotation), delete `hive_migration.dart`, the adapters in `lib/legacy/`, and the two Hive dependencies. Keep the `hive_import_done` row; it costs nothing and documents what happened.

## Verification

Drift runs on the Dart VM in `flutter test` with `NativeDatabase.memory()`, and Hive runs on any directory with `Hive.init(path)`, so the whole import is testable without a device:

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

What my run printed: two rows with legacy keys `0` and `custom-key`, `createdAt` equal to the original UTC value, the box directory going from `[notes.hive, settings.hive]` to `[]`, and an unchanged row count after the second call.

To prove the crash safety, I added an SQLite trigger that aborts the insert of the `hive_import_done` row, which simulates the app dying at the last possible moment. The import threw `SqliteException(1811): ... simulated crash`, the `notes` table had 0 rows, and both `.hive` files were still on disk. On the next launch the import simply runs again. That is the whole point of putting the flag inside the transaction and the deletes outside it.

Then, on a real device: install the previous store build, create data, install the new build over it, and confirm the data shows up and `app.sqlite` exists in the documents directory while the `.hive` files are gone.

## Rolling back

Before the import window closes, the migration is reversible only in one direction of time: an older app version cannot read `app.sqlite`, and after a successful import the `.hive` files are deleted. If you need a safe rollback path, delay the deletion by one release (keep step 4 but skip the `deleteFromDisk` calls), so a user who downgrades still finds their old boxes. Data written after the import would not appear in the downgraded app, so say this loudly to QA. Once the boxes are deleted, the migration is one-way.

## Gotchas from a real migration

### `jsonEncode` throws on values Hive stored natively

A `Box<dynamic>` can hold a `DateTime`, a `Uint8List` or a custom adapter type. `jsonEncode` only handles maps, lists, strings, numbers, booleans and null, so a preferences box with a `lastSync` date throws `JsonUnsupportedObjectError` inside the transaction and the whole import rolls back on every launch. Map those keys explicitly, or pass `toEncodable: (o) => o is DateTime ? o.toUtc().toIso8601String() : throw ...`.

### Encrypted boxes need their cipher

If the old version opened a box with `encryptionCipher: HiveAesCipher(key)`, the import must pass the same cipher, usually read from `flutter_secure_storage`. Without it, entries fail to decode. Decide whether the drift database needs encryption too; drift's SQLCipher support is a separate setup and `drift_flutter` does not turn it on for you.

### Large boxes and memory

`Box` loads every value into memory when opened, which the old app already did, so a normal box is fine. If the old code used `LazyBox` because the data is large, read with `await lazy.get(key)` and insert in chunks of a few thousand rows per `batch`. Keep everything in one transaction anyway so the completion flag stays atomic.

### Integer keys

`box.add` assigns auto-increment `int` keys and `box.put` accepts `int` or `String`. Storing `key.toString()` in `legacyKey` covers both, but if other boxes reference entries by key (a "favorites" box holding note keys), resolve those references after the main insert with a lookup on `legacyKey`, not by assuming the drift `id` equals the Hive key.

### Running the import off the UI thread

For tens of thousands of entries, decoding the boxes is CPU work on the main isolate during startup. `driftDatabase()` already runs SQLite on a background isolate (it opens the file through `NativeDatabase.createBackgroundConnection`), but Hive decoding still happens wherever `openBox` is called. If startup time suffers, show a migration screen rather than a frozen splash, or move the decoding into a separate isolate and pass plain data back.

## Related

- If the import is slow enough to jank startup, see [how to write a Dart isolate for CPU-bound work](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) and [the difference between a Dart isolate and a thread](/2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread/).
- The migration screen that awaits the import and then navigates needs the patterns from [using BuildContext safely after an await in Flutter](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).
- Adding `drift_dev` and `build_runner` changes your lockfile; if CI suddenly reports it modified, read [why pubspec.lock changes after a Flutter upgrade](/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/).

## Sources

- [`drift_flutter` README](https://pub.dev/packages/drift_flutter) (pub.dev)
- [Drift: DateTime storage and migrating between modes](https://drift.simonbinder.eu/guides/datetime-migrations/) (drift.simonbinder.eu)
- [Drift: migrations and `schemaVersion`](https://drift.simonbinder.eu/migrations/) (drift.simonbinder.eu)
- [`sqlite3` upgrading to v3 notes](https://github.com/simolus3/sqlite3.dart/blob/main/UPGRADING_TO_V3.md) (simolus3/sqlite3.dart)
- [`hive_ce` package](https://pub.dev/packages/hive_ce) and [`hive` package](https://pub.dev/packages/hive) (pub.dev)
- [Hive CE source](https://github.com/IO-Design-Team/hive_ce) (IO-Design-Team/hive_ce)
