---
title: "MAUI en mobile es solo CoreCLR en .NET 11 Preview 6: la salida de emergencia de Mono desapareció"
description: ".NET 11 Preview 6 elimina el camino separado de Mono para MAUI en Android, iOS y Mac Catalyst. CoreCLR es ahora el único runtime móvil, la salida de emergencia UseMonoRuntime se cerró y la GA está prevista para noviembre de 2026."
pubDate: 2026-07-19
tags:
  - "dotnet-11"
  - "maui"
  - "coreclr"
  - "mono"
  - "runtime"
lang: "es"
translationOf: "2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6"
translatedBy: "claude"
translationDate: 2026-07-19
---

Hace dos meses, [MAUI cambió su runtime móvil predeterminado a CoreCLR en .NET 11 Preview 4](/es/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/), y las notas de la versión te dieron una salida de emergencia: al establecer `<UseMonoRuntime>true</UseMonoRuntime>`, tus compilaciones de Android, iOS y Mac Catalyst volvían al runtime anterior. Esa salida se está cerrando. En [CoreCLR Progress and the Mono Timeline for .NET MAUI](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/), David Ortinau confirma que, a partir de .NET 11 Preview 6 (publicado el 2026-07-10), CoreCLR es el único runtime disponible para las aplicaciones móviles de MAUI. Microsoft "ya no expone un camino de Mono separado para Android, iOS o Mac Catalyst".

## De predeterminado a único

La distinción importa. En Preview 4, CoreCLR era el predeterminado y Mono estaba a un cambio de propiedad de distancia, presentado explícitamente como un desbloqueo temporal mientras presentabas una regresión. Preview 6 elimina esa postura de doble runtime en mobile. Ya no hay un target de Mono compatible para las cabeceras móviles de MAUI, y la propiedad de exclusión que solía revertirlas ya no forma parte de la historia. Si tu proyecto o una dependencia transitiva se apoyaba en `UseMonoRuntime` para esquivar una regresión de CoreCLR, ese plan expira ahora, no en la GA.

Blazor WebAssembly no se ve afectado. WebAssembly sigue ejecutándose sobre Mono porque CoreCLR no tiene un target de Wasm, y nada de esto cambia eso.

```xml
<!-- Preview 4: still an option -->
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-android'">
  <UseMonoRuntime>true</UseMonoRuntime>
</PropertyGroup>

<!-- Preview 6: no separate Mono path for MAUI mobile -->
```

## Dónde quedaron los números

La parte honesta del anuncio de Preview 4 fue su reconocimiento de regresiones en aplicaciones de Android más grandes. Preview 6 se lee con más calma. Ortinau informa que iOS y Mac Catalyst son en general más rápidos que sobre Mono, y que Android ahora queda dentro de aproximadamente un 10% de Mono tanto en tiempo de arranque como en tamaño de la aplicación. Eso es lo bastante cerca como para que la unificación del runtime, que comparte el mismo JIT, GC y diagnósticos que ASP.NET Core, deje de ser un intercambio que discutes y empiece a ser una base sobre la que construyes. También mantiene NativeAOT para MAUI sobre la mesa como siguiente paso, algo que nunca fue posible mientras mobile estuvo sobre un runtime separado.

## Qué probar antes de noviembre

La GA es en noviembre de 2026, y la ventana de preview es exactamente cuando las prioridades aún pueden cambiar según tus comentarios. En concreto:

- Compila tu aplicación en Preview 6 y confirma que carga. Las plataformas que CoreCLR descartó antes en el ciclo de .NET 11 (Android x86, API 23 e inferiores, las antiguas APIs de embedding de Xamarin.Android) fallan en tiempo de compilación o de carga, no en silencio en producción.
- Ejecuta una compilación en Release en un dispositivo Android de gama baja representativo y compara arranque en frío, arranque en caliente y tamaño del paquete contra .NET 10. La cifra del 10% es el agregado de Microsoft, no una promesa sobre tu grafo de dependencias.
- Audita cualquier biblioteca de Xamarin.Android sin tocar desde hace tiempo. Si usa las APIs de embedding, no cargará sobre CoreCLR y necesitas tener un reemplazo en cola antes de que el tren de la GA se vaya.

El runtime sobre el que publiques MAUI en noviembre se decide ahora. Preview 6 es el último momento cómodo para averiguar si tu aplicación está de acuerdo. El informe de progreso completo y el calendario están en el [.NET Blog](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/).
