---
title: "Blazor static SSR obtiene [SupplyParameterFromSession] en .NET 11 Preview 5"
description: "Leer el estado de sesión en Blazor renderizado en el servidor estático significaba acceder a HttpContext.Session y serializar a mano. .NET 11 Preview 5 agrega [SupplyParameterFromSession] para enlazar una propiedad de componente directamente a una clave de sesión."
pubDate: 2026-06-16
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnetcore"
  - "ssr"
  - "csharp"
lang: "es"
translationOf: "2026/06/blazor-supplyparameterfromsession-static-ssr-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-16
---

[.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/), publicado el 2026-06-09, completa la familia de atributos "supply parameter from X" que el renderizado del lado del servidor estático (static SSR) de Blazor ya tenía para cadenas de consulta y datos de formulario. El nuevo es `[SupplyParameterFromSession]`, y enlaza una propiedad de componente a una clave en la sesión del servidor de ASP.NET Core. Si alguna vez llevaste el estado de un asistente de varios pasos a través de cargas de página de static SSR, sabes por qué esto importa.

## Por qué la sesión era la incómoda

Static SSR renderiza HTML plano sin circuito SignalR ni payload de WebAssembly, así que no hay estado de componente en memoria que sobreviva a una navegación. Blazor ya te daba acceso tipado y declarativo a las dos entradas por solicitud obvias: `[SupplyParameterFromQuery]` para la URL y `[SupplyParameterFromForm]` para un cuerpo POST. La sesión era el hueco. Para leerla, hacías cascada del `HttpContext` hacia el componente y pasabas por `HttpContext.Session` tú mismo, con cadenas de clave manuales y serialización manual en ambos lados:

```csharp
@inject IHttpContextAccessor Http

@code {
    private int CurrentStep;

    protected override void OnInitialized()
    {
        var raw = Http.HttpContext?.Session.GetString("checkout-step");
        CurrentStep = raw is null ? 0 : JsonSerializer.Deserialize<int>(raw);
    }
}
```

Cada componente que tocaba la sesión repetía esa ceremonia, y la cadena de clave era un contrato basado en cadenas esperando a desviarse.

## Qué reemplaza el atributo

Preview 5 colapsa la lectura a una declaración de propiedad. El atributo toma un `Name` para la clave de sesión y usa `System.Text.Json` para serializar y deserializar el valor, así que funciona para cualquier tipo que se pueda convertir a JSON, no solo cadenas:

```csharp
@code {
    [SupplyParameterFromSession(Name = "checkout-step")]
    public int CurrentStep { get; set; }
}
```

El framework lee `checkout-step` de la sesión, lo deserializa en `int` y lo asigna antes de que el componente se renderice. Asignar de vuelta a la propiedad escribe el nuevo valor en la sesión, así que un asistente puede avanzar su paso en una sola línea en lugar de un baile de obtener, mutar, serializar y asignar.

La infraestructura es el middleware de sesión estándar de ASP.NET Core, así que igual lo configuras en `Program.cs`:

```csharp
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession();

// ...
app.UseSession();
```

## Dónde encaja

Esta es una de varias pasadas de afinamiento de static SSR en Preview 5. Combina de forma natural con la [validación del lado del cliente para formularios static SSR](/es/2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5/), que llegó en la misma versión: enlaza el estado de trabajo del formulario a una clave de sesión, valida en el navegador y mantén el modo de renderizado barato durante todo un flujo de pago. El ordenamiento y la paginación de QuickGrid ahora también funcionan en static SSR, así que el patrón de "sensación interactiva, cero circuito" sigue ampliándose.

Para probarlo, instala el SDK de .NET 11 Preview 5, apunta a `net11.0` y revisa las [notas de la versión de ASP.NET Core Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/aspnetcore.md) para la lista completa.
