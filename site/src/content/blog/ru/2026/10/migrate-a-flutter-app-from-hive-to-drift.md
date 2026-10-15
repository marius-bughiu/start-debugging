---
title: "Миграция локального хранилища Flutter-приложения с Hive на Drift (hive_ce 2.22 на drift 2.35)"
description: "Однократный и устойчивый к сбоям импорт существующих боксов Hive в базу SQLite drift на устройстве пользователя: проектирование схемы, функция импорта, идемпотентность, удаление боксов и два подводных камня, которые незаметно портят данные (точность DateTime и конфликты имён классов). Проверено на Flutter 3.44.8 с hive_ce 2.22.0 и drift 2.35.2."
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
lang: "ru"
translationOf: "2026/10/migrate-a-flutter-app-from-hive-to-drift"
translatedBy: "claude"
translationDate: 2026-10-15
---

Перенос опубликованного Flutter-приложения с Hive на drift - это не рефакторинг кода, а миграция данных, которая выполняется на телефоне каждого пользователя. Данные ваших пользователей лежат в файлах `.hive` в каталоге документов приложения, и новая версия должна скопировать их в базу SQLite ровно один раз, ничего не потеряв, даже если приложение будет убито на полпути. Рабочий подход: оставить Hive как зависимость только для чтения на несколько релизов, при запуске выполнять функцию импорта, которая читает все боксы внутри одной транзакции drift, отмечать завершение строкой-флагом в той же транзакции и удалять файлы боксов только после коммита. Для типичного приложения с 2-5 боксами это полдня работы плюс тесты. Две вещи ломаются незаметно: хранение `DateTime` в drift по умолчанию (целые секунды, местное время) и конфликт имени сгенерированного класса строки с именем вашей модели Hive. Всё ниже проверено на Flutter 3.44.8 (Dart 3.12.2) с `hive_ce` 2.22.0, `drift` 2.35.2, `drift_flutter` 0.3.1 и `drift_dev` 2.35.1.

## Зачем вообще уходить с Hive

- **Оригинальный пакет заморожен.** `hive` 2.2.3 опубликован 30 июня 2022 года и до сих пор остаётся последней версией на pub.dev; `hive_flutter` 1.1.0 датируется июнем 2021 года. Форк сообщества `hive_ce` поддерживается (2.22.0 вышел на этой неделе), так что если вам нужна только поддержка, дешевле просто сменить импорт на `hive_ce`. Бокс, записанный `hive` 2.2.3, в моём тесте корректно открылся и прочитался через `hive_ce` 2.22.0, так что такая замена не требует миграции данных.
- **Вам нужны запросы, а не поиск по ключу.** Hive - это хранилище ключ-значение. Фильтрация, сортировка, постраничная выдача и соединения выполняются в Dart после загрузки значений в память. Drift даёт SQL с проверяемыми на этапе компиляции запросами на Dart, индексы и реактивные потоки `watch()`, которые обновляются только при изменении нужных таблиц.
- **Эволюция схемы становится явной.** В Hive добавление поля означает вечную возню с индексами `@HiveField` и nullable-чтением. В drift есть `schemaVersion`, обратный вызов `onUpgrade` и инструменты (`drift_dev schema steps`), которые генерируют типизированные, тестируемые пошаговые миграции.
- **Транзакции.** Записи в Hive выполняются по одному ключу. Drift оборачивает любое число записей в транзакцию SQLite, и именно это делает импорт ниже устойчивым к сбоям.

## Что меняется в приложении

| Область | Изменение | Серьёзность |
| --- | --- | --- |
| Классы моделей | Классы `@HiveType` заменяются таблицами drift и сгенерированными классами строк | высокая |
| Столбцы `DateTime` | Drift хранит целые секунды и возвращает местное время, если не включить текстовое хранение | высокая |
| Ключи | Автоинкрементные ключи Hive (`box.add`) имеют тип `int`, пользовательские ключи - `String`; drift требует типизированный первичный ключ | средняя |
| Списки и словари | Нативного столбца-списка нет; нужен `TypeConverter` или дочерняя таблица | средняя |
| Запуск | `Hive.initFlutter()` + `openBox` заменяются одним экземпляром `AppDatabase` | средняя |
| Реактивный UI | `ValueListenableBuilder(box.listenable())` превращается в `StreamBuilder(query.watch())` | низкая |
| Место хранения | Оба используют `getApplicationDocumentsDirectory()`; drift пишет `<name>.sqlite` рядом с файлами `.hive` | низкая |

## Чек-лист перед началом

- Составьте перечень всех боксов: имя, тип значения (`Box<Note>`, `Box<dynamic>`, `LazyBox`), тип ключа, зашифрован ли бокс и сколько примерно записей у активного пользователя.
- Перечислите все `TypeAdapter` и их `typeId`. Код импорта должен их зарегистрировать, иначе `openBox` бросает исключение, встретив неизвестный ID типа.
- Сохраните копию файлов `.hive` с реального устройства (из отладочной сборки, через `adb pull` или загрузку контейнера в Xcode) для использования в качестве тестовых фикстур.
- Решите, с какой минимальной версии приложения вы ещё будете выполнять миграцию. Hive остаётся в `pubspec.yaml`, пока вы не откажетесь от этой поддержки.
- Убедитесь, что CI умеет запускать `dart run build_runner build`, ведь drift использует кодогенерацию.

## Шаги миграции

1. **Добавьте drift рядом с Hive, а не вместо него.** Старый пакет остаётся, потому что импорт должен читать старые файлы. Обратите внимание, что `sqlite3_flutter_libs` больше не нужен: `drift_flutter` 0.3.x зависит от `sqlite3` 3.x, который включает SQLite через build hooks, а `sqlite3_flutter_libs` 0.6.0 - это пустой релиз "end of life".

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

   Проверьте командой `flutter pub get` и убедитесь, что в `pubspec.lock` не осталось строки `sqlite3_flutter_libs` 0.5.x.

2. **Переключите drift на текстовое хранение `DateTime` до записи любых данных.** По умолчанию drift хранит `DateTime` как целочисленную метку Unix в секундах и всегда читает её обратно как местное время. В моём тесте значение Hive `2026-10-15T09:30:12.345Z` вернулось из drift как `2026-10-15T12:30:12.000` с `isUtc=false` (машина работает в поясе +03:00): миллисекунды и признак UTC пропали, а в самом столбце лежало `1792056612`. Hive сохраняет и то, и другое. Добавьте `build.yaml` рядом с `pubspec.yaml`:

   ```yaml
   # build.yaml - drift_dev 2.35.1
   targets:
     $default:
       builders:
         drift_dev:
           options:
             store_date_time_values_as_text: true
   ```

   С этой опцией то же значение хранится как `2026-10-15T09:30:12.345Z` и читается обратно с `isUtc=true`. Сделать это сейчас ничего не стоит; позднее переключение потребует миграции схемы по всем столбцам с датами.

3. **Опишите таблицы и сохраните старый ключ Hive.** Столбец `legacyKey` с ограничением уникальности делает импорт идемпотентным. Переименуйте сгенерированный класс строки через `@DataClassName`: drift выводит `Note` из таблицы `Notes`, и это конфликтует с вашим существующим классом Hive `Note`, как только один файл импортирует оба (`Error: 'Note' is imported from both ...`).

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

   Таблица `Settings` заменяет нетипизированный `Box<dynamic>` с настройками простой таблицей ключ-значение со значениями в JSON. Запустите `dart run build_runner build` и убедитесь, что `database.g.dart` генерируется без предупреждений.

4. **Напишите импорт как одну транзакцию с флагом завершения.** Всё важное происходит в этой функции: она открывает старые боксы, вставляет все записи одним `batch` внутри одной `transaction`, записывает строку `hive_import_done` в той же транзакции и удаляет файлы боксов только после коммита.

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

   Проверьте тестом из раздела "Проверка" ниже, прежде чем подключать импорт к приложению.

5. **Вызывайте его один раз при запуске, до того как первый экран прочитает данные.** Инициализируйте Hive так же, как это делала старая версия, чтобы боксы нашлись в том же каталоге, затем выполните импорт, а потом передайте базу данных остальному приложению.

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

   Если старый релиз вызывал `Hive.initFlutter('some_subdir')`, передайте то же значение, иначе `boxExists` вернёт `false`, импорт отметит "fresh install", а данные пользователя будут молча проигнорированы. Проверьте так: установите старый релиз, создайте данные, затем установите новую сборку поверх него.

6. **Заменяйте чтение и запись экран за экраном.** `box.values.where(...)` становится запросом drift, `box.put` становится вставкой или обновлением, а `box.listenable()` становится `watch()`:

   ```dart
   // Flutter 3.44.8, drift 2.35.2
   Stream<List<NoteRow>> watchPinned(AppDatabase db) =>
       (db.select(db.notes)
             ..where((n) => n.pinned.equals(true))
             ..orderBy([(n) => OrderingTerm.desc(n.createdAt)]))
           .watch();
   ```

   Проверьте командой `flutter analyze`: когда ни один файл вне `legacy/` и `hive_migration.dart` не импортирует `package:hive_ce`, логика приложения полностью работает на drift.

7. **Удалите Hive после окна импорта.** Когда аналитика покажет, что почти все активные установки выполнили импорт (или когда самая старая поддерживаемая версия выйдет из обращения), удалите `hive_migration.dart`, адаптеры в `lib/legacy/` и две зависимости Hive. Строку `hive_import_done` оставьте; она ничего не стоит и документирует произошедшее.

## Проверка

Drift работает на Dart VM в `flutter test` с `NativeDatabase.memory()`, а Hive работает в любом каталоге с `Hive.init(path)`, поэтому весь импорт можно протестировать без устройства:

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

Что вывел мой запуск: две строки со старыми ключами `0` и `custom-key`, `createdAt`, равный исходному значению в UTC, каталог боксов, изменившийся с `[notes.hive, settings.hive]` на `[]`, и неизменное число строк после второго вызова.

Чтобы доказать устойчивость к сбоям, я добавил триггер SQLite, который прерывает вставку строки `hive_import_done`, имитируя гибель приложения в самый последний момент. Импорт бросил `SqliteException(1811): ... simulated crash`, в таблице `notes` было 0 строк, а оба файла `.hive` остались на диске. При следующем запуске импорт просто выполняется снова. В этом и смысл размещения флага внутри транзакции, а удалений за её пределами.

Затем на реальном устройстве: установите предыдущую сборку из магазина, создайте данные, установите новую сборку поверх неё и убедитесь, что данные отображаются, а `app.sqlite` существует в каталоге документов, тогда как файлов `.hive` больше нет.

## Откат

Пока окно импорта не закрыто, миграция обратима только в одном направлении времени: старая версия приложения не может прочитать `app.sqlite`, а после успешного импорта файлы `.hive` удалены. Если нужен безопасный путь отката, отложите удаление на один релиз (оставьте шаг 4, но пропустите вызовы `deleteFromDisk`), чтобы пользователь, вернувшийся на старую версию, всё ещё нашёл свои старые боксы. Данные, записанные после импорта, в версии после даунгрейда не появятся, так что скажите об этом QA прямо и громко. Как только боксы удалены, миграция становится односторонней.

## Подводные камни реальной миграции

### `jsonEncode` падает на значениях, которые Hive хранил нативно

`Box<dynamic>` может содержать `DateTime`, `Uint8List` или тип с пользовательским адаптером. `jsonEncode` умеет обрабатывать только словари, списки, строки, числа, булевы значения и null, поэтому бокс настроек с датой `lastSync` приводит к `JsonUnsupportedObjectError` внутри транзакции, и весь импорт откатывается при каждом запуске. Обрабатывайте такие ключи явно или передайте `toEncodable: (o) => o is DateTime ? o.toUtc().toIso8601String() : throw ...`.

### Зашифрованным боксам нужен их шифр

Если старая версия открывала бокс с `encryptionCipher: HiveAesCipher(key)`, импорт должен передавать тот же шифр, обычно считываемый из `flutter_secure_storage`. Без него записи не декодируются. Решите, нужно ли шифровать и базу drift; поддержка SQLCipher в drift настраивается отдельно, и `drift_flutter` не включает её за вас.

### Большие боксы и память

`Box` загружает все значения в память при открытии, что старое приложение уже делало, так что обычный бокс не проблема. Если старый код использовал `LazyBox` из-за большого объёма данных, читайте через `await lazy.get(key)` и вставляйте порциями по несколько тысяч строк на `batch`. Всё равно держите всё в одной транзакции, чтобы флаг завершения оставался атомарным.

### Целочисленные ключи

`box.add` назначает автоинкрементные ключи типа `int`, а `box.put` принимает `int` или `String`. Сохранение `key.toString()` в `legacyKey` покрывает оба случая, но если другие боксы ссылаются на записи по ключу (бокс "favorites" с ключами заметок), разрешайте эти ссылки после основной вставки поиском по `legacyKey`, а не предполагая, что `id` в drift равен ключу Hive.

### Запуск импорта вне потока UI

Для десятков тысяч записей декодирование боксов - это нагрузка на процессор в главном изоляте во время запуска. `driftDatabase()` уже запускает SQLite в фоновом изоляте (он открывает файл через `NativeDatabase.createBackgroundConnection`), но декодирование Hive по-прежнему происходит там, где вызван `openBox`. Если страдает время запуска, покажите экран миграции вместо замершей заставки или вынесите декодирование в отдельный изолят и передавайте обратно простые данные.

## Связанные материалы

- Если импорт настолько медленный, что запуск подтормаживает, см. [как написать изолят Dart для задач, нагружающих процессор](/ru/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) и [разницу между изолятом Dart и потоком](/ru/2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread/).
- Экрану миграции, который ждёт импорт и затем выполняет переход, нужны приёмы из статьи [безопасное использование BuildContext после await во Flutter](/ru/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).
- Добавление `drift_dev` и `build_runner` меняет ваш файл блокировки; если CI вдруг сообщает, что он изменён, прочитайте [почему pubspec.lock меняется после обновления Flutter](/ru/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/).

## Источники

- [`drift_flutter` README](https://pub.dev/packages/drift_flutter) (pub.dev)
- [Drift: DateTime storage and migrating between modes](https://drift.simonbinder.eu/guides/datetime-migrations/) (drift.simonbinder.eu)
- [Drift: migrations and `schemaVersion`](https://drift.simonbinder.eu/migrations/) (drift.simonbinder.eu)
- [`sqlite3` upgrading to v3 notes](https://github.com/simolus3/sqlite3.dart/blob/main/UPGRADING_TO_V3.md) (simolus3/sqlite3.dart)
- [`hive_ce` package](https://pub.dev/packages/hive_ce) и [`hive` package](https://pub.dev/packages/hive) (pub.dev)
- [Hive CE source](https://github.com/IO-Design-Team/hive_ce) (IO-Design-Team/hive_ce)
