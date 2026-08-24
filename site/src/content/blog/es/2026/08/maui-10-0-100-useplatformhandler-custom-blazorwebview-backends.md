---
title: ".NET MAUI 10.0.100 agrega UsePlatformHandler para backends personalizados de BlazorWebView"
description: "MAUI 10.0.100 incorpora MauiBlazorWebViewBuilderExtensions.UsePlatformHandler, un punto de extensión soportado para reemplazar BlazorWebViewHandler sin reimplementar todo lo que registra AddMauiBlazorWebView(). Dos sobrecargas y una trampa de orden."
pubDate: 2026-08-24
tags:
  - "dotnet"
  - "maui"
  - "blazor"
  - "dotnet-10"
lang: "es"
translationOf: "2026/08/maui-10-0-100-useplatformhandler-custom-blazorwebview-backends"
translatedBy: "claude"
translationDate: 2026-08-24
---

.NET MAUI 10.0.100 [se lanzó el 2026-08-20](https://github.com/dotnet/maui/releases/tag/10.0.100) con 209 commits, y la mayor parte es lo habitual en una versión de servicio: regresiones de desplazamiento en `CollectionView`, márgenes de área segura en el flyout de Shell en Android, un `ActivityIndicator` de iOS que se negaba a desaparecer. Escondida en la lista hay una API pública realmente nueva, y desbloquea una categoría de proyecto que estaba estancada desde que salió Blazor Hybrid: `MauiBlazorWebViewBuilderExtensions.UsePlatformHandler`.

## Por qué AddMauiBlazorWebView() era un callejón sin salida para plataformas personalizadas

`AddMauiBlazorWebView()` hace dos trabajos. Registra la infraestructura compartida que necesita todo BlazorWebView (JSInterop, navegación, resolución de recursos estáticos) y fija `BlazorWebViewHandler` como el handler de `IBlazorWebView`.

El segundo trabajo era el problema. Si estabas construyendo un backend para una plataforma para la que MAUI no distribuye handlers, siendo el caso motivador un renderizador GTK para Linux, el handler integrado simplemente no te servía y no había ningún punto de extensión para reemplazarlo. El [issue #34103](https://github.com/dotnet/maui/issues/34103) detalla la solución alternativa que la gente terminó adoptando: saltarse `AddMauiBlazorWebView()` por completo, volver a registrar a mano cada servicio interno y luego perseguir esos registros cada vez que cambian aguas arriba.

## El nuevo punto de extensión

El [PR #34225](https://github.com/dotnet/maui/pull/34225) agrega dos métodos de extensión sobre `IMauiBlazorWebViewBuilder`:

```csharp
public static IMauiBlazorWebViewBuilder UsePlatformHandler<THandler>(
    this IMauiBlazorWebViewBuilder builder)
    where THandler : IViewHandler, new();

public static IMauiBlazorWebViewBuilder UsePlatformHandler(
    this IMauiBlazorWebViewBuilder builder,
    Func<IServiceProvider, IViewHandler> factory);
```

En `MauiProgram.cs` eso reduce toda la solución alternativa a una sola llamada encadenada:

```csharp
builder.Services
    .AddMauiBlazorWebView()
    .UsePlatformHandler<GtkBlazorWebViewHandler>();
```

Todo lo que registra `AddMauiBlazorWebView()` se mantiene en su lugar. Solo cambia el handler. Internamente el método reenvía a `ConfigureMauiHandlers(h => h.AddHandler<IBlazorWebView, THandler>())`, que es la misma colección de handlers en la que escribe el registro integrado.

Fíjate en la restricción genérica: `where THandler : IViewHandler, new()`. El parámetro de tipo además lleva la anotación `[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicConstructors)]`, para que el recortador conserve el constructor sin parámetros en una compilación recortada o con NativeAOT en lugar de eliminarlo en silencio. Los handlers que necesitan argumentos de constructor pasan por la otra sobrecarga, la de fábrica.

## El orden es el filo peligroso

El reemplazo funciona con la regla de que gana el último registro, y eso corta en ambos sentidos. Llama a `UsePlatformHandler` después de `AddMauiBlazorWebView()` o no hará nada. Más doloroso todavía: si una biblioteca aguas abajo vuelve a llamar a `AddMauiBlazorWebView()` más adelante en tu canal de inicio, esa segunda llamada vuelve a registrar el handler predeterminado y tu backend desaparece sin error y sin advertencia. Cuando compongas la configuración de MAUI Blazor desde varias fuentes, llama a `UsePlatformHandler` al final.

La sobrecarga de fábrica tiene una segunda trampa que conviene conocer. El `IServiceProvider` que te entrega es el proveedor de la fábrica de handlers de MAUI, no el proveedor raíz de la aplicación. Resuelve los servicios registrados a través de `ConfigureMauiHandlers` y nada más, así que buscar ahí un singleton de nivel de aplicación va a fallar.

Ambas sobrecargas están ausentes en `Microsoft.AspNetCore.Components.WebView.Maui` 10.0.90 y presentes en 10.0.100, así que se trata de una incorporación directa de 10.0.100 y no de algo retroportado en silencio. Si sigues el tren de versiones de servicio de .NET MAUI 10, el [despliegue de Material 3 en Android terminó en SR6](/es/2026/05/maui-10-material-3-android-usematerial3-flag/).
