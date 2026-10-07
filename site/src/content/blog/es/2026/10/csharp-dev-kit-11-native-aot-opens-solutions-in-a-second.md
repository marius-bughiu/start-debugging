---
title: "C# Dev Kit 11.0 reduce seis procesos a un solo binario Native AOT"
description: "La versión preliminar de C# Dev Kit 11.0 reemplaza seis procesos administrados por un único proceso CSDevKit con Native AOT y una caché persistente de proyectos. Una solución de Aspire con 407 proyectos queda lista en 3,0 s en lugar de 84,1 s, y usa 316 MB en lugar de 2 072 MB."
pubDate: 2026-10-07
tags:
  - "vscode"
  - "csharp"
  - "dotnet-11"
  - "native-aot"
  - "tooling"
lang: "es"
translationOf: "2026/10/csharp-dev-kit-11-native-aot-opens-solutions-in-a-second"
translatedBy: "claude"
translationDate: 2026-10-07
---

El 6 de octubre de 2026, Drew Noakes publicó [A faster, lighter C# Dev Kit](https://devblogs.microsoft.com/dotnet/faster-lighter-csharp-dev-kit/) en el .NET Blog. C# Dev Kit pasa de la versión 3.3 a la 11.0, de modo que su numeración ahora sigue a .NET 11. El nuevo número viene acompañado de una reconstrucción de cómo la extensión carga las soluciones en VS Code. Si abandonaste VS Code para soluciones grandes de C# porque el indicador "Loading projects..." parecía no terminar nunca, vuelve a intentarlo.

## Seis procesos administrados se convirtieron en un binario Native AOT

C# Dev Kit 3.x ejecutaba seis procesos administrados independientes. Cada uno iniciaba el runtime y compilaba con JIT su propio código de arranque antes de poder hacer cualquier trabajo. La versión 11.0 los fusiona en un único proceso `CSDevKit` compilado con Native AOT, así que esa ruta de arranque ya no carga un runtime ni ejecuta el JIT.

El servicio de lenguaje de C# (Roslyn) sigue ejecutándose en su propio proceso, por lo que las cifras de memoria de abajo corresponden solo al lado de Dev Kit. Aun así, la reducción es grande:

| Solución | Proyectos | Archivos de C# | 3.3 | 11.0 |
|----------|----------|----------|-----|------|
| Orleans | 155 | 4 010 | 1 307 MB | 208 MB |
| Roslyn | 398 | 18 153 | 2 000 MB | 379 MB |
| Aspire | 407 | 4 686 | 2 072 MB | 316 MB |

Eso es aproximadamente entre 81 % y 85 % menos memoria en los tres repositorios.

## Una caché de proyectos que puedes confirmar en el repositorio

La otra mitad de la mejora es una caché persistente de proyectos. La primera carga evalúa tus proyectos y guarda los resultados. Las aperturas posteriores leen de la caché y se saltan la evaluación completa en tiempo de diseño. En el repositorio de Aspire, el archivo activo se puede usar en 0,47 s en lugar de 84,1 s, y la solución completa está lista en 3,0 s. Orleans tarda 0,53 s para el archivo activo y 2,3 s para la solución completa, frente a 50,3 s.

La publicación del blog también dice que, si confirmas los archivos de la caché en el control de versiones, los clones nuevos y los nuevos worktrees de git obtienen herramientas rápidas de inmediato. Esto importa si trabajas con varios worktrees de git en paralelo, por ejemplo para agentes de programación en paralelo. Hoy, cada worktree nuevo te cuesta otra carga de proyectos en frío. El anuncio no indica los nombres de los archivos de la caché ni qué la invalida, así que revisa lo que la extensión escribe en tu repositorio antes de modificar `.gitignore`.

Las compilaciones incrementales también son más rápidas. Una compilación sin cambios de la solución de Aspire tarda 0,88 s en lugar de 34,4 s, y una compilación después de cambiar un archivo tarda 2,1 s en lugar de 36,1 s.

## Los archivos de MSBuild obtienen IntelliSense de verdad

La versión 11.0 también agrega compatibilidad de lenguaje para archivos `.csproj`, `.props` y `.targets`: autocompletado, diagnósticos, ir a la definición, correcciones rápidas y resaltado semántico. Los nombres y versiones de paquetes se completan mientras escribes, y CodeLens muestra una advertencia encima de los paquetes con vulnerabilidades conocidas:

```xml
<ItemGroup>
  <!-- package id and version now complete; vulnerable versions get a CodeLens warning -->
  <PackageReference Include="MessagePack" Version="3.1.11" />
</ItemGroup>
```

Una nueva vista "C# Doctor" reúne en un solo lugar las comprobaciones de SDK, runtime, target framework, restauración y vulnerabilidades. Ya no tienes que revisar los canales de salida para averiguar por qué un proyecto no se cargó.

## Cómo probar la versión preliminar

La versión 11.0 sigue siendo una versión preliminar. En la vista de Extensiones, abre C# Dev Kit y elige **Switch to Pre-Release Version**. También puedes hacerlo desde una terminal:

```bash
code --install-extension ms-dotnettools.csdevkit --pre-release
```

Para comprobar las cifras de memoria en tu propia solución, busca el proceso consolidado después de que la solución termine de cargarse:

```bash
# macOS / Linux: resident memory in KB
ps -A -o rss,comm | grep -i csdevkit
```

Reporta las regresiones en [microsoft/vscode-dotnettools](https://github.com/microsoft/vscode-dotnettools). Una reescritura de este tamaño tendrá asperezas en algunos diseños de proyectos, y el equipo está recopilando esos reportes antes de la versión estable.
