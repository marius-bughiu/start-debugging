---
title: "WebApplication.CreateBuilder vs CreateSlimBuilder vs CreateEmptyBuilder in ASP.NET Core 11"
description: "Verwenden Sie CreateBuilder für eine normale App, CreateSlimBuilder, wenn Sie getrimmt oder mit Native AOT hinter einem TLS-Proxy veröffentlichen, und CreateEmptyBuilder nur, wenn Sie jeden Dienst selbst registrieren möchten. Hier ist die Feature-Matrix samt der Stolperfallen, die die Entscheidung erzwingen."
pubDate: 2026-07-23
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet-11"
  - "native-aot"
  - "csharp"
lang: "de"
translationOf: "2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-23
---

Für eine normale ASP.NET Core 11 Web-App verwenden Sie `WebApplication.CreateBuilder(args)`. Es ist nicht ohne Grund die Standardwahl: Es verdrahtet jede Hosting-Funktion, die Sie erwarten. Wechseln Sie nur dann zu `WebApplication.CreateSlimBuilder(args)`, wenn Sie mit Trimming oder Native AOT veröffentlichen und hinter einem TLS-terminierenden Proxy laufen, denn es entfernt HTTPS, HTTP/3, die IIS-Integration, statische Web-Assets und zwei Logging-Provider, um die Binärdatei zu verkleinern. Greifen Sie nur in dem seltenen Fall zu `WebApplication.CreateEmptyBuilder(...)`, in dem Sie eine nahezu leere Grundlage möchten und den Server, das Routing und die Konfiguration selbst registrieren. Dieser Beitrag zielt auf .NET 11 (zum Zeitpunkt des Schreibens Preview 6, GA im November 2026) mit `Microsoft.NET.Sdk.Web` und C# 14, aber alle drei Factory-Methoden existieren seit .NET 8, sodass die Empfehlung auf .NET 8 bis 11 unverändert gilt.

## Was "Standards" hier tatsächlich bedeutet

Die drei Methoden unterscheiden sich in genau einer Sache: wie viel sie in den `WebApplicationBuilder` registrieren, bevor Ihr Code läuft. Alles andere, die `builder.Services` Sammlung, `builder.Build()`, `app.MapGet(...)`, ist identisch. Die gesamte Entscheidung läuft also darauf hinaus, welche Standards Sie geliefert bekommen möchten und welche Sie bereit sind, von Hand nachzurüsten.

`CreateBuilder` gibt Ihnen den vollständigen Standard-Host. `CreateSlimBuilder` gibt Ihnen eine kuratierte Teilmenge, die auf Trim-Sicherheit und geringe Größe ausgelegt ist. `CreateEmptyBuilder` gibt Ihnen fast nichts und erwartet, dass Sie sich für jeden Baustein einzeln entscheiden. Intern teilen sie sich sogar die Maschinerie: `CreateSlimBuilder` baut auf demselben leeren Host-Application-Builder auf, den `CreateEmptyBuilder` bereitstellt, und fügt dann die schlanke Menge an Diensten darüber wieder hinzu. Deshalb ist die untenstehende Reihenfolge eine strikte Obermengenkette: `CreateBuilder` enthält alles, was `CreateSlimBuilder` enthält, was wiederum alles enthält, was `CreateEmptyBuilder` enthält.

## Feature-Matrix

Jede Zeile ist gegen die ASP.NET Core 11 Dokumentation und den `WebApplication.cs` Quellcode verifiziert. "Manuell" bedeutet, dass die Funktion nicht für Sie registriert wird, Sie sie aber mit dem angegebenen Aufruf hinzufügen können.

| Funktion                                   | CreateBuilder | CreateSlimBuilder             | CreateEmptyBuilder            |
| ------------------------------------------ | ------------- | ----------------------------- | ----------------------------- |
| appsettings.json + appsettings.{env}.json  | ja            | ja                            | manuell                       |
| User Secrets (Development)                 | ja            | ja                            | manuell                       |
| Umgebungsvariablen- + Kommandozeilenkonfiguration | ja     | ja                            | manuell                       |
| Console-Logging                            | ja            | ja                            | manuell (`AddConsole`)        |
| Debug / EventSource / EventLog Logging     | ja            | nein                          | nein                          |
| Kestrel-Server                             | vollständig   | Kern (`UseKestrelCore`)       | manuell (`UseKestrelCore`)    |
| HTTPS-Endpunkte in Kestrel                 | ja            | nein (`UseKestrelHttpsConfiguration`) | manuell                 |
| HTTP/3 (QUIC)                              | ja            | nein (`UseQuic`)              | manuell                       |
| IIS-Integration                            | ja            | nein                          | nein                          |
| Statische Web-Assets                       | ja            | nein                          | nein                          |
| Hosting-Startup-Assemblies / `UseStartup`  | ja            | nein                          | nein                          |
| Regex- und Alpha-Routing-Constraints       | ja            | nein                          | nein                          |
| Routing / `MapGet` usw.                    | ja            | ja                            | manuell                       |

Die wichtigste Erkenntnis aus dieser Tabelle: `CreateSlimBuilder` behält weiterhin Ihre Konfigurationsquellen und das Console-Logging. Es entfernt nicht die Dinge, die Sie täglich nutzen. Es entfernt Protokoll- und Plattformfunktionen, die eine cloud-native, mit Proxy vorgeschaltete Bereitstellung normalerweise nicht benötigt, sowie drei Logging-Provider, die Sie in der Produktion selten lesen.

## Wann Sie CreateBuilder wählen sollten

Dies ist der Standard, und für die meisten Apps sollte es der Standard bleiben.

- **Sie stellen auf IIS oder IIS Express bereit oder Sie laufen unter Windows und lesen das Windows EventLog.** Beides wird nur von `CreateBuilder` verdrahtet. `CreateSlimBuilder` hat keine IIS-Integration, sodass eine In-Process-IIS-Bereitstellung schlicht nicht korrekt hosten wird.
- **Sie liefern statische Web-Assets aus Razor Class Libraries aus oder verwenden `UseStaticWebAssets`.** Blazor- und MVC-UI-Apps hängen davon ab. Der Slim-Builder registriert es nicht, und der Fehlermodus ist fehlendes CSS/JS ohne offensichtlichen Fehler.
- **Sie verwenden `{id:regex(...)}` oder `{name:alpha}` Route-Constraints.** Diese werden im Slim-Builder ausgelassen, um rund ein Megabyte an Binärgröße zu sparen. `{id:int}` und andere primitive Constraints sind in Ordnung; Regex und Alpha sind die beiden, die verschwinden.
- **Sie veröffentlichen überhaupt nicht getrimmt oder mit AOT.** Wenn Sie einen normalen Framework-abhängigen oder eigenständigen JIT-Build ausliefern, bringt Ihnen der Slim-Builder zur Laufzeit fast nichts. Die Gewinne bei Binärgröße und Startzeit stammen von Trimming und AOT, nicht von der Builder-Wahl allein. Slim hier zu wählen bedeutet nur, HTTPS und Konsorten ohne Gegenleistung wieder hinzuzufügen.

## Wann Sie CreateSlimBuilder wählen sollten

`CreateSlimBuilder` wurde in .NET 8 speziell eingeführt, um der Standard für das Native AOT Web API Template (`dotnet new webapiaot`) zu sein. Wählen Sie es, wenn das Folgende Ihre Bereitstellung beschreibt.

- **Sie veröffentlichen mit `<PublishAot>true</PublishAot>` oder aggressivem Trimming (`<PublishTrimmed>true</PublishTrimmed>`).** Der Slim-Builder vermeidet es, Trim-unfreundliche Codepfade in den Graphen zu ziehen, was Warnungen niedrig und die Ausgabe klein hält. Siehe [wie man Native AOT mit ASP.NET Core Minimal APIs verwendet](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) für das vollständige AOT-Setup, für das dieser Builder ausgelegt ist.
- **Sie laufen hinter einem TLS-terminierenden Proxy oder Ingress (Nginx, Caddy, YARP, Azure Application Gateway).** Der Proxy übernimmt HTTPS, sodass Ihr Prozess, der auf einfachem HTTP lauscht, genau richtig ist. Das ist die Annahme, die der Slim-Builder einbackt, indem er die HTTPS-Konfiguration von Kestrel entfernt.
- **Sie möchten das kleinstmögliche sinnvolle Container-Image für einen Minimal-API-Microservice.** In Kombination mit Trimming und AOT erzeugt der Slim-Builder eine einzelne kleine native ausführbare Datei mit einer winzigen Angriffsfläche.

Wenn Sie Slim wählen und später feststellen, dass Sie doch HTTPS oder HTTP/3 benötigen, müssen Sie nicht den Builder wechseln. Fügen Sie sie explizit wieder hinzu:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateSlimBuilder(args);

// Re-enable HTTPS endpoints that CreateSlimBuilder omits by default.
builder.WebHost.UseKestrelHttpsConfiguration();

// Re-enable HTTP/3 (QUIC) if a client actually needs it.
builder.WebHost.UseQuic();

var app = builder.Build();
app.MapGet("/", () => "Hello from a slim host");
app.Run();
```

## Wann Sie CreateEmptyBuilder wählen sollten

`CreateEmptyBuilder(WebApplicationOptions)` erstellt einen Builder ganz ohne eingebautes Verhalten. Die App, die er baut, enthält nur die Dienste und Middleware, die Sie explizit konfigurieren. Dies ist ein Spezialwerkzeug, kein allgemeiner Standard. Greifen Sie dazu, wenn Sie den kleinstmöglichen Dienst bauen und jede Registrierung kontrollieren möchten, oder wenn Sie damit experimentieren, wie wenig ASP.NET Core genau benötigt, um eine Anfrage zu bedienen.

Hier ist das kanonische minimale Beispiel aus den .NET 8 Release Notes, das auf .NET 11 immer noch unverändert kompiliert:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateEmptyBuilder(new WebApplicationOptions());

// Nothing is registered by default, so add the server yourself.
builder.WebHost.UseKestrelCore();

var app = builder.Build();

app.Use(async (context, next) =>
{
    await context.Response.WriteAsync("Hello, World!");
    await next(context);
});

Console.WriteLine("Running...");
app.Run();
```

Beachten Sie, was fehlt und von Hand hinzugefügt werden müsste, wenn Sie es benötigten: Es gibt kein Laden von `appsettings.json`, kein Console-Logging, kein Routing (also kein `MapGet`; Sie schreiben stattdessen rohe Middleware) und keine Konfigurationsbindung. Sie fügen jedes mit einem expliziten Aufruf hinzu: `builder.Configuration.AddJsonFile("appsettings.json")`, `builder.Logging.AddConsole()`, `builder.Services.AddRouting()` und so weiter. Genau das ist der Sinn des leeren Builders: Sie zahlen für genau das, was Sie nutzen.

## Die Größenfrage, und warum es eine Trimming-Frage ist

Der Grund, warum alle drei existieren, ist Binärgröße und Startzeit für Native AOT, nicht der reine Anfragendurchsatz. Bei einer JIT-kompilierten App registrieren die drei Builder unterschiedliche Dienstgraphen, aber sobald die App warm ist, liegt der Unterschied bei den Anfragen pro Sekunde nicht dort, wo der Wert steckt. Der Wert zeigt sich, wenn Sie trimmen und AOT-kompilieren.

Microsofts eigener Benchmark für das Native AOT Web API Template vergleicht eine Native-AOT-Veröffentlichung mit einem getrimmten Laufzeit-Build und einem ungetrimmten Laufzeit-Build und berichtet, dass die AOT-App von den dreien die geringste App-Größe, den geringsten Speicherverbrauch und die kürzeste Startzeit hat. Die .NET 8 Release Notes liefern einen konkreten Anker für das leere Ende des Spektrums: Das `CreateEmptyBuilder` "Hello, World"-Beispiel oben, mit Native AOT auf einer linux-x64-Maschine veröffentlicht, erzeugte eine eigenständige native ausführbare Datei von etwa 8,5 MB. Diese Zahl ist es, wie eine nahezu leere Grundlage aussieht, sobald AOT und Trimming ihre Arbeit tun.

Die praktische Reihenfolge, vom größten zum kleinsten veröffentlichten Footprint, ist `CreateBuilder`, dann `CreateSlimBuilder`, dann `CreateEmptyBuilder`. Aber die Lücke zwischen ihnen öffnet sich nur unter `PublishAot` oder `PublishTrimmed`. Liefern Sie einen einfachen Build aus, und Sie haben die Zeremonie des Slim- oder leeren Builders bezahlt, ohne die Belohnung einzustreichen. Das ist der mit Abstand häufigste Fehler: den Slim-Builder für eine normale Bereitstellung zu wählen, weil "Slim klingt schneller". Er ist zur Laufzeit nicht schneller; er ist getrimmt kleiner. Wenn Sie nicht trimmen, lohnt es sich, [was Native AOT Sie tatsächlich kostet](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) zu lesen, bevor Sie sich auf den Slim-Pfad festlegen, und [Native AOT vs ReadyToRun vs JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) behandelt, wo jeder Veröffentlichungsmodus gewinnt.

## Die Stolperfalle, die für Sie entscheidet

Präferenz entscheidet das selten. Eines von diesen tut es meist.

- **In-Process-IIS-Hosting erzwingt `CreateBuilder`.** Keine IIS-Integration bedeutet kein In-Process-Modul. Wenn Ihr Host IIS ist, ist die Entscheidung getroffen.
- **Statische Web-Assets erzwingen `CreateBuilder`.** Eine Blazor- oder Razor-UI-App, die `UseStaticWebAssets` verliert, liefert kaputtes Styling ohne Exception beim Start aus. Dieser beißt still, behandeln Sie also jede UI-App als `CreateBuilder`-App, es sei denn, Sie haben einen konkreten Grund dagegen.
- **Regex- oder Alpha-Route-Constraints erzwingen `CreateBuilder`.** Wenn Ihre Routing-Tabelle `{code:regex(^[A-Z]{3}$)}` oder `{slug:alpha}` enthält, wird der Slim-Builder diese Constraints nicht auflösen. Primitive Constraints wie `:int`, `:guid` und `:datetime` sind unbetroffen.
- **AOT plus ein TLS-Proxy erzwingt `CreateSlimBuilder`.** Wenn Sie AOT für einen mit Proxy vorgeschalteten Microservice veröffentlichen, ist Slim der beabsichtigte Standard, und dagegen anzukämpfen, indem Sie mit `CreateBuilder` beginnen, zieht Trim-unfreundlichen Code zurück in den Graphen.
- **MVC-Controller schließen AOT gänzlich aus, was die ganze Frage verändert.** MVC ist nicht Native-AOT-kompatibel, wenn Sie also Controller benötigen, gehen Sie ohnehin nicht voll AOT, und der Hauptvorteil des Slim-Builders verpufft. Siehe [Minimal APIs vs Controller in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/), falls Sie diese Wahl noch abwägen.

## Die Entscheidung, noch einmal formuliert

Wählen Sie standardmäßig `CreateBuilder`. Es ist die richtige Wahl für die überwältigende Mehrheit der ASP.NET Core 11 Apps, einschließlich jeder App, die IIS, statische Web-Assets, MVC, Blazor oder Regex-Route-Constraints verwendet. Wechseln Sie zu `CreateSlimBuilder`, wenn und nur wenn Sie getrimmt oder mit Native AOT veröffentlichen und hinter einem TLS-terminierenden Proxy sitzen, was genau das Szenario ist, auf das das `webapiaot` Template abzielt; fügen Sie HTTPS oder HTTP/3 mit einem einzigen `UseKestrelHttpsConfiguration()` oder `UseQuic()` Aufruf wieder hinzu, falls Sie sie benötigen. Behalten Sie `CreateEmptyBuilder` für den wirklich minimalen Dienst in der Hinterhand, bei dem Sie jedes einzelne Teil selbst registrieren und die Untergrenze messen möchten. Das Einzige, was Sie nicht tun sollten, ist, den Slim- oder leeren Builder für eine normale JIT-Bereitstellung zu wählen, mit der Theorie, dass er schneller sei. Er ist getrimmt kleiner, nicht laufend schneller, und bei einem normalen Build bekommen Sie die Reibung ohne die Gegenleistung. Wenn Sie überhaupt erst einen älteren Host auf dieses Modell migrieren, ist die [Migration von IWebHostBuilder zu WebApplication.CreateBuilder](/2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder/) die Hürde, die Sie nehmen müssen, bevor Sie optimieren, welche Factory-Methode Sie aufrufen.

## Verwandt

- [Wie man Native AOT mit ASP.NET Core Minimal APIs verwendet](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)
- [Migration von IWebHostBuilder zu WebApplication.CreateBuilder in .NET 11](/2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [Was ist Native AOT und was kostet es Sie?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Minimal APIs vs Controller in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Quellen

- [WebApplication.CreateSlimBuilder Method (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.builder.webapplication.createslimbuilder)
- [ASP.NET Core support for Native AOT: Compare CreateSlimBuilder and CreateBuilder (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot)
- [What's new in ASP.NET Core in .NET 8: New CreateEmptyBuilder method (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-8.0#new-createemptybuilder-method)
- [Andrew Lock: Comparing WebApplication.CreateBuilder to the new CreateSlimBuilder method](https://andrewlock.net/exploring-the-dotnet-8-preview-comparing-createbuilder-to-the-new-createslimbuilder-method/)
