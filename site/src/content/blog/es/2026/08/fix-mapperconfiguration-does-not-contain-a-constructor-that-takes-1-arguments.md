---
title: "Solución: 'MapperConfiguration' does not contain a constructor that takes 1 arguments"
description: "AutoMapper 15 eliminó el constructor de un solo argumento de MapperConfiguration. Pasa un ILoggerFactory como segundo argumento y agrega una acción de configuración a cada llamada a AddAutoMapper."
pubDate: 2026-08-18
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "csharp"
  - "automapper"
  - "migration"
lang: "es"
translationOf: "2026/08/fix-mapperconfiguration-does-not-contain-a-constructor-that-takes-1-arguments"
translatedBy: "claude"
translationDate: 2026-08-18
---

`new MapperConfiguration(cfg => ...)` ya no compila porque AutoMapper 15.0 eliminó el constructor de un solo argumento. Pasa un `ILoggerFactory` como segundo argumento: `new MapperConfiguration(cfg => ..., loggerFactory)`, o `NullLoggerFactory.Instance` en las pruebas. La misma versión también eliminó todas las sobrecargas de `AddAutoMapper` que no recibían una acción de configuración, así que `services.AddAutoMapper(typeof(Program))` falla en la misma compilación con otro código de error.

Todo lo que sigue está verificado con AutoMapper 15.1.3 y 16.2.0 sobre el SDK de .NET 10.0.201, apuntando a `net10.0`. El cambio llegó en [15.0.0 el 2025-07-02](https://github.com/LuckyPennySoftware/AutoMapper/releases/tag/v15.0.0) y sigue siendo la forma de la API en 16.2.0.

## El error en contexto

```text
Repro.cs(11,26): error CS1729: 'MapperConfiguration' does not contain a constructor that takes 1 arguments
```

Si registras AutoMapper mediante inyección de dependencias, la misma compilación suele producir dos errores más que son el mismo cambio incompatible con otro disfraz:

```text
Repro.cs(15,32): error CS1503: Argument 2: cannot convert from 'System.Type' to 'System.Action<AutoMapper.IMapperConfigurationExpression>'
Repro.cs(16,32): error CS1503: Argument 2: cannot convert from 'System.Reflection.Assembly' to 'System.Action<AutoMapper.IMapperConfigurationExpression>'
```

Tres errores, una sola causa. Arreglar solo el constructor deja la compilación en rojo.

## Por qué desapareció el constructor de un argumento

AutoMapper 15 agregó una clave de licencia y registro del estado de esa licencia, y ese registro necesita un destino donde escribir. En lugar de recurrir a un logger estático o a un destino ambiental, los mantenedores hicieron explícita la dependencia: `MapperConfiguration` ahora recibe el `ILoggerFactory` a través del cual va a escribir. Jimmy Bogard [lo confirmó en el issue #4542](https://github.com/LuckyPennySoftware/AutoMapper/issues/4542): es un cambio incompatible intencional y faltaba en las notas de la versión original, razón por la cual mucha gente se topa con él sin saber qué buscar.

La reflexión sobre los ensamblados publicados hace concreta la diferencia. AutoMapper 14.0.0 expone:

```text
// AutoMapper 14.0.0
MapperConfiguration.ctor(MapperConfigurationExpression)
MapperConfiguration.ctor(Action`1)
```

AutoMapper 15.1.3 y 16.2.0 exponen ambos:

```text
// AutoMapper 15.1.3 and 16.2.0
MapperConfiguration.ctor(MapperConfigurationExpression, ILoggerFactory)
MapperConfiguration.ctor(Action`1, ILoggerFactory)
```

No hay ninguna sobrecarga con un parámetro `ILoggerFactory` con valor por omisión, así que no existe forma de mantener compilando la llamada anterior. Hay que tocar cada construcción directa.

## Reproducción mínima

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
using AutoMapper;

public record Source(int Id, string Name);
public record Dest(int Id, string Name);

public class Repro
{
    public void OldStyle()
    {
        // error CS1729
        var config = new MapperConfiguration(cfg => cfg.CreateMap<Source, Dest>());
        var mapper = config.CreateMapper();
    }
}
```

Un `csproj` con nada más que `<PackageReference Include="AutoMapper" Version="15.1.3" />` lo reproduce. Ten en cuenta que esta es una ruptura solo en tiempo de compilación. Nada del motor de mapeo cambió, así que en cuanto las llamadas compilen, tus mapeos se comportan exactamente igual que en la 14.

## ¿Qué paso como ILoggerFactory fuera de la inyección de dependencias?

Para configuraciones estáticas del mapper, fixtures de pruebas y herramientas de consola donde no hay host, `NullLoggerFactory.Instance` de `Microsoft.Extensions.Logging.Abstractions` es la respuesta correcta. AutoMapper ya depende de `Microsoft.Extensions.Logging.Abstractions`, así que no hay que agregar ningún paquete nuevo.

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
using AutoMapper;
using Microsoft.Extensions.Logging.Abstractions;

public static class Maps
{
    public static readonly MapperConfiguration Config = new(
        cfg =>
        {
            cfg.LicenseKey = "<your key>";
            cfg.AddProfile<MyProfile>();
        },
        NullLoggerFactory.Instance);

    public static readonly IMapper Mapper = Config.CreateMapper();
}
```

Un `MapperConfiguration` estático sigue siendo un patrón soportado. Esa era la otra preocupación en el issue #4542, y Bogard la respondió directamente: una instancia estática está bien, y la clave de licencia puede venir de `IConfiguration` o de un almacén de secretos en lugar de quedar incrustada en un literal.

`AssertConfigurationIsValid()` sigue colgando del objeto de configuración exactamente como antes, así que las pruebas de validación no necesitan cambios más allá del constructor:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
[Fact]
public void Mapping_configuration_is_valid()
{
    var config = new MapperConfiguration(
        cfg => cfg.AddProfile<MyProfile>(),
        NullLoggerFactory.Instance);

    config.AssertConfigurationIsValid();
}
```

Si quieres que los diagnósticos de licencia sean visibles en una corrida de pruebas, cambia `NullLoggerFactory.Instance` por una fábrica real. Es lo único para lo que se usa ese parámetro.

## ¿Cómo arreglo las llamadas a AddAutoMapper que se rompieron al mismo tiempo?

Toda sobrecarga de `AddAutoMapper` sin acción de configuración fue eliminada en la 15.0. Comparando los métodos estáticos públicos de `Microsoft.Extensions.DependencyInjection.ServiceCollectionExtensions` entre versiones, estos tres desaparecieron:

```text
// Present in AutoMapper 14.0.0, gone in 15.0.0 and later
AddAutoMapper(IServiceCollection, Assembly[])
AddAutoMapper(IServiceCollection, Type[])
AddAutoMapper(IServiceCollection, IEnumerable<Assembly>, ServiceLifetime)
```

Lo que significa que la acción de configuración ahora es obligatoria y siempre va en segundo lugar:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3, ASP.NET Core minimal host
var builder = WebApplication.CreateBuilder(args);

// Before (AutoMapper 14):
// builder.Services.AddAutoMapper(typeof(Program));

// After:
builder.Services.AddAutoMapper(
    cfg => cfg.LicenseKey = builder.Configuration["AutoMapper:LicenseKey"],
    typeof(Program));
```

Si la acción no tiene nada que decir, una lambda vacía es válida: `services.AddAutoMapper(_ => { }, typeof(Program))`. Sigue siendo obligatoria por posición.

La ruta de inyección de dependencias te provee el `ILoggerFactory`, así que no hay ningún `MapperConfiguration` que construir a mano. Vale la pena saber qué queda registrado, porque los tiempos de vida son asimétricos:

```text
// Registered by AddAutoMapper, AutoMapper 15.1.3
AutoMapper.IConfigurationProvider -> Singleton
AutoMapper.IMapper               -> Transient
```

El objeto caro, la configuración compilada, es el singleton. `IMapper` es un envoltorio transient barato por encima de ella, y por eso inyectar `IMapper` en servicios scoped y transient no cuesta nada y no cae en el [problema de la dependencia cautiva de un servicio scoped desde un singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

También existe una sobrecarga que te entrega el `IServiceProvider`, útil cuando la clave vive detrás de un servicio y no de configuración cruda:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
services.AddAutoMapper(
    (sp, cfg) => cfg.LicenseKey = sp.GetRequiredService<ILicenseStore>().AutoMapperKey,
    typeof(MyProfile));
```

## ¿Qué hago si aparece 'No service for type ILoggerFactory has been registered' justo después?

Arreglas el constructor, la compilación pasa a verde, y una prueba revienta en tiempo de ejecución:

```text
System.InvalidOperationException: No service for type 'Microsoft.Extensions.Logging.ILoggerFactory' has been registered.
```

Es el registro de inyección de dependencias buscando la fábrica de loggers que AutoMapper ahora necesita. En una aplicación ASP.NET Core nunca lo vas a ver, porque `WebApplicationBuilder` configura el registro de eventos antes de que tengas oportunidad de llamar a `AddAutoMapper`. Lo ves en pruebas unitarias y en pequeñas aplicaciones de consola que arman un `ServiceCollection` pelado:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3 - throws on resolve
var services = new ServiceCollection();
services.AddAutoMapper(cfg => cfg.CreateMap<Source, Dest>());
var mapper = services.BuildServiceProvider().GetRequiredService<IMapper>();
```

Una línea lo arregla:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3 - resolves
var services = new ServiceCollection();
services.AddLogging();                       // this is the missing piece
services.AddAutoMapper(cfg => cfg.CreateMap<Source, Dest>());
var mapper = services.BuildServiceProvider().GetRequiredService<IMapper>();
```

El mensaje de error es lo bastante genérico como para que la gente lo persiga como si fuera otro bug, igual que [un registro faltante de DbContextOptions](/es/2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered/) manda a buscar en el archivo equivocado. Si apareció en el mismo commit que te movió a AutoMapper 15, es esto.

## Qué pasa realmente si nunca configuras una clave de licencia

Nada se rompe. AutoMapper 15.1.3 mapea objetos tan tranquilo sin clave alguna, con una clave inválida o con una cadena vacía. Lo que obtienes es un mensaje en el registro, bajo la categoría `LuckyPennySoftware.AutoMapper.License`:

```text
warn: LuckyPennySoftware.AutoMapper.License[0]
      You do not have a valid license key for the Lucky Penny software AutoMapper. This is allowed for
      development and testing scenarios. If you are running in production you are required to have a
      licensed version. Please visit https://luckypennysoftware.com to obtain a valid license.
```

Ese es todo el mecanismo de aplicación, y por eso el parámetro `ILoggerFactory` tenía que existir. La documentación es explícita en que no hay otra aplicación de la licencia más allá de los mensajes de registro. Es una obligación legal, no una barrera técnica, así que trata la advertencia como un tema de cumplimiento y no como un problema de ejecución a silenciar.

Un detalle que le cuesta una tarde a más de uno: una clave mal formada se registra en nivel crítico antes de la advertencia, con un fallo de parseo de JWT, porque la clave es un JWT firmado:

```text
crit: LuckyPennySoftware.AutoMapper.License[0]
      Error validating the Lucky Penny software license key
      Microsoft.IdentityModel.Tokens.SecurityTokenMalformedException: IDX14100: JWT is not well formed,
      there are no dots (.).
```

Si tu canal de registro alerta ante `Critical`, una clave truncada o con espacios mal puestos en una variable de entorno va a despertar a alguien mientras la aplicación sigue funcionando correctamente. Busca esa cadena antes de asumir que AutoMapper está roto.

Dos notas prácticas más sobre la clave. Primero, `cfg.LicenseKey` no es la única ruta documentada: la documentación lista las variables de entorno `AUTOMAPPER_LICENSE_KEY` y `LUCKYPENNY_LICENSE_KEY`, resueltas en ese orden después del valor explícito en código. En mis pruebas sobre 15.1.3 ninguna de las dos variables de entorno fue tomada, ya que un valor deliberadamente mal formado en cada una produjo solo la advertencia genérica de falta de licencia y nunca el error de parseo de JWT que sí dispara un `cfg.LicenseKey` explícito. En la línea 15.x, configura la clave en código y léela desde la configuración. Segundo, AutoMapper 16.2.0 no registró ningún mensaje de licencia en la misma prueba, así que no interpretes la ausencia de advertencia como evidencia de que una clave fue aceptada.

## ¿Conviene fijarse en AutoMapper 14 en su lugar?

Es la solución alternativa más sugerida en los hilos de issues, y desde 2026-03 es una mala idea. AutoMapper 14.0.0 y todo lo anterior a 15.1.1 arrastran [GHSA-rvv3-g6hj-g44x](https://github.com/advisories/GHSA-rvv3-g6hj-g44x), un problema de recursión no controlada de severidad alta (CVSS 7.5): mapear un grafo de objetos profundamente anidado o autorreferencial agota la pila y tumba el proceso con un `StackOverflowException` que no se puede capturar. Si entrada no confiable llega a un tipo mapeado, eso es una denegación de servicio. Restaurar 14.0.0 hoy produce esto en cada compilación:

```text
warning NU1903: Package 'AutoMapper' 14.0.0 has a known high severity vulnerability,
https://github.com/advisories/GHSA-rvv3-g6hj-g44x
```

La corrección llegó en 15.1.1 y 16.1.1, ambas publicadas en 2026-03. Así que la elección real es entre 15.1.3 y 16.2.0, no entre 15 y 14. Las dos reciben el mismo constructor, así que el trabajo de migración descrito arriba es idéntico en cualquier caso.

Si prefieres no pagar por un mapper en absoluto, esa decisión es independiente de este error de compilación y conviene tomarla con calma y no bajo la presión de una compilación rota. Las ventajas y desventajas están planteadas en el recorrido sobre [migrar de AutoMapper al mapeo generado por código fuente con Mapperly](/es/2026/05/migrate-from-automapper-to-source-generated-mapping/), y la misma pregunta de licencia comercial ya se jugó con otra biblioteca de Bogard en [MediatR vs clases de servicio simples](/es/2026/05/mediatr-vs-plain-service-classes-in-2026/).

## Qué cambia de nuevo en AutoMapper 16

Nada que tengas que tocar. La forma del constructor y las firmas de `AddAutoMapper` son idénticas entre 15.1.3 y 16.2.0, así que el código arreglado para la 15 compila sin cambios en la 16. Las diferencias están en el empaquetado:

- La 15.x apunta a `net8.0`, `net9.0` y `netstandard2.0`.
- La 16.x agrega `net10.0` y `net471`, y sube sus dependencias `Microsoft.Extensions.*` de 8.0.0 a 10.0.0.

Si ya estás en .NET 10, la 16.2.0 evita arrastrar los paquetes de extensiones 8.0.0 a tu grafo. Si estás atrapado en .NET 8 con un conjunto de dependencias transitivas bloqueado, 15.1.3 es un lugar soportado y parcheado donde quedarse. Las dos están más allá de la corrección de seguridad, y la actualización en sí es la misma edición de tres líneas en cualquier caso: agrega la fábrica de loggers, agrega la acción de configuración, decide dónde vive la clave.

## Relacionados

- [Migrar de AutoMapper al mapeo generado por código fuente con Mapperly](/es/2026/05/migrate-from-automapper-to-source-generated-mapping/)
- [MediatR vs clases de servicio simples en 2026: ¿debería moverte el cambio de licencia?](/es/2026/05/mediatr-vs-plain-service-classes-in-2026/)
- [Solución: No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered](/es/2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered/)
- [Solución: Cannot consume scoped service 'X' from singleton 'Y'](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [Migrar de EF Core 6 a EF Core 11: los cambios incompatibles que de verdad duelen](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)

## Fuentes

- [Guía de actualización a AutoMapper 15.0](https://docs.automapper.io/en/stable/15.0-Upgrade-Guide.html)
- [Notas de la versión AutoMapper v15.0.0](https://github.com/LuckyPennySoftware/AutoMapper/releases/tag/v15.0.0)
- [Issue #4542: MapperConfiguration single argument constructor](https://github.com/LuckyPennySoftware/AutoMapper/issues/4542)
- [Documentación de configuración de licencia de AutoMapper](https://docs.automapper.io/en/stable/License-configuration.html)
- [Documentación de inyección de dependencias de AutoMapper](https://docs.automapper.io/en/stable/Dependency-injection.html)
- [GHSA-rvv3-g6hj-g44x: recursión no controlada en AutoMapper](https://github.com/advisories/GHSA-rvv3-g6hj-g44x)
