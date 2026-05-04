---
title: "Cómo apuntar a múltiples versiones de Flutter desde un solo pipeline de CI"
description: "Guía práctica para ejecutar un proyecto Flutter contra varias versiones del SDK en CI: matriz de GitHub Actions con subosito/flutter-action v2, .fvmrc de FVM 3 como fuente de verdad, fijación de canal, caché y los detalles que muerden cuando la matriz crece más allá de tres versiones."
pubDate: 2026-05-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "ci"
  - "github-actions"
  - "fvm"
  - "how-to"
lang: "es"
translationOf: "2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline"
translatedBy: "claude"
translationDate: 2026-05-04
---

Respuesta corta: fija la versión principal de Flutter del proyecto en `.fvmrc` (estilo FVM 3) y usa ese archivo como fuente de verdad para el desarrollo local. En CI, ejecuta un trabajo `strategy.matrix` sobre las versiones extra de Flutter que te interesan, instala cada una con `subosito/flutter-action@v2` (lee `flutter-version-file: .fvmrc` para la compilación principal y acepta un `flutter-version: ${{ matrix.flutter-version }}` explícito para las entradas de la matriz), activa tanto `cache: true` como `pub-cache: true`, y limita la matriz con `fail-fast: false` para que una versión rota no oculte las demás. Trata la versión principal como obligatoria y las versiones de la matriz como informativas hasta que las hayas estabilizado.

Esta guía es para proyectos Flutter 3.x en mayo de 2026, validada contra `subosito/flutter-action@v2` (último v2.x), FVM 3.2.x y Flutter SDK 3.27.x y 3.32.x en runners alojados por GitHub con Ubuntu y macOS. Asume un repo, un `pubspec.yaml` y el objetivo de detectar regresiones entre versiones de Flutter antes de que lleguen a una rama de release. Los patrones se trasladan a GitLab CI y Bitbucket Pipelines con pequeños cambios de sintaxis; los conceptos de matriz son idénticos.

## Por qué un solo repo contra varias versiones de Flutter es siquiera una cosa

Flutter tiene dos canales de versión, `stable` y `beta`, y solo `stable` es soportado en producción. La documentación de Flutter recomienda stable para nuevos usuarios y para releases en producción, lo cual es correcto, y sería precioso que cada equipo pudiera elegir un parche estable y quedarse ahí. En la práctica, tres presiones empujan a los equipos fuera de ese camino:

1. Un paquete del que dependes sube su límite inferior `environment.flutter`, y el nuevo límite está un minor por delante de donde estás.
2. Aterriza un nuevo stable con un arreglo de Impeller o un arreglo de build de iOS que necesitas, pero un paquete transitivo todavía no se ha certificado contra él.
3. Distribuyes una biblioteca o plantilla (un kit de inicio, un sistema de diseño interno) que las apps consumidoras usan sobre cualquier Flutter que su equipo haya estandarizado, y necesitas saber que no se rompe bajo ninguno de `stable - 1`, `stable` o `beta`.

En los tres casos la respuesta es la misma disciplina aburrida: elige una versión como contrato para las máquinas de tus desarrolladores, y trata cualquier otra versión que te importe como una entrada de matriz de CI. Ese es el modelo que construye el resto de este artículo.

Un recordatorio rápido sobre lo que `pubspec.yaml` realmente impone. La restricción `environment.flutter` es verificada por `pub` solo como un límite inferior. Como se cubre en [flutter/flutter#107364](https://github.com/flutter/flutter/issues/107364) y [#113169](https://github.com/flutter/flutter/issues/113169), el SDK no impone el límite superior en la restricción `flutter:`, así que escribir `flutter: ">=3.27.0 <3.33.0"` no impedirá que un desarrollador en Flutter 3.40 instale tu paquete. Necesitas un mecanismo externo. Ese mecanismo es FVM para humanos y `flutter-action` para CI.

## Paso 1: convierte `.fvmrc` en la fuente de verdad del proyecto

Instala [FVM 3](https://fvm.app/) una vez por estación de trabajo, y luego fija el proyecto desde la raíz del repo:

```bash
# FVM 3.2.x, May 2026
dart pub global activate fvm
fvm install 3.32.0
fvm use 3.32.0
```

`fvm use` escribe `.fvmrc` y actualiza `.gitignore` para que el pesado directorio `.fvm/` no se suba al repo. Según la [documentación de configuración de FVM](https://fvm.app/documentation/getting-started/configuration), solo `.fvmrc` (y el legado `fvm_config.json` si lo tienes de FVM 2) pertenece al control de versiones. Súbelo y el archivo se convierte en el contrato que cada desarrollador y cada job de CI lee.

Un `.fvmrc` mínimo se ve así:

```json
{
  "flutter": "3.32.0",
  "flavors": {
    "next": "3.33.0-1.0.pre",
    "edge": "beta"
  },
  "updateVscodeSettings": true,
  "updateGitIgnore": true
}
```

El mapa `flavors` es el concepto de FVM que se mapea perfectamente sobre una matriz de CI: cada entrada es una versión nombrada de Flutter que tu proyecto tolera. `next` es el próximo stable en el que quieres luz verde, `edge` es el canal beta en vivo para señal de alerta temprana. Localmente, un desarrollador puede ejecutar `fvm use next` para verificar antes de abrir un PR. En CI, iterarás los mismos nombres de flavor desde la matriz, así que los nombres se mantienen alineados.

## Paso 2: un workflow, una compilación principal, un job de matriz

La trampa en la que la mayoría de los equipos cae en el primer intento es meter cada versión de Flutter en la misma matriz y tratarlas todas como obligatorias. Eso hace que el tiempo de ejecución se infle y convierte una beta inestable en una rama main roja. El patrón que escala son dos jobs en el mismo archivo de workflow:

- Un job **principal** que instala solo la versión de `.fvmrc` y ejecuta el pipeline completo de tests, build y entrega. Es requerido por la protección de rama.
- Un job de matriz de **compatibilidad** que instala cada versión extra, ejecuta el analizador y los tests, y es informativo hasta que confíes en él.

Aquí está el workflow, con la v6 de `actions/checkout` (actual a mayo de 2026) y `subosito/flutter-action@v2`:

```yaml
# .github/workflows/flutter-ci.yml
name: Flutter CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: flutter-ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  primary:
    name: Primary (.fvmrc)
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v6
      - uses: subosito/flutter-action@v2
        with:
          flutter-version-file: .fvmrc
          channel: stable
          cache: true
          pub-cache: true
      - run: flutter --version
      - run: flutter pub get
      - run: dart format --output=none --set-exit-if-changed .
      - run: flutter analyze
      - run: flutter test --coverage

  compat:
    name: Compat (Flutter ${{ matrix.flutter-version }})
    needs: primary
    runs-on: ${{ matrix.os }}
    timeout-minutes: 20
    continue-on-error: ${{ matrix.experimental }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - flutter-version: "3.27.4"
            channel: stable
            os: ubuntu-latest
            experimental: false
          - flutter-version: "3.32.0"
            channel: stable
            os: macos-latest
            experimental: false
          - flutter-version: "3.33.0-1.0.pre"
            channel: beta
            os: ubuntu-latest
            experimental: true
    steps:
      - uses: actions/checkout@v6
      - uses: subosito/flutter-action@v2
        with:
          flutter-version: ${{ matrix.flutter-version }}
          channel: ${{ matrix.channel }}
          cache: true
          pub-cache: true
      - run: flutter pub get
      - run: flutter analyze
      - run: flutter test
```

Algunas cosas en ese archivo son deliberadas y vale la pena destacarlas antes de que lo copies.

**`fail-fast: false`** es obligatorio para una matriz de compatibilidad. Sin él, la primera versión que falla cancela las demás, lo que anula el propósito. Quieres ver, en una sola ejecución de CI, que 3.27 pasa, 3.32 falla y beta pasa, no solo "algo falló".

**`continue-on-error` por entrada de matriz** te permite marcar beta como rojo tolerado. La protección de rama debería requerir el nombre de check `Primary (.fvmrc)` y cualquier entrada de compatibilidad que hayas clasificado como obligatoria. Beta y "next" se mantienen verdosos en el dashboard pero nunca bloquean un merge.

**`needs: primary`** es un detalle de secuenciación pequeño pero importante. Significa que los minutos de CI no se gastan en la matriz hasta que la compilación principal demuestre que el cambio es al menos sintácticamente sano. En una matriz de 30 jobs esto importa. En una matriz de 3 jobs sigue siendo una victoria gratuita.

**`concurrency`** cancela las ejecuciones en curso sobre el mismo ref cuando aterriza un nuevo commit. Sin él, un desarrollador que sube tres veces en un minuto paga por tres ejecuciones completas de matriz.

## Paso 3: caché que de verdad acierta entre versiones

`subosito/flutter-action@v2` cachea la instalación del SDK de Flutter con `actions/cache@v5` por debajo. Cada combinación única de `(os, channel, version, arch)` produce una entrada de caché separada, que es exactamente lo que quieres. La clave de caché por defecto es función de esos tokens, así que una matriz de 3 versiones produce 3 cachés de SDK y una matriz de 2 OS por 3 versiones produce 6. Esto está bien hasta que empiezas a personalizar.

Las dos perillas que vale la pena conocer:

- `cache: true` cachea el SDK en sí. Ahorra unos 90 segundos por ejecución en Ubuntu, más en macOS donde la instalación trae artefactos relacionados con Xcode.
- `pub-cache: true` cachea `~/.pub-cache`. Esta es la mayor victoria para cambios incrementales. Una app Flutter típica con 80 paquetes transitivos toma 25-40 segundos para `pub get` en frío, menos de 5 segundos en caliente.

Si tienes un monorepo con varios proyectos Flutter compartiendo dependencias, configura un `cache-key` y `pub-cache-key` que incluyan el hash de todos los archivos `pubspec.lock` relevantes, no solo el predeterminado. De lo contrario, cada subproyecto sobrescribe la caché de los demás. La acción expone los tokens `:hash:` y `:sha256:` exactamente para esto; consulta el [README](https://github.com/subosito/flutter-action) para la sintaxis.

Lo que **no** pertenece en tu clave de caché de matriz es el nombre del canal del SDK de Flutter cuando estás fijando a una build `*-pre`. Las etiquetas beta se reconstruyen ocasionalmente, así que un acierto de caché en una versión `*-pre` puede servir un binario obsoleto. La solución más simple es saltar la caché para las entradas `experimental: true`:

```yaml
- uses: subosito/flutter-action@v2
  with:
    flutter-version: ${{ matrix.flutter-version }}
    channel: ${{ matrix.channel }}
    cache: ${{ !matrix.experimental }}
    pub-cache: ${{ !matrix.experimental }}
```

Renuncias a un minuto de tiempo de instalación en la entrada beta y ganas confianza en que la build beta es reproducible.

## Paso 4: conecta `.fvmrc` y la matriz

El punto de los flavors de FVM más una matriz es que los nombres se alinean. Añadir un nuevo objetivo de compatibilidad debería ser un cambio de una línea en `.fvmrc` y un cambio de una línea en el workflow. Para mantenerlos sincronizados sin coordinación manual, genera la matriz desde el archivo en tiempo de job. GitHub Actions puede hacer esto con un pequeño job de bootstrap que emita una matriz JSON:

```yaml
  matrix-builder:
    name: Build matrix from .fvmrc
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.build.outputs.matrix }}
    steps:
      - uses: actions/checkout@v6
      - id: build
        run: |
          MATRIX=$(jq -c '
            {
              include: (
                .flavors // {} | to_entries
                | map({
                    "flutter-version": .value,
                    "channel": (if (.value | test("pre|dev")) then "beta" else "stable" end),
                    "os": "ubuntu-latest",
                    "experimental": (.key == "edge")
                  })
              )
            }' .fvmrc)
          echo "matrix=$MATRIX" >> "$GITHUB_OUTPUT"

  compat:
    needs: [primary, matrix-builder]
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix: ${{ fromJson(needs.matrix-builder.outputs.matrix) }}
    # ... same steps as before
```

Ahora añadir `"perf-investigation": "3.31.2"` a `.fvmrc` añade automáticamente un job de compatibilidad en la próxima ejecución de CI. Sin segunda fuente de verdad, sin desviación entre lo que FVM intenta localmente y lo que CI verifica. La acción `flutter-actions/pubspec-matrix-action` de GitHub hace algo similar si prefieres usar una dependencia mantenida en lugar del `jq` inline; ambos enfoques funcionan.

## Detalles que aparecen después de la segunda entrada de matriz

Una vez que la matriz tiene más de tres versiones, te toparás con al menos uno de estos.

**Envenenamiento de la caché de pub.** Un paquete que usa imports condicionales para símbolos más nuevos de Flutter puede resolverse de forma diferente en 3.27 frente a 3.32. Si ambas versiones comparten una `pub-cache`, el archivo lock escrito por 3.32 puede ser servido de vuelta a 3.27 y producir una build que "funciona" con la ruta de código equivocada. Usa una `pub-cache-key` que incluya el token de versión de Flutter (`:version:`) para mantenerlas separadas. El costo es una caché más fría; el beneficio es la reproducibilidad.

**Churn de `pubspec.lock`.** Si subes `pubspec.lock` (recomendado para repos de aplicación, no para bibliotecas), la matriz lo regenerará de forma diferente por versión de Flutter, y un desarrollador ejecutando con la versión de `.fvmrc` verá un lock distinto al que ven las entradas de matriz de CI. La solución es saltar la reescritura del lock en el job de matriz: pasa `--enforce-lockfile` a `flutter pub get`, que falla en divergencia de resolución en lugar de mutar el lock. Aplica esto solo en el job de matriz; el job principal debería seguir permitiendo actualizaciones para que los PRs de Renovate o Dependabot puedan llegar a verde.

**Builds de iOS y canal beta.** `subosito/flutter-action@v2` instala el SDK de Flutter pero no cambia la versión de Xcode en `macos-latest`. La Xcode del runner se actualiza con una cadencia distinta a la del canal beta de Flutter, y Flutter beta a veces requerirá un Xcode que el runner aún no entrega. Cuando el paso de build de iOS (`flutter build ipa --no-codesign`) empieza a fallar solo en beta, verifica la Xcode del runner contra los requisitos de [`flutter doctor`](https://docs.flutter.dev/get-started/install) antes de asumir que tu código está roto. Fijar el runner con `runs-on: macos-15` en lugar de `macos-latest` te da control sobre esa variable.

**Defaults de arquitectura.** A mayo de 2026 los runners alojados por GitHub son ARM64 por defecto en macOS y x64 en Ubuntu. Si compilas plugins nativos, el token de arquitectura en la clave de caché importa; de lo contrario, una caché de Apple Silicon puede ser servida a un runner x64 en una migración futura. La `cache-key` por defecto de la acción incluye `:arch:` por esta razón; no la elimines cuando personalices.

**Desviación del SDK de Dart.** Cada versión de Flutter trae un SDK de Dart específico. Una ejecución de `dart format` en Flutter 3.32 (Dart 3.7) produce formato diferente en algunos casos límite que en Flutter 3.27 (Dart 3.5). Ejecuta el formateo solo en el job principal, no en la matriz, para evitar reportes espurios de "format check failed" en versiones más antiguas. La misma lógica aplica para los lints: un lint nuevo introducido en Dart 3.7 disparará en 3.32 y no en 3.27. Usa un `analysis_options.yaml` a nivel de proyecto y solo activa los lints nuevos cuando la versión más antigua de la matriz los soporte.

## Cuándo dejar de añadir versiones

El punto de todo esto es detectar regresiones temprano, no probar exhaustivamente. Una matriz de más de tres o cuatro versiones suele significar que el equipo tiene miedo de actualizar en lugar de confianza para hacerlo. Si tu matriz ha crecido a cinco, pregunta qué entrada no ha detectado una regresión en seis meses. Esa entrada probablemente debería retirarse. La cadencia correcta para la mayoría de las apps es `stable actual`, `próximo stable cuando se anuncie` y `beta`, lo que significa que el script matrix-builder del Paso 4 lo mantiene acotado por lo que `.fvmrc` declara.

La disciplina que paga dividendos es la misma que hace que [fijar el SDK de Flutter de forma reproducible](/es/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/) funcione en primer lugar: declara las versiones que te importan, instala solo esas versiones y trata cualquier cosa fuera de ese conjunto como fuera de contrato. La matriz es la imposición.

## Relacionado

- [Flutter 3.38.6 y el bump de engine.version: las builds reproducibles se vuelven más fáciles si lo fijas](/es/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/) cubre por qué fijar el SDK importa incluso dentro de un solo canal.
- [Las dev tags de Dart 3.12 se mueven rápido](/es/2026/01/dart-3-12-dev-tags-are-moving-fast-how-to-read-them-and-what-to-do-as-a-flutter-3-x-developer/) explica cómo la cadencia de dev tags de Dart interactúa con las elecciones de canal de Flutter.
- [Depurando Flutter iOS desde Windows](/es/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) es la pieza acompañante para equipos cuyo CI necesita cubrir macOS pero cuyos desarrolladores no usan Macs a diario.
- [FlutterGuard CLI: una verificación rápida de "qué puede extraer un atacante" para apps Flutter 3.x](/es/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/) es un paso adicional útil para añadir al job principal una vez que tu matriz sea estable.

## Enlaces de origen

- [README de subosito/flutter-action](https://github.com/subosito/flutter-action)
- [flutter-actions/setup-flutter](https://github.com/flutter-actions/setup-flutter) (la alternativa mantenida si v2 alguna vez se queda atrás)
- [Documentación de FVM 3](https://fvm.app/documentation/getting-started/configuration)
- [Opciones de pubspec de Flutter](https://docs.flutter.dev/tools/pubspec)
- [Actualizar Flutter](https://docs.flutter.dev/install/upgrade)
- [flutter/flutter#107364: el límite superior de la restricción del SDK no se impone](https://github.com/flutter/flutter/issues/107364)
- [flutter/flutter#113169: Establecer una versión exacta de Flutter en pubspec.yaml no funciona](https://github.com/flutter/flutter/issues/113169)
