---
title: "JWT vs. autenticación por cookies en ASP.NET Core 11: ¿cuál deberías elegir?"
description: "Usa autenticación por cookies para cualquier app donde el navegador sea el único cliente, y reserva los tokens bearer JWT para APIs llamadas por apps móviles, otros servicios o terceros. Aquí tienes la matriz de decisión completa."
pubDate: 2026-06-26
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet"
  - "authentication"
  - "security"
lang: "es"
translationOf: "2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-26
---

Si lo único que llama a tu app de ASP.NET Core 11 es un navegador, usa autenticación por cookies. Si quien llama es una app móvil, otro servicio o un cliente de terceros que no puede sostener una cookie, usa tokens bearer JWT. El único eje que lo decide es el cliente: las cookies son un mecanismo de sesión de navegador con revocación del lado del servidor y herramientas de CSRF integradas, mientras que los JWT son una credencial autónoma y sin estado que cualquier cliente HTTP puede transportar, pero que no puedes revocar antes de que expire. Elegir JWT para un sitio renderizado en el servidor o una single-page app del mismo origen es el error de seguridad más común en el ecosistema .NET, porque empuja un token de larga duración a un almacenamiento accesible desde JavaScript sin ningún beneficio. Este post respalda esa recomendación con la matriz de características, el cableado de ambos en .NET 11 y el detalle traicionero que fuerza la decisión.

Todo lo de aquí apunta a .NET 11, ASP.NET Core 11 y C# 14. Ambos esquemas vienen incluidos: la autenticación por cookies vive en `Microsoft.AspNetCore.Authentication.Cookies` y JWT bearer vive en `Microsoft.AspNetCore.Authentication.JwtBearer`, siendo este último la única referencia NuGet que normalmente agregas. Nada del compromiso fundamental cambió en .NET 11, pero el framework te sigue empujando hacia el valor predeterminado correcto: la guía de OAuth para apps basadas en navegador y el patrón Backend-for-Frontend han endurecido ambas el consejo de mantener los tokens completamente fuera del navegador.

## La matriz de características

| Característica                | Autenticación por cookies             | JWT bearer                              |
| ----------------------------- | ------------------------------------- | --------------------------------------- |
| Se transporta en              | encabezado `Cookie` (gestionado por el navegador) | encabezado `Authorization: Bearer`      |
| Estado del servidor           | con estado (el ticket puede revalidarse) | sin estado (claims autónomos)        |
| Revocable antes de expirar    | sí (de inmediato)                     | no (necesita lista de denegación o TTL corto) |
| Establecido automáticamente por el navegador | sí                     | no (el cliente lo adjunta)              |
| Exposición a CSRF             | sí, necesita tokens antifalsificación | no (el encabezado no se envía automáticamente) |
| Exposición a XSS de la credencial | baja (`HttpOnly` lo oculta de JS) | alta si se almacena en almacenamiento legible por JS |
| Funciona para clientes que no son navegador | incómodo                | nativo                                  |
| Entre dominios / multi-API    | doloroso (reglas de alcance de cookies) | fácil (cualquier host valida la firma) |
| Tamaño del payload por solicitud | valor pequeño y opaco tipo id      | token completo, crece con los claims    |
| Integrado en .NET 11          | sí                                    | sí (`AddJwtBearer`)                     |

Las filas que deciden los diseños reales son revocación, CSRF y XSS. Todo lo demás es fontanería.

## Qué es realmente cada esquema

La autenticación por cookies emite un ticket de autenticación cifrado después del inicio de sesión y lo almacena en una cookie que la capa de Data Protection de ASP.NET Core firma y cifra. El navegador adjunta esa cookie a cada solicitud del mismo sitio automáticamente. El servidor la descifra, reconstruye el `ClaimsPrincipal` y puede ejecutar `OnValidatePrincipal` en cada solicitud para volver a verificar al usuario contra la base de datos, que es como revocas una sesión en el instante en que un usuario es deshabilitado.

```csharp
// .NET 11, C# 14
builder.Services
    .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Cookie.HttpOnly = true;                 // hidden from document.cookie
        options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
        options.Cookie.SameSite = SameSiteMode.Strict;  // blocks most CSRF by default
        options.ExpireTimeSpan = TimeSpan.FromHours(8);
        options.SlidingExpiration = true;
        options.LoginPath = "/login";
    });
```

La propiedad que la define es que el valor de la cookie es opaco para JavaScript cuando `HttpOnly` está activado, y el servidor mantiene suficiente contexto (las claves de Data Protection, opcionalmente un almacén de respaldo) para invalidarla. El costo es que, como el navegador envía la cookie automáticamente en solicitudes entre sitios, heredas CSRF y debes defenderte de él con tokens antifalsificación.

La autenticación JWT bearer valida un token autónomo en el encabezado `Authorization`. El token es un blob de claims firmado (y opcionalmente cifrado). No hay sesión del lado del servidor: la validación es pura matemática de firma más claims, así que cualquier cantidad de servicios puede aceptar el mismo token con solo conocer la clave de firma o la clave pública del emisor. El cliente es responsable de almacenar el token y adjuntarlo a cada solicitud.

```csharp
// .NET 11, C# 14
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";   // for key discovery
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = "https://login.example.com",
            ValidateAudience = true,
            ValidAudience = "my-api",
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true
        };
    });
```

Acertar con esos `TokenValidationParameters` es donde viven la mayoría de los bugs de JWT; si estás depurando un token que el framework rechaza, consulta [cómo validar el emisor, la audiencia y el tiempo de vida de un JWT en ASP.NET Core 11](/es/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). La otra cara es que no puedes des-emitir un token válido: una vez que está firmado y en manos del cliente, se acepta hasta que pase `exp`, sin importar lo que le ocurra a la cuenta del usuario.

## Cuándo elegir autenticación por cookies

- **Apps renderizadas en el servidor: MVC, Razor Pages o Blazor Server en .NET 11.** El navegador es el único cliente, gestiona la cookie por ti, y `HttpOnly` mantiene la credencial fuera del alcance de cualquier script inyectado. No hay token que JavaScript pueda filtrar.
- **Una single-page app del mismo origen que habla con su propio backend.** Este es el caso que la gente más suele hacer mal. Si tu app de React o Angular se sirve desde y llama al mismo origen, una cookie es a la vez más simple y más segura que acuñar un JWT y guardarlo en `localStorage`. La guía del grupo de trabajo de OAuth para apps basadas en navegador dirige explícitamente a las SPA de primera parte hacia un Backend-for-Frontend respaldado por cookies en lugar de tokens en el navegador.
- **Necesitas revocación instantánea.** Deshabilitar a un usuario, rotar una contraseña o forzar un cierre de sesión global debe surtir efecto ahora. Con cookies revalidas el principal por solicitud (`OnValidatePrincipal`) o cambias la clave de Data Protection, y la siguiente solicitud queda sin autenticar. No hay que esperar a que un token expire.
- **Estás usando ASP.NET Core Identity con cuentas locales.** La UI predeterminada de Identity y `SignInManager` se basan en cookies, y ese es el camino soportado de primera parte.

El impuesto que aceptas con las cookies es CSRF. Como el navegador envía la cookie en los envíos de formularios entre sitios, necesitas protección antifalsificación en los endpoints que cambian estado. `SameSite=Strict` o `Lax` bloquea los casos comunes, y los tokens antifalsificación de ASP.NET Core cierran el resto. Si esos tokens dejan de validarse después de una implementación, eso suele ser un problema con el anillo de claves de Data Protection, cubierto en [por qué el token antifalsificación no se pudo descifrar](/es/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/).

## Cuándo elegir JWT bearer

- **Una API REST o gRPC consumida por una app móvil o de escritorio.** Un cliente nativo no tiene un tarro de cookies atado a tu dominio y puede almacenar un token en el keychain del SO o en almacenamiento seguro, que es un hogar más seguro que un navegador. Los tokens bearer son el ajuste natural.
- **Llamadas servicio a servicio y microservicios.** Un token firmado por un proveedor de identidad central puede validarse de forma independiente por una docena de servicios que nunca comparten un almacén de sesión. Este es el escenario donde la ausencia de estado es una característica, no una desventaja.
- **Acceso a APIs de terceros donde no controlas el cliente.** Las APIs públicas, las integraciones con socios y cualquier cosa impulsada por los flujos OAuth 2.0 de client-credentials o authorization-code viven sobre tokens bearer por diseño.
- **Llamadas entre dominios que una cookie no puede alcanzar limpiamente.** Si `app.com` debe llamar a `api.other.com`, el alcance de las cookies te pelea mientras que a un token bearer no le importa el origen. Si enrutas una llamada a una API protegida por JWT desde un navegador en otro origen, la parte difícil suele ser el preflight, no el token; consulta [cómo configurar CORS para una API protegida por JWT en ASP.NET Core 11](/es/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/).

El impuesto que aceptas con los JWT es la revocación. Un token filtrado o robado es válido hasta que expira, así que la mitigación estándar son tokens de acceso de corta duración (5 a 15 minutos) emparejados con tokens de actualización de mayor duración que puedes revocar del lado del servidor. Si estás emitiendo tus propios tokens, no te saltes esa maquinaria; [cómo implementar tokens de actualización en ASP.NET Core Identity](/es/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) recorre las piezas de rotación y revocación.

## Por qué "JWT en localStorage" es el valor predeterminado equivocado para navegadores

La razón por la que esta comparación importa es que el patrón popular de los tutoriales de SPA, acuñar un JWT en el login y guardarlo en `localStorage`, cambia un no-problema por uno real. Una SPA del mismo origen no necesita ausencia de estado; su backend está justo ahí y puede mantener una sesión. Lo que obtiene a cambio del token es una credencial exfiltrable por XSS. Cualquier script que se ejecute en tu página, incluido uno traído a través de una dependencia npm comprometida, puede leer `localStorage`, levantar el token y reproducirlo desde cualquier lugar hasta que expire.

Una cookie con `HttpOnly` no puede ser leída por `document.cookie` en absoluto, así que el mismo XSS que drena un token de `localStorage` no puede robar directamente una cookie. Esa es toda la razón por la que la industria se movió hacia el patrón Backend-for-Frontend: la SPA se autentica contra su propio backend con una cookie segura, `HttpOnly` y `SameSite`, y el backend mantiene cualquier token OAuth ascendente del lado del servidor, sin entregarlos nunca a JavaScript. El borrador actual del IETF para apps basadas en navegador recomienda exactamente esto, y el framework BFF de Duende lo empaqueta para ASP.NET Core. La versión corta: los tokens pertenecen al navegador solo cuando no hay un servidor que los sostenga por ti, lo cual para una app de primera parte nunca ocurre.

## Ejecutar ambos esquemas en una sola app

Elegir un esquema globalmente no significa que solo puedas usar uno. Una forma común del mundo real es un sitio renderizado en el servidor más una API JSON en el mismo host: cookies para las páginas, JWT para la API. Registra ambos y selecciona por endpoint.

```csharp
// .NET 11, C# 14
builder.Services
    .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie()
    .AddJwtBearer();   // second scheme, not the default

// Pages use the default cookie scheme:
app.MapGet("/dashboard", () => Results.Ok("hello"))
   .RequireAuthorization();

// The API explicitly requires the bearer scheme:
app.MapGet("/api/orders", () => Results.Ok(orders))
   .RequireAuthorization(new AuthorizeAttribute
   {
       AuthenticationSchemes = JwtBearerDefaults.AuthenticationScheme
   });
```

El detalle clave: el esquema que pasas primero a `AddAuthentication` es el predeterminado, y cualquier `[Authorize]` sin un esquema explícito lo usa. Los endpoints que deberían aceptar un token bearer deben nombrar `JwtBearerDefaults.AuthenticationScheme` explícitamente, o el framework intentará validar una cookie, no encontrará ninguna y desafiará con una redirección a la página de login en lugar de devolver `401`. Ese desajuste, una API que devuelve una redirección HTML de login en lugar de un `401` limpio, es un síntoma frecuente de un esquema predeterminado mal configurado. Una variante relacionada, donde la API responde `405` en lugar de `401`, y la clase más amplia de problemas de "token válido aún rechazado", valen la pena de conocer antes de que envíes una configuración mixta: consulta [por qué un JWT de ASP.NET Core devuelve 401 incluso con un token válido](/es/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/).

## El detalle traicionero que decide por ti

La latencia de revocación es la función forzante. Hazte una pregunta: cuando el acceso de un usuario debe cortarse, ¿cuánto tiempo puedes tolerar que la credencial vieja siga funcionando?

- Si la respuesta es "cero, debe detenerse de inmediato" (banca, consolas de administración, cualquier cosa donde una cuenta comprometida o despedida sea una amenaza activa), las cookies ganan, porque puedes invalidar la sesión en la siguiente solicitud. Para obtener el mismo comportamiento de los JWT tienes que añadir una lista de denegación del lado del servidor, lo que reintroduce exactamente la búsqueda con estado que adoptaste JWT para evitar.
- Si la respuesta es "unos minutos está bien", los JWT de corta duración con tokens de actualización son aceptables, y conservas la ausencia de estado que los hace atractivos entre servicios.

La segunda función forzante es el cliente. Una cookie es una construcción de navegador. En el momento en que un cliente que no es navegador debe autenticarse, una cookie deja de ser natural y un token bearer se convierte en el transportador obvio. Si tu app tiene ambos tipos de quien llama, eso no es un empate, es una señal para ejecutar ambos esquemas como se mostró arriba, cada uno en los endpoints que le encajan.

## La recomendación, replanteada

Para una app cuyo único cliente es un navegador, incluida una SPA del mismo origen, usa autenticación por cookies: `HttpOnly`, `Secure`, `SameSite`, con antifalsificación en los endpoints que cambian estado. Obtienes una credencial que JavaScript no puede leer y revocación que surte efecto en la siguiente solicitud, y no renuncias a nada que una app web de primera parte realmente necesite. Recurre a JWT bearer cuando quien llama sea una app móvil o de escritorio, otro servicio o un tercero, donde la ausencia de estado es una ventaja genuina y no hay sesión del lado del servidor en la que apoyarse. Cuando existen ambos tipos de cliente, registra ambos esquemas y selecciona por endpoint en lugar de forzar a uno a hacer el trabajo del otro. La decisión no es sobre qué tecnología es más moderna; es sobre quién sostiene la credencial y qué tan rápido necesitas quitársela.

## Relacionados

- [Cómo validar el emisor, la audiencia y el tiempo de vida de un JWT en ASP.NET Core 11](/es/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/)
- [Por qué un JWT de ASP.NET Core devuelve 401 incluso con un token válido](/es/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/)
- [Cómo configurar CORS para una API protegida por JWT en ASP.NET Core 11](/es/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/)
- [Cómo implementar tokens de actualización en ASP.NET Core Identity](/es/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)
- [Por qué el token antifalsificación no se pudo descifrar en ASP.NET Core](/es/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/)

## Fuentes

- [Overview of ASP.NET Core authentication (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/?view=aspnetcore-10.0)
- [Use cookie authentication without ASP.NET Core Identity (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/cookie?view=aspnetcore-10.0)
- [Authentication and authorization in minimal APIs / JWT bearer (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication?view=aspnetcore-10.0)
- [Prevent Cross-Site Request Forgery (XSRF/CSRF) attacks (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/anti-request-forgery?view=aspnetcore-10.0)
- [OAuth 2.0 for Browser-Based Apps (IETF draft)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps)
- [Securing SPAs using the BFF Pattern (Duende Software)](https://duendesoftware.com/blog/20210326-bff)
