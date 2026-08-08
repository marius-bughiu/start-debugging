---
title: "Aspire vs Docker Compose para desarrollo local con varios servicios"
description: "Aspire 13.4.6 gana el ciclo interno de .NET porque ejecuta tus proyectos como procesos del host que puedes depurar, mientras que Docker Compose gana cuando el archivo compose es también tu contrato de CI e implementación. Mediciones de arranque y de edición a ejecución en ambos, la configuración que cada uno inyecta por ti y los seis detalles que deciden."
pubDate: 2026-08-08
template: vs
tags:
  - "comparison"
  - "aspire"
  - "docker"
  - "dotnet"
  - "devops"
lang: "es"
translationOf: "2026/08/aspire-vs-docker-compose-for-local-multi-service-development"
translatedBy: "claude"
translationDate: 2026-08-08
---

Elige Aspire si los servicios que ejecutas localmente son proyectos .NET que compilas desde el código fuente: los ejecuta como procesos ordinarios del host, así que un depurador se conecta a todos a la vez, e inyecta cadenas de conexión y configuración de OpenTelemetry que de otro modo escribirías a mano. Elige Docker Compose si tu `docker-compose.yaml` es también tu contrato de CI, staging o producción, o si la mayor parte de tu stack son imágenes prediseñadas que no escribes tú. No estás obligado a elegir: `aspire publish` genera un archivo Compose a partir del mismo modelo. Todos los números y APIs de abajo provienen de Aspire 13.4.6 (la versión estable actual, publicada el 2026-06-20) y Docker Compose v5.1.4 sobre .NET 10.

Nota sobre el nombre: el producto eliminó el prefijo ".NET" con Aspire 13 en noviembre de 2025, así que ".NET Aspire" y "Aspire" son lo mismo, y el paso `dotnet workload install aspire` desapareció desde Aspire 9.0.

## La matriz

| | Aspire 13.4.6 | Docker Compose v5.1.4 |
| --- | --- | --- |
| Formato de configuración | C# o TypeScript | YAML |
| Cómo se ejecuta tu propio servicio .NET | proceso del host, lanzado por DCP | contenedor compilado desde un Dockerfile |
| Conexión del depurador | F5 sobre todos los proyectos a la vez | depurador remoto, configurado por servicio |
| Cadenas de conexión | inyectadas como `ConnectionStrings__<name>` | las escribes tú |
| URLs entre servicios | inyectadas como `services__<name>__<scheme>__0` | DNS del contenedor por nombre de servicio |
| Telemetría | endpoint OTLP más dashboard, sin configuración | ninguna |
| Orden de arranque | `WaitFor()` más health checks | `depends_on` con `condition: service_healthy` |
| Redes personalizadas | sin equivalente | `networks:` |
| Límites de CPU y memoria | no modelados | `deploy.resources` |
| Nombres de contenedor | sufijo aleatorio (`cache-mmsmckhq`) | deterministas (`<project>-cache-1`) |
| ¿Es tu artefacto de implementación? | no, el AppHost es solo de tiempo de desarrollo | con frecuencia sí |
| Servicios que no son .NET | Node, Bun, Python, Go o cualquier contenedor | cualquier contenedor |

## Qué arranca realmente cada uno

Esta es la diferencia de la que se deriva todo lo demás. Compose arranca contenedores, y punto. Cada servicio del archivo, incluido el que estás editando, es una imagen que hay que compilar antes de poder ejecutarla.

El AppHost de Aspire arranca una mezcla. Todo lo que declaraste con `AddProject<T>` se ejecuta como un proceso normal en tu máquina bajo el Developer Control Plane; solo las cosas que no escribiste tú, declaradas con `AddContainer`, `AddRedis`, `AddPostgres` y compañía, se convierten en contenedores. Puedes verlo en `docker ps` mientras la aplicación se ejecuta:

```
NAMES              IMAGE
cache-mmsmckhq     redis:8.6
```

Esa es la lista completa de contenedores para una aplicación de dos servicios. La API es un proceso `dotnet`, y por eso Visual Studio y Rider pueden poner un punto de interrupción en ella sin ninguna configuración de depuración remota, y por eso una recompilación no involucra a Docker en absoluto.

## El mismo stack, escrito dos veces

Una minimal API más Redis. Primero la versión de Compose:

```yaml
# docker-compose.yaml -- Docker Compose v5.1.4
services:
  cache:
    image: redis:8.2
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 2s
      retries: 15

  api:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - ConnectionStrings__cache=cache:6379
    ports:
      - "8080:8080"
    depends_on:
      cache:
        condition: service_healthy
```

Más un Dockerfile, que no es opcional y que no se muestra aquí. Ahora la versión de Aspire, el archivo completo:

```csharp
// AppHost/AppHost.cs -- Aspire 13.4.6, .NET 10
var builder = DistributedApplication.CreateBuilder(args);

var cache = builder.AddRedis("cache");

builder.AddProject<Projects.Api>("api")
       .WithHttpEndpoint(port: 8080, name: "public")
       .WithReference(cache)
       .WaitFor(cache);

builder.Build().Run();
```

El archivo de proyecto tiene tres líneas de contenido interesante, y observa que la plantilla de 13.4.6 ahora coloca el SDK en el atributo `Sdk` en lugar de un elemento `<Sdk>` anidado:

```xml
<!-- AppHost/AppHost.csproj -- Aspire 13.4.6 -->
<Project Sdk="Aspire.AppHost.Sdk/13.4.6">
  <ItemGroup>
    <ProjectReference Include="..\Api\Api.csproj" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Aspire.Hosting.Redis" Version="13.4.6" />
  </ItemGroup>
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
```

Ambos stacks ejecutan el mismo `Program.cs`, que lee `ConnectionStrings:cache` desde la configuración. Con Compose ese valor lo proporcionaste tú. Con Aspire no.

## Qué escribe Aspire dentro de tu proceso

Añadí un endpoint de depuración que vuelca las variables de entorno interesantes y luego ejecuté el AppHost. Esto es lo que recibió el proceso de la API sin una sola línea de configuración de mi parte:

```
ASPNETCORE_URLS=https://localhost:61681;http://localhost:61682;http://localhost:61683
ConnectionStrings__cache=localhost:58390,password=T9bjFegjra6EBk5HG3M9uq
OTEL_EXPORTER_OTLP_ENDPOINT=https://localhost:21089
OTEL_EXPORTER_OTLP_HEADERS=x-otlp-api-key=566b726e1f4c36c1b4e0474e80db9cd5
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_METRIC_EXPORT_INTERVAL=1000
OTEL_SERVICE_NAME=api
OTEL_TRACES_SAMPLER=always_on
```

Dos cosas dignas de atención. Aspire generó una contraseña para Redis y la puso en la cadena de conexión, así que la caché local no queda abierta en un puerto conocido y sin autenticación, como sí ocurre con `redis:8.2` en un archivo Compose. Y el bloque OTLP es lo que hace que las trazas y las métricas aparezcan gratis en el dashboard; si quieres lo mismo con Compose vas a levantar un colector y cablear exportadores por tu cuenta, lo cual da para un artículo entero sobre [cómo usar OpenTelemetry con .NET 11 y un backend gratuito](/es/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/).

Para referencias entre proyectos, la variable inyectada es `services__<name>__<scheme>__0`, por ejemplo `services__basket__https__0`, y el descubrimiento de servicios de .NET resuelve `https://basket` contra ella.

## Las mediciones

Misma máquina, misma aplicación, mismo Redis: un Intel Core Ultra 7 265KF (20 núcleos), 32 GB de RAM, Windows 11 Pro 26200, Docker 29.5.3 con Compose v5.1.4, .NET SDK 10.0.201, Aspire CLI 13.4.6. Las imágenes base se descargaron antes de medir, así que ninguna medición incluye una descarga del registro. El tiempo es de reloj, desde que arranca el comando hasta que un GET HTTP sobre la aplicación devuelve el código recién compilado, con sondeo cada 250 ms. La edición es un cambio de una línea en un literal de cadena de `Program.cs`, y cada ronda usa un valor nuevo para que nada pueda servirse desde una caché.

| Escenario | Aspire 13.4.6 | Docker Compose v5.1.4 |
| --- | --- | --- |
| Arranque en frío: nada compilado, stack levantado y sirviendo | 15,5 s (`dotnet clean`, luego `aspire run`) | 10,8 s (7,0 s de `build --no-cache` más 3,8 s de `up`) |
| Cambio de una línea en C# hasta servir el código nuevo | 14,6 / 13,9 / 11,0 s, mediana 13,9 s | 5,4 / 5,6 / 5,3 s, mediana 5,4 s |

Docker Compose ganó en todas las filas, y no lo voy a maquillar. Conviene entender por qué antes de sacar una conclusión de ahí.

El ciclo de Compose aquí es una compilación incremental de `docker build` de tres segundos (la capa de restore está en caché, solo se rehacen `COPY` y `dotnet publish`) más la recreación del contenedor, sobre una aplicación cuya salida publicada son unos diez kilobytes de código mío. El ciclo de Aspire es `aspire resource api stop`, una invocación completa de MSBuild y `aspire resource api start`, y el propio coste de arranque de MSBuild domina en un proyecto tan pequeño. El número de Compose crece con el tamaño de la capa de imagen que recompilas; el de Aspire crece con el grafo de MSBuild. No medí dónde se cruzan esas curvas, así que no voy a afirmar un punto de cruce.

La advertencia más importante es que la fila de Aspire está medida con la CLI, y la CLI no es como la mayoría usa Aspire. En Visual Studio o Rider el ciclo es F5 más Hot Reload, que parchea el proceso en ejecución y nunca recompila. No hay equivalente para un servicio en contenedor: `docker compose watch` sincroniza archivos o recompila la imagen, no parchea un proceso en ejecución. Así que toma la tabla como una cota superior del ciclo interno de Aspire y como una medida justa del de Compose.

## Cuándo Docker Compose es la respuesta correcta

- **El archivo compose es un entregable.** Si CI levanta ese mismo YAML, si una máquina de QA lo ejecuta, si tu runbook de guardia dice `docker compose up`, entonces Compose no es solo una herramienta de desarrollo y reemplazarlo por un AppHost significa mantener dos descripciones del mismo sistema.
- **Mayormente no compilas los servicios.** Un stack de Kafka, MinIO, Keycloak y un Postgres con tres scripts de inicialización es un stack de imágenes. Aspire también modela eso como contenedores, pero estás pagando una abstracción en C# sobre cosas que ya estaban bien como YAML.
- **Necesitas redes o límites de recursos.** Aspire no tiene equivalente para el aislamiento de redes personalizadas; cada recurso es alcanzable por nombre. Si estás probando qué pasa cuando el servicio A realmente no puede alcanzar al servicio B, o necesitas `deploy.resources` para limitar un contenedor a una CPU, Compose lo hace y Aspire no.
- **Tu equipo no es .NET primero.** Aspire 13.4 hizo generalmente disponibles los AppHost en TypeScript y añadió `AddGoApp` y `AddBunApp`, así que esto es menos cierto que hace un año, pero la documentación, los ejemplos y el catálogo de integraciones siguen centrados en .NET.

## Cuándo Aspire es la respuesta correcta

- **Depuras más de un servicio a la vez.** Esta es la razón de más peso. Puntos de interrupción en la API y en el worker con un solo F5, sin `docker-compose.debug.yml`, sin `vsdbg` en la imagen, sin malabares de puertos.
- **Tu stack de desarrollo tiene servicios de apoyo con configuración delicada.** `AddPostgres("db").AddDatabase("orders")` te da un contenedor, una contraseña generada, una cadena de conexión en el formato .NET correcto y un arranque condicionado por health checks. El equivalente en Compose son quince líneas y un archivo `.env`.
- **Quieres telemetría en el ciclo interno.** El dashboard muestra trazas entre servicios, logs estructurados y métricas desde el momento en que pulsas ejecutar. Encontrar un N+1 o una tormenta de reintentos en tu propia máquina, en lugar de en staging, cambia cómo escribes el código. Si has estado [detectando consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) desde archivos de log, esto es una mejora real.
- **Ya lo estás añadiendo de forma incremental.** Aspire entra en una solución heredada como dos proyectos nuevos, que es el tema de [cómo añadir Aspire a una solución ASP.NET Core existente](/es/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/).

## Los detalles que deciden por ti

**La sintaxis de puertos de Compose no se traduce literalmente.** `ports: ["8080:8080"]` parece `WithHttpEndpoint(port: 8080, targetPort: 8080)`, y esa combinación lanza una excepción al arrancar:

```
System.InvalidOperationException: The endpoint 'public' for resource 'api'
requested a proxy (IsProxied is true). Non-container resources cannot be
proxied when both TargetPort and Port are specified with the same value.
```

Aspire hace de proxy para los endpoints de proyecto, así que el puerto del host y el puerto de destino no pueden tener el mismo valor. Especifica solo `port:` y deja que elija el destino.

**`WithReference` no es `depends_on`.** La guía de migración es explícita: `WithReference()` solo configura el descubrimiento de servicios y las cadenas de conexión, y no controla el orden de arranque. Si quieres el comportamiento de `condition: service_healthy` de Compose, lo que quieres es `WaitFor()`, y lo quieres además de `WithReference()`, no en su lugar.

**Los nombres de contenedor no son estables.** Compose te da `bench-cache-1`, derivado del nombre del proyecto y del servicio. Aspire me dio `cache-vvkhtnuf`, luego `cache-zwjpvzxh`, luego `cache-mmsmckhq` en tres ejecuciones. Cualquier script o costumbre de un compañero construida sobre `docker exec -it myapp-cache-1 redis-cli` se rompe.

**Las versiones de imagen por defecto se mueven con la versión de Aspire.** `AddRedis` en 13.4.6 descargó `redis:8.6`, no el `redis:8.2` que mi archivo Compose fijaba. Aspire 13.4 también movió el valor por defecto de Postgres de 17.6 a 18.3, que no es compatible con un volumen de datos existente. Fija la versión con `WithImageTag` si te importa.

**Un contexto de compilación de Compose necesita un `.dockerignore`.** Sin él, `COPY Api/ Api/` mete tus `bin/` y `obj/` del host en el contexto de compilación, lo que infla cada compilación e invalida capas ante cambios que no tocaron el código fuente. Dos líneas lo arreglan, y la diferencia se ve en el log de compilación, donde la transferencia de contexto para este proyecto baja a 1,18 kB:

```
# .dockerignore
**/bin
**/obj
```

Aspire no tiene un problema equivalente porque nunca compila una imagen para tu proyecto. Tiene el problema espejo: MSBuild no puede sobrescribir `Api.dll` mientras el recurso está en ejecución, así que una recompilación desde línea de comandos necesita `aspire resource api stop` antes de `dotnet build`. El IDE se encarga de eso por ti; un script de shell no.

**El proxy de Aspire puede sobrevivir a `aspire stop`, y hará sombra a tus contenedores.** Este me costó una hora mientras recogía los números de arriba. Después de `aspire stop --force`, un proceso `dcp` seguía enlazado al puerto fijo del host:

```
PID=70448 Name=dcp Addr=127.0.0.1
PID=70448 Name=dcp Addr=::1
```

Docker entonces enlazó el mismo puerto en `::`, ambos comandos reportaron éxito, y cada petición a `localhost:8080` la respondía el proxy de Aspire abandonado en lugar del contenedor. Nada da error. `docker compose ps` muestra el contenedor sano y mapeado, la imagen contiene realmente tu código nuevo, y la aplicación sigue devolviendo las respuestas de la compilación anterior, porque no estás hablando con el contenedor en absoluto. Estuve un rato culpando a la caché de capas de Docker antes de comprobar quién era realmente el dueño del puerto:

```bash
Get-NetTCPConnection -LocalPort 8080 -State Listen
```

Esto solo muerde cuando fijas un puerto del host con `WithHttpEndpoint(port: ...)`, que es exactamente lo que haces al traducir un archivo Compose. Los puertos dinámicos por defecto de Aspire no colisionan.

## Usar ambos

La elección no es permanente, porque el modelo del AppHost puede generar el archivo Compose:

```csharp
// AppHost/AppHost.cs -- Aspire 13.4.6
builder.AddDockerComposeEnvironment("compose")
       .WithDashboard(d => d.WithHostPort(8080));
```

```bash
aspire publish
```

Eso emite un `docker-compose.yaml` más un `.env` con los parámetros sin rellenar, y cada recurso del modelo se convierte en un servicio de Compose sin más opt-in. `PublishAsDockerComposeService` personaliza un servicio individual (nombre de contenedor, etiquetas, política de reinicio) y `ConfigureComposeFile` edita el documento completo antes de escribirlo. Así que un estado final razonable es: Aspire para el ciclo interno, Compose generado para los entornos que necesitan un archivo YAML, una sola fuente de verdad. Ten en cuenta que el AppHost nunca se envía, del mismo modo que [publicar una imagen de contenedor con `dotnet publish /t:PublishContainer`](/es/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) es un asunto aparte de cómo ejecutaste la cosa localmente.

## La decisión

Para una solución .NET donde tú compilas los servicios, Aspire es el mejor entorno de desarrollo local, y la razón enfáticamente no es la velocidad: Compose le ganó en todas las mediciones que tomé. Es que tu código se ejecuta como un proceso que puedes depurar, y que el AppHost escribe las cadenas de conexión, los puertos y la configuración de OpenTelemetry que de otro modo mantendrías a mano en YAML y se desincronizarían. Los segundos de arranque son baratos frente a una tarde averiguando por qué el contenedor tiene una compilación obsoleta o por qué el depurador no se conecta.

Quédate en Docker Compose cuando el archivo tenga un segundo trabajo. Si CI, staging o un runbook dependen de ese YAML, la comparación honesta no es "Aspire vs Compose" sino "Aspire más Compose generado vs Compose solo", y si tu equipo es pequeño y el stack son cinco imágenes que no escribiste tú, la segunda opción sigue siendo una respuesta perfectamente buena en 2026.

## Relacionado

- [Cómo añadir Aspire a una solución ASP.NET Core existente sin reestructurarla](/es/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/)
- [¿Qué es .NET Aspire?](/es/2023/11/what-is-net-aspire/)
- [Cómo usar OpenTelemetry con .NET 11 y un backend gratuito](/es/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)
- [WebApplicationFactory vs Testcontainers para pruebas de integración en ASP.NET Core](/es/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/)
- [Cómo publicar una aplicación .NET 11 como imagen de contenedor con dotnet publish /t:PublishContainer](/es/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)

## Fuentes

- [Migrate from Docker Compose to Aspire](https://aspire.dev/app-host/migrate-from-docker-compose/), el mapeo oficial concepto por concepto
- [Deploy Aspire apps with Docker Compose to any host](https://aspire.dev/deployment/docker-compose/)
- [Aspire Docker integration for containerized resources](https://aspire.dev/integrations/compute/docker/)
- [What's new in Aspire 13.4](https://aspire.dev/whats-new/aspire-13-4/), incluidos los cambios de imagen por defecto de Postgres y RabbitMQ
- [Aspire service discovery fundamentals](https://aspire.dev/fundamentals/service-discovery/)
- [Compose Develop Specification](https://docs.docker.com/reference/compose-file/develop/) para `watch`
- [microsoft/aspire releases](https://github.com/microsoft/aspire/releases)
