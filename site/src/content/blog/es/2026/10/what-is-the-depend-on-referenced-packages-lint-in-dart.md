---
title: "Qué es el lint depend_on_referenced_packages en Dart y por qué se dispara con importaciones transitivas"
description: "depend_on_referenced_packages se dispara cuando un archivo importa o exporta un paquete que no está en tu propio pubspec.yaml, aunque se resuelva a través de otra dependencia. Esto es exactamente lo que comprueba la regla en Dart 3.12.2 y Flutter 3.44.8, por qué las importaciones transitivas son un bug real y cómo corregir cada variante."
pubDate: 2026-10-24
tags:
  - "dart"
  - "flutter"
  - "lints"
  - "pub"
  - "pubspec"
lang: "es"
translationOf: "2026/10/what-is-the-depend-on-referenced-packages-lint-in-dart"
translatedBy: "claude"
translationDate: 2026-10-24
---

**Respuesta corta:** `depend_on_referenced_packages` reporta cualquier `import` o `export` de `package:foo/...` donde `foo` no esté listado en el `pubspec.yaml` del propio paquete que importa. No le importa que `foo` se resuelva sin problemas porque una de tus dependencias lo trae consigo: un paquete transitivo es algo que estás tomando prestado, con una versión que no controlas y una presencia que no puedes garantizar. Corrígelo declarando tú mismo el paquete (`dart pub add foo` o `flutter pub add foo`), bajo `dependencies` si la importación vive en `lib/`, `bin/`, `hook/build.dart` o `hook/link.dart`, y bajo `dev_dependencies` solo si vive en cualquier otro lugar, como `test/` o `tool/`. Todo lo que sigue se midió en Dart 3.12.2 y Flutter 3.44.8 con `lints` 6.1.0 y `flutter_lints` 6.0.0.

La regla existe desde Dart 2.14 y forma parte del conjunto **core** de [`package:lints`](https://pub.dev/packages/lints), lo que significa que tanto `lints/recommended.yaml` como `flutter_lints` la activan. La mayoría de la gente la conoce la primera vez que escribe `import 'package:collection/collection.dart';` en una app Flutter recién creada y recibe un subrayado azul en una línea que compila y se ejecuta perfectamente.

## Por qué se marca una importación que funciona

Cuando ejecutas `flutter pub get`, pub resuelve todo el grafo de dependencias y escribe cada paquete de él en `.dart_tool/package_config.json`. El compilador y el analizador resuelven los URI `package:` a través de ese archivo, y este contiene también tus dependencias transitivas. Por eso `package:http_parser` se resuelve en un proyecto que solo depende de `http`: `http` depende de `http_parser`, así que está en la configuración de paquetes.

La importación funciona hoy por accidente. Tres cosas pueden romperla más adelante, y ninguna aparece en tu diff:

1. **El intermediario la elimina.** Si `http` 2.0 deja de depender de `http_parser`, tu próximo `pub upgrade` lo quita del grafo y tu compilación falla con `Target of URI doesn't exist`. Nada cambió en tu `pubspec.yaml`.
2. **Nunca elegiste la versión.** Tu código está escrito contra la versión de `http_parser` que la restricción de `http` haya permitido. Un salto de versión mayor en el paquete transitivo que `http` tolera es un cambio incompatible para ti, sin ninguna restricción tuya que lo impida.
3. **Tus consumidores no lo reciben.** Si publicas un paquete, los usuarios resuelven su propio grafo. Las dependencias de desarrollo nunca son transitivas, así que todo lo que tu código de `lib/` importe desde una dependencia de desarrollo simplemente no existe para ellos.

El lint convierte esos tres fallos latentes en un único diagnóstico informativo visible en el punto de la importación. La [página oficial de la regla](https://dart.dev/tools/linter-rules/depend_on_referenced_packages) la resume como "Depend on referenced packages", y el razonamiento es que una dependencia explícita es la única forma de garantizar que el paquete esté presente y, a la vez, poner tu propia restricción de versión sobre él.

## Qué comprueba realmente la regla

La implementación es corta y vale la pena leerla: [`pkg/linter/lib/src/rules/pub/depend_on_referenced_packages.dart`](https://github.com/dart-lang/sdk/blob/main/pkg/linter/lib/src/rules/pub/depend_on_referenced_packages.dart) en el SDK de Dart. Para cada biblioteca construye una lista de nombres de paquete permitidos:

- el `name` del propio paquete (así que las autoimportaciones `package:my_app/...` siempre están bien),
- cada clave bajo `dependencies`,
- cada clave bajo `dev_dependencies`, **pero solo si el archivo no está en una ubicación pública**.

Un archivo cuenta como público cuando está dentro de `lib/` o `bin/`, o es exactamente `hook/build.dart` o `hook/link.dart` (los hooks de compilación de native assets, añadidos a raíz de [dart-lang/sdk#54334](https://github.com/dart-lang/sdk/issues/54334)). Luego visita cada directiva `import` y `export`, toma el primer segmento de ruta después de `package:` y lo reporta si el nombre no está en la lista de permitidos.

Algunas consecuencias se derivan directamente de ese código:

- `dependency_overrides` no se consulta. Un paquete que solo aparece ahí sigue siendo "no una dependencia".
- Las directivas `export` se comprueban exactamente igual que las importaciones.
- Solo se comprueba el URI principal de una directiva, no los URI dentro de las cláusulas condicionales `if (dart.library.io) ...`.
- La única excepción codificada es `flutter_gen`, el antiguo paquete sintético de localización (consulta [dart-lang/linter#3308](https://github.com/dart-lang/linter/issues/3308)).
- No hay herencia desde el paquete raíz ni desde el workspace. Cada paquete se comprueba contra su propio pubspec.

## Un caso mínimo que dispara todas las variantes

Aquí hay un pequeño paquete de Dart puro que depende solo de `http` y mantiene `meta` como dependencia de desarrollo:

```yaml
# pubspec.yaml -- Dart 3.12.2
name: repro
version: 1.0.0

environment:
  sdk: ^3.12.0

dependencies:
  http: ^1.6.0

dev_dependencies:
  lints: ^6.1.0
  meta: ^1.18.0

dependency_overrides:
  path: ^1.9.1
```

```yaml
# analysis_options.yaml
include: package:lints/recommended.yaml
```

```dart
// lib/repro.dart -- Dart 3.12.2
import 'package:http/http.dart' as http;          // declared: OK
import 'package:http_parser/http_parser.dart';   // transitive via http: LINT
import 'package:meta/meta.dart';                 // dev_dependency in lib/: LINT
import 'package:repro/src/helpers.dart';         // self package: OK
export 'package:async/async.dart' show Result;   // transitive export: LINT

@immutable
class Probe {
  const Probe();

  Future<MediaType> contentType(Uri uri) async {
    final response = await http.head(uri);
    return MediaType.parse(response.headers['content-type'] ?? 'text/plain');
  }
}

final helper = helperValue;
```

Agrega el mismo `import 'package:meta/meta.dart';` a `bin/repro.dart`, `hook/build.dart`, `tool/gen.dart` y `test/repro_test.dart`, importa `package:http_parser` también desde el test, e importa `package:path` (solo override) desde `lib/src/over.dart`. `dart analyze` reporta:

```text
info - bin/repro.dart:1:8 - The imported package 'meta' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - hook/build.dart:1:8 - The imported package 'meta' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/repro.dart:2:8 - The imported package 'http_parser' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/repro.dart:3:8 - The imported package 'meta' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/repro.dart:5:8 - The imported package 'async' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/src/over.dart:1:8 - The imported package 'path' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - test/repro_test.dart:2:8 - The imported package 'http_parser' isn't a dependency of the importing package. ... - depend_on_referenced_packages
```

Fíjate en lo que falta: `tool/gen.dart` y la importación de `meta` en `test/` están limpios, porque las dependencias de desarrollo se permiten fuera de las ubicaciones públicas. Fíjate también en que el mensaje es el mismo tanto si el paquete está ausente como si simplemente está en la sección equivocada. "Isn't a dependency" puede significar "es una dependencia de desarrollo y este archivo es público".

## La versión de Flutter de lo mismo

En una app Flutter, los paquetes transitivos que es más probable que importes por accidente son los que el propio SDK necesita: `collection`, `meta`, `vector_math`, `characters`, `material_color_utilities`. Siempre están en el grafo porque `flutter` los requiere. Una app nueva creada con `flutter create --empty` con este archivo:

```dart
// lib/probe.dart -- Flutter 3.44.8
import 'package:collection/collection.dart';
import 'package:meta/meta.dart';
import 'package:vector_math/vector_math_64.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
```

obtiene cuatro avisos informativos de `depend_on_referenced_packages`. `flutter_localizations` además recibe un error duro `uri_does_not_exist`, porque es un paquete del SDK independiente que no está en el grafo hasta que lo pides. El lint es el más amable de los dos diagnósticos, pero el problema de fondo es idéntico.

## Cómo corregirlo, caso por caso

1. **Paquete transitivo importado desde `lib/`.** Decláralo como dependencia normal. Deja que pub elija la restricción en lugar de adivinarla:

   ```bash
   # Flutter 3.44.8
   flutter pub add collection meta vector_math
   ```

   ```yaml
   dependencies:
     collection: ^1.19.1
     flutter:
       sdk: flutter
     meta: ^1.18.0
     vector_math: ^2.2.0
   ```

2. **Paquete del SDK como `flutter_localizations`.** Estos necesitan la forma `sdk: flutter`, que `pub add` acepta como descriptor JSON:

   ```bash
   flutter pub add 'flutter_localizations:{"sdk":"flutter"}'
   ```

3. **Dependencia de desarrollo importada desde `lib/`, `bin/` o un hook de compilación.** O la mueves a `dependencies` (`dart pub add meta` la mueve por ti), o sacas el código que la importa del directorio público. Para paquetes que solo aportan anotaciones, como `meta`, moverlo a `dependencies` es lo correcto: de lo contrario, un paquete publicado con `@immutable` en `lib/` no compila para quienes lo consumen.

4. **Paquete que solo existe en `dependency_overrides`.** Un override cambia la versión de algo que ya está en el grafo; no declara una dependencia. Agrega también una entrada normal y conserva el override si todavía lo necesitas.

5. **Paquete exportado desde tu biblioteca.** Misma corrección que para una importación. Si reexportas el `Result` de `package:async`, tu API pública ahora depende de la versión de `async`, que es exactamente la razón por la que quieres tu propia restricción sobre él.

No hay un `dart fix` para esta regla; en el caso mínimo, `dart fix --dry-run` reporta "Nothing to fix!". La corrección rápida del IDE agrega el paquete a `pubspec.yaml`, y `pub add` hace lo mismo desde la terminal.

## Trampas y casos límite

### El SDK de Flutter fija tu restricción

Paquetes como `meta` y `collection` están fijados a versiones exactas por `flutter` y `flutter_test`. Si escribes una restricción por encima de la versión fijada, la resolución falla:

```text
Note: meta is pinned to version 1.18.0 by flutter_test from the flutter SDK.

Because every version of flutter_test from sdk depends on meta 1.18.0 and fapp depends on meta ^1.19.0, flutter_test from sdk is forbidden.
So, because fapp depends on flutter_test from sdk, version solving failed.
```

Por eso `flutter pub add` es mejor que escribir la restricción a mano: elige la versión que satisface la fijación. Si ya te topaste con este error, la guía sobre [cómo corregir "version solving failed" en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/) explica cómo leer la salida del solucionador. Espera que tu `pubspec.lock` cambie bastante cuando después cambies de versión de Flutter, ya que las fijaciones se mueven con el SDK; [esta explicación sobre pubspec.lock](/es/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/) cubre el motivo.

### Los workspaces de pub no heredan dependencias

Con un workspace de pub de Dart 3.6+, todos los miembros comparten una resolución y un `package_config.json`, así que un miembro puede importar cualquier cosa de la que dependa otro miembro. El lint no lo permite. Un `pubspec.yaml` raíz con `http` en sus `dependencies` y un miembro `pkgs/app` con `resolution: workspace` y sin dependencias sigue produciendo:

```text
info - pkgs/app/lib/app.dart:1:8 - The imported package 'http' isn't a dependency of the importing package. ... - depend_on_referenced_packages
```

Este es el comportamiento que quieres en un monorepo. La resolución compartida facilita tomar prestado entre paquetes sin querer, y el lint es lo que impide que un paquete dependa en silencio de la lista de dependencias de otro. Si el servidor de análisis va lento en un workspace grande, es un problema aparte; consulta [cómo acelerar el servidor de análisis de Dart en un monorepo grande de Flutter](/es/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/).

### Las importaciones condicionales se cuelan

La regla solo comprueba el URI primario de una directiva. Esto pasa el lint aunque `path` no esté declarado:

```dart
// lib/src/cond.dart -- Dart 3.12.2
import 'package:repro/src/helpers.dart'
    if (dart.library.io) 'package:path/path.dart';
```

`dart pub publish --dry-run` tampoco lo marcó en Dart 3.12.2. Trata las importaciones condicionales por plataforma como algo que se revisa a mano en la revisión de código.

### `dart pub publish` aplica la misma regla como error

Para los paquetes publicados, el validador propio de pub ejecuta una versión más estricta de esta comprobación. En el caso mínimo, `dart pub publish --dry-run` convirtió los hallazgos de lib, bin y hook en errores duros:

```text
* line 3, column 1 of lib/repro.dart: meta is in the `dev_dependencies` section of `pubspec.yaml`. Packages used in lib/ must be declared in the `dependencies` section.
* line 2, column 1 of lib/repro.dart: This package does not have http_parser in the `dependencies` section of `pubspec.yaml`.
```

El hallazgo en `test/` solo aparece como advertencia. Así que ignorar el lint en un paquete que publicas solo traslada el fallo al día del lanzamiento.

### `flutter_gen` está exento, pero va camino de desaparecer

La excepción de `flutter_gen` existe porque `flutter gen-l10n` solía generar un paquete sintético que no podía aparecer en ningún pubspec. Flutter ha dejado obsoleto ese paquete sintético (consulta el [aviso de cambio incompatible](https://docs.flutter.dev/release/breaking-changes/flutter-generate-i10n-source)); las localizaciones generadas ahora viven en tu propio árbol de código fuente y se importan a través del nombre de tu propio paquete, algo que el lint ya permite.

### No lo silencies "solo para un paquete de desarrollo"

Una petición común es poner en una lista blanca, en `analysis_options.yaml`, un paquete de anotaciones solo para desarrollo. [dart-lang/sdk#60026](https://github.com/dart-lang/sdk/issues/60026) pidió exactamente eso y se cerró sin la funcionalidad. La respuesta del mantenedor fue que un paquete importado desde `lib/` es una dependencia real, y que los comentarios `// ignore:` están disponibles si insistes. Si de verdad debes hacerlo, limita la supresión a la línea en lugar de al proyecto:

```dart
// ignore: depend_on_referenced_packages
import 'package:meta/meta.dart';
```

Desactivar la regla globalmente (`depend_on_referenced_packages: false` bajo `linter: rules:`) también apaga la única alerta temprana que recibes antes de que fallen pub o la compilación de un consumidor. La configuración de lints en general es más fácil de razonar cuando sabes exactamente dónde mira cada regla; la [comparación entre unawaited_futures y discarded_futures](/es/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/) es un buen ejemplo de dos reglas cuyos alcances son más estrechos de lo que sugieren sus nombres.

## Lee a continuación

- [Fix: Version solving failed in pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Fix: pubspec.lock shows as modified after flutter upgrade or switching Flutter versions](/es/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/)
- [unawaited_futures vs discarded_futures in Dart](/es/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/)
- [How to run dart fix across a whole repo to apply Flutter breaking-change migrations](/es/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/)
- [How to speed up a slow Dart analysis server in VS Code for a large Flutter monorepo](/es/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/)

## Fuentes

- [Página de la regla depend_on_referenced_packages](https://dart.dev/tools/linter-rules/depend_on_referenced_packages) y [página del diagnóstico](https://dart.dev/tools/diagnostics/depend_on_referenced_packages)
- [Implementación de la regla en dart-lang/sdk](https://github.com/dart-lang/sdk/blob/main/pkg/linter/lib/src/rules/pub/depend_on_referenced_packages.dart) y [sus pruebas](https://github.com/dart-lang/sdk/blob/main/pkg/linter/test/rules/depend_on_referenced_packages_test.dart)
- [Conjunto de reglas core de package:lints](https://pub.dev/packages/lints)
- [dart-lang/sdk#60026: exentar las dependencias de desarrollo](https://github.com/dart-lang/sdk/issues/60026)
- [dart-lang/linter#3308: excepción de flutter_gen](https://github.com/dart-lang/linter/issues/3308)
- [Fijación de versiones del SDK](https://dart.dev/go/sdk-version-pinning)
- [Cambio incompatible de Flutter: código fuente de generate l10n](https://docs.flutter.dev/release/breaking-changes/flutter-generate-i10n-source)
