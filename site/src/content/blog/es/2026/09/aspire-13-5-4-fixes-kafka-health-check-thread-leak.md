---
title: "Aspire 13.5.4 evita que los health checks de Kafka filtren un productor en cada sondeo"
description: "Antes de Aspire 13.5.4, cada health check del AppHost sobre un recurso AddKafka creaba un nuevo productor de Confluent que nadie liberaba, así que los hilos de sondeo se acumulaban y el AppHost consumía CPU. La corrección, y la trampa de HealthCheckRegistration.Factory que hay detrás, también aplica a tus propios health checks."
pubDate: 2026-09-21
tags:
  - "aspire"
  - "kafka"
  - "dotnet"
  - "health-checks"
  - "dependency-injection"
lang: "es"
translationOf: "2026/09/aspire-13-5-4-fixes-kafka-health-check-thread-leak"
translatedBy: "claude"
translationDate: 2026-09-21
---

[Aspire 13.5.4](https://github.com/microsoft/aspire/releases/tag/v13.5.4) salió el 2026-09-15 y es un parche que vale la pena instalar si tu AppHost llama a `AddKafka`. Hasta la 13.5.3, el health check de Kafka que registra `Aspire.Hosting.Kafka` creaba un productor de Confluent.Kafka completamente nuevo en cada ejecución y nunca lo liberaba. Cada productor arranca su propio hilo de sondeo, así que un AppHost de larga duración se iba llenando de hilos atascados en `SafeKafkaHandle.Poll`. El reporte en [el issue #20091](https://github.com/microsoft/aspire/issues/20091) describe un AppHost en macOS al 350-400% de CPU, con una traza de muestreo de hilos en la que 1901 de 1934 hilos muestreados estaban dentro del bucle de sondeo de Kafka.

Si alguna vez dejaste `dotnet run` abierto sobre un AppHost toda una tarde y te preguntaste por qué giraban los ventiladores, este es un candidato probable.

## De dónde salían los productores

La integración de hosting construía su check dentro de una factory de `HealthCheckRegistration`:

```csharp
var healthCheckRegistration = new HealthCheckRegistration(
    healthCheckKey,
    sp =>
    {
        var options = new KafkaHealthCheckOptions();
        options.Configuration = new ProducerConfig();
        options.Configuration.BootstrapServers = connectionString
            ?? throw new InvalidOperationException("Connection string is unavailable");
        return new KafkaHealthCheck(options);
    },
    failureStatus: default,
    tags: default);
builder.Services.AddHealthChecks().Add(healthCheckRegistration);
```

`HealthCheckService` llama a esa factory en cada ejecución del check. `KafkaHealthCheck` crea un productor de forma diferida y lo libera en `Dispose()`, pero el objeto devuelto por la factory se construía con `new`, no se resolvía desde el contenedor. El runner de health checks sí abre y libera un scope de DI por ejecución, pero un scope solo libera las instancias que él mismo creó. Nadie llamaba nunca a `Dispose()` sobre el check, así que cada sondeo dejaba atrás un productor más y un hilo de sondeo más.

El código evitaba a propósito `AddKafka(...)` del paquete de health checks de Xabaril: ese helper registra un singleton y, con dos recursos Kafka, la factory leería la cadena de conexión del último recurso ([Xabaril #2298](https://github.com/Xabaril/AspNetCore.Diagnostics.HealthChecks/issues/2298)). El workaround corrigió el bug de configuración e introdujo el bug de ciclo de vida.

## La corrección: que DI sea dueño del check

[El PR #20092](https://github.com/microsoft/aspire/pull/20092), portado a 13.5.4 como #20094, registra un singleton con clave por cada recurso Kafka y hace que la factory lo resuelva:

```csharp
builder.Services.AddKeyedSingleton<KafkaHealthCheck>(healthCheckKey, (sp, _) =>
{
    var options = new KafkaHealthCheckOptions();
    options.Configuration = new ProducerConfig();
    options.Configuration.BootstrapServers = connectionString
        ?? throw new InvalidOperationException("Connection string is unavailable");
    return new KafkaHealthCheck(options);
});

var healthCheckRegistration = new HealthCheckRegistration(
    healthCheckKey,
    sp => sp.GetRequiredKeyedService<KafkaHealthCheck>(healthCheckKey),
    failureStatus: default,
    tags: default);
```

Usar la clave `"{name}_check"` mantiene separados los bootstrap servers de cada recurso, el productor se reutiliza entre sondeos y el contenedor raíz lo libera cuando el AppHost se apaga. La medición del PR contra dos brokers Kafka 8.2.0 reales: 84 ejecuciones del health check produjeron 84 instancias del check y 84 hilos de sondeo en 13.5.3, frente a 2 instancias y 2 hilos con la corrección, y 0 hilos restantes tras la liberación.

## Actualizar

Sube los paquetes de Aspire en el proyecto del AppHost:

```xml
<PackageReference Include="Aspire.Hosting.Kafka" Version="13.5.4" />
```

No hace falta cambiar código del AppHost y no hay cambios en la API pública. La misma versión también corrige fallos de DevTunnel con regiones seleccionadas automáticamente (una regresión de la 13.3), oculta el recurso `azure-environment` sin uso en AppHosts que solo usan emuladores y marca `IAwsRadiusProviderBuilder` e `IAzureRadiusProviderBuilder` con el diagnóstico experimental `ASPIRERADIUS003`, que puede aparecer como un nuevo warning-as-error si referencias esas interfaces directamente.

## Revisa tus propios health checks en busca del mismo patrón

El bug no es exclusivo de Kafka. Cualquier factory de `HealthCheckRegistration` que devuelva `new SomethingDisposable(...)` filtra una instancia por sondeo, y con el periodo por defecto de 30 segundos del publisher de health checks eso son 2880 objetos filtrados al día por check. O registras el check en DI y lo resuelves en la factory, como hace ahora Aspire, o mantienes el cliente costoso (productor, conexión, `HttpClient`) en un singleton y dejas que el check sea un objeto barato y sin estado. Si sigues en la línea 13.5, el [post anterior sobre `WithTerminal()`](/es/2026/08/aspire-13-5-withterminal-interactive-shells-in-the-dashboard/) cubre el resto de lo que la 13.5 cambió en el dashboard.
