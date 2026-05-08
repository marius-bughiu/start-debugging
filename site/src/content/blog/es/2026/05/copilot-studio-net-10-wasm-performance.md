---
title: "La actualización a .NET 10 WebAssembly de Copilot Studio: 20% en frío, 5% en caliente"
description: "Microsoft pasó el motor WASM de Copilot Studio de .NET 8 a .NET 10. El paquete dual JIT/AOT, el fingerprinting y WasmStripILAfterAOT explican los números."
pubDate: 2026-05-08
tags:
  - "dotnet"
  - "webassembly"
  - "performance"
  - "blazor"
lang: "es"
translationOf: "2026/05/copilot-studio-net-10-wasm-performance"
translatedBy: "claude"
translationDate: 2026-05-08
---

El 7 de mayo de 2026, Daniel Roth publicó un [estudio de caso sobre Copilot Studio](https://devblogs.microsoft.com/dotnet/copilot-studio-dotnet-10-migration/) en el blog de .NET. El titular: el runtime WebAssembly de Copilot Studio, que se distribuye como paquete NPM y está incrustado en muchas superficies de Microsoft 365, ahora corre sobre .NET 10 en producción. La ejecución en ruta fría es alrededor de un 20% más rápida, en ruta caliente alrededor de un 5%, y la migración en sí fue básicamente subir el `<TargetFramework>`.

Lo interesante es cómo Copilot Studio empaqueta dos motores en un mismo bundle, y qué cambió en las herramientas de WebAssembly de .NET 10 para que el nuevo build sea más pequeño donde importa y un poco más grande donde no.

## Dos motores, un paquete

Copilot Studio no elige entre JIT o AOT. Envía ambos en el mismo paquete NPM y deja que la página los cargue en paralelo.

El motor JIT arranca primero y empieza a atender las interacciones del usuario de inmediato. El motor AOT, que es más grande y más lento de descargar, termina de cargar en segundo plano. En cuanto está listo, el runtime entrega la sesión activa al AOT y descarta el motor JIT. El usuario ve una primera respuesta rápida y luego una experiencia silenciosamente más rápida durante el resto de la conversación.

Esa carga dual es la razón por la que a Copilot Studio le importa tanto compartir assets entre ambos motores. Cualquier cosa que ambos puedan referenciar no debería descargarse dos veces.

## Qué cambió realmente .NET 10

Dos cambios en el workload de WebAssembly de .NET 10 explican la mayor parte de la diferencia.

Primero, **fingerprinting automático de assets**. En .NET 8, el equipo tenía que ejecutar un paso de PowerShell personalizado para añadir un hash SHA256 a cada nombre de archivo WASM y DLL, para que la caché y las verificaciones de integridad se comportaran bien. En .NET 10 esto está incluido de fábrica, y la salida de publicación ya genera nombres como `dotnet.runtime.{hash}.js` sin pegamento MSBuild personalizado.

Segundo, **`WasmStripILAfterAOT` está activado por defecto**. Después de la compilación AOT, el IL original de los métodos compilados ya no se envía. Eso recorta el payload AOT, pero también reduce la cantidad de archivos que pueden compartir los motores JIT y AOT, porque los archivos exclusivos de AOT ya no llevan el IL que el motor JIT necesitaría.

```xml
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <RunAOTCompilation>true</RunAOTCompilation>
  <!-- Defaults to true on net10.0; shown here for clarity. -->
  <WasmStripILAfterAOT>true</WasmStripILAfterAOT>
</PropertyGroup>
```

En .NET 8 había 59 archivos compartidos entre los motores JIT y AOT de Copilot Studio. En .NET 10 ese número bajó a 22. El paquete completo creció alrededor de un 15%. Ese es el costo de quitar el IL de los métodos AOT: el modelo dual pierde parte de sus ahorros por deduplicación.

## Leer los números con honestidad

Microsoft es claro respecto al compromiso. Las descargas AOT son alrededor de un 6% más lentas en una LAN rápida, lo que se traduce en unos 200 ms, y alrededor de un 17% más lentas en un enlace 4G, unos 5 segundos. Esa penalización se paga en segundo plano mientras el JIT ya está atendiendo al usuario, así que no aparece en el time-to-interactive. Sí aparece si un usuario se desconecta a mitad de carga o ejecuta Copilot Studio en una red restringida.

A cambio:

- Ruta fría de ejecución: ~20% más rápida.
- Ruta caliente de ejecución: ~5% más rápida.
- Sin cambios de código más allá del salto de framework.

Para una carga de trabajo que corre dentro de las superficies de Microsoft 365 y recibe golpes constantemente, una mejora del 20% en la ruta fría en cada interacción importa más que cinco segundos de descarga en segundo plano.

## Qué significa esto para tu app Blazor WebAssembly

Si distribuyes una aplicación Blazor WebAssembly o .NET WASM y todavía estás en .NET 8, la migración es barata. Sube `TargetFramework` a `net10.0`, restaura, publica y deja que el nuevo fingerprinting y los valores por defecto de AOT se ejecuten. Si tienes un paso personalizado de hashing o de stripping de IL en tu pipeline, bórralo.

Si no envías motores JIT y AOT duales (la mayoría de las apps no), no verás el crecimiento del 15% del paquete que vio Copilot Studio. Vas a obtener el ahorro por strip de IL sin la pérdida por deduplicación. Esa es la configuración para la que están afinados los valores por defecto de .NET 10.

El estudio de caso completo, incluyendo los detalles de despliegue y cómo Copilot Studio mide estos números en producción, está en el [blog de .NET](https://devblogs.microsoft.com/dotnet/copilot-studio-dotnet-10-migration/).
