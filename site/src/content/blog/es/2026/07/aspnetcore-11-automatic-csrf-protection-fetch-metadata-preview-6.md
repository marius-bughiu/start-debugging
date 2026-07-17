---
title: "ASP.NET Core 11 Preview 6 activa la protección CSRF automática"
description: "Preview 6 rechaza por defecto las solicitudes entre orígenes no seguras del navegador, leyendo el encabezado Sec-Fetch-Site en lugar de un token antiforgery. Esto es lo que bloquea y cómo excluir endpoints."
pubDate: 2026-07-17
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "security"
  - "csrf"
  - "csharp"
lang: "es"
translationOf: "2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6"
translatedBy: "claude"
translationDate: 2026-07-17
---

[.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) llegó el 2026-07-15, y el cambio de ASP.NET Core que probablemente afecte tu app es uno para el que no tienes que escribir nada de código: la protección contra cross-site request forgery (CSRF) ahora está activada por defecto, sin configuración, en Minimal APIs, MVC, Razor Pages y Blazor. No depende del token antiforgery clásico. En su lugar lee el encabezado `Sec-Fetch-Site` del navegador.

## Por qué valía la pena reemplazar el baile del token

El modelo antiguo ponía la carga sobre ti. Emitías un token antiforgery en cada formulario, lo validabas en el POST y compartías las claves de Data Protection entre instancias para que el token siguiera descifrándose tras un salto del balanceador de carga. Si olvidabas cualquiera de esas cosas, obtenías o bien un agujero de seguridad o bien un error en runtime (consulta [cuándo el token antiforgery no se pudo descifrar](/es/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/)). Para las APIs que no tenían ningún formulario renderizado en el servidor del que colgar un token, la orientación era aún más confusa.

Fetch Metadata evita todo eso. Los navegadores modernos adjuntan `Sec-Fetch-Site` a cada solicitud, y el valor no puede ser falsificado por script. Preview 6 lo inspecciona (recurriendo al encabezado `Origin`) y registra un veredicto de confianza antes de que se ejecute tu endpoint.

## Qué se permite y qué se rechaza

La regla es deliberadamente estrecha. Las solicitudes del mismo origen, las navegaciones iniciadas por el usuario (escribir una URL, hacer clic en un enlace) y los clientes que no son navegadores (una app móvil, `HttpClient`, curl) se permiten todas. Lo que se rechaza es la forma real de un CSRF: una solicitud de navegador entre orígenes que intenta consumir uno de tus endpoints. Como es automático, las plantillas de Blazor Web App ya no llaman a `app.UseAntiforgery()`.

Sigues conservando las exclusiones donde las necesites. Un webhook público al que hace POST un servicio externo es un cliente que no es navegador, así que pasa, pero si quieres ser explícito:

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// Protected automatically: a cross-origin page cannot POST here from a browser.
app.MapPost("/transfer", (TransferRequest req) => Results.Ok());

// Opt a single endpoint out.
app.MapPost("/webhook", (Payload p) => Results.Ok())
   .DisableAntiforgery();

app.Run();
```

En MVC, la vía de escape por acción no cambia:

```csharp
[HttpPost]
[IgnoreAntiforgeryToken]
public IActionResult Receive(Payload p) => Ok();
```

Para desactivar la característica en toda la app, establece la clave de configuración `DisableCsrfProtection`:

```json
{
  "DisableCsrfProtection": true
}
```

Si la lógica del veredicto integrada no encaja con tu topología, registra una implementación personalizada de `ICsrfProtection` para reemplazar por completo la decisión de confianza.

## Antes de cambiar el runtime

Esta API apareció por primera vez en Preview 4 y se rediseñó en Preview 6 para seguir las convenciones estándar de options, así que si la probaste antes, vuelve a revisar tu configuración. Y trátala como defensa en profundidad, no como un reemplazo de la autenticación: detiene el vector del navegador entre orígenes, no un token bearer robado. Los detalles completos están en las [notas de la versión de ASP.NET Core Preview 6](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md). Instala el SDK de .NET 11 Preview 6, apunta a `net11.0` y audita cualquier endpoint que legítimamente espere POST entre orígenes desde el navegador antes de publicar.
