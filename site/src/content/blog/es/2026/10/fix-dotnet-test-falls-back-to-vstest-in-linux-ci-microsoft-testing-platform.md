---
title: "Solución: dotnet test recurre a VSTest en un pipeline de CI en Linux aunque el proyecto use Microsoft.Testing.Platform"
description: "dotnet test elige su ejecutor a partir de global.json, que busca subiendo desde el directorio de trabajo. En CI con Linux recurre a VSTest cuando ese archivo falta, tiene otro nombre, tiene una clave con mayúsculas incorrectas o el SDK es anterior a la versión 10."
pubDate: 2026-10-07
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "testing"
  - "microsoft-testing-platform"
  - "ci-cd"
  - "dotnet-10"
lang: "es"
translationOf: "2026/10/fix-dotnet-test-falls-back-to-vstest-in-linux-ci-microsoft-testing-platform"
translatedBy: "claude"
translationDate: 2026-10-07
---

Si `dotnet test` ejecuta tus pruebas de Microsoft.Testing.Platform (MTP) a través de VSTest en un agente de compilación de Linux pero no en tu máquina, la CLI no vio la selección de ejecutor. `dotnet test` decide entre VSTest y MTP antes de compilar nada: busca un `global.json` que empieza en el **directorio de trabajo actual** y sube por el árbol, y lee una sección `"test": { "runner": "Microsoft.Testing.Platform" }` con exactamente esos nombres de propiedad en minúsculas. En Linux el archivo debe llamarse `global.json` en minúsculas, el trabajo debe ejecutarse dentro del repositorio y el SDK debe ser 10.0 o posterior. Corrige lo que tu pipeline incumpla y después haz que CI falle de forma visible si vuelve a ocurrir.

Todo lo que sigue se midió en macOS arm64 (incluido un volumen APFS que distingue mayúsculas y minúsculas y se comporta como un sistema de archivos de Linux) con el SDK de .NET 10 10.0.302, el SDK de .NET 11 RC 1 (11.0.100-rc.1.26425.128) y el SDK de .NET 9 9.0.318, contra MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1) y xunit.v3 3.2.2 (MTP v1 con `xunit.runner.visualstudio` 3.1.5).

## El error en contexto

Cómo se ve "recurrir a VSTest" depende de la versión de MTP que usen tus proyectos de pruebas. Los proyectos con MTP 2.x (MSTest 4.x, MSTest.Sdk 4.x, `xunit.v3.mtp-v2`) se niegan a ejecutarse y hacen fallar el trabajo:

```text
Microsoft.Testing.Platform.MSBuild.targets(355,5): error : Testing with VSTest target is no longer supported by Microsoft.Testing.Platform on .NET 10 SDK and later. If you use dotnet test, you should opt-in to the new dotnet test experience. For more information, see https://aka.ms/dotnet-test-mtp-error [/src/tests/SdkTests/SdkTests.csproj]
```

Si tu pipeline usa la sintaxis exclusiva de MTP para seleccionar qué probar, el fallo ocurre incluso antes, porque `dotnet test` en modo VSTest le pasa a MSBuild el modificador desconocido:

```text
MSBUILD : error MSB1001: Unknown switch.
    Full command line: '/usr/share/dotnet/sdk/10.0.302/MSBuild ... --target:VSTest --nologo -nodereuse:false --solution src/Repo.slnx ...'
Switch: --solution
```

La variante peligrosa es la que se queda en verde. Un proyecto con MTP v1 que todavía referencia un adaptador de VSTest (`xunit.v3` 3.x con `xunit.runner.visualstudio`, o MSTest 3.x con `Microsoft.NET.Test.Sdk`) se ejecuta sin quejas bajo VSTest:

```text
Test run for /src/tests/XTests/bin/Debug/net10.0/XTests.dll (.NETCoreApp,Version=v10.0)
A total of 1 test files matched the specified pattern.
Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: 6 ms - XTests.dll (net10.0)
```

En ese modo `dotnet test -- --report-trx` también devuelve el código de salida 0 y no escribe ningún archivo TRX, porque todo lo que va después de `--` se trata como argumentos de RunSettings. En modo MTP real, el mismo proyecto rechaza `--report-trx` con el código de salida 5 (la extensión no está referenciada), que es la respuesta honesta. Un pipeline que publica "los archivos TRX que existan" publicará nada tan tranquilo.

Como comparación, esto es lo que imprime el modo MTP. Si no ves `Running tests from` y `Test run summary`, no estás en modo MTP:

```text
Running tests from /src/tests/SdkTests/bin/Debug/net10.0/SdkTests.dll (net10.0|arm64)
/src/tests/SdkTests/bin/Debug/net10.0/SdkTests.dll (net10.0|arm64) passed (426ms)
Test run summary: Passed!
```

## Por qué dotnet test ignora tu elección de ejecutor

La selección de ejecutor se añadió en el SDK de .NET 10 y vive en un solo lugar: la sección `test` de `global.json`. En el SDK de .NET 11 (desde Preview 6) la variable de entorno `DOTNET_TEST_RUNNER` puede sobrescribirla. Si ninguna de las dos selecciona MTP, `dotnet test` se queda en modo VSTest, invoca el target de MSBuild `VSTest` y deja que tu proyecto MTP reaccione como lo hace su versión. Nada en el `.csproj` puede cambiar esa decisión, porque la toma la CLI antes de que MSBuild evalúe cualquier proyecto.

Las causas que pude reproducir, en orden aproximado de frecuencia en pipelines reales:

1. **El trabajo se ejecuta desde un directorio que no está dentro del repositorio**, así que la búsqueda ascendente nunca llega a `global.json`. Pasar la ruta de la solución no ayuda; la búsqueda empieza en el directorio de trabajo, no en el proyecto.
2. **El archivo se llama `Global.json`** (o `GLOBAL.JSON`). Windows y los sistemas de archivos predeterminados de macOS no distinguen mayúsculas y minúsculas, así que en local funciona. Linux no.
3. **`global.json` no está en el lugar desde el que se ejecuta CI**: está en `src/` mientras el trabajo se ejecuta desde la raíz del repositorio, o un contexto de compilación de Docker copia los proyectos pero no el archivo.
4. **Un nombre de propiedad tiene mayúsculas incorrectas.** `"Test"` o `"Runner"` se ignoran en silencio. El valor no distingue mayúsculas, las claves sí.
5. **La imagen de CI tiene un SDK anterior a 10.0.** El SDK de .NET 9 no sabe que existe la sección `test`.
6. **`DOTNET_TEST_RUNNER=VSTest` está definida** a nivel de pipeline o de agente en un SDK de .NET 11. Tiene prioridad sobre `global.json`.

## Reproducción mínima

Dos proyectos de pruebas, una solución y un `global.json` en la raíz del repositorio:

```json
// global.json - .NET 10 SDK 10.0.302
{
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

```xml
<!-- tests/SdkTests/SdkTests.csproj - MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1) -->
<Project Sdk="MSTest.Sdk/4.4.1">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
```

Desde la raíz del repositorio, `dotnet test` ejecuta ambos proyectos en modo MTP. Ahora reproduce el comportamiento de CI:

```bash
# .NET 10 SDK 10.0.302
cd /tmp/elsewhere
dotnet test /src/repo/Repo.slnx        # VSTest mode: "Testing with VSTest target is no longer supported"

cd /src/repo
mv global.json Global.json
dotnet test                             # macOS/Windows: MTP mode. Linux: VSTest mode
```

Ejecuté la segunda mitad en una imagen de disco APFS que distingue mayúsculas y minúsculas (`hdiutil create -fs "Case-sensitive APFS"`) para obtener la semántica de Linux sin un contenedor: `global.json` pasó, `Global.json` falló con el error de VSTest, y el mismo `Global.json` en el volumen normal que no distingue mayúsculas y minúsculas pasó. Esa es la clásica división de "en mi máquina funciona".

## Solución, en detalle

### 1. Demuestra en qué modo está el agente

Añade un paso de diagnóstico antes del paso de pruebas. Las primeras líneas de `dotnet test --help` te dicen qué comando eligió la CLI:

```bash
# .NET 10 SDK 10.0.302 - put this right before the test step
pwd
ls -la global.json || echo "no global.json in $(pwd)"
dotnet --version
dotnet test --help | sed -n 2p
```

En modo MTP la segunda línea dice `.NET Test Command for Microsoft.Testing.Platform (opted-in via 'global.json' file)`. En modo VSTest dice `.NET Test Command for VSTest. To use Microsoft.Testing.Platform, opt-in to the Microsoft.Testing.Platform-based command via global.json.` Una pequeña rareza: en el SDK de .NET 11 RC 1 el texto de MTP sigue diciendo "via 'global.json' file" incluso cuando fue la variable de entorno la que lo activó.

### 2. Renombra el archivo a minúsculas en git

En un sistema de archivos que no distingue mayúsculas y minúsculas, un simple cambio de nombre al mismo nombre con otras mayúsculas no se detecta de forma fiable. Deja que git lo haga:

```bash
# any git version
git mv Global.json global.json.tmp
git mv global.json.tmp global.json
git commit -m "Rename global.json to lowercase for Linux agents"
```

Lo mismo se aplica a `Directory.Build.props` y similares, pero esos los resuelve MSBuild y unas mayúsculas incorrectas ahí producen síntomas distintos.

### 3. Ejecuta el paso de pruebas desde dentro del repositorio

La búsqueda sube desde el directorio de trabajo, así que el trabajo solo necesita estar en la carpeta que contiene `global.json` o por debajo de ella. En GitHub Actions el directorio de trabajo predeterminado es el checkout, así que el culpable habitual es un `working-directory` explícito o un `cd` a una carpeta de artefactos:

```yaml
# GitHub Actions, actions/setup-dotnet@v6, .NET 10 SDK
- uses: actions/setup-dotnet@v6
  with:
    global-json-file: global.json
- name: Test
  run: dotnet test --solution Repo.slnx
  # no working-directory pointing at a folder outside the repo
```

`global-json-file` mantiene sincronizado con el archivo el SDK que instala `setup-dotnet`, lo que también cubre la causa 5. Lee la versión del SDK de `sdk.version`, así que combínalo con la fijación que se muestra en el paso 5. Sin fijación, `setup-dotnet` documenta que gana el SDK más reciente que ya esté instalado en el runner. Si tu `global.json` vive en `src/`, muévelo a la raíz (recomendado, ya que `dotnet build` y los IDE lo resuelven igual) o ejecuta el paso con `working-directory: src`.

Para compilaciones con Docker, copia `global.json` en el mismo directorio desde el que ejecutas `dotnet test` y revisa `.dockerignore`:

```dockerfile
# mcr.microsoft.com/dotnet/sdk:10.0
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS test
WORKDIR /src
COPY global.json ./
COPY Repo.slnx ./
COPY tests/ tests/
RUN dotnet test --solution Repo.slnx
```

### 4. Escribe la sección exactamente

Todo esto se probó en el SDK 10.0.302:

| Contenido de `global.json` | Resultado |
|---|---|
| `"test": { "runner": "Microsoft.Testing.Platform" }` | MTP |
| `"test": { "runner": "microsoft.testing.platform" }` | MTP (el valor no distingue mayúsculas) |
| `"Test": { "runner": ... }` o `"test": { "Runner": ... }` | VSTest, en silencio |
| `"sdk": { "version": "10.0.302", "test": { ... } }` (anidado) | VSTest, en silencio |
| `"test": { "runner": "MTP" }` | Fallo de la CLI: `Test runner 'MTP' is not supported.` |
| `// comments` en el archivo | MTP (se permiten comentarios) |
| una coma final | Fallo de la CLI: `JsonException ... trailing comma` |

Los fallos ruidosos son fáciles. Los dos silenciosos son la razón para mantener exactamente las mayúsculas y minúsculas de la documentación y para dejar `test` en el nivel superior, junto a `sdk`, no dentro de él.

### 5. Usa un SDK que entienda la selección de ejecutor

En el SDK 9.0.318 con exactamente el mismo `global.json`, `dotnet test` ignoró por completo la sección `test` y ejecutó un proyecto `xunit.v3` 3.2.2 a través de VSTest (`VSTest version 17.14.1`). Un proyecto MSTest.Sdk 4.4.1 en `net9.0` también se quedó en verde, pero a través del antiguo puente de MSBuild (`Run tests: '...' [net9.0|arm64]`), porque el puente sigue siendo compatible en el SDK 9 y anteriores. En ambos casos pierdes el comportamiento del modo MTP sin ninguna advertencia.

Esto afecta a los pipelines que usan imágenes `mcr.microsoft.com/dotnet/sdk:9.0`, o `setup-dotnet` con `dotnet-version: 9.0.x` para un proyecto que apunta a `net8.0` o `net9.0`. No necesitas cambiar el destino de los proyectos; solo necesitas el SDK 10.0 para ejecutarlos. Fíjalo en el mismo archivo:

```json
// global.json - SDK pin plus runner selection, .NET 10 SDK
{
  "sdk": {
    "version": "10.0.302",
    "rollForward": "latestFeature"
  },
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

Con un `sdk.version` fijado, un agente sin un SDK compatible falla al arrancar con un error de "compatible .NET SDK was not found" en lugar de usar en silencio uno más antiguo.

### 6. Revisa DOTNET_TEST_RUNNER en agentes con .NET 11

En el SDK de .NET 11 RC 1 confirmé la precedencia documentada: `DOTNET_TEST_RUNNER=VSTest` sobrescribe un `global.json` correcto y produce el mismo error "Testing with VSTest target is no longer supported", mientras que un valor vacío o no reconocido (`DOTNET_TEST_RUNNER=MTP`) se ignora y gana `global.json`. La variable también funciona en el sentido contrario, lo que la convierte en una solución temporal práctica cuando no puedes cambiar el repositorio:

```bash
# .NET 11 SDK RC 1 (11.0.100-rc.1.26425.128) and later; ignored by the .NET 10 SDK
export DOTNET_TEST_RUNNER=Microsoft.Testing.Platform
dotnet test --solution Repo.slnx
```

En el SDK 10.0.302 la variable no tiene efecto en ningún sentido, así que no cuentes con ella hasta que el agente esté en .NET 11.

### 7. Haz que un fallback rompa la compilación

Dos protecciones baratas convierten la variante silenciosa en una compilación en rojo:

```bash
# .NET 10 SDK 10.0.302, MTP 2.4.1
dotnet test --solution Repo.slnx --minimum-expected-tests 1
```

`--solution` (o `--project`) solo existe en modo MTP, así que en modo VSTest el comando muere con `MSB1001: Unknown switch` en lugar de ejecutar las pruebas de la forma equivocada. `--minimum-expected-tests` es una opción de MTP que hace fallar la ejecución con el código de salida 9 si se ejecutaron menos pruebas de las esperadas. Nunca pases opciones de MTP después de `--` en CI: esa es exactamente la sintaxis que el modo VSTest se traga sin quejarse.

Si todavía estás migrando, elimina también `TestingPlatformDotnetTestSupport` de tus proyectos una vez que el cambio en `global.json` esté en su lugar. Solo importa en modo VSTest, y dejarlo permite que un proyecto con MTP v1 siga "funcionando" a través del puente cuando se pierde la selección de ejecutor.

## Trampas y casos parecidos

- **El `.csproj` no puede activarlo por ti.** `TestingPlatformDotnetTestSupport`, `EnableMSTestRunner` y `UseMicrosoftTestingPlatformRunner` deciden cómo se comporta un proyecto en cada modo. No eligen el modo.
- **Una solución mixta es un error distinto.** Una vez activado el modo MTP, un proyecto que solo es compatible con VSTest hace fallar la ejecución. Es el problema opuesto, tratado en la [guía de migración de VSTest a Microsoft.Testing.Platform](/es/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/).
- **`Zero tests ran` con el código de salida 5 significa que estás en modo MTP.** La aplicación de pruebas rechazó una opción, consulta [dotnet test con código de salida 5 en Microsoft.Testing.Platform](/es/2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform/).
- **Las tareas `VSTest@2` y `VSTest@3` de Azure DevOps siempre usan vstest.console.** Ningún cambio en `global.json` lo modifica. Usa en su lugar un paso de script que llame a `dotnet test` desde la raíz del repositorio.
- **Los IDE toman su propia decisión.** Que el Explorador de pruebas lea el proyecto de forma distinta a la CLI es una clase de error aparte, por ejemplo el [Explorador de pruebas que se cuelga con xUnit v3 mientras dotnet test pasa](/es/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/).

## Relacionado

- La [migración completa de VSTest a Microsoft.Testing.Platform en .NET 11](/es/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/), incluidos `--logger` a `--report-trx` y `.runsettings` a `testconfig.json`.
- Cuando el modo MTP está activo pero un proyecto rechaza sus argumentos: [solución para dotnet test con código de salida 5 y "Zero tests ran"](/es/2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform/).
- Obtener los fallos de MTP anotados en el diff del pull request una vez que CI se ejecuta en el modo correcto: [anotaciones de GitHub Actions en Microsoft.Testing.Platform 2.3](/es/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/).
- Sacar un proyecto `xunit.v3` 3.x de MTP v1 y del adaptador de VSTest: [migrar un proyecto de pruebas de xUnit v2 a xUnit v3](/es/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/).

## Fuentes

- [Comando dotnet test: elegir un ejecutor de pruebas](https://learn.microsoft.com/dotnet/core/tools/dotnet-test#choose-a-test-runner)
- [Pruebas con dotnet test: modo VSTest y modo MTP](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test)
- [Descripción general de global.json, incluido cómo se localiza el archivo](https://learn.microsoft.com/dotnet/core/tools/global-json)
- [dotnet test con Microsoft.Testing.Platform](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp)
- [actions/setup-dotnet: entrada global-json-file](https://github.com/actions/setup-dotnet)
- [Repositorio microsoft/testfx (MSTest y Microsoft.Testing.Platform)](https://github.com/microsoft/testfx)
