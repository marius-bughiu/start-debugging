---
title: "Cómo usar Tailwind CSS con Blazor WebAssembly en .NET 11"
description: "Configuración completa en .NET 11 para Tailwind CSS v4 en una app Blazor WebAssembly: CLI standalone (sin Node), target de MSBuild, directivas @source para archivos Razor y CSS isolation, y un pipeline de publish que sobrevive a Native AOT."
pubDate: 2026-05-03
tags:
  - "blazor"
  - "blazor-webassembly"
  - "tailwind-css"
  - "dotnet-11"
  - "csharp"
  - "msbuild"
lang: "es"
translationOf: "2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-03
---

La configuración mínima viable de Tailwind v4 para una app Blazor WebAssembly en .NET 11 tiene tres piezas en movimiento: el binario standalone del CLI de Tailwind (sin Node, sin npm), un target de MSBuild `BeforeBuild` que lo ejecuta, y un archivo `Styles/app.css` cuyas directivas `@source` apuntan a tus archivos `.razor` y `.razor.css`. El CLI compila a `wwwroot/css/app.css`, tú referencias ese archivo desde `wwwroot/index.html`, y la compilación agrega aproximadamente un segundo en una corrida en frío y de 50 a 150 ms en recompilaciones incrementales. El mismo pipeline sobrevive a `dotnet publish`, al trimming y a Native AOT, ninguno de los cuales toca CSS pero todos rompen las configuraciones ingenuas basadas en Node.

Esta guía recorre la integración completa sobre `Microsoft.AspNetCore.Components.WebAssembly` 11.0.0 con Tailwind CSS 4.0.x, C# 14, y el SDK fijado en `global.json` a `9.0.100` o más reciente (el SDK de .NET 11 se publica como `9.0.100` hasta GA). Cada afirmación de abajo fue verificada contra un proyecto vacío `dotnet new blazorwasm-empty` en Windows 11 y Ubuntu 24.04.

## Por qué las plantillas basadas en Node no sobreviven a una compilación de Blazor

La mayoría de los tutoriales de "Tailwind en Blazor" todavía te dicen que instales Node, ejecutes `npm install -D tailwindcss`, escribas un `tailwind.config.js` y llames a `npx tailwindcss` desde un target de compilación. Esa configuración funciona en una laptop de desarrollador y explota la primera vez que se ejecuta en un contenedor limpio o en una imagen de CI sin Node:

- El target de MSBuild llama a `npx`, que falla rápido con `'npx' is not recognized`. El paso `dotnet publish` sale con código 1 y un stack trace que apunta dentro de MSBuild en lugar de tu código.
- `package.json` y `node_modules` terminan versionados junto al `.csproj`, duplicando el tiempo de restore e inflando el repo con cientos de megabytes de paquetes npm transitivos cuyo único trabajo es compilar un solo archivo CSS.
- La ruta basada en PostCSS de Tailwind v4 usa [Lightning CSS](https://lightningcss.dev/), que distribuye binarios nativos por OS y CPU. Un `package-lock.json` horneado en Windows falla en un agente de compilación Linux, con un paso `npm rebuild` añadido como solución alternativa.

[Tailwind v4](https://tailwindcss.com/blog/tailwindcss-v4) lanzó un CLI standalone explícitamente para esquivar todo este stack. Es un único binario, de unos 80 MB, que contiene el compilador completo y el escáner de contenido Oxide. Lo dejas junto a tu repo (o lo instalas a nivel de sistema), lo invocas desde MSBuild, y la única dependencia que necesita una imagen de CI es el archivo en sí.

## Obtén el CLI standalone de Tailwind v4

Tailwind publica binarios por plataforma en cada release. Elige el que coincida con tus agentes de compilación y máquinas de desarrollo:

- Windows x64: `tailwindcss-windows-x64.exe`
- Linux x64: `tailwindcss-linux-x64`
- macOS arm64: `tailwindcss-macos-arm64`

Descárgalo desde la [página de releases de Tailwind CSS](https://github.com/tailwindlabs/tailwindcss/releases) y o bien deja el archivo en `tools/tailwindcss.exe` dentro de tu repo (commiteado, ~80 MB), o instálalo a nivel de sistema vía `winget install --id TailwindLabs.Tailwind` en Windows o `brew install tailwindcss` en macOS.

El enfoque de binario commiteado es el que aguanta en CI sin sorpresas, porque la compilación no necesita acceso a la red y cada colaborador obtiene exactamente la misma versión de Tailwind. La contrapartida son ~80 MB en tu historial de Git. Si eso te molesta, guárdalo en [Git LFS](https://git-lfs.com/) o tráelo al vuelo en un target `Restore`. Para el resto de este post asumiré que el binario vive en `tools/tailwindcss.exe`.

```text
MyBlazorApp/
├── MyBlazorApp.csproj
├── Styles/
│   └── app.css
├── tools/
│   └── tailwindcss.exe   <-- standalone v4 binary
└── wwwroot/
    ├── index.html
    └── css/
        └── app.css        <-- generated, gitignored
```

Agrega el archivo generado a `.gitignore`:

```text
# .gitignore
wwwroot/css/app.css
```

El CSS generado es un artefacto puro de compilación; commitearlo produce diffs ruidosos cada vez que alguien cambia un nombre de clase en un componente.

## Conecta el CLI a tu `.csproj`

Abre `MyBlazorApp.csproj` y agrega un target `BeforeBuild`. La tarea `Exec` invoca el CLI standalone con la entrada, salida y (en `Release`) un flag `--minify` correctos.

```xml
<!-- MyBlazorApp.csproj  (.NET 11, Tailwind CSS 4) -->
<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TailwindCli>$(MSBuildProjectDirectory)/tools/tailwindcss.exe</TailwindCli>
    <TailwindInput>$(MSBuildProjectDirectory)/Styles/app.css</TailwindInput>
    <TailwindOutput>$(MSBuildProjectDirectory)/wwwroot/css/app.css</TailwindOutput>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly" Version="11.0.0" />
    <PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly.DevServer" Version="11.0.0" PrivateAssets="all" />
  </ItemGroup>

  <Target Name="TailwindBuild" BeforeTargets="BeforeBuild">
    <Exec Command="&quot;$(TailwindCli)&quot; -i &quot;$(TailwindInput)&quot; -o &quot;$(TailwindOutput)&quot; $(TailwindArgs)"
          ConsoleToMSBuild="true" />
  </Target>

  <Target Name="TailwindBuildRelease" BeforeTargets="TailwindBuild" Condition="'$(Configuration)' == 'Release'">
    <PropertyGroup>
      <TailwindArgs>--minify</TailwindArgs>
    </PropertyGroup>
  </Target>
</Project>
```

Dos cosas que vale la pena saber sobre este target. Primero, el comando `Exec` cita cada ruta para que la compilación siga funcionando cuando el proyecto vive en `C:\Users\you\Documents\My Apps\Blazor`. Segundo, el flag `--minify` solo se dispara en `Release`, lo que mantiene rápidas las compilaciones de `Debug` y te da CSS legible en las dev tools del navegador durante el desarrollo.

En Linux y macOS puedes reemplazar la ruta específica de Windows con una condición por OS:

```xml
<TailwindCli Condition="'$(OS)' == 'Windows_NT'">$(MSBuildProjectDirectory)/tools/tailwindcss.exe</TailwindCli>
<TailwindCli Condition="'$(OS)' != 'Windows_NT'">$(MSBuildProjectDirectory)/tools/tailwindcss</TailwindCli>
```

Ambos binarios comparten la misma superficie de CLI; la única diferencia es el nombre del archivo y el bit ejecutable en Unix.

## Dile a Tailwind dónde viven tus clases

El cambio más grande de Tailwind v4 para usuarios de Blazor es la desaparición de `tailwind.config.js`. El framework ahora hace configuración CSS-first: pones bloques `@theme`, `@source` y `@layer` directamente en tu archivo CSS de entrada, y no hay configuración de JavaScript en absoluto. Eso son buenas noticias para proyectos .NET, que no tenían razón para arrastrar un toolchain de JS para definir una paleta de colores.

Crea `Styles/app.css` y dile a Tailwind dónde buscar nombres de clases. Por defecto, v4 solo escanea el sistema de archivos relativo al CSS de entrada, así que sin directivas `@source` explícitas no encontrará nada en tus archivos Razor.

```css
/* Styles/app.css -- Tailwind CSS 4.0 */
@import "tailwindcss";

@source "../**/*.razor";
@source "../**/*.razor.cs";
@source "../**/*.razor.css";
@source "../**/*.cshtml";
@source "../wwwroot/index.html";

@theme {
  --color-brand-50:  oklch(96% 0.02 260);
  --color-brand-500: oklch(64% 0.18 260);
  --color-brand-900: oklch(28% 0.10 260);

  --font-sans: "Inter", "Segoe UI", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "Cascadia Code", monospace;
}

@layer components {
  .btn-primary {
    @apply inline-flex items-center gap-2 rounded-md
           bg-brand-500 px-4 py-2 text-sm font-medium text-white
           hover:bg-brand-900 focus-visible:outline-2 focus-visible:outline-offset-2
           focus-visible:outline-brand-500 transition-colors;
  }
}
```

Algunos detalles a destacar. El glob `../**/*.razor.cs` captura archivos code-behind donde podrías ensamblar nombres de clases dinámicamente, p. ej. `var classes = active ? "bg-brand-500" : "bg-gray-100";`. El escáner de contenido de Tailwind es un extractor basado en regex (el [motor Oxide](https://tailwindcss.com/blog/tailwindcss-v4#new-high-performance-engine)), así que mientras la cadena literal aparezca en cualquier parte de un archivo escaneado, terminará en la salida. El bloque `@theme` define design tokens como propiedades CSS personalizadas, que Tailwind luego expone como utilidades (`bg-brand-500`, `text-brand-900`). Esto reemplaza por completo el bloque `theme: { extend: { colors: ... } }` de JavaScript de la v3.

Conecta el archivo generado en `wwwroot/index.html`:

```html
<!-- wwwroot/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MyBlazorApp</title>
  <base href="/" />
  <link rel="stylesheet" href="css/app.css" />
  <link rel="stylesheet" href="MyBlazorApp.styles.css" />
</head>
<body>
  <div id="app">Loading...</div>
  <script src="_framework/blazor.webassembly.js"></script>
</body>
</html>
```

El link a `MyBlazorApp.styles.css` es el bundle de CSS isolation de Blazor, que el SDK genera a partir de cada archivo `Component.razor.css` del proyecto. El orden importa: carga `app.css` primero para que los estilos con scope de componente puedan sobrescribir los defaults de Tailwind.

## Haz que CSS isolation se lleve bien

El CSS isolation de Blazor agrega un atributo de scope por componente (p. ej. `b-9pdypsqo3w`) a cada selector y reescribe los elementos para que lleven ese atributo. Las utilidades de Tailwind aplicadas directamente a elementos en el markup heredan el scope automáticamente, pero las directivas `@apply` dentro de un archivo `Component.razor.css` necesitan un poco de cuidado.

Esto funciona:

```razor
@* Pages/Counter.razor *@
<button class="btn-primary" @onclick="IncrementCount">
  Count: @currentCount
</button>
```

`btn-primary` vino de tu bloque `@layer components` en `Styles/app.css`, así que la definición de la clase vive en el `app.css` global. El botón sigue recibiendo el atributo de scope, pero el selector de Tailwind es `.btn-primary` (sin scope), que coincide.

Esto también funciona, y es la forma correcta de escribir utilidades privadas del componente:

```css
/* Pages/Counter.razor.css */
@reference "../../Styles/app.css";

.danger {
  @apply rounded-md bg-red-600 px-3 py-1 text-white;
}
```

La directiva `@reference` (nueva en v4) le dice a Tailwind qué design tokens del archivo de entrada usar sin duplicar su CSS en el bundle del componente. Sin `@reference`, `@apply red-600` no puede resolver, porque el archivo CSS con scope de componente no tiene su propio `@import "tailwindcss";`. Con ella, solo los bytes de la utilidad `red-600` son traídos al bundle con scope, y el atributo de scope se preserva mediante el paso de CSS isolation de Blazor.

Agrega los archivos de isolation a tus patrones `@source` (ya mostrados arriba) para que cualquier clase que escribas inline en archivos `.razor.css` sea extraída junto con el resto. Si solo pones utilidades en el markup y nunca las referencias en `.razor.css`, puedes omitir ese glob.

## Un componente real de principio a fin

Aquí hay una página `Pages/Home.razor` y su CSS con scope, construida sobre los design tokens definidos arriba. Usa utilidades directamente en el markup, llama a una clase de componente personalizada de `app.css`, y agrega una utilidad privada del componente vía `@apply`.

```razor
@* Pages/Home.razor *@
@page "/"

<section class="mx-auto max-w-3xl px-6 py-12">
  <h1 class="font-sans text-4xl font-semibold text-brand-900">
    Tailwind on Blazor WebAssembly
  </h1>
  <p class="mt-3 text-base text-slate-600">
    Built with the standalone CLI, no Node toolchain required.
  </p>

  <div class="mt-8 flex items-center gap-3">
    <button class="btn-primary" @onclick="Refresh">Refresh</button>
    <span class="status">Last refresh: @lastRefresh.ToLocalTime():T</span>
  </div>
</section>

@code {
    private DateTime lastRefresh = DateTime.UtcNow;

    private void Refresh() => lastRefresh = DateTime.UtcNow;
}
```

```css
/* Pages/Home.razor.css */
@reference "../../Styles/app.css";

.status {
  @apply text-sm font-mono text-slate-500;
}
```

Ejecuta `dotnet build`. El target `TailwindBuild` se dispara antes de que el SDK comience a compilar C#, el binario escanea cada archivo Razor y CSS que coincida con los globs de `@source`, y `wwwroot/css/app.css` aterriza solo con las utilidades que realmente usaste. En un proyecto recién creado con `blazorwasm-empty` la salida cae de un teórico Tailwind sin minificar de 3.5 MB a aproximadamente 18 KB minificado para la página de arriba. Ese número escala con cuántas utilidades distintas traes a través de toda la app, que es el punto entero de un motor on-demand.

## Compilaciones de producción, `dotnet publish` y Native AOT

`dotnet publish -c Release` ejecuta el mismo target `BeforeBuild` con `--minify` activado. La salida publicada bajo `bin/Release/net11.0/publish/wwwroot/css/app.css` es el archivo minificado listo para compresión Brotli por el pipeline de publish de Blazor (`BlazorEnableCompression`, activado por defecto).

Hay algunas asperezas que conviene conocer:

- **Native AOT para Blazor WebAssembly**: el paso de compilación AOT (`<RunAOTCompilation>true</RunAOTCompilation>`) opera sobre ensamblados .NET, nunca sobre CSS. Tailwind queda completamente fuera de ese pipeline, así que AOT no cambia nada para esta configuración. Los tiempos de publish en frío se estiran de 30 segundos a varios minutos, pero Tailwind sigue siendo un costo de menos de un segundo en esa mezcla.
- **Trimming**: el trimmer tampoco tiene nada que ver con CSS. Sin embargo, ocasionalmente se quejará sobre reflexión dentro de bibliotecas JavaScript adyacentes a Tailwind que podrías agregar (p. ej. helpers headless UI). Mantén esas aisladas a archivos JS referenciados desde `index.html`, no empaquetadas a través de ninguna capa de interop con C#.
- **Bundling de static web assets**: si configuras `<BlazorWebAssemblyLoadAllGlobalizationData>` o usas [las opciones de compresión en publish-time de Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/host-and-deploy/webassembly), `wwwroot/css/app.css` se incluye automáticamente. No hay cableado extra.
- **Modo watch**: `dotnet watch` vuelve a ejecutar el target `BeforeBuild` en cada cambio de archivo Razor, así que agregar una clase a un componente dispara una recompilación de Tailwind y el navegador hace hot-reload de la nueva hoja de estilos en menos de un segundo. Si quieres watching solo de CSS de verdad (más barato que la recompilación completa de Razor), ejecuta `tools/tailwindcss.exe --watch` en una terminal separada junto con `dotnet watch run`.

## Trampas que vale la pena conocer

La configuración de arriba es duradera, pero tres cosas muerden consistentemente a la gente al entrar.

Primero, las clases construidas en runtime que el escáner no puede ver en el código fuente no sobrevivirán al purge de Tailwind. `var c = $"bg-{color}-500";` produce `bg-red-500` en runtime, pero Tailwind nunca ve el literal en el código fuente y lo descarta de la salida. La solución es poner en lista blanca el conjunto completo explícitamente vía un comentario:

```csharp
// .NET 11, C# 14: Tailwind scanner sees these literals
// bg-red-500 bg-green-500 bg-blue-500
private static string ColorClass(string color) => $"bg-{color}-500";
```

El extractor basado en regex de Tailwind encuentra esos literales en el comentario y los mantiene en el bundle. La concatenación en runtime luego resuelve a una clase que efectivamente existe en el CSS.

Segundo, las páginas Blazor pre-renderizadas (una configuración híbrida Blazor United donde el host renderiza en servidor el cliente WASM) necesitan que tanto `app.css` como `MyBlazorApp.styles.css` sean alcanzables desde el pipeline de archivos estáticos del servidor. Si divides el proyecto en un host `Server` más un proyecto WASM `Client`, el [layout de validación compartida que cubrí más temprano esta semana](/es/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) es el mismo patrón: el proyecto `Client` posee la compilación de Tailwind, y el `Server` referencia al `Client` para que su `wwwroot` se publique junto al host.

Tercero, integración con IDE. La extensión oficial [Tailwind CSS IntelliSense](https://marketplace.visualstudio.com/items?itemName=bradlc.vscode-tailwindcss) para VS Code lee tu `Styles/app.css` y te da autocompletados dentro de archivos `.razor` una vez que agregas `razor` a la configuración `tailwindCSS.includeLanguages`. Rider y Visual Studio ambos distribuyen plugins de Tailwind a partir de las versiones 2025.1, ambos funcionan de la misma manera: apúntalos al archivo CSS de entrada y recogen los design tokens de `@theme` automáticamente.

## Lecturas relacionadas

- [Cómo compartir lógica de validación entre el servidor y Blazor WebAssembly](/es/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) para el patrón de layout de proyecto que se empareja naturalmente con este pipeline de CSS.
- [dotnet new webworker: Web Workers de primera clase para Blazor en .NET 11 Preview 2](/es/2026/04/dotnet-11-preview-2-blazor-webworker-template/) para descargar trabajo de CPU sin romper tu layout de Tailwind.
- [Blazor Virtualize por fin maneja items de altura variable en .NET 11](/es/2026/04/blazor-virtualize-variable-height-dotnet-11-preview-3/) ya que las filas de altura variable se emparejan mal con utilidades de Tailwind que hornean tamaños fijos.
- [Blazor SSR por fin obtiene TempData en .NET 11](/es/2026/04/blazor-ssr-tempdata-dotnet-11/) para patrones de estilo de mensajes flash que puedes construir con los design tokens de arriba.

## Enlaces a fuentes

- [Notas de la versión de Tailwind CSS v4.0](https://tailwindcss.com/blog/tailwindcss-v4)
- [Releases del CLI standalone de Tailwind CSS](https://github.com/tailwindlabs/tailwindcss/releases)
- [Referencia de las directivas `@source` y `@theme`](https://tailwindcss.com/docs/functions-and-directives)
- [Resumen de CSS isolation de Blazor en MS Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/css-isolation)
- [Notas de la versión de .NET 11](https://github.com/dotnet/core/blob/main/release-notes/11.0/README.md)
