---
title: "Eine Blazor-App mit routbaren Komponenten in einer anderen Assembly von .NET 8 auf .NET 10 migrieren"
description: "Upgrade einer Blazor Web App, deren Seiten in einer Razor-Klassenbibliothek oder einem .Client-Projekt liegen, von .NET 8 auf .NET 10: was gleich bleibt (beide AdditionalAssemblies-Registrierungen) und die vier Dinge, die brechen, vom 404 auf blazor.web.js in schlanken Hosts bis zu NotFoundPage-Seiten, die leer rendern. Gemessen mit ASP.NET Core 8.0.32 und 10.0.10."
pubDate: 2026-10-15
updatedDate: 2026-10-15
template: migration
tags:
  - "migration"
  - "blazor"
  - "dotnet-10"
  - "dotnet-8"
  - "aspnet-core"
  - "razor-class-library"
lang: "de"
translationOf: "2026/10/migrate-blazor-routable-components-from-another-assembly-dotnet-8-to-dotnet-10"
translatedBy: "claude"
translationDate: 2026-10-15
---

Wenn Ihre .NET 8 Blazor Web App Seiten rendert, die in einer anderen Assembly liegen (eine Razor-Klassenbibliothek, ein `.Client`-Projekt, ein Feature-Modul), ändert sich der Routing-Vertrag unter .NET 10 nicht: Auf der Endpunktseite braucht es weiterhin `MapRazorComponents<App>().AddAdditionalAssemblies(...)`, und der interaktive `Router` braucht weiterhin seinen Parameter `AdditionalAssemblies`. Ich habe dieselbe Registrierungsmatrix mit sieben Fällen auf ASP.NET Core 8.0.32 und 10.0.10 ausgeführt, und jeder Fall lieferte dasselbe Ergebnis. Was bricht, liegt drumherum: Ein Host ohne eigene `.razor`-Dateien liefert `blazor.web.js` nicht mehr aus, eine `NotFoundPage` in der Bibliothek rendert eine leere 404-Antwort, sofern die Bibliothek nicht auf der Endpunktseite registriert ist, das alte `<NotFound>`-Fragment ist veraltet, und der Fehler "Assembly already defined" wandert von Ihrer Zeile in `Program.cs` in den App-Start. Für eine typische Lösung mit ein oder zwei Seitenbibliotheken dauert das Upgrade weniger als eine Stunde. Alles Folgende wurde mit SDK 10.0.302 und `Microsoft.AspNetCore.Components.Web` 10.0.13 gebaut.

## Warum jetzt von .NET 8 wegziehen

- **Der Support für .NET 8 endet am 10. November 2026.** .NET 10 ist das aktuelle LTS und wird bis November 2028 unterstützt. Nach diesem Datum erhalten .NET 8 Apps keine Sicherheitspatches mehr.
- **`NotFoundPage` funktioniert assemblyübergreifend.** .NET 10 kann eine routbare Not-Found-Seite aus Ihrer gemeinsamen Bibliothek für unbekannte URLs, `NavigationManager.NotFound()`-Aufrufe und die erneute Ausführung per Statuscode rendern, statt eines Inline-Fragments, das in jedem Host dupliziert wird.
- **Statische Assets werden mit Fingerprint versehen und komprimiert.** `MapStaticAssets` (in .NET 9 eingeführt) liefert die `_content/...`-Dateien der Bibliothek und das Blazor-Skript mit Kompression zur Build-Zeit und ETags aus, was Seitenbibliotheken mit eigenem CSS und JS hilft.

## Was sich zwischen .NET 8 und .NET 10 ändert

| Bereich | Änderung | Schweregrad |
| --- | --- | --- |
| Host ohne `.razor`-Dateien | `blazor.web.js` ist in .NET 10 ein statisches Web-Asset und wird nur erzeugt, wenn das Projekt eine Komponente enthält. Schlanke Hosts erhalten einen 404. | hoch |
| `NotFoundPage` in einer Bibliothek | Die Seite braucht `@page`, und ihre Assembly muss an `AddAdditionalAssemblies` übergeben werden, sonst ist die 404-Antwort leer | mittel |
| `<NotFound>`-Fragment | `[Obsolete]`, und wirft eine Ausnahme in Kombination mit `NotFoundPage` | mittel |
| RCL-Paketverweis | `Microsoft.AspNetCore.Components.Web` 8.0.x muss auf 10.0.x wechseln | niedrig |
| Doppelte Assembly-Registrierung | "Assembly already defined" wird beim Start geworfen, nicht beim Aufruf von `AddAdditionalAssemblies` | niedrig |
| Membernamen in Bibliothekskomponenten | `ComponentBase` hat in .NET 9 `RendererInfo` und `AssignedRenderMode` erhalten; ein Komponentenmember mit gleichem Namen verdeckt es jetzt (CS0108) | niedrig |
| `UseStaticFiles` | Funktioniert nach dem Publish weiterhin, aber der Migrationsleitfaden ersetzt es durch `MapStaticAssets` | niedrig |

## Die zwei Registrierungen und was jede steuert

Hier machen die meisten Migrationen Fehler, meist weil die .NET 7 Blazor-Server-App nur eine der beiden brauchte. Eine Blazor Web App hat zwei Router. Das Endpoint Routing von ASP.NET Core bearbeitet die erste HTTP-Anfrage (und jede erweiterte Navigationsanfrage) und muss wissen, welche Assemblies `@page`-Komponenten enthalten. Die Blazor-Komponente `Router` bearbeitet die Navigation, sobald sie interaktiv läuft, und baut ihre eigene Routentabelle aus `AppAssembly` plus `AdditionalAssemblies` auf.

Das ist der Testaufbau: ein Host, erstellt aus der .NET 8 Vorlage `blazor` mit Interactive Server, und eine Razor-Klassenbibliothek `Shared.Pages` mit einer Seite.

```razor
@* Shared.Pages/Pages/Reports.razor, .NET 8 and .NET 10 *@
@page "/reports"
@rendermode InteractiveServer

<h1>Reports (from Shared.Pages)</h1>
<p>Rendered from @GetType().Assembly.GetName().Name</p>
<button @onclick="() => count++">Clicked @count</button>

@code {
    int count;
}
```

Ich habe jede Registrierung und den Render-Modus von `<Routes />` per Umgebungsvariablen umgeschaltet und dann `/reports` direkt angefragt. Die Ergebnisse waren auf 8.0.32 und 10.0.10 identisch:

| `Router.AdditionalAssemblies` | `AddAdditionalAssemblies` | Render-Modus von `<Routes>` | `GET /reports` |
| --- | --- | --- | --- |
| nicht gesetzt | nicht gesetzt | statisch | 404 |
| gesetzt | nicht gesetzt | statisch | 404 |
| nicht gesetzt | gesetzt | statisch | 200 |
| gesetzt | gesetzt | statisch | 200 |
| gesetzt | nicht gesetzt | `InteractiveServer` | 404 |
| nicht gesetzt | gesetzt | `InteractiveServer` | 200, dann "not found", sobald die Verbindung (Circuit) startet |
| gesetzt | gesetzt | `InteractiveServer` | 200 |

Die sechste Zeile ist die verwirrende. Der Server rendert die Seite korrekt vor, der Browser zeigt sie kurz an, dann übernimmt der interaktive `Router`, findet `/reports` nicht in seiner eigenen Routentabelle und ersetzt die Seite durch den Not-Found-Inhalt. Das habe ich in einem Browser auf beiden Versionen bestätigt. Die fünfte Zeile ist der umgekehrte Fehler: Der interaktive Router kennt die Seite, aber die allererste Anfrage erreicht sie nie, weil kein Endpunkt existiert.

Die Regel für beide Versionen ist also einfach: **Registrieren Sie jede Assembly, die routbare Komponenten enthält, an beiden Stellen.** Liegt die Komponente `Routes` im Serverprojekt, muss deren `AdditionalAssemblies` auch die `.Client`-Assembly enthalten.

## Checkliste vor dem Start

1. .NET 10 SDK installiert (`dotnet --list-sdks` zeigt `10.0.1xx` oder neuer; ich habe 10.0.302 verwendet). Falls eine `global.json` 8.0 festlegt, aktualisieren Sie sie.
2. Eine Liste jeder Assembly, die `@page`-Komponenten enthält. `grep -rln "@page" --include=*.razor .` ausführen und die Treffer nach Projekt gruppieren.
3. Jede Stelle, die sie registriert. `grep -rn "AdditionalAssemblies" --include=*.razor --include=*.cs .` sollte pro Host einen `Router` und eine `MapRazorComponents`-Kette zeigen. Zeigt es nur eines davon, haben Sie bereits den Fehler aus der obigen Matrix.
4. Eine Liste der URLs, die weiter funktionieren müssen, mit je einer URL aus jeder Bibliothek und einer, die 404 liefern soll. Diese rufen Sie nach jedem Schritt mit curl ab.

## Migrationsschritte

1. **Alle Projekte neu ausrichten und das Paket der Bibliothek anheben.** Ändern Sie `<TargetFramework>net8.0</TargetFramework>` in `net10.0` im Host, im `.Client`-Projekt und in jeder Razor-Klassenbibliothek. Die RCL-Vorlage verweist auf `Microsoft.AspNetCore.Components.Web` als Paket, daher braucht auch dieses eine neue Version:

   ```xml
   <!-- Shared.Pages.csproj, .NET 10 -->
   <Project Sdk="Microsoft.NET.Sdk.Razor">
     <PropertyGroup>
       <TargetFramework>net10.0</TargetFramework>
       <Nullable>enable</Nullable>
       <ImplicitUsings>enable</ImplicitUsings>
     </PropertyGroup>
     <ItemGroup>
       <SupportedPlatform Include="browser" />
     </ItemGroup>
     <ItemGroup>
       <PackageReference Include="Microsoft.AspNetCore.Components.Web" Version="10.0.13" />
     </ItemGroup>
   </Project>
   ```

   Wenn andere Apps die Bibliothek weiterhin unter .NET 8 nutzen, richten Sie sie mit `<TargetFrameworks>net8.0;net10.0</TargetFrameworks>` auf mehrere Frameworks aus und machen die Paketversion von `$(TargetFramework)` abhängig. Prüfen Sie mit `dotnet build` und lesen Sie die Warnungen: Ein CS0108 an einer Bibliothekskomponente bedeutet, dass sie einen Member deklariert, der jetzt einen `ComponentBase`-Member verdeckt (siehe die Stolperfallen).

2. **Die Assembly-Liste an einer Stelle halten und für beide Registrierungen verwenden.** Die meisten Fehler nach dem Muster "Seite funktioniert beim Neuladen, aber nicht beim Klick" entstehen, weil zwei Listen auseinanderlaufen. Eine kleine statische Klasse beseitigt das Auseinanderlaufen:

   ```csharp
   // Host/RoutableAssemblies.cs, .NET 10
   using System.Reflection;

   namespace Host;

   public static class RoutableAssemblies
   {
       // Do NOT include typeof(Program).Assembly: it is already the app assembly.
       public static readonly Assembly[] Additional =
       [
           typeof(Shared.Pages._Imports).Assembly,
           // typeof(Host.Client._Imports).Assembly,
       ];
   }
   ```

   ```csharp
   // Host/Program.cs, .NET 10
   app.MapRazorComponents<App>()
       .AddInteractiveServerRenderMode()
       .AddAdditionalAssemblies(RoutableAssemblies.Additional);
   ```

   ```razor
   @* Host/Components/Routes.razor, .NET 10 *@
   <Router AppAssembly="typeof(Program).Assembly"
           AdditionalAssemblies="RoutableAssemblies.Additional"
           NotFoundPage="typeof(Shared.Pages.Pages.NotFound)">
       <Found Context="routeData">
           <RouteView RouteData="routeData" DefaultLayout="typeof(Layout.MainLayout)" />
           <FocusOnNavigate RouteData="routeData" Selector="h1" />
       </Found>
   </Router>
   ```

   Prüfen Sie mit `curl -s -o /dev/null -w '%{http_code}' http://localhost:5000/reports`, dass für je eine URL pro Bibliothek `200` zurückkommt, öffnen Sie dann dieselbe URL im Browser und warten Sie, bis der Circuit (oder die WebAssembly-Runtime) gestartet ist. Die Seite muss danach weiterhin da sein.

3. **`<NotFound>` durch eine routbare `NotFoundPage` ersetzen.** In .NET 10 ist das Render-Fragment `NotFound` mit `[Obsolete("NotFound is deprecated. Use NotFoundPage instead.")]` markiert. Die Release Notes gehen weiter und sagen, es werde "isn't supported in .NET 10 or later", aber in meinem Test rendete das Fragment auf 10.0.10 weiterhin, wenn keine `NotFoundPage` gesetzt war. Es handelt sich also um eine Veraltung, die Sie einplanen können, nicht um einen Ausfall. Werden beide gesetzt, wird `InvalidOperationException: Setting NotFound and NotFoundPage properties simultaneously is not supported` geworfen. Die Seite braucht eine Route, weil der Router prüft, dass sie ein `[Route]`-Attribut hat:

   ```razor
   @* Shared.Pages/Pages/NotFound.razor, .NET 10 *@
   @page "/not-found"

   <h1>Not found (from Shared.Pages)</h1>
   ```

   Fügen Sie dann die Middleware für die erneute Ausführung per Statuscode hinzu, die die .NET 10 Vorlage verwendet, damit unbekannte URLs aus der ersten HTTP-Anfrage ebenfalls auf dieser Seite landen:

   ```csharp
   // Host/Program.cs, .NET 10
   app.UseStatusCodePagesWithReExecute("/not-found", createScopeForStatusCodePages: true);
   app.UseAntiforgery();
   ```

   Prüfen Sie, dass `GET /missing` den Status `404` mit dem `<h1>` Ihrer Seite im Body zurückgibt und dass `GET /not-found` den Status `200` liefert. Ist der Body der 404-Antwort leer, lesen Sie den nächsten Schritt.

4. **Die Assembly der Not-Found-Seite auf der Endpunktseite registrieren.** Die erneute Ausführung ist eine zweite Anfrage durch das Endpoint Routing an `/not-found`. Liegt die Seite in einer Bibliothek, die nur der `Router` kennt, gibt es dafür keinen Endpunkt. Gemessen auf 10.0.10 mit der Seite in `Shared.Pages`:

   | `AddAdditionalAssemblies(Shared.Pages)` | `GET /missing` | `GET /not-found` |
   | --- | --- | --- |
   | fehlt | 404, leerer Body | 404, leerer Body |
   | vorhanden | 404, "Not found (from Shared.Pages)" | 200 |

   Schritt 2 behebt das bereits, wenn die Bibliothek in der gemeinsamen Liste steht. Prüfen Sie mit denselben zwei Anfragen.

5. **`UseStaticFiles` auf `MapStaticAssets` umstellen.** Der Migrationsleitfaden für .NET 9 ersetzt `app.UseStaticFiles()` durch `app.MapStaticAssets()`, und die .NET 10 Vorlage verwendet es. Es liefert die Assets der Bibliothek unter `_content/Shared.Pages/...` mit vorkomprimierten `.br`- und `.gz`-Varianten aus. Ich habe geprüft, dass `UseStaticFiles` unter .NET 10 `blazor.web.js` weiterhin aus einem Publish-Ordner ausliefert, die Umstellung ist also nicht erzwungen, aber der Rest der Vorlage (`@Assets["..."]`, `<ResourcePreloader />`, `<ImportMap />`) erwartet sie:

   ```csharp
   // Host/Program.cs, .NET 10
   app.UseAntiforgery();
   app.MapStaticAssets();
   app.MapRazorComponents<App>()
       .AddInteractiveServerRenderMode()
       .AddAdditionalAssemblies(RoutableAssemblies.Additional);
   ```

   Prüfen Sie, dass `GET /_framework/blazor.web.js` den Status `200` liefert und dass ein Stylesheet der Bibliothek wie `/_content/Shared.Pages/Shared.Pages.bundle.scp.css` weiterhin geladen wird.

6. **Hat der Host keine `.razor`-Dateien, das Blazor-Skript erzwingen.** Das ist der Bruch, der nur die sauberste Architektur trifft. Wenn `App.razor`, das Layout und jede Seite in Bibliotheken liegen und der Host nur aus `Program.cs` besteht, lieferte .NET 8 `blazor.web.js` trotzdem aus, weil es eine eingebettete Ressource im Shared Framework war. In .NET 10 ist das Skript ein statisches Web-Asset, das das SDK nur hinzufügt, wenn das Projekt mindestens eine Komponente enthält. Mein schlanker Host, gemessen aus einem Publish-Ordner:

   | Host | `GET /reports` | `GET /_framework/blazor.web.js` |
   | --- | --- | --- |
   | .NET 8.0.32, `UseStaticFiles` | 200 | 200 |
   | .NET 10.0.10, `MapStaticAssets` | 200 | 404 |
   | .NET 10.0.10, `MapStaticAssets` + `RequiresAspNetWebAssets` | 200 | 200 |

   Die Seite wird weiterhin vorgerendert, deshalb ist das leicht zu übersehen: Nichts ist interaktiv, und das einzige Signal ist ein 404 im Netzwerk-Tab des Browsers. Die Lösung ist eine MSBuild-Eigenschaft:

   ```xml
   <!-- Host.csproj, .NET 10, host project without any .razor file -->
   <PropertyGroup>
     <TargetFramework>net10.0</TargetFramework>
     <RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>
   </PropertyGroup>
   ```

   Prüfen Sie, dass `publish/wwwroot/_framework/blazor.web.js` nach `dotnet publish` existiert, und klicken Sie dann im Browser auf etwas Interaktives.

7. **Bei WebAssembly- und Auto-Seiten in einer Bibliothek auch die `.Client`-Seite prüfen.** Hier hat sich zwischen 8 und 10 nichts geändert, aber die Migration ist ein guter Zeitpunkt, es zu korrigieren. Eine Bibliotheksseite mit `@rendermode InteractiveWebAssembly` muss vom Browser heruntergeladen werden können, daher muss das `.Client`-Projekt auf die Bibliothek verweisen, und der Server muss sie für die erste Anfrage weiterhin in `AddAdditionalAssemblies` aufführen. Läuft `Routes` selbst auf WebAssembly (globale Interaktivität), liegt es in `.Client`, und sein `Router` braucht die Bibliothek in `AdditionalAssemblies`. Prüfen Sie, indem Sie eine WebAssembly-Seite direkt laden und dann von einer anderen Seite aus zu ihr navigieren.

## Verifikation

Führen Sie das gegen die veröffentlichte App aus (`dotnet publish -c Release -o out`, dann `dotnet out/Host.dll`), nicht gegen `bin/`:

```bash
#!/usr/bin/env bash
# .NET 10 smoke test for routable components from other assemblies
BASE=http://localhost:5000
for u in /reports /not-found /missing /_framework/blazor.web.js; do
  printf '%-30s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$u")"
done
```

Erwartet: `200`, `200`, `404`, `200`. Danach im Browser:

- Öffnen Sie eine Bibliotheksseite direkt und warten Sie zwei Sekunden. Sie darf sich nicht in die Not-Found-Seite verwandeln.
- Navigieren Sie per Klick auf einen Link von einer Host-Seite zu einer Bibliotheksseite und zurück.
- Lösen Sie `NavigationManager.NotFound()` aus einer Bibliotheksseite aus, falls Sie es verwenden, und bestätigen Sie, dass die `NotFoundPage` gerendert wird.
- Prüfen Sie im Netzwerk-Tab auf 404-Antworten bei `_framework/` oder `_content/`.

## Rollback

Die Änderung ist umkehrbar, solange Sie die Bibliothek kompatibel halten. Wenn die Bibliothek `net8.0;net10.0` als Ziele hat, können Sie den Host auf `net8.0` zurücksetzen, indem Sie seine `.csproj` zurücknehmen. Beachten Sie, was es unter 8 nicht gibt: `MapStaticAssets` (verwenden Sie `UseStaticFiles`), `NotFoundPage` (verwenden Sie das `<NotFound>`-Fragment), den Parameter `createScopeForStatusCodePages` von `UseStatusCodePagesWithReExecute` und `RequiresAspNetWebAssets` (harmlos, aber ungenutzt). Halten Sie diese Änderungen in einem separaten Commit vom Retargeting, damit der Rollback ein sauberer Revert ist.

## Stolperfallen aus den Testläufen

**"Assembly already defined" ist umgezogen.** Die eigene Assembly der App zu `AddAdditionalAssemblies` hinzuzufügen war schon immer ein Fehler. Auf 8.0.32 zeigt der Stack Trace direkt auf Ihren Code:

```text
Unhandled exception. System.InvalidOperationException: Assembly already defined.
   at Microsoft.AspNetCore.Components.Discovery.ComponentApplicationBuilder.AddLibrary(...)
   at Microsoft.AspNetCore.Builder.RazorComponentsEndpointConventionBuilderExtensions.AddAdditionalAssemblies(...)
   at Program.<Main>$(String[] args) in .../Host/Program.cs:line 29
```

Auf 10.0.10 wird die Registrierung aufgeschoben, bis die Endpunkte zum ersten Mal gebaut werden. Derselbe Fehler wird dann als `Application startup exception` aus `RazorComponentEndpointDataSource.UpdateEndpoints()` protokolliert, und kein Frame nennt `Program.cs`. Sehen Sie diese Meldung nach dem Upgrade, suchen Sie in Ihrer Liste zusätzlicher Assemblies nach `typeof(Program).Assembly` oder danach, dass dieselbe Bibliothek über zwei Hilfsmethoden doppelt hinzugefügt wurde.

**Doppelte Routen über Assemblies hinweg schlagen erst zur Anfragezeit fehl, nicht beim Start.** Als Host und Bibliothek beide `@page "/reports"` deklarierten, startete die App auf 10.0.10 problemlos, und die Anfrage lieferte `500` mit `AmbiguousMatchException: The request matched multiple endpoints`. Nur die kollidierende URL bricht, ein Smoke-Test, der sie auslässt, läuft also durch. Die Ausgabe von `grep -rn '@page "' --include=*.razor` aus der Checkliste, nach Route sortiert, findet diese Fälle vor der Auslieferung.

**Ein Bibliotheksmember namens `RendererInfo` verdeckt jetzt einen Framework-Member.** Meine erste Version der Testseite hatte eine Eigenschaft `string RendererInfo`. Sie kompilierte unter .NET 8 sauber und erzeugte unter .NET 10 `warning CS0108: 'Reports.RendererInfo' hides inherited member 'ComponentBase.RendererInfo'`, weil `ComponentBase` in .NET 9 `RendererInfo` und `AssignedRenderMode` erhalten hat. Die Warnung ist harmlos, bis ein Teammitglied in dieser Komponente `RendererInfo.IsInteractive` liest und Ihren String statt des Framework-Members erhält. Benennen Sie den Member um.

**`UseStaticFiles` beizubehalten und aus `bin/` zu testen liefert einen falschen 404.** Mit der .NET 8 Pipeline (`UseStaticFiles`, kein `MapStaticAssets`) lieferte `dotnet bin/Release/net10.0/Host.dll` in der Umgebung Production für `blazor.web.js` einen 404, sogar in einem normalen Host mit Komponenten, während dasselbe unter .NET 8 200 ergab. `UseStaticFiles` sieht nur die Dateien, die physisch in `wwwroot` liegen, und außerhalb von Development fügt nichts die statischen Web-Assets aus referenzierten Projekten und dem SDK hinzu. Unter .NET 8 stammte das Blazor-Skript aus einer eingebetteten Ressource, daher störte es nicht; unter .NET 10 ist es ein statisches Web-Asset. Derselbe Lauf aus `bin/` mit `MapStaticAssets` lieferte 200, weil es das erzeugte Endpunkt-Manifest liest, und der Publish-Ordner lieferte mit beiden Middlewares 200. Testen Sie aus einem `dotnet publish`-Ordner oder mit `dotnet run`, sonst jagen Sie dem falschen Problem hinterher.

**Das Vorrendern verbirgt eine fehlende `Router`-Registrierung.** Wie die Matrix zeigt, rendert eine Seite, die nur auf der Endpunktseite registriert ist, in `curl` und in automatisierten HTML-Snapshot-Tests einwandfrei. Der Fehler zeigt sich erst, nachdem der interaktive Router startet. Jeder End-to-End-Test für Bibliotheksseiten muss auf die Interaktivität warten, zum Beispiel indem er auf eine Schaltfläche klickt und das Ergebnis prüft.

## Verwandte Artikel

- Wenn Sie noch auf dem .NET 7 Hosting-Modell sind, beginnen Sie mit [der Migration einer Blazor-Server-App zu Blazor United](/de/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) und kommen Sie dann für den Teil mit mehreren Assemblies zurück.
- Welcher Render-Modus für eine Bibliotheksseite tatsächlich läuft, sobald sie geroutet ist, steht in [was ein Blazor-Render-Modus ist und welcher meine Komponente ausführt](/de/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/).
- Ein verwandter Fehler bei statischen Assets mit anderer Ursache: [404 Not Found für blazor.server.js nach der Installation eines neuen .NET SDK](/de/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/).
- Deklariert eine Bibliotheksseite einen Render-Modus, den ihre übergeordnete Komponente nicht hosten kann, stoßen Sie auf [den Fehler "render mode is not supported by the parent component's render mode"](/de/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor/).
- Das Projektlayout hinter `.Client` und `AddAdditionalAssemblies` wird in [Blazor Server vs WebAssembly vs United](/de/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) verglichen.

## Quellen

- [Route to components from multiple assemblies](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/routing) (Microsoft Learn, ASP.NET Core Blazor routing)
- [Migrate from ASP.NET Core in .NET 8 to ASP.NET Core in .NET 9](https://learn.microsoft.com/en-us/aspnet/core/migration/80-to-90), einschließlich "Replace UseStaticFiles with MapStaticAssets" (Microsoft Learn)
- [Migrate from ASP.NET Core in .NET 9 to ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/migration/90-to-100) (Microsoft Learn)
- [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0): "Blazor router has a NotFoundPage parameter" und "Blazor script as static web asset"
- [Map static files in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/map-static-files) (Microsoft Learn)
- [ASP.NET Core Razor class libraries](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/class-libraries) (Microsoft Learn)
- [`Router.cs` at v10.0.0](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Components/Components/src/Routing/Router.cs), die Quelle der `NotFoundPage`-Validierung und des veralteten Parameters `NotFound` (dotnet/aspnetcore)
- [.NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core) für die End-of-Support-Daten von .NET 8 und .NET 10
