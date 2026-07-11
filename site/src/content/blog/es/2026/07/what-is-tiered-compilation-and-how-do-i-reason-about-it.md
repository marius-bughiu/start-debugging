---
title: "¿Qué es la compilación por niveles y cómo razonar sobre ella?"
description: "La compilación por niveles permite que el JIT de .NET compile cada método dos veces: primero rápido y sin optimizar para poner en marcha la aplicación, y luego de nuevo con optimizaciones completas cuando el runtime sabe que un método es caliente. Aquí verás cómo encajan el tier 0, el tier 1, el reemplazo en pila y el Dynamic PGO, y cómo observarlos y ajustarlos."
pubDate: 2026-07-11
tags:
  - "dotnet"
  - "performance"
  - "jit"
  - "dotnet-11"
  - "csharp"
lang: "es"
translationOf: "2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it"
translatedBy: "claude"
translationDate: 2026-07-11
---

La compilación por niveles es la estrategia del runtime de .NET de compilar cada método más de una vez. La primera vez que se ejecuta un método, el compilador JIT (just-in-time) produce código de "tier 0" rápidamente y casi sin optimización, para que tu aplicación arranque rápido. Si más tarde ese método resulta ser caliente (llamado al menos 30 veces, o girando en un bucle largo), un subproceso en segundo plano lo recompila como código "tier 1" totalmente optimizado y lo intercambia sin ruido. Obtienes la velocidad de arranque y el rendimiento en régimen estacionario del mismo binario, sin tener que elegir entre ambos. Está activada por defecto desde .NET Core 3.0, y en .NET 8 y posteriores también alimenta a un perfilador (Dynamic PGO) que hace que el código de tier 1 sea más inteligente de lo que un compilador estático podría lograr. Esta entrada explica las piezas móviles y cómo razonar sobre ellas cuando perfilas o mides.

Todo lo aquí descrito apunta a `<TargetFramework>net11.0</TargetFramework>` con el SDK de .NET 11 (`11.0.100`), pero la mecánica ha sido estable desde .NET 7, cuando el reemplazo en pila y el jitting rápido de bucles pasaron a ser el comportamiento por defecto en x64 y arm64. Cuando un comportamiento depende de una versión concreta, lo señalo.

## Por qué el runtime compila el mismo método dos veces

Un compilador JIT enfrenta un dilema cada vez que ve un método por primera vez. Puede compilar ese método lentamente y producir código máquina excelente, lo cual es ideal para un método que se ejecuta un millón de veces pero un desperdicio para un método que se ejecuta una sola vez durante el arranque. O puede compilar rápido y producir código mediocre, lo cual es ideal para el arranque pero deja rendimiento sobre la mesa en las rutas calientes.

Los compiladores ahead-of-time esquivan esto optimizándolo todo por adelantado, y lo pagan con tiempo de compilación y binarios más grandes. Un JIT puro que siempre optimiza lo paga con un arranque lento, porque una aplicación real compila con JIT miles de métodos antes de servir su primera solicitud. La compilación por niveles se niega a elegir. Compila rápido primero para que el proceso se ponga en marcha, luego observa qué métodos importan realmente y recompila solo esos con el optimizador costoso. La inmensa mayoría de los métodos de cualquier proceso se ejecutan un puñado de veces y nunca llegan a ganarse el tier 1, así que el presupuesto del optimizador va donde rinde.

## Tier 0 y tier 1: qué significan realmente "rápido" y "optimizado"

El tier 0 lo produce el "quick JIT". El compilador omite la mayoría de las optimizaciones: sin inlining agresivo, sin desenrollado de bucles, con asignación mínima de registros. Emite código máquina directo en una fracción del tiempo que tomaría una compilación completa. El código resultante es correcto y a menudo varias veces más lento que el código optimizado, pero existe casi de inmediato.

El tier 1 es el optimizador completo. Hace inlining, elimina comprobaciones de límites cuando puede demostrar que son redundantes, saca invariantes de los bucles y (desde .NET 8) usa datos de perfil recogidos mientras corría el tier 0. La compilación de tier 1 es mucho más lenta de producir, que es exactamente por lo que el runtime solo la gasta en métodos que han demostrado que valen la pena.

Hay una tercera fuente de código que participa en el mismo sistema: ReadyToRun (R2R). Los ensamblados del framework se distribuyen con código R2R precompilado, para que el runtime no tenga que compilar con JIT `string.Substring` en cada lanzamiento. El código R2R se trata como un tier prehorneado que aún puede ser reemplazado por una versión de tier 1 incluso mejor, una vez que el método resulta ser caliente en tu carga de trabajo concreta. Por eso desactivar la compilación por niveles puede a veces hacer que una aplicación sea más lenta en lugar de más rápida: pierdes la capacidad de reoptimizar métodos del framework con tu perfil.

## El umbral de conteo de llamadas y el retardo de niveles

Un método no salta al tier 1 en el momento en que se calienta. Dos mecanismos controlan la promoción.

Primero, un contador de llamadas. Cada método de tier 0 tiene un contador, y una vez que ha sido llamado 30 veces (el valor por defecto de `DOTNET_TC_CallCountThreshold`), se pone en cola para la recompilación a tier 1. Treinta es deliberadamente bajo; el objetivo es atrapar cualquier cosa que se ejecute repetidamente sin esperar a que corra miles de veces en código lento.

Segundo, un retardo de arranque. El runtime no empieza a contar llamadas de inmediato, porque durante el arranque casi todos los métodos se están llamando por primera vez y ninguno está aún caliente en régimen estacionario. Hay un temporizador de aproximadamente 100 ms que se reinicia cada vez que se compila con JIT un nuevo método de tier 0. Solo cuando ese temporizador transcurre sin nuevas compilaciones de tier 0, es decir, cuando la tormenta de JIT del arranque se ha calmado, empieza en serio el conteo de llamadas. Por eso el arranque en sí se queda en código de tier 0 barato y el optimizador no se agita sobre métodos que solo corrieron durante la inicialización.

La recompilación ocurre en un subproceso en segundo plano tomado del pool de subprocesos, trabajando en rebanadas de unos 10 ms cada vez para que nunca monopolice a un trabajador. Tu método caliente sigue ejecutando su código de tier 0 hasta que la versión optimizada está lista, momento en el cual el runtime redirige atómicamente las llamadas futuras al código de tier 1. Nada se bloquea, y ninguna llamada en vuelo se interrumpe.

```csharp
// .NET 11, C# 14.
// Call this in a tight loop and the runtime will promote it to tier 1
// after ~30 calls, once startup has settled. You will not see the
// promotion in the method's behavior, only in its speed.
static long SumOfSquares(int n)
{
    long acc = 0;
    for (int i = 0; i < n; i++)
        acc += (long)i * i;
    return acc;
}
```

## Reemplazo en pila: escapar de un bucle caliente que nunca retorna

El mecanismo de conteo de llamadas tiene un hueco evidente. ¿Qué pasa con un método que se llama exactamente una vez pero luego gira en un bucle durante toda la vida del proceso? Piensa en `Main`, o en un worker que itera sobre una cola para siempre. Su conteo de llamadas es 1, así que quedaría atrapado en código lento de tier 0 permanentemente.

El reemplazo en pila (OSR, on-stack replacement) cierra ese hueco. Cuando el quick JIT emite código de tier 0 para un método que contiene un bucle, también inserta un pequeño contador en la arista trasera del bucle (el salto de vuelta al principio). Si esa arista trasera se ejecuta suficientes veces, el runtime compila una versión optimizada del método y transfiere la ejecución a ella en pleno vuelo, reemplazando el marco de pila en ejecución en el sitio. El bucle que empezó en tier 0 termina en tier 1 sin que el método haya retornado nunca.

El OSR es lo que hace seguro compilar con quick JIT métodos con bucles en primer lugar. Antes de que llegara el OSR, el runtime se negaba a aplicar quick JIT a cualquier método que contuviera un bucle (el antiguo valor por defecto `false` de `TieredCompilationQuickJitForLoops`), porque un bucle largo atrapado en código sin optimizar era un verdadero precipicio de rendimiento. La [PR #65675 en dotnet/runtime](https://github.com/dotnet/runtime/pull/65675) activó por defecto tanto `DOTNET_TC_QuickJitForLoops` como `DOTNET_TC_OnStackReplacement` para x64 y arm64 en .NET 7, así que hoy casi todos los métodos empiezan en tier 0 y el runtime confía en el OSR para rescatar cualquier cosa atrapada en un bucle largo. El resultado fue una mejora de arranque de aproximadamente el 25 % en aplicaciones con mucho JIT, y de un 10 a 30 % mejor tiempo hasta la primera solicitud en los benchmarks de TechEmpower, según el [informe de rendimiento de .NET 7](https://devblogs.microsoft.com/dotnet/performance_improvements_in_net_7/).

## Dynamic PGO: la pasada de tier 0 también perfila

Aquí está la parte que sorprende a la gente. En .NET 8 y posteriores, el Dynamic PGO (profile-guided optimization) está activado por defecto, y es lo que hace que todo el diseño de dos pasadas sea más que un simple "compilar dos veces".

Cuando el Dynamic PGO está activo, el código de tier 0 no solo está sin optimizar, sino que también está instrumentado. Registra hechos baratos sobre cómo se comporta realmente el método: qué tipos concretos aparecen en un sitio de llamada virtual, qué rama de un `if` se toma más a menudo, cuántas veces itera un bucle. Cuando el método se promueve a tier 1, el optimizador lee ese perfil y especializa el código para lo que realmente ocurrió en tiempo de ejecución. Una llamada virtual cuyo destino fue `List<int>` el 99 % de las veces obtiene esa ruta con inlining, protegida por una comprobación de tipo (devirtualización protegida). Una rama que casi nunca se toma se saca de la ruta caliente.

Esta es una optimización que un compilador estático no puede hacer, porque depende de datos que solo existen mientras corre tu carga de trabajo concreta. También es por lo que la compilación por niveles más Dynamic PGO puede superar a una configuración totalmente optimizada desde el inicio en rendimiento real, no solo en arranque. Puedes desactivarlo para comparar:

```xml
<!-- .NET 11, C# 14. Disables Dynamic PGO. Default is enabled since .NET 8. -->
<PropertyGroup>
  <TieredPGO>false</TieredPGO>
</PropertyGroup>
```

El compromiso es que el código de tier 0 instrumentado es ligeramente más lento y ligeramente más grande que el tier 0 simple, y el resultado de tier 1 es mejor. Para un servidor que corre durante horas, esa es una victoria fácil. Para una función de vida corta que termina antes de que algo llegue a tier 1, la instrumentación es puro coste sin recompensa, que es una de las razones por las que las cargas de trabajo sensibles al arranque en frío a veces desactivan esto. Hay un tratamiento más completo de ese escenario en la guía sobre [reducir el tiempo de arranque en frío de un AWS Lambda con .NET 11](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/).

## Cómo ver la asignación de niveles en acción

Razonar sobre la compilación por niveles es mucho más fácil una vez que puedes verla. El runtime emite eventos ETW/EventPipe para cada compilación JIT, etiquetados con el tier, así que `dotnet-trace` puede mostrarte las transiciones:

```bash
# .NET 11 SDK 11.0.100. Capture JIT and tiering events for a running process.
dotnet-trace collect --process-id 1234 \
  --providers Microsoft-Windows-DotNETRuntime:0x1000:5
```

Los eventos `MethodJittingStarted` y `MethodLoadVerbose` llevan un campo de nivel de optimización, así que un método que aparece dos veces, primero como tier 0 y luego como tier 1, es la promoción que estás buscando. Para un recorrido de cómo leer estas trazas, consulta la entrada sobre [perfilar una aplicación de .NET con dotnet-trace](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/).

Si quieres ver el código máquina que el JIT produjo en cada nivel, `DOTNET_JitDisasmSummary=1` imprime una línea por método con su tier, y asignar a `DOTNET_JitDisasm` un nombre de método vuelca el ensamblador real. Herramientas como el [visor de desensamblado de Rider 2026.1](/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) exponen la misma salida sin lidiar con variables de entorno. Comparar el desensamblado de tier 0 y tier 1 del mismo método es la forma más rápida de construir intuición sobre lo que compra "optimizado".

## La trampa de medición en la que todo el mundo cae

El error más común con la compilación por niveles es medir código de tier 0 por accidente. Si escribes un bucle con cronómetro que ejecuta tu método unas miles de veces y promedia el resultado, las primeras iteraciones corren en tier 0 lento, la promoción ocurre a mitad de camino y tu promedio es una mezcla sin sentido de dos piezas de código distintas.

La solución es calentar. Ejecuta el método suficientes veces para disparar la promoción, espera a que la compilación en segundo plano termine, y solo entonces empieza a medir. Esto es exactamente lo que hace [BenchmarkDotNet](https://benchmarkdotnet.org/) por ti: ejecuta una fase de calentamiento, detecta cuándo se estabilizan los tiempos y mide el código de tier 1 en régimen estacionario. No hagas a mano un microbenchmark con `Stopwatch` y confíes en el número; casi con certeza estás midiendo el tier equivocado. Si tienes que hacerlo, puedes forzar la cuestión asignando `DOTNET_TieredCompilation=0` para que todo se compile directamente a código optimizado, pero eso cambia el comportamiento de arranque y tampoco es como corre tu aplicación en producción.

## Las perillas, y cuándo deberías tocarlas de verdad

Los valores por defecto son buenos. El equipo de .NET los ajusta contra una enorme batería de aplicaciones reales, y la respuesta honesta para la mayoría de los proyectos es dejar cada ajuste en paz. Dicho esto, las palancas existen por una razón:

- `TieredCompilation` (env `DOTNET_TieredCompilation`, activado por defecto): desactívalo solo para forzar código totalmente optimizado en todas partes, a costa de un arranque mucho más lento. Ocasionalmente útil para un servicio crítico en latencia que puede permitirse un calentamiento largo y quiere cero jitter de tier 0, pero mide antes de comprometerte.
- `TieredCompilationQuickJit` (env `DOTNET_TC_QuickJit`, activado por defecto): desactivar esto hace que el tier 0 use el optimizador completo, lo cual en su mayor parte derrota el propósito.
- `TieredCompilationQuickJitForLoops` (env `DOTNET_TC_QuickJitForLoops`, activado por defecto desde .NET 7 en x64/arm64): junto con el OSR, rara vez vale la pena cambiarlo.
- `TieredPGO` (env `DOTNET_TieredPGO`, activado por defecto desde .NET 8): el que podrías desactivar legítimamente para procesos ultracortos, o activar para una aplicación de .NET 6/7 anterior al cambio de valor por defecto.

Todos estos se corresponden con propiedades de MSBuild en el `.csproj` y con claves `System.Runtime.*` en `runtimeconfig.json`, documentadas en la referencia de [ajustes de configuración de compilación](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation) de Microsoft. Si estás sopesando el JIT por niveles frente a renunciar al JIT por completo, los compromisos están en [Native AOT frente a ReadyToRun frente a JIT simple](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) y en la mirada más profunda a [qué te cuesta Native AOT](/2026/06/what-is-native-aot-and-what-does-it-cost-you/), ya que el código de AOT nunca obtiene la reoptimización del Dynamic PGO en absoluto.

El modelo mental que conviene retener: tu proceso arranca en código de tier 0 barato y rápido de producir que va tomando notas sin ruido; un pequeño número de métodos demuestran que son calientes; un subproceso en segundo plano reescribe exactamente esos métodos con el optimizador completo informado por las notas; y el OSR atrapa cualquier cosa atascada en un bucle que el conteo de llamadas se perdería. Una vez que puedas ver eso ocurriendo en una traza, la compilación por niveles deja de ser una caja negra y empieza a ser una herramienta sobre la que puedes razonar.

## Relacionados

- [Native AOT frente a ReadyToRun frente a JIT simple en .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [¿Qué es Native AOT y qué te cuesta?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Cómo perfilar una aplicación de .NET con dotnet-trace y leer la salida](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)
- [Cómo reducir el tiempo de arranque en frío de un AWS Lambda con .NET 11](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)
- [El visor de ASM de Rider 2026.1 para desensamblado de JIT y Native AOT](/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/)

## Fuentes

- [Ajustes de configuración de compilación, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation)
- [Documento de diseño de compilación por niveles, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/tiered-compilation.md)
- [Documento de diseño de reemplazo en pila, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/OnStackReplacement.md)
- [Enable QJFL and OSR by default for x64 and arm64, PR #65675](https://github.com/dotnet/runtime/pull/65675)
- [Performance Improvements in .NET 7, .NET Blog](https://devblogs.microsoft.com/dotnet/performance_improvements_in_net_7/)
- [Documento de diseño de Dynamic PGO, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/DynamicPgo.md)
