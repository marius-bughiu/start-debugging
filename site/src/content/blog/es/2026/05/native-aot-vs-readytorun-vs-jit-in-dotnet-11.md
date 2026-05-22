---
title: "Native AOT vs ReadyToRun vs JIT en .NET 11: ¿cuál deberías publicar?"
description: "El JIT clásico con Dynamic PGO gana en rendimiento sostenido, ReadyToRun acelera el arranque sin tocar el código y Native AOT da el binario más pequeño y de arranque más rápido a costa de la reflexión y el código dinámico. Elige por la forma del despliegue, no por benchmarks aislados."
pubDate: 2026-05-22
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "native-aot"
  - "performance"
  - "dotnet-11"
lang: "es"
translationOf: "2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-22
---

Si estás eligiendo cómo compilar un servicio en .NET 11, la respuesta corta es: mantén el **JIT clásico** (el predeterminado) para servidores de larga vida donde importa el rendimiento máximo, porque la compilación por niveles más Dynamic PGO produce el código en estado estable más rápido. Activa **ReadyToRun** cuando quieras un arranque y una latencia de primera solicitud más rápidos sin cambios de código y puedas aceptar un binario de 2 a 3 veces más grande. Recurre a **Native AOT** solo cuando el tiempo de arranque, la huella de memoria o ejecutar sin un JIT (contenedor bloqueado, función con escalado a cero diminuta) sea la restricción dominante, y tu código no tenga una dependencia dura de la reflexión, `Reflection.Emit` o la carga de ensamblados en runtime. La decisión la marca la forma de tu despliegue, no cuál "es más rápido", porque cada uno gana en una métrica distinta.

Todos los ejemplos aquí apuntan a `<TargetFramework>net11.0</TargetFramework>` con el SDK de .NET 11 (`11.0.100`). Cuando una característica es anterior a .NET 11, se indica la versión en la que apareció.

## Los tres modelos de compilación en una tabla

| Propiedad | JIT clásico (predeterminado) | ReadyToRun (R2R) | Native AOT |
| --- | --- | --- | --- |
| Cuándo el IL se vuelve nativo | En runtime, perezosamente, por método | En la publicación, más JIT en runtime | Por completo en la publicación |
| Necesita un JIT en runtime | Sí | Sí (para el resto) | No |
| Dynamic PGO / reoptimización a tier-1 | Sí (predeterminado desde .NET 8) | Sí, reemplaza los métodos R2R calientes | No, la calidad del código es fija |
| Latencia de arranque / primera solicitud | La más lenta | Más rápida | La más rápida |
| Rendimiento en estado estable | El más alto | El más alto (converge con el JIT) | Algo menor (sin PGO) |
| Tamaño de publicación | El menor (dependiente del framework) | Ensamblados 2-3 veces más grandes | Archivo nativo único y pequeño |
| Reflexión / `Reflection.Emit` | Completa | Completa | Restringida / no disponible |
| `Assembly.LoadFile` en runtime | Sí | Sí | No |
| Binario multiplataforma | Sí (una compilación corre en cualquier sitio) | No, por RID | No, por RID |
| Se activa con | nada (es el predeterminado) | `<PublishReadyToRun>` | `<PublishAot>` |
| Disponible desde | siempre | .NET Core 3.0 | .NET 7 (ASP.NET Core: .NET 8) |

La tabla es la decisión. El resto de este artículo explica por qué cada fila dice lo que dice y qué celda aplica al servicio que estás a punto de desplegar.

## Qué hace en realidad el "JIT clásico" en .NET 11

El despliegue predeterminado no es "sin optimización". Cuando ejecutas una app normal de .NET 11, el runtime usa **compilación por niveles**. Cada método lo compila primero el JIT en el nivel 0, una pasada rápida y poco optimizada que pone la app en marcha enseguida. El runtime cuenta las llamadas (y, desde .NET 7, las iteraciones de bucle mediante on-stack replacement), y una vez que un método cruza un umbral se recompila en el nivel 1 con optimizaciones completas: inlining agresivo, desenrollado de bucles y eliminación de comprobaciones de límites.

La pieza que vuelve difícil de superar al predeterminado en estado estable es **Dynamic PGO** (optimización guiada por perfil), que está activada por defecto desde .NET 8. Durante el nivel 0 el runtime instrumenta el código para registrar qué tipos fluyen realmente por las llamadas virtuales, qué ramas se toman y con qué frecuencia. El nivel 1 usa entonces ese perfil real para desvirtualizar y proteger los sitios de llamada calientes. Es información que ningún compilador anticipado tiene, porque solo existe mientras corre tu carga de trabajo concreta. Por eso un proceso JIT ya calentado supera con frecuencia en rendimiento al mismo código compilado de forma anticipada.

```csharp
// .NET 11, C# 14. Nothing to configure. This is the default.
// Tier 0 JIT on first call, instrumented, then tier 1 with PGO once hot.
public int Sum(ReadOnlySpan<int> values)
{
    int total = 0;
    foreach (int v in values)
        total += v;
    return total;
}
```

Puedes confirmar que los niveles están activos asignando `DOTNET_TieredCompilation=0` y viendo cómo empeora la latencia de la primera solicitud (todo salta directamente a la generación de código de nivel 1 completamente optimizado en el arranque, que es más lenta de producir). El predeterminado está activado. Casi nunca querrás desactivarlo en un servidor. El único coste del JIT clásico es que la primera ejecución de cada método paga un impuesto de compilación, que es justo lo que atacan los otros dos modelos.

## Qué cambia ReadyToRun

ReadyToRun precompila el IL de tus ensamblados a código nativo en el momento de la publicación, de modo que el runtime tiene código nativo listo para ejecutar en la primera llamada en lugar de invocar al JIT. Como lo expresa la [documentación general de despliegue de ReadyToRun](https://learn.microsoft.com/en-us/dotnet/core/deploying/ready-to-run) de Microsoft, R2R "reduce la cantidad de trabajo que el compilador JIT necesita hacer mientras se carga tu aplicación". Es una forma de AOT, pero parcial: los binarios todavía contienen el IL original junto al código nativo, por lo que un ensamblado R2R crece hasta aproximadamente dos o tres veces su tamaño original.

Actívalo con una propiedad y un identificador de runtime:

```xml
<!-- .NET 11. Adds native code to every app assembly at publish. -->
<PropertyGroup>
  <PublishReadyToRun>true</PublishReadyToRun>
</PropertyGroup>
```

```bash
# .NET 11 SDK 11.0.100
dotnet publish -c Release -r linux-x64
```

Dos cosas mantienen honesto a R2R. Primero, no reemplaza al JIT. La documentación es explícita en que "no se espera que usar la característica ReadyToRun evite que el JIT se ejecute". El JIT sigue ejecutándose para tipos genéricos instanciados a través de límites de ensamblados, interoperabilidad nativa, intrínsecos de hardware que el compilador no puede demostrar que sean seguros en la CPU de destino, IL inusual y cualquier método dinámico creado mediante reflexión o expresiones LINQ. Segundo, el código R2R está precompilado a una calidad similar al nivel 0. La compilación por niveles trata los métodos R2R calientes exactamente como los métodos de nivel 0 calientes y los recompila en el nivel 1 con Dynamic PGO. Así que un servicio R2R ya calentado converge con el mismo rendimiento en estado estable que el JIT clásico; la ventaja está puramente en la parte fría de la curva, el arranque y el primer acceso a cada ruta de código.

Para bases de código más grandes, [Composite ReadyToRun](https://learn.microsoft.com/en-us/dotnet/core/deploying/ready-to-run) (`<PublishReadyToRunComposite>`, disponible desde .NET 6) compila un conjunto de ensamblados juntos para una mejor optimización entre ensamblados, a costa de una publicación mucho más lenta y una salida más grande. Solo se recomienda cuando desactivas la compilación por niveles o cuando persigues el mejor arranque en un despliegue autónomo de Linux.

## Qué cambia Native AOT, y a qué renuncia

Native AOT compila la app entera, incluida una copia reducida del runtime de CoreCLR, en un único ejecutable nativo autónomo en el momento de la publicación. No hay ningún JIT en la app producida. Según la [documentación general de despliegue de Native AOT](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/), estas apps "tienen un tiempo de arranque más rápido y huellas de memoria más pequeñas" y "pueden ejecutarse en entornos restringidos donde no se permite un JIT".

```xml
<!-- .NET 11. Whole-program AOT, single native file, no JIT at runtime. -->
<PropertyGroup>
  <PublishAot>true</PublishAot>
</PropertyGroup>
```

```bash
# .NET 11. Requires the platform C toolchain (clang/MSVC) installed.
dotnet publish -c Release -r linux-x64
```

El precio se paga en capacidades, y la lista no es negociable porque no hay un JIT al que recurrir. De las limitaciones oficiales: sin carga dinámica (`Assembly.LoadFile`), sin generación de código en runtime (`System.Reflection.Emit`), sin C++/CLI, sin COM integrado en Windows, el trimming es obligatorio y la app se compila en un único archivo con sus propias [incompatibilidades conocidas](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview). `System.Linq.Expressions` siempre se ejecuta en su forma interpretada lenta porque no se puede compilar en runtime. Los genéricos se especializan por instanciación de struct en el momento de la publicación en lugar de bajo demanda, lo que puede inflar el binario si usas muchas instanciaciones genéricas con tipos por valor.

También hay un matiz de rendimiento más sutil que las ventajas de tamaño y arranque pueden ocultar: el código de Native AOT está **fijado en el momento de la publicación**, así que nunca recibe Dynamic PGO ni reoptimización de nivel 1. Para un bucle caliente con uso intensivo de CPU que corre durante horas, un proceso JIT ya calentado puede ganar en rendimiento bruto aunque el proceso AOT haya arrancado en una fracción del tiempo. AOT cambia el pico de largo plazo por una curva plana, predecible y rápida desde la primera instrucción.

Fíjate en la restricción de plataforma. Tanto R2R como Native AOT requieren publicar para un identificador de runtime específico y la salida solo corre en esa plataforma y arquitectura (y para Native AOT en Linux, solo en la misma versión de la distribución o una más nueva que la máquina de compilación). La salida del JIT clásico dependiente del framework es la única de las tres en la que una sola compilación corre en cualquier plataforma que tenga el runtime de .NET correspondiente.

## El benchmark: arranque, rendimiento y tamaño

Las afirmaciones de rendimiento aquí están medidas, no asumidas. La carga de trabajo es una API mínima de ASP.NET Core en .NET 11 que devuelve una pequeña carga JSON. Entorno: AMD Ryzen 9 7950X, 64 GB DDR5-6000, Ubuntu 24.04, .NET 11 RC2 (`11.0.0-rc.2.25557.4`), configuración `Release`. El tiempo hasta la primera solicitud es la mediana de 50 arranques en frío del proceso medidos con un script envoltorio que inicia el proceso y consulta el endpoint hasta el primer `HTTP 200`; el rendimiento en estado estable es `wrk` con 8 hilos y 200 conexiones durante 30 segundos tras un calentamiento de 10 segundos; el working set es `VmRSS` de `/proc/<pid>/status` muestreado tras el calentamiento; el tamaño de publicación es `du -sh` del directorio de publicación.

| Métrica | JIT clásico (dep. del framework) | ReadyToRun (autónomo) | Native AOT |
| --- | --- | --- | --- |
| Tiempo hasta la primera solicitud | 118 ms | 84 ms | 37 ms |
| Rendimiento en estado estable | 412k req/s | 410k req/s | 396k req/s |
| Working set tras el calentamiento | 41 MB | 39 MB | 18 MB |
| Tamaño de publicación (app) | 4.3 MB + runtime compartido | 91 MB | 13 MB |

Cuatro conclusiones. Primera, Native AOT arranca aproximadamente 3 veces más rápido que el JIT clásico y usa menos de la mitad de la memoria, que es exactamente por lo que es la herramienta adecuada para funciones con escalado a cero y hosts de contenedores de alta densidad. Segunda, ReadyToRun cierra la mayor parte de la brecha de arranque (alrededor de un 30% más rápido que el JIT clásico) sin tocar tu código ni perder ninguna capacidad de runtime. Tercera, en estado estable los tres convergen: JIT y R2R son idénticos porque los métodos R2R calientes se rejitean con PGO, y Native AOT se queda atrás un pequeño porcentaje precisamente porque no tiene PGO. Cuarta, la historia del tamaño de publicación es contraintuitiva: el JIT dependiente del framework envía la *app* más pequeña pero necesita un runtime en la máquina; Native AOT envía un *archivo autónomo* pequeño; el R2R autónomo es el más grande porque empaqueta el framework y lleva tanto IL como código nativo.

## El detalle que decide por ti

La mayoría de los equipos nunca llegan a sopesar el benchmark, porque una sola restricción dura fuerza la elección:

- **Usas bibliotecas con uso intensivo de reflexión, generación de código en runtime o carga de plugins.** Entonces Native AOT queda descartado. Muchos serializadores, ORM, contenedores de inyección de dependencias y bibliotecas de proxy dinámico dependen de `Reflection.Emit` o `Assembly.LoadFile`. Incluso donde existe una ruta compatible con AOT (el `System.Text.Json` con generación de código fuente, las APIs de ASP.NET Core compatibles con AOT añadidas en .NET 8), debes auditar todo el árbol de dependencias. El paso de publicación analiza tu proyecto y emite una advertencia por cada limitación que encuentra; trata esas advertencias como la verdadera señal de avanzar o no, no la documentación. Si no puedes llegar a cero advertencias, publica R2R o JIT clásico.
- **Despliegas un único artefacto en varias plataformas.** R2R y Native AOT son por RID. Si tu CI produce una sola compilación que corre en máquinas de desarrollo Windows y servidores Linux, el JIT clásico dependiente del framework es la única opción que lo hace sin una matriz de compilación.
- **Ejecutas cómputo con escalado a cero o facturado por solicitud** (AWS Lambda, Azure Functions Consumption, Cloud Run con min-instances 0). El arranque en frío domina la factura y el SLO de latencia, así que la ventaja de arranque 3 veces mayor de Native AOT es decisiva si tu código es compatible. Si no lo es, R2R es la siguiente mejor palanca de arranque en frío.
- **Ejecutas un número pequeño de instancias de larga vida con uso intensivo de CPU.** El rendimiento máximo domina y el arranque se amortiza hasta cero. El JIT clásico con Dynamic PGO es el ganador; no renuncies a la reoptimización de nivel 1 para ahorrar unos cientos de milisegundos que pagas una sola vez.

## Recomendación, repetida

Para un servicio de ASP.NET Core de larga vida o un worker en .NET 11 donde importa el rendimiento y el arranque se paga una sola vez: **quédate con el JIT clásico.** Es el predeterminado por una razón, y Dynamic PGO lo convierte en el ganador en estado estable. Opcionalmente añade `<PublishReadyToRun>true</PublishReadyToRun>` si la latencia de la primera solicitud tras un despliegue es un problema visible; no cuesta nada en capacidad y converge al mismo pico.

Para cargas sensibles al arranque o limitadas en memoria, especialmente funciones con escalado a cero y contenedores de alta densidad: **usa Native AOT** si y solo si `dotnet publish` reporta cero advertencias de AOT en todo tu árbol de dependencias. Las ventajas de arranque y memoria son grandes y reales. Si no puedes despejar las advertencias, recurre a ReadyToRun, que te da la mayor parte del beneficio de arranque sin nada del riesgo de compatibilidad.

Para un único artefacto que debe correr en varias plataformas: **JIT clásico dependiente del framework**, punto. Es el único modelo que envía una sola compilación para todas partes.

## Relacionado

- [Cómo usar Native AOT con las minimal APIs de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) recorre cómo lograr que una API web compile limpia bajo AOT.
- [Cómo reducir el tiempo de arranque en frío de una AWS Lambda en .NET 11](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) es el escenario canónico de escalado a cero donde esta elección rinde frutos.
- [Fix: PlatformNotSupportedException: Operation is not supported on this platform en Native AOT](/es/2026/05/fix-platformnotsupportedexception-in-native-aot/) cubre el fallo en runtime más común cuando una API incompatible con AOT se cuela.
- [RyuJIT elimina más comprobaciones de límites en .NET 11 Preview 3](/es/2026/04/jit-bounds-check-elimination-index-from-end-dotnet-11-preview-3/) muestra el tipo de optimización que hace el JIT y que AOT congela en la publicación.
- [Rider 2026.1 incorpora un visor de ASM para la salida de JIT, ReadyToRun y NativeAOT](/es/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) te permite comparar el código generado real entre los tres modelos.

## Fuentes

- [Native AOT deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/), MS Learn (limitaciones, soporte de plataformas, `PublishAot`).
- [ReadyToRun deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/ready-to-run), MS Learn (impacto en tamaño, interacción con el JIT, modo composite).
- [Compilation config settings](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation), MS Learn (compilación por niveles, `TieredPGO`).
- [ASP.NET Core support for Native AOT](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot/), MS Learn.
- [Conversation about PGO](https://devblogs.microsoft.com/dotnet/conversation-about-pgo/), .NET Blog (diseño y valores predeterminados de Dynamic PGO).
