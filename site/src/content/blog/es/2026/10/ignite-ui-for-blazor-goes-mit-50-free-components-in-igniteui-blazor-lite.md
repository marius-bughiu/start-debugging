---
title: "Ignite UI for Blazor pasa a MIT: más de 50 componentes gratuitos en IgniteUI.Blazor.Lite 1.0.0"
description: "Infragistics publicó como código abierto bajo MIT más de 50 controles de Ignite UI for Blazor, distribuidos como IgniteUI.Blazor.Lite e IgniteUI.Blazor.GridLite 1.0.0 para net8.0, net9.0 y net10.0. Qué es gratuito, cómo configurarlo y los detalles a tener en cuenta."
pubDate: 2026-10-28
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet"
  - "nuget"
lang: "es"
translationOf: "2026/10/ignite-ui-for-blazor-goes-mit-50-free-components-in-igniteui-blazor-lite"
translatedBy: "claude"
translationDate: 2026-10-28
---

El 27 de octubre de 2026 el equipo de ASP.NET [anunció](https://devblogs.microsoft.com/dotnet/blazor-welcomes-infragistics/) que Infragistics es ahora un colaborador de Blazor, y lo más importante para la mayoría de nosotros es la licencia: más de 50 controles de Ignite UI for Blazor ahora son MIT, gratuitos para uso comercial, con el código fuente en [GitHub](https://github.com/IgniteUI/igniteui-blazor). No es un nivel de prueba. Es un subconjunto permanente de la suite comercial.

## Qué es realmente gratuito

Dos paquetes, ambos en la versión 1.0.0 en NuGet y ambos con destino `net8.0`, `net9.0` y `net10.0`:

- `IgniteUI.Blazor.Lite`: controles de entrada, navegación y diseño. Combo, Date Picker, Date Range Picker, Tree, Stepper, Tile Manager, Splitter, Dialog, Tabs, Calendar, Mask Input, Slider, Rating, Chat (versión preliminar) y unos 40 más.
- `IgniteUI.Blazor.GridLite`: una cuadrícula de datos ligera con filtrado de columnas y plantillas de celda personalizadas.

La Grid completa, Tree Grid, Pivot Grid, Hierarchical Grid y Dock Manager siguen siendo comerciales en el paquete `IgniteUI.Blazor`. Si necesitas agrupación, edición o exportación a Excel, Grid Lite no es esa cuadrícula.

## Configuración en una Blazor Web App

```bash
dotnet add package IgniteUI.Blazor.Lite --version 1.0.0
```

Registra los servicios en `Program.cs` e importa el espacio de nombres en `_Imports.razor`:

```csharp
builder.Services.AddIgniteUIBlazor();
```

```razor
@using IgniteUI.Blazor.Controls
```

Luego agrega un tema en `Components/App.razor` (o en `wwwroot/index.html` para WebAssembly independiente):

```html
<link href="_content/IgniteUI.Blazor/themes/light/bootstrap.css" rel="stylesheet" />
```

Fíjate en la ruta: es `_content/IgniteUI.Blazor/`, no `_content/IgniteUI.Blazor.Lite/`. Revisé el paquete 1.0.0 y el `BasePath` de sus recursos web estáticos es `_content/IgniteUI.Blazor`, así que los paquetes Lite y comercial comparten las mismas URL de recursos. Si adivinas la ruta "obvia", obtendrás componentes sin estilos y un 404 en la pestaña de red. Los temas se incluyen en `bootstrap`, `fluent`, `indigo` y `material`, cada uno en `light` y `dark`.

No hace falta ninguna etiqueta `<script>`. Un inicializador de JavaScript carga los web components cuando arranca Blazor.

## Un Combo con enlace de datos real

`IgbCombo` es genérico sobre `TValue` y `TItem`, y `Value` es siempre un `TValue[]`, incluso con `SingleSelect`. Eso confunde a muchos la primera vez:

```razor
@rendermode InteractiveServer

<IgbCombo TItem="City" TValue="int"
          Data="cities"
          ValueKey="Id"
          DisplayKey="Name"
          Label="Destination"
          SingleSelect="true"
          @bind-Value="selected" />

<p>Selected id: @(selected.FirstOrDefault())</p>

@code {
    record City(int Id, string Name);

    City[] cities = [new(1, "Bucharest"), new(2, "Cluj"), new(3, "Iasi")];
    int[] selected = [];
}
```

La línea `@rendermode` es importante. Los componentes se basan en interoperabilidad con JavaScript, por lo que necesitan `InteractiveServer`, `InteractiveWebAssembly` o `InteractiveAuto`. El SSR estático no es compatible, y una página sin modo de renderizado solo muestra marcado inerte.

## Lo que llega con .NET 11

Los ingenieros de Infragistics también aportaron dos analizadores de Blazor, integrados para .NET 11 en [dotnet/aspnetcore#67176](https://github.com/dotnet/aspnetcore/pull/67176) y [#67383](https://github.com/dotnet/aspnetcore/pull/67383). El primero señala las llamadas a `StateHasChanged()` que `ComponentBase` ya vuelve redundantes, como una llamada justo antes del primer `await` en `OnInitializedAsync`, e incluye una corrección de código que las elimina. El segundo advierte cuando una clase llama a `GetAuthenticationStateAsync()` sin suscribirse a `AuthenticationStateChanged`, que es la forma de terminar con un usuario en caché desactualizado.

También hay una skill `use-igniteui-blazor` en [dotnet/skills](https://github.com/dotnet/skills/tree/main/plugins/dotnet-blazor/skills/use-igniteui-blazor) para agentes de programación, además de un generador de plantillas que aún está en revisión en [dotnet/Scaffolding#3823](https://github.com/dotnet/Scaffolding/pull/3823).

Para los equipos que descartaron a los proveedores de componentes por las licencias por puesto, un Combo, un Date Range Picker y un Tree gratuitos bajo MIT, que cumplen el nivel exigido por el equipo de Blazor en recorte (trimming) y accesibilidad, merecen una prueba de concepto esta semana.
