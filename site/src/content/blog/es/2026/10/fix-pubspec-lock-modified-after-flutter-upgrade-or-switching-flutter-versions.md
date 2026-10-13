---
title: "Solución: pubspec.lock aparece como modificado después de flutter upgrade o de cambiar de versión de Flutter"
description: "El SDK de Flutter fija versiones de meta, vector_math, test_api y matcher, así que cada cambio de SDK vuelve a resolver tu lockfile, y flutter upgrade ejecuta pub upgrade en el proyecto donde estás parado. Fija una versión de Flutter por repositorio y haz cumplir el lockfile en CI."
pubDate: 2026-10-13
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-3-47"
  - "dart"
  - "pub"
lang: "es"
translationOf: "2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions"
translatedBy: "claude"
translationDate: 2026-10-13
---

Tu `pubspec.lock` cambia porque el SDK de Flutter es en sí mismo una dependencia con sus propias versiones fijadas. `flutter` y `flutter_test` exigen versiones exactas de paquetes como `meta`, `vector_math`, `test_api` y `matcher`, así que un SDK distinto obliga a pub a volver a resolverlas, y el `flutter run` o `flutter build` que sigue a un cambio de SDK ejecuta `pub get` por ti. Además, `flutter upgrade` ejecuta `pub upgrade` en el proyecto donde estés parado. La solución: fija una versión de Flutter por repositorio (FVM más una restricción `environment: flutter:`), haz commit del cambio del lockfile de una actualización de SDK por separado, y ejecuta `flutter pub get --enforce-lockfile` en CI. Todo lo que sigue se midió en Flutter 3.44.8 (Dart 3.12.2) y Flutter 3.47.7 (Dart 3.13.5) el 2026-10-13.

## El síntoma en contexto

No tocaste `pubspec.yaml`. Ejecutaste `flutter upgrade`, cambiaste de canal, o un compañero con otra versión de Flutter hizo push, y ahora `git status` muestra esto:

```text
 M pubspec.lock
```

El diff solo toca paquetes transitivos que tú nunca agregaste:

```diff
   meta:
     dependency: transitive
     description:
       name: meta
-      sha256: "1741988757a65eb6b36abe716829688cf01910bbf91c34354ff7ec1c3de2b349"
+      sha256: "307249ce4ff29d58a18e97f6345f539382eb9c9c29ecda628900f31de0443dd9"
       url: "https://pub.dev"
     source: hosted
-    version: "1.18.0"
+    version: "1.19.0"
```

Vuelve al SDK anterior y ejecuta cualquier cosa que dispare `pub get`, y el diff se invierte. En un equipo con versiones de Flutter mezcladas, el lockfile rebota de un lado a otro en cada pull request.

## Por qué ocurre

Hay tres mecanismos distintos, y la mayoría de los equipos se topa con los tres.

**1. El SDK de Flutter fija sus propias dependencias.** `packages/flutter/pubspec.yaml` y `packages/flutter_test/pubspec.yaml` del SDK listan versiones exactas. Tu aplicación depende de ambos mediante `sdk: flutter`, así que sus pins se convierten en restricciones sobre tu resolución. Cuando el SDK cambia, los pins cambian, las versiones de tu lockfile dejan de satisfacerlos y pub tiene que elegir otras nuevas. Estas son las líneas relevantes de los dos SDK que probé:

| Paquete | Flutter 3.44.8 | Flutter 3.47.7 |
| --- | --- | --- |
| `meta` | `1.18.0` | `^1.18.3` |
| `vector_math` | `2.2.0` | `^2.4.0` |
| `test_api` | `0.7.11` | `0.7.12` |
| `matcher` | `0.12.19` | `0.12.20` |
| `material_color_utilities` | `0.13.0` | `0.13.0` |
| `collection` | `1.19.1` | `^1.19.1` |

Flutter 3.47 es la primera versión estable con [PR #185268, "Unpin sdk package dependencies"](https://github.com/flutter/flutter/pull/185268), que cerró el antiguo issue [#158050, "Stop pinning dependencies"](https://github.com/flutter/flutter/issues/158050). La mayoría de los pins pasaron a rangos con caret. `test_api` y `matcher` siguen siendo exactos porque el SDK importa sus bibliotecas `src/`, y `material_color_utilities` también sigue fijado (la descripción del PR explica ambos casos). Así que incluso en 3.47 y posteriores, cada versión de Flutter que sube `test_api` o `matcher` reescribe esas entradas del lockfile.

**2. Flutter ejecuta `pub get` a tus espaldas después de cambiar de SDK.** `flutter run`, `flutter build`, `flutter test` y compañía llaman a `pub get` antes de hacer cualquier otra cosa. La herramienta de Flutter solo lo omite cuando `.dart_tool/version` coincide con la versión actual del framework y `pubspec.yaml` es más antiguo que `pubspec.lock` y `.dart_tool/package_config.json`. La comprobación está en `packages/flutter_tools/lib/src/dart/pub.dart`. Por eso el primer `flutter run` tras cambiar de SDK siempre vuelve a resolver, y el lockfile cambia aunque nunca hayas escrito `pub`.

**3. `flutter upgrade` ejecuta `pub upgrade` en tu proyecto.** Este es el que la mayoría pasa por alto. Después de actualizar el SDK, `UpgradeCommand.updatePackages` busca un `pubspec.yaml` en el directorio actual o en cualquier directorio padre, y si encuentra uno llama a `pub.get(..., upgrade: true)` sobre ese proyecto. Eso es `pub upgrade`, no `pub get`, así que mueve *todas* las dependencias a la versión más reciente que permitan tus restricciones, incluidos paquetes que no tienen nada que ver con el SDK. El código hace esto desde al menos Flutter 3.0.0.

## Reproducción mínima

Crea un proyecto con el SDK anterior, haz commit y luego resuélvelo con el nuevo. Mantuve ambos SDK lado a lado: el Flutter 3.44.8 de Homebrew y el zip estable de 3.47.7 descomprimido en una carpeta temporal.

```bash
# Flutter 3.44.8 (Dart 3.12.2) creates and locks the project
flutter create -e --platforms=android app
cd app
flutter pub add http shared_preferences intl
git init -q && git add -A && git commit -qm base

# Same project, Flutter 3.47.7 (Dart 3.13.5)
~/sdks/flutter-3.47.7/bin/flutter pub get
git diff --stat
```

Salida en 3.47.7:

```text
Resolving dependencies...
Downloading packages...
  clock 1.1.2 (1.1.3 available)
> matcher 0.12.20 (was 0.12.19)
  material_color_utilities 0.13.0 (0.13.1 available)
> meta 1.19.0 (was 1.18.0)
  stack_trace 1.12.1 (1.12.2 available)
> test_api 0.7.12 (was 0.7.11) (0.7.15 available)
> vector_math 2.4.3 (was 2.2.0)
Changed 4 dependencies!
Upgrading analysis_options.yaml to exclude build and platform directories.
 analysis_options.yaml |  4 ++++
 pubspec.lock          | 16 ++++++++--------
 2 files changed, 12 insertions(+), 8 deletions(-)
```

Se movieron cuatro paquetes, todos pins del SDK o antiguos pins del SDK. `http`, `shared_preferences` e `intl` se quedaron exactamente donde estaban: un `pub get` normal conserva todas las versiones bloqueadas que pueda. Fíjate en el cambio extra de archivo. Flutter 3.47 incluye una `AnalysisOptionsMigration` que agrega `build/**` y una exclusión `<platform>/**` por cada carpeta de plataforma a `analysis_options.yaml` la primera vez que ejecuta `pub get` en tu proyecto. Es una edición única, y conviene incluirla en el mismo commit que el lockfile.

Ahora vuelve a 3.44.8:

```text
< matcher 0.12.19 (was 0.12.20) (0.12.20 available)
< meta 1.18.0 (was 1.19.0) (1.19.0 available)
< test_api 0.7.11 (was 0.7.12) (0.7.15 available)
< vector_math 2.2.0 (was 2.4.3) (2.4.3 available)
Changed 4 dependencies!
```

Ese es el rebote. Ningún SDK acepta el lockfile del otro, así que gana quien ejecutó último.

Como comparación, `pub upgrade` en 3.47.7 a partir del mismo lockfile de 3.44 (que es lo que `flutter upgrade` hace por ti) cambió seis paquetes en lugar de cuatro, porque además movió `clock` y `stack_trace` a sus últimas versiones. En una aplicación real con unas pocas docenas de dependencias, ese número suele ser mucho mayor.

## La solución en detalle

El objetivo no es evitar que el lockfile cambie alguna vez. Tiene que cambiar cuando cambia el SDK, porque la resolución anterior ya no es válida. El objetivo es que cambie una sola vez, a propósito, en un commit que puedas revisar.

### 1. Haz commit de `pubspec.lock` en aplicaciones, y solo en aplicaciones

La [documentación de Dart sobre `pub get`](https://dart.dev/tools/pub/cmd/pub-get) dice que los paquetes de aplicación deben incluir el lockfile en el control de versiones, para que cada desarrollador y cada implementación usen las mismas versiones, mientras que los paquetes reutilizables no deben hacerlo. Si ves cambios constantes en el repositorio de un *paquete*, la solución más simple es dejar de hacer commit del lockfile ahí. Todo lo que sigue asume una aplicación.

### 2. Fija una versión de Flutter por repositorio

El rebote solo ocurre cuando distintas personas ejecutan SDK diferentes contra el mismo lockfile. Haz que la versión sea parte del repositorio.

Con [FVM](https://fvm.app/), `fvm use` escribe la versión en `.fvmrc` en la raíz del proyecto, y todos ejecutan `fvm flutter ...` contra ella:

```bash
# FVM 3.x, Flutter 3.47.7
fvm install 3.47.7
fvm use 3.47.7
git add .fvmrc
```

Luego respáldala con una restricción de Flutter en `pubspec.yaml`, que pub hace cumplir a todos, usen FVM o no:

```yaml
# pubspec.yaml, Flutter 3.47.7 / Dart 3.13.5
environment:
  sdk: ^3.13.5
  flutter: ">=3.47.0 <3.48.0"
```

Pub comprueba ambos límites. Con el rango fijado en `<3.45.0`, Flutter 3.47.7 se negó a resolver por completo:

```text
The current Flutter SDK version is 3.47.7.

Because app2 requires Flutter SDK version >=3.0.0 <3.45.0, version solving failed.
Failed to update packages.
```

Ese error es mucho mejor que un lockfile reescrito en silencio: el compañero con el SDK equivocado se entera de inmediato en lugar de en la revisión de código. Espera que el bloque `sdks:` al final de `pubspec.lock` refleje tu restricción (`flutter: ">=3.47.0 <3.48.0"`), porque pub registra ahí la intersección de todas las restricciones de SDK del grafo. Esa línea cambia cada vez que editas la restricción, y no pasa nada.

Si quieres que CI siga el mismo archivo, la [configuración de CI para varias versiones](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) lee la versión desde `.fvmrc`.

### 3. Actualiza Flutter como un cambio aparte, fuera del directorio del proyecto

Como `flutter upgrade` ejecuta `pub upgrade` en el proyecto que encuentra a partir de tu directorio de trabajo, actualizar desde dentro de un repositorio mezcla dos cambios muy distintos en un solo diff: la nueva resolución impulsada por el SDK y una actualización completa de dependencias. Sepáralos:

```bash
# Flutter 3.44.8 -> 3.47.7
cd ~                # no pubspec.yaml here or in any parent directory
flutter upgrade     # upgrades only the SDK

cd ~/src/my_app
flutter pub get     # re-resolves only what the new SDK forces
git add pubspec.lock analysis_options.yaml
git commit -m "Flutter 3.47.7: re-resolve SDK-pinned packages"
```

Si usas FVM, obtienes el mismo efecto gratis: `fvm install` y `fvm use` nunca llaman a `pub upgrade` en tu aplicación. Cuando sí quieras paquetes más nuevos, ejecuta `flutter pub upgrade` deliberadamente en un segundo commit, de modo que una regresión se localice con bisect en "SDK nuevo" o en "paquetes nuevos", no en ambos. Es la misma separación que recomiendo para [la rotura de `awaitNotRequired`](/es/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/), donde un paquete retirado y una incompatibilidad de SDK parecían un solo problema.

### 4. Haz cumplir el lockfile en CI

`--enforce-lockfile` hace que `pub get` falle en lugar de reescribir el lockfile cuando la resolución confirmada no es válida para el SDK actual. La documentación lo recomienda para CI y para implementaciones en producción. Así se ve el lockfile de 3.44 bajo Flutter 3.47.7:

```text
> matcher 0.12.20 (was 0.12.19)
> meta 1.19.0 (was 1.18.0)
> test_api 0.7.12 (was 0.7.11) (0.7.15 available)
> vector_math 2.4.3 (was 2.2.0)
Would change 4 dependencies.
Unable to satisfy `pubspec.yaml` using `pubspec.lock`.

To update `pubspec.lock` run `flutter pub get` without
`--enforce-lockfile`.
Failed to update packages.
```

El comando termina con código 65 y deja `pubspec.lock` intacto. Ponlo antes de cada compilación:

```yaml
# GitHub Actions, subosito/flutter-action v2, Flutter 3.47.7
- uses: subosito/flutter-action@v2
  with:
    flutter-version-file: .fvmrc
- run: flutter pub get --enforce-lockfile
- run: flutter build apk --release
```

Ahora un runner de CI con el SDK equivocado, o un lockfile que alguien olvidó confirmar tras una actualización de SDK, es una compilación en rojo con un mensaje claro en lugar de una compilación en verde sobre versiones que nadie revisó. `--enforce-lockfile` también falla si el hash de contenido de un paquete alojado ya no coincide con el `sha256` registrado en el lockfile, lo cual es una buena verificación de la cadena de suministro de regalo.

### 5. No pelees contra el diff con `--no-pub`

`flutter run --no-pub` omite el `pub get` implícito, y sí evita que el lockfile cambie. También significa que ejecutas el SDK nuevo contra un `package_config.json` resuelto para el anterior. Eso funciona hasta que deja de funcionar, normalmente con un error de compilación dentro de `flutter_test` o de una anotación de `meta` que el nuevo framework espera. Usa `--no-pub` para experimentos rápidos, nunca como la solución.

## Detalles a tener en cuenta y casos parecidos

**Los proyectos nuevos en 3.47+ empiezan en los límites inferiores.** Desde el [PR #175352](https://github.com/flutter/flutter/pull/175352), `flutter create` escribe un `pubspec.lock` que bloquea las dependencias del SDK en el extremo inferior de sus nuevos rangos. Un proyecto nuevo de 3.47.7 bloquea `meta` 1.18.3 y `vector_math` 2.4.0; el primer `flutter pub upgrade` los mueve a 1.19.0 y 2.4.3. Ese diff es esperado, y tú decides cuándo aceptarlo.

**Las versiones de parche rara vez mueven los pins.** El pubspec de `flutter_test` es idéntico en 3.47.0, 3.47.6 y 3.47.7, así que una actualización de parche dentro de una misma versión menor normalmente deja el lockfile en paz. Las versiones menores (3.44 a 3.47) casi siempre lo cambian. Cuenta con el diff cuando cruces una versión menor.

**Las comillas en `sha256` no son ruido.** En los diffs de arriba, algunos hashes llevan comillas y otros no. Pub pone comillas a cualquier hash que empiece con un dígito para que YAML no lo lea como número. Si cambia la línea de un hash, es porque cambió la versión, no el formato.

**Monorepos con un workspace de pub.** Con los workspaces de Dart hay un solo `pubspec.lock` en la raíz del workspace, y `flutter upgrade` desde la carpeta de cualquier miembro sube por los directorios y también encuentra un `pubspec.yaml`. Se aplican las mismas reglas, con un radio de impacto mayor. Si tu editor se vuelve lento después de una nueva resolución, consulta [cómo acelerar el servidor de análisis de Dart en un monorepo grande](/es/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/).

**"version solving failed" en lugar de un diff.** Si un paquete del que dependes fija el mismo paquete que fija el SDK, un cambio de SDK hace fallar la resolución por completo en lugar de reescribir el lockfile en silencio. Es un problema distinto con su propia guía: [cómo solucionar "version solving failed" en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

**Los artefactos del engine son un pin aparte.** Fijar la versión del framework también fija el engine, lo cual importa para tener compilaciones de release reproducibles. El contexto está en [el artículo sobre la versión del engine de Flutter 3.38.6](/es/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/).

## Relacionado

- [Cómo solucionar "version solving failed" en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Cómo apuntar a varias versiones de Flutter desde un mismo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Solución: Undefined name 'awaitNotRequired' de material_ui o cupertino_ui en Flutter 3.44](/es/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/)
- [Flutter 3.38.6 y el cambio de versión del engine: las compilaciones reproducibles son más fáciles si lo fijas](/es/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/)
- [Cómo acelerar un servidor de análisis de Dart lento en VS Code para un monorepo grande de Flutter](/es/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/)

## Fuentes

- [dart.dev: `dart pub get`](https://dart.dev/tools/pub/cmd/pub-get), sobre versiones bloqueadas, `--enforce-lockfile` y el commit del lockfile.
- [flutter/flutter#158050: Stop pinning dependencies](https://github.com/flutter/flutter/issues/158050) y el [documento de diseño](https://flutter.dev/go/unpin-flutter-sdk-dependencies).
- [flutter/flutter#184821: Unpin sdk package dependencies](https://github.com/flutter/flutter/pull/184821) y su reland [#185268](https://github.com/flutter/flutter/pull/185268).
- [flutter/flutter#175352: Have `flutter create` create a pubspec.lock](https://github.com/flutter/flutter/pull/175352).
- Código fuente de la herramienta de Flutter en el [tag 3.47.7](https://github.com/flutter/flutter/tree/3.47.7/packages/flutter_tools/lib/src): `commands/upgrade.dart` (`updatePackages`), `dart/pub.dart` (la comprobación que omite pub get), `migrations/analysis_options_migration.dart`.
