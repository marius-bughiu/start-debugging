---
title: "¿Qué es PGO en .NET y necesito activarlo?"
description: "PGO (optimización guiada por perfil) permite que el JIT de .NET especialice el código caliente para los tipos y ramas que tu carga de trabajo realmente ejecuta. Dynamic PGO está activo por defecto desde .NET 8, así que en .NET 8 y versiones posteriores no necesitas activarlo. Esto es lo que hace, cómo ver su efecto y los casos poco frecuentes en los que tocas el ajuste."
pubDate: 2026-07-11
tags:
  - "dotnet"
  - "performance"
  - "jit"
  - "dotnet-11"
  - "csharp"
lang: "es"
translationOf: "2026/07/what-is-pgo-in-dotnet-and-do-i-need-to-opt-in"
translatedBy: "claude"
translationDate: 2026-07-11
---

PGO significa optimización guiada por perfil: el compilador recopila un perfil de cómo se ejecuta realmente tu código y luego usa ese perfil para generar código máquina más rápido para las rutas que importan. En .NET el JIT hace esto en tiempo de ejecución, un modo llamado Dynamic PGO, y la respuesta corta a "¿necesito activarlo?" es no, ya no. Dynamic PGO está habilitado por defecto desde .NET 8, así que en .NET 8, .NET 9, .NET 10 y .NET 11 ya lo tienes. Solo recurres al interruptor si estás en .NET 6 o 7 (donde estaba desactivado por defecto), o si tienes una carga de trabajo inusual y de vida muy corta en la que quieras desactivarlo. Este artículo explica qué te aporta el perfil, cómo confirmar que se está ejecutando y los pocos casos en los que vale la pena tocar el ajuste.

Todo lo que aquí se describe apunta a `<TargetFramework>net11.0</TargetFramework>` con el SDK de .NET 11 (`11.0.100`), pero el comportamiento activo por defecto se mantiene desde .NET 8, y el mecanismo subyacente ha sido estable desde que .NET 7 lo reforzó. Cuando un comportamiento dependa de una versión concreta, lo señalo.

## Qué significa realmente "guiado por perfil"

Un compilador optimizador tradicional tiene que adivinar. Cuando ve una llamada a un método virtual, no puede saber qué tipo concreto aparecerá en tiempo de ejecución, así que emite una llamada indirecta genérica. Cuando ve un `if`, no sabe qué rama es caliente, así que dispone ambas como si fueran igual de probables. Cuando ve un bucle, no sabe si se ejecuta dos veces o dos millones de veces. Esas suposiciones suelen estar bien y a veces dejan mucho rendimiento sobre la mesa.

La optimización guiada por perfil elimina las suposiciones. Ejecuta el programa, registra lo que realmente ocurrió en cada uno de esos puntos de decisión y devuelve esos datos al optimizador. Ahora el compilador sabe que un punto de llamada concreto fue `List<int>` el 98% de las veces, que una rama concreta se toma una vez de cada mil iteraciones, que un bucle concreto es genuinamente caliente. Puede especializar el código para la realidad en lugar de cubrirse ante todas las posibilidades.

El PGO clásico anticipado hace esto en dos compilaciones separadas: una compilación instrumentada que ejecutas contra una carga de trabajo representativa para producir un perfil, y luego una segunda compilación que consume el perfil. Así lo han hecho las cadenas de herramientas de C y C++ durante décadas, y es potente pero engorroso, porque tienes que capturar una carga de trabajo que se parezca a producción y recompilar. Dynamic PGO de .NET fusiona ambas fases en un solo proceso en ejecución, que es lo que lo convierte en algo que simplemente puedes dejar activado.

## Cómo se apoya Dynamic PGO en la compilación por niveles

Dynamic PGO no es una pasada separada atornillada al runtime. Se monta sobre la maquinaria que el JIT ya usa para compilar los métodos calientes dos veces. Si aún no has interiorizado ese modelo de dos pasadas, el artículo sobre [qué es la compilación por niveles y cómo razonar sobre ella](/es/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/) es el requisito previo; la versión muy corta es que los métodos primero se compilan como código "tier 0" rápido y sin optimizar, y solo los calientes se recompilan como código "tier 1" totalmente optimizado en segundo plano.

Dynamic PGO explota esa primera pasada. Cuando está activo, el código tier 0 que emite el JIT no es simplemente sin optimizar, está instrumentado. El compilador inserta sondas baratas que cuentan con qué frecuencia se ejecuta cada bloque básico y, en los puntos de llamada virtuales y de interfaz, construye un pequeño histograma de qué tipos concretos llegan realmente. Mientras tu aplicación se calienta, ese código tier 0 recopila silenciosamente un perfil de tu carga de trabajo específica. Cuando un método se promociona luego a tier 1, el optimizador lee el perfil que recopiló y especializa el código tier 1 en consecuencia.

Ese momento es todo el truco. El perfil se recopila de la carga de trabajo real, en la máquina real, momentos antes de que se produzca el código optimizado, así que no hay una compilación instrumentada separada ni un problema de carga de trabajo representativa. El coste es que el código tier 0 instrumentado es ligeramente más lento y ligeramente más grande que el tier 0 normal, lo que solo importa durante la breve ventana antes de la promoción.

## La optimización que paga todo lo demás: devirtualización guiada

Lo más valioso que habilita Dynamic PGO es la devirtualización guiada (GDV). Las llamadas virtuales y de interfaz son caras no porque el salto indirecto en sí sea lento, sino porque el JIT no puede hacer inlining a través de ellas, y el inlining es de donde la mayoría de las demás optimizaciones obtienen su ventaja. Si el compilador no puede ver dentro de una llamada, no puede plegar constantes a través de ella, izar trabajo fuera de ella ni eliminar comprobaciones redundantes a su alrededor.

Con un perfil de tipos a mano, el JIT puede insertar una ruta rápida. Emite una comprobación explícita del tipo que dominó el perfil y, si la comprobación pasa, ejecuta una copia inlined y totalmente optimizada del cuerpo de ese método; si falla, recurre a la llamada virtual normal. Considera un bucle sobre un `IEnumerable<int>` que en realidad siempre es un `List<int>`:

```csharp
// .NET 11, C# 14.
// Dynamic PGO learns that `items` is a List<int> at this call site
// and inlines the enumerator's MoveNext/Current behind a type guard.
static long Sum(IEnumerable<int> items)
{
    long total = 0;
    foreach (int x in items) // virtual GetEnumerator/MoveNext without PGO
        total += x;
    return total;
}
```

Sin PGO el `foreach` pasa por despacho de interfaz en cada elemento. Con PGO el JIT adivina `List<int>`, protege la suposición con una comprobación de tipo e inlinea el enumerador, de modo que el cuerpo del bucle se convierte en aritmética de enteros ceñida y sin asignaciones. A partir de .NET 8 el JIT puede incluso emitir más de una guarda en un punto que ve dos tipos dominantes, aunque la GDV múltiple está desactivada por defecto y protegida tras un ajuste de configuración. El equipo de .NET midió métodos del framework donde la GDV por sí sola redujo el tiempo de ejecución en aproximadamente un 40%, e informó de mejoras reales en producción: [la migración de Bing a .NET 8](https://devblogs.microsoft.com/dotnet/bing-on-dotnet-8-the-impact-of-dynamic-pgo/) atribuyó una caída del 13% en los ciclos de CPU por consulta, una reducción del 20% en las consultas afectadas por GC de gen0/gen1 y algunas latencias internas cayendo más de un 25%, en gran parte a que Dynamic PGO está activo por defecto.

## ¿Necesito activarlo? La respuesta versión por versión

Aquí está la parte que la consulta de búsqueda realmente pregunta.

- **.NET 8, 9, 10 y 11**: no. Dynamic PGO está activo por defecto. No haces nada. Si tienes `<TieredCompilation>` en su valor por defecto (habilitado), ya tienes PGO.
- **.NET 7**: existe y funciona bien, pero está desactivado por defecto. Actívalo con el ajuste de abajo si lo quieres.
- **.NET 6**: se introdujo aquí como experimento, desactivado por defecto y menos maduro. Puedes activarlo, pero trátalo como calidad preliminar.
- **.NET 5 y anteriores**: Dynamic PGO no existe.

Para activarlo donde no es el valor por defecto, establece la propiedad de MSBuild en tu archivo de proyecto:

```xml
<!-- .NET 7 (or .NET 6). Opts into Dynamic PGO, which is off by default there. -->
<!-- Unnecessary on .NET 8+, where it is already enabled. -->
<PropertyGroup>
  <TieredPGO>true</TieredPGO>
</PropertyGroup>
```

O establece la variable de entorno, que es útil para pruebas A/B sin recompilar:

```bash
# Enable Dynamic PGO for a single run (any supported .NET version).
DOTNET_TieredPGO=1 ./myapp
```

La propiedad de MSBuild, la clave de `runtimeconfig.json` (`System.Runtime.TieredPGO`) y la variable de entorno `DOTNET_TieredPGO` controlan todas el mismo interruptor, documentado en la referencia de [ajustes de configuración de compilación](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation) de Microsoft. Como Dynamic PGO depende de la compilación por niveles, desactivar la compilación por niveles (`DOTNET_TieredCompilation=0`) también desactiva Dynamic PGO como efecto secundario; no hay pasada de perfil si no hay tier 0.

## Cuándo podrías legítimamente desactivarlo

Dejar PGO activo es la decisión correcta para casi cualquier aplicación, pero hay una excepción honesta: un proceso que termina antes de que sus métodos calientes lleguen a tier 1. Una CLI de vida corta, una función serverless que atiende una petición y muere, un AWS Lambda con un timeout agresivo. En esas cargas de trabajo el código tier 0 instrumentado se ejecuta, paga el pequeño impuesto de perfilado, y el proceso se cierra antes de que ocurra cualquier recompilación a tier 1, así que pagaste por un perfil que nunca gastaste.

```xml
<!-- .NET 11, C# 14. Turns Dynamic PGO OFF. -->
<!-- Only sensible for ultra-short-lived processes that never reach tier 1. -->
<PropertyGroup>
  <TieredPGO>false</TieredPGO>
</PropertyGroup>
```

Incluso aquí, no lo des por hecho; mide. Muchas cargas de trabajo sensibles al arranque en frío obtienen una mayor ganancia de una estrategia completamente distinta, como imágenes ReadyToRun o Native AOT, que de alternar PGO. Los compromisos para el arranque en frío en concreto se trabajan en la guía sobre [reducir el tiempo de arranque en frío de un AWS Lambda con .NET 11](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/). Y si estás considerando renunciar por completo al JIT, ten en cuenta que el código de [Native AOT](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/) nunca obtiene la reoptimización en tiempo de ejecución de Dynamic PGO, porque no hay pasada de perfilado tier 0 en un binario anticipado.

## Static PGO: el perfil que trae el framework

Dynamic PGO no es el único PGO en .NET. Las propias imágenes ReadyToRun precompiladas del framework se construyen con static PGO: Microsoft recopila un perfil sin conexión, lo almacena como un archivo `.mibc` y se lo da al compilador `crossgen2` de modo que incluso el código anticipado del framework se disponga según un perfil representativo. Por eso `string`, `List<T>` y el resto de la biblioteca de clases base llegan ya ajustados antes de que tu aplicación ejecute una sola línea.

Puedes hacer lo mismo para tus propias compilaciones AOT o ReadyToRun: captura un perfil con las herramientas, produce un `.mibc` y pásaselo a `crossgen2`. Este es un flujo de trabajo de nicho y avanzado, relevante sobre todo si publicas Native AOT y quieres una disposición informada por perfil sin un JIT en tiempo de ejecución. Para la gran mayoría de aplicaciones de servidor y escritorio que mantienen el JIT, Dynamic PGO te da la misma clase de beneficio automáticamente y se adapta a la carga de trabajo real en lugar de a un perfil enlatado, lo cual es estrictamente mejor que un perfil estático horneado en tiempo de compilación. La elección entre JIT-con-PGO y los modelos AOT es el tema de [Native AOT vs ReadyToRun vs JIT plano en .NET 11](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).

## Cómo confirmar que PGO realmente hace algo

Como PGO es silencioso por diseño, la pregunta natural es cómo sabes que está funcionando. Dos enfoques.

El primero es mirar el código máquina. Establecer `DOTNET_JitDisasm` con el nombre de un método vuelca el ensamblador tier 1, y un método que ha pasado por GDV muestra una forma reveladora: una comparación de tipo, una ruta rápida inlined y una llamada de reserva. Si desactivas PGO y vuelves a volcar, la guarda y el cuerpo inlined desaparecen y te queda una llamada virtual plana. Ese antes y después es la prueba más clara de que el perfil cambió la salida.

```bash
# .NET 11 SDK 11.0.100. Dump the JIT's assembly for a specific method,
# then compare with DOTNET_TieredPGO=0 to see the guarded fast path vanish.
DOTNET_JitDisasm=Sum DOTNET_TieredPGO=1 ./myapp
```

El segundo enfoque es medir el rendimiento correctamente, lo que significa medir el código tier 1 en estado estacionario y no el calentamiento tier 0 que lo precede. No hagas a mano un bucle con `Stopwatch`; usa [BenchmarkDotNet](https://benchmarkdotnet.org/), que calienta hasta que los tiempos se estabilizan y puede ejecutar el mismo benchmark con PGO activo y desactivado para que compares lo comparable. Si quieres ver los eventos de niveles y JIT pasar en un proceso real, el artículo sobre [perfilar una aplicación de .NET con dotnet-trace](/es/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) recorre la captura del proveedor del runtime que informa del nivel de optimización de cada método.

El modelo mental a retener: PGO es la razón por la que el diseño de .NET de "compilar los métodos calientes dos veces" produce código que un compilador estático no puede igualar, porque la segunda compilación está informada por un perfil de tu carga de trabajo real. En .NET 8 y posteriores ya está activo, ya se adapta y ya se paga solo. No necesitas activarlo. Solo necesitas saber que está ahí, para que cuando hagas benchmarks midas el nivel optimizado y acredites al perfil la velocidad que se ganó.

## Related

- [¿Qué es la compilación por niveles y cómo razono sobre ella?](/es/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/)
- [¿Qué es Native AOT y qué te cuesta?](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Native AOT vs ReadyToRun vs JIT plano en .NET 11](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [Cómo perfilar una aplicación de .NET con dotnet-trace y leer la salida](/es/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)
- [Cómo reducir el tiempo de arranque en frío de un AWS Lambda con .NET 11](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)

## Sources

- [Ajustes de configuración de compilación, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation)
- [Documento de diseño de Dynamic PGO, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/DynamicPgo.md)
- [Performance Improvements in .NET 8, .NET Blog](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-8/)
- [Bing on .NET 8: The Impact of Dynamic PGO, .NET Blog](https://devblogs.microsoft.com/dotnet/bing-on-dotnet-8-the-impact-of-dynamic-pgo/)
