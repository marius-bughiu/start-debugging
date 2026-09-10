---
title: "Lösung: IsAuthenticated ist false und RemoteUserAccount ist null in Blazor WebAssembly nach einem MSAL-Upgrade"
description: "Microsoft.Authentication.WebAssembly.Msal 10.0.8, 9.0.16 und 8.0.27 sind auf msal.js 4 umgestiegen, dessen asynchrones init mit sich selbst konkurriert. Initialisieren Sie MSAL einmal in Program.cs oder pinnen Sie 10.0.7."
pubDate: 2026-09-10
template: error-page
tags:
  - "errors"
  - "blazor"
  - "blazor-webassembly"
  - "authentication"
  - "msal"
  - "entra-id"
  - "dotnet-10"
  - "aspnet-core"
lang: "de"
translationOf: "2026/09/fix-isauthenticated-false-remoteuseraccount-null-blazor-webassembly-msal-upgrade"
translatedBy: "claude"
translationDate: 2026-09-10
---

Wenn die Anmeldung in einer Blazor-WebAssembly-App nach dem Wechsel von `Microsoft.Authentication.WebAssembly.Msal` 10.0.7 auf 10.0.8 oder neuer (oder von 9.0.15 auf 9.0.16, oder von 8.0.26 auf 8.0.27) nicht mehr funktioniert, liegt kein Konfigurationsfehler vor. Diese Versionen haben das mitgelieferte msal.js 2.39.0 durch 4.30.0 ersetzt, und das JavaScript-`init` des Pakets kann jetzt zweimal gleichzeitig laufen. Dabei entstehen zwei MSAL-Clients, die sich gegenseitig in die Quere kommen. Die Lösung: MSAL genau einmal initialisieren, bevor die erste Komponente rendert, indem `GetAuthenticationStateAsync()` in `Program.cs` vor `RunAsync()` abgewartet wird. Das Paket auf 10.0.7 zu pinnen funktioniert ebenfalls, aber nur als Übergangslösung. Stand 2026-09-10 ist 10.0.12 das neueste Release, und es ist weiterhin betroffen.

## Der Fehler im Kontext

Dieselbe Regression zeigt sich über verschiedene Symptome, und jedes hat ein eigenes Issue in `dotnet/aspnetcore`. Der ursprüngliche Bericht, [dotnet/aspnetcore#66978](https://github.com/dotnet/aspnetcore/issues/66978), beschreibt eine funktionierende 10.0.7-App, in der nach dem Upgrade auf 10.0.8 ohne weitere Änderung `User.Identity.IsAuthenticated` immer `false` ist und der `RemoteUserAccount`, den eine eigene `AccountClaimsPrincipalFactory.CreateUserAsync` während des Login-Callbacks erhält, `null` ist. In der Konsole steht nur das Autorisierungs-Log:

```
info: Microsoft.AspNetCore.Authorization.DefaultAuthorizationService[2]
      Authorization failed. These requirements were not met:
      DenyAnonymousAuthorizationRequirement: Requires an authenticated user.
```

Der Melder hat danach das entscheidende Experiment gemacht: Die `AuthenticationService.js` aus 10.0.7 in die 10.0.8-App zu kopieren, behob das Problem ohne jede weitere Änderung. Der Bug sitzt in der JavaScript-Schicht.

[dotnet/aspnetcore#68549](https://github.com/dotnet/aspnetcore/issues/68549) zeigt die laute Variante. Unter 10.0.10 schlägt das Neuladen einer authentifizierten Seite in Firefox mit einer Ausnahme fehl, die aus `_content/Microsoft.Authentication.WebAssembly.Msal/AuthenticationService.js` stammt:

```
uninitialized_public_client_application: You must call and await the initialize function before attempting to call any other MSAL API.
```

Edge hat es nicht reproduziert. [dotnet/aspnetcore#68136](https://github.com/dotnet/aspnetcore/issues/68136) ist die leise Variante: Die Anmeldung gelingt, aber `InteractiveRequestOptions.ReturnUrl` wird ignoriert, und jeder Benutzer landet auf `/`. Kommentare in #66978 ergänzen ein hängendes Abmelden unter 10.0.8 bis 10.0.10. Alle vier Symptome haben eine gemeinsame Ursache.

## Was sich in 10.0.8 geändert hat

`Microsoft.Authentication.WebAssembly.Msal` bindet msal.js nicht über ein CDN ein. Das Paket kompiliert `@azure/msal-browser` in das statische Asset `AuthenticationService.js`, das Ihre `index.html` lädt. msal.js 2.x hat sein Lebensende erreicht und wurde von Microsofts Component-Governance-Scan markiert, daher hat [dotnet/aspnetcore#66055](https://github.com/dotnet/aspnetcore/pull/66055) für .NET 11 Preview 4 auf `^4.30.0` umgestellt, und die Änderung wurde in jede unterstützte Linie zurückportiert: [#66094](https://github.com/dotnet/aspnetcore/pull/66094) für 10.0, [#66234](https://github.com/dotnet/aspnetcore/pull/66234) für 9.0 und [#66236](https://github.com/dotnet/aspnetcore/pull/66236) für 8.0. Alle drei Servicing-Releases erschienen am 2026-05-12. Ich habe die ausgelieferten Dateien geprüft, statt den Milestones zu vertrauen: Die `AuthenticationService.js` aus 10.0.7 enthält msal-browser 2.39.0, die aus 10.0.12 enthält 4.30.0.

| Linie | Letzte Version mit msal.js 2 | Erste Version mit msal.js 4 |
| ---- | --------------------------- | ---------------------------- |
| .NET 8 | 8.0.26 | 8.0.27 |
| .NET 9 | 9.0.15 | 9.0.16 |
| .NET 10 | 10.0.7 | 10.0.8 |
| .NET 11 | 11.0.0-preview.3 | 11.0.0-preview.4 (inklusive RC 1) |

## Warum das msal.js-Upgrade die Anmeldung bricht

msal-browser 3.0 brachte eine Änderung, die hier entscheidend ist: Eine `PublicClientApplication` ist nach der Konstruktion nicht mehr sofort nutzbar. Laut dem [Migrationsleitfaden von v2 auf v3](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v2-migration.md) muss zuerst `initialize()` aufgerufen und abgewartet werden. Das Blazor-Paket hat diesen Aufruf an der naheliegenden Stelle ergänzt, mitten in seinem statischen `init`:

```ts
// Microsoft.Authentication.WebAssembly.Msal 10.0.8 through 10.0.12 (msal-browser 4.30.0)
public static async init(settings: AuthorizeServiceConfiguration, jsLoggingOptions: JavaScriptLoggingOptions) {
    if (!AuthenticationService._initialized) {
        AuthenticationService.instance = new MsalAuthorizeService(settings, new Logger(jsLoggingOptions));
        await AuthenticationService.instance.initialize(); // new in 10.0.8
        AuthenticationService.instance.initializeMsalHandler();
        AuthenticationService._initialized = true;
    }
    return Promise.resolve();
}
```

In 10.0.7 gab es die Zeile mit `await` nicht. Zwischen dem Lesen von `_initialized` und dem Setzen lag kein Unterbrechungspunkt, und weil JavaScript auf einem einzigen Thread läuft, war der ganze Block atomar. Ein zweiter Aufruf sah immer `_initialized === true` und tat nichts. Jetzt wird das Flag erst nach einem `await` gesetzt, und ein zweiter Aufruf, der eintrifft, während der erste pausiert, besteht die Prüfung ebenfalls.

Ein solcher zweiter Aufruf kommt tatsächlich, denn die C#-Seite hat seit Jahren dieselbe Struktur. Das ist `RemoteAuthenticationService` in `Microsoft.AspNetCore.Components.WebAssembly.Authentication` 10.0.x:

```csharp
// Microsoft.AspNetCore.Components.WebAssembly.Authentication 10.0.x
private async ValueTask EnsureAuthService()
{
    if (!_initialized)
    {
        await JsRuntime.InvokeVoidAsync("AuthenticationService.init", Options.ProviderOptions, _loggingOptions);
        _initialized = true;
    }
}
```

Jeder Einstiegspunkt ruft die Methode auf: `GetAuthenticationStateAsync`, `RequestAccessToken`, `SignInAsync`, `CompleteSignInAsync`, `SignOutAsync` und `CompleteSignOutAsync`. Starten zwei davon, bevor das erste JS-`init` fertig ist, rufen beide es auf. Solange das JavaScript atomar war, blieb das folgenlos. Mit msal.js 4 erzeugt jeder Aufruf seinen eigenen `MsalAuthorizeService`, jeder ruft `initialize()` und danach `handleRedirectPromise()` auf, und die zweite Zuweisung überschreibt `AuthenticationService.instance`. Von da an sprechen alle statischen Methoden, `getUser`, `completeSignIn` und `signOut`, mit der zuletzt zugewiesenen Instanz. Diese kann noch mitten in der Initialisierung stecken, oder sie ist diejenige, die das Rennen um die Verarbeitung der Redirect-Antwort verloren hat.

Damit sind die Symptome erklärt. Trifft `getUser` auf die zweite Instanz, bevor deren `initialize()` aufgelöst ist, wirft es `uninitialized_public_client_application`. Ob das passiert, hängt von der Reihenfolge der Promises ab, deshalb zeigt Firefox den Fehler und Edge nicht. Blazor legt die Rücksprung-URL in `sessionStorage` ab und löscht sie beim ersten Lesen. Wenn zwei Instanzen denselben Callback verarbeiten, bekommt eine davon keinen Zustand, und `RemoteAuthenticatorView` fällt auf `/` zurück. Diese Diagnose hat ein Kommentator in #68136 gepostet, zusammen mit einem Entwurf für einen Fix, bei dem `init` ein einziges gemeinsames Promise zurückgibt. Und wenn `completeSignIn` die Instanz fragt, die die Antwort nicht verarbeitet hat, kommt kein Konto zurück, `CreateUserAsync` erhält `null`, und der Benutzer bleibt anonym.

## Minimale Reproduktion

Die doppelte Initialisierung lässt sich ohne Entra-Tenant leicht nachweisen. Erstellen Sie die Vorlage mit Platzhalter-IDs, mit dem .NET SDK 10.0.302:

```bash
dotnet new blazorwasm -au SingleOrg --client-id "00001111-aaaa-2222-bbbb-3333cccc4444" --tenant-id "aaaabbbb-0000-cccc-1111-dddd2222eeee" -o MsalRepro
```

Setzen Sie alle drei Paketreferenzen auf 10.0.12. Die reine Vorlage zeigt die Race Condition nicht: `AuthorizeRouteView` wartet auf den Authentifizierungszustand, bevor es `RemoteAuthenticatorView` rendert, also ist das erste `init` fertig, wenn irgendetwas anderes fragt. Echte Apps bleiben selten so einfach. Es genügt irgendetwas außerhalb der Autorisierungsschranke, das beim Start die Authentifizierung berührt, etwa eine Layout-Komponente, die Daten über den autorisierten `HttpClient` lädt. `AuthorizeRouteView` rendert das Layout, während es noch autorisiert, also läuft das parallel zum ersten `GetAuthenticationStateAsync`:

```razor
@* Layout/NavMenu.razor, .NET 10, Microsoft.Authentication.WebAssembly.Msal 10.0.12 *@
@using Microsoft.AspNetCore.Components.WebAssembly.Authentication
@inject IAccessTokenProvider TokenProvider

@code {
    protected override async Task OnInitializedAsync()
    {
        // Same effect as any startup call through the authorized HttpClient.
        await TokenProvider.RequestAccessToken();
    }
}
```

Um zu zählen, was passiert, laden Sie direkt nach `AuthenticationService.js` ein kleines Diagnoseskript, das `init` umhüllt und die Zuweisungen an `AuthenticationService.instance` beobachtet:

```js
// wwwroot/probe.js, diagnostic only. Load after AuthenticationService.js.
(() => {
  const svc = window.AuthenticationService;
  const probe = window.__probe = { initCalls: 0, instances: 0 };
  let current;
  Object.defineProperty(svc, 'instance', {
    configurable: true,
    get: () => current,
    set: v => { probe.instances++; current = v; }
  });
  const init = svc.init;
  svc.init = function (...args) { probe.initCalls++; return init.apply(svc, args); };
})();
```

Ich habe `/` und `/authentication/login-callback` in einem Chromium-basierten Browser geladen und nach dem Start `window.__probe` ausgelesen. Beide Routen lieferten dieselben Zahlen:

| Aufbau | `init`-Aufrufe | Erzeugte MSAL-Instanzen |
| ----- | ------------ | ---------------------- |
| Msal 10.0.12 | 2 | 2 |
| Msal 10.0.7 (msal.js 2.39.0) | 2 | 1 |
| Msal 10.0.12 + Vorinitialisierung in `Program.cs` (Lösung 1) | 1 | 1 |
| Msal 10.0.12 + idempotenter `init`-Shim (Lösung 2) | 2 | 1 |

Aufschlussreich ist die Zeile für 10.0.7: Den doppelten Aufruf aus C# gab es schon immer, und das synchrone `init` von msal.js 2 hat ihn abgefangen. Ohne eine wegwerfbare Entra-App-Registrierung konnte ich keine echte Anmeldung durch den defekten Build führen, daher stammt die Zuordnung der zweiten Instanz zu den einzelnen Symptomen aus dem Code und den oben genannten Issue-Threads. Die doppelte Instanz selbst ist gemessen.

## Die Lösung im Detail

### 1. MSAL einmal in Program.cs initialisieren

Rufen Sie den Authentication-State-Provider einmal auf, nach `Build()` und vor `RunAsync()`:

```csharp
// .NET 10, Microsoft.Authentication.WebAssembly.Msal 10.0.12
using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using MsalRepro;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(sp => new HttpClient { BaseAddress = new Uri(builder.HostEnvironment.BaseAddress) });

builder.Services.AddMsalAuthentication(options =>
{
    builder.Configuration.Bind("AzureAd", options.ProviderOptions.Authentication);
});

var host = builder.Build();

// Run AuthenticationService.init to completion before any component can race it.
await host.Services.GetRequiredService<AuthenticationStateProvider>().GetAuthenticationStateAsync();

await host.RunAsync();
```

Zu diesem Zeitpunkt existiert noch keine Komponente, also kann sich nichts mit dem Aufruf überschneiden. `EnsureAuthService` läuft vollständig durch, setzt das `_initialized`-Flag in C# und das in JavaScript, und jeder spätere Aufruf überspringt `init` komplett. JavaScript-Interop steht in einem WebAssembly-Host schon vor `RunAsync` zur Verfügung, und in meiner Reproduktion sank die Zählung damit auf einen `init`-Aufruf und eine Instanz auf beiden Routen.

Der Preis: Das erste Rendern wartet, bis MSAL initialisiert ist und seinen Cache gelesen hat, Arbeit, die die App ohnehin ein paar Millisekunden später erledigt hätte. Ruft Ihre `AccountClaimsPrincipalFactory` in `CreateUserAsync` Microsoft Graph oder Ihre eigene API auf, rückt auch dieser Aufruf vor das erste Rendern. Halten Sie ihn schlank oder nehmen Sie einen etwas späteren ersten Paint in Kauf.

### 2. Oder init in JavaScript idempotent machen

Wenn Sie den Start nicht kontrollieren, etwa weil eine gemeinsam genutzte Komponentenbibliothek Token-Anfragen auslöst, die nicht von Ihnen stammen, beheben Sie die Race Condition dort, wo sie entsteht: in `init`. Dieser Shim merkt sich das Promise, und genau das macht auch der Fix-Entwurf aus #68136 innerhalb des Pakets:

```js
// wwwroot/msal-init-fix.js
// Workaround for dotnet/aspnetcore#66978, #68549, #68136
// (Microsoft.Authentication.WebAssembly.Msal 8.0.27+, 9.0.16+, 10.0.8+).
(() => {
  const svc = window.AuthenticationService;
  if (!svc || svc.__initFixApplied) return;
  const originalInit = svc.init;
  let pending;
  svc.init = function (settings, loggingOptions) {
    pending ??= originalInit.call(svc, settings, loggingOptions)
      .catch(e => { pending = undefined; throw e; });
    return pending;
  };
  svc.__initFixApplied = true;
})();
```

Die Reihenfolge der Skripte ist entscheidend. Der Shim muss laufen, nachdem das Paketskript `window.AuthenticationService` definiert hat, und bevor Blazor startet:

```html
<!-- wwwroot/index.html -->
<script src="_content/Microsoft.Authentication.WebAssembly.Msal/AuthenticationService.js"></script>
<script src="msal-init-fix.js"></script>
<script src="_framework/blazor.webassembly#[.{fingerprint}].js"></script>
```

C# ruft `init` weiterhin zweimal auf, aber beide Aufrufe warten jetzt auf dasselbe Promise, und es entsteht nur ein einziger `MsalAuthorizeService`. Das `.catch` setzt den Cache zurück, damit eine fehlgeschlagene Initialisierung erneut versucht werden kann, statt dauerhaft zu scheitern. Das funktioniert, weil Blazor `AuthenticationService.init` bei jedem Aufruf per Name über `window` auflöst, also genügt es, die Eigenschaft zu ersetzen.

### 3. Oder das Paket auf 10.0.7 pinnen

```xml
<!-- .NET 10: last Msal release that bundles msal.js 2.39.0 -->
<PackageReference Include="Microsoft.Authentication.WebAssembly.Msal" Version="10.0.7" />
```

Die Entsprechungen sind 9.0.15 und 8.0.26. `Microsoft.AspNetCore.Components.WebAssembly` kann auf 10.0.12 bleiben: Diese Kombination kompiliert, und die App liefert das 2.39.0-Bundle aus. Beachten Sie, dass das Pinnen `Microsoft.AspNetCore.Components.WebAssembly.Authentication` als transitive Abhängigkeit auf 10.0.7 mitzieht. Der Preis ist ein msal.js am Ende seines Lebenszyklus, genau der Grund, aus dem Microsoft aktualisiert hat. Betrachten Sie das also als Brücke. Prüfen Sie, was der Browser tatsächlich erhält:

```bash
curl -s http://localhost:5117/_content/Microsoft.Authentication.WebAssembly.Msal/AuthenticationService.js | grep -oE '"(2\.39\.0|4\.30\.0)"'
```

Löschen Sie nach jedem Versionswechsel die Websitedaten in dem Browser, mit dem Sie testen. Der MSAL-Cache und der Zustand, den Blazor in `sessionStorage` ablegt, überleben App-Updates, worauf der [Abschnitt zur Problembehandlung in Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/security/webassembly/standalone-with-microsoft-entra-id#cookies-and-site-data) genau für solche Tests hinweist.

## Stolperfallen und ähnliche Fehler

**Benutzer nach dem Schließen des Browsers abgemeldet, mit `CacheLocation = "localStorage"`.** Das ist msal.js 4 wie vorgesehen, nicht die Race Condition. Ab v4 verschlüsselt MSAL den `localStorage`-Cache mit AES-GCM und legt den Schlüssel in einem Session-Cookie namens `msal.cache.encryption` ab (im 10.0.12-Bundle vorhanden). Laut [Migrationsleitfaden von v3 auf v4](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v3-migration.md) wird der Schlüssel entfernt, wenn der Browser geschlossen wird, sodass `localStorage` nicht mehr über Browsersitzungen hinweg bestehen bleibt. Keine der obigen Lösungen ändert das. Rechnen Sie nach einem Browserneustart mit einer stillen oder interaktiven Anmeldung.

**Stille Anmeldung schlägt nur auf Hosts mit privaten IP-Adressen fehl.** Läuft die App unter `192.168.x.x` oder `10.x.x.x` und blockiert Chrome 142 oder neuer den versteckten iframe mit `LocalNetworkAccessPermissionDenied`, handelt es sich um Chromes Local-Network-Access-Beschränkung, erfasst in [dotnet/aspnetcore#64699](https://github.com/dotnet/aspnetcore/issues/64699). Sie tritt mit jeder Paketversion auf.

**Apps mit `AddOidcAuthentication` sind von dieser Änderung nicht betroffen.** Der msal.js-Wechsel betraf nur das Interop-Skript des Msal-Pakets. Wenn Sie den generischen OIDC-Provider verwenden oder eine Blazor Web App, die auf dem Server authentifiziert, liegt die Ursache woanders.

**Wenn der Fix erscheint, schaden die Workarounds nicht.** Die drei Issues sind im Milestone 10.0.x offen, Stand 2026-09-10 ohne gemergten Fix. Der Aufruf in `Program.cs` kostet danach nichts. Der Shim wird zu einem wirkungslosen Wrapper, und Sie können ihn löschen, sobald `AuthenticationService.init` ein Promise statt eines Booleans speichert.

Geht es um eine neue App und nicht um eine kaputte, lohnt sich vorher ein Blick auf [Blazor Server vs WebAssembly vs United in .NET 11](/de/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/). Serverseitige Authentifizierung vermeidet Tokens im Browser vollständig.

## Verwandte Artikel

- [Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11](/de/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [JWT vs Cookie-Authentifizierung in ASP.NET Core 11](/de/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/), für die API-Seite eines WebAssembly-Clients.
- [Was ist ein Blazor-Rendermodus und welcher führt meine Komponente aus?](/de/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/)
- [SignalR in .NET 11 RC 1 tauscht ein ablaufendes Token aus, ohne die Verbindung zu trennen](/de/2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1/)

## Quellen

- [dotnet/aspnetcore#66978, MSAL-Authentifizierungsproblem nach dem Upgrade auf 10.0.8](https://github.com/dotnet/aspnetcore/issues/66978)
- [dotnet/aspnetcore#68549, `uninitialized_public_client_application` nach einem Neuladen in Firefox unter 10.0.10](https://github.com/dotnet/aspnetcore/issues/68549)
- [dotnet/aspnetcore#68136, `RemoteAuthenticatorView` ignoriert `ReturnUrl` unter 10.0.10](https://github.com/dotnet/aspnetcore/issues/68136)
- [dotnet/aspnetcore#66055, `@azure/msal-browser` auf 4.x aktualisieren](https://github.com/dotnet/aspnetcore/pull/66055), und die Backports [#66094](https://github.com/dotnet/aspnetcore/pull/66094), [#66234](https://github.com/dotnet/aspnetcore/pull/66234), [#66236](https://github.com/dotnet/aspnetcore/pull/66236)
- [`AuthenticationService.ts` auf `release/10.0`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/WebAssembly/Authentication.Msal/src/Interop/AuthenticationService.ts)
- [`RemoteAuthenticationService.cs` auf `release/10.0`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/WebAssembly/WebAssembly.Authentication/src/Services/RemoteAuthenticationService.cs)
- [Eine eigenständige Blazor-WebAssembly-App mit Microsoft Entra ID absichern](https://learn.microsoft.com/en-us/aspnet/core/blazor/security/webassembly/standalone-with-microsoft-entra-id)
- [msal-browser-Migrationsleitfaden von v2 auf v3](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v2-migration.md) und [Migrationsleitfaden von v3 auf v4](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v3-migration.md)
- [Microsoft.Authentication.WebAssembly.Msal auf NuGet](https://www.nuget.org/packages/Microsoft.Authentication.WebAssembly.Msal)
