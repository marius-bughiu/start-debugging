---
title: "Fix: CA1070 \"Do not declare event fields as virtual\""
description: "CA1070 se dispara en eventos de tipo campo declarados virtual. Quita virtual, deja el evento no virtual y que las clases derivadas sobrescriban un método protected virtual OnXxx."
pubDate: 2026-08-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "csharp"
  - "analyzers"
  - "events"
lang: "es"
translationOf: "2026/08/fix-ca1070-do-not-declare-event-fields-as-virtual"
translatedBy: "claude"
translationDate: 2026-08-29
---

CA1070 se dispara cuando un evento de tipo campo lleva el modificador `virtual`. La solución es quitar `virtual` y darle a las clases derivadas un método disparador `protected virtual void OnThresholdReached(...)` que puedan sobrescribir. Esto no es un detalle de estilo: si algo llega a sobrescribir ese evento virtual, el compilador le entrega a la clase base y a la derivada dos campos de respaldo privados separados, y el disparo desde la clase base no invoca nada, en silencio.

El texto del diagnóstico que estás buscando:

```text
warning CA1070: Event 'ThresholdReached' should not be declared virtual
```

Todo lo que sigue fue verificado con el SDK `10.0.302` (.NET 10, C# 14), con los analizadores que vienen incluidos en el SDK, y contra el código fuente de `DoNotDeclareEventFieldsAsVirtual` en `dotnet/sdk`.

## ¿dotnet build reporta CA1070?

No. Su severidad por defecto es sugerencia, no advertencia, porque el analizador se declara con `RuleLevel.IdeSuggestion`:

```csharp
// dotnet/sdk, Microsoft.CodeQuality.Analyzers/QualityGuidelines/DoNotDeclareEventFieldsAsVirtual.cs
internal static readonly DiagnosticDescriptor Rule = DiagnosticDescriptorHelper.Create(
    RuleId,
    CreateLocalizableResourceString(nameof(DoNotDeclareEventFieldsAsVirtualTitle)),
    CreateLocalizableResourceString(nameof(DoNotDeclareEventFieldsAsVirtualMessage)),
    DiagnosticCategory.Design,
    RuleLevel.IdeSuggestion,
    ...
```

Los diagnósticos de nivel sugerencia aparecen en Visual Studio, Rider y `dotnet format`, pero `dotnet build` no los imprime y `TreatWarningsAsErrors` no los toca. Un proyecto lleno de eventos virtuales compila así:

```text
    0 Warning(s)
    0 Error(s)
```

Dos formas de volverlo real:

```xml
<!-- .NET 10 SDK 10.0.302: promotes the All-mode analyzers, CA1070 included -->
<PropertyGroup>
  <AnalysisMode>All</AnalysisMode>
</PropertyGroup>
```

```ini
# .editorconfig, just this rule
[*.{cs,vb}]
dotnet_diagnostic.CA1070.severity = warning
```

Es la misma trampa de invisibilidad que [CA1873 y los argumentos costosos de logging](/es/2026/08/fix-ca1873-evaluation-of-this-argument-may-be-expensive-and-unnecessary-if-logging-is-disabled/), y las contrapartidas de promover sugerencias en CI están cubiertas en [TreatWarningsAsErrors sin sabotear las compilaciones de desarrollo](/es/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/).

## ¿Por qué alguien marca un evento como virtual?

Casi siempre por culpa de CS0070. Una clase derivada no puede disparar un evento de la clase base:

```csharp
// .NET 10, C# 14
public class Sensor
{
    public event EventHandler? ThresholdReached;
}

public class LoggingSensor : Sensor
{
    public void Raise() => ThresholdReached?.Invoke(this, EventArgs.Empty);
}
```

```text
error CS0070: The event 'Sensor.ThresholdReached' can only appear on the left hand side
of += or -= (except when used from within the type 'Sensor')
```

El compilador te está diciendo que, fuera del tipo que lo declara, un evento es solo un par add/remove, nunca el delegado que hay detrás. La salida que parece obvia es marcar el evento como `virtual` y sobrescribirlo en `LoggingSensor` para que el nombre resuelva a algo que la clase derivada sí posee. Eso compila. También rompe el evento.

## ¿Por qué sobrescribir un evento de tipo campo virtual rompe el evento?

La clase base deja de disparar. Aquí está la falla completa en un solo archivo:

```csharp
// .NET 10 (SDK 10.0.302), C# 14
using System;

public class Sensor
{
    public virtual event EventHandler? ThresholdReached;   // CA1070
    public void Raise() => ThresholdReached?.Invoke(this, EventArgs.Empty);
}

public class LoggingSensor : Sensor
{
    public override event EventHandler? ThresholdReached;
    public void RaiseFromDerived() => ThresholdReached?.Invoke(this, EventArgs.Empty);
}

public static class Program
{
    public static void Main()
    {
        LoggingSensor derived = new();
        Sensor asBase = derived;
        asBase.ThresholdReached += (_, _) => Console.WriteLine("handler ran");

        Console.WriteLine("Sensor.Raise():");
        asBase.Raise();                 // fires nothing
        Console.WriteLine("LoggingSensor.RaiseFromDerived():");
        derived.RaiseFromDerived();     // fires the handler
    }
}
```

Salida real en .NET 10:

```text
Sensor.Raise():
LoggingSensor.RaiseFromDerived():
handler ran
```

El mismo objeto, el mismo manejador: un disparo funciona y el otro no hace nada.

La razón es que un evento de tipo campo son dos cosas distintas a la vez, y solo una de ellas es virtual. Los descriptores de acceso `add` y `remove` son métodos reales y sí reciben el modificador `virtual`. El campo delegado de respaldo no, porque los campos no pueden ser virtuales. Usar reflexión sobre el ensamblado compilado muestra exactamente lo que emitió el compilador:

```text
Sensor: field ThresholdReached, IsPrivate=True, type=EventHandler
Sensor: add_ThresholdReached IsVirtual=True, IsFinal=False, DeclaringType=Sensor
LoggingSensor: field ThresholdReached, IsPrivate=True, type=EventHandler
LoggingSensor: add_ThresholdReached IsVirtual=True, IsFinal=False, DeclaringType=LoggingSensor
```

Dos campos privados, uno por tipo. Entonces:

- `asBase.ThresholdReached += handler` pasa por el descriptor de acceso add virtual, despacha a `LoggingSensor.add_ThresholdReached` y aterriza en el campo de `LoggingSensor`.
- `Sensor.Raise()` no pasa por ningún descriptor de acceso. Dentro del tipo que lo declara, `ThresholdReached?.Invoke(...)` compila a una lectura directa del campo privado propio de `Sensor`, que sigue en null.

La especificación de C# permite esto. Una declaración de evento virtual hace virtuales los descriptores de acceso, y una declaración de evento que sobrescribe "no declara un evento nuevo, simplemente especializa las implementaciones de los descriptores de acceso". El lenguaje de la especificación implica que los descriptores de acceso derivados deberían especializar el acceso a un único campo compartido, lo que obligaría al compilador a promover el campo de respaldo de la base de privado a protegido. Nunca lo hizo. Microsoft documentó esto como un error conocido del compilador allá por 2007 y decidió no arreglarlo, porque arreglarlo resucitaría invocaciones de manejadores en código que silenciosamente dependía de que nunca se ejecutaran.

Lo que sí cambió desde 2007 es que la falla se volvió más silenciosa. El repro original usaba `myEvent(this, null)` y lanzaba `NullReferenceException`, lo que al menos apuntaba al problema. La invocación condicional a null moderna, hacia la que te empuja cualquier analizador o corrección automática, la convierte en un no-op silencioso.

## ¿Cómo aparece esto en una clase base de MVVM?

La forma que la gente usa al escribir `INotifyPropertyChanged` en un view model base es exactamente el caso roto:

```csharp
// .NET 10, C# 14
public class ViewModelBase : INotifyPropertyChanged
{
    public virtual event PropertyChangedEventHandler? PropertyChanged;   // CA1070
    protected void Notify(string n) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(n));
}

public class OrderViewModel : ViewModelBase
{
    public override event PropertyChangedEventHandler? PropertyChanged;
}
```

El motor de binding se suscribe a través de la interfaz `INotifyPropertyChanged`, lo que enruta al descriptor de acceso add virtual, que guarda el manejador en `OrderViewModel`. `Notify` se ejecuta dentro de `ViewModelBase` y lee el campo de `ViewModelBase`. Confirmé en .NET 10 que el manejador nunca se llama: la interfaz de usuario simplemente no se actualiza, sin excepción y sin ningún error de binding en la ventana de salida.

El `override` en el view model derivado suele ser vestigial, agregado por alguien persiguiendo CS0070 o copiado de una plantilla. Borrarlo arregla el binding al instante, porque entonces hay un solo campo de respaldo. Vale la pena revisar eso antes de reescribir nada. Si estás construyendo la infraestructura de notificación desde cero, [un source generator para INotifyPropertyChanged](/es/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) emite la forma no virtual correcta y nunca se equivoca en esto.

## ¿Cómo soluciono CA1070?

En orden de preferencia.

**1. Evento no virtual más un disparador protected virtual.** Este es el patrón que prescriben las guías de diseño de .NET, y es hacia donde CA1070 te está empujando. Las clases derivadas obtienen el punto de extensión que realmente querían, y hay exactamente un campo de respaldo.

```csharp
// .NET 10, C# 14. Builds clean under AnalysisMode=All.
public class Sensor
{
    public event EventHandler? ThresholdReached;

    protected virtual void OnThresholdReached(EventArgs e)
        => ThresholdReached?.Invoke(this, e);

    public void Raise() => OnThresholdReached(EventArgs.Empty);
}

public class LoggingSensor : Sensor
{
    protected override void OnThresholdReached(EventArgs e)
    {
        Console.WriteLine("[derived saw the raise]");
        base.OnThresholdReached(e);
    }
}
```

Ten en cuenta que el disparador lee el campo, así que debe vivir en el tipo que lo declara. Las sobrescrituras derivadas llaman a `base.OnThresholdReached(e)` para disparar de verdad. Si olvidas la llamada a `base`, suprimiste el evento, lo cual a veces es justo lo que buscas.

**2. Deja el evento virtual, pero escribe descriptores de acceso explícitos sobre un campo protegido.** Usa esto cuando la clase derivada realmente necesita interceptar la suscripción, por ejemplo para conectar de forma diferida un hook del sistema operativo con el primer suscriptor. CA1070 no se dispara aquí, porque la regla solo apunta a eventos de tipo campo.

```csharp
// .NET 10, C# 14
public class Sensor
{
    protected EventHandler? _thresholdReached;

    public virtual event EventHandler? ThresholdReached
    {
        add => _thresholdReached += value;
        remove => _thresholdReached -= value;
    }

    public void Raise() => _thresholdReached?.Invoke(this, EventArgs.Empty);
}

public class LoggingSensor : Sensor
{
    public override event EventHandler? ThresholdReached
    {
        add { Console.WriteLine("[derived add]"); _thresholdReached += value; }
        remove => _thresholdReached -= value;
    }
}
```

El `+=` sobre un campo delegado no es atómico, así que usa `Interlocked.CompareExchange` o un lock en los descriptores de acceso si los suscriptores pueden llegar desde varios hilos. Ambos manejadores se dispararon correctamente en mi ejecución, porque ahora los dos descriptores de acceso apuntan al mismo campo protegido.

**3. Haz que el evento de la base sea abstract.** Un evento de tipo campo abstracto no puede usarse como campo, así que la clase base físicamente no puede dispararlo y el error de campos separados no puede ocurrir. CA1070 no se dispara, porque el analizador revisa `IsVirtual`, que es false para miembros abstractos.

```csharp
// .NET 10, C# 14
public abstract class Sensor
{
    public abstract event EventHandler? ThresholdReached;
    public abstract void Raise();
}
```

Esto es correcto pero rara vez es lo que quieres, ya que cada clase derivada tiene ahora que reimplementar el evento y el disparo.

## ¿Qué declaraciones marca realmente CA1070?

Solo la declaración `virtual` de la base, lo cual sorprende a quienes ejecutan el analizador esperando que apunte a la línea que de verdad está rota. La verificación es una única acción sobre símbolos:

```csharp
// dotnet/sdk, DoNotDeclareEventFieldsAsVirtual.cs
if (!eventSymbol.IsVirtual ||
    eventSymbol.AddMethod?.IsImplicitlyDeclared == false ||
    eventSymbol.RemoveMethod?.IsImplicitlyDeclared == false)
{
    return;
}
```

`IEventSymbol.IsVirtual` es true solo para miembros declarados con la palabra clave `virtual`. Un miembro `override` reporta `IsOverride`, no `IsVirtual`, y un miembro `abstract` reporta `IsAbstract`. Así que el diagnóstico aterriza en la declaración de la base y en ningún otro lado. Las verificaciones de `IsImplicitlyDeclared` son las que restringen la regla a eventos de tipo campo: si escribiste los descriptores de acceso tú mismo, no son implícitos y la regla se retira.

Esta es la matriz completa que armé y ejecuté contra el SDK 10.0.302 con `dotnet_diagnostic.CA1070.severity = warning`:

| Declaración | ¿CA1070? |
| --- | :---: |
| `public virtual event EventHandler A;` | sí |
| `protected virtual event EventHandler B;` en una clase pública no sellada | sí |
| `internal virtual event EventHandler C;` | no |
| `public virtual event EventHandler D { add {} remove {} }` | no |
| `public override event EventHandler A;` en la clase derivada | no |
| `public abstract event EventHandler E;` | no |
| `public virtual event EventHandler F;` dentro de una clase `internal` | no |
| `public event EventHandler G;` (no virtual) | no |

Las dos filas que sorprenden a la gente son las internas, y se pueden configurar.

## ¿Cómo hago que CA1070 cubra eventos internal y private?

Por defecto la regla solo analiza símbolos visibles externamente, igual que el viejo comportamiento de FxCop. Configura `api_surface` para ampliarla:

```ini
[*.{cs,vb}]
dotnet_diagnostic.CA1070.severity = warning
dotnet_code_quality.CA1070.api_surface = all
```

Sobre la misma matriz, `api_surface = all` reporta A, B, C y F. `api_surface = private, internal` reporta solo C y F. Para un ensamblado de aplicación en lugar de una biblioteca publicada, `all` es la configuración correcta: allí nada es un contrato de API pública, y al error no le importa la accesibilidad.

Vale la pena conocer una discrepancia en la documentación: la página de MS Learn lista los lenguajes aplicables como "C# and Visual Basic", pero el analizador está atribuido con `[DiagnosticAnalyzer(LanguageNames.CSharp)]`, con un comentario de supresión que dice "Construct is invalid in VB.NET". VB no tiene un evento de tipo campo `Overridable` de entrada, así que no hay nada que analizar; la tabla de la documentación simplemente está desactualizada.

## ¿Cuándo es seguro suprimir CA1070?

Cuando el evento virtual ya es parte de una API pública publicada. Quitar `virtual` es un cambio binario incompatible para cualquiera que lo haya sobrescrito, así que la guía de la propia regla es suprimir en lugar de romper a los consumidores. Suprímelo en la declaración, no a nivel de proyecto, y deja una nota:

```csharp
// Public since v2.0. Removing 'virtual' is a binary break for derived types.
#pragma warning disable CA1070
public virtual event EventHandler? ThresholdReached;
#pragma warning restore CA1070
```

Después agrega el disparador protegido de todos modos, para que los nuevos tipos derivados tengan un punto de extensión correcto y dejen de recurrir a `override`. En una base de código nueva o interna, no lo suprimas. Arréglalo.

## Trampas y casos parecidos que llegan aquí por error

**CS0070** ("The event 'X' can only appear on the left hand side of += or -=") es el error de compilación que lleva a la gente a escribir `virtual`, cubierto más arriba. La solución es un disparador protegido, nunca un evento virtual.

**CS0067** ("The event 'X' is never used") aparece sobre el `override` derivado una vez que sigues este artículo y dejas de dispararlo desde la clase derivada. Esa advertencia es el fantasma visible al analizador de un campo de respaldo en el que nadie escribe; borrar el override la elimina.

**CA1030** ("Use events where appropriate") y **CA1003** ("Use generic event handler instances") son reglas de diseño sobre la forma de los eventos, no sobre virtualidad, y ninguna tiene relación con el error de campos separados.

**"Lo marqué virtual para que Moq o Castle DynamicProxy pudieran interceptarlo."** Las bibliotecas de mocking basadas en proxies sí necesitan miembros virtuales, y la intercepción de eventos es el único caso donde complacerlas planta un error real. Haz mock de la interfaz en su lugar: extrae `IThresholdSource` con un `event EventHandler ThresholdReached` simple y deja que el mock la implemente, así nada necesita `virtual`. Lo mismo aplica a una clase base marcada como virtual en bloque para los proxies de carga diferida de EF Core, donde en realidad solo las propiedades de navegación lo necesitan.

Si un evento virtual ya se publicó y estás rastreando las consecuencias, el síntoma suele ser un manejador que queda suscrito para siempre sin ser invocado nunca, lo que aparece como un delegado con raíz en un volcado de memoria. [Diagnosticar una fuga de memoria administrada con dotnet-gcdump y dotnet-dump](/es/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/) recorre cómo encontrar la cadena de manejadores que sobrevive.

CA1070 está incluida desde los analizadores de .NET 5, con severidad Info, y nunca fue promovida. Es una decisión razonable para una regla cuya carga solo detona cuando alguien escribe `override`, pero implica que la advertencia con más probabilidades de ahorrarte una tarde de "por qué no se actualiza mi binding" es una que tu compilación nunca imprime. Convertirla en advertencia cuesta una línea de `.editorconfig`.

## Relacionado

- [Fix: CA1873 "Evaluation of this argument may be expensive and unnecessary if logging is disabled"](/es/2026/08/fix-ca1873-evaluation-of-this-argument-may-be-expensive-and-unnecessary-if-logging-is-disabled/)
- [Cómo escribir un source generator para INotifyPropertyChanged](/es/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/)
- [TreatWarningsAsErrors sin sabotear las compilaciones de desarrollo (.NET 10)](/es/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/)
- [¿Qué es un source generator y cuándo necesito uno?](/es/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [Cómo diagnosticar una fuga de memoria administrada con dotnet-gcdump y dotnet-dump](/es/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/)

## Fuentes

- [CA1070: Do not declare event fields as virtual](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1070) en MS Learn
- [DoNotDeclareEventFieldsAsVirtual.cs](https://github.com/dotnet/sdk/blob/main/src/Microsoft.CodeAnalysis.NetAnalyzers/src/Microsoft.CodeAnalysis.NetAnalyzers/Microsoft.CodeQuality.Analyzers/QualityGuidelines/DoNotDeclareEventFieldsAsVirtual.cs), el código fuente del analizador
- [Virtual events in C#](https://learn.microsoft.com/en-us/archive/blogs/samng/virtual-events-in-c), la publicación del equipo de C# de 2007 que documentó el error del compilador y la decisión de no arreglarlo
- [How to raise base class events in derived classes](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/events/how-to-raise-base-class-events-in-derived-classes) en MS Learn
- [Handle and raise events](https://learn.microsoft.com/en-us/dotnet/standard/events/), las guías de diseño de eventos de .NET
- [Compiler Error CS0070](https://learn.microsoft.com/en-us/dotnet/csharp/misc/cs0070) en MS Learn
- [Opción de configuración api_surface](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/code-quality-rule-options#api_surface) para las reglas de calidad de código
