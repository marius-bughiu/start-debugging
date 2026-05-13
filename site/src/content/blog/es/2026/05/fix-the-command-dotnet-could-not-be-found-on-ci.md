---
title: "Solución: The command 'dotnet' could not be found en CI"
description: "Tu runner de CI no puede resolver dotnet porque el SDK no está instalado para ese paso, o sí lo está pero no en PATH. Usa actions/setup-dotnet, fija un global.json y exporta DOTNET_ROOT y ~/.dotnet/tools."
pubDate: 2026-05-13
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "ci"
  - "github-actions"
  - "azure-pipelines"
lang: "es"
translationOf: "2026/05/fix-the-command-dotnet-could-not-be-found-on-ci"
translatedBy: "claude"
translationDate: 2026-05-13
---

La solución: un paso de CI ejecuta `dotnet` en un shell donde el SDK no está instalado, no está en `PATH`, o está fijado a una versión que tu `global.json` no permite. En GitHub Actions, añade un paso `actions/setup-dotnet@v4` antes de cualquier invocación de `dotnet`, incluye en el repo un `global.json` que coincida con el SDK que pides, y en contenedores Linux exporta `DOTNET_ROOT` y `$HOME/.dotnet/tools`. El error casi nunca es un fallo en la imagen del runner.

```text
/bin/bash: line 1: dotnet: command not found
##[error]Process completed with exit code 127.
```

o en runners de Windows:

```text
dotnet : The term 'dotnet' is not recognized as the name of a cmdlet, function, script file, or operable program.
At line:1 char:1
+ dotnet build
+ ~~~~~~
    + CategoryInfo          : ObjectNotFound: (dotnet:String) [], CommandNotFoundException
```

o, en Ubuntu después de `dotnet-install.sh`:

```text
Command 'dotnet' not found, but can be installed with:
sudo apt install dotnet-host
```

Esta guía está escrita contra .NET 11 (SDK 11.0.100), `actions/setup-dotnet@v4.0.1`, la tarea `UseDotNet@2` de Azure DevOps versión 2.213.x, y `dotnet-install.sh` tal como se publica en `https://dot.net/v1/dotnet-install.sh` en mayo de 2026. Las causas subyacentes no han cambiado desde .NET Core 3.1; solo han cambiado las versiones de las acciones.

## Por qué los shells de CI pierden `dotnet`

Hay cuatro causas raíz. Es fácil confundirlas porque todas muestran la misma línea `command not found`, así que conviene saber cuál estás viendo antes de parchear el YAML.

1. **La imagen del runner no tiene SDK alguno.** Imágenes de contenedor como `ubuntu:24.04`, `alpine:3.20` o `mcr.microsoft.com/devcontainers/base:ubuntu` no incluyen el SDK de .NET. Los runners alojados por GitHub (`ubuntu-latest`, `windows-latest`) sí, pero la versión en caché es la que se haya horneado en la imagen del runner, no la que necesita tu repo.
2. **El SDK está instalado, pero no está en `PATH` para este paso.** Cada paso en GitHub Actions corre en un shell nuevo. Añadir una línea a `~/.bashrc` desde un paso anterior no se traslada. Hacer `export` de `PATH` dentro de un bloque `run:` no se filtra al siguiente bloque `run:`.
3. **El SDK está en `PATH`, pero `global.json` fija una versión que no está instalada.** Cuando `dotnet` arranca, lee el `global.json` más cercano subiendo el árbol de directorios y resuelve un SDK que cumple las reglas de `version` y `rollForward`. Si no hay coincidencia, obtienes `error NETSDK1045` o un fallo del host que aparece, según el caso, con forma de "command not found" en el script envoltorio.
4. **El SDK fue instalado por `dotnet-install.sh` en `$HOME/.dotnet`, pero nunca se establecieron `DOTNET_ROOT` ni `PATH`.** Este es el fallo más común en runners auto-alojados de Linux y dentro de contenedores Docker. El script instala correctamente, luego ningún paso posterior exporta las variables.

## Una reproducción mínima en CI

Guarda esto como `.github/workflows/build.yml` y empújalo a un repo con un `.csproj`:

```yaml
# .github/workflows/build.yml -- .NET 11, GitHub Actions May 2026
name: build
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    container: ubuntu:24.04   # no SDK is preinstalled here
    steps:
      - uses: actions/checkout@v4
      - run: dotnet --info     # fails: dotnet: command not found
```

La clave `container:` cambia el SO del runner por una imagen Ubuntu pelada. El runner por defecto `ubuntu-latest` sí trae el SDK, así que quitar `container:` hace que este snippet funcione. La mayoría de equipos chocan con esto al mover un job a un contenedor por reproducibilidad y olvidar llevar también `setup-dotnet`.

## Solución 1: instalar el SDK en el mismo job y luego usarlo

La solución canónica en GitHub Actions es `actions/setup-dotnet`. Colócalo antes de cualquier paso que llame a `dotnet`. Descarga el SDK a una caché por runner, lo antepone al `PATH` para todos los pasos siguientes y exporta `DOTNET_ROOT` para herramientas que necesitan el directorio de instalación del SDK directamente.

```yaml
# .github/workflows/build.yml -- setup-dotnet@v4
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: "11.0.x"
      - run: dotnet --info
      - run: dotnet build -c Release
```

Dos detalles que muerden:

- **`dotnet-version` acepta un comodín**, pero igualmente deberías incluir un `global.json` para que las compilaciones locales y CI coincidan. Sin él, un desarrollador con SDK 11.0.5 instalado localmente y CI en 11.0.7 pueden producir `obj/project.assets.json` distintos y sorprenderse mutuamente.
- **`global-json-file:` anula a `dotnet-version`** en `setup-dotnet@v4`. Si pasas ambos, gana el JSON. Es una característica, no un bug, pero he visto a gente añadir `dotnet-version: "8.0.x"` a un workflow con `global.json` apuntando a 11 y preguntarse por qué se sigue instalando .NET 11.

En Azure DevOps, el equivalente es `UseDotNet@2`:

```yaml
# azure-pipelines.yml -- Azure DevOps, UseDotNet@2
steps:
  - task: UseDotNet@2
    inputs:
      packageType: sdk
      version: "11.0.x"
  - script: dotnet build -c Release
```

En GitLab CI o Buildkite, el camino más limpio es una imagen base con el SDK ya horneado (`mcr.microsoft.com/dotnet/sdk:11.0`). Evita ejecutar `dotnet-install.sh` en el propio job a no ser que sea estrictamente necesario: funciona, pero cada job paga el coste de descarga.

## Solución 2: incluye un `global.json` que coincida con CI

Cuando CI ejecuta `dotnet build`, usa el SDK que gana la resolución de `global.json`, no el último SDK instalado. Un fallo típico tiene esta pinta:

```text
A compatible .NET SDK was not found.
Requested SDK version: 11.0.200
global.json file: /home/runner/work/myrepo/myrepo/global.json
Installed SDKs:
  8.0.412 [/usr/share/dotnet/sdk]
  11.0.100 [/usr/share/dotnet/sdk]
```

El runner tiene 11.0.100; `global.json` pide 11.0.200. El script envoltorio sale con código distinto de cero, y según el host, puedes ver "command not found" propagado desde un `if` de Bash que se tragó el error real.

Mantén `global.json` honesto:

```json
{
  "sdk": {
    "version": "11.0.100",
    "rollForward": "latestFeature"
  }
}
```

`rollForward: latestFeature` deja a un desarrollador con 11.0.103 trabajar sin tener que subir el archivo en cada release de parche. `latestMajor` es demasiado permisivo para CI; `disable` es demasiado estricto para local. Haz que `version` coincida con lo que `dotnet-version` de `actions/setup-dotnet` va a instalar.

## Solución 3: cuando tienes que usar `dotnet-install.sh`

Dentro de un contenedor reducido, o en un runner auto-alojado donde no puedes usar `setup-dotnet`, instala con el script oficial y exporta las variables explícitamente en cada paso posterior.

```yaml
# self-hosted runner or restrictive container -- .NET 11
jobs:
  build:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - name: Install .NET 11 SDK
        run: |
          curl -sSL https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh
          chmod +x dotnet-install.sh
          ./dotnet-install.sh --channel 11.0 --install-dir "$HOME/.dotnet"
          echo "$HOME/.dotnet" >> "$GITHUB_PATH"
          echo "$HOME/.dotnet/tools" >> "$GITHUB_PATH"
          echo "DOTNET_ROOT=$HOME/.dotnet" >> "$GITHUB_ENV"
      - run: dotnet --info
      - run: dotnet tool restore && dotnet build -c Release
```

Las dos líneas `echo` escriben en archivos especiales que GitHub Actions lee entre pasos: `GITHUB_PATH` antepone una entrada al `PATH` para todos los pasos siguientes del job, y `GITHUB_ENV` exporta una variable de entorno de la misma manera. `export PATH=...` dentro del mismo bloque `run:` no funcionaría para el paso siguiente, que es la trampa en la que cae la gente cuando traduce un script de shell literalmente.

`DOTNET_ROOT` importa aunque `PATH` esté configurado. El host (el binario `dotnet`) usa `DOTNET_ROOT` para encontrar las carpetas `shared/Microsoft.NETCore.App` y `sdk/`. Si solo arreglas `PATH`, puedes acabar con `dotnet --info` funcionando pero `dotnet build` fallando con un error del host sobre un runtime que falta. Según Microsoft Learn, `DOTNET_ROOT` lo lee el host en Linux y macOS, y en Windows cuando la instalación no está en la ubicación por defecto.

Añade también el directorio `tools`. Sin `$HOME/.dotnet/tools` en `PATH`, cualquier llamada `dotnet tool install --global` tiene éxito pero la herramienta queda inaccesible, produciendo el error relacionado: `dotnet-ef: command not found`.

## Solución 4: imagen del SDK preconstruida, sin paso de instalación

Para CI basado en Docker, el camino con menor fricción es partir de una imagen que ya tiene el SDK:

```yaml
# .gitlab-ci.yml -- pinned SDK image, no install step
build:
  image: mcr.microsoft.com/dotnet/sdk:11.0
  script:
    - dotnet --info
    - dotnet build -c Release
```

Replica esto en Buildkite, CircleCI, agentes de Jenkins en Docker y cualquier plataforma cuya primitiva de CI sea "un contenedor más un script". Sacrificas flexibilidad (una imagen, un SDK) a cambio de la garantía de que `dotnet` está en `PATH` desde el primer comando.

## Variantes comunes y errores parecidos

Las búsquedas que aterrizan en esta página a veces buscan un error ligeramente distinto. Conviene diferenciarlas de entrada para no perseguir la solución equivocada.

- **`dotnet-ef: command not found`**. La herramienta global se instaló pero `$HOME/.dotnet/tools` no está en `PATH`. Añádelo como se muestra arriba, o usa un manifiesto local `dotnet-tools.json` y llama a `dotnet tool restore && dotnet ef`.
- **`Could not execute because the specified command or file was not found`**. `dotnet` está en `PATH`, pero el subcomando (`dotnet foo`) no es uno integrado y no está instalado como herramienta. Otro error, otra causa raíz.
- **`error NETSDK1045: The current .NET SDK does not support targeting .NET 11.0`**. El SDK está en `PATH`, pero es demasiado antiguo para el `TargetFramework` del proyecto. Sube `dotnet-version` de `setup-dotnet` (o `global.json`), no instales un segundo SDK al lado del primero esperando que la resolución multi-target lo solucione.
- **`/usr/bin/env: 'dotnet': No such file or directory`**. La misma causa raíz que "command not found", otro shell. La solución es idéntica.
- **`A fatal error occurred. The required library libhostfxr.so could not be found`**. `dotnet` está en `PATH`, pero `DOTNET_ROOT` apunta a un directorio vacío, o el SDK se instaló parcialmente. Vuelve a ejecutar `dotnet-install.sh` y comprueba que `DOTNET_ROOT` coincide con el directorio de instalación real.

## Cosas que parecen soluciones pero no lo son

- **Ejecutar `apt install dotnet-host`** en CI. Esto instala solo el host, no el SDK, y trae un `.deb` firmado por Microsoft que puede ir semanas por detrás del canal del SDK. Usa `setup-dotnet` o `dotnet-install.sh`.
- **Añadir `dotnet` a `PATH` en `~/.bashrc`** dentro de un paso `run:`. Los pasos de CI usan shells no interactivos; `~/.bashrc` no se carga. Usa `GITHUB_PATH` (GitHub Actions), `task.prependpath` (Azure DevOps), o un prefijo `PATH=...` por paso.
- **`sudo` en un runner alojado**. Los runners alojados ya corren con un usuario que tiene `sudo` sin contraseña, pero el SDK se instala en `/usr/share/dotnet` y el wrapper en `/usr/bin/dotnet` ya está ahí. Si te encuentras haciendo `sudo` para que funcione, casi seguro te falta `setup-dotnet`, no privilegios.
- **Fijar `actions/setup-dotnet` en un major anterior** porque "v4 nos rompió". v4 cambió los directorios de caché y empezó a parsear `global.json` con más estrictez. La rotura casi siempre es un `global.json` que apunta a un SDK no disponible. Arregla el JSON; no te quedes anclado a v3 para siempre.

## Verificar la solución en CI

Antes de seguir, ejecuta dos pasos de diagnóstico. Son baratos y te ahorran perseguir fantasmas en la salida de `dotnet build`.

```yaml
- run: which dotnet || command -v dotnet || true
- run: dotnet --info
```

`which dotnet` (o `where dotnet` en Windows) confirma qué binario resuelve el shell. `dotnet --info` imprime el runtime, la lista de SDKs y el `global.json` resuelto. Si `--info` tiene éxito pero `build` falla con "command not found", el fallo está dentro de un script envoltorio que se traga errores, no en `dotnet`. Ese es el momento de leer el envoltorio, no de reinstalar.

Cuando la salida de `--info` muestre el SDK que pediste, apunte `Base Path:` al directorio que esperabas y liste `global.json file: <tu ruta>`, has terminado. Cualquier otra cosa es una configuración incorrecta real que vale la pena arreglar.

## Relacionados

- Para el panorama más amplio de correr herramientas en lanes de CI paralelas, mira [cómo apuntar a múltiples versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), que usa el mismo truco de `GITHUB_PATH` para intercambiar SDKs por job de matriz.
- Si tu build falla después de encontrar el SDK, mira [por qué una app publicada falla al cargar ensamblados](/es/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) para la historia de trim y runtime packs.
- Para fallos específicos de copia en build, [la solución de MSB3027 con conteo de reintentos](/es/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) cubre los casos de antivirus y bloqueos de archivo.
- Para una herramienta de EF Core que se resuelve pero falla al adjuntarse al host, ver [solucionar dotnet ef migrations add cuando no se puede crear el DbContext](/es/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).
- Para pruebas de integración basadas en contenedor cuando quieres una base de datos real en el mismo job, [pruebas de integración contra un SQL Server real con Testcontainers](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) recorre un pipeline funcional.

## Fuentes

- [README de `actions/setup-dotnet`](https://github.com/actions/setup-dotnet), documentación `v4.0.x` de `dotnet-version`, `global-json-file` y `cache`.
- [Instalar .NET en Linux sin gestor de paquetes](https://learn.microsoft.com/en-us/dotnet/core/install/linux-scripted-manual), Microsoft Learn, cubre `dotnet-install.sh`, `DOTNET_ROOT` y `PATH`.
- [Variables de entorno usadas por el SDK y la CLI de .NET](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-environment-variables), Microsoft Learn, sobre `DOTNET_ROOT`.
- [Resumen de `global.json`](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json), Microsoft Learn, para las reglas de `rollForward`.
- [Comandos de workflow para GitHub Actions](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#adding-a-system-path), GitHub Docs, sobre `GITHUB_PATH` y `GITHUB_ENV`.
- [Issue 5267 de `dotnet/core`](https://github.com/dotnet/core/issues/5267), el hilo upstream de larga vida sobre "command 'dotnet' not found, but can be installed with".
