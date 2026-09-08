---
title: "Cómo ejecutar dart fix en todo un repositorio para aplicar las migraciones de cambios incompatibles de Flutter"
description: "dart fix acepta un solo directorio destino y ese directorio puede ser la raíz del repositorio: el analizador abre un contexto por cada pubspec.yaml anidado y migra todos los paquetes en una sola pasada. Aquí está la superficie completa de flags, las cuatro cosas que silencian las correcciones y hacen que un repo sucio informe Nothing to fix, por qué el código de salida es inútil en CI, y un caso donde una transformación de Flutter genera código que no compila."
pubDate: 2026-09-08
template: how-to
tags:
  - "flutter"
  - "dart"
  - "migration"
  - "tooling"
  - "how-to"
lang: "es"
translationOf: "2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations"
translatedBy: "claude"
translationDate: 2026-09-08
---

`dart fix --apply` acepta un único directorio destino, y ese directorio puede ser la raíz de tu repositorio. El analizador abre un contexto de análisis por cada `pubspec.yaml` anidado debajo, así que un monorepo con una docena de paquetes se migra con un solo comando, respetando el `analysis_options.yaml` propio de cada paquete. La razón por la que una ejecución sobre todo el repo tantas veces imprime `Nothing to fix!` en una base de código visiblemente llena de advertencias de obsolescencia no es que la herramienta esté rota: cuatro cosas sin relación entre sí silencian las correcciones, y `dart fix` sale con 0 en todos esos casos. Tampoco existe un comando `flutter fix`, pese a la página de documentación llamada Flutter fix. Todo lo que sigue se ejecutó en Flutter 3.44.8 con Dart 3.12.2; la superficie del comando y las interioridades citadas aquí no cambian en la rama main del SDK de Dart que alimenta la línea estable actual, Flutter 3.47.

## Toda la superficie del comando son cuatro flags

Antes de diseñar un flujo de trabajo para todo el repo alrededor de esta herramienta conviene saber lo poco que hay:

```console
$ dart fix --help
Apply automated fixes to Dart source code.

This tool looks for and fixes analysis issues that have associated automated fixes.

To use the tool, run either 'dart fix --dry-run' for a preview of the proposed changes for a project, or 'dart fix --apply' to apply the changes.

Usage: dart fix [arguments]
-h, --help                      Print this usage information.
-n, --dry-run                   Preview the proposed changes but make no changes.
    --apply                     Apply the proposed changes.
    --code=<code1,code2,...>    Apply fixes for one (or more) diagnostic codes.
```

Eso es todo. Existen dos flags ocultos en `pkg/dartdev/lib/src/commands/fix.dart` (`--compare-to-golden`, para las pruebas del propio SDK, y `--use-aot-snapshot`), y ninguno te sirve. No hay `--exclude`, no hay soporte de globs, no hay argumento de múltiples rutas. Exactamente un destino posicional, un archivo o un directorio, que por defecto es el directorio actual. Si no pasas ni `--apply` ni `--dry-run`, o pasas ambos, el comando imprime el uso y devuelve 0 sin hacer nada.

Lo otro que conviene comprobar temprano:

```console
$ flutter fix --dry-run
Could not find a command named "fix".
```

La página de documentación [Flutter fix](https://docs.flutter.dev/tools/flutter-fix) describe una funcionalidad, no un comando. Tú ejecutas `dart fix`, y mientras el `dart` de tu `PATH` sea el que viene con el SDK de Flutter (`$FLUTTER_ROOT/bin/dart`), resuelve los datos de migración del framework automáticamente.

## Una sola ejecución en la raíz cubre todos los paquetes anidados

Esta es la parte que la mayoría de los equipos hace mal, normalmente escribiendo un bucle con `find` antes de comprobar si hace falta. Toma un pub workspace con tres miembros:

```yaml
# pubspec.yaml at the repo root, Dart 3.12.2
name: mono_root
environment:
  sdk: ^3.12.0
workspace:
  - packages/pkg_a
  - packages/pkg_b
  - apps/app
```

Un comando en la raíz, un informe que cubre los tres:

```console
$ dart fix --dry-run
Computing fixes in mono (dry run)...

6 proposed fixes in 3 files.

apps/app/lib/main.dart
  prefer_const_constructors - 1 fix
  prefer_final_locals - 1 fix

packages/pkg_a/lib/a.dart
  prefer_const_constructors - 1 fix
  prefer_final_locals - 1 fix

packages/pkg_b/lib/b.dart
  prefer_const_constructors - 1 fix
  prefer_final_locals - 1 fix
```

Esto no es una funcionalidad de los workspaces. Dos paquetes hermanos sin ningún `pubspec.yaml` raíz reciben el mismo tratamiento, porque el analizador descubre las raíces de contexto recorriendo el árbol de directorios en busca de archivos `pubspec.yaml` y `analysis_options.yaml`. Cada paquete conserva su propia configuración de lints durante esa única ejecución, así que un paquete que activa `prefer_final_locals` recibe esas correcciones mientras su vecino no.

`dart fix` además itera. `FixCommand.maxPasses` vale 4, y vuelve a ejecutar todo el cálculo hasta que no se produzcan más ediciones o hasta alcanzar ese tope. El efecto se ve en una sola sentencia: `var b = Box(1);` se convierte en `final b = const Box(1);`, lo que requiere que `prefer_final_locals` y `prefer_const_constructors` se disparen en pasadas distintas sobre la misma línea.

## Por qué un paquete informa "Nothing to fix!" cuando está lleno de APIs obsoletas

Cuatro mecanismos distintos producen la misma salida y el mismo código de salida. Descártalos en este orden.

**El paquete no está resuelto.** `dart fix` necesita un `.dart_tool/package_config.json` para saber qué significa `package:lib_pkg/api.dart`, y sin él no hay diagnóstico `deprecated_member_use` al que asociar una corrección. Mismo repositorio, mismo archivo, antes y después de un `pub get`:

```console
$ dart fix --dry-run          # no pub get yet
Computing fixes in app (dry run)...
Nothing to fix!

$ dart pub get && dart fix --dry-run
Computing fixes in app (dry run)...

1 proposed fix in 1 file.

lib/main.dart
  deprecated_member_use - 1 fix
```

En un monorepo este es el culpable habitual: CI resolvió la app pero no los seis paquetes hoja, así que la migración cubre en silencio una fracción del árbol.

**Los archivos están excluidos del análisis.** Una lista `exclude`, normalmente añadida hace años para mantener el código generado fuera del informe de lints, también saca esos archivos del conjunto de correcciones:

```yaml
# analysis_options.yaml
analyzer:
  exclude:
    - lib/main.dart
```

```console
$ dart fix --dry-run
Nothing to fix!
```

**El diagnóstico está degradado a `ignore`.** Este es el más dañino, porque es la maniobra estándar cuando una actualización de Flutter inunda CI con advertencias de obsolescencia:

```yaml
analyzer:
  errors:
    deprecated_member_use: ignore
```

Silenciar la advertencia también desactiva la migración automática correspondiente. Si tu repo tiene esta línea, quítala antes de ejecutar `dart fix`, no después.

**La línea lleva un comentario `// ignore:`.** El mismo efecto, con granularidad de archivo o de línea. Un `// ignore_for_file: deprecated_member_use` al principio de un archivo de widgets grande hace que `dart fix` se salte el archivo entero sin decir nada.

Para las correcciones que vienen de lints hay un quinto caso que es de diseño y no una trampa: una corrección solo existe si el lint está activado. `--code` no anula eso.

```console
$ dart fix --dry-run --code=prefer_final_locals   # lint not in analysis_options.yaml
Nothing to fix!
```

Añade la regla y el mismo comando encuentra la corrección. Eso da un patrón útil de un solo uso: activa temporalmente un lint de limpieza, ejecuta `dart fix --apply --code=<ese lint>` y luego decide si conservas la regla activada.

Ninguno de estos cinco casos cambia el estado de salida. Cada ejecución de arriba devolvió 0. La única invocación que devuelve algo distinto de cero es un código de diagnóstico desconocido:

```console
$ dart fix --apply --code=this_is_not_a_real_code
Computing fixes in app...
Unable to compute fixes: The diagnostic 'this_is_not_a_real_code' is not defined by the analyzer.
$ echo $?
3
```

Lo cual vale la pena saber, porque significa que un error de tipeo en un script de CI falla de forma ruidosa en lugar de saltarse la migración.

## Ejecutarlo en todo el repositorio, en orden

1. **Actualiza el SDK y luego quita los silenciadores.** Las transformaciones de obsolescencia solo existen para APIs que el analizador puede ver como obsoletas, así que `flutter upgrade` va primero. Después busca `deprecated_member_use: ignore` en cada `analysis_options.yaml` y `ignore_for_file: deprecated_member_use` en `lib/`, y bórralos. Sáltate esto y los pasos 3 y 4 informarán de un repo limpio.

2. **Resuelve cada paquete.** Dentro de un pub workspace, un solo `dart pub get` en cualquier parte resuelve todo (ejecutarlo en un paquete miembro imprime `Resolving dependencies in /path/to/root` y escribe el `.dart_tool` de la raíz). Fuera de un workspace, cada paquete con su propia resolución necesita su propio `pub get`.

3. **Ejecuta una vez en la raíz y lee el informe.** `dart fix --dry-run` desde la raíz del repositorio, y comprueba que la lista de archivos menciona todos los paquetes que esperas. Un paquete ausente del informe es un paquete que falló el paso 2 o que está excluido del análisis, no uno limpio.

4. **Recurre a un bucle por paquete solo si el paso 3 se quedó corto.** Para repos donde los paquetes no se pueden resolver desde un solo sitio, esto lo cubre todo y es idempotente:

   ```bash
   #!/usr/bin/env bash
   # tool/dart_fix_repo.sh - Flutter 3.44.8, Dart 3.12.2
   set -euo pipefail

   find . -name pubspec.yaml \
     -not -path '*/.*' \
     -not -path '*/build/*' \
     -not -path '*/ephemeral/*' \
     -print | while read -r manifest; do
       pkg=$(dirname "$manifest")
       echo "==> $pkg"
       ( cd "$pkg" && dart pub get >/dev/null && dart fix --apply "$@" )
     done

   dart format .
   ```

   Los filtros `-not -path` importan: `build/` y los directorios `ephemeral/` bajo `windows/`, `linux/` y `macos/` contienen archivos `pubspec.yaml` generados que no quieres tocar. Si ya usas [Melos](https://melos.invertase.dev/), `melos exec -- "dart pub get && dart fix --apply"` hace lo mismo con los flags de filtrado que ya tienes configurados.

5. **Formatea, luego analiza, luego ejecuta las pruebas.** En ese orden, y no te saltes lo último. Los detalles están más abajo.

## Un diagnóstico por commit

Un diff de `dart fix --apply` sobre 400 archivos es irrevisable. `--code` acepta una lista separada por comas, así que divide la ejecución en commits que un humano pueda leer de verdad:

```bash
dart fix --apply --code=deprecated_member_use
git commit -am "chore: apply Flutter deprecation migrations via dart fix"

dart fix --apply --code=prefer_const_constructors,prefer_const_literals_to_create_immutables
git commit -am "chore: const cleanup via dart fix"
```

El informe de la ejecución en seco imprime los comandos exactos para los códigos que encontró, lo que hace barato planificar esto.

## De dónde salen las migraciones

Las correcciones de obsolescencia son datos, no lógica del compilador. Un paquete las declara en `lib/fix_data.yaml`, y el analizador las recoge de cualquier dependencia resuelta. En Flutter 3.44.8 el framework incluye 30 archivos así bajo `packages/flutter/lib/fix_data/`, con 381 transformaciones, más 8 en `flutter_test`, 2 en `flutter_driver` y 1 en `integration_test`. Los tipos de cambio, por frecuencia en `package:flutter`: 418 `removeParameter`, 228 `addParameter`, 204 `fragment`, 158 `rename`, 90 `renameParameter`, 16 `import`, 12 `addTypeParameter`, 11 `replacedBy`, 1 `changeParameterType`.

El mismo mecanismo está disponible para tus propios paquetes internos, que es lo de mayor apalancamiento en este artículo si mantienes un design system compartido. Marca el miembro viejo como obsoleto y luego describe la reescritura:

```dart
// lib_pkg/lib/api.dart
class Report {
  @Deprecated('Use render() instead. Removed in lib_pkg 3.0.0.')
  String toHtml() => render();
  String render() => '<html/>';
}
```

```yaml
# lib_pkg/lib/fix_data.yaml - Dart 3.12.2
version: 1
transforms:
  - title: "Rename to 'render'"
    date: 2026-09-01
    element:
      uris: ['api.dart']
      method: 'toHtml'
      inClass: 'Report'
    changes:
      - kind: 'rename'
        newName: 'render'
```

Cada consumidor que ejecute `dart fix --apply` tras subir la dependencia obtiene `r.toHtml()` reescrito a `r.render()`. La lista `uris` debe contener la ruta de la biblioteca pública que importan los consumidores, no el archivo bajo `src/` donde se declara la clase. Ese único detalle es la razón más común de que un `fix_data.yaml` escrito a mano no haga nada.

## dart fix no es un compilador, y te entregará código que no compila

Por esto el paso 5 de arriba termina en analizar y probar en lugar de en hacer commit. Un widget mínimo que usa dos APIs obsoletas de Flutter:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'package:flutter/material.dart';

class Card1 extends StatelessWidget {
  const Card1({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.black.withOpacity(0.5),
      child: ListView(
        cacheExtent: 250.0,
        children: const [Text('hi')],
      ),
    );
  }
}
```

`dart fix --apply` informa `deprecated_member_use - 2 fixes` y reescribe las dos. La transformación de `withOpacity` es correcta. La de `cacheExtent` no:

```dart
color: Colors.black.withValues(alpha: 0.5),
child: ListView(
  scrollCacheExtent: ScrollCacheExtent.pixels(250.0), children: const [Text('hi')],
),
```

```console
$ flutter analyze
error - Undefined name 'ScrollCacheExtent'. Try correcting the name to one that is defined,
        or defining the name - lib/main.dart:11:28 - undefined_identifier
```

`ScrollCacheExtent` está declarado en `packages/flutter/lib/src/rendering/viewport.dart` y solo se exporta desde `package:flutter/rendering.dart`. Ni `material.dart` ni `widgets.dart` lo reexportan, y la transformación en `fix_widgets.yaml` usa `addParameter` sin un cambio `import` que la acompañe. La reescritura es semánticamente correcta y el archivo ya no compila. Añadir `import 'package:flutter/rendering.dart';` lo arregla, y `flutter analyze` queda en verde.

Ese modo de fallo se generaliza. `dart fix` edita rangos de tokens descritos en YAML; no verifica tipos del resultado, y no tiene ni idea de si el símbolo que acaba de escribir está en ámbito. Los cambios de comportamiento son peores que los errores de compilación aquí, porque nada los detecta, que es la misma razón por la que la [separación de los paquetes Material y Cupertino](/es/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/) y la [reescritura de Radio a RadioGroup](/es/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/) necesitan una ejecución de pruebas después de la pasada automática, no solo un analyze.

Un consuelo: un archivo con un error de sintaxis no envenena la ejecución. `dart fix` sigue calculando y aplicando correcciones en todos los demás archivos del mismo paquete.

## Sigue siempre con dart format

La herramienta aplica ediciones, no reformatea el resultado. Fíjate dónde acabó `children` arriba. `dart format .` lo restaura:

```dart
child: ListView(
  scrollCacheExtent: ScrollCacheExtent.pixels(250.0),
  children: const [Text('hi')],
),
```

Pon el paso de formateo en el mismo commit que la corrección, porque si no el editor de la siguiente persona lo hará y el blame queda peor.

## Ponerle una barrera en CI

Como el código de salida siempre es 0, una comprobación de CI tiene que mirar el árbol de trabajo en su lugar. Aplica las correcciones y deja que git decida:

```yaml
# .github/workflows/analyze.yml
- run: dart pub get
- run: dart fix --apply
- run: git diff --exit-code
```

Verificado en local: con una corrección pendiente commiteada en la rama, `git diff --exit-code` devuelve 1 y el job falla; sin nada que corregir, devuelve 0. Combínalo con una matriz si [compilas contra más de una versión de Flutter](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), ya que las transformaciones disponibles difieren por SDK y una corrección que está pendiente en 3.47 puede no existir en 3.44.

El flujo de trabajo que de verdad aguanta en una base de código de varios años es aburrido: actualiza el SDK, borra los silenciadores, resuelve todo, haz la ejecución en seco en la raíz, aplica un código de diagnóstico a la vez, formatea, analiza, prueba, commitea. Las 392 transformaciones del framework harán la mayor parte del tecleo. La parte que no pueden hacer es aquella en la que tú lees el diff.

## Relacionado

- [Migra las importaciones de Material y Cupertino de Flutter a los paquetes material_ui y cupertino_ui](/es/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/)
- [Migra una app web de Flutter de dart:html a package:web y dart:js_interop](/es/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/)
- [Cómo reemplazar groupValue y onChanged obsoletos de Radio en Flutter con RadioGroup](/es/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/)
- [Migra una app Flutter 2 a Flutter 3.x: la lista de null safety](/es/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)
- [Cómo apuntar a múltiples versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)

## Fuentes

- [dart fix](https://dart.dev/tools/dart-fix), documentación de la herramienta Dart
- [Flutter fix](https://docs.flutter.dev/tools/flutter-fix), documentación de la herramienta Flutter
- [Breaking changes and migration guides](https://docs.flutter.dev/release/breaking-changes), documentación de releases de Flutter
- [`pkg/dartdev/lib/src/commands/fix.dart`](https://github.com/dart-lang/sdk/blob/main/pkg/dartdev/lib/src/commands/fix.dart), SDK de Dart
- [`pkg/dartdev/doc/dart-fix.md`](https://github.com/dart-lang/sdk/blob/main/pkg/dartdev/doc/dart-fix.md), SDK de Dart
- [Data driven fixes](https://dart.dev/go/data-driven-fixes), especificación de Dart para `fix_data.yaml`
- [Pub workspaces](https://dart.dev/tools/pub/workspaces), documentación de gestión de paquetes de Dart
- [Customizing static analysis](https://dart.dev/tools/analysis), documentación del analizador de Dart
