---
title: "Fix: RZ10012: Found markup element with unexpected name en Blazor"
description: "El compilador de Razor de Blazor emite RZ10012 cuando una etiqueta en PascalCase no tiene un tipo de componente correspondiente en el ámbito. Agrega @using para el namespace del componente en _Imports.razor, o @namespace en el componente, y recompila."
pubDate: 2026-05-12
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "blazor"
  - "razor"
lang: "es"
translationOf: "2026/05/fix-rz10012-found-markup-element-with-unexpected-name-blazor"
translatedBy: "claude"
translationDate: 2026-05-12
---

La solución: el compilador de Razor vio una etiqueta en PascalCase (por ejemplo `<NavMenu />` o `<MudButton />`) y no pudo enlazarla a un tipo de componente que esté en el ámbito de ese archivo. Agrega `@using <namespace>` ya sea al archivo `.razor` padre o a un `_Imports.razor` que lo cubra, y recompila. Si el componente vive en una Razor Class Library (RCL) cuya estructura de carpetas no coincide con su namespace, agrega también `@namespace <FullNamespace>` al archivo `.razor` del componente. Borra `bin/`, `obj/` y `.vs/` si la advertencia persiste en el IDE después de una compilación limpia.

```text
RZ10012: Found markup element with unexpected name 'NavMenu'.
If this is intended to be a component, add a @using directive for its namespace.
```

Esta guía está escrita contra .NET 11 preview 4, el Razor SDK incluido en `Microsoft.AspNetCore.App` 11.0.0-preview.4 y Visual Studio 17.13. El ID de diagnóstico `RZ10012` y el texto exacto han sido estables desde .NET Core 3.1, por lo que las soluciones siguientes aplican sin cambios a .NET 6, 7, 8, 10 y 11. Blazor Server, Blazor WebAssembly, Blazor United y las Razor Class Libraries emiten todas el mismo diagnóstico desde el mismo paso del compilador.

RZ10012 es una **advertencia del compilador** por defecto, no un error. El proyecto sigue compilando. Si la etiqueta realmente está pensada como un componente y haces el deploy sin corregirla, en tiempo de ejecución la etiqueta se renderiza como **HTML literal** (un elemento `<NavMenu></NavMenu>` sin hijos), los manejadores de clic nunca se enganchan y los parámetros desaparecen silenciosamente. Por eso el resto de este post la trata como un error que vale la pena bloquear en la compilación.

## Por qué el compilador de Razor cree que tu etiqueta es "unexpected"

El compilador de Razor clasifica cada elemento en un archivo `.razor` con una sola regla: una etiqueta cuyo nombre empieza con una **letra ASCII en mayúscula** es una referencia a un componente; cualquier otra cosa es HTML. Cuando ve `<NavMenu />`, recorre la tabla de **tag helper descriptors** del archivo actual, buscando un tipo de componente cuyo nombre corto coincida y cuyo namespace esté importado por una directiva `@using` que aplique a ese archivo.

Si ningún descriptor coincide, el compilador tiene dos opciones: asumir HTML y emitir una advertencia para que un humano corrija el rumbo, o hacer fallar la compilación. Los diseñadores eligieron la primera, por eso RZ10012 es una advertencia. La tabla de descriptores se llena desde tres fuentes, en este orden:

1. **Directivas `@using` en el propio archivo.** Ámbito léxico, solo el archivo que las declara.
2. **Archivos `_Imports.razor`**, aplicados **de abajo hacia arriba por carpeta**. El `_Imports.razor` junto al archivo aplica primero, luego el de la carpeta padre, y así hasta la raíz del proyecto.
3. **Imports a nivel de proyecto** que el SDK inyecta: `Microsoft.AspNetCore.Components`, `Microsoft.AspNetCore.Components.Web` y algunos más. Por eso no tienes que importar `<EditForm>` manualmente.

Ten en cuenta que `_Imports.razor` **no es transitivo entre proyectos**. Un `_Imports.razor` dentro de una Razor Class Library no fluye hacia la aplicación que la consume. El `_Imports.razor` del consumidor (o la propia página) tiene que declarar `@using MyRcl` para que `<MyRclComponent />` se enlace.

## El archivo mínimo que reproduce el problema

La reproducción más pequeña son dos archivos en el mismo proyecto:

```razor
@* .NET 11 preview 4, Razor SDK 11.0.0-preview.4 *@
@* File: Components/Pages/Home.razor *@

<h1>Home</h1>
<NavMenu />
```

```razor
@* File: Components/Layout/NavMenu.razor *@

<nav>Navigation here</nav>
```

`NavMenu` vive en `MyApp.Components.Layout`. `Home.razor` vive en `MyApp.Components.Pages`. Ningún archivo tiene un `@using` para `MyApp.Components.Layout`, y no hay un `_Imports.razor` que los una. Al compilar:

```text
Components\Pages\Home.razor(3,2): warning RZ10012: Found markup element with unexpected name 'NavMenu'. If this is intended to be a component, add a @using directive for its namespace.
```

En tiempo de ejecución, la página renderiza `<navmenu></navmenu>` como una etiqueta HTML literal.

## Las cuatro soluciones, ordenadas

Aplícalas en este orden. Detente en la primera que resuelva tu caso.

### 1. Agrega `@using` al `_Imports.razor` más cercano

Esta es la solución canónica y la que el propio texto de la advertencia te indica. Suelta una sola línea en el `_Imports.razor` que cubre tu árbol de componentes:

```razor
@* File: Components/_Imports.razor *@
@using MyApp.Components.Layout
@using MyApp.Components.Shared
```

Si todavía no existe un `_Imports.razor` para la carpeta, créalo. La plantilla por defecto de `dotnet new blazor` coloca uno en `Components/_Imports.razor` con los usings comunes ya conectados.

Esto funciona porque el Razor SDK alimenta al compilador con cada `_Imports.razor` entre la raíz del proyecto y el archivo actual, como si sus directivas aparecieran en la parte superior del archivo actual. Agregar un using aquí se propaga a todo `.razor` que esté en esa carpeta o por debajo, incluyendo layouts, páginas y parciales.

### 2. Agrega `@using` directamente al archivo `.razor` consumidor

Cuando el componente se referencia desde exactamente un archivo y quieres mantener contenida la contaminación de namespaces, declara el using en línea:

```razor
@* File: Components/Pages/Home.razor *@
@using MyApp.Components.Layout

<h1>Home</h1>
<NavMenu />
```

Mecánicamente idéntico a la solución 1, simplemente con ámbito más reducido. Útil cuando dos carpetas definen componentes con el mismo nombre corto y solo quieres desambiguar en un sitio.

### 3. Agrega `@namespace` al componente (caso de Razor Class Library)

Cuando el componente vive en una RCL, el namespace autogenerado se deriva de `RootNamespace` más la ruta del archivo relativa al archivo de proyecto de la RCL. Si el `RootNamespace` de la RCL no coincide con su namespace real, o el archivo vive bajo una carpeta cuyo nombre el compilador de C# no acepta literalmente (números, guiones), el namespace generado no coincidirá con lo que importa el consumidor. Agrega `@namespace` para arreglar la discrepancia en el origen:

```razor
@* File: src/MyRcl/Components/Button.razor *@
@namespace MyRcl.Components

<button class="my-rcl-button" @onclick="OnClick">@ChildContent</button>

@code {
    [Parameter] public RenderFragment? ChildContent { get; set; }
    [Parameter] public EventCallback OnClick { get; set; }
}
```

Ahora el consumidor puede `@using MyRcl.Components` y obtener un enlace limpio. Sin `@namespace`, Razor generaría `MyRcl.src.MyRcl.Components` o `Some.RootNamespace.src.MyRcl.Components` dependiendo de cómo esté organizada la RCL, y tu `@using` fallaría silenciosamente al buscar el tipo.

También puedes establecer `RootNamespace` en el `.csproj` de la RCL para saltarte por completo la nomenclatura basada en carpetas:

```xml
<!-- src/MyRcl/MyRcl.csproj -->
<PropertyGroup>
  <RootNamespace>MyRcl</RootNamespace>
</PropertyGroup>
```

### 4. Limpia la caché del IDE cuando la advertencia persiste tras una compilación limpia

El servicio de lenguaje de Razor en Visual Studio cachea los descriptores de tag helpers por proyecto. Después de agregar una referencia de proyecto o renombrar un namespace, la caché puede seguir reportando RZ10012 aunque `dotnet build` desde un `obj/` fresco esté limpio. El reset fiable:

```powershell
# Close Visual Studio first, then from the solution root:
Remove-Item -Recurse -Force .vs, **/bin, **/obj
dotnet build
```

Reabre la solución. La primera compilación de IntelliSense rehidratará la caché de descriptores con el estado posterior a la corrección. Si usas JetBrains Rider, el equivalente es **File > Invalidate Caches**.

## Haz que la advertencia falle la compilación

La severidad por defecto envía a producción compilaciones que renderizan páginas rotas. Dos formas de elevarla:

**Específica (recomendada):** trata solo RZ10012 como error.

```xml
<!-- MyApp.csproj, .NET 11 preview 4 -->
<PropertyGroup>
  <WarningsAsErrors>$(WarningsAsErrors);RZ10012</WarningsAsErrors>
</PropertyGroup>
```

El prefijo `$(WarningsAsErrors);` preserva cualquier cosa que el SDK ya haya promovido, lo cual importa porque los SDK de .NET más nuevos suman entradas a esa lista con el tiempo.

**Global:** trata todas las advertencias como errores. Disciplina más sana en general, pero te obliga a perseguir cada otra advertencia que el SDK haya emitido alguna vez, lo cual es más limpieza de la que la mayoría de los equipos quieren para una sola corrección.

```xml
<PropertyGroup>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
</PropertyGroup>
```

Como sea, un `@using` faltante ahora detiene la compilación en vez de filtrarse a QA como un ticket de "el botón no hace nada".

## Variantes comunes que aterrizan aquí por error

**Nombre de etiqueta en minúscula.** `<navMenu />` no dispara RZ10012, porque la primera letra es minúscula y Razor la clasifica como HTML. Si tu componente se renderiza como marcado literal y **no** hay advertencia, tienes un bug de capitalización, no de namespace. Renombra la etiqueta a PascalCase.

**`@inherits` enmascarando el componente.** En .NET 7.0.302 y anteriores hay un problema conocido ([dotnet/razor#8800](https://github.com/dotnet/razor/issues/8800)) donde agregar `@inherits MyBase` a un componente causaba que el compilador perdiera su carácter de componente y emitiera RZ10012 dondequiera que se usara. Corregido en .NET 8. Si todavía estás en .NET 7 y no puedes actualizar, trabaja alrededor heredando en `@code { protected partial class ... }` en vez de mediante la directiva.

**Biblioteca de componentes de terceros no registrada.** Cuando usas MudBlazor, Radzen, Telerik o Syncfusion, la biblioteca envía un snippet de `_Imports.razor` que tienes que pegar en el tuyo. Olvidarlo significa que cada `<MudButton />` se enciende con RZ10012. La página de "getting started" del proveedor tiene la lista exacta (MudBlazor necesita `@using MudBlazor`, Radzen necesita `@using Radzen` y `@using Radzen.Blazor`, etc.).

**Componente genérico con parámetro de tipo.** `<MyList T="string" />` igual avisa si `MyList<T>` no está en el ámbito. El atributo `T="..."` no importa un namespace; la regla del `@using` aplica de la misma forma.

**Falso positivo del editor en VS 17.4.x.** [dotnet/razor#8146](https://github.com/dotnet/razor/issues/8146) sigue una serie de falsos positivos en lanzamientos tempranos de VS 2022. Si la compilación está limpia y solo el IDE marca RZ10012, actualiza VS a 17.6 o superior y limpia `.vs/` como en la solución 4.

**Componente en un proyecto referenciado que apunta a otro framework.** Una Razor Class Library apuntando a `net6.0` consumida por una app `net11.0` puede no exponer sus componentes si a la RCL le falta `<UseRazorSourceGenerator>true</UseRazorSourceGenerator>` o tiene una referencia al SDK desactualizada. Actualiza el `<PackageReference>` de la RCL a `Microsoft.AspNetCore.App` 11 y recompila.

## Una checklist de 30 segundos

Cuando RZ10012 aterriza en CI y tienes un vuelo que tomar, recorre esta lista de arriba a abajo:

1. ¿La etiqueta es PascalCase? Si está en minúscula, renómbrala.
2. ¿El componente está en **este** proyecto? Si sí, `@using` su namespace en el `_Imports.razor` más cercano.
3. ¿El componente está en una RCL? Verifica que la RCL tenga `@namespace` coincidiendo con lo que importas, y que el consumidor referencie el paquete o proyecto de la RCL.
4. ¿Biblioteca de terceros? Pega el snippet del proveedor en `_Imports.razor`.
5. ¿Sigue advirtiendo después de una compilación limpia? Borra `.vs/`, `bin/`, `obj/` y recompila.
6. ¿Quieres que esto falle CI? Agrega `RZ10012` a `<WarningsAsErrors>`.

El noventa por ciento de los casos es paso 2 o paso 4. El resto es plomería de namespaces.

## Relacionados

- [Fix: The type or namespace name could not be found after a project reference](/es/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) cubre el lado C# de la misma familia de fallos de resolución de namespace.
- [Cómo compartir lógica de validación entre servidor y Blazor WebAssembly](/es/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) recorre el tipo de layout multi-proyecto donde RZ10012 muerde más fácilmente.
- [Cómo usar Tailwind CSS con Blazor WebAssembly en .NET 11](/es/2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11/) muestra un layout de proyecto Blazor limpio con el que puedes comparar.
- [Cómo agregar un filtro global de excepciones en ASP.NET Core 11](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) es la contraparte de tiempo de ejecución para atrapar los bugs de "etiqueta renderizada como HTML literal" que RZ10012 habría prevenido.

## Fuentes

- [dotnet/aspnetcore#45427: Referenced Razor Class Library component reporting error RZ10012](https://github.com/dotnet/aspnetcore/issues/45427)
- [dotnet/razor#8800: `@inherits` breaks component recognition](https://github.com/dotnet/razor/issues/8800)
- [dotnet/razor#8146: Unusable Blazor analyzers blinking invalid RZ10012 warnings in VS 17.4.x](https://github.com/dotnet/razor/issues/8146)
- [Microsoft Learn: ASP.NET Core Blazor namespaces](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/?view=aspnetcore-9.0#namespaces)
- [Jonathan Crozier: Treat Blazor component warnings as errors](https://jonathancrozier.com/blog/treat-blazor-component-warnings-as-errors-found-markup-element-with-unexpected-name)
