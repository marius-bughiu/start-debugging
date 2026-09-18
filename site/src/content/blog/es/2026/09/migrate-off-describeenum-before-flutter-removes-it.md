---
title: "Migra fuera de describeEnum en Flutter antes de que lo eliminen"
description: "describeEnum está obsoleto desde Flutter 3.16 y el PR que lo elimina ya está aprobado. Cómo reemplazar cada llamada por Enum.name (Flutter 3.47.4, Dart 3.13), manejar clases tipo enum y diagnósticos, encontrar las llamadas escondidas en dependencias como flutter_svg 1.x y cómo se ve el error de compilación una vez que desaparece."
pubDate: 2026-09-18
updatedDate: 2026-09-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "enums"
lang: "es"
translationOf: "2026/09/migrate-off-describeenum-before-flutter-removes-it"
translatedBy: "claude"
translationDate: 2026-09-18
---

Para casi cualquier base de código esto es un buscar y reemplazar de 30 minutos: `describeEnum(x)` pasa a ser `x.name`, `describeEnum` pasado como tear-off pasa a ser `(e) => e.name`, y los bucles de "string de vuelta a enum" que lo acompañaban pasan a ser `MyEnum.values.byName(s)`. `dart fix` no lo hace por ti, y los únicos puntos de llamada que requieren pensar son los que pasan algo que no es un `Enum` real de Dart. Lo que de verdad cuesta tiempo es tu grafo de dependencias: un paquete viejo como `flutter_svg` 1.1.6 todavía llama a `describeEnum`, y el día que lo eliminen tu app deja de compilar en un archivo que no es tuyo. Todo lo que sigue lo verifiqué en Flutter 3.47.4 (Dart 3.13.3), la versión estable actual, y contra una compilación local de Flutter con la eliminación pendiente aplicada.

## En qué punto está realmente la eliminación

La línea de tiempo es lo bastante confusa como para fijarla antes de tocar código, porque hoy la documentación oficial y el SDK no coinciden.

- `describeEnum` se marcó como obsoleto en [flutter/flutter#125016](https://github.com/flutter/flutter/pull/125016), que llegó en 3.14.0-2.0.pre y se publicó en la estable 3.16. El mensaje de obsolescencia dice "Use the `name` getter on enums instead. This feature was deprecated after v3.14.0-2.0.pre."
- La eliminación es [flutter/flutter#190076](https://github.com/flutter/flutter/pull/190076), abierto el 2026-07-27. Borra la función de `packages/flutter/lib/src/foundation/diagnostics.dart` junto con sus pruebas. Tiene tres aprobaciones pero, al 2026-09-18, sigue abierto: el check "Google testing" falla porque el monorepo interno de Google primero tiene que subir `flutter_svg` por encima de 2.0.0.
- La guía de cambios incompatibles para la eliminación ([flutter/website#13682](https://github.com/flutter/website/pull/13682)) se fusionó el 2026-08-18, y el índice de cambios incompatibles ya lista "Removal of `describeEnum`" bajo **Released in Flutter 3.47**. Eso va por delante de la realidad. Revisé `diagnostics.dart` en el tag `3.47.4`, en el tag beta `3.48.0-0.5.pre` y en `master`: `describeEnum` sigue definido en los tres.

Así que hoy no se rompe nada en el canal estable. Lo que obtienes es una sugerencia `deprecated_member_use` de nivel `info` que la mayoría de los equipos viene ignorando desde 2023. En cuanto se fusione #190076, `master` se rompe de inmediato y la siguiente beta se rompe para todos los que estén en beta. Migrar ahora cuesta lo mismo que migrar después, solo que después te toca en medio de una actualización que querías hacer por otro motivo.

## Qué se rompe

| Área | Cambio | Severidad |
| ---- | ------ | -------- |
| `describeEnum(value)` en tu código | Error de compilación: la función ya no existe | alta, pero trivial de arreglar |
| `describeEnum` en una dependencia | Error de compilación en el archivo del paquete, la app no compila | alta, requiere actualizar el paquete |
| `describeEnum` sobre clases que no son `Enum` | No hay getter `.name` al cual cambiar | media, requiere un helper local |
| `describeEnum` usado como tear-off (`.map(describeEnum)`) | El mismo error de compilación | baja |
| `StringProperty(name, describeEnum(v))` en `debugFillProperties` | Funciona si lo reescribes a `.name`, pero `EnumProperty` es el mejor reemplazo | baja |
| Soporte de `dart fix` | Ninguno. La guía de Flutter lo dice explícitamente, y `dart fix --dry-run` reporta "Nothing to fix!" | informativo |

## Lista de verificación previa

- Flutter 3.16 o más reciente. Todas las estables desde entonces traen la obsolescencia, así que el analizador puede encontrar tus puntos de llamada por ti. Aquí la base es código en 3.47.4.
- Dart 2.15 o más reciente para el getter `name` y `values.byName`. Ambos llegaron con los helpers de enum de `dart:core` en Dart 2.15.0 (la guía de Flutter dice 2.14, pero el changelog de Dart los lista bajo 2.15.0). Cualquier proyecto Flutter 3.x ya cumple con esto.
- Una línea base limpia de `flutter analyze`, para que las sugerencias de obsolescencia no queden enterradas bajo advertencias no relacionadas.
- La salida de `flutter pub outdated` para tu app, porque el paso de dependencias de más abajo puede obligarte a subir una versión mayor.

## Cómo se ve el fallo después de la eliminación

Para obtener el texto real del error en lugar de adivinarlo, apliqué el diff de #190076 a un checkout temporal de Flutter 3.47.4 y corrí un proyecto de prueba contra él. El analizador reporta:

```text
error • The function 'describeEnum' isn't defined. Try importing the library that defines 'describeEnum', correcting the name to the name of an existing function, or defining a function named 'describeEnum' • lib/legacy.dart:27:20 • undefined_function
```

`flutter run`, `flutter test` y `flutter build` pasan en cambio por el compilador front-end, que imprime:

```text
lib/legacy.dart:27:20: Error: Method not found: 'describeEnum'.
String simple() => describeEnum(ThemeChoice.dark);
                   ^^^^^^^^^^^^
```

Y un proyecto que depende de `flutter_svg: 1.1.6` falla antes de que se ejecute nada de tu código, con el error apuntando dentro de la caché de pub:

```text
/Users/marius/.pub-cache/hosted/pub.dev/flutter_svg-1.1.6/lib/src/picture_provider.dart:196:33: Error: The method 'describeEnum' isn't defined for the type 'PictureConfiguration'.
      result.write('platform: ${describeEnum(platform!)}');
                                ^^^^^^^^^^^^
```

Si llegaste a este artículo por ese último mensaje, salta directo al paso 5.

## Pasos de la migración

1. **Lista cada punto de llamada con el analizador.**
   Ejecuta `flutter analyze` y filtra por la obsolescencia. En 3.47.4 cada coincidencia es una línea `info` que termina en `deprecated_member_use`:

   ```bash
   # Flutter 3.47.4
   flutter analyze --no-fatal-infos | grep "'describeEnum' is deprecated"
   ```

   Un simple `grep -rn "describeEnum" lib test` encuentra los mismos puntos, más las menciones en comentarios de documentación y en cualquier archivo que tu `analysis_options.yaml` excluya. Verifica: tienes una lista de archivos y números de línea, y sabes cuáles están en archivos generados (regenéralos, no los edites a mano).

2. **Reemplaza las llamadas sobre enums reales por `.name`.**
   Para cualquier valor cuyo tipo estático sea un `enum`, la reescritura es mecánica. Esto cubre enums simples, enums mejorados, enums anulables y tear-offs:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   enum ThemeChoice { light, dark }

   // Before
   String simple() => describeEnum(ThemeChoice.dark);
   String? nullable(ThemeChoice? c) => c == null ? null : describeEnum(c);
   List<String> tearOff() => ThemeChoice.values.map(describeEnum).toList();

   // After
   String simple() => ThemeChoice.dark.name;
   String? nullable(ThemeChoice? c) => c?.name;
   List<String> tearOff() => ThemeChoice.values.map((e) => e.name).toList();
   ```

   El comportamiento es idéntico: desde Flutter 3.0, `describeEnum` empieza con `if (enumEntry is Enum) return enumEntry.name;`, así que para enums reales ya era solo un envoltorio de `.name`. Eso incluye los enums mejorados que sobrescriben `toString()`. Un enum cuyo `toString()` devuelve `Level(H)` igual daba `high` con `describeEnum`, y da `high` con `.name`. Verifica: `flutter analyze` no muestra sugerencias restantes para estos archivos.

3. **Reemplaza la búsqueda inversa por `values.byName`.**
   La mayor parte del código con `describeEnum` está junto a un parser hecho a mano que recorre `values` comparando strings. Reemplaza ambas mitades a la vez:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   // Before
   Map<String, Object?> toJson(ThemeChoice c) => {'theme': describeEnum(c)};
   ThemeChoice fromJson(Map<String, Object?> json) =>
       ThemeChoice.values.firstWhere((e) => describeEnum(e) == json['theme']);

   // After
   Map<String, Object?> toJson(ThemeChoice c) => {'theme': c.name};
   ThemeChoice fromJson(Map<String, Object?> json) =>
       ThemeChoice.values.byName(json['theme']! as String);
   ```

   Los strings serializados no cambian, así que el JSON almacenado, las shared preferences y los eventos de analítica siguen funcionando. Lo que sí cambia es el modo de fallo: para un valor desconocido el bucle viejo lanzaba `StateError: Bad state: No element`, mientras que `byName` lanza `ArgumentError: Invalid argument (name): No enum value with that name: "blue"`. Si capturas `StateError` alrededor de ese parseo, actualiza el `catch`. Verifica: una prueba que haga el viaje de ida y vuelta de cada valor de `ThemeChoice.values` por `toJson`/`fromJson`, más una prueba con un string desconocido.

4. **Dale a las clases tipo enum un helper local.**
   `describeEnum` aceptaba `Object`, y para cualquier cosa que no fuera un `Enum` tomaba `toString()` y devolvía todo lo que venía después del primer punto. Eso estaba pensado para las clases "tipo enum" anteriores a Dart 2.17 como esta, que todavía existen en bases de código antiguas y en algunos paquetes:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   class Channel {
     const Channel._(this._value);
     final String _value;
     static const Channel stable = Channel._('stable');
     static const Channel beta = Channel._('beta');
     @override
     String toString() => 'Channel.$_value';
   }
   ```

   `Channel.beta.name` no compila, porque no existe `name`. Tienes dos opciones. La mejor es convertir `Channel` en un `enum` real, algo que normalmente es posible ahora que los enums mejorados admiten campos y constructores. Cuando no es posible (la clase viene de un paquete, o tiene instancias que no son const), copia la rama de respaldo a tu propio código:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   /// Local copy of the only describeEnum behaviour `.name` cannot replace.
   String enumLikeName(Object value) {
     final String description = value.toString();
     final int indexOfDot = description.indexOf('.');
     assert(
       indexOfDot != -1 && indexOfDot < description.length - 1,
       'The provided object "$value" is not an enum.',
     );
     return description.substring(indexOfDot + 1);
   }

   String fromObject(Object value) =>
       value is Enum ? value.name : enumLikeName(value);
   ```

   La comprobación `value is Enum` importa en los puntos de llamada tipados como `Object` o `dynamic`, que es justo donde la gente le pasaba a `describeEnum` una mezcla de enums y clases tipo enum. Ten en cuenta que el `assert` solo se ejecuta en compilaciones de depuración. En release, `describeEnum(42)` nunca lanzaba nada: `indexOf` devolvía -1, `substring(0)` devolvía `"42"` y tu código seguía de largo. El helper conserva ese comportamiento a propósito, para que nada cambie en producción. Verifica: las pruebas en modo depuración para cada tipo tipo enum devuelven los mismos strings que antes.

5. **Arregla las llamadas en tus dependencias.**
   Tu propio código es la parte fácil. Un paquete que llama a `describeEnum` rompe tu compilación el día que la función desaparece, y no puedes parchearlo con un buscar y reemplazar. Hacer grep sobre la caché de pub genera mucho ruido porque contiene todas las versiones que alguna vez descargaste, así que escanea solo las versiones de paquetes que tu app realmente resuelve, usando `.dart_tool/package_config.json`:

   ```dart
   // Dart 3.13: list every describeEnum call in the packages your app resolves.
   // Save as tool/find_describe_enum.dart, run: dart run tool/find_describe_enum.dart
   import 'dart:convert';
   import 'dart:io';

   void main() {
     final config = File('.dart_tool/package_config.json');
     final json = jsonDecode(config.readAsStringSync()) as Map<String, dynamic>;
     final call = RegExp(r'\bdescribeEnum\s*[(),;]');
     for (final pkg in (json['packages'] as List).cast<Map<String, dynamic>>()) {
       if (pkg['name'] == 'flutter') continue; // defines it
       var rootUri = pkg['rootUri'] as String;
       if (!rootUri.endsWith('/')) rootUri += '/';
       final root = config.parent.uri.resolve(rootUri);
       final lib = Directory.fromUri(root.resolve(pkg['packageUri'] as String));
       if (!lib.existsSync()) continue;
       for (final f in lib.listSync(recursive: true).whereType<File>()) {
         if (!f.path.endsWith('.dart')) continue;
         final lines = f.readAsLinesSync();
         for (var i = 0; i < lines.length; i++) {
           if (call.hasMatch(lines[i]) && !lines[i].trimLeft().startsWith('//')) {
             print('${pkg['name']}: ${f.path}:${i + 1}');
           }
         }
       }
     }
   }
   ```

   El arreglo de la barra final no es decorativo. `package_config.json` guarda los paquetes alojados como `file:///.../flutter_svg-1.1.6` sin barra final, y resolver `lib/` contra eso apunta en silencio a la carpeta padre. La primera versión de este script tenía ese bug y reportaba cero coincidencias para `flutter_svg` 1.1.6. La versión corregida imprime:

   ```text
   flutter_svg: /Users/marius/.pub-cache/hosted/pub.dev/flutter_svg-1.1.6/lib/src/picture_provider.dart:196
   ```

   Para cada paquete que reporte, revisa si una versión más nueva eliminó la llamada. Para `flutter_svg` la respuesta es cualquier 2.x: hice grep sobre 2.0.0 y 2.2.1 y ninguna hace referencia a `describeEnum` (la última versión es 2.3.0). El salto de 1.x a 2.x es una migración en sí misma, porque 2.0 pasó a `vector_graphics` y cambió las APIs de carga, pero es el mismo salto que el código interno de Google tiene que dar antes de que #190076 pueda fusionarse. Si un paquete está abandonado, haz un fork, aplica el paso 2 al fork y apunta una entrada de `dependency_overrides` a tu fork. Verifica: el script no imprime ninguna línea para paquetes de terceros.

6. **Reescribe los diagnósticos para usar `EnumProperty`.**
   Un uso habitual dentro de widgets y render objects era `debugFillProperties`. Una reescritura mecánica a `.name` compila, pero la propiedad tipada es mejor:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   // Before
   properties.add(StringProperty('choice', describeEnum(choice)));

   // After
   properties.add(EnumProperty<ThemeChoice>('choice', choice));
   ```

   La salida es ligeramente distinta. `StringProperty` pone su valor entre comillas, así que DevTools y `toStringDeep()` mostraban `choice: "dark"`, mientras que `EnumProperty` imprime `choice: dark`. Si tienes pruebas golden sobre `toStringDeep()` o `debugDescribeChildren`, actualízalas. Desde Flutter 3.16, `EnumProperty<T>` exige `T extends Enum?`, así que para una clase tipo enum usa `DiagnosticsProperty<Channel>` en su lugar. Verifica: las pruebas de diagnósticos pasan después de regenerar sus strings esperados.

7. **Evita que la obsolescencia vuelva.**
   `deprecated_member_use` es `info` por defecto, y por eso estas llamadas sobrevivieron tres años de obsolescencia. Súbelo de nivel en `analysis_options.yaml`:

   ```yaml
   # Flutter 3.47.4
   include: package:flutter_lints/flutter.yaml

   analyzer:
     exclude:
       - build/**
       - android/**
     errors:
       deprecated_member_use: error
   ```

   Fusiona `errors:` dentro de tu bloque `analyzer:` existente. Cuando agregué una segunda clave `analyzer:` de nivel superior en su lugar, el analizador no se quejó y siguió reportando `info`, así que parecía que el cambio estaba aplicado y no lo estaba. Con el bloque fusionado, `flutter analyze --no-fatal-infos` reporta `error` y termina con código 1. Ten en cuenta que esto sube de nivel todas las obsolescencias, no solo `describeEnum`. Si es demasiado para un solo PR, déjalo en `warning` y haz fallar la CI con `--fatal-warnings`. Verifica: agrega una llamada a `describeEnum` en un archivo temporal y confirma que la CI falla.

## Verificación

Ejecuté las versiones antes y después de cada patrón anterior lado a lado en un solo `flutter test` sobre Flutter 3.47.4:

| Patrón | Resultado de `describeEnum` | Resultado migrado |
| ------- | --------------------- | --------------- |
| Enum simple | `dark` | `dark` |
| Enum mejorado que sobrescribe `toString()` | `high` | `high` |
| Clase tipo enum | `beta` | `beta` |
| Anulable, valor `null` | `null` | `null` |
| Tear-off sobre `values` | `[light, dark]` | `[light, dark]` |
| Valor enum tipado como `Object` | `light` | `light` |
| Ida y vuelta por JSON | `ThemeChoice.dark` | `ThemeChoice.dark` |
| Valor JSON desconocido | `StateError` | `ArgumentError` |
| `debugFillProperties` | `choice: "dark"` | `choice: dark` |

Después de la migración, la lista de verificación es corta: `flutter analyze` queda limpio con `deprecated_member_use: error`, el escaneo de dependencias no imprime nada para paquetes de terceros y la suite de pruebas pasa. Para tener certeza extra, haz checkout de una rama de Flutter con #190076 aplicado y ejecuta `flutter test`. Así es como capturé los mensajes de error de más arriba.

## Plan de reversión

No hay nada que revertir en tu propio código: `.name` y `values.byName` funcionan en todas las versiones de Flutter desde 3.0, así que el código migrado corre en el SDK que tienes hoy y en todos los SDK posteriores a la eliminación. El único paso que puede doler es una actualización mayor de un paquete en el paso 5. Hazla en su propio commit, para poder revertir el cambio de `pubspec.yaml` y `pubspec.lock` por separado y conservar la limpieza de `describeEnum`.

## Trampas

- **`dart fix` no te va a ayudar.** A diferencia de la mayoría de las obsolescencias de Flutter, `describeEnum` no tiene un arreglo basado en datos en `packages/flutter/lib/fix_data`, y la guía de eliminación indica que la migración no está soportada por `dart fix`. Si ejecutas una pasada de `dart fix` sobre todo el repo para otras migraciones, esta sigue siendo manual.
- **No reemplaces `describeEnum(e)` por `e.toString().split('.').last`.** Es la respuesta más común en Stack Overflow, y es incorrecta para los enums mejorados que sobrescriben `toString()`: `Level.high.toString().split('.').last` devuelve `Level(H)`.
- **Código generado.** Si una coincidencia del paso 1 está en un archivo `.g.dart` o `.freezed.dart`, arregla el generador (actualízalo o cambia tu plantilla) y regenera. Editar la salida a mano solo dura hasta la siguiente ejecución de `build_runner`.
- **La documentación dice 3.47, el SDK no.** Si un revisor señala el índice de cambios incompatibles y pregunta por qué 3.47.4 todavía compila, es porque la guía se fusionó antes que el cambio de código. Sigue #190076 para conocer la fecha real. El propio campo "Landed in version" de la guía todavía dice TBD.

## Relacionados

- Si tienes una pila de obsolescencias de Flutter por limpiar de una vez, [ejecutar `dart fix` sobre todo un repo](/es/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) se encarga de todo lo que sí tiene un arreglo basado en datos.
- Otra obsolescencia que requiere una reescritura manual: [reemplazar `groupValue` y `onChanged` obsoletos de `Radio` por `RadioGroup`](/es/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/).
- La migración grande del grafo de dependencias que le llega a toda app Flutter: [pasar a los paquetes independientes `material_ui` y `cupertino_ui`](/es/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- Si el parseo de tus enums vive dentro de la decodificación de JSON, [corregir `FormatException: Unexpected character` en Dart](/es/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) cubre la otra mitad de ese camino de código.

## Fuentes

- [flutter/flutter#190076: Remove deprecated `describeEnum` from framework](https://github.com/flutter/flutter/pull/190076)
- [flutter/flutter#125016: Deprecate `describeEnum`](https://github.com/flutter/flutter/pull/125016)
- [Cambio incompatible en Flutter: Remove describeEnum](https://docs.flutter.dev/release/breaking-changes/remove-describeEnum)
- [Cambio incompatible en Flutter: Migration guide for describeEnum and EnumProperty](https://docs.flutter.dev/release/breaking-changes/describe-enum)
- [Referencia de la API de `describeEnum`](https://api.flutter.dev/flutter/foundation/describeEnum.html)
- [Referencia de la API de `EnumProperty`](https://api.flutter.dev/flutter/foundation/EnumProperty-class.html)
- [Lenguaje Dart: Enumerated types](https://dart.dev/language/enums)
- [Changelog del SDK de Dart, 2.15.0](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [flutter_svg en pub.dev](https://pub.dev/packages/flutter_svg)
