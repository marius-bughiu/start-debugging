---
title: "Lösung: The antiforgery token could not be decrypted in ASP.NET Core"
description: "Der Fehler bedeutet, dass Data Protection den Schlüssel verloren hat, der das Token signiert hat. Persistieren Sie die Schlüssel in einem gemeinsamen, dauerhaften Speicher und rufen Sie SetApplicationName auf, damit jede Instanz denselben Schlüsselring liest."
pubDate: 2026-06-12
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet"
lang: "de"
translationOf: "2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-06-12
---

The antiforgery token could not be decrypted, weil der Data-Protection-Schlüssel, der es signiert hat, nicht mehr im Schlüsselring liegt, den Ihre Anwendung liest. Standardmäßig schreibt ASP.NET Core diese Schlüssel in einen maschinen- und benutzerspezifischen Ordner, der einen Neustart eines Containers nicht übersteht und nicht zwischen Instanzen geteilt wird. Persistieren Sie die Schlüssel in einem dauerhaften Speicher, den jede Instanz lesen kann (Dateifreigabe, Datenbank, Azure Blob, Redis), und fixieren Sie `SetApplicationName` überall auf denselben Wert. Das ist die vollständige Lösung. Der Rest dieses Artikels erklärt, warum es passiert, und den genauen Code für jeden Speicher.

Dies gilt für ASP.NET Core 11 (`.NET 11`), aber derselbe Data-Protection-Stack und dieselbe Lösung reichen bis ASP.NET Core 2.x zurück.

## Der Fehler im Kontext

Sie sehen einen davon, üblicherweise bei einem POST direkt nach einer Bereitstellung, einem Scale-out oder einem Container-Neustart:

```
Microsoft.AspNetCore.Antiforgery.AntiforgeryValidationException: The antiforgery token could not be decrypted.
 ---> System.Security.Cryptography.CryptographicException: The key {0cf0e637-...} was not found in the key ring.
   at Microsoft.AspNetCore.DataProtection.KeyManagement.KeyRingBasedDataProtector.UnprotectCore(...)
   at Microsoft.AspNetCore.Antiforgery.DefaultAntiforgeryTokenSerializer.Deserialize(String serializedToken)
```

Die innere Ausnahme ist der entscheidende Hinweis. `The key {guid} was not found in the key ring` bedeutet, dass das Token einen Schlüssel referenziert, den diese Instanz noch nie gesehen hat. Eine andere innere Meldung, `The payload was invalid`, deutet auf einen Schlüssel hin, der existiert, aber genau dieses Token nicht entschlüsseln kann, was üblicherweise bedeutet, dass zwei Anwendungen einen Schlüsselring ohne übereinstimmenden Anwendungsnamen teilen (mehr dazu unten).

In Blazor und Razor Pages zeigt sich dieselbe Ursache als HTTP 400 mit `Bad Request - antiforgery token validation failed`, und in MVC als Weiterleitungsschleife beim Login, weil das Antiforgery-Cookie niemals validiert werden kann.

## Warum das passiert

Antiforgery-Token werden von ASP.NET Core Data Protection verschlüsselt und signiert. Die Validierung funktioniert nur, wenn die Instanz, die das Token liest, noch den Schlüssel hält, der es geschrieben hat. Es gibt vier Wege, diesen Schlüssel zu verlieren:

- **Die Schlüssel sind flüchtig.** Ohne explizite Konfiguration persistiert Data Protection die Schlüssel in `%LOCALAPPDATA%\ASP.NET\DataProtection-Keys` (Windows) oder `$HOME/.aspnet/DataProtection-Keys` (Linux). In einem Container liegt dieser Pfad in der beschreibbaren Schicht und wird bei jedem Neustart gelöscht, sodass jeder neue Container einen frischen Schlüsselring erzeugt und jedes vom vorherigen ausgestellte Token ablehnt.
- **Sie haben horizontal skaliert.** Zwei oder mehr Instanzen hinter einem Load Balancer erzeugen jeweils ihren eigenen Schlüsselring. Ein von Instanz A ausgestelltes Token landet bei Instanz B, deren Ring den Schlüssel von A nicht enthält. Dies ist die häufigste Ursache in Produktion.
- **Die Identität hat sich geändert.** Unter IIS verschiebt ein Recycling des Anwendungspools oder ein Identitätswechsel den Schlüsselordner, weil der Standardpfad benutzergebunden ist. Bereitstellungsslots von Azure App Service haben denselben Effekt: Der Staging-Slot und der Produktions-Slot teilen keine Schlüssel, sofern Sie es nicht anweisen.
- **Zwei Anwendungen, ein Ring, kein Anwendungsname.** Wenn mehrere Anwendungen auf denselben Speicher zeigen, aber keinen übereinstimmenden `SetApplicationName` setzen, kollidieren ihre Token. Data Protection isoliert über einen Anwendungsdiskriminator, sodass eine Abweichung `The payload was invalid` erzeugt.

Die Standard-Lebensdauer der Schlüssel beträgt 90 Tage, sodass legitime Schlüsselrotation dies fast nie verursacht. Wenn Sie es sehen, fehlt der Schlüssel, er ist nicht abgelaufen.

## Minimale Reproduktion

Dies ist die kleinste Anwendung, die den Fehler über einen Neustart hinweg reproduziert. Führen Sie sie aus, senden Sie das Formular ab und starten Sie dann den Prozess neu, bevor Sie es erneut absenden.

```csharp
// .NET 11, ASP.NET Core 11
// No Data Protection configuration: keys are ephemeral.
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAntiforgery();
var app = builder.Build();

app.MapGet("/", (HttpContext ctx, IAntiforgery af) =>
{
    var tokens = af.GetAndStoreTokens(ctx);
    return Results.Content($"""
        <form action="/submit" method="post">
          <input name="{tokens.FormFieldName}" type="hidden" value="{tokens.RequestToken}" />
          <button type="submit">Submit</button>
        </form>
        """, "text/html");
});

app.MapPost("/submit", () => "OK").RequireAntiforgery();

app.Run();
```

Laden Sie `/`, kopieren Sie das gerenderte Formular, starten Sie die Anwendung neu und führen Sie dann ein POST des alten Formulars aus. Da der speicherinterne Schlüsselring beim Neustart neu erzeugt wurde, entschlüsselt das Token nicht mehr und Sie erhalten `AntiforgeryValidationException`. In einem einzelnen, langlebigen Prozess sehen Sie es nicht, was genau der Grund ist, warum dies durch lokale Tests rutscht und erst in Containern und Farmen zubeißt.

## Die Lösung im Detail

Wählen Sie den Speicher, der zu Ihrer Ausführungsumgebung passt. In jedem Fall lautet die Regel gleich: ein Ort, den alle Instanzen lesen und schreiben können, plus ein stabiler Anwendungsname.

### 1. Dateifreigabe (UNC oder eingehängtes Volume): am einfachsten für VMs und Bare Metal

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo(@"\\fileserver\dpkeys\myapp"))
    .SetApplicationName("MyApp");
```

In Kubernetes hängen Sie ein gemeinsames `PersistentVolume` (ReadWriteMany) ein und richten `PersistKeysToFileSystem` auf den Einhängepfad. Die Schlüssel überleben dann jeden einzelnen Pod. Dies ist die reibungsärmste Lösung, wenn Sie bereits gemeinsamen Speicher haben.

### 2. Datenbank über EF Core: keine zusätzliche Infrastruktur, wenn Sie bereits eine Datenbank haben

Fügen Sie das Paket [`Microsoft.AspNetCore.DataProtection.EntityFrameworkCore`](https://www.nuget.org/packages/Microsoft.AspNetCore.DataProtection.EntityFrameworkCore/) und einen Kontext hinzu, der `IDataProtectionKeyContext` implementiert:

```csharp
// .NET 11, EF Core 11
public class KeysDbContext : DbContext, IDataProtectionKeyContext
{
    public KeysDbContext(DbContextOptions<KeysDbContext> options) : base(options) { }
    public DbSet<DataProtectionKey> DataProtectionKeys => Set<DataProtectionKey>();
}
```

```csharp
// Program.cs
builder.Services.AddDbContext<KeysDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Keys")));

builder.Services.AddDataProtection()
    .PersistKeysToDbContext<KeysDbContext>()
    .SetApplicationName("MyApp");
```

Führen Sie einmal eine Migration aus, die die Tabelle `DataProtectionKeys` erstellt, und jede Instanz liest denselben Ring. Dies ist die Option, zu der ich am häufigsten greife, weil sie nichts benötigt, was die Anwendung nicht ohnehin schon hat.

### 3. Azure Blob Storage: die saubere Wahl für App Service und Azure Container Apps

Fügen Sie [`Azure.Extensions.AspNetCore.DataProtection.Blobs`](https://www.nuget.org/packages/Azure.Extensions.AspNetCore.DataProtection.Blobs) hinzu. Verwenden Sie eine verwaltete Identität statt einer Verbindungszeichenfolge:

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.AddDataProtection()
    .PersistKeysToAzureBlobStorage(
        new Uri("https://mystorage.blob.core.windows.net/dpkeys/keys.xml"),
        new DefaultAzureCredential())
    .SetApplicationName("MyApp");
```

Dies behebt auch die Variante mit Bereitstellungsslots: Wenn Staging und Produktion auf denselben Blob zeigen, macht ein Slot-Wechsel keine aktiven Sitzungen mehr ungültig. Für gestaffelte Sicherheit umschließen Sie es mit `ProtectKeysWithAzureKeyVault` (Paket [`Azure.Extensions.AspNetCore.DataProtection.Keys`](https://www.nuget.org/packages/Azure.Extensions.AspNetCore.DataProtection.Keys)), damit der Schlüsselring selbst im Ruhezustand verschlüsselt ist.

### 4. Redis: die geringste Latenz für große Farmen

Fügen Sie `Microsoft.AspNetCore.DataProtection.StackExchangeRedis` hinzu und verwenden Sie den Multiplexer wieder, den Sie bereits für Caching nutzen:

```csharp
// .NET 11, ASP.NET Core 11
var redis = ConnectionMultiplexer.Connect(builder.Configuration.GetConnectionString("Redis")!);
builder.Services.AddDataProtection()
    .PersistKeysToStackExchangeRedis(redis, "DataProtection-Keys")
    .SetApplicationName("MyApp");
```

Welchen Speicher Sie auch wählen, `SetApplicationName` ist in einem Szenario mit mehreren Anwendungen oder Slots nicht optional. Es legt den Anwendungsdiskriminator fest, den Data Protection in die Schlüsselableitung einmischt, und der Wert muss byteweise identisch über jede Instanz und jeden Slot sein, die den Token der jeweils anderen vertrauen sollen.

## Fallstricke und Varianten

**`The payload was invalid` statt `key not found`.** Der Schlüssel existiert, aber der Anwendungsdiskriminator weicht ab. Zwei Anwendungen teilen einen Speicher, und einer fehlt `SetApplicationName` oder sie hat einen anderen Wert. Setzen Sie in beiden denselben Namen. Dies ist auch der Grund, warum das Kopieren einer veröffentlichten Anwendung an einen neuen Content-Root-Pfad die Token brechen kann: ASP.NET Core leitet den Anwendungsnamen aus dem Content-Root-Pfad ab, wenn Sie keinen explizit setzen, sodass der Pfad selbst zum Diskriminator wird.

**Im Ruhezustand verschlüsselte Schlüssel, die andere Instanzen nicht lesen können.** Unter Windows verschlüsselt Data Protection den Schlüsselring standardmäßig mit DPAPI, gebunden an den aktuellen Benutzer oder die aktuelle Maschine. Ein unter einer Identität geschriebener Schlüssel ist unter einer anderen nicht lesbar, was dasselbe Symptom erzeugt, obwohl die Schlüssel physisch vorhanden sind. Wenn Sie Schlüssel über Maschinen hinweg teilen, deaktivieren Sie entweder die maschinengebundene Verschlüsselung oder verwenden Sie einen expliziten, portablen Schutz wie `ProtectKeysWithCertificate`.

**Es funktioniert lokal, scheitert im Container.** Erwartungsgemäß. Ein einzelner Prozess auf Ihrer Entwicklungsmaschine hält seinen flüchtigen Ring für die gesamte Sitzung im Speicher, sodass das Token immer entschlüsselt. Der Fehler tritt erst auf, sobald eine zweite Instanz oder ein Neustart ins Spiel kommt. Reproduzieren Sie ihn, indem Sie zwei Instanzen lokal auf verschiedenen Ports ohne etwas davor ausführen oder zwischen Anfragen neu starten, wie in der obigen Reproduktion.

**„Beheben" Sie es nicht durch Deaktivieren von Antiforgery.** Das Entfernen von `[ValidateAntiForgeryToken]` oder `.RequireAntiforgery()` lässt den Fehler verschwinden und öffnet ein CSRF-Loch erneut. Das Token tut seine Arbeit. Persistieren Sie stattdessen die Schlüssel.

**`DisableAutomaticKeyGeneration` auf schreibgeschützten Replikaten.** Wenn Sie einen Worker betreiben, der Schlüssel konsumieren, aber niemals erzeugen soll, rufen Sie `DisableAutomaticKeyGeneration()` auf, damit er keinen konkurrierenden Schlüssel im gemeinsamen Ring erstellt. Lassen Sie es auf der Instanz aus, die die Rotation besitzt.

## Verwandte Lektüre

- [.NET 10.0.7 erscheint außer der Reihe, um CVE-2026-40372 in ASP.NET Core Data Protection zu beheben](/de/2026/04/dotnet-10-0-7-oob-cve-2026-40372-dataprotection/) behandelt einen HMAC-Validierungsfehler im selben Stack und warum Sie Ihren Schlüsselring gepatcht haben wollen.
- [Refresh-Token in ASP.NET Core Identity implementieren](/de/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) stützt sich für dieselbe Verschlüsselungspipeline auf Data Protection.
- [Blazor-Formulare mit statischem SSR erhalten clientseitige Validierung in .NET 11 Preview 5](/de/2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5/) ist der Ort, an dem Antiforgery-Token in statisch gerenderten Blazor-Formularen auftauchen.
- [Zustand über die statisch-zu-interaktiv-Renderinggrenze von Blazor in .NET 11 hinweg persistieren](/de/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) behandelt die verwandte Klasse von „Zustand über eine Grenze verloren"-Fehlern.
- [Einen globalen Ausnahmefilter in ASP.NET Core 11 hinzufügen](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) hilft Ihnen, diese Ausnahme sauber auszugeben statt als nacktes 400.

## Quellen

- [Configure ASP.NET Core Data Protection](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/configuration/overview?view=aspnetcore-11.0) - die genauen APIs `PersistKeysTo*`, `ProtectKeysWith*` und `SetApplicationName` sowie die Paketnamen.
- [Key storage providers in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/implementation/key-storage-providers?view=aspnetcore-11.0) - Anbieter für Dateisystem, Azure Blob, Redis und EF Core.
- [Data Protection key management and lifetime](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/configuration/default-settings?view=aspnetcore-11.0) - Standard-Lebensdauer von 90 Tagen und Standard-Speicherorte.
- [dotnet/aspnetcore #47185: The antiforgery token could not be decrypted](https://github.com/dotnet/aspnetcore/issues/47185) - reale Meldungen und Hinweise der Maintainer.
