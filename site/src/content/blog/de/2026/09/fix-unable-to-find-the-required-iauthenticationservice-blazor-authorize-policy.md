---
title: "Lösung: Unable to find the required 'IAuthenticationService' service mit [Authorize(Policy = ...)] in Blazor"
description: "Eine Seite einer Blazor Web App mit [Authorize] wird zu einem Endpunkt, den die AuthorizationMiddleware prüft, und eine fehlgeschlagene Prüfung ruft ChallengeAsync auf, was AddAuthentication voraussetzt. Registrieren Sie ein echtes Schema oder lassen Sie Komponenten-Endpunkte bis zu AuthorizeRouteView durch."
pubDate: 2026-09-24
template: error-page
tags:
  - "errors"
  - "blazor"
  - "aspnetcore"
  - "dotnet-10"
  - "authorization"
lang: "de"
translationOf: "2026/09/fix-unable-to-find-the-required-iauthenticationservice-blazor-authorize-policy"
translatedBy: "claude"
translationDate: 2026-09-24
---

`Unable to find the required 'IAuthenticationService' service` auf einer Blazor-Seite mit `@attribute [Authorize(Policy = "...")]` bedeutet, dass die ASP.NET Core `AuthorizationMiddleware` Ihre Policy für die HTTP-Anfrage ausgewertet hat, die Prüfung fehlgeschlagen ist und sie versucht hat, `HttpContext.ChallengeAsync()` aufzurufen, ohne dass Authentifizierungsdienste registriert sind. Die eigentliche Lösung ist `builder.Services.AddAuthentication(...)` mit einem Schema (meist Cookies), damit eine Challenge ein Ziel hat. Wenn Ihre App ausschließlich über einen eigenen `AuthenticationStateProvider` authentifiziert, registrieren Sie einen `IAuthorizationMiddlewareResultHandler`, der Razor-Komponenten-Endpunkte durchlässt, und überlassen Sie die Durchsetzung der Policy `AuthorizeRouteView`.

Alles Folgende wurde auf .NET 10.0.10 (SDK 10.0.302) und .NET 11 RC 1 (SDK 11.0.100-rc.1.26425.128) mit dem unveränderten Template `dotnet new blazor -int Server` reproduziert. Beide Laufzeiten lieferten in jedem Szenario identische Ergebnisse.

## Der Fehler im Kontext

Der Browser erhält bei der ersten Anfrage an die geschützte Seite einen 500er. Das Log zeigt, dass die Challenge von der Autorisierungs-Middleware kommt, nicht von Blazor:

```text
fail: Microsoft.AspNetCore.Diagnostics.DeveloperExceptionPageMiddleware[1]
      An unhandled exception has occurred while executing the request.
      System.InvalidOperationException: Unable to find the required 'IAuthenticationService' service. Please add all the required services by calling 'IServiceCollection.AddAuthentication' in the application startup code.
         at Microsoft.AspNetCore.Authentication.AuthenticationHttpContextExtensions.GetAuthenticationService(HttpContext context)
         at Microsoft.AspNetCore.Authentication.AuthenticationHttpContextExtensions.ChallengeAsync(HttpContext context)
         at Microsoft.AspNetCore.Authorization.Policy.AuthorizationMiddlewareResultHandler.<>c__DisplayClass0_0.<<HandleAsync>g__Handle|0>d.MoveNext()
      --- End of stack trace from previous location ---
         at Microsoft.AspNetCore.Authorization.AuthorizationMiddleware.Invoke(HttpContext context)
         at Microsoft.AspNetCore.Diagnostics.DeveloperExceptionPageMiddlewareImpl.Invoke(HttpContext context)
```

Das typische Muster, das Leute zu Stack Overflow und zu [dotnet/aspnetcore#55678](https://github.com/dotnet/aspnetcore/issues/55678) führt: Die Navigation zur Seite innerhalb der App funktioniert, aber ein Neuladen, ein Lesezeichen oder das Öffnen als erste Seite einer Sitzung stürzt ab.

## Warum das passiert

Drei Bausteine von ASP.NET Core greifen ineinander und erzeugen die Exception.

1. **Eine routbare Komponente ist ein HTTP-Endpunkt.** Seit .NET 8 erzeugt `MapRazorComponents<App>()` einen Endpunkt pro `@page`. `RazorComponentEndpointFactory` kopiert jedes Attribut des Komponententyps in die Endpunkt-Metadaten, einschließlich `[Authorize]` (siehe den Kommentar "All attributes defined for the type are included as metadata" im Quellcode).
2. **`UseAuthorization()` wird automatisch hinzugefügt.** `WebApplicationBuilder` fügt die Autorisierungs-Middleware automatisch ein, sobald `IAuthorizationHandlerProvider` registriert ist, und `AddAuthorizationCore()` registriert ihn. Sie müssen `app.UseAuthorization()` nicht aufrufen, um betroffen zu sein; meine Reproduktion ruft es nie auf.
3. **Eine fehlgeschlagene Policy wird zu einer Challenge.** Der Standard-`AuthorizationMiddlewareResultHandler` ruft `context.ChallengeAsync()` für einen anonymen Benutzer auf und `context.ForbidAsync()` für einen authentifizierten, der die Policy nicht erfüllt. Beide benötigen `IAuthenticationService`, den nur `AddAuthentication()` registriert.

Die Middleware prüft Ihre Policy also gegen `HttpContext.User`. Ihr eigener `AuthenticationStateProvider` wird auf diesem Weg überhaupt nicht gefragt, weshalb der nächste Punkt viele überrascht: **Der Fehler tritt auch bei Benutzern auf, die Ihr Provider als angemeldet betrachtet**. In meiner Reproduktion bekam ein Provider, der einen Principal mit der Rolle `Admin` zurückgibt, auf `/admin` trotzdem einen 500er, weil `HttpContext.User` anonym war.

Clientseitige Navigation innerhalb eines interaktiven Circuits löst nie eine HTTP-Anfrage aus, daher sieht die Middleware sie nie. Dort wertet stattdessen `AuthorizeRouteView` `[Authorize]` aus, und zwar mit dem `AuthenticationStateProvider`. Das ist die ganze Erklärung für "funktioniert, wenn ich auf den Link klicke, stürzt bei F5 ab".

In .NET 7 Blazor Server funktionierte das, weil `_Host.cshtml` der einzige Endpunkt war und Komponenten nie einzeln gemappt wurden. Die [Migration zu einer Blazor Web App](/de/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) ist genau der Moment, in dem die meisten diesem Fehler begegnen.

## Minimale Reproduktion

Eine Blazor Web App, die sich gegen eine externe API authentifiziert und das Ergebnis nur über einen eigenen `AuthenticationStateProvider` bereitstellt, ohne ASP.NET Core Authentifizierungsschema:

```csharp
// .NET 10.0.10 / .NET 11 RC 1, Program.cs
using System.Security.Claims;
using AuthRepro.Components;
using Microsoft.AspNetCore.Components.Authorization;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddRazorComponents().AddInteractiveServerComponents();
builder.Services.AddCascadingAuthenticationState();
builder.Services.AddScoped<AuthenticationStateProvider, ApiTokenAuthStateProvider>();
builder.Services.AddAuthorizationCore(o =>
    o.AddPolicy("Admins", p => p.RequireRole("Admin")));

var app = builder.Build();
app.UseAntiforgery();
app.MapStaticAssets();
app.MapRazorComponents<App>().AddInteractiveServerRenderMode();
app.Run();

class ApiTokenAuthStateProvider : AuthenticationStateProvider
{
    public override Task<AuthenticationState> GetAuthenticationStateAsync() =>
        Task.FromResult(new AuthenticationState(new ClaimsPrincipal(new ClaimsIdentity())));
}
```

```razor
@* .NET 10 / 11, Components/Pages/Admin.razor *@
@page "/admin"
@attribute [Authorize(Policy = "Admins")]
<h1>Admin area</h1>
```

`Routes.razor` verwendet `<AuthorizeRouteView>` mit einem `<NotAuthorized>`-Block. Ein curl gegen die laufende App ergibt:

| Anfrage | Ergebnis |
| --- | --- |
| `GET /` | 200 |
| `GET /admin` | 500, `IAuthenticationService`-Exception |
| `GET /admin`, Provider liefert einen Admin | 500, dieselbe Exception |

## Lösung 1: ein echtes Authentifizierungsschema registrieren (empfohlen)

Wenn sich Benutzer überhaupt bei Ihrer App anmelden, geben Sie ASP.NET Core ein Schema, das bei der HTTP-Anfrage weiß, wer sie sind. Für eine serverseitig gerenderte Blazor-App sind das fast immer Cookies:

```csharp
// .NET 10 / 11, Program.cs
using Microsoft.AspNetCore.Authentication.Cookies;

builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o =>
    {
        o.LoginPath = "/login";
        o.AccessDeniedPath = "/access-denied";
    });

builder.Services.AddAuthorization(o =>
    o.AddPolicy("Admins", p => p.RequireRole("Admin")));
```

Damit liefert `GET /admin` für einen anonymen Benutzer ein `302` nach `/login?ReturnUrl=%2Fadmin`, statt eine Exception zu werfen. Ein angemeldeter Benutzer ohne die Rolle wird zu `AccessDeniedPath` geschickt.

Zwei weitere Schritte machen das korrekt, statt es nur zum Schweigen zu bringen:

- **Mit dem Cookie anmelden.** Wenn Ihr Login-Ablauf eine externe API aufruft und ein Token zurückbekommt, schließen Sie ihn mit `HttpContext.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, principal)` ab, aus einer statischen SSR-Seite oder einem Minimal-API-Endpunkt, mit den Claims, die Sie brauchen (Rollen, Benutzer-ID). Das API-Token können Sie in den `AuthenticationProperties` des Cookies ablegen, falls spätere Aufrufe es benötigen.
- **Den eigenen `AuthenticationStateProvider` entfernen, wenn er nur diese Arbeit doppelt erledigt hat.** Der eingebaute `ServerAuthenticationStateProvider` von Blazor liest `HttpContext.User` während des Prerenderings und reicht ihn in den Circuit weiter, sodass Seiten, `AuthorizeView` und die Middleware sich einig sind, wer der Benutzer ist.

Wenn Sie unsicher sind, ob Cookies oder Tokens zu Ihrer App passen, erläutert [JWT vs. Cookie-Authentifizierung in ASP.NET Core](/de/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) die Abwägung. Für eine Blazor Web App, die ihre eigene UI ausliefert, gewinnen Cookies fast immer.

Ein Detail, das man kennen sollte: Seit .NET 7 wird ein Schema automatisch zum Standard, wenn genau eines registriert ist. `AddAuthentication().AddCookie()` ohne Standardschema-Argument funktionierte in meiner Reproduktion ebenfalls und leitete zum Standardpfad `/Account/Login` des Cookie-Handlers um. Sobald Sie ein zweites Schema hinzufügen (OpenID Connect, JWT Bearer), benennen Sie die Standards explizit, sonst tauschen Sie diesen Fehler gegen `No authenticationScheme was specified, and there was no DefaultChallengeScheme found`.

## Lösung 2: Komponenten-Endpunkte bis zu AuthorizeRouteView durchlassen

Manche Apps haben tatsächlich keine Identität auf HTTP-Ebene: Die Blazor-Server-App ruft eine separate Web API auf, hält das Token im Circuit-Zustand und stellt den Benutzer nur über einen eigenen `AuthenticationStateProvider` bereit. Ein Cookie-Schema hinzuzufügen hieße dort, den Login-Ablauf neu zu bauen. Die Alternative ist, zu ändern, was die Autorisierungs-Middleware bei einer fehlgeschlagenen Policy tut, über den dokumentierten Erweiterungspunkt [`IAuthorizationMiddlewareResultHandler`](https://learn.microsoft.com/aspnet/core/security/authorization/customizingauthorizationmiddlewareresponse):

```csharp
// .NET 10 / 11, Program.cs
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Policy;
using Microsoft.AspNetCore.Components.Endpoints;

builder.Services.AddSingleton<IAuthorizationMiddlewareResultHandler,
    BlazorAuthorizationMiddlewareResultHandler>();

sealed class BlazorAuthorizationMiddlewareResultHandler : IAuthorizationMiddlewareResultHandler
{
    private readonly AuthorizationMiddlewareResultHandler _default = new();

    public Task HandleAsync(RequestDelegate next, HttpContext context,
        AuthorizationPolicy policy, PolicyAuthorizationResult authorizeResult)
    {
        // Razor component pages: let the request through. AuthorizeRouteView
        // re-checks [Authorize] against the AuthenticationStateProvider.
        if (context.GetEndpoint()?.Metadata.GetMetadata<ComponentTypeMetadata>() is not null)
            return next(context);

        return _default.HandleAsync(next, context, policy, authorizeResult);
    }
}
```

`ComponentTypeMetadata` (öffentlich, in `Microsoft.AspNetCore.Components.Endpoints`) hängt an jedem Endpunkt, den `MapRazorComponents` erzeugt, daher gilt das Durchlassen nur für Seiten. Alles andere behält das Standardverhalten.

Gemessene Ergebnisse mit diesem Handler und ohne Aufruf von `AddAuthentication()`:

| Anfrage | Benutzer laut Provider | Ergebnis |
| --- | --- | --- |
| `GET /admin` | anonym | 200, `<NotAuthorized>`-Inhalt gerendert |
| `GET /admin` | hat die Rolle `Admin` | 200, Seite gerendert |
| `GET /api/secret` (`RequireAuthorization("Admins")`) | beide | 500, `IAuthenticationService`-Exception |

Machen Sie sich klar, worauf Sie sich mit dieser Lösung einlassen:

- **Die Seite wird von `AuthorizeRouteView` geschützt, nicht von der Middleware.** Sie rendert `<NotAuthorized>` statt der Seite, während des Prerenderings und im Circuit. Ihre `Routes.razor` muss `AuthorizeRouteView` verwenden (das einfache `RouteView` ignoriert `[Authorize]`), und der `<NotAuthorized>`-Inhalt ist das, was anonyme Benutzer sehen, also gehört dort ein Login-Link hin.
- **Die Antwort ist 200, nicht 401 oder 302.** Crawler und Uptime-Monitore sehen eine erfolgreiche Seite. Wenn Sie eine Umleitung brauchen, lösen Sie sie aus dem `<NotAuthorized>`-Block mit `NavigationManager.NavigateTo("/login")` aus, oder verwenden Sie Lösung 1.
- **Endpunkte, die keine Komponenten sind, brauchen weiterhin Lösung 1.** Die letzte Tabellenzeile ist Absicht: Eine Minimal API oder ein Controller hinter einer Policy hat kein `AuthorizeRouteView` als Rückfallebene. Wenn Sie solche haben, brauchen Sie ohnehin ein echtes Schema.

"Beheben" Sie das nicht, indem Sie einen wirkungslosen Authentifizierungs-Handler registrieren, dessen Challenge nichts tut. Die Middleware bricht nach einer Challenge ab, sodass Benutzer eine leere 200-Seite ohne Erklärung bekommen, was schlimmer ist als die Exception.

## Lösung 3: die Prüfung in die Komponente verlagern

Wenn nur ein Abschnitt einer Seite eingeschränkt ist, ist das Attribut das falsche Werkzeug. Entfernen Sie `@attribute [Authorize(...)]` und umschließen Sie das geschützte Markup:

```razor
@* .NET 10 / 11 *@
@page "/admin"

<AuthorizeView Policy="Admins">
    <Authorized><h1>Admin area</h1></Authorized>
    <NotAuthorized><p>You need the Admin role.</p></NotAuthorized>
</AuthorizeView>
```

Keine Endpunkt-Metadaten, keine Prüfung durch die Middleware, keine Exception: In derselben Reproduktion (weiterhin ohne `AddAuthentication()`) lieferte diese Seite 200 mit dem `<NotAuthorized>`-Inhalt für einen anonymen Benutzer und das Admin-Markup für einen Admin. Das deckt sich mit der Beobachtung des Melders in #55678, dass `<AuthorizeView>` auf der ersten Seite nie fehlschlug. Für das Ein- und Ausblenden von UI ist das in Ordnung, aber denken Sie daran, dass alles serverseitig Gerenderte trotzdem an Benutzer gesendet wird, die die Prüfung bestehen. Der Datenzugriff in der Komponente sollte daher ebenfalls die Autorisierung prüfen, nicht nur das Markup.

## Stolperfallen und ähnliche Fehler

**Eine `FallbackPolicy` bricht jede Seite, auch die Startseite.** `AddAuthorization(o => o.FallbackPolicy = ...RequireAuthenticatedUser()...)` gilt für jeden Endpunkt ohne eigene Autorisierungs-Metadaten. In meiner Reproduktion ging `GET /` mit derselben Exception von 200 auf 500. Klassische Blazor-Server-Apps, die noch `_Host.cshtml` und `MapBlazorHub()` verwenden, treffen auf diesem Weg auf den Fehler (oder über `MapBlazorHub().RequireAuthorization()`), da ihre Komponenten keine einzelnen Endpunkte sind.

**`AddAuthorizationCore()` vs. `AddAuthorization()` ist nicht die Ursache.** Beide registrieren den Handler-Provider, der `WebApplicationBuilder` dazu bringt, `UseAuthorization()` einzufügen. Ein Wechsel zwischen ihnen ändert hier nichts.

**Eigenständiges Blazor WebAssembly zeigt diesen Fehler nie.** Auf dem Client gibt es keine ASP.NET Core Pipeline. Wenn eine WebAssembly-App den Benutzer nach der Anmeldung für anonym hält, ist das ein anderes Problem, behandelt in [IsAuthenticated ist nach einem MSAL-Upgrade false](/de/2026/09/fix-isauthenticated-false-remoteuseraccount-null-blazor-webassembly-msal-upgrade/).

**Der Render-Modus spielt keine Rolle.** Die fehlschlagende Anfrage ist der initiale HTTP-GET, der die Seite ausliefert, bevor irgendeine Interaktivität beginnt. Seiten mit Static SSR, Interactive Server, WebAssembly und Auto verhalten sich gleich. Wenn Render-Modi sich noch unscharf anfühlen, erklärt [welcher Render-Modus meine Komponente ausführt](/de/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/), wo jeder einzelne läuft.

**Der Benutzer aus dem `AuthenticationStateProvider` erreicht `HttpContext.User` nicht.** Der Fluss geht nur in die andere Richtung: `ServerAuthenticationStateProvider` liest aus `HttpContext`. Alles, was vor dem Rendern der Komponenten läuft (Middleware, Endpunktfilter, nach Benutzer partitioniertes Rate Limiting), sieht nur, was ein Authentifizierungs-Handler dort hinterlegt hat.

## Verwandte Artikel

- [Eine Blazor-Server-App zu einer Blazor Web App in .NET 11 migrieren](/de/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/), die Migration, bei der dieser Fehler meist auftaucht.
- [JWT vs. Cookie-Authentifizierung in ASP.NET Core 11](/de/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/), zur Wahl des Schemas in Lösung 1.
- [Was ist ein Blazor-Render-Modus und welcher führt meine Komponente aus?](/de/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/)
- [Lösung: JavaScript interop calls cannot be issued at this time beim Blazor-Prerendering](/de/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/), ein weiterer Fehler, der nur bei der ersten HTTP-Anfrage auftritt.

## Quellen

- [dotnet/aspnetcore#55678](https://github.com/dotnet/aspnetcore/issues/55678), "Exception triggered by AuthorizeAttribute on the first page loaded in a circuit", und [#53732](https://github.com/dotnet/aspnetcore/issues/53732) zu `AddAuthorizationCore` ohne Authentifizierung in .NET 8 Blazor Web Apps.
- [`RazorComponentEndpointFactory.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Components/Endpoints/src/Builder/RazorComponentEndpointFactory.cs) und [`ComponentTypeMetadata.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Components/Endpoints/src/Builder/ComponentTypeMetadata.cs) am Tag `v10.0.0`.
- [`WebApplicationBuilder.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/DefaultBuilder/src/WebApplicationBuilder.cs) (automatisches `UseAuthentication` / `UseAuthorization`) und [`AuthorizationMiddlewareResultHandler.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Security/Authorization/Policy/src/AuthorizationMiddlewareResultHandler.cs).
- [Customize the behavior of AuthorizationMiddleware](https://learn.microsoft.com/aspnet/core/security/authorization/customizingauthorizationmiddlewareresponse) und [ASP.NET Core Blazor authentication and authorization](https://learn.microsoft.com/aspnet/core/blazor/security/) auf Microsoft Learn.
- [Authentication uses single scheme as DefaultScheme](https://learn.microsoft.com/aspnet/core/release-notes/aspnetcore-7.0#authentication-uses-single-scheme-as-defaultscheme) in What's new in ASP.NET Core 7.0.
