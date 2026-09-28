---
title: "Quartz.NET 4.2 convierte las expresiones cron incorrectas en errores de compilación"
description: "Quartz.NET 4.2.0 incluye un analizador de Roslyn que rechaza los literales cron que no se pueden analizar como QZ0001 en tiempo de compilación, además de un generador de código fuente que convierte los atributos [QuartzJob] y [CronTrigger] en un registro AddDeclaredJobs(). Aquí se explica qué verifica, cómo es el código generado y cómo desactivarlo."
pubDate: 2026-09-28
tags:
  - "quartz-net"
  - "dotnet"
  - "csharp"
  - "source-generators"
  - "roslyn-analyzers"
lang: "es"
translationOf: "2026/09/quartz-net-4-2-turns-bad-cron-expressions-into-build-errors"
translatedBy: "claude"
translationDate: 2026-09-28
---

La mayoría de los usuarios de Quartz.NET han publicado alguna vez una expresión cron que se veía bien en la revisión y que lanzaba una `FormatException` al iniciar. [Quartz.NET 4.2.0](https://github.com/quartznet/quartznet/releases/tag/v4.2.0), publicado el 25 de septiembre de 2026 y seguido del parche 4.2.1 el 27 de septiembre, traslada ese fallo al compilador. El paquete `Quartz` ahora incluye su propio analizador y generador de código fuente, sin necesidad de instalar ningún paquete adicional.

## QZ0001: el analizador de cron se ejecuta en tiempo de compilación

El analizador inspecciona cada literal o constante cron que se pasa a `WithCronSchedule`, `CronScheduleBuilder.Create`, los constructores de `CronExpression`, `CronCalendar` y `CronTriggerImpl`. No usa una segunda gramática: enlaza directamente el código fuente del propio analizador del programador de tareas, y un corpus de paridad de 128 expresiones mantiene a ambos en concordancia. Si el compilador acepta un literal, el programador de tareas también lo acepta.

```csharp
q.AddTrigger(t => t
    .ForJob(jobKey)
    .WithCronSchedule("0 12 * * 1-5"));
// error QZ0001, reported on the literal with the parser's own message
```

Ese ejemplo es el error clásico: una expresión crontab de cinco campos copiada de Linux. Quartz lee seis o siete campos (con los segundos primero) y requiere `?` en uno de los dos campos de día, así que la versión de Quartz es `"0 0 12 ? * MON-FRI"`. Si realmente quieres usar la gramática Unix, pasa `CronFormat.Unix` como literal y el analizador validará contra esa gramática en su lugar.

Junto con esta regla se incluyen otras tres:

- **QZ0002** (error): un valor de `[JobTimeout("...")]` que no se puede analizar o que es negativo.
- **QZ0003** (advertencia): `[PersistJobDataAfterExecution]` sin `[DisallowConcurrentExecution]`, donde dos ejecuciones concurrentes pueden sobrescribirse mutuamente el mapa de datos del job.
- **QZ0004** (información): un método `Execute` que nunca observa su `CancellationToken`.

## Declarar el job en su propia clase

La segunda mitad de la función es un generador que lee `[QuartzJob]` y `[CronTrigger]` en tus tipos `IJob`:

```csharp
[QuartzJob(Name = "cleanup", Group = "maintenance")]
[CronTrigger("0 0 0/6 * * ?")]
[CronTrigger("0 0 12 ? * MON-FRI", Name = "cleanup-weekday-noon", TimeZone = "Europe/Helsinki")]
public sealed class CleanupJob : IJob
{
    public ValueTask Execute(IJobExecutionContext context, CancellationToken cancellationToken = default)
        => default;
}

services.AddQuartz(q => q.AddDeclaredJobs());
services.AddQuartzHostedService();
```

`AddDeclaredJobs()` se genera en tu ensamblado como una extensión `internal` sobre `IQuartzBuilder`. Contiene exactamente las llamadas a `AddJob<T>` y `AddTrigger<T>` que habrías escrito a mano, por lo que no hay escaneo de ensamblados ni nada que anclar como raíz para trimming o Native AOT. Las cadenas cron de los atributos pasan por QZ0001 como cualquier otro literal. Configura `<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>` si quieres leer el `QuartzDeclaredJobs.g.cs` generado.

El generador tiene sus propias barreras de seguridad: `QZ1001` rechaza el atributo en un tipo que no es un `IJob` concreto, `QZ1002` rechaza dos declaraciones con la misma identidad, y `QZ1003` rechaza un `[CronTrigger]` sin `[QuartzJob]`. Un job sin trigger se fuerza a `Durable = true` para que el almacén no lo elimine de inmediato.

## Notas de actualización

El analizador está activado de forma predeterminada, lo que significa que un proyecto existente con un literal incorrecto deja de compilar. Esa es la intención, pero también presta atención a QZ0003 bajo `TreatWarningsAsErrors`. Para desactivarlo por completo, configura esto en el archivo de proyecto:

```xml
<PropertyGroup>
  <DisableQuartzAnalyzers>true</DisableQuartzAnalyzers>
</PropertyGroup>
```

Las notas de la versión señalan que `ExcludeAssets="analyzers"` en la referencia del paquete no lo desactiva en el SDK de .NET 10. Aun así, puedes ajustar la severidad de cada regla en `.editorconfig`.

Si usas un almacén de jobs persistente, 4.2 también requiere la migración `database/migrations/4.2/add_continuations_<dialect>.sql` antes de que arranque el primer nodo 4.2, debido a la nueva función de continuaciones de trigger. Y si activas el nuevo historial de ejecución respaldado por base de datos en un esquema creado a partir de `tables_sqlServerMOT.sql` o `tables_sqlServer_Below2016.sql`, ve directamente a [4.2.1](https://github.com/quartznet/quartznet/releases/tag/v4.2.1), que corrige la columna `RETRY_ATTEMPT` faltante.

Si todavía estás decidiendo si Quartz es el programador de tareas adecuado, lo comparé con las alternativas en [Hangfire vs Quartz.NET vs IHostedService](/2026/06/hangfire-vs-quartz-net-vs-ihostedservice-for-scheduled-llm-jobs/).
