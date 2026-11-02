---
title: "Modos de renderizado Blazor en .NET 11: Server, WebAssembly y Auto"
description: "Elija Blazor Web App o WebAssembly independiente según hosting, uso offline y servicios, con el comportamiento correcto de Auto."
pubDate: 2026-05-26
updatedDate: 2026-11-02
tags:
  - "comparison"
  - "blazor"
  - "dotnet"
  - "csharp"
  - "aspnetcore"
lang: "es"
translationOf: "2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-26
---

**Corrección — 2 de noviembre de 2026:** La versión anterior incluía benchmarks sin verificar y afirmaciones incorrectas sobre Auto, plantillas, funcionamiento sin conexión y límites de renderizado. Se han corregido. Aquí no se presentan mediciones de rendimiento de .NET 11.

Para una nueva aplicación Blazor alojada en un servidor, considere **Blazor Web App**. Ofrece renderizado estático e interactividad Server, WebAssembly o Auto opcional. Si debe desplegarse completamente como archivos estáticos, considere **Blazor WebAssembly independiente**. «Blazor United» fue un nombre inicial del enfoque combinado, no un tercer runtime que se instala.

En esta revisión, Microsoft publica [.NET 11 RC3 como versión preliminar go-live](https://dotnet.microsoft.com/en-us/download/dotnet/11.0). .NET 10 es la versión LTS actual; .NET 11 pertenece a la línea STS. Decida la política de soporte del runtime por separado de la arquitectura de renderizado.

## Elegir dónde se ejecuta el componente

| Opción | Útil para | Coste que considerar |
| --- | --- | --- |
| SSR estático | Contenido y formularios de petición/respuesta con HTML del servidor | Sin eventos C# interactivos |
| Interactive Server | Servicios del servidor y descargas iniciales pequeñas | Latencia, circuitos y recursos del servidor |
| Interactive WebAssembly | UI interactiva ejecutada en el navegador | Descarga del runtime, límites del navegador y API de backend |
| Interactive Auto | Ambos entornos aportan valor | Desarrollar y comprobar dos rutas de ejecución |
| WebAssembly independiente | Hosting estático o una PWA diseñada para funcionar sin conexión | Caché y APIs protegidas por separado |

Auto elige el runtime interactivo al crear la instancia del componente. Puede usar Server inicialmente y WebAssembly en visitas posteriores, una vez almacenado el paquete en caché. **No traslada un componente en ejecución de Server a WebAssembly.** Elegir Auto no neutraliza un reinicio del servidor. Consulte las [reglas de renderizado](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes?view=aspnetcore-11.0).

## Usar las plantillas actuales

Estos comandos se verificaron con los SDK 8.0.427 y 10.0.302. Con .NET 11, consulte `dotnet new blazor --help` para conocer las opciones del SDK instalado; aquí no se ejecutaron con .NET 11.

```bash
dotnet new blazor -o ServerDemo --interactivity Server --no-restore
dotnet new blazor -o AutoDemo --interactivity Auto --no-restore
dotnet new blazorwasm -o OfflineDemo --pwa --no-restore
```

La opción Server usa Blazor Web App sin exigir un proyecto cliente WebAssembly. Prohibir descargas WebAssembly no obliga a usar la antigua plantilla `blazorserver`, ausente en los dos SDK probados. Auto genera un proyecto `.Client`; los componentes ejecutados en WebAssembly deben formar parte de su compilación. La [documentación de herramientas](https://learn.microsoft.com/en-us/aspnet/core/blazor/tooling?view=aspnetcore-11.0) describe las plantillas.

Esta página compiló en la aplicación Server generada con ambos SDK:

```razor
@page "/counter-check"
@rendermode InteractiveServer

<button @onclick="() => count++">@count</button>

@code {
    private int count;
}
```

SSR estático es el valor predeterminado cuando no se asigna ni hereda interactividad. No existe un valor incorporado `@rendermode StaticServer`. Quitar la directiva solo basta si el padre no impone ya un modo interactivo.

## Límites y servicios

Un padre estático puede contener islas interactivas, incluso hermanos con modos distintos. Un hijo interactivo no puede cambiar a un modo interactivo incompatible con el padre. Los parámetros que cruzan del renderizado estático al interactivo deben ser serializables; no se pueden pasar fragmentos arbitrarios.

Los componentes Server pueden llamar a servicios del servidor, pero siguen necesitando autorización y ciclos de vida adecuados. Los componentes del navegador no deben contener credenciales de base de datos ni secretos. La falta de registros de inyección de dependencias suele fallar en ejecución, no necesariamente al compilar. Auto necesita implementaciones apropiadas en ambos entornos. Los componentes interactivos se prerenderizan por defecto; las APIs exclusivas del navegador requieren tratamiento del ciclo de vida incluso con WebAssembly.

## Sin conexión, escalabilidad e Hybrid son decisiones distintas

Un componente WebAssembly dentro de Blazor Web App no convierte automáticamente la aplicación en una aplicación sin conexión. Una PWA independiente necesita service worker, recursos en caché, datos locales y sincronización. La navegación no almacenada y las APIs remotas aún pueden fallar.

La interactividad Server necesita una conexión SignalR funcional. La capacidad depende del estado por circuito y de la carga; no hay un límite universal de 5.000 usuarios. WebAssembly desplaza trabajo de UI al navegador, pero las APIs siguen teniendo capacidad finita. Mida arranque, transferencia, latencia y memoria en su aplicación. Las tablas anteriores de valores fijos carecían de evidencia reproducible.

[Blazor Hybrid](https://learn.microsoft.com/en-us/aspnet/core/blazor/hybrid/?view=aspnetcore-10.0) ejecuta componentes Razor sobre el runtime .NET nativo de una aplicación móvil o de escritorio. No requiere una aplicación WebAssembly independiente. Compartir componentes mediante una biblioteca Razor es otra decisión.

En una aplicación existente, prefiera el cambio arquitectónico más pequeño que resuelva un problema medido. La [guía de migración desde Framework](/es/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/) aborda también la sustitución de `System.Web`.

**Límites de verificación:** Se comprobaron generación de plantillas, compilación Server y componente contador en .NET 8 y 10. No se hizo ninguna compilación .NET 11, benchmark de navegador, prueba offline ni experimento del ciclo de vida Auto.

## Otras fuentes primarias

- [Blazor hosting models](https://learn.microsoft.com/en-us/aspnet/core/blazor/hosting-models?view=aspnetcore-10.0)
- [Blazor PWA](https://learn.microsoft.com/en-us/aspnet/core/blazor/progressive-web-app?tabs=visual-studio)
