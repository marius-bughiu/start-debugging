---
title: "Cómo quitar u ocultar endpoints individuales que MapIdentityApi mapea en ASP.NET Core"
description: "MapIdentityApi<TUser>() mapea diez endpoints y no tiene ningún interruptor para omitir uno. Estas son cuatro formas medidas de resolverlo en .NET 11: ocultar un endpoint de OpenAPI, hacer que devuelva 404, sombrearlo o quitarlo por completo del enrutamiento, además de la trampa de /confirmEmail que convierte el registro en un 500."
pubDate: 2026-10-17
template: how-to
tags:
  - "aspnetcore"
  - "aspnetcore-11"
  - "identity"
  - "minimal-apis"
  - "openapi"
  - "dotnet-11"
lang: "es"
translationOf: "2026/10/how-to-remove-or-hide-individual-endpoints-that-mapidentityapi-maps-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-10-17
---

**Respuesta corta:** `MapIdentityApi<TUser>()` no tiene ningún parámetro para elegir endpoints, y eso sigue siendo cierto en .NET 11 RC 2. Lo que obtienes de vuelta es un `IEndpointConventionBuilder`, y sus convenciones se ejecutan sobre cada endpoint con el patrón de ruta final disponible, así que puedes identificar `/register` o `/manage/2fa` por patrón. Para ocultar un endpoint solo del documento OpenAPI, agrega `ExcludeFromDescriptionAttribute` en una convención. Para dejarlo inutilizable, reemplaza además `EndpointBuilder.RequestDelegate` por uno que devuelva 404. Para quitarlo del enrutamiento por completo, mapea Identity en un `IEndpointRouteBuilder` privado y vuelve a exponer sus endpoints mediante un `EndpointDataSource` que filtre (unas 30 líneas, abajo). Nunca quites `/confirmEmail` mientras `/register` o `/resendConfirmationEmail` sigan activos: ambos lanzan `NotSupportedException` y devuelven 500.

Todo lo que sigue se ejecutó en macOS con el SDK 11.0.100-rc.1.26425.128, `Microsoft.AspNetCore.Identity.EntityFrameworkCore` 11.0.0-rc.1.26425.128 y un almacén InMemory de EF Core. Comparé `IdentityApiEndpointRouteBuilderExtensions.cs` entre las etiquetas `v8.0.0`, `v11.0.0-rc.1.26425.128` y `v11.0.0-rc.2.26504.105`: la lista de rutas es idéntica en las tres, y el archivo no cambió entre RC 1 y RC 2, así que las técnicas aplican a .NET 8, 9, 10 y 11.

## Por qué no hay una forma integrada de omitir un endpoint

`MapIdentityApi<TUser>()` es un único método de extensión que crea un grupo de rutas vacío y mapea todo dentro de él:

| Método | Ruta | Requiere autenticación |
| --- | --- | --- |
| POST | `/register` | no |
| POST | `/login` | no |
| POST | `/refresh` | no |
| GET | `/confirmEmail` | no |
| POST | `/resendConfirmationEmail` | no |
| POST | `/forgotPassword` | no |
| POST | `/resetPassword` | no |
| POST | `/manage/2fa` | sí |
| GET | `/manage/info` | sí |
| POST | `/manage/info` | sí |

Luego el código fuente envuelve el grupo en un tipo privado `IdentityEndpointsConventionBuilder`, con un comentario que dice que lo hace "to avoid a potential future behavioral breaking change". No puedes convertir el valor devuelto de vuelta a `RouteGroupBuilder`, y los manejadores son lambdas dentro del método, así que tampoco puedes invocarlos tú mismo.

La solicitud de dividirlo está abierta desde 2024 como [dotnet/aspnetcore#55792](https://github.com/dotnet/aspnetcore/issues/55792) ("Split MapIdentityApi<TUser>() into multiple APIs and allow selective end points to be enabled"), y la más amplia [dotnet/aspnetcore#50303](https://github.com/dotnet/aspnetcore/issues/50303) sobre extensibilidad se remonta a las versiones preliminares de .NET 8. Ambas están en el hito Backlog. Hasta que alguna llegue, los motivos habituales por los que la gente se topa con esto (el registro público debe estar desactivado, el 2FA se maneja en otro lugar, el documento OpenAPI no debería anunciar el restablecimiento de contraseña) hay que resolverlos desde fuera.

## La configuración de prueba

Esta es la aplicación en la que se conecta cada variante de abajo. Los endpoints de Identity viven bajo `/account`, porque así los montan la mayoría de las aplicaciones reales y porque eso afecta cómo se identifican las rutas:

```csharp
// .NET 11 RC 1, Microsoft.AspNetCore.Identity.EntityFrameworkCore 11.0.0-rc.1.26425.128
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase("ids"));
builder.Services.AddAuthorization();
builder.Services.AddIdentityApiEndpoints<IdentityUser>()
    .AddEntityFrameworkStores<AppDbContext>();
builder.Services.AddOpenApi();

var app = builder.Build();
app.MapOpenApi();

var account = app.MapGroup("/account");
account.MapIdentityApi<IdentityUser>();

app.Run();

class AppDbContext(DbContextOptions<AppDbContext> options)
    : IdentityDbContext<IdentityUser>(options);
```

Sin cambios, `/openapi/v1.json` lista las diez rutas bajo `/account`, `POST /account/register` devuelve 200, y un `POST /account/manage/2fa` anónimo devuelve 401.

Un detalle importa para todas las técnicas siguientes: dentro de una convención, `RouteEndpointBuilder.RoutePattern.RawText` es el patrón **final**, con el prefijo del grupo incluido. Si lo registras desde una convención, imprime `/account/register`, `/account/manage/2fa`, y así sucesivamente, no `/register`. Identity mismo se apoya en esto cuando nombra el endpoint de confirmación de correo. Por eso identifica con `EndsWith`, o compara contra la ruta completa con prefijo:

```csharp
// .NET 11 RC 1
string[] blocked = ["/register", "/manage/2fa"];

bool IsBlocked(EndpointBuilder b) =>
    b is RouteEndpointBuilder rb &&
    blocked.Any(p => rb.RoutePattern.RawText!.EndsWith(p, StringComparison.OrdinalIgnoreCase));
```

## Opción 1: ocultar un endpoint solo del documento OpenAPI

Si el endpoint debe seguir funcionando pero quedar fuera de tu contrato publicado (algo común con `/refresh` o `/manage/info` en un documento de API público), agrega los mismos metadatos que agrega `.ExcludeFromDescription()`:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>().Add(b =>
{
    if (IsBlocked(b))
        b.Metadata.Add(new ExcludeFromDescriptionAttribute());
});
```

Resultado medido: `/account/register` y `/account/manage/2fa` desaparecen de `/openapi/v1.json`, y `POST /account/register` sigue devolviendo 200. Ese es el objetivo de esta opción, y también su límite. Ocultar es documentación, no control de acceso. Cualquiera que haya leído la documentación de Identity sabe que la ruta existe.

`ExcludeFromDescriptionAttribute` vive en `Microsoft.AspNetCore.Routing` e implementa `IExcludeFromDescriptionMetadata`, que respetan tanto el generador integrado `Microsoft.AspNetCore.OpenApi` como el API explorer de Swashbuckle. Si prefieres mantener todo esto en un solo lugar, puedes hacer el mismo filtrado en un transformador de documento, como se muestra en [el artículo sobre transformadores de operación y de esquema de OpenAPI](/es/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/), pero el enfoque con metadatos es más simple y además cubre a otros consumidores del API explorer.

## Opción 2: mantener la ruta pero hacer que devuelva 404

Para apagar de verdad un endpoint, reemplaza su delegado de solicitud en la misma convención. Las convenciones reciben el `EndpointBuilder` antes de que se construya el `RouteEndpoint`, y `RequestDelegate` es una propiedad con setter:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>().Add(b =>
{
    if (!IsBlocked(b)) return;

    b.Metadata.Add(new ExcludeFromDescriptionAttribute());
    b.RequestDelegate = ctx =>
    {
        ctx.Response.StatusCode = StatusCodes.Status404NotFound;
        return Task.CompletedTask;
    };
});
```

Resultado medido: `POST /account/register` devuelve 404, ambas rutas desaparecen del documento OpenAPI, y todos los demás endpoints se comportan igual que antes. Obtuve el mismo resultado con `.Finally(...)` en lugar de `.Add(...)`. Las convenciones `Finally` se ejecutan después de todas las demás, lo cual es la opción más segura si algo más en tu pipeline también toca `RequestDelegate`.

El inconveniente es que el endpoint sigue existiendo para el enrutamiento y la autorización. Conserva todos sus metadatos, incluido el `RequireAuthorization()` que Identity coloca en el grupo `/manage`. El middleware de autorización se ejecuta antes del delegado del endpoint, así que un `POST /account/manage/2fa` anónimo sigue devolviendo **401**, no 404. Solo los llamadores autenticados llegan a tu 404. Si el objetivo es "no revelar que esto existe", esa diferencia es visible desde fuera.

Un [filtro de endpoint](/es/2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11/) te lleva al mismo lugar, porque `AddEndpointFilter` funciona en cualquier `IEndpointConventionBuilder`:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>().AddEndpointFilter(async (ctx, next) =>
{
    var route = (ctx.HttpContext.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? "";
    if (blocked.Any(p => route.EndsWith(p))) return Results.NotFound();
    return await next(ctx);
});
```

También devolvió 404 para `/account/register`, pero aquí es estrictamente peor: el filtro se ejecuta en cada solicitud de Identity, los endpoints permanecen en el documento OpenAPI a menos que agregues también los metadatos, y el enlace de modelo del cuerpo de la solicitud ya ocurrió para cuando el filtro se ejecuta. La [comparación entre filtros de endpoint y middleware](/es/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/) explica ese orden con más detalle. Usa el reemplazo del delegado.

## Opción 3: sombrear la ruta con un endpoint de mayor prioridad

Muchas respuestas en línea sugieren mapear tu propio endpoint en la misma ruta. Mapeado de forma ingenua, con `account.MapPost("/register", () => Results.NotFound())` después de `MapIdentityApi`, no hace nada útil: esperaba una `AmbiguousMatchException`, pero un `POST /account/register` JSON siguió devolviendo 200 desde el manejador de Identity. El endpoint de Identity enlaza un parámetro `[FromBody]`, así que lleva metadatos de accepts `application/json`, y la política de coincidencia de tipo de contenido lo ubica por encima de tu endpoint, que no declara nada. Tu endpoint nunca se ejecuta, sin avisar. Dale un `Order` menor y el matcher lo prefiere antes de que ocurra cualquier desempate:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>();
account.MapPost("/register", () => Results.NotFound())
    .WithOrder(-1)
    .ExcludeFromDescription();
```

Resultado medido: `POST /account/register` devuelve 404, y la lista de endpoints ahora contiene tanto `POST /account/register order=0` como `POST /account/register order=-1`. El endpoint original sigue en el documento OpenAPI, porque `ExcludeFromDescription()` solo se aplica a tu endpoint sombra. Necesitas la opción 1 además para ocultarlo.

Sombrear es la herramienta correcta cuando quieres **reemplazar** un endpoint en lugar de quitarlo, por ejemplo un `/register` que además exija un código de invitación, mientras el resto de `MapIdentityApi` queda tal cual. Para una simple eliminación es la más desordenada de las cuatro opciones.

## Opción 4: quitar endpoints del enrutamiento por completo

Para que un endpoint realmente no exista (sin ruta, sin entrada en OpenAPI, sin 401 para llamadores anónimos, solo el mismo 404 que cualquier URL desconocida), tienes que impedir que su `RouteEndpoint` llegue al sistema de enrutamiento. `MapIdentityApi` solo usa dos miembros del `IEndpointRouteBuilder` que le pasas: `ServiceProvider`, para resolver sus servicios, y `DataSources`, al que `MapGroup("")` agrega su origen de endpoints. Eso te da un punto de apoyo:

1. Pasa a `MapIdentityApi` un pequeño `IEndpointRouteBuilder` propio cuya colección `DataSources` sea privada.
2. Envuelve esa colección privada en un `EndpointDataSource` que descarte los endpoints que no quieres.
3. Agrega el envoltorio a los `DataSources` del constructor de rutas real.

```csharp
// .NET 11 RC 1, works the same on .NET 8, 9 and 10
using Microsoft.Extensions.Primitives;

static class IdentityApiExceptExtensions
{
    public static IEndpointConventionBuilder MapIdentityApiExcept<TUser>(
        this IEndpointRouteBuilder endpoints, params string[] excludedRoutes)
        where TUser : class, new()
    {
        var capture = new CapturingRouteBuilder(endpoints);
        var conventions = capture.MapIdentityApi<TUser>();

        bool Keep(Endpoint e) =>
            e is not RouteEndpoint re ||
            !excludedRoutes.Any(r =>
                re.RoutePattern.RawText!.EndsWith(r, StringComparison.OrdinalIgnoreCase));

        endpoints.DataSources.Add(new FilteringEndpointDataSource(capture.DataSources, Keep));
        return conventions;
    }

    private sealed class CapturingRouteBuilder(IEndpointRouteBuilder inner) : IEndpointRouteBuilder
    {
        public ICollection<EndpointDataSource> DataSources { get; } = new List<EndpointDataSource>();
        public IServiceProvider ServiceProvider => inner.ServiceProvider;
        public IApplicationBuilder CreateApplicationBuilder() => inner.CreateApplicationBuilder();
    }

    private sealed class FilteringEndpointDataSource(
        ICollection<EndpointDataSource> sources, Func<Endpoint, bool> keep) : EndpointDataSource
    {
        private readonly CompositeEndpointDataSource _inner = new(sources);

        public override IReadOnlyList<Endpoint> Endpoints =>
            _inner.Endpoints.Where(keep).ToList();

        public override IReadOnlyList<Endpoint> GetGroupedEndpoints(RouteGroupContext context) =>
            _inner.GetGroupedEndpoints(context).Where(keep).ToList();

        public override IChangeToken GetChangeToken() => _inner.GetChangeToken();
    }
}
```

El uso es un cambio de una línea:

```csharp
// .NET 11 RC 1
var account = app.MapGroup("/account");
account.MapIdentityApiExcept<IdentityUser>("/register", "/manage/2fa");
```

Resultado medido: la lista de endpoints tiene ocho entradas en lugar de diez, `/openapi/v1.json` lista ocho rutas, y tanto `POST /account/register` como un `POST /account/manage/2fa` anónimo devuelven 404. Los otros ocho endpoints funcionan como antes, y el constructor de convenciones devuelto sigue aplicándose a ellos, así que `.RequireRateLimiting(...)` o `.WithTags(...)` encadenados sobre el resultado se comportan como siempre.

Dos partes de ese código son fáciles de equivocar:

- **Sobrescribe `GetGroupedEndpoints`.** Cuando llamas a la extensión sobre un grupo como `account`, el grupo externo no lee `Endpoints`. Llama a `GetGroupedEndpoints` con el prefijo y las convenciones del grupo. Delegar esa llamada a los orígenes internos permite que construyan cada endpoint una sola vez con el prefijo completo y todas las convenciones aplicadas, en lugar de depender de que la clase base vuelva a envolver endpoints que ya se construyeron sin el prefijo. También es la razón por la que `RawText` ya lleva `/account` cuando se ejecuta `Keep`.
- **Pasa el token de cambio.** Los endpoints de Identity son estáticos, pero devolver un token real del compuesto interno mantiene el origen de datos correcto si algo más llega a agregar endpoints a la colección capturada.

Esto depende de que `MapIdentityApi` use solo `ServiceProvider` y `DataSources`. Eso es cierto en cada versión desde la 8.0 hasta la 11 RC 2, pero es un detalle de implementación. Una versión futura que, por ejemplo, llamara a `CreateApplicationBuilder()` seguiría funcionando gracias a la delegación de arriba. Una que mapee en algún otro constructor no. Una prueba que verifique la lista de rutas esperada (el volcado de `IEnumerable<EndpointDataSource>` que usé son tres líneas) lo detectará al actualizar.

## La trampa de `/confirmEmail`

El único endpoint que no puedes quitar por sí solo es `GET /confirmEmail`. `/register`, `/resendConfirmationEmail` y la rama de cambio de correo de `POST /manage/info` generan el enlace de confirmación por nombre de endpoint, con `LinkGenerator.GetUriByName`. El nombre se asigna en una convención `Finally` sobre `/confirmEmail`, como `MapIdentityApi-` seguido del patrón de ruta final.

Con la opción 4 y `MapIdentityApiExcept<IdentityUser>("/confirmEmail")`, la convención se ejecuta de todos modos (el endpoint se construye y luego se filtra), así que el nombre se asigna, pero el generador de enlaces no encuentra ningún endpoint con ese nombre. El registro entonces falla:

```text
System.NotSupportedException: Could not find endpoint named 'MapIdentityApi-/account/confirmEmail'.
```

Resultado medido: `POST /account/register` devuelve **500** y también `POST /account/resendConfirmationEmail`, mientras `/login` sigue funcionando. Si no quieres confirmación de correo a través de esta API en absoluto, quita `/register` y `/resendConfirmationEmail` junto con `/confirmEmail`, o mantén `/confirmEmail` enrutado y solo ocúltalo de OpenAPI con la opción 1.

La opción 2 no tiene este problema, porque el endpoint sigue existiendo para la generación de enlaces. Simplemente responde 404.

## Qué opción usar

- **El endpoint está bien, solo no debería estar en el documento publicado:** opción 1.
- **El endpoint no debe funcionar, y un 401 para llamadores anónimos en `/manage/*` es aceptable:** opción 2 con el reemplazo del delegado en `Finally`. Son pocas líneas y no depende de los internos de Identity.
- **El endpoint no debe existir en absoluto:** opción 4.
- **Necesitas una implementación distinta de un endpoint:** opción 3, más la opción 1 para ocultar el original.
- **Necesitas cambiar el comportamiento dentro de varios endpoints** (campos de registro adicionales, inicio de sesión con nombre de usuario, respuestas de token distintas): copia [`IdentityApiEndpointRouteBuilderExtensions.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs) en tu proyecto y edítalo. Tiene licencia MIT, unas 490 líneas, y los DTO de solicitud y respuesta que usa (`RegisterRequest`, `LoginRequest`, `AccessTokenResponse` y así sucesivamente) son tipos públicos en `Microsoft.AspNetCore.Identity.Data`. Pierdes las correcciones automáticas de futuras actualizaciones del framework, así que revisa el historial del archivo cuando actualices.

Si ya estás en el punto de reemplazar varios endpoints, compara primero las ventajas y desventajas en [JWT vs autenticación con cookies en ASP.NET Core 11](/es/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/). Los tokens bearer que emite `MapIdentityApi` son tokens opacos de Data Protection, no JWT, y con frecuencia esa es la verdadera razón por la que un equipo supera estos endpoints.

## Detalles a tener en cuenta

- **Identifica la ruta completa, o usa `EndsWith` con cuidado.** `EndsWith("/info")` coincide tanto con `GET` como con `POST /manage/info`. Si solo quieres bloquear el `POST` (es el que puede cambiar el correo y la contraseña), revisa también `b.Metadata.OfType<HttpMethodMetadata>()` en la convención, o `re.Metadata.GetMetadata<HttpMethodMetadata>()` en la opción 4.
- **`/login` y `/refresh` van juntos.** Quitar `/refresh` y mantener `/login` deja a los clientes con un `refreshToken` que nunca podrán usar. La [guía de refresh tokens](/es/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) cubre qué valida realmente `/refresh`.
- **Quitar `/register` no impide la creación de cuentas.** `UserManager<TUser>.CreateAsync` sigue disponible para tu propio código, y los flujos de inicio de sesión externo aún pueden crear usuarios. Bloquear el endpoint solo elimina la ruta pública y anónima de registro.
- **No recurras primero a un middleware basado en rutas.** Un middleware que devuelve 404 para rutas que empiezan con `/account/register` funciona, pero fija el prefijo del grupo en el código, se ejecuta en cada solicitud de la aplicación y deja la entrada de OpenAPI en su lugar. Las convenciones de endpoint conocen el patrón final y se ejecutan una sola vez, cuando se construyen los endpoints.
- **Monta Identity en su propio grupo.** Llamar a `MapIdentityApi` directamente sobre `app` coloca `/login` y `/register` en la raíz de tu API. Un grupo dedicado, como se describe en [organizar endpoints de minimal API con `MapGroup`](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/), también te permite aplicar límite de tasa y etiquetas solo a Identity.

## Relacionado

- [Cómo implementar refresh tokens en ASP.NET Core Identity](/es/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/), incluido cuándo `MapIdentityApi` deja de ser suficiente.
- [Cómo organizar endpoints de minimal API con `MapGroup` en ASP.NET Core 11](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Cómo personalizar OpenAPI con transformadores de operación y de esquema en ASP.NET Core 11](/es/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Filtros de endpoint vs middleware en ASP.NET Core 11](/es/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/)
- [JWT vs autenticación con cookies en ASP.NET Core 11](/es/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/)

## Fuentes

- [`IdentityApiEndpointRouteBuilderExtensions.cs` en `v11.0.0-rc.2.26504.105`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.2.26504.105/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs), dotnet/aspnetcore.
- [dotnet/aspnetcore#55792: Split MapIdentityApi<TUser>() into multiple APIs and allow selective end points to be enabled](https://github.com/dotnet/aspnetcore/issues/55792)
- [dotnet/aspnetcore#50303: Extensibility for Identity Endpoints](https://github.com/dotnet/aspnetcore/issues/50303)
- [Use Identity to secure a Web API backend for SPAs](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/identity-api-authorization), Microsoft Learn.
- [Route groups and endpoint conventions in minimal APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers#route-groups), Microsoft Learn.
- [`EndpointDataSource` class](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.routing.endpointdatasource), Microsoft Learn.
