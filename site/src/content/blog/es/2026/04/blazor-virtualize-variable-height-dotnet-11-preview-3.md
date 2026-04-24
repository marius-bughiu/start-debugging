---
title: "Blazor Virtualize finalmente maneja items de altura variable en .NET 11"
description: "ASP.NET Core en .NET 11 Preview 3 enseña al componente Virtualize a medir items en runtime, arreglando el jitter de spacing y scroll que causaban las asunciones de altura uniforme."
pubDate: 2026-04-16
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet-11"
  - "virtualize"
lang: "es"
translationOf: "2026/04/blazor-virtualize-variable-height-dotnet-11-preview-3"
translatedBy: "claude"
translationDate: 2026-04-24
---

Cualquiera que haya usado [`Virtualize<TItem>`](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/virtualization) para un chat log, un feed de cards, o un panel de notifications ha visto el mismo bug: los items hacen jitter al scroll, el thumb del scrollbar salta alrededor, y terminas con gaps o overlaps torpes. La causa raíz siempre ha sido la misma. `Virtualize` asumía que cada row era de la misma altura y usaba ese único número para computar la ventana de scroll. [.NET 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/aspnetcore.md) finalmente arregla eso: el componente ahora mide items en runtime y ajusta el viewport virtual a las alturas que realmente aterrizan en el DOM.

## Por qué el comportamiento viejo rompía UIs reales

El API original te forzaba a elegir un escalar vía `ItemSize`. Si tus items eran de 48px de alto, seteabas 48. Blazor luego multiplicaba item count por 48 para dimensionar el área scrolleable y renderizaba solo las rows cuya posición top computada intersectaba el viewport. En el momento en que tus rows contenían un body de longitud variable, un quote que wrapeaba, o una imagen responsive, la matemática dejaba de matchear la realidad y el browser y Blazor peleaban sobre placement.

```razor
<Virtualize Items="messages" Context="message">
    <article class="message-card">
        <h4>@message.Author</h4>
        <p>@message.Text</p>
    </article>
</Virtualize>
```

Ese snippet es exactamente el escenario que solía misbehavior. Un one-liner corto y un reply de cinco párrafos comparten el mismo row slot, así que los offsets de scroll derivan mientras te mueves a través de la lista.

## Midiendo el DOM renderizado

En .NET 11 Preview 3, `Virtualize` ahora trackea dimensiones de items medidas en runtime y las alimenta de vuelta a sus cálculos de spacer. Ya no necesitas setear `ItemSize` a un valor que matchee el peor caso, y ya no necesitas setear `overflow: hidden` en hijos para forzarlos a un box fijo. El componente todavía acepta un hint de tamaño inicial, pero lo trata como una estimación de arranque en lugar de ground truth.

El segundo cambio es el default de `OverscanCount`. `Virtualize` solía renderizar tres items arriba y abajo del viewport. En Preview 3 ese default salta a 15 así hay suficientes items medidos para estabilizar la estimación de altura antes de que el usuario scrollee a territorio no medido.

```razor
<Virtualize Items="messages" Context="message" OverscanCount="30">
    <article class="message-card">
        <h4>@message.Author</h4>
        <p>@message.Text</p>
    </article>
</Virtualize>
```

Subir `OverscanCount` más alto ahora es una perilla de tuning legítima para feeds con alturas de items salvajemente distintas. El costo es renderizar más DOM off-screen, pero a cambio obtienes scrolling más suave y un scrollbar estable.

## QuickGrid mantiene el default viejo

Si estás usando `QuickGrid`, nada cambia. El componente pinea su propio `OverscanCount` en 3 porque las rows de grid son intencionalmente uniformes y renderizar 30 rows escondidas por tick de scroll torcharía la performance para tablas con cientos de columnas. Eso es deliberado: los nuevos defaults apuntan a los componentes donde la asunción vieja era genuinamente equivocada.

## Qué cambiar en apps existentes

Dropea el valor de `ItemSize` si lo seteabas solo para tapar alturas variables, ya que el path medido es estrictamente mejor ahí. Audita cualquier CSS que agregaste para forzar hijos a un box fijo. Y perfilá scrolling antes de tunear `OverscanCount` más arriba, porque 15 ya es un salto grande desde 3.

La implementación vive en [dotnet/aspnetcore#64964](https://github.com/dotnet/aspnetcore/pull/64964). Agarra [.NET 11 Preview 3](https://dotnet.microsoft.com/download/dotnet/11.0) y la próxima vez que alguien pregunte por qué el chat log scrollea raro, tendrás un workaround menos que explicar.
