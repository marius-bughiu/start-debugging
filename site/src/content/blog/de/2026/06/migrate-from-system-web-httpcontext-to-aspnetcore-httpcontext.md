---
title: "Von System.Web.HttpContext zu Microsoft.AspNetCore.Http.HttpContext migrieren"
description: "Eine praktische Migration vom System.Web.HttpContext des ASP.NET Framework zum HttpContext von ASP.NET Core 11: HttpContext.Current, die Eigenschaften-Zuordnung, Server.MapPath, Session und der Shim der System.Web-Adapter für inkrementelle Migrationen."
pubDate: 2026-06-06
updatedDate: 2026-06-06
template: migration
tags:
  - "migration"
  - "aspnetcore-11"
  - "dotnet-11"
  - "httpcontext"
  - "system-web"
lang: "de"
translationOf: "2026/06/migrate-from-system-web-httpcontext-to-aspnetcore-httpcontext"
translatedBy: "claude"
translationDate: 2026-06-06
---

Die einzelne Zeile, die mehr ASP.NET-Framework-Migrationen zerstört als jede andere, ist `HttpContext.Current`. Sie existiert in ASP.NET Core nicht. Es gibt keinen statischen Umgebungskontext, auf den man aus einer beliebigen Klasse zugreifen könnte, der Typ `HttpContext` ist ein anderer Typ in einem anderen Namespace (`Microsoft.AspNetCore.Http.HttpContext`, nicht `System.Web.HttpContext`), und die meisten Eigenschaften, auf die Sie sich verlassen haben, sind verschoben worden, haben ihre Form geändert oder sind verschwunden. Dieser Beitrag ordnet die alte API der neuen für .NET 11 / ASP.NET Core 11 zu und zeigt dann die zwei realen Wege nach vorn: ein sauberes Neuschreiben für Code, den Sie kontrollieren, und die offiziellen `System.Web`-Adapter, wenn Sie einen Haufen gemeinsam genutzter Bibliotheken haben, die `HttpContext` herumreichen und nicht in einem Zug neu geschrieben werden können.

Für einen kleinen Handler oder einen einzelnen Controller ist das Neuschreiben eine Stunde. Für einen Monolithen, in dem `HttpContext.Current` durch eine Geschäftsschicht in einem separaten Assembly gefädelt ist, planen Sie Tage ein und greifen Sie zu den Adaptern, damit die Bibliotheken weiterhin gegen beide Frameworks kompilieren, während Sie Anwendung für Anwendung migrieren. Nichts an der HTTP-Semantik ändert sich; was sich ändert, ist, wie Sie die Anfrage erreichen, dass die Laufzeit jetzt strikt an die Anfrage gebunden ist und dass es keine Thread-Affinität gibt, auf die man sich stützen kann.

## Warum diese Migration kein Suchen-und-Ersetzen ist

`System.Web.HttpContext` und `Microsoft.AspNetCore.Http.HttpContext` sind wirklich verschiedene Objekte, und die Lücken sind verhaltensbezogen, nicht nur kosmetisch:

- **`HttpContext.Current` ist weg.** ASP.NET Framework gab jeder Anfrage Thread-Affinität, sodass ein statischer Accessor den richtigen Kontext über den aktuellen Thread finden konnte. ASP.NET Core gibt keine solche Garantie, also gibt es nichts Gleichwertiges, das man statisch lesen könnte. Stattdessen injizieren Sie den Kontext.
- **Der Kontext kann die Anfrage nicht überleben.** In ASP.NET Core wird der Kontext am Ende der Anfrage recycelt. Ihn danach anzufassen (eine erfasste Referenz in einer Fire-and-Forget-Task, ein zwischengespeichertes Feld) wirft eine `ObjectDisposedException`. Im Framework "funktionierte" das oft zufällig.
- **Keine Thread-Affinität.** Eine einzelne Anfrage kann über `await`-Punkte hinweg den Thread wechseln. `HttpContext` nebenläufig zu lesen und zu schreiben ist jetzt eine Race Condition, die Ihnen gehört.
- **Lese- und Schreibvorgänge werden asynchron.** `Response.Write` wird zu `await Response.WriteAsync`. Das Formular oder den Body zu lesen ist `await ReadFormAsync()` / ein Stream-Lesevorgang. Antwort-Header und Cookies müssen gesetzt werden, bevor die Antwort beginnt.

Microsofts eigener [HttpContext-Migrationsleitfaden](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/http-context?view=aspnetcore-10.0) rahmt dies als zwei Strategien, und die Wahl steuert alles Folgende: vollständiges Neuschreiben oder `System.Web`-Adapter für einen inkrementellen Umzug.

## Was kaputtgeht

| Bereich | ASP.NET Framework | ASP.NET Core 11 | Schweregrad |
| --- | --- | --- | --- |
| Umgebungskontext | `HttpContext.Current` | `IHttpContextAccessor` (mit `AddHttpContextAccessor` registrieren) | hoch |
| Kontext-Lebensdauer | Nach der Anfrage teils nutzbar | `ObjectDisposedException` nach Ende der Anfrage | hoch |
| Thread-Sicherheit | Anfrage mit Thread-Affinität | Keine Thread-Affinität über `await` hinweg | hoch |
| In die Antwort schreiben | `Response.Write(s)` | `await Response.WriteAsync(s)` | mittel |
| Formular / Body lesen | `Request.Form`, `Request.InputStream` (sync) | `await Request.ReadFormAsync()`, `Request.Body` (einmal lesbar) | mittel |
| Antwort-Header / Cookies | Jederzeit setzbar | Vor Beginn der Antwort setzen (oder via `OnStarting`) | mittel |
| Physische Pfade | `Server.MapPath("~/x")` | `IWebHostEnvironment.ContentRootPath` / `WebRootPath` + `Path.Combine` | mittel |
| Session | `Session["k"]`, auto-serialisiert, gesperrt | `HttpContext.Session.GetString/SetString`, byte-basiert, kein Lock | mittel |
| HTML-Kodierung | `Server.HtmlEncode` | `System.Net.WebUtility.HtmlEncode` / `HtmlEncoder` | niedrig |
| Anfrage-URL | `Request.Url`, `Request.RawUrl` | `Request.Scheme/Host/Path/QueryString` oder `GetDisplayUrl()` | niedrig |

## Checkliste vor dem Start

- Installieren Sie das .NET-11-SDK (`dotnet --version` meldet `11.x`). Fixieren Sie `<TargetFramework>net11.0</TargetFramework>` im Webprojekt.
- Inventarisieren Sie jede `HttpContext.Current`-Referenz. `grep -rn "HttpContext.Current"` über die gesamte Solution ist die ehrliche Aufwandsschätzung.
- Inventarisieren Sie `Server.MapPath`, `Session[`, `Request.Url`, `Response.Write` und `Request.ServerVariables`. Das sind die Übeltäter zweiter Stufe.
- Entscheiden Sie pro Assembly: zu nativem ASP.NET Core neu schreiben oder `System.Web.HttpContext` behalten und das Adapter-Paket hinzufügen. Gemeinsam genutzte Bibliotheken, die die noch nicht migrierte Framework-Anwendung weiterhin bedienen müssen, sind Adapter-Kandidaten.
- Halten Sie eine grüne Test-Suite bereit, bevor Sie irgendetwas anfassen. Die Migration ist mechanisch, und eine bestehende Suite ist die Art, wie Sie sie ehrlich halten.

## Migrationsschritte

### Schritt 1: Registrieren Sie den Accessor und greifen Sie nicht mehr zu HttpContext.Current

Ersetzen Sie den Umgebungszugriff durch explizite Injektion. In `Program.cs`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddHttpContextAccessor(); // enables IHttpContextAccessor

var app = builder.Build();
app.MapControllers();
app.Run();
```

Ein Service, der zuvor `HttpContext.Current` las, erhält nun `IHttpContextAccessor`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
public sealed class CurrentUserService(IHttpContextAccessor accessor)
{
    public string? UserId =>
        accessor.HttpContext?.User.FindFirst("sub")?.Value;
}
```

Speichern Sie `accessor.HttpContext` nicht in einem Feld. Lesen Sie es jedes Mal am Verwendungspunkt, denn das Feld würde einen Kontext aus einer Anfrage erfassen und ihn an eine andere übergeben, oder an gar keine. Innerhalb eines Controllers oder einer Minimal API haben Sie `HttpContext` bereits als Eigenschaft oder Parameter, bevorzugen Sie es also, ihn explizit zu übergeben, und überspringen Sie den Accessor ganz.

**Prüfen:** Die Solution kompiliert ohne `System.Web`-Referenzen in den neu geschriebenen Projekten, und eine Anfrage, die `CurrentUserService` ausführt, gibt die erwartete Benutzer-ID zurück.

### Schritt 2: Übersetzen Sie die Anfrage-Eigenschaften

Die meisten `Request`-Member wurden verschoben statt entfernt. Die Zuordnung, die die gängigen Fälle abdeckt:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
string method      = httpContext.Request.Method;          // was HttpMethod
bool   isHttps     = httpContext.Request.IsHttps;         // was IsSecureConnection
string? remoteIp   = httpContext.Connection.RemoteIpAddress?.ToString(); // was UserHostAddress
string userAgent   = httpContext.Request.Headers.UserAgent.ToString();

// Query string: IQueryCollection, indexer never throws on a missing key
string q = httpContext.Request.Query["key"].ToString(); // "" if absent

// Full URL: no single Request.Url anymore
// using Microsoft.AspNetCore.Http.Extensions;
string url = httpContext.Request.GetDisplayUrl();
```

Das Formular oder den Body zu lesen ist asynchron, und der Body ist ein Vorwärts-Stream, den Sie einmal lesen können:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
if (httpContext.Request.HasFormContentType)
{
    IFormCollection form = await httpContext.Request.ReadFormAsync();
    string firstName = form["firstname"].ToString();
}
```

**Prüfen:** Rufen Sie einen Endpunkt auf, der Query, Formular und einen Header liest; stellen Sie sicher, dass die Werte mit dem übereinstimmen, was die Framework-Anwendung für dieselbe Anfrage zurückgab.

### Schritt 3: Übersetzen Sie die Antwort und respektieren Sie, wann Header gesetzt werden können

Schreiben ist asynchron, und Header und Cookies müssen gesetzt werden, bevor der Body zu fließen beginnt:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
httpContext.Response.StatusCode = StatusCodes.Status200OK;
httpContext.Response.ContentType = "application/json";
httpContext.Response.Headers["X-Custom"] = "value"; // before first write
await httpContext.Response.WriteAsync(payload);
```

Wenn Sie in Middleware sind und Header unmittelbar vor dem Senden der Antwort setzen müssen, verwenden Sie den Callback, statt sie zu spät zu setzen:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
httpContext.Response.OnStarting(static state =>
{
    var ctx = (HttpContext)state;
    ctx.Response.Headers["X-Late"] = "value";
    return Task.CompletedTask;
}, httpContext);
```

**Prüfen:** Inspizieren Sie die Antwort-Header mit `curl -i`; bestätigen Sie, dass der Header vorhanden ist und Sie unter Last keine `response has already started`-Ausnahme erhalten.

### Schritt 4: Ersetzen Sie Server.MapPath durch IWebHostEnvironment

`Server.MapPath("~/App_Data/x.json")` hat kein Äquivalent. Injizieren Sie `IWebHostEnvironment` und kombinieren Sie die Pfade selbst:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
public sealed class FileService(IWebHostEnvironment env)
{
    public string DataPath(string name) =>
        Path.Combine(env.ContentRootPath, "App_Data", name); // project root
    public string AssetPath(string name) =>
        Path.Combine(env.WebRootPath, name);                 // wwwroot
}
```

`ContentRootPath` ist das Projektstammverzeichnis (das alte `~/`), `WebRootPath` ist `wwwroot` (das alte Stammverzeichnis für statische Dateien). Für die HTML-Kodierung wird `Server.HtmlEncode` zu `System.Net.WebUtility.HtmlEncode` oder, in DI, einem injizierten `HtmlEncoder`.

**Prüfen:** Eine Anfrage, die eine Datei lädt, löst denselben absoluten Pfad auf, den Sie erwarten, sowohl unter Windows als auch unter Linux (das `Path.Combine` hält es portabel).

### Schritt 5: Verschieben Sie Session, im Wissen, dass sie sich anders verhält

Die Session von ASP.NET Core ist opt-in, byte-basiert, wird nicht automatisch serialisiert und bietet kein Locking pro Anfrage. Registrieren Sie sie:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession();
// ...
app.UseSession(); // before endpoints
```

Tauschen Sie dann den Indexer gegen die typisierten Helfer:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
httpContext.Session.SetString("user", "marius"); // was Session["user"] = "marius"
string? user = httpContext.Session.GetString("user");
httpContext.Session.SetInt32("count", 3);
```

Ein Objekt zu speichern bedeutet, es selbst zu serialisieren (zum Beispiel mit `System.Text.Json`) und `SetString` aufzurufen. Es gibt keine automatische Objekt-Session, wie sie das Framework hatte. Der [Session-Migrationsleitfaden](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/session?view=aspnetcore-9.0) lohnt sich zu lesen, wenn Sie auf das Session-Locking angewiesen waren.

**Prüfen:** Setzen Sie einen Wert in einer Anfrage, lesen Sie ihn in der nächsten zurück; bestätigen Sie, dass er über Anfragen hinweg mit demselben Session-Cookie überlebt.

## Wenn ein Neuschreiben zu groß ist: die System.Web-Adapter

Wenn `HttpContext` durch Klassenbibliotheken verwoben ist, die auch eine noch nicht migrierte Framework-Anwendung aufruft, ist es nicht praktikabel, jede Signatur auf einmal neu zu schreiben. Microsoft liefert die [System.Web-Adapter](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/inc/systemweb-adapters?view=aspnetcore-10.0) genau dafür. Sie implementieren die Form von `System.Web.HttpContext` über dem ASP.NET-Core-Kontext neu, sodass eine Bibliothek `netstandard2.0` anvisieren und beide Runtimes bedienen kann.

Die Pakete, die Sie sehen werden:

- `Microsoft.AspNetCore.SystemWebAdapters`: der Shim selbst, referenziert von den gemeinsam genutzten Bibliotheken. Zielt auf .NET Standard 2.0, .NET Framework 4.5+ und .NET 5+.
- `Microsoft.AspNetCore.SystemWebAdapters.CoreServices`: referenziert von der ASP.NET-Core-Anwendung zur Konfiguration des Verhaltens. Zielt auf .NET 6+.
- `Microsoft.AspNetCore.SystemWebAdapters.FrameworkServices`: referenziert von der Framework-Anwendung während der inkrementellen Migration.

In der ASP.NET-Core-Anwendung aktivieren Sie sie:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
builder.Services.AddSystemWebAdapters();
// ...
app.UseSystemWebAdapters();
```

Eine Bibliothek, die `System.Web.HttpContext` entgegennahm, kompiliert weiter, nachdem Sie die `System.Web`-Referenz gegen das Adapter-Paket getauscht haben. Um innerhalb einer Anfrage zwischen den beiden Repräsentationen zu konvertieren, verwenden Sie die zwischengespeicherten Konvertierungen, was es Ihnen erlaubt, gezielte Aufrufstellen inkrementell neu zu schreiben:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
// Microsoft.AspNetCore.Http.HttpContext -> System.Web.HttpContext
System.Web.HttpContext legacy = coreContext.AsSystemWeb();
// System.Web.HttpContext -> Microsoft.AspNetCore.Http.HttpContext
HttpContext core = legacy.AsAspNetCore();
```

Die Adapter sind nicht kostenlos. Sie fügen gegenüber den nativen APIs Overhead hinzu, nicht jeder Member wird unterstützt, und zwei Verhaltensweisen müssen aktiviert werden, weil ASP.NET Core sie standardmäßig nicht bereitstellt: ein durchsuchbarer, vollständig gepufferter Anfrage-Stream (`PreBufferRequestStream`) und eine gepufferte Antwort (`BufferResponseStream`). Wenn eine Bibliothek den Body zweimal liest oder sich auf `Response.End()` verlässt, aktivieren Sie diese an den relevanten Endpunkten:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapDefaultControllerRoute()
   .PreBufferRequestStream()
   .BufferResponseStream();
```

## Verifizierung

Gehen Sie nach der Migration diese Liste durch:

- `dotnet build` meldet keine Warnungen zu `System.Web` in den Projekten, die Sie neu geschrieben haben.
- `dotnet test` besteht ohne übersprungene HTTP-Kontext-Tests.
- Ein Smoke-Test der Hot Paths: Anmeldung (Claims via `HttpContext.User`), ein Formular-POST, ein Datei-Download, ein Session-Hin-und-Zurück.
- Führen Sie einen kurzen Lasttest durch und achten Sie auf `ObjectDisposedException` oder `response has already started`. Diese beiden Ausnahmen sind die Signatur eines Bugs mit erfasstem Kontext oder eines verspäteten Header-Schreibens.

## Rollback

Dies ist eine Code-Migration, keine Daten-Migration, also ist der Rollback ein `git revert` des Branches. Das Einzige, worauf zu achten ist, ist das Format des Session-Zustands: Die Session von ASP.NET Core ist nicht wire-kompatibel mit der Session von ASP.NET Framework, also wenn Sie den Produktionsverkehr umgeleitet haben und Benutzer aktive Sessions haben, verwirft ein Rollback diese Sessions und erzwingt eine erneute Anmeldung. Lassen Sie sie auslaufen oder akzeptieren Sie das. Nichts anderes hier ist eine Einbahnstraße.

## Fallstricke, die man vor dem Start kennen sollte

- **Erfasster `HttpContext` in Hintergrundarbeit.** Der häufigste Produktionsfehler: Ein Controller startet `Task.Run(() => DoWork(HttpContext))`, und der Kontext ist bereits freigegeben, wenn `DoWork` ihn liest. Kopieren Sie zuerst, was Sie brauchen, in ein einfaches Objekt. Dies ist dieselbe Falle des freigegebenen Kontexts, die den `DbContext` von EF Core in Fire-and-Forget-Code beißt.
- **`accessor.HttpContext` ist außerhalb der Anfrage null.** In einem Hosted Service oder einer Startaufgabe gibt es keine Anfrage, also gibt der Accessor null zurück. Das ist korrekt, kein Bug. Hintergrunddienste haben ihr eigenes [Muster für Scoped Services](/de/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).
- **Den Body zweimal lesen.** `Request.Body` ist vorwärtsgerichtet. Wenn das Model Binding ihn bereits verbraucht hat, erhält ein späterer Lesevorgang nichts. Verwenden Sie `EnableBuffering()` oder das `PreBufferRequestStream` der Adapter. Synchrone Lesevorgänge werfen ebenfalls eine Ausnahme, es sei denn, Sie erlauben sie, was dieselbe Grundursache hinter der Ausnahme [synchronous operations are disallowed](/de/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/) ist.
- **Reihenfolge der DI-Registrierung.** Wenn ein Service, der `IHttpContextAccessor` benötigt, ihn nicht auflösen kann, haben Sie `AddHttpContextAccessor()` vergessen, was als der bekannte Fehler [unable to resolve service for type](/de/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) auftaucht.

Wenn Sie dies als Teil eines umfassenderen Framework-Umzugs tun, passt dies in die größere [Migration von .NET Framework 4.8 zu .NET 11](/de/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/), und Sie werden im selben Schritt wahrscheinlich auch das Hosting-Modell ersetzen, wenn Sie [von IWebHostBuilder zu WebApplication.CreateBuilder migrieren](/de/2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder/). Für die neuen Endpunkte, die während der Migration geschrieben werden, lohnt es sich, die Abwägungen von [Minimal APIs gegenüber Controllern](/de/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) abzuwägen, bevor Sie die alte Controller-Form wortwörtlich portieren.

## Quellen

- [HttpContext von ASP.NET Framework zu ASP.NET Core migrieren (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/http-context?view=aspnetcore-10.0)
- [System.Web-Adapter (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/inc/systemweb-adapters?view=aspnetcore-10.0)
- [Auf HttpContext in ASP.NET Core zugreifen (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/http-context?view=aspnetcore-10.0)
- [Migration des Session-Zustands von ASP.NET zu ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/areas/session?view=aspnetcore-9.0)
- [dotnet/systemweb-adapters (GitHub)](https://github.com/dotnet/systemweb-adapters)
