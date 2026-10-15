---
title: "Migra el almacenamiento local de una app Flutter de Hive a Drift (hive_ce 2.22 a drift 2.35)"
description: "Una importación única y a prueba de fallos de las cajas de Hive existentes a una base de datos SQLite de drift en el dispositivo del usuario: diseño del esquema, la función de importación, idempotencia, eliminación de las cajas y las dos trampas que corrompen datos en silencio (precisión de DateTime y colisiones de nombres de clase). Probado en Flutter 3.44.8 con hive_ce 2.22.0 y drift 2.35.2."
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
lang: "es"
translationOf: "2026/10/migrate-a-flutter-app-from-hive-to-drift"
translatedBy: "claude"
translationDate: 2026-10-15
---

Pasar una app Flutter ya publicada de Hive a drift no es un refactor de código, es una migración de datos que se ejecuta en el celular de cada usuario. Los datos que tus usuarios ya tienen viven en archivos `.hive` dentro del directorio de documentos de la app, y la nueva versión tiene que copiarlos a una base de datos SQLite exactamente una vez, sin perder nada si la app se cierra a la mitad. El enfoque que funciona: mantener Hive como dependencia de solo lectura durante unas versiones, ejecutar al inicio una función de importación que lea cada caja dentro de una única transacción de drift, marcar la finalización con una fila de bandera en la misma transacción y eliminar los archivos de las cajas solo después del commit. Para una app típica con 2 a 5 cajas son medio día de trabajo más las pruebas. Las dos cosas que fallan en silencio son el almacenamiento predeterminado de `DateTime` en drift (segundos enteros, hora local) y la colisión de la clase de fila generada con el nombre de tu modelo de Hive. Todo lo que sigue se probó en Flutter 3.44.8 (Dart 3.12.2) con `hive_ce` 2.22.0, `drift` 2.35.2, `drift_flutter` 0.3.1 y `drift_dev` 2.35.1.

## Por qué abandonar Hive

- **El paquete original está congelado.** `hive` 2.2.3 se publicó el 30 de junio de 2022 y sigue siendo la última versión en pub.dev; `hive_flutter` 1.1.0 es de junio de 2021. El fork de la comunidad `hive_ce` tiene mantenimiento (la 2.22.0 salió esta semana), así que si solo necesitas mantenimiento, cambiar la importación a `hive_ce` es el movimiento más barato. Una caja escrita por `hive` 2.2.3 se abrió y se leyó correctamente con `hive_ce` 2.22.0 en mi prueba, así que ese cambio no necesita una migración de datos.
- **Necesitas consultas, no búsquedas por clave.** Hive es un almacén clave-valor. Filtrar, ordenar, paginar y hacer joins ocurre en Dart después de cargar los valores en memoria. Drift te da SQL con consultas Dart verificadas en tiempo de compilación, índices y streams `watch()` reactivos que se actualizan solo cuando cambian las tablas subyacentes.
- **La evolución del esquema se vuelve explícita.** En Hive, agregar un campo significa hacer malabares para siempre con los índices de `@HiveField` y lecturas anulables. Drift tiene un `schemaVersion`, un callback `onUpgrade` y herramientas (`drift_dev schema steps`) que generan migraciones paso a paso tipadas y verificables con pruebas.
- **Transacciones.** Las escrituras de Hive son por clave. Drift envuelve cualquier cantidad de escrituras en una transacción de SQLite, que es justo lo que hace que la importación de abajo sea a prueba de fallos.

## Qué cambia en la app

| Área | Cambio | Gravedad |
| --- | --- | --- |
| Clases de modelo | Las clases `@HiveType` se reemplazan por tablas de drift más clases de fila generadas | alta |
| Columnas `DateTime` | Drift guarda segundos enteros y devuelve hora local salvo que optes por el almacenamiento como texto | alta |
| Claves | Las claves autoincrementales de Hive (`box.add`) son `int`, las claves personalizadas son `String`; drift quiere una clave primaria tipada | media |
| Listas y mapas | No hay columna de lista nativa; se necesita un `TypeConverter` o una tabla hija | media |
| Inicio | `Hive.initFlutter()` + `openBox` se reemplazan por una única instancia de `AppDatabase` | media |
| UI reactiva | `ValueListenableBuilder(box.listenable())` pasa a ser `StreamBuilder(query.watch())` | baja |
| Ubicación del almacenamiento | Ambos usan `getApplicationDocumentsDirectory()`; drift escribe `<name>.sqlite` junto a los archivos `.hive` | baja |

## Lista de verificación previa

- Haz el inventario de cada caja: nombre, tipo de valor (`Box<Note>`, `Box<dynamic>`, `LazyBox`), tipo de clave, si está cifrada y cuántas entradas tiene aproximadamente un usuario intensivo.
- Enumera cada `TypeAdapter` y su `typeId`. El código de importación debe registrarlos, o `openBox` lanza una excepción al encontrar un ID de tipo desconocido.
- Guarda una copia de los archivos `.hive` de un dispositivo real (de una compilación de depuración, mediante `adb pull` o la descarga del contenedor desde Xcode) para usarlos como fixtures de prueba.
- Decide la versión mínima de la app desde la que seguirás migrando. Hive permanece en `pubspec.yaml` hasta que elimines ese soporte.
- Asegúrate de que el CI pueda ejecutar `dart run build_runner build`, ya que drift genera código.

## Pasos de la migración

1. **Agrega drift junto a Hive, no en su lugar.** El paquete antiguo se queda porque la importación tiene que leer los archivos antiguos. Ten en cuenta que `sqlite3_flutter_libs` ya no es necesario: `drift_flutter` 0.3.x depende de `sqlite3` 3.x, que incluye SQLite mediante build hooks, y `sqlite3_flutter_libs` 0.6.0 es una versión vacía de "fin de vida".

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

   Verifica con `flutter pub get` y confirma que no quede ninguna línea `sqlite3_flutter_libs` 0.5.x en `pubspec.lock`.

2. **Cambia drift al almacenamiento de `DateTime` como texto antes de escribir cualquier dato.** De forma predeterminada drift guarda un `DateTime` como una marca de tiempo Unix entera en segundos y siempre lo devuelve como hora local. En mi prueba, un valor de Hive `2026-10-15T09:30:12.345Z` volvió de drift como `2026-10-15T12:30:12.000` con `isUtc=false` (la máquina funciona en +03:00): los milisegundos y la bandera UTC desaparecieron, y la columna cruda contenía `1792056612`. Hive conserva ambos. Agrega un `build.yaml` junto a `pubspec.yaml`:

   ```yaml
   # build.yaml - drift_dev 2.35.1
   targets:
     $default:
       builders:
         drift_dev:
           options:
             store_date_time_values_as_text: true
   ```

   Con esta opción el mismo valor se guarda como `2026-10-15T09:30:12.345Z` y se lee de vuelta con `isUtc=true`. Hacerlo ahora no cuesta nada; cambiarlo después requiere una migración de esquema sobre cada columna de fecha.

3. **Modela las tablas y conserva la clave antigua de Hive.** Una columna `legacyKey` con restricción de unicidad es lo que hace idempotente la importación. Renombra la clase de fila generada con `@DataClassName`, porque drift deriva `Note` de una tabla llamada `Notes`, y eso colisiona con tu clase `Note` de Hive existente en cuanto un archivo importa ambas (`Error: 'Note' is imported from both ...`).

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

   La tabla `Settings` reemplaza una `Box<dynamic>` sin tipos de preferencias por una simple tabla clave-valor con valores JSON. Ejecuta `dart run build_runner build` y verifica que `database.g.dart` se genere sin advertencias.

4. **Escribe la importación como una sola transacción con una bandera de finalización.** Todo lo importante ocurre en esta función: abre las cajas antiguas, inserta cada entrada en un solo `batch` dentro de una sola `transaction`, escribe la fila `hive_import_done` en la misma transacción y elimina los archivos de las cajas solo después del commit.

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

   Verifica con la prueba de la sección Verificación de más abajo antes de conectarla a la app.

5. **Llámala una vez al inicio, antes de que la primera pantalla lea datos.** Inicializa Hive igual que lo hacía la versión antigua, para que las cajas se encuentren en el mismo directorio; luego ejecuta la importación y después entrega la base de datos al resto de la app.

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

   Si la versión antigua llamaba a `Hive.initFlutter('some_subdir')`, pasa el mismo valor; de lo contrario `boxExists` devuelve `false`, la importación marca una "instalación nueva" y los datos del usuario se ignoran en silencio. Verifica instalando la versión antigua, creando datos y luego instalando la nueva compilación encima.

6. **Reemplaza lecturas y escrituras pantalla por pantalla.** `box.values.where(...)` pasa a ser una consulta de drift, `box.put` pasa a ser un insert o update, y `box.listenable()` pasa a ser `watch()`:

   ```dart
   // Flutter 3.44.8, drift 2.35.2
   Stream<List<NoteRow>> watchPinned(AppDatabase db) =>
       (db.select(db.notes)
             ..where((n) => n.pinned.equals(true))
             ..orderBy([(n) => OrderingTerm.desc(n.createdAt)]))
           .watch();
   ```

   Verifica con `flutter analyze`: cuando ningún archivo fuera de `legacy/` y `hive_migration.dart` importe `package:hive_ce`, la lógica de la app estará completamente en drift.

7. **Elimina Hive después de la ventana de importación.** Cuando las analíticas muestren que casi todas las instalaciones activas ya ejecutaron la importación (o cuando la versión más antigua soportada haya salido de circulación), elimina `hive_migration.dart`, los adaptadores en `lib/legacy/` y las dos dependencias de Hive. Conserva la fila `hive_import_done`; no cuesta nada y documenta lo que ocurrió.

## Verificación

Drift se ejecuta en la VM de Dart en `flutter test` con `NativeDatabase.memory()`, y Hive funciona en cualquier directorio con `Hive.init(path)`, así que toda la importación se puede probar sin un dispositivo:

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

Lo que imprimió mi ejecución: dos filas con claves heredadas `0` y `custom-key`, `createdAt` igual al valor UTC original, el directorio de cajas pasando de `[notes.hive, settings.hive]` a `[]`, y un conteo de filas sin cambios tras la segunda llamada.

Para demostrar la seguridad ante fallos, agregué un trigger de SQLite que aborta el insert de la fila `hive_import_done`, lo que simula que la app muere en el último momento posible. La importación lanzó `SqliteException(1811): ... simulated crash`, la tabla `notes` tenía 0 filas y los dos archivos `.hive` seguían en disco. En el siguiente inicio la importación simplemente se ejecuta de nuevo. Ese es todo el sentido de poner la bandera dentro de la transacción y las eliminaciones fuera de ella.

Luego, en un dispositivo real: instala la compilación anterior de la tienda, crea datos, instala la nueva compilación encima y confirma que los datos aparecen y que `app.sqlite` existe en el directorio de documentos mientras los archivos `.hive` ya no están.

## Cómo revertir

Antes de que se cierre la ventana de importación, la migración es reversible solo en una dirección del tiempo: una versión antigua de la app no puede leer `app.sqlite`, y tras una importación exitosa los archivos `.hive` se eliminan. Si necesitas una ruta segura de reversión, retrasa la eliminación una versión (conserva el paso 4 pero omite las llamadas a `deleteFromDisk`), de modo que un usuario que vuelva a una versión anterior aún encuentre sus cajas antiguas. Los datos escritos después de la importación no aparecerían en la app degradada, así que díselo claramente a QA. Una vez eliminadas las cajas, la migración es de un solo sentido.

## Trampas de una migración real

### `jsonEncode` falla con valores que Hive guardó de forma nativa

Una `Box<dynamic>` puede contener un `DateTime`, un `Uint8List` o un tipo de adaptador personalizado. `jsonEncode` solo maneja mapas, listas, cadenas, números, booleanos y null, así que una caja de preferencias con una fecha `lastSync` lanza `JsonUnsupportedObjectError` dentro de la transacción y toda la importación se revierte en cada inicio. Mapea esas claves de forma explícita, o pasa `toEncodable: (o) => o is DateTime ? o.toUtc().toIso8601String() : throw ...`.

### Las cajas cifradas necesitan su cifrador

Si la versión antigua abría una caja con `encryptionCipher: HiveAesCipher(key)`, la importación debe pasar el mismo cifrador, normalmente leído de `flutter_secure_storage`. Sin él, las entradas no se pueden decodificar. Decide si la base de datos de drift también necesita cifrado; el soporte de SQLCipher en drift es una configuración aparte y `drift_flutter` no lo activa por ti.

### Cajas grandes y memoria

`Box` carga todos los valores en memoria al abrirse, algo que la app antigua ya hacía, así que una caja normal no es problema. Si el código antiguo usaba `LazyBox` porque los datos son grandes, lee con `await lazy.get(key)` e inserta en bloques de unos pocos miles de filas por `batch`. De todos modos mantén todo en una sola transacción para que la bandera de finalización siga siendo atómica.

### Claves enteras

`box.add` asigna claves `int` autoincrementales y `box.put` acepta `int` o `String`. Guardar `key.toString()` en `legacyKey` cubre ambos casos, pero si otras cajas hacen referencia a entradas por clave (una caja de "favoritos" que guarda claves de notas), resuelve esas referencias después del insert principal con una búsqueda por `legacyKey`, no suponiendo que el `id` de drift es igual a la clave de Hive.

### Ejecutar la importación fuera del hilo de la UI

Con decenas de miles de entradas, decodificar las cajas es trabajo de CPU en el isolate principal durante el inicio. `driftDatabase()` ya ejecuta SQLite en un isolate en segundo plano (abre el archivo mediante `NativeDatabase.createBackgroundConnection`), pero la decodificación de Hive sigue ocurriendo donde se llame a `openBox`. Si el tiempo de inicio se resiente, muestra una pantalla de migración en lugar de una pantalla de carga congelada, o mueve la decodificación a un isolate aparte y devuelve datos simples.

## Relacionado

- Si la importación es lo bastante lenta como para entorpecer el inicio, consulta [cómo escribir un isolate de Dart para trabajo limitado por CPU](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) y [la diferencia entre un isolate de Dart y un hilo](/es/2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread/).
- La pantalla de migración que espera la importación y luego navega necesita los patrones de [usar BuildContext de forma segura después de un await en Flutter](/es/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).
- Agregar `drift_dev` y `build_runner` cambia tu archivo de bloqueo; si el CI de pronto informa que fue modificado, lee [por qué cambia pubspec.lock después de actualizar Flutter](/es/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/).

## Fuentes

- [`drift_flutter` README](https://pub.dev/packages/drift_flutter) (pub.dev)
- [Drift: DateTime storage and migrating between modes](https://drift.simonbinder.eu/guides/datetime-migrations/) (drift.simonbinder.eu)
- [Drift: migrations and `schemaVersion`](https://drift.simonbinder.eu/migrations/) (drift.simonbinder.eu)
- [`sqlite3` upgrading to v3 notes](https://github.com/simolus3/sqlite3.dart/blob/main/UPGRADING_TO_V3.md) (simolus3/sqlite3.dart)
- [`hive_ce` package](https://pub.dev/packages/hive_ce) y [`hive` package](https://pub.dev/packages/hive) (pub.dev)
- [Hive CE source](https://github.com/IO-Design-Team/hive_ce) (IO-Design-Team/hive_ce)
