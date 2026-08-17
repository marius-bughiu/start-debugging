---
title: "Cómo usar IDbContextFactory<T> desde un servicio singleton en Blazor"
description: "Un singleton no puede inyectar un DbContext, pero sí puede inyectar IDbContextFactory<T>, porque AddDbContextFactory registra la fábrica como singleton por omisión. Crea y libera un contexto por llamada, nunca guardes la instancia."
pubDate: 2026-08-16
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "blazor"
  - "ef-core"
  - "dependency-injection"
lang: "es"
translationOf: "2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor"
translatedBy: "claude"
translationDate: 2026-08-16
---

Un servicio singleton no puede recibir un `DbContext` en su constructor: `AddDbContext<T>` registra el contexto como scoped, y el validador de ámbitos de ASP.NET Core rechaza la captura al arrancar. Sí puede recibir `IDbContextFactory<T>`, porque `AddDbContextFactory<T>` registra la fábrica como **singleton** por omisión. Inyecta la fábrica, llama a `CreateDbContextAsync` dentro de cada método, envuélvelo en `await using` y nunca guardes el contexto devuelto en un campo. Esa última regla lo es todo: un singleton en Blazor lo comparten todos los circuitos del servidor, así que un contexto cacheado recibe llamadas de varios usuarios a la vez y EF Core se corrompe o lanza una excepción.

Esta guía está escrita para .NET 11 y EF Core 11. Todo lo que sigue aplica igual a .NET 6, 8 y 10, porque `IDbContextFactory<T>` mantiene la misma forma de registro desde EF Core 5.0. Los volcados de registro y los mensajes de error de abajo se produjeron con el SDK .NET 10.0.201 y `Microsoft.EntityFrameworkCore.Sqlite` 10.0.11, que es el runtime que tenía instalado al escribir esto.

## Por qué un singleton de Blazor es el caso más hostil para DbContext

Blazor del lado del servidor mantiene un *circuito* por usuario conectado. Ese circuito es un único ámbito de DI de larga vida que dura tanto como la pestaña del navegador, no tanto como una solicitud HTTP. La propia guía de Microsoft sobre EF Core con Blazor señala que los tres tiempos de vida estándar son inadecuados para un `DbContext`: singleton comparte una instancia entre todos los usuarios, scoped comparte una instancia entre todos los componentes del circuito de un mismo usuario, y transient produce contextos que viven tanto como el componente que los sostiene.

El singleton es el peor de los tres, y es fácil acabar con uno sin querer. Una caché de catálogo, un servicio de tablas de consulta, un `IHostedService` que refresca datos de referencia, un `IEmailSender` que escribe una fila de auditoría: todos son singletons por naturaleza, todos quieren acceso a la base de datos, y ninguno puede sostener un `DbContext`.

La validación de ámbitos detecta la versión ingenua al arrancar. Registrar el contexto de forma normal e inyectarlo en un singleton hace fallar a `BuildServiceProvider` con `ValidateOnBuild`:

```text
Error while validating the service descriptor 'ServiceType: BadWarmer Lifetime: Singleton
ImplementationType: BadWarmer': Cannot consume scoped service 'AppDb' from singleton 'BadWarmer'.
```

Esa es la misma comprobación de dependencia cautiva que produce el [error de no poder consumir un servicio scoped desde un singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/) en aplicaciones ASP.NET Core normales. La fábrica es la salida sancionada.

## Qué registra realmente AddDbContextFactory

La razón por la que un singleton puede inyectar la fábrica no es una convención, es el valor por omisión declarado. La firma es:

```csharp
// EF Core 11, Microsoft.Extensions.DependencyInjection
public static IServiceCollection AddDbContextFactory<TContext>(
    this IServiceCollection serviceCollection,
    Action<DbContextOptionsBuilder>? optionsAction = null,
    ServiceLifetime lifetime = ServiceLifetime.Singleton)
    where TContext : DbContext;
```

`lifetime` vale `ServiceLifetime.Singleton` por omisión, y controla "el tiempo de vida con el que se registran la fábrica **y las opciones**". Volcar los descriptores de servicio que agrega una sola llamada a `AddDbContextFactory<AppDb>` deja clara la forma:

```text
Singleton  Microsoft.EntityFrameworkCore.DbContextOptions`1[AppDb]
Singleton  Microsoft.EntityFrameworkCore.DbContextOptions
Singleton  Microsoft.EntityFrameworkCore.Internal.IDbContextFactorySource`1[AppDb]
Singleton  Microsoft.EntityFrameworkCore.IDbContextFactory`1[AppDb]
Scoped     AppDb
```

Vale la pena notar dos cosas.

Primero, `IDbContextFactory<AppDb>` es singleton, así que inyectarlo en tu propio singleton pasa la validación de ámbitos sin problemas. La implementación concreta que se resuelve es la `DbContextFactory<TContext>` integrada de EF Core.

Segundo, y esto sorprende: `AddDbContextFactory` **también registra el propio tipo del contexto como scoped**. Es comportamiento documentado, no una fuga. Las notas de la API lo dicen sin rodeos: "For convenience, this method also registers the context type itself as a scoped service. This allows a context instance to be resolved from a dependency injection scope directly or created by the factory, as appropriate." Así que después de una llamada a `AddDbContextFactory`, `@inject AppDb Db` sigue compilando y sigue funcionando en un componente. En Blazor es una trampa, porque esa instancia scoped pertenece al circuito y la comparten todos los componentes de la pestaña. Registrar la fábrica no impide que alguien inyecte el contexto de la forma equivocada.

## Cómo conectarlo en cuatro pasos

1. Registra la fábrica en `Program.cs` y deja el tiempo de vida por omisión. No pases `ServiceLifetime.Scoped`, que es la forma más común de romper esto.

   ```csharp
   // .NET 11, EF Core 11
   builder.Services.AddDbContextFactory<CatalogDb>(options =>
       options.UseSqlServer(builder.Configuration.GetConnectionString("Catalog")));

   builder.Services.AddSingleton<CatalogCache>();
   ```

2. Expón en el contexto el constructor con `DbContextOptions<TContext>`, igual que harías con `AddDbContext`. La fábrica pasa las opciones por ese constructor, así que un contexto que solo tenga constructor sin parámetros no se podrá crear.

   ```csharp
   public sealed class CatalogDb(DbContextOptions<CatalogDb> options) : DbContext(options)
   {
       public DbSet<Product> Products => Set<Product>();
   }
   ```

3. Inyecta `IDbContextFactory<TContext>` en el singleton y crea un contexto por cada llamada a método. Usa `CreateDbContextAsync` y `await using` para que la liberación asíncrona pase por la ruta propia del proveedor.

   ```csharp
   public sealed class CatalogCache(IDbContextFactory<CatalogDb> factory)
   {
       public async Task<List<Product>> GetActiveAsync(CancellationToken ct = default)
       {
           await using var db = await factory.CreateDbContextAsync(ct);
           return await db.Products
               .AsNoTracking()
               .Where(p => p.IsActive)
               .ToListAsync(ct);
       }
   }
   ```

4. Activa la validación de ámbitos en todos los entornos, para que una refactorización futura que reintroduzca un `DbContext` cautivo falle al arrancar y no a las 3 de la mañana bajo carga.

   ```csharp
   builder.Host.UseDefaultServiceProvider(options =>
   {
       options.ValidateScopes = true;
       options.ValidateOnBuild = true;
   });
   ```

Los contextos que te entrega la fábrica **no** pertenecen al contenedor de DI. La documentación de EF Core es explícita: las instancias creadas así "are not managed by the application's service provider and therefore must be disposed by the application". El `await using` del paso 3 no es cortesía opcional; sin él filtras conexiones durante toda la vida del proceso.

## Qué se rompe de verdad cuando cacheas el contexto

El atajo tentador es crear un contexto en el constructor del singleton y reutilizarlo. Parece inofensivo en desarrollo, donde eres el único usuario. Aquí está el mismo `CatalogCache` sosteniendo un solo contexto, con 25 llamadas concurrentes en hilos reales:

```csharp
// Do not do this. One context, shared by every circuit on the server.
public sealed class CatalogCache(IDbContextFactory<CatalogDb> factory)
{
    private readonly CatalogDb _shared = factory.CreateDbContext();

    public Task<int> CountAsync() => _shared.Products.CountAsync();
}
```

Ejecutar eso tres veces seguidas con EF Core 10.0.11 produjo tres resultados distintos, dos de ellos excepciones diferentes:

```text
run 1: InvalidOperationException: A second operation was started on this context instance
       before a previous operation completed. This is usually caused by different threads
       concurrently using the same instance of DbContext.
run 2: InvalidOperationException: ExecuteReader can only be called when the connection is open.
run 3: InvalidOperationException: A second operation was started on this context instance ...
```

Ese indeterminismo es justamente el punto. El detector de seguridad entre hilos de EF Core produce el primer mensaje, más amable, cuando gana la carrera, pero no siempre la gana: la segunda ejecución sacó a la superficie un fallo crudo de estado de conexión de ADO.NET, porque dos operaciones ya se habían entrelazado sobre la misma conexión. Con otro ritmo de ejecución, el mismo error devuelve datos incorrectos en silencio en lugar de lanzar nada. Antes, durante mis pruebas, 25 tareas que resultaron completarse de forma síncrona devolvieron todas la respuesta correcta y no lanzaron nada, que es exactamente por qué este error llega a producción.

Al cambiar a un contexto por llamada, las mismas 25 llamadas concurrentes tuvieron éxito con resultados idénticos. Eso no es código ingenioso, es solo la [regla de una unidad de trabajo](/es/2026/05/fix-second-operation-was-started-on-this-context-instance/) aplicada con honestidad.

El mismo razonamiento explica por qué capturar un contexto dentro de una tarea desprendida produce [ObjectDisposedException sobre una instancia de contexto ya liberada](/es/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/): los dos errores vienen de dejar que un contexto sobreviva a la operación que lo necesitaba.

## La sobrecarga que rompe el patrón sin avisar

`AddDbContextFactory` acepta un `lifetime` opcional. Pasar `ServiceLifetime.Scoped` es un consejo muy copiado y pegado, normalmente heredado de un ejemplo multiinquilino donde la cadena de conexión se resuelve por solicitud. Cambia el registro de la fábrica y reintroduce exactamente la dependencia cautiva que querías evitar:

```csharp
// This compiles, then fails at startup once a singleton consumes the factory.
builder.Services.AddDbContextFactory<CatalogDb>(
    options => options.UseSqlServer(connectionString),
    lifetime: ServiceLifetime.Scoped);
```

```text
Error while validating the service descriptor 'ServiceType: CacheWarmer Lifetime: Singleton
ImplementationType: CacheWarmer': Cannot consume scoped service
'Microsoft.EntityFrameworkCore.IDbContextFactory`1[AppDb]' from singleton 'CacheWarmer'.
```

Si de verdad necesitas una cadena de conexión por circuito, no hagas scoped la fábrica para luego consumirla desde un singleton. Mantén la fábrica como singleton y pasa el inquilino de forma explícita, o resuelve la fábrica específica del inquilino con `IServiceScopeFactory` dentro del método. Lo que lleva a la limitación real de todo este patrón.

## Un singleton no tiene circuito, así que no tiene usuario

Esta es la restricción con la que la gente choca en segundo lugar, después de acertar con el cableado. Un singleton se crea una vez para todo el servidor. No tiene `AuthenticationStateProvider`, ni resolutor de inquilino ligado al circuito, ni `HttpContext`. Cualquier `DbContextOptions` calculado a partir del usuario ambiental sencillamente no existe en el momento en que corre tu singleton.

En concreto, esto no funciona:

```csharp
// The singleton has no circuit, so there is no current user to read here.
builder.Services.AddDbContextFactory<CatalogDb>((sp, options) =>
    options.UseSqlServer(sp.GetRequiredService<ITenantContext>().ConnectionString));
```

Si los datos que toca tu singleton son realmente por usuario, el singleton es el lugar equivocado. O mueves el trabajo a un servicio scoped que el componente llama, o pasas la identidad del inquilino como parámetro del método y eliges tú la cadena de conexión:

```csharp
public sealed class CatalogCache(IDbContextFactory<CatalogDb> factory)
{
    public async Task<int> CountForAsync(string tenantId, CancellationToken ct = default)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Products.CountAsync(p => p.TenantId == tenantId, ct);
    }
}
```

Los datos de referencia, las tablas de consulta y los agregados entre inquilinos encajan bien en un singleton con una fábrica. Todo lo que dependa de "el usuario actual" no. Si recurres a un singleton sobre todo para evitar consultas repetidas, una caché es la primitiva mejor, y [HybridCache frente a IMemoryCache e IDistributedCache](/es/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) cubre cómo elegir una.

## Cuándo conviene la fábrica con pool

`AddPooledDbContextFactory<TContext>` también registra un `IDbContextFactory<TContext>` singleton, respaldado por `PooledDbContextFactory<TContext>`, con un `poolSize` que vale 1024 por omisión desde EF Core 6 (era 128 en EF Core 5.0). Liberar un contexto del pool lo reinicia y lo devuelve al pool en vez de descartarlo, lo que recorta las asignaciones de memoria de forma medible en rutas calientes.

Comportamiento verificado en EF Core 10.0.11: crear un contexto, liberarlo y crear otro devuelve la **misma** instancia, y tocar el primero después de liberarlo lanza `ObjectDisposedException`. Así que el pool recicla de verdad, y el uso tras liberación se sigue detectando.

Dos advertencias antes de cambiar:

- Las sobrecargas con pool no aceptan parámetro `lifetime`, y `optionsAction` es obligatorio en lugar de opcional. La configuración debe hacerse por fuera, porque `OnConfiguring` no se llama en absoluto sobre contextos del pool.
- Los contextos del pool no pueden recibir servicios arbitrarios inyectados en su constructor, ya que la instancia se reutiliza entre operaciones sin relación. Cualquier estado que guardes en el contexto sobrevive hasta la siguiente llamada salvo que EF Core lo reinicie.

Para un singleton que hace lecturas cortas y muy frecuentes, la fábrica con pool es el valor por omisión más adecuado. Para un singleton que trabaja de forma ocasional, la fábrica normal es más simple y la diferencia de asignaciones no aparecerá en un perfilado. Si el punto caliente son las consultas y no la construcción del contexto, [las consultas compiladas para rutas calientes de EF Core](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) son la palanca más grande.

## Modos de renderizado, WebAssembly y servicios en segundo plano

Vale la pena nombrar tres casos límite, porque cambian dónde vive el singleton.

**Modos de renderizado interactivo WebAssembly y Auto.** Un singleton registrado en el `Program.cs` del proyecto de servidor existe solo en el servidor. Los componentes que corren en el cliente tienen su propio proveedor de servicios en el proyecto WebAssembly, y un `DbContext` no puede abrir ninguna conexión a base de datos desde el entorno aislado del navegador. Si un componente pasa de interactive server a interactive WebAssembly, el singleton del que dependía deja de poder resolverse en el cliente sin avisar. Esa frontera es la misma que hay detrás del [problema de estado entre el renderizado estático e interactivo de Blazor](/es/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/).

**SSR estático y prerenderizado.** Durante el renderizado estático del lado del servidor no hay circuito, pero el proveedor raíz de la aplicación sigue existiendo, así que un singleton con una fábrica funciona con normalidad. Este es uno de los pocos patrones de base de datos que se comporta igual en SSR estático, prerenderizado y renderizado interactivo de servidor, lo que es un argumento real a su favor.

**BackgroundService.** `AddHostedService<T>` registra un singleton, así que un servicio alojado que necesita datos tiene exactamente el mismo problema y exactamente la misma solución. Inyecta `IDbContextFactory<T>` cuando el trabajo es acceso puro a datos; recurre a `IServiceScopeFactory` cuando la unidad de trabajo necesita varios servicios scoped juntos, algo que se cubre en [usar servicios scoped dentro de un BackgroundService](/es/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).

El patrón es lo bastante pequeño como para enunciarlo en una línea: los singletons pueden sostener fábricas, nunca contextos. Todo lo demás en este artículo es una consecuencia de eso.

## Fuentes

- [DbContext Lifetime, Configuration, and Initialization](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/), documentación de EF Core, sobre `AddDbContextFactory` y la liberación de contextos no gestionados.
- [ASP.NET Core Blazor with Entity Framework Core](https://learn.microsoft.com/en-us/aspnet/core/blazor/blazor-ef-core), sobre los circuitos y por qué singleton, scoped y transient son todos inadecuados para un `DbContext`.
- [EntityFrameworkServiceCollectionExtensions.AddDbContextFactory](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions.adddbcontextfactory), para el valor por omisión `ServiceLifetime.Singleton` y el registro scoped del tipo del contexto.
- [EntityFrameworkServiceCollectionExtensions.AddPooledDbContextFactory](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions.addpooleddbcontextfactory), para el valor por omisión de `poolSize` y la advertencia sobre `OnConfiguring`.
