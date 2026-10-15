---
title: "Lokalen Speicher einer Flutter-App von Hive auf Drift migrieren (hive_ce 2.22 auf drift 2.35)"
description: "Ein einmaliger, absturzsicherer Import bestehender Hive-Boxes in eine drift-SQLite-Datenbank auf dem Gerät des Nutzers: Schemaentwurf, die Importfunktion, Idempotenz, das Löschen der Boxes und die zwei Fallstricke, die Daten unbemerkt beschädigen (DateTime-Genauigkeit und Klassennamenskollisionen). Getestet mit Flutter 3.44.8, hive_ce 2.22.0 und drift 2.35.2."
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
lang: "de"
translationOf: "2026/10/migrate-a-flutter-app-from-hive-to-drift"
translatedBy: "claude"
translationDate: 2026-10-15
---

Eine ausgelieferte Flutter-App von Hive auf drift umzustellen ist kein Code-Refactoring, sondern eine Datenmigration, die auf dem Telefon jedes Nutzers läuft. Die vorhandenen Daten Ihrer Nutzer liegen in `.hive`-Dateien im Dokumentenverzeichnis der App, und die neue Version muss sie genau einmal in eine SQLite-Datenbank kopieren, ohne etwas zu verlieren, falls die App mittendrin beendet wird. Der Ansatz, der funktioniert: Hive für einige Releases als reine Lese-Abhängigkeit behalten, beim Start eine Importfunktion ausführen, die jede Box innerhalb einer einzigen drift-Transaktion liest, den Abschluss mit einer Flag-Zeile in derselben Transaktion markieren und die Box-Dateien erst nach dem Commit löschen. Für eine typische App mit 2 bis 5 Boxes sind das einen halben Tag Arbeit plus Tests. Unbemerkt schiefgehen zwei Dinge: die Standardspeicherung von `DateTime` in drift (ganze Sekunden, lokale Zeit) und die Kollision der generierten Zeilenklasse mit dem Namen Ihres Hive-Modells. Alles Folgende wurde mit Flutter 3.44.8 (Dart 3.12.2), `hive_ce` 2.22.0, `drift` 2.35.2, `drift_flutter` 0.3.1 und `drift_dev` 2.35.1 getestet.

## Warum überhaupt von Hive wegziehen

- **Das ursprüngliche Paket ist eingefroren.** `hive` 2.2.3 wurde am 30. Juni 2022 veröffentlicht und ist weiterhin die neueste Version auf pub.dev; `hive_flutter` 1.1.0 stammt von Juni 2021. Der Community-Fork `hive_ce` wird gepflegt (2.22.0 erschien diese Woche). Wenn es Ihnen nur um Wartung geht, ist der Wechsel des Imports auf `hive_ce` also der günstigere Weg. Eine mit `hive` 2.2.3 geschriebene Box ließ sich in meinem Test mit `hive_ce` 2.22.0 korrekt öffnen und lesen, dieser Tausch braucht also keine Datenmigration.
- **Sie brauchen Abfragen, keine Lookups.** Hive ist ein Key-Value-Store. Filtern, Sortieren, Paginieren und Joins passieren alle in Dart, nachdem die Werte in den Speicher geladen wurden. Drift bietet SQL mit zur Kompilierzeit geprüften Dart-Abfragen, Indizes und reaktive `watch()`-Streams, die nur aktualisiert werden, wenn sich die zugrunde liegenden Tabellen ändern.
- **Schemaentwicklung wird explizit.** In Hive bedeutet ein neues Feld, dauerhaft `@HiveField`-Indizes und nullbare Lesezugriffe zu jonglieren. Drift hat eine `schemaVersion`, einen `onUpgrade`-Callback und Werkzeuge (`drift_dev schema steps`), die typisierte, testbare Migrationen Schritt für Schritt erzeugen.
- **Transaktionen.** Hive-Schreibvorgänge gelten pro Schlüssel. Drift fasst beliebig viele Schreibvorgänge in einer SQLite-Transaktion zusammen, und genau das macht den folgenden Import absturzsicher.

## Was sich in der App ändert

| Bereich | Änderung | Schweregrad |
| --- | --- | --- |
| Modellklassen | `@HiveType`-Klassen werden durch drift-Tabellen plus generierte Zeilenklassen ersetzt | hoch |
| `DateTime`-Spalten | Drift speichert ganze Sekunden und liefert lokale Zeit zurück, sofern Sie sich nicht für Textspeicherung entscheiden | hoch |
| Schlüssel | Hive-Auto-Increment-Schlüssel (`box.add`) sind `int`, eigene Schlüssel sind `String`; drift erwartet einen typisierten Primärschlüssel | mittel |
| Listen und Maps | Keine native Listenspalte; ein `TypeConverter` oder eine Kindtabelle ist nötig | mittel |
| Start | `Hive.initFlutter()` + `openBox` werden durch eine einzige `AppDatabase`-Instanz ersetzt | mittel |
| Reaktive UI | `ValueListenableBuilder(box.listenable())` wird zu `StreamBuilder(query.watch())` | niedrig |
| Speicherort | Beide nutzen `getApplicationDocumentsDirectory()`; drift schreibt `<name>.sqlite` neben die `.hive`-Dateien | niedrig |

## Checkliste vor dem Start

- Erfassen Sie jede Box: Name, Werttyp (`Box<Note>`, `Box<dynamic>`, `LazyBox`), Schlüsseltyp, ob sie verschlüsselt ist und wie viele Einträge ein Vielnutzer ungefähr hat.
- Listen Sie jeden `TypeAdapter` und seine `typeId` auf. Der Importcode muss sie registrieren, sonst wirft `openBox` beim Auftreten einer unbekannten Typ-ID eine Ausnahme.
- Bewahren Sie eine Kopie der `.hive`-Dateien eines echten Geräts auf (aus einem Debug-Build, per `adb pull` oder über den Xcode-Container-Download) und nutzen Sie sie als Test-Fixtures.
- Legen Sie fest, ab welcher App-Mindestversion Sie noch migrieren. Hive bleibt in `pubspec.yaml`, bis Sie diese Unterstützung einstellen.
- Stellen Sie sicher, dass die CI `dart run build_runner build` ausführen kann, da drift Code generiert.

## Migrationsschritte

1. **Drift neben Hive hinzufügen, nicht stattdessen.** Das alte Paket bleibt, weil der Import die alten Dateien lesen muss. Beachten Sie, dass `sqlite3_flutter_libs` nicht mehr nötig ist: `drift_flutter` 0.3.x hängt von `sqlite3` 3.x ab, das SQLite über Build-Hooks mitbringt, und `sqlite3_flutter_libs` 0.6.0 ist ein leerer "End of Life"-Release.

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

   Prüfen Sie mit `flutter pub get` und vergewissern Sie sich, dass in `pubspec.lock` keine `sqlite3_flutter_libs`-0.5.x-Zeile übrig ist.

2. **Drift auf Text-Speicherung für `DateTime` umstellen, bevor Sie Daten schreiben.** Standardmäßig speichert drift ein `DateTime` als ganzzahligen Unix-Zeitstempel in Sekunden und liest es immer als lokale Zeit zurück. In meinem Test kam ein Hive-Wert `2026-10-15T09:30:12.345Z` aus drift als `2026-10-15T12:30:12.000` mit `isUtc=false` zurück (der Rechner läuft auf +03:00): Die Millisekunden und das UTC-Flag waren weg, und die Rohspalte enthielt `1792056612`. Hive behält beides. Legen Sie neben `pubspec.yaml` eine `build.yaml` an:

   ```yaml
   # build.yaml - drift_dev 2.35.1
   targets:
     $default:
       builders:
         drift_dev:
           options:
             store_date_time_values_as_text: true
   ```

   Mit dieser Option wird derselbe Wert als `2026-10-15T09:30:12.345Z` gespeichert und mit `isUtc=true` zurückgelesen. Es jetzt zu tun ist kostenlos; ein späterer Wechsel erfordert eine Schemamigration über jede Datumsspalte.

3. **Die Tabellen modellieren und den alten Hive-Schlüssel behalten.** Eine Spalte `legacyKey` mit Unique-Constraint macht den Import idempotent. Benennen Sie die generierte Zeilenklasse mit `@DataClassName` um, denn drift leitet aus einer Tabelle namens `Notes` den Namen `Note` ab, und der kollidiert mit Ihrer bestehenden Hive-Klasse `Note`, sobald eine Datei beide importiert (`Error: 'Note' is imported from both ...`).

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

   Die Tabelle `Settings` ersetzt eine untypisierte `Box<dynamic>` mit Einstellungen als einfache Key-Value-Tabelle mit JSON-Werten. Führen Sie `dart run build_runner build` aus und prüfen Sie, dass `database.g.dart` ohne Warnungen generiert wird.

4. **Den Import als eine Transaktion mit Abschluss-Flag schreiben.** Alles Wesentliche geschieht in dieser Funktion: Sie öffnet die alten Boxes, fügt jeden Eintrag in einem `batch` innerhalb einer `transaction` ein, schreibt die Zeile `hive_import_done` in derselben Transaktion und löscht die Box-Dateien erst nach dem Commit.

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

   Prüfen Sie mit dem Test im Abschnitt Überprüfung weiter unten, bevor Sie die Funktion in die App einbinden.

5. **Einmal beim Start aufrufen, bevor der erste Bildschirm Daten liest.** Initialisieren Sie Hive genauso wie die alte Version, damit die Boxes im selben Verzeichnis gefunden werden, führen Sie dann den Import aus und übergeben Sie die Datenbank anschließend an den Rest der App.

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

   Falls das alte Release `Hive.initFlutter('some_subdir')` aufgerufen hat, übergeben Sie denselben Wert. Andernfalls liefert `boxExists` `false`, der Import markiert eine "Neuinstallation", und die Daten des Nutzers werden unbemerkt ignoriert. Prüfen Sie dies, indem Sie das alte Release installieren, Daten anlegen und dann den neuen Build darüber installieren.

6. **Lese- und Schreibzugriffe Bildschirm für Bildschirm ersetzen.** `box.values.where(...)` wird zu einer drift-Abfrage, `box.put` zu einem Insert oder Update und `box.listenable()` zu `watch()`:

   ```dart
   // Flutter 3.44.8, drift 2.35.2
   Stream<List<NoteRow>> watchPinned(AppDatabase db) =>
       (db.select(db.notes)
             ..where((n) => n.pinned.equals(true))
             ..orderBy([(n) => OrderingTerm.desc(n.createdAt)]))
           .watch();
   ```

   Prüfen Sie mit `flutter analyze`: Sobald keine Datei außerhalb von `legacy/` und `hive_migration.dart` mehr `package:hive_ce` importiert, läuft die App-Logik vollständig auf drift.

7. **Hive nach dem Importfenster entfernen.** Sobald die Analytics zeigen, dass nahezu alle aktiven Installationen den Import ausgeführt haben (oder die älteste unterstützte Version aus dem Umlauf ist), löschen Sie `hive_migration.dart`, die Adapter in `lib/legacy/` und die beiden Hive-Abhängigkeiten. Behalten Sie die Zeile `hive_import_done`; sie kostet nichts und dokumentiert, was passiert ist.

## Überprüfung

Drift läuft in `flutter test` mit `NativeDatabase.memory()` auf der Dart VM, und Hive läuft mit `Hive.init(path)` in jedem Verzeichnis, sodass sich der gesamte Import ohne Gerät testen lässt:

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

Was mein Lauf ausgab: zwei Zeilen mit den Legacy-Schlüsseln `0` und `custom-key`, `createdAt` gleich dem ursprünglichen UTC-Wert, das Box-Verzeichnis ging von `[notes.hive, settings.hive]` auf `[]` zurück, und die Zeilenanzahl blieb nach dem zweiten Aufruf unverändert.

Um die Absturzsicherheit zu belegen, habe ich einen SQLite-Trigger hinzugefügt, der das Einfügen der Zeile `hive_import_done` abbricht und damit simuliert, dass die App im allerletzten Moment stirbt. Der Import warf `SqliteException(1811): ... simulated crash`, die Tabelle `notes` hatte 0 Zeilen, und beide `.hive`-Dateien lagen noch auf dem Datenträger. Beim nächsten Start läuft der Import einfach erneut. Genau darum geht es, wenn das Flag in der Transaktion liegt und die Löschvorgänge außerhalb.

Danach auf einem echten Gerät: den vorherigen Store-Build installieren, Daten anlegen, den neuen Build darüber installieren und bestätigen, dass die Daten erscheinen und `app.sqlite` im Dokumentenverzeichnis existiert, während die `.hive`-Dateien verschwunden sind.

## Rollback

Bevor das Importfenster schließt, ist die Migration nur in einer Zeitrichtung umkehrbar: Eine ältere App-Version kann `app.sqlite` nicht lesen, und nach einem erfolgreichen Import sind die `.hive`-Dateien gelöscht. Wenn Sie einen sicheren Rollback-Pfad brauchen, verzögern Sie das Löschen um ein Release (behalten Sie Schritt 4, lassen Sie aber die `deleteFromDisk`-Aufrufe weg), sodass ein Nutzer, der downgradet, seine alten Boxes noch vorfindet. Nach dem Import geschriebene Daten würden in der heruntergestuften App nicht erscheinen, weisen Sie die QA deutlich darauf hin. Sobald die Boxes gelöscht sind, ist die Migration eine Einbahnstraße.

## Fallstricke aus einer echten Migration

### `jsonEncode` wirft bei Werten, die Hive nativ gespeichert hat

Eine `Box<dynamic>` kann ein `DateTime`, eine `Uint8List` oder einen eigenen Adapter-Typ enthalten. `jsonEncode` verarbeitet nur Maps, Listen, Strings, Zahlen, Booleans und null, sodass eine Einstellungs-Box mit einem Datum `lastSync` innerhalb der Transaktion `JsonUnsupportedObjectError` wirft und der gesamte Import bei jedem Start zurückgerollt wird. Bilden Sie diese Schlüssel explizit ab oder übergeben Sie `toEncodable: (o) => o is DateTime ? o.toUtc().toIso8601String() : throw ...`.

### Verschlüsselte Boxes brauchen ihre Cipher

Wenn die alte Version eine Box mit `encryptionCipher: HiveAesCipher(key)` geöffnet hat, muss der Import dieselbe Cipher übergeben, meist aus `flutter_secure_storage` gelesen. Ohne sie lassen sich Einträge nicht dekodieren. Entscheiden Sie, ob auch die drift-Datenbank verschlüsselt werden muss; die SQLCipher-Unterstützung von drift ist ein separates Setup, und `drift_flutter` schaltet sie nicht für Sie ein.

### Große Boxes und Speicher

`Box` lädt beim Öffnen jeden Wert in den Speicher, was die alte App bereits tat, eine normale Box ist also unproblematisch. Wenn der alte Code wegen großer Datenmengen `LazyBox` verwendet hat, lesen Sie mit `await lazy.get(key)` und fügen Sie in Blöcken von einigen tausend Zeilen pro `batch` ein. Halten Sie trotzdem alles in einer Transaktion, damit das Abschluss-Flag atomar bleibt.

### Ganzzahlige Schlüssel

`box.add` vergibt Auto-Increment-Schlüssel vom Typ `int`, und `box.put` akzeptiert `int` oder `String`. Das Speichern von `key.toString()` in `legacyKey` deckt beides ab. Verweisen jedoch andere Boxes per Schlüssel auf Einträge (eine "favorites"-Box mit Notiz-Schlüsseln), lösen Sie diese Verweise nach dem Haupt-Insert per Lookup auf `legacyKey` auf und nehmen Sie nicht an, dass die drift-`id` dem Hive-Schlüssel entspricht.

### Den Import außerhalb des UI-Threads ausführen

Bei Zehntausenden Einträgen ist das Dekodieren der Boxes während des Starts CPU-Arbeit im Main-Isolate. `driftDatabase()` führt SQLite bereits in einem Hintergrund-Isolate aus (es öffnet die Datei über `NativeDatabase.createBackgroundConnection`), aber das Hive-Dekodieren findet weiterhin dort statt, wo `openBox` aufgerufen wird. Leidet die Startzeit, zeigen Sie einen Migrationsbildschirm statt eines eingefrorenen Splash-Screens oder verlagern Sie das Dekodieren in ein separates Isolate und geben Sie einfache Daten zurück.

## Verwandte Artikel

- Wenn der Import langsam genug ist, um den Start ruckeln zu lassen, lesen Sie [how to write a Dart isolate for CPU-bound work](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) und [the difference between a Dart isolate and a thread](/de/2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread/).
- Der Migrationsbildschirm, der auf den Import wartet und danach navigiert, braucht die Muster aus [using BuildContext safely after an await in Flutter](/de/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).
- Das Hinzufügen von `drift_dev` und `build_runner` ändert Ihre Lockfile; wenn die CI plötzlich meldet, sie sei geändert worden, lesen Sie [why pubspec.lock changes after a Flutter upgrade](/de/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/).

## Quellen

- [`drift_flutter` README](https://pub.dev/packages/drift_flutter) (pub.dev)
- [Drift: DateTime storage and migrating between modes](https://drift.simonbinder.eu/guides/datetime-migrations/) (drift.simonbinder.eu)
- [Drift: migrations and `schemaVersion`](https://drift.simonbinder.eu/migrations/) (drift.simonbinder.eu)
- [`sqlite3` upgrading to v3 notes](https://github.com/simolus3/sqlite3.dart/blob/main/UPGRADING_TO_V3.md) (simolus3/sqlite3.dart)
- [`hive_ce` package](https://pub.dev/packages/hive_ce) and [`hive` package](https://pub.dev/packages/hive) (pub.dev)
- [Hive CE source](https://github.com/IO-Design-Team/hive_ce) (IO-Design-Team/hive_ce)
