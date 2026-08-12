---
title: "Solución: dotnet tool install --global dotnet-ef lanza un error"
description: "Todas las formas en que dotnet tool install --global dotnet-ef falla en el SDK de .NET 10, con el mensaje exacto y el código de salida de cada una: ya instalado, versión no encontrada, degradación bloqueada, conflicto de shim, feed de NuGet caído y el desajuste de runtime que solo se rompe despues de que la instalación termina bien."
pubDate: 2026-08-12
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "ef-core"
  - "entity-framework"
lang: "es"
translationOf: "2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error"
translatedBy: "claude"
translationDate: 2026-08-12
---

`dotnet tool install --global dotnet-ef` falla por seis razones distintas, y el SDK le da a cada una un mensaje diferente de una sola línea, sin traza de pila que permita desambiguarlo. Lee la línea, no el código de salida: "Tool 'dotnet-ef' is already installed." sale con **0** y no es un error en absoluto, mientras que "is not found in NuGet feeds", "is lower than existing version", "conflicts with an existing command from another tool" y "No NuGet sources are defined or enabled" salen todas con **1** y cada una necesita un flag distinto. Todo lo que sigue se ejecutó contra el SDK 10.0.201 en Windows 11 el 2026-08-12, contra el feed en vivo de nuget.org.

## El error en contexto

Estos son los mensajes reales, capturados literalmente. El SDK imprime una línea y se detiene:

```
Tool 'dotnet-ef' is already installed.

Version 99.0.0 of package dotnet-ef is not found in NuGet feeds https://api.nuget.org/v3/index.json.

dotnet-ef-typo-xyz is not found in NuGet feeds https://api.nuget.org/v3/index.json.

The requested version 8.0.11 is lower than existing version 9.0.11.

Tool 'dotnet-ef' failed to update due to the following:
Failed to create shell shim for tool 'dotnet-ef': Command 'dotnet-ef' conflicts with an existing command from another tool.
Tool 'dotnet-ef' failed to install.

No NuGet sources are defined or enabled

Unhandled exception: Unable to load the service index for source https://nuget.invalid.example/v3/index.json.
```

Hay un séptimo fallo que es peor que todos estos, porque la instalación reporta éxito:

```
You can invoke the tool using the following command: dotnet-ef
Tool 'dotnet-ef' (version '3.1.32') was successfully installed.
```

y luego la herramienta se niega a ejecutarse.

## Por qué ocurre esto

`dotnet tool install` hace tres trabajos separados en un solo comando, y cada trabajo tiene su propia superficie de fallo. Resuelve una versión de paquete desde los feeds de NuGet que tengas configurados, descomprime ese paquete en el almacén de herramientas y escribe un ejecutable shim en el directorio de herramientas. Un problema de resolución de NuGet, una regla de ordenamiento de versiones y una colisión de nombres en el sistema de archivos producen mensajes completamente ajenos entre sí, y por eso buscar "dotnet tool install dotnet-ef error" devuelve consejos que no corresponden a lo que tienes delante.

El séptimo caso es distinto en naturaleza. Instalar una herramienta nunca comprueba que tengas un runtime capaz de ejecutarla. El target framework del paquete solo lo hace cumplir el host al arrancar, así que una herramienta compilada para un runtime que no tienes se instala limpiamente y luego muere en el primer uso.

## Repro: reproducir cada fallo en el SDK 10.0.201

Usa `--tool-path` en lugar de `--global` mientras experimentas. Aísla cada caso en un directorio desechable en vez de revolver tu almacén de herramientas real, y los mensajes de fallo son idénticos:

```bash
# SDK 10.0.201. Each block is one failure mode.
dotnet tool install --tool-path ./tp dotnet-ef --version 99.0.0
dotnet tool install --tool-path ./tp dotnet-ef-typo-xyz
dotnet tool install --tool-path ./tp dotnet-ef --version 9.0.11
dotnet tool install --tool-path ./tp dotnet-ef --version 8.0.11
```

El tercer comando funciona, el cuarto imprime `The requested version 8.0.11 is lower than existing version 9.0.11.` y sale con 1. Para reproducir la colisión de shim, pon cualquier archivo con el nombre de comando de la herramienta en el directorio destino primero:

```bash
# SDK 10.0.201
mkdir -p ./tp6 && echo dummy > ./tp6/dotnet-ef.exe
dotnet tool install --tool-path ./tp6 dotnet-ef
```

## La solución, en detalle

Ordenadas por la frecuencia con la que realmente te topas con cada una.

### "Tool 'dotnet-ef' is already installed." no es un fallo

Código de salida 0. Medido, no supuesto. El comando es idempotente por diseño, así que dejarlo sin protección en un script de aprovisionamiento o en un Dockerfile es correcto y no romperá la compilación.

Lo que confunde a la gente es que el mismo comando a veces imprime algo completamente distinto:

```
Tool 'dotnet-ef' was successfully updated from version '10.0.10' to version '10.0.11'.
```

En el SDK de .NET 10, `dotnet tool install --global dotnet-ef` sin `--version` actualiza una instalación existente a la última versión estable en lugar de negarse. Solo obtienes "already installed" cuando la versión a la que llegarías es la que ya tienes. Si querías una versión fijada y recibiste una actualización inesperada, esa es la razón: fíjala.

```bash
# SDK 10.0.201. Both forms work; the @ syntax needs SDK 10.0.100 or later.
dotnet tool install --global dotnet-ef --version 10.0.11
dotnet tool install --global dotnet-ef@10.0.11
```

### "is not found in NuGet feeds" se refiere a la versión, no al paquete

Dos mensajes distintos comparten esta redacción y significan cosas diferentes. `dotnet-ef-typo-xyz is not found in NuGet feeds ...` nombra el paquete, así que el ID del paquete está mal o tu feed no lo tiene. `Version 99.0.0 of package dotnet-ef is not found in NuGet feeds ...` nombra una versión, así que el paquete se resolvió bien y la versión no existía.

El segundo es el habitual, porque `--version 11.0.0` no hace lo que la gente espera. Desde .NET 8, `--version Major.Minor.Patch` coincide con esa versión exacta, incluidas las no listadas, y no flota. Para la 11.x más reciente usa un comodín, y para una versión preliminar tienes que optar explícitamente:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --version 11.0.*
dotnet tool install --global dotnet-ef --prerelease
```

La ejecución con `--prerelease` resolvió `11.0.0-preview.7.26381.103` el día en que se escribió esto. Sin el flag, las versiones preliminares son invisibles y obtienes un "not found" para una versión que ves perfectamente en nuget.org.

### "The requested version X is lower than existing version Y"

Instalar por encima de una herramienta más nueva se rechaza, y `dotnet tool update` a una versión anterior también. El flag existe precisamente para esto:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --version 8.0.11 --allow-downgrade
```

que reporta `Tool 'dotnet-ef' was successfully updated from version '9.0.11' to version '8.0.11'.` y sale con 0. Recurre a esto cuando estés fijando la herramienta para que coincida con un runtime de EF Core más antiguo en una rama heredada. `dotnet tool uninstall --global dotnet-ef` seguido de una instalación limpia también funciona, pero son dos comandos y te deja sin nada instalado si el segundo falla.

### "Failed to create shell shim ... conflicts with an existing command from another tool"

El directorio de herramientas ya contiene un ejecutable llamado `dotnet-ef` que esta instalación no creó. La instalación se aborta en lugar de sobrescribirlo, y fíjate en la primera línea engañosa: dice "failed to update" antes de decir "failed to install".

En la práctica esto casi siempre es una instalación previa a medio borrar, o una instalación con `--tool-path` que le hace sombra a una con `--global`. Encuentra el shim obsoleto y bórralo. Las herramientas globales viven en `%USERPROFILE%\.dotnet\tools` en Windows y en `$HOME/.dotnet/tools` en Linux y macOS, con los binarios reales en un directorio hermano `.store`:

```bash
# SDK 10.0.201
dotnet tool list --global
ls ~/.dotnet/tools
```

Si `dotnet tool list --global` no muestra `dotnet-ef` pero el archivo está ahí, el shim quedó huérfano y se puede borrar a mano sin riesgo.

### "No NuGet sources are defined or enabled"

No hay nada desde donde restaurar. Un `NuGet.config` en algún punto por encima de tu directorio actual tiene `<clear />` en `<packageSources>` sin nada añadido después, o todas las fuentes están deshabilitadas. Es fácil toparse con esto dentro de un repositorio que se limita a un feed privado, y fácil de pasar por alto porque el archivo de configuración que te rompe puede estar varios directorios más arriba.

```bash
# SDK 10.0.201
dotnet nuget list source
dotnet tool install --global dotnet-ef --source https://api.nuget.org/v3/index.json
```

`--source` reemplaza todas las fuentes configuradas para este único comando, que es la forma más rápida de confirmar que el problema es la configuración y no la red.

### "Unable to load the service index for source"

Un feed de tu configuración es inalcanzable, y en el SDK 10.0.201 esto aparece como una línea cruda de `Unhandled exception:`. Aborta la instalación completa incluso cuando un feed que sí funciona, más adelante en la lista, tiene el paquete. Dile al SDK que trate un feed caído como una advertencia:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --ignore-failed-sources
```

Con una configuración que lista un feed privado inalcanzable seguido de nuget.org, el comando pelado lanzó la excepción y `--ignore-failed-sources` instaló 10.0.11 sin problemas. Si el feed privado es el que tiene el paquete, este flag no te salvará y en su lugar necesitas `--interactive` para completar la autenticación.

### La instalación funciona y la herramienta no arranca

Este es el que te cuesta una tarde. Instalar un `dotnet-ef` antiguo en una máquina sin el runtime al que apunta funciona perfectamente, y luego:

```
You must install or update .NET to run this application.

App: ...\dotnet-ef.exe
Architecture: x64
Framework: 'Microsoft.NETCore.App', version '3.1.0' (x64)
.NET location: C:\Program Files\dotnet\

The following frameworks were found:
  6.0.36 at [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]
  8.0.23 at [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]
  10.0.5 at [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]
```

La solución es un flag en el momento de la instalación, disponible desde el SDK de .NET 9, que permite a la herramienta ejecutarse sobre un runtime más nuevo que aquel al que apunta:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --version 3.1.32 --allow-roll-forward
```

Mismo paquete, misma máquina. Sin el flag el shim se niega a arrancar; con él, `dotnet-ef --version` imprime `3.1.32` sobre el runtime 10.0.5. Es una decisión de tiempo de instalación grabada en el shim, así que una herramienta ya instalada tiene que reinstalarse para adoptarla.

## Qué cambió en el SDK de .NET 10

Cambiaron tres comportamientos y los tres generan preguntas de soporte.

La instalación ahora actúa como instalar-o-actualizar para herramientas globales sin versión fijada, y por eso un comando que antes no hacía nada en una máquina ya aprovisionada ahora te mueve en silencio una versión de parche hacia adelante. Fija la versión si eso te importa.

Las instalaciones locales ya no fallan cuando no hay manifiesto. Antes, `dotnet tool install dotnet-ef` sin `-g` en una carpeta sin `.config/dotnet-tools.json` producía "Cannot find a manifest file." A partir de .NET 10, `--create-manifest-if-needed` viene activado por defecto y el manifiesto se crea por ti, colocado en el directorio ancestro más cercano que contenga una subcarpeta `.git`. Eso suele ser lo correcto y de vez en cuando es muy incorrecto: ejecútalo desde una carpeta de descargas o desde dentro de un repositorio ajeno y modificarás en silencio el manifiesto de otra persona. Desactívalo con `--create-manifest-if-needed=false`. El flag `-d` que antes imprimía las ubicaciones de manifiesto consultadas está muerto, porque el error que anotaba ya no existe.

La sintaxis `@version` llegó en el SDK 10.0.100, así que `dotnet-ef@10.0.11` ahora equivale a `dotnet-ef --version 10.0.11`. Mezclar las dos formas es un error: pasar a la vez `dotnet-ef@10.0.11` y `--version` devuelve "Cannot specify --version when the package argument already contains a version."

## ¿Se puede ejecutar dotnet-ef sin instalarlo

Si la instalación falla en un runner de CI que no controlas, la solución más rápida en .NET 10 es dejar de instalar. `dotnet tool exec` y su atajo `dnx` descargan y ejecutan una herramienta de una sola vez:

```bash
# SDK 10.0.201
dnx dotnet-ef -y -- --version
dotnet tool exec dotnet-ef --yes -- database update
```

El `-y` acepta el mensaje de confirmación de descarga, que necesitas en cualquier contexto no interactivo. El separador `--` no es opcional aquí y el fallo sin él confunde: `dnx` interpreta `--version`, `--prerelease` y `--source` como opciones propias, así que `dnx dotnet-ef --version` nunca llega a la herramienta. Pon todo lo destinado a `dotnet-ef` después de `--`.

La ejecución de una sola vez también respeta un manifiesto local. Si hay un `.config/dotnet-tools.json` cerca, `dnx` ejecuta la versión fijada ahí en lugar de la última del feed, lo que la convierte en un valor por defecto razonable para scripts de repositorio.

## Trampas y errores parecidos

**"Could not execute because the specified command or file was not found"** es otro problema. La instalación funcionó y el directorio del shim no está en tu `PATH`. Eso tiene su propio recorrido en [cómo solucionar dotnet ef not found](/es/2023/06/how-to-fix-command-dotnet-ef-not-found/); en Linux la herramienta solo se puede ejecutar desde `$HOME/.dotnet/tools` hasta que la exportes tú, y en un runner de CI normalmente necesitas primero [tener dotnet en el PATH](/es/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/).

**La advertencia de herramientas más antiguas que el runtime** manda a la gente a reinstalar cuando no hay nada roto:

```
The Entity Framework tools version '8.0.11' is older than that of the runtime '10.0.5'. Update the tools for the latest features and bug fixes. See https://aka.ms/AAc1fbw for more information.
```

Eso es una advertencia, no la causa de lo que sea que falló después. En la ejecución anterior venía seguida de un error no relacionado, "No DbContext was found in assembly". Actualiza la herramienta si quieres, pero no des por hecho que eso arregló algo.

**Una instalación exitosa no significa que `dotnet ef` vaya a funcionar en tu solución.** Los dos fallos siguientes más comunes son que el host de tiempo de diseño no se resuelva, cubierto en [Unable to create an object of type DbContext](/es/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/), y que el paquete de diseño esté en el proyecto equivocado, cubierto en [tu proyecto de inicio no referencia Microsoft.EntityFrameworkCore.Design](/es/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/).

**No instales la herramienta en máquinas de producción para aplicar migraciones.** Compila un migration bundle en CI en su lugar, que no necesita SDK ni herramienta global en la máquina destino. Ese flujo está en [aplicar migraciones de EF Core 11 con dotnet ef migrations bundle](/es/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/).

## Relacionado

Una vez que la herramienta se instala, la fricción se traslada a invocarla correctamente en una solución dividida, y EF Core 11 por fin tiene una respuesta para eso en [el archivo de valores por defecto .config/dotnet-ef.json](/es/2026/06/efcore-11-dotnet-ef-json-config-file/). Si llegaste aquí a mitad de una actualización, la versión de la herramienta es un punto más entre muchos en la [lista de verificación de .NET 8 a .NET 11](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) y en los [cambios disruptivos de EF Core 6 a EF Core 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Fuentes

- [Comando dotnet tool install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-tool-install), para la referencia de opciones, la tabla de ubicaciones de instalación y la regla de coincidencia `--version Major.Minor.Patch` introducida en .NET 8.
- [Cambio disruptivo: dotnet tool install --local crea el manifiesto por defecto](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/10.0/dotnet-tool-install-local-manifest), para el error retirado "Cannot find a manifest file." y la opción de exclusión `--create-manifest-if-needed=false`.
- [Novedades del SDK y las herramientas de .NET 10](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/sdk), para la ejecución de una sola vez con `dotnet tool exec` y el script `dnx`.
- [Solución de problemas de uso de herramientas .NET](https://learn.microsoft.com/en-us/dotnet/core/tools/troubleshoot-usage-issues), para los diagnósticos de PATH y shim.
