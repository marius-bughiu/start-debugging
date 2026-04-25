---
title: "Blazor SSR finalmente obtiene TempData en .NET 11"
description: "ASP.NET Core en .NET 11 Preview 2 trae TempData al renderizado estático del lado servidor de Blazor, habilitando mensajes flash y flujos Post-Redirect-Get sin workarounds."
pubDate: 2026-04-13
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet-11"
  - "ssr"
lang: "es"
translationOf: "2026/04/blazor-ssr-tempdata-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-25
---

Si has construido aplicaciones Blazor SSR estáticas, casi seguramente has chocado contra la misma pared: después de un POST de formulario que redirige, no hay forma incorporada de pasar un mensaje único a la siguiente página. MVC y Razor Pages tuvieron `TempData` por más de una década. Blazor SSR no, hasta [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/).

## Cómo funciona TempData en Blazor SSR

Cuando llamas a `AddRazorComponents()` en tu `Program.cs`, TempData se registra automáticamente. Sin conexión de servicios adicional. Dentro de cualquier componente SSR estático, agárralo como un parámetro en cascada:

```csharp
@code {
    [CascadingParameter]
    public ITempData? TempData { get; set; }

    private void HandleSubmit()
    {
        // Store a flash message before redirecting
        TempData?.Set("StatusMessage", "Record saved.");
        Navigation.NavigateTo("/dashboard", forceLoad: true);
    }
}
```

En la página de destino, lee el valor. Una vez que llamas a `Get`, la entrada se elimina del almacén:

```csharp
@code {
    [CascadingParameter]
    public ITempData? TempData { get; set; }

    private string? StatusMessage;

    protected override void OnInitialized()
    {
        StatusMessage = TempData?.Get<string>("StatusMessage");
    }
}
```

Ese es el patrón clásico Post-Redirect-Get, y ahora funciona en Blazor SSR sin gestión de estado personalizada.

## Peek y Keep

`ITempData` proporciona cuatro métodos que reflejan el ciclo de vida de TempData de MVC:

- `Get<T>(key)` lee el valor y lo marca para eliminación.
- `Peek<T>(key)` lee sin marcar, así el valor sobrevive a la siguiente solicitud.
- `Keep()` retiene todos los valores.
- `Keep(key)` retiene un valor específico.

Estos te dan control sobre si un mensaje flash desaparece después de una lectura o permanece para una segunda redirección.

## Proveedores de almacenamiento

Por defecto, TempData está basado en cookies a través de `CookieTempDataProvider`. Los valores se cifran con ASP.NET Core Data Protection, así que obtienes protección contra manipulación de inmediato. Si prefieres almacenamiento del lado del servidor, intercambia a `SessionStorageTempDataProvider`:

```csharp
builder.Services.AddSession();
builder.Services
    .AddSingleton<ITempDataProvider, SessionStorageTempDataProvider>();
```

## El detalle: solo SSR estático

TempData no funciona con los modos de renderizado Blazor Server interactivo o Blazor WebAssembly. Está limitado a SSR estático, donde cada navegación es una solicitud HTTP completa. Para escenarios interactivos, `PersistentComponentState` o tu propio estado en cascada siguen siendo las herramientas correctas.

Esta es una pequeña adición, pero elimina una de las quejas comunes de "¿por qué Blazor no puede hacer lo que Razor Pages puede?". Toma [.NET 11 Preview 2](https://dotnet.microsoft.com/download/dotnet/11.0) y pruébalo en tu próximo flujo de formulario SSR.
