---
title: "Solución: Version solving failed en pubspec.yaml"
description: "La solución en 30 segundos: lee la cadena 'because' del error, encuentra la única restricción que tiene atrapado a pub, y o la amplías o agregas una entrada en dependency_overrides. No empieces con flutter clean."
pubDate: 2026-05-17
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "pub"
  - "pubspec"
lang: "es"
translationOf: "2026/05/fix-version-solving-failed-in-pubspec-yaml"
translatedBy: "claude"
translationDate: 2026-05-17
---

La solución en una frase: `Version solving failed` no es un bug, es `dart pub` diciéndote que las restricciones que escribiste en `pubspec.yaml` no pueden satisfacerse todas al mismo tiempo. Lee la cadena de líneas `because ... depends on ...` de abajo hacia arriba, encuentra la única restricción imposible de satisfacer (normalmente un límite inferior del SDK de Dart o un paquete fijado a una versión más antigua de la que necesita uno de sus consumidores) y luego amplía esa restricción o agrega una entrada en `dependency_overrides` para forzar una versión específica. `flutter clean` y borrar `pubspec.lock` no solucionarán esto.

```text
Resolving dependencies...
Because every version of flutter_test from sdk depends on collection 1.19.0
        and my_app depends on collection ^1.18.0, flutter_test from sdk is forbidden.
So, because my_app depends on flutter_test any from sdk, version solving failed.

pub get failed (1; So, because my_app depends on flutter_test any from sdk,
version solving failed.)
exit code 1
```

Esta guía está escrita contra Dart 3.11 y Flutter 3.41.5, el canal stable a fecha de mayo de 2026. El comportamiento del resolutor descrito a continuación es el mismo algoritmo `PubGrub` que se distribuye en `dart pub` desde Dart 2.10, así que todo lo de aquí aplica limpiamente a cualquier proyecto Flutter 3.x o Dart 3.x. El código fuente relevante vive en [dart-lang/pub](https://github.com/dart-lang/pub) bajo `lib/src/solver/`.

## Lo que significa realmente el error

`dart pub get` ejecuta un resolutor estilo SAT llamado [PubGrub](https://github.com/dart-lang/pub/blob/master/doc/solver.md). Recorre todas las restricciones en tu `pubspec.yaml`, incluidas las restricciones transitivas extraídas del propio `pubspec.yaml` de cada dependencia, e intenta encontrar un único conjunto de versiones de paquetes donde toda restricción se satisfaga a la vez. Cuando no existe tal conjunto, no se rinde tras el primer intento. Retrocede, aprende un hecho sobre qué combinaciones son imposibles y reintenta. La salida que ves es la **explicación** de la prueba de que no existe solución.

Cada línea es un hecho. Lee de abajo hacia arriba: la línea inferior es la conclusión (`version solving failed`), y las líneas que están sobre ella son la cadena de hechos que forzó esa conclusión. El hecho en la cima de la cadena es la restricción que realmente escribiste, y probablemente la que necesitas cambiar.

El mensaje de error tiene estructura. Pub nombra cada paquete relevante, imprime la restricción exacta y te dice quién la está pidiendo. No hay que adivinar nada una vez que vas despacio y lees.

## Una reproducción mínima que demuestra el fallo

Crea un paquete nuevo y fija dos dependencias cuyas restricciones transitivas se contradicen entre sí:

```yaml
# pubspec.yaml, Flutter 3.41.5, Dart 3.11
name: my_app
environment:
  sdk: '>=2.17.0 <3.0.0'

dependencies:
  flutter:
    sdk: flutter
  http: ^1.5.0
  some_legacy_package: 0.4.2
```

Ejecuta `flutter pub get` y obtienes:

```text
Because http >=1.0.0 requires SDK version >=3.0.0 <4.0.0
        and my_app requires SDK version >=2.17.0 <3.0.0, http >=1.0.0 is forbidden.
So, because my_app depends on http ^1.5.0, version solving failed.
```

Esta es la forma más común del error en proyectos reales. La restricción que rompe la resolución es tu propio límite inferior del SDK. El paquete que pediste está bien; el SDK que dijiste soportar es la parte imposible.

Una segunda forma común es una colisión transitiva:

```text
Because flutter_test from sdk depends on collection 1.19.0
        and riverpod 3.0.0 depends on collection ^1.18.0,
        flutter_test from sdk is incompatible with riverpod 3.0.0.
So, because my_app depends on both flutter_test from sdk and riverpod ^3.0.0,
version solving failed.
```

Mismo algoritmo, causa distinta. Aquí el pin del SDK desde `flutter_test` es exacto (`1.19.0`) y `riverpod` aceptará cualquier cosa desde `1.18.0` hasta sin incluir `2.0.0`. Ambos pueden satisfacerse si actualizas `riverpod` a una versión cuyo límite inferior de `collection` sea `1.19.0` o superior. La solución está en la versión que eliges, no en la sintaxis de la restricción.

## Solución, en orden de frecuencia con la que es la respuesta

Ejecuta los pasos siguientes en orden. No te saltes ninguno. Cada paso asume que el anterior no resolvió el error.

### 1. Lee el error e identifica el cuello de botella

Abre la salida del terminal. Encuentra la primera línea `Because ...` y la restricción nombrada en la cima de la cadena. Ese es el hecho imposible. En el ejemplo del SDK arriba es `my_app requires SDK version >=2.17.0 <3.0.0`. En el ejemplo transitivo es `flutter_test from sdk depends on collection 1.19.0`.

Anota dos cosas:

1. El paquete cuya restricción no puede satisfacerse (la **víctima**).
2. La restricción que lo encajona (el **culpable**).

Si no puedes identificar ambos, no has leído la cadena con suficiente atención. Léela de nuevo.

### 2. Sube el límite inferior de tu SDK

En 2026, la causa más común es una restricción del SDK obsoleta. Cualquier paquete publicado en los últimos 18 meses que use funciones de Dart 3 (records, patterns, sealed classes, las nuevas expresiones `switch`) establecerá su restricción del SDK a `^3.0.0`. Si tu `pubspec.yaml` todavía dice `>=2.17.0 <3.0.0`, no puedes instalar ese paquete. Actualiza a la sintaxis de caret contra la versión de Dart que realmente tienes:

```yaml
# pubspec.yaml, after running `dart --version`
environment:
  sdk: ^3.0.0
  flutter: '>=3.10.0'
```

Usa `^3.0.0` (todo desde 3.0.0 hasta sin incluir 4.0.0), no `^3.11.0`. El límite inferior comunica "esta es la versión más antigua de Dart contra la que probé"; ponerlo igual a la versión de tu portátil obliga a todo colaborador a actualizar sin razón. Mira la [documentación de pubspec](https://dart.dev/tools/pub/pubspec) para la sintaxis.

### 3. Actualiza la dependencia en conflicto

Si el culpable es un paquete de terceros, la segunda solución más común es que estés fijado a una versión major antigua. `flutter pub outdated` te muestra cada dependencia, qué versión está resuelta y cuál es la más reciente:

```bash
# Flutter 3.41.5
flutter pub outdated
```

Busca el paquete nombrado en el paso 1. Si su columna **latest** es más alta que la que tienes, ejecuta:

```bash
flutter pub upgrade --major-versions <package_name>
```

Esto reescribe la restricción en `pubspec.yaml` a la última versión major compatible y luego vuelve a ejecutar el resolutor. Si el paquete sigue semver, puede que tengas que arreglar cambios incompatibles en tu código, pero el error del resolutor desaparece.

### 4. Afloja una restricción demasiado estricta

Si escribiste una restricción a mano y la fijaste más estricta de lo necesario, amplíala. Los dos errores de sobre-fijación más comunes:

```yaml
# Demasiado estricto: pin exacto
some_package: 1.5.3

# Demasiado estricto: caret sobre una versión pre-1.0
some_package: ^0.4.2  # permite >=0.4.2 <0.5.0, a menudo demasiado estrecho
```

Sustituye por un caret sobre la versión major (`^1.5.3` permite `>=1.5.3 <2.0.0`) o por un rango explícito que cubra las versiones que estás dispuesto a aceptar (`'>=0.4.0 <0.6.0'`). La [documentación de Dart sobre restricciones de dependencias](https://dart.dev/tools/pub/dependencies) explica la sintaxis de caret tanto para paquetes pre-1.0 como post-1.0.

### 5. Usa `dependency_overrides` para conflictos transitivos que no puedes arreglar

Cuando el culpable es una dependencia transitiva en la que dos de tus dependencias directas no se ponen de acuerdo, y ninguna tiene una versión que resuelva el conflicto, sobrescríbela explícitamente. Esto va en el `pubspec.yaml` del paquete raíz solamente; las sobreescrituras en una dependencia que consumes son ignoradas por el resolutor.

```yaml
# pubspec.yaml, Flutter 3.41.5, Dart 3.11
name: my_app
environment:
  sdk: ^3.0.0

dependencies:
  flutter:
    sdk: flutter
  riverpod: ^3.0.0
  some_other_package: ^2.0.0

dependency_overrides:
  collection: ^1.19.0
```

`dependency_overrides` es un mazo. El resolutor deja de aplicar restricciones sobre el paquete sobrescrito y usa tu versión donde sea que aparezca en el grafo. Si un consumidor de `collection` dependía de una API eliminada en `1.19.0`, compilará pero fallará en runtime. Usa esto solo después de haber verificado que la versión que estás forzando es realmente compatible, y elimina la sobreescritura en cuanto la dependencia upstream se ponga al día.

### 6. Último recurso: regenera `pubspec.lock`

El lockfile está aguas abajo de la resolución, no aguas arriba. Borrarlo no puede arreglar un problema de restricciones, y la mayoría de las entradas de blog que lo recomiendan como primer paso están equivocadas. La única vez que borrar `pubspec.lock` ayuda es si ya cambiaste `pubspec.yaml` y el lockfile ahora está bloqueando al resolutor de elegir una nueva versión compatible:

```bash
# Flutter 3.41.5
rm pubspec.lock
flutter pub get
```

Haz esto solo después de los pasos 1 al 5. Si `pub get` sigue fallando tras regenerar el lockfile, las restricciones siguen siendo imposibles y en realidad no has arreglado nada.

## Trampas y casos parecidos

Algunos casos que producen un error similar o parecen ser de resolución de versiones pero no lo son:

- **`pub get failed (server unavailable)`**: este es un problema de red o de registro, no de resolución. Verifica `PUB_HOSTED_URL` si lo configuraste; una URL de espejo incorrecta devolverá 404s y el fallo aparece cerca de, pero no como, `version solving failed`.
- **`The current Dart SDK version is X.Y.Z. Because my_app requires SDK version ^A.B.C, version solving failed.`**: esta es la forma más directa del error. Ejecutaste `flutter pub get` con un SDK de Dart más antiguo del que declara tu propio `pubspec.yaml`. O actualizas Flutter (`flutter upgrade`) o bajas la restricción.
- **`pub get` funciona localmente pero falla en CI**: tu versión de Flutter en CI es más antigua que la local. Fija la versión de Flutter en CI para que coincida. El post [cómo apuntar a varias versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) cubre el patrón matriz.
- **`Gradle build failed to produce an .apk file` justo después de un `pub get`**: no es un error del resolutor en absoluto. La fase de compilación nativa está fallando. Mira [Gradle build failed to produce an apk file](/es/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) (la misma solución aplica a Flutter Android).
- **Las versiones pre-release se ignoran silenciosamente**: por defecto el resolutor no elegirá `2.0.0-beta.1` cuando pidas `^1.0.0`, incluso si no hay un `2.0.0` estable. Para entrar, usa la versión explícita: `some_package: ^2.0.0-beta.1`.
- **Un paquete con dependencias `git:` o `path:`**: el resolutor sigue aplicando restricciones de versión pero la fuente es la referencia git o la ruta que escribiste, no pub.dev. Una resolución de versión que falla en una dependencia git casi siempre se debe a que el propio `pubspec.yaml` de la rama referenciada está roto; clona el paquete localmente y ejecuta `dart pub get` dentro para verlo.

Si recurres a `dependency_overrides` más de una vez por trimestre, tu árbol de dependencias tiene problemas estructurales. O estás usando demasiados paquetes del mismo micro-dominio (tres clientes HTTP, dos gestores de estado), o tus dependencias directas no se mantienen al día con sus propias transitivas. Recortar el árbol soluciona más errores del resolutor que cualquier edición individual de una restricción.

## Relacionados

- [Solución: FormatException: Unexpected character al parsear JSON en Dart](/es/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/)
- [Solución: A RenderFlex overflowed by N pixels en Flutter](/es/2026/05/fix-renderflex-overflowed-in-flutter/)
- [Cómo apuntar a varias versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Cómo escribir un isolate de Dart para trabajo intensivo en CPU](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)
- [Cómo perfilar el jank en una app Flutter con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)

## Fuentes

- [The pubspec file](https://dart.dev/tools/pub/pubspec) (dart.dev)
- [Package dependencies](https://dart.dev/tools/pub/dependencies) (dart.dev)
- [PubGrub solver design doc](https://github.com/dart-lang/pub/blob/master/doc/solver.md) (dart-lang/pub)
- [dart-lang/pub issue 2470: "version solving failed"](https://github.com/dart-lang/pub/issues/2470) (hilo canónico de reporte de bug)
- [dart-lang/pub issue 3755: SDK version constraint edge cases](https://github.com/dart-lang/pub/issues/3755)
