---
title: "Cómo renderizar un encabezado cuyo nivel (h1-h6) se elige en tiempo de ejecución en un componente Blazor"
description: "Razor no tiene sintaxis para un nombre de etiqueta variable, y DynamicComponent solo renderiza tipos de componente. Sobrescribe BuildRenderTree y llama a builder.OpenElement(0, $\"h{level}\"). Cubre el paso de atributos, por qué hay que acotar el nombre de la etiqueta antes de que llegue al DOM, por qué cambiar el nivel arranca el elemento del DOM incluso con @key, y una variante auto-nivelada construida sobre un valor en cascada."
pubDate: 2026-08-27
template: how-to
tags:
  - "dotnet"
  - "csharp"
  - "aspnetcore"
  - "how-to"
lang: "es"
translationOf: "2026/08/how-to-render-a-heading-with-a-runtime-chosen-level-in-blazor"
translatedBy: "claude"
translationDate: 2026-08-27
---

Razor no te ofrece ninguna forma de escribir `<h@Level>`, y `<DynamicComponent>` no puede ayudarte porque su parámetro `Type` tiene que implementar `IComponent`. La respuesta es bajar hasta `RenderTreeBuilder` y construir el elemento tú mismo: sobrescribe `BuildRenderTree` y llama a `builder.OpenElement(0, $"h{level}")` con un nivel que ya hayas acotado al rango 1-6. Todo lo que sigue fue verificado contra .NET 10 (SDK 10.0.201, `Microsoft.AspNetCore.App` 10.0.5); las APIs no han cambiado en las versiones preliminares de .NET 11.

## Por qué fallan los dos enfoques evidentes

El primer impulso es `<DynamicComponent Type="...">`. Aquí no aplica. La documentación lo describe como una forma de "renderizar componentes por tipo", y el runtime lo impone. Pasar un nombre de elemento, o cualquier tipo que no sea un componente, lanza una excepción antes de que se renderice nada:

```text
System.ArgumentException: The component type must implement Microsoft.AspNetCore.Components.IComponent.
```

No existe un equivalente para elementos HTML. `DynamicComponent` sirve para elegir entre `RocketLab.razor` y `SpaceX.razor`, no entre `h2` y `h3`.

El segundo impulso es partir la etiqueta en dos valores `MarkupString`:

```csharp
// .NET 10. Renders correctly in static SSR and breaks interactively.
builder.AddContent(0, (MarkupString)$"<h{Level}>");
builder.AddContent(1, ChildContent);
builder.AddContent(2, (MarkupString)$"</h{Level}>");
```

Esta es la trampa que vale la pena entender, porque parece funcionar. Renderizado a través de `HtmlRenderer` para el renderizado estático del lado del servidor, la salida es exactamente la correcta:

```html
<h3>Release notes</h3>
```

Eso ocurre solo porque el SSR estático concatena los frames en una cadena. Inspeccionar el árbol de renderizado muestra lo que realmente se produjo: tres frames hermanos independientes, no un elemento con un hijo.

```text
PrependFrame @sibling 0 frame=[Markup "<h3>"]
PrependFrame @sibling 1 frame=[Text "Release notes"]
PrependFrame @sibling 2 frame=[Markup "</h3>"]
```

En Blazor Server o WebAssembly, el cliente recorre esos frames y llama a `insertMarkup` una vez por cada frame de marcado, y [`insertMarkup` analiza el contenido de cada frame por separado](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Rendering/BrowserRenderer.ts) antes de insertar los nodos resultantes. El analizador del navegador convierte la cadena suelta `<h3>` en un elemento vacío `<h3></h3>` y la cadena suelta `</h3>` en nada en absoluto. Tu texto termina como hermano *después* de un encabezado vacío. El componente pasa una prueba rápida de SSR estático y produce marcado roto e inaccesible en cuanto el modo de renderizado pasa a ser interactivo.

Un `@switch` sobre seis ramas fijas sí funciona. Solo que son seis copias de cada atributo, cada clase CSS y el contenido hijo, y todo eso tiene que mantenerse sincronizado para siempre. Para un componente es tolerable; para un sistema de diseño con encabezados, etiquetas y títulos de sección no lo es.

## Pasos: construir un componente Heading que elige su propia etiqueta

1. Crea un archivo `.cs` normal, no un archivo `.razor`. Un componente Razor ya genera un método `BuildRenderTree`, así que declarar el tuyo en un bloque `@code` produce `CS0111: Type 'Heading' already defines a member called 'BuildRenderTree' with the same parameter types`.
2. Deriva de `ComponentBase` y añade un parámetro `int Level`, un parámetro `RenderFragment? ChildContent` y un diccionario `AdditionalAttributes` marcado con `[Parameter(CaptureUnmatchedValues = true)]` para que quien lo use pueda seguir pasando `class`, `id` y atributos `data-`.
3. Sobrescribe `BuildRenderTree` y acota el nivel con `Math.Clamp(Level, 1, 6)` antes de interpolarlo en el nombre de la etiqueta. Acotar es un control de seguridad, no una comodidad.
4. Llama a `builder.OpenElement(0, $"h{level}")`, luego a `builder.AddMultipleAttributes(1, AdditionalAttributes)`, luego a `builder.AddContent(2, ChildContent)` y por último a `builder.CloseElement()`.
5. Fija cada número de secuencia como un literal entero. No uses una variable contador, ni siquiera una que parezca inofensiva.

## El componente completo

```csharp
// Heading.cs -- .NET 10, C# 14
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Rendering;

public class Heading : ComponentBase
{
    [Parameter] public int Level { get; set; } = 2;
    [Parameter] public RenderFragment? ChildContent { get; set; }

    [Parameter(CaptureUnmatchedValues = true)]
    public IReadOnlyDictionary<string, object>? AdditionalAttributes { get; set; }

    protected override void BuildRenderTree(RenderTreeBuilder builder)
    {
        var level = Math.Clamp(Level, 1, 6);

        builder.OpenElement(0, $"h{level}");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        builder.AddContent(2, ChildContent);
        builder.CloseElement();
    }
}
```

Se consume exactamente igual que cualquier otro componente:

```razor
@* .NET 10 *@
<Heading Level="SectionDepth" class="title" id="release-notes">
    Release notes
</Heading>
```

Renderizado a través de `HtmlRenderer`, los resultados son los que escribirías a mano:

```text
Level= 1 -> <h1 class="title" id="s1">Release notes</h1>
Level= 3 -> <h3 class="title" id="s1">Release notes</h3>
Level= 6 -> <h6 class="title" id="s1">Release notes</h6>
Level= 9 -> <h6 class="title" id="s1">Release notes</h6>
Level=-4 -> <h1 class="title" id="s1">Release notes</h1>
```

Fíjate en que `AddMultipleAttributes` va antes de `AddContent`. Todos los frames de atributo de un elemento tienen que añadirse antes de cualquier contenido hijo; intercalarlos lanza una excepción en tiempo de renderizado.

## Mantenerlo en un archivo .razor

Si prefieres no salir de Razor, puedes hacerlo, siempre que no sobrescribas `BuildRenderTree`. Expón la lógica del builder como una propiedad `RenderFragment` y renderízala como el cuerpo completo del componente:

```razor
@* Heading.razor -- .NET 10 *@
@Rendered

@code {
    [Parameter] public int Level { get; set; } = 2;
    [Parameter] public RenderFragment? ChildContent { get; set; }

    [Parameter(CaptureUnmatchedValues = true)]
    public IReadOnlyDictionary<string, object>? AdditionalAttributes { get; set; }

    private RenderFragment Rendered => builder =>
    {
        builder.OpenElement(0, $"h{Math.Clamp(Level, 1, 6)}");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        builder.AddContent(2, ChildContent);
        builder.CloseElement();
    };
}
```

Esto compila sin problemas y emite `<h4 class="title">Release notes</h4>` sin nodos de espacio en blanco sueltos alrededor, porque la expresión `@Rendered` es el único marcado del componente. El `BuildRenderTree` generado simplemente llama a tu fragmento. Elige el tipo de archivo que tu equipo busque con más frecuencia; el árbol de renderizado es idéntico.

## El nombre de la etiqueta llega al DOM tal cual

El acotado del paso 3 es la parte que la gente se salta, y es la parte que importa. `OpenElement` no valida ni escapa su argumento `elementName`. La cadena que le pases se escribe en la salida como nombre de etiqueta. Aquí hay un componente con un parámetro `string Level` sin validar, renderizado con tres entradas distintas:

```text
Level="2"                          -> <h2>hi</h2>
Level="2 onload=alert(1)"          -> <h2 onload=alert(1)>hi</h2 onload=alert(1)>
Level="2><script>alert(1)</script" -> <h2><script>alert(1)</script>hi</h2><script>alert(1)</script>
```

Eso es una etiqueta de script en tu página proveniente de un parámetro de componente. La codificación automática de Blazor protege el texto y los *valores* de atributo; no protege el nombre de la etiqueta, porque nunca se espera que el nombre de la etiqueta sea dato del usuario. La propia guía de Microsoft sobre `RenderTreeBuilder` lo dice: un componente mal formado "puede provocar comportamiento indefinido", incluida la "seguridad comprometida".

Así que nunca dejes que un valor no confiable, o simplemente sin validar, llegue a `OpenElement`. Acepta un `int` en lugar de un `string`, acótalo y, si tu API realmente necesita una cadena, valídala contra una lista de permitidos de los seis nombres de encabezado en vez de interpolarla.

## Cambiar el nivel destruye y reconstruye el elemento

El algoritmo de diferencias de Blazor empareja frames por número de secuencia y tipo de frame. Dos frames de elemento con el mismo número de secuencia pero nombres de etiqueta *distintos* no son el mismo elemento, así que el antiguo se elimina y se inserta uno nuevo. Capturar el lote de renderizado cuando `Level` pasa de 2 a 3 muestra exactamente eso:

```text
after Level 2 -> 3:
  RemoveFrame @sibling 0 frame=[Element h3]
  PrependFrame @sibling 0 frame=[Element h3]
```

Compáralo con cambiar solo el atributo `class`, que se parchea en el sitio:

```text
after class change only:
  SetAttribute @sibling 0 frame=[Attribute class=subtitle]
```

La consecuencia práctica es que un encabezado que cambia de nivel pierde su nodo del DOM. El foco dentro de él se descarta, cualquier `ElementReference` que hayas capturado queda obsoleta, las transiciones CSS se reinician y un script de terceros que se había enganchado a ese nodo ahora está enganchado a un huérfano. Añadir `@key` no lo salva. Las claves permiten al algoritmo emparejar elementos a través de reordenamientos; no hacen que dos nombres de etiqueta distintos sean el mismo elemento. Una versión con clave produce exactamente el mismo script de edición:

```text
keyed, Level 2 -> 3:
  RemoveFrame @sibling 0 frame=[Element h3]
  PrependFrame @sibling 0 frame=[Element h3]
```

Rara vez es un problema, porque el nivel de un encabezado suele ser fijo durante toda la vida de la sección. Se vuelve un problema cuando el nivel deriva de algo que cambia a menudo, como un esquema plegable que se renumera a medida que el usuario expande nodos. Si te encuentras con eso, mantén el nivel estable y cambia el estilo en su lugar.

## Los números de secuencia se dejan fijos, incluso entre ramas

Esta es la regla más fácil de romper en cuanto añades un segundo camino de código. Es tentador escribir `var seq = 0;` y usar `seq++` por todas partes, sobre todo en un componente con un `if`/`else`. No lo hagas. La documentación de Microsoft es explícita: "el rendimiento de la aplicación se resiente si los números de secuencia se generan dinámicamente", porque un contador borra la información que el algoritmo de diferencias usa para reconocer en qué rama estabas. El resultado son scripts de edición más largos y, en estructuras anidadas, una recursión de diferencias mucho más profunda.

El patrón correcto es lo que emite el propio compilador de Razor: números literales que aumentan en el orden del *código fuente*, con cada rama dueña de su propio rango.

```csharp
// AutoHeading.cs -- .NET 10, C# 14
protected override void BuildRenderTree(RenderTreeBuilder builder)
{
    var level = Ambient?.Value ?? 1;

    if (level <= 6)
    {
        builder.OpenElement(0, $"h{level}");
        builder.AddMultipleAttributes(1, AdditionalAttributes);
        builder.AddContent(2, ChildContent);
        builder.CloseElement();
    }
    else
    {
        builder.OpenElement(3, "div");
        builder.AddAttribute(4, "role", "heading");
        builder.AddAttribute(5, "aria-level", level);
        builder.AddMultipleAttributes(6, AdditionalAttributes);
        builder.AddContent(7, ChildContent);
        builder.CloseElement();
    }
}
```

Si un componente crece más allá de una pantalla de llamadas al builder, envuelve las piezas en `OpenRegion`/`CloseRegion`. Cada región obtiene su propio espacio de números de secuencia, así que puedes reiniciar desde cero dentro de ella sin confundir al algoritmo.

## Auto-nivelado con un valor en cascada

La versión de arriba insinúa la forma más útil de este componente. En lugar de obligar a cada llamador a pasar el número correcto, deja que el encabezado lea su profundidad del contexto. Un pequeño valor en cascada transporta el nivel ambiental, y cualquier componente que abra una sección anidada pasa en cascada el siguiente:

```csharp
// HeadingLevel.cs -- .NET 10, C# 14
public sealed class HeadingLevel
{
    public int Value { get; init; } = 1;
    public HeadingLevel Next() => new() { Value = Value + 1 };
}
```

```razor
@* Section.razor -- .NET 10 *@
<CascadingValue Value="_child" IsFixed="true">
    <section>@ChildContent</section>
</CascadingValue>

@code {
    [CascadingParameter] public HeadingLevel? Ambient { get; set; }
    [Parameter] public RenderFragment? ChildContent { get; set; }

    private HeadingLevel _child = default!;

    protected override void OnParametersSet()
        => _child = (Ambient ?? new HeadingLevel()).Next();
}
```

`AutoHeading` entonces no toma ningún parámetro `Level`. Un componente de tarjeta colocado tres secciones más adentro renderiza un `h4` sin saber nada sobre dónde se usó, que es la propiedad que hace componibles a los componentes reutilizables. Pon `IsFixed="true"` en el `CascadingValue` cuando el nivel no pueda cambiar después de que la sección se renderice; permite a Blazor saltarse la suscripción de cada descendiente a las notificaciones de cambio.

## Qué hacer más allá de h6

HTML se detiene en `h6`, pero un esquema profundamente anidado no. En lugar de acotar en silencio y producir tres elementos `h6` hermanos que la tecnología de asistencia lee como pares, recurre al equivalente de ARIA. `role="heading"` más `aria-level` expresa cualquier profundidad:

```text
ambient=2 -> <h2 class="title">Release notes</h2>
ambient=6 -> <h6 class="title">Release notes</h6>
ambient=7 -> <div role="heading" aria-level="7" class="title">Release notes</div>
```

Los elementos nativos siguen siendo la mejor opción donde existen, así que usa las etiquetas reales `h1`-`h6` para los niveles 1 a 6 y reserva el respaldo de ARIA para el caso de desbordamiento. En la práctica, necesitar el nivel 7 suele ser señal de que la estructura de la página debería aplanarse, así que conviene registrar una advertencia en desarrollo cuando se active el respaldo.

Una última nota sobre los propios tipos del árbol de renderizado: la documentación marca todo lo que está bajo `Microsoft.AspNetCore.Components.RenderTree` como interno inestable del framework. `RenderTreeBuilder` y `ComponentBase.BuildRenderTree` son API pública, soportada y segura de usar. Leer `RenderBatch` y `RenderTreeEdit`, como hice arriba para capturar la salida de diferencias, está bien para diagnóstico pero no es algo que debas llevar a producción.

## Relacionados

- La resolución de etiquetas del compilador de Razor es lo que hace imposible un nombre de etiqueta variable en primer lugar, y también está detrás del error en [Se encontró un elemento de marcado con un nombre inesperado en Blazor](/es/2026/05/fix-rz10012-found-markup-element-with-unexpected-name-blazor/).
- El código de componente que accede al DOM tiene que respetar el límite del modo de renderizado, como se cubre en [Las llamadas de interoperabilidad de JavaScript no se pueden emitir en este momento](/es/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/).
- El mismo instinto de evitar JS para algo que el framework puede hacer de forma nativa aplica a [descargar un archivo desde un componente Blazor sin interoperabilidad de JavaScript](/es/2026/08/how-to-download-a-file-from-a-blazor-component-without-javascript-interop/).
- Si la reconstrucción de un encabezado está perdiendo estado que te importa, [persistir el estado a través del límite de renderizado estático a interactivo](/es/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) cubre el mecanismo.
- El modo de renderizado que elijas decide si el error de `MarkupString` de arriba es siquiera alcanzable; consulta [Blazor Server vs WebAssembly vs United](/es/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

## Fuentes

- [Escenarios avanzados de Blazor en ASP.NET Core (construcción del árbol de renderizado)](https://learn.microsoft.com/en-us/aspnet/core/blazor/advanced-scenarios?view=aspnetcore-10.0), incluida la guía sobre números de secuencia y la advertencia de seguridad sobre componentes mal formados.
- [Componentes Razor renderizados dinámicamente en ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/dynamiccomponent?view=aspnetcore-10.0) para el contrato de `DynamicComponent`.
- [Referencia de la API `RenderTreeBuilder.OpenElement`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.rendering.rendertreebuilder.openelement).
- [`BrowserRenderer.ts` en dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Rendering/BrowserRenderer.ts) para ver cómo se analizan e insertan los frames de marcado en el cliente.
