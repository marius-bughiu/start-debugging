---
title: "Los formularios SSR estáticos de Blazor obtienen validación del lado del cliente en .NET 11 Preview 5"
description: "Los formularios de Blazor renderizados de forma estática en el servidor solo podían validarse tras un POST completo de ida y vuelta. .NET 11 Preview 5 renderiza los metadatos de validación para que el JS de Blazor aplique las reglas de DataAnnotations en el navegador, sin circuito."
pubDate: 2026-06-11
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnetcore"
  - "ssr"
  - "csharp"
lang: "es"
translationOf: "2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-11
---

[.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) salió el 2026-06-09, y un cambio en ASP.NET Core cierra una brecha que ha molestado a cualquiera que construya formularios sobre renderizado estático del lado del servidor (static SSR): los formularios ahora se validan en el navegador sin un modo de renderizado interactivo. Hasta esta versión preliminar, un formulario static SSR tenía exactamente una forma de avisar al usuario de que su correo estaba mal formado: enviarlo entero, dejar que el servidor ejecutara `DataAnnotations` y volver a renderizar la página con los mensajes de error. Eso es un POST completo de ida y vuelta por un error de tecleo.

## Por qué los formularios static SSR estaban atados al servidor

La plantilla Blazor Web App renderiza la mayoría del contenido como HTML estático. No hay circuito SignalR ni carga de WebAssembly, que es justo por lo que static SSR es barato y rápido. Pero la validación del lado del cliente necesita código ejecutándose en el navegador, y una página estática no envía ninguna lógica de componente al cliente. Así que la validación vivía enteramente en el servidor: enviabas el formulario, `DataAnnotationsValidator` recorría el modelo y cualquier fallo volvía como una página re-renderizada. Correcto, pero lento, y una experiencia pobre frente a un formulario interactivo que marca un campo erróneo al perder el foco.

El truco habitual era optar el componente del formulario por `InteractiveServer` o `InteractiveWebAssembly` solo para obtener feedback en vivo, pagando por un circuito o una descarga de WASM que de otro modo no necesitabas.

## Cómo Preview 5 cierra la brecha

En Preview 5 el servidor renderiza las reglas de validación como metadatos dentro del HTML, y el JS de Blazor las aplica en el navegador. Tus atributos de `DataAnnotations` siguen siendo la fuente de verdad autoritativa, evaluados de nuevo en el servidor al enviar. El navegador solo obtiene una copia temprana y gratuita de las mismas reglas. La característica está habilitada por defecto para todo formulario static SSR que incluya un `DataAnnotationsValidator`, y funciona con formularios mejorados y no mejorados.

No hay una API nueva que aprender. El formulario que ya escribiste empieza a validar del lado del cliente en cuanto apuntas al SDK de Preview 5:

```razor
<EditForm Model="Model" Enhance FormName="registration" OnValidSubmit="HandleValidSubmit">
    <DataAnnotationsValidator />
    <div>
        <label for="Email">Email</label>
        <InputText @bind-Value="Model!.Email" id="Email" />
        <ValidationMessage For="@(() => Model!.Email)" />
    </div>
    <button type="submit" id="submit-btn">Register</button>
</EditForm>
```

```csharp
public class RegistrationModel
{
    [Required]
    [EmailAddress]
    public string Email { get; set; }

    [Required]
    [StringLength(100, MinimumLength = 8)]
    public string Password { get; set; }

    [Required]
    [Compare("Password")]
    [Display(Name = "Confirm Password")]
    public string ConfirmPassword { get; set; }
}
```

Un correo erróneo o una contraseña demasiado corta ahora aparece en el navegador antes de que el formulario llegue siquiera a la red. El servidor sigue ejecutando las mismas comprobaciones en el POST, así que no pierdes la defensa en profundidad: la validación del cliente es una capa de conveniencia, no un límite de seguridad, exactamente como debe ser.

## Qué falta todavía

Las reglas asíncronas (una comprobación de unicidad en base de datos, una consulta a una API remota) aún no forman parte de esto. Las notas de la versión dicen que la historia asíncrona completa llegará cuando se publiquen las nuevas APIs asíncronas de `DataAnnotations` en una versión preliminar posterior. Por ahora esto cubre el conjunto de atributos síncronos, que es el grueso de la validación de formularios del mundo real.

Esto se combina con las otras adiciones de Preview 5 como la [serialización JSON Lines de System.Text.Json](/es/2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5/). Para probarlo, instala el SDK de .NET 11 Preview 5 y apunta a `net11.0`. Todos los detalles están en las [notas de la versión de ASP.NET Core Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/aspnetcore.md).
