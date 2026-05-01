---
title: "¿Qué es .NET Aspire?"
description: "Una visión general de .NET Aspire, el framework orientado a la nube para construir aplicaciones distribuidas escalables, abarcando orquestación, componentes y herramientas."
pubDate: 2023-11-14
updatedDate: 2023-11-16
tags:
  - "aspire"
  - "dotnet"
lang: "es"
translationOf: "2023/11/what-is-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET Aspire es un framework integral, orientado a la nube, diseñado para crear aplicaciones distribuidas escalables, observables y de nivel de producción. Se introdujo como preview como parte de la versión .NET 8.

El framework se entrega a través de un conjunto de paquetes NuGet, cada uno abordando diferentes aspectos del desarrollo de aplicaciones cloud-native, que normalmente se estructuran como una red de microservicios en lugar de una única base de código grande, y dependen en gran medida de una variedad de servicios como bases de datos, sistemas de mensajería y soluciones de caché.

## Orchestration

La orquestación en el contexto de aplicaciones cloud-native implica la sincronización y administración de varios componentes. .NET Aspire mejora este proceso simplificando la configuración e integración de los distintos segmentos de una aplicación cloud-native. Ofrece abstracciones de alto nivel para manejar de manera efectiva aspectos como descubrimiento de servicios, variables de entorno y configuraciones de contenedores, eliminando así la necesidad de código intrincado de bajo nivel. Estas abstracciones aseguran procedimientos de configuración uniformes en aplicaciones compuestas por múltiples componentes y servicios.

Con .NET Aspire, la orquestación aborda áreas clave como:

-   **Composición de la aplicación:** esto implica definir los proyectos .NET, contenedores, archivos ejecutables y recursos basados en la nube que constituyen la aplicación.
-   **Descubrimiento de servicios y gestión de cadenas de conexión:** el host de la aplicación es responsable de incorporar de manera fluida cadenas de conexión precisas y detalles de descubrimiento de servicios, mejorando así el proceso de desarrollo.

Por ejemplo, .NET Aspire permite la creación de un recurso local de contenedor Redis y la configuración de la cadena de conexión correspondiente en un proyecto "frontend" con muy poco código, utilizando solo un par de métodos auxiliares.

```cs
// Create a distributed application builder given the command line arguments.
var builder = DistributedApplication.CreateBuilder(args);

// Add a Redis container to the application.
var cache = builder.AddRedisContainer("cache");

// Add the frontend project to the application and configure it to use the 
// Redis container, defined as a referenced dependency.
builder.AddProject<Projects.MyFrontend>("frontend")
       .WithReference(cache);
```

## Components

Los componentes de .NET Aspire, disponibles como paquetes NuGet, están diseñados para optimizar la integración con servicios y plataformas ampliamente usados como Redis y PostgreSQL. Estos componentes abordan varios aspectos del desarrollo de aplicaciones cloud-native ofreciendo configuraciones uniformes, incluyendo la implementación de health checks y características de telemetría.

Cada uno de estos componentes está diseñado para integrarse de forma fluida con el framework de orquestación de .NET Aspire. Tienen la capacidad de propagar automáticamente sus configuraciones a través de las dependencias, basándose en las relaciones definidas en las referencias de proyecto y paquete .NET. Esto significa que si un componente, digamos Example.ServiceFoo, depende de otro, Example.ServiceBar, entonces Example.ServiceFoo adopta automáticamente las configuraciones necesarias de Example.ServiceBar para facilitar su intercomunicación.

Para ilustrar, consideremos el uso del componente Service Bus de .NET Aspire en un escenario de programación.

```cs
builder.AddAzureServiceBus("servicebus");
```

El método `AddAzureServiceBus` en .NET Aspire aborda varias funciones clave:

1.  Establece un `ServiceBusClient` como singleton dentro del contenedor de inyección de dependencias (DI), permitiendo la conexión a Azure Service Bus.
2.  Este método permite la configuración de `ServiceBusClient`, que puede hacerse directamente en el código o mediante ajustes de configuración externos.
3.  Adicionalmente, activa health checks, registro y características de telemetría relevantes específicamente diseñados para Azure Service Bus, asegurando una monitorización y mantenimiento eficientes.

## Tooling

Las aplicaciones desarrolladas con .NET Aspire siguen una estructura uniforme, establecida por las plantillas de proyecto predeterminadas de .NET Aspire. Típicamente, una aplicación .NET Aspire se compone de al menos tres proyectos distintos:

1.  **Foo**: esta es la aplicación inicial, que puede ser un proyecto .NET estándar como Blazor UI o Minimal API. A medida que la aplicación crece, se pueden añadir más proyectos, y su orquestación se gestiona mediante los proyectos Foo.AppHost y Foo.ServiceDefaults.
2.  **Foo.AppHost**: el proyecto AppHost supervisa la orquestación de alto nivel de la aplicación. Esto incluye ensamblar diferentes componentes como APIs, contenedores de servicios y ejecutables, y configurar su interconectividad y comunicación.
3.  **Foo.ServiceDefaults**: este proyecto aloja los ajustes de configuración por defecto para una aplicación .NET Aspire. Estos ajustes, que incluyen aspectos como health checks y configuraciones de OpenTelemetry, pueden personalizarse y ampliarse según sea necesario.

Para ayudar a empezar con esta estructura, se ofrecen dos plantillas iniciales principales de .NET Aspire:

-   **.NET Aspire Application**: una plantilla inicial fundamental, incluye solo los proyectos Foo.AppHost y Foo.ServiceDefaults, proporcionando el marco básico sobre el que construir.
-   **.NET Aspire Starter Application**: una plantilla más completa, no solo contiene los proyectos Foo.AppHost y Foo.ServiceDefaults sino que también viene con proyectos UI y API preconfigurados. Estos proyectos adicionales están preconfigurados con descubrimiento de servicios y otras funcionalidades estándar de .NET Aspire.

### Read next:

-   [How to install .NET Aspire](/es/2023/11/how-to-install-net-aspire/)
-   [Build your first .NET Aspire application](/es/2023/11/getting-started-with-net-aspire/)
