---
title: "Empezando con .NET Aspire"
description: "Una guía paso a paso para construir tu primera aplicación .NET Aspire, cubriendo la estructura del proyecto, el descubrimiento de servicios y el dashboard de Aspire."
pubDate: 2023-11-15
tags:
  - "aspire"
  - "dotnet"
lang: "es"
translationOf: "2023/11/getting-started-with-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---
Este artículo te guiará en la construcción de tu primera aplicación .NET Aspire. Si quieres una visión general de .NET Aspire y de lo que aporta, revisa nuestro artículo [What is .NET Aspire](/es/2023/11/what-is-net-aspire/).

## Prerequisites

Hay algunas cosas que necesitas tener listas antes de empezar con .NET Aspire:

-   Visual Studio 2022 Preview (versión 17.9 o superior)
    -   con el workload de .NET Aspire instalado
    -   y .NET 8.0
-   Docker Desktop

Si prefieres no usar Visual Studio, también puedes instalar .NET Aspire usando la CLI de dotnet con el comando `dotnet workload install aspire`. Y luego eres libre de usar el IDE que prefieras.

Para una guía completa sobre cómo instalar todos los requisitos previos de .NET Aspire, revisa [How to install .NET Aspire](/es/2023/11/how-to-install-net-aspire/).

## Create new project

En Visual Studio, ve a **File** > **New** > **Project**, selecciona **.NET Aspire** en el desplegable de tipo de proyecto, o busca la palabra "Aspire". Esto debería mostrar dos plantillas:

-   **.NET Aspire Application** -- una plantilla de proyecto .NET Aspire vacía.
-   **.NET Aspire Starter Application** -- una plantilla más completa que incluye un frontend Blazor, un servicio backend API y, opcionalmente, caché usando Redis.

Elegiremos la plantilla **.NET Aspire Starter Application** para nuestra primera app .NET Aspire.

[![Diálogo de creación de nuevo proyecto de Visual Studio mostrando una lista filtrada de plantillas de proyecto .NET Aspire.](/wp-content/uploads/2023/11/image-9.png)](/wp-content/uploads/2023/11/image-9.png)

Dale un nombre a tu proyecto y, en el diálogo **Additional information**, asegúrate de habilitar la opción **Use Redis for caching**. Esto es totalmente opcional, pero sirve como buen ejemplo de lo que .NET Aspire puede hacer por ti.

[![Diálogo de información adicional para la plantilla de proyecto .NET Aspire Starter Application con la opción opcional Use Redis for caching (requiere Docker).](/wp-content/uploads/2023/11/image-5.png)](/wp-content/uploads/2023/11/image-5.png)

### Using dotnet CLI

También puedes crear apps .NET Aspire usando la CLI de dotnet. Para crear una app usando la plantilla .NET Aspire Starter Application, usa el siguiente comando, reemplazando `Foo` con el nombre de solución que desees.

```bash
dotnet new aspire-starter --use-redis-cache --output Foo
```

## Project structure

Con la solución .NET Aspire creada, veamos su estructura. Deberías tener 4 proyectos en tu solución:

-   **ApiService**: un proyecto de API ASP.NET Core que el frontend usa para obtener datos.
-   **AppHost**: actúa como orquestador conectando y configurando los diferentes proyectos y servicios de tu aplicación .NET Aspire.
-   **ServiceDefaults**: un proyecto compartido usado para gestionar configuraciones relacionadas con resiliencia, descubrimiento de servicios y telemetría.
-   **Web**: una aplicación Blazor que actúa como nuestro frontend.

Las dependencias entre los proyectos se ven así:

[![Un grafo de dependencias de proyecto para una .NET Aspire Starter Application mostrando AppHost en la parte superior, dependiente de ApiService y Web, ambos dependientes de ServiceDefaults.](/wp-content/uploads/2023/11/image-6.png)](/wp-content/uploads/2023/11/image-6.png)

Empecemos por arriba.

## AppHost project

Este es nuestro proyecto orquestador de la solución .NET Aspire. Su rol es conectar y configurar los diferentes proyectos y servicios de nuestra aplicación .NET Aspire.

Veamos su archivo `.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <IsAspireHost>true</IsAspireHost>
  </PropertyGroup>

  <ItemGroup>
    <ProjectReference Include="..\Foo.ApiService\Foo.ApiService.csproj" />
    <ProjectReference Include="..\Foo.Web\Foo.Web.csproj" />
  </ItemGroup>

  <ItemGroup>
    <PackageReference Include="Aspire.Hosting" Version="8.0.0-preview.1.23557.2" />
  </ItemGroup>

</Project>
```

Dos cosas destacarán:

-   el elemento `IsAspireHost` que marca explícitamente este proyecto como el orquestador de nuestra solución
-   la referencia al paquete `Aspire.Hosting`. Este paquete contiene la API y abstracciones principales para el modelo de aplicación .NET Aspire. Como el framework todavía está en preview, los paquetes NuGet de .NET Aspire también están marcados como versiones preliminares.

Veamos a continuación `Program.cs`. Notarás un patrón builder muy familiar usado para enlazar los diferentes proyectos y habilitar el caché.

```cs
var builder = DistributedApplication.CreateBuilder(args);

var cache = builder.AddRedisContainer("cache");

var apiservice = builder.AddProject<Projects.Foo_ApiService>("apiservice");

builder.AddProject<Projects.Foo_Web>("webfrontend")
    .WithReference(cache)
    .WithReference(apiservice);

builder.Build().Run();
```

Lo que el código de arriba esencialmente hace es lo siguiente:

-   crea una instancia de `IDistributedApplicationBuilder` usada para construir nuestra `DistributedApplication`
-   crea un `RedisContainerResource` que podemos referenciar luego en nuestros proyectos y servicios
-   añade nuestro proyecto `ApiService` a la aplicación y mantiene una instancia del `ProjectResource`
-   añade nuestro proyecto `Web` a la aplicación, referenciando el caché Redis y el `ApiService`
-   antes de finalmente llamar a `Build()` para construir nuestra instancia de `DistributedApplication`, y `Run()` para ejecutarla.

## ApiService project

El proyecto `ApiService` expone un endpoint `/weatherforecast` que podemos consumir desde nuestro proyecto `Web`. Para hacer la API disponible para consumo, la registramos en nuestro proyecto `AppHost` y le dimos el nombre `apiservice`.

```cs
builder.AddProject<Projects.Foo_ApiService>("apiservice")
```

## Web project

El proyecto `Web` representa nuestro frontend Blazor y consume el endpoint `/weatherforecast` expuesto por nuestro `ApiService`. La forma en que lo hace es donde la magia de .NET Aspire empieza a verse de verdad.

Notarás que usa un `HttpClient` tipado:

```cs
public class WeatherApiClient(HttpClient httpClient)
{
    public async Task<WeatherForecast[]> GetWeatherAsync()
    {
        return await httpClient.GetFromJsonAsync<WeatherForecast[]>("/weatherforecast") ?? [];
    }
}
```

Ahora, si miras dentro de `Program.cs` notarás algo interesante en la línea 14:

```cs
builder.Services.AddHttpClient<WeatherApiClient>(client =>
    client.BaseAddress = new("http://apiservice"));
```

¿Recuerdas cómo le dimos a nuestro proyecto `ApiService` el nombre `apiservice` cuando lo añadimos como `ProjectResource` en nuestra `DistributedApplication`? Ahora esta línea configura el `WeatherApiClient` tipado para usar descubrimiento de servicios y conectarse a un servicio llamado `apiservice`. `http://apiservice` se resolverá automáticamente a la dirección correcta de nuestro recurso `ApiService` sin ninguna configuración adicional requerida de tu parte.

## ServiceDefaults project

Similar al proyecto `AppHost`, el proyecto compartido también se diferencia mediante una propiedad de proyecto especial:

```xml
<IsAspireSharedProject>true</IsAspireSharedProject>
```

El proyecto asegura que todos los diferentes proyectos y servicios estén configurados de la misma manera en lo relativo a resiliencia, descubrimiento de servicios y telemetría. Lo hace exponiendo un conjunto de métodos de extensión que pueden ser llamados por los proyectos y servicios de la solución sobre sus propias instancias de `IHostApplicationBuilder`.

## Run the project

Para ejecutar el proyecto, asegúrate de tener `AppHost` configurado como tu proyecto de inicio y pulsa run (F5) en Visual Studio. Alternativamente, puedes ejecutar el proyecto desde la línea de comandos, usando `dotnet run --project Foo/Foo.AppHost`, reemplazando `Foo` con el nombre de tu proyecto.

Después de que la aplicación arranque, se te presentará el dashboard de .NET Aspire.

[![El dashboard de .NET Aspire ejecutando la plantilla de proyecto .NET Aspire Starter Application.](/wp-content/uploads/2023/11/image-7-1024x414.png)](/wp-content/uploads/2023/11/image-7.png)

El dashboard te permite monitorear las distintas partes de tu aplicación .NET Aspire: tus proyectos, contenedores y ejecutables. También proporciona registros agregados y estructurados para tus servicios, trazas de solicitudes y otras métricas útiles.

[![Una traza de solicitud dentro del dashboard de .NET Aspire mostrando la solicitud en etapas a medida que pasa por los diferentes componentes de la aplicación.](/wp-content/uploads/2023/11/image-8.png)](/wp-content/uploads/2023/11/image-8.png)

Y eso es todo! Felicidades por construir y ejecutar tu primera aplicación .NET Aspire!
