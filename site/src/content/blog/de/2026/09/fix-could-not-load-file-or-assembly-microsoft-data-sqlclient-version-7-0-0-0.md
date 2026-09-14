---
title: "Lösung: Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0' nach dem Update von EF Core"
description: "EF Core 11 ist gegen Microsoft.Data.SqlClient 7.0.0.0 kompiliert, aber beim Restore oder Deployment hat sich eine 6.x-Kopie durchgesetzt. Entfernen Sie den alten SqlClient-Pin und stellen Sie die vollständige Ausgabe neu bereit."
pubDate: 2026-09-14
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet"
  - "dotnet-11"
lang: "de"
translationOf: "2026/09/fix-could-not-load-file-or-assembly-microsoft-data-sqlclient-version-7-0-0-0"
translatedBy: "claude"
translationDate: 2026-09-14
---

**Kurze Antwort:** `Microsoft.EntityFrameworkCore.SqlServer` 11 (geprüft mit `11.0.0-rc.1.26425.128`, .NET 11 RC 1) ist gegen `Microsoft.Data.SqlClient, Version=7.0.0.0` kompiliert und benötigt das Paket 7.0.2 oder neuer. Die Exception bedeutet, dass der Prozess einen SqlClient 6.x gefunden hat oder gar keinen. Löschen Sie die übrig gebliebene Referenz auf `Microsoft.Data.SqlClient` 6.x (bzw. ihr `PackageVersion` in `Directory.Packages.props`), entfernen Sie jedes `NoWarn` für `NU1605`, kompilieren Sie neu und stellen Sie den gesamten Ausgabeordner neu bereit, `runtimes/` eingeschlossen.

Der Rest dieses Beitrags zeigt, woher die 6.x-Kopie stammt, wie Sie sie in weniger als einer Minute finden, und die zwei ähnlich aussehenden Fehler, die Leute zur falschen Lösung führen. Jedes Szenario unten wurde auf macOS mit dem .NET 11 RC 1 SDK (`11.0.100-rc.1.26425.128`) und SDK 10.0.302 reproduziert; eine Datenbank ist zum Auslösen nicht nötig.

## Der Fehler im Kontext

EF Core fasst SqlClient beim Registrieren des Kontexts nicht an. Das Laden passiert, wenn der Provider zum ersten Mal seine Type Mappings aufbaut, also bei der ersten Abfrage, bei `SaveChanges`, `MigrateAsync` oder `Database.GetDbConnection()`. Hier ist die Exception-Kette, die meine Reproduktion ausgegeben hat, die äußerste zuerst:

```text
System.TypeInitializationException: The type initializer for 'Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerTypeMappingSource' threw an exception.
System.TypeInitializationException: The type initializer for 'Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerVectorTypeMapping' threw an exception.
System.IO.FileNotFoundException: Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0, Culture=neutral, PublicKeyToken=23ec7fc2d6eaa4a5'. The system cannot find the file specified.
```

Wenn Ihre Logs nur die äußere `TypeInitializationException` zeigen, packen Sie `InnerException` zweimal aus. Die `FileNotFoundException` ganz unten ist der eigentliche Fehler.

Eine Sache sollten Sie vorab wissen: `Version=7.0.0.0` ist eine **Assembly**-Version, keine Paketversion. SqlClient fixiert `AssemblyVersion` für jedes Release einer Hauptversionslinie auf `Major.0.0.0`, daher liefert das Paket 7.0.3 eine DLL mit der Assembly-Version `7.0.0.0` (Dateiversion `7.0.3.26253`). Die Maintainer haben in [dotnet/SqlClient#4310](https://github.com/dotnet/SqlClient/issues/4310) bestätigt, dass das Absicht ist. Jedes 7.x-Paket erfüllt die Referenz. Sie müssen nicht nach "genau 7.0.0" suchen.

## Warum das passiert

Die Laufzeit bindet anhand der Assembly-Version, und sie geht nur vorwärts, nie zurück. Wenn EF Core 11 nach `7.0.0.0` fragt und die einzige `Microsoft.Data.SqlClient.dll` im Suchpfad ein 6.x-Build ist (Assembly-Version `6.0.0.0`), schlägt das Laden fehl. Es schlägt mit dem irreführenden "cannot find the file specified" fehl, selbst wenn eine 6.x-Datei genau an dem Pfad liegt, auf den die `.deps.json` verweist. Ich habe das ausdrücklich getestet: Wird die 6.1.6-DLL in der Ausgabe über die 7.0.2-DLL kopiert, entsteht exakt dieselbe Meldung.

Das ist es, wogegen jedes Paket kompiliert ist, direkt aus den Assembly-Metadaten der NuGet-Pakete gelesen:

| Paket | SqlClient-Paketabhängigkeit | Assembly-Referenz in der DLL |
| --- | --- | --- |
| `Microsoft.EntityFrameworkCore.SqlServer` 10.0.10, 10.0.11, 10.0.12 | `>= 6.1.x` (10.0.12: `>= 6.1.6`) | `Microsoft.Data.SqlClient 6.0.0.0` |
| `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 | `>= 7.0.2` | `Microsoft.Data.SqlClient 7.0.0.0` |

Unter EF Core 10 fragt der Provider selbst also nie nach 7.0.0.0. Unter EF Core 11 tut er es immer. Geordnet danach, wie oft ich sie sehe, sind das die Wege, auf denen sich trotzdem eine 6.x-Kopie durchsetzt:

1. **Eine übrig gebliebene direkte Referenz auf `Microsoft.Data.SqlClient` 6.x, bei der die Downgrade-Warnung unterdrückt ist.** Viele Projekte mit EF Core 8 bis 10 haben eine explizite SqlClient-Referenz hinzugefügt, um einen Fix oder Unterstützung für Entra ID zu bekommen. Nach dem EF-Update ist dieser Pin ein Downgrade. NuGet meldet ihn als `NU1605`, was das SDK als Fehler behandelt, es sei denn, das Projekt enthält wegen eines früheren Konflikts `<NoWarn>NU1605</NoWarn>`.
2. **Das Deployment lässt die DLL weg oder ersetzt sie.** SqlClient hat keine portable Implementierung. Die echten Assemblies liegen unter `runtimes/unix/lib/net9.0/` und `runtimes/win/lib/net9.0/`. Ein Dockerfile oder Kopierskript, das nur `*.dll` aus dem Stammverzeichnis von `bin/` übernimmt oder einen neuen Build über einen alten Ordner entpackt, hinterlässt die App ohne SqlClient 7.x.
3. **Ein Plug-in-Host lädt Ihre Datenschicht dynamisch.** Der Host-Prozess hat keinen `.deps.json`-Eintrag für SqlClient, daher kann sein Standard-Ladekontext die Abhängigkeiten des Plug-ins nicht auflösen.

## Minimale Reproduktion

Eine Konsolen-App, die unter EF Core 10 mit einem SqlClient-Pin lief und auf EF Core 11 RC 1 aktualisiert wurde. Das `NoWarn` ist die Zeile, die einen Build-Fehler in einen Absturz zur Laufzeit verwandelt:

```xml
<!-- .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <NoWarn>$(NoWarn);NU1605</NoWarn>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-rc.1.26425.128" />
    <PackageReference Include="Microsoft.Data.SqlClient" Version="6.1.6" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
using Microsoft.EntityFrameworkCore;

var options = new DbContextOptionsBuilder<ShopDb>()
    .UseSqlServer("Server=localhost;Database=Shop;User ID=sa;Password=x;TrustServerCertificate=True")
    .Options;

using var db = new ShopDb(options);
// Throws the FileNotFoundException above; no server connection is attempted.
Console.WriteLine(db.Database.GetDbConnection().GetType().Assembly.GetName());

class ShopDb(DbContextOptions<ShopDb> options) : DbContext(options);
```

Entfernen Sie die `NoWarn`-Zeile, dann bricht der Build stattdessen beim Restore ab, und genau das wollen Sie:

```text
error NU1605: Warning As Error: Detected package downgrade: Microsoft.Data.SqlClient from 7.0.2 to 6.1.6. Reference the package directly from the project to select a different version.
error NU1605:  app -> Microsoft.EntityFrameworkCore.SqlServer 11.0.0-rc.1.26425.128 -> Microsoft.Data.SqlClient (>= 7.0.2)
error NU1605:  app -> Microsoft.Data.SqlClient (>= 6.1.6)
```

Ohne den Pin gibt dasselbe Programm `Microsoft.Data.SqlClient, Version=7.0.0.0, Culture=neutral, PublicKeyToken=23ec7fc2d6eaa4a5` aus.

## Die Lösung im Detail

### 1. Herausfinden, wer die 6.x-Kopie mitbringt

Raten Sie nicht. Fragen Sie NuGet nach dem Abhängigkeitsgraphen des Startprojekts, nicht der Klassenbibliothek:

```bash
# .NET SDK 10.0.302 or .NET 11 RC 1 SDK
dotnet nuget why src/Shop.Api/Shop.Api.csproj Microsoft.Data.SqlClient
dotnet list src/Shop.Api/Shop.Api.csproj package --include-transitive
```

`dotnet nuget why` gibt pro Ziel-Framework einen Baum aus, sodass eine direkte 6.x-Referenz oder ein Paket, das eine solche mitzieht, auf einen Blick sichtbar ist. Prüfen Sie danach, was tatsächlich für die Laufzeit geschrieben wurde, denn das liest der Host:

```bash
# .NET 11 RC 1 SDK
grep -A3 '"Microsoft.Data.SqlClient/' src/Shop.Api/bin/Release/net11.0/Shop.Api.deps.json
```

Wenn die `.deps.json` `7.0.x` angibt und die App trotzdem fehlschlägt, liegt das Problem beim Deployment (Schritt 4), nicht beim Restore.

### 2. Den SqlClient-Pin entfernen oder anheben

Wenn nichts in Ihrem Code eine bestimmte SqlClient-Version braucht, löschen Sie die direkte Referenz und lassen Sie EF Core die Version mitbringen, gegen die es kompiliert wurde. Wenn Sie sie explizit behalten möchten, heben Sie sie auf das aktuelle 7.x an:

```xml
<!-- .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 -->
<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-rc.1.26425.128" />
  <!-- Was 6.1.6. Any 7.x works; 7.0.3 is the latest stable at the time of writing. -->
  <PackageReference Include="Microsoft.Data.SqlClient" Version="7.0.3" />
</ItemGroup>
```

Mit [Central Package Management](/de/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) und transitivem Pinning liegt der Pin in `Directory.Packages.props`, und der Restore-Fehler hat einen anderen Code:

```text
error NU1109: Detected package downgrade: Microsoft.Data.SqlClient from 7.0.2 to centrally defined 6.1.6. Update the centrally managed package version to a higher version.
```

Aktualisieren Sie den `PackageVersion`-Eintrag selbst:

```xml
<!-- .NET 11 RC 1, Directory.Packages.props -->
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-rc.1.26425.128" />
  <PackageVersion Include="Microsoft.Data.SqlClient" Version="7.0.3" />
</ItemGroup>
```

### 3. NU1605 nicht mehr unterdrücken

Durchsuchen Sie die Solution nach `NU1605` in `NoWarn`, einschließlich `Directory.Build.props`. Diese Unterdrückung ist der einzige Grund, warum das Problem bei einem normalen Build überhaupt bis zur Laufzeit gelangt. Ohne sie bekommt die nächste Person, die wieder ein Downgrade einführt, einen Restore-Fehler mit dem genauen Paketpfad statt eines Absturzes in Produktion.

### 4. Die gesamte Ausgabe neu bereitstellen, einschließlich `runtimes/`

Bei einem Framework-abhängigen Build ohne RID liegt die echte Implementierung von SqlClient unter `runtimes/<os>/lib/net9.0/`, und die `.deps.json` verweist dorthin. Ich habe genau diese eine Datei aus einem funktionierenden Build gelöscht und dieselbe `FileNotFoundException` bekommen, und das Löschen des ganzen `runtimes/`-Ordners bewirkt dasselbe. Wenn Ihr Dockerfile oder Ihre Pipeline selektiv kopiert, kopieren Sie stattdessen den vollständigen Publish-Ordner:

```dockerfile
# .NET 11 RC 1 images
FROM mcr.microsoft.com/dotnet/sdk:11.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish src/Shop.Api/Shop.Api.csproj -c Release -r linux-x64 --self-contained false -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:11.0
WORKDIR /app
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "Shop.Api.dll"]
```

Das Veröffentlichen mit einer RID (`-r linux-x64`) legt den plattformspezifischen SqlClient flach ins Stammverzeichnis neben `Microsoft.Data.SqlClient.Extensions.Abstractions.dll` und `Microsoft.Data.SqlClient.Internal.Logging.dll`, wodurch sich das Layout viel schwerer beschädigen lässt. Stellen Sie bei IIS, Azure App Service Zip Deploy oder xcopy-Deployments in einen sauberen Ordner bereit, damit eine 6.x-DLL aus dem vorherigen Release nicht neben der neuen `.deps.json` überleben kann. Wenn Sie unsicher sind, ob Sie die Ausgabe von `dotnet build` oder von `dotnet publish` ausliefern sollten, spielt [der Unterschied zwischen beiden](/de/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) hier eine Rolle.

### 5. Die Azure-Erweiterung hinzufügen, wenn Sie Entra ID verwenden

Der Wechsel auf SqlClient 7.0 ist in den [Breaking Changes von EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes) als Änderung mit mittlerer Auswirkung aufgeführt. Die Entra-ID-Authentifizierung (`Active Directory Default`, Managed Identity, Service Principal) wurde aus dem Kernpaket ausgelagert. Sobald der Ladefehler behoben ist, braucht ein Connection String, der sie verwendet, eine weitere Referenz:

```xml
<!-- .NET 11 RC 1, Microsoft.Data.SqlClient 7.x -->
<PackageReference Include="Microsoft.Data.SqlClient.Extensions.Azure" Version="7.0.3" />
```

Halten Sie dieses Paket auf derselben Version wie `Microsoft.Data.SqlClient`. Ab 7.0.2 werden SqlClient, `Extensions.Azure` und `Extensions.Abstractions` im Gleichschritt veröffentlicht, und SqlClient 7.0.2 verlangt `Extensions.Abstractions` im Bereich `[7.0.2, 8.0.0)`. NuGet hat keine Version 7.0.0 des Azure-Pakets: Die Versionen lauten 1.0.0, 7.0.2, 7.0.3, sodass ein aus einem Doku-Snippet kopiertes `Version="7.0.0"` nicht auf genau diese Version aufgelöst wird. Ohne das Paket wirft 7.0 einen verständlichen Fehler, der es beim Namen nennt, Sie müssen also nicht raten. Der [Migrationsleitfaden von EF Core 6 auf EF Core 11](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) behandelt das zusammen mit den anderen durch SqlClient bedingten Änderungen.

### 6. Plug-in-Hosts: über einen `AssemblyLoadContext` laden

Wenn ein Host ohne Referenz auf EF Core Ihre Datenschicht mit `Assembly.LoadFrom` lädt, hat der Standardkontext des Hosts keinen `.deps.json`-Eintrag für SqlClient. Die Antwort der Maintainer in [#4310](https://github.com/dotnet/SqlClient/issues/4310) ist das übliche Plug-in-Muster. Kompilieren Sie das Plug-in mit `<EnableDynamicLoading>true</EnableDynamicLoading>` und laden Sie es über einen Kontext, der die eigene `.deps.json` des Plug-ins liest:

```csharp
// .NET 11 RC 1
using System.Reflection;
using System.Runtime.Loader;

sealed class PluginLoadContext(string pluginPath) : AssemblyLoadContext(isCollectible: false)
{
    private readonly AssemblyDependencyResolver _resolver = new(pluginPath);

    protected override Assembly? Load(AssemblyName name)
    {
        var path = _resolver.ResolveAssemblyToPath(name);
        return path is null ? null : LoadFromAssemblyPath(path);
    }

    protected override IntPtr LoadUnmanagedDll(string unmanagedDllName)
    {
        var path = _resolver.ResolveUnmanagedDllToPath(unmanagedDllName);
        return path is null ? IntPtr.Zero : LoadUnmanagedDllFromPath(path);
    }
}

// var asm = new PluginLoadContext(pluginPath).LoadFromAssemblyPath(pluginPath);
```

In meinem Test schlug dasselbe Plug-in mit `Assembly.LoadFrom` fehl und lud `Microsoft.Data.SqlClient, Version=7.0.0.0` über diesen Kontext problemlos. Der Resolver ist gerade für SqlClient wichtig. Er bildet die Anfrage auf die richtige Datei unter `runtimes/<os>/` ab statt auf die Platzhalter-Assembly im Stammverzeichnis.

## Stolperfallen und ähnliche Fehler

**"Aber ich bin noch auf EF Core 10."** Dann ist es nicht EF, das nach 7.0.0.0 fragt. Die Provider-DLLs von 10.0.10 bis 10.0.12 referenzieren alle `6.0.0.0`. Deshalb wurde [dotnet/efcore#38845](https://github.com/dotnet/efcore/issues/38845), das diesen Fehler nach dem Wechsel von 10.0.10 auf 10.0.11 meldete, ohne Reproduktion geschlossen. Etwas anderes im Graphen ist gegen 7.x kompiliert. Aspire ist eine häufige Quelle. `Aspire.Microsoft.EntityFrameworkCore.SqlServer` 13.5.3 hängt gleichzeitig von `Microsoft.Data.SqlClient >= 7.0.1` und EF Core 10.0.11 ab, daher zeigt `dotnet nuget why` bei einem Aspire-Service SqlClient als 7.0.1 aufgelöst unter einer EF Core 10 App. Diese Kombination ist in Ordnung: EF Core 10.0.12 hat in meinem Test seine Type Mappings initialisiert und eine `SqlConnection` erstellt, sowohl mit SqlClient 7.0.0 als auch mit 7.0.3. Es bricht nur, wenn sich ein 6.x-Pin oder ein veraltetes Deployment durchsetzt, womit Sie wieder bei den Schritten 1 bis 4 sind.

**`Could not load type 'Microsoft.Data.SqlClient.SqlAuthenticationMethod' from assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0'`.** Das ist ein anderer Fehler mit derselben Versionszeichenkette. Die Datei wurde problemlos geladen, aber eine gegen 6.x kompilierte Bibliothek (SQL Server Management Objects 181.x war die häufigste) suchte nach einem Typ, den 7.0.0 nach `Microsoft.Data.SqlClient.Extensions.Abstractions` verschoben hat. SqlClient 7.0.1 hat Type Forwards für `SqlAuthenticationMethod`, `SqlAuthenticationProvider` und drei verwandte Typen hinzugefügt ([#4117](https://github.com/dotnet/SqlClient/pull/4117)), daher behebt ein Update von SqlClient auf 7.0.1 oder neuer das Problem.

**`PlatformNotSupportedException: Microsoft.Data.SqlClient is not supported on this platform.`** Die Datei wurde gefunden, aber es war die falsche. Die Assembly im Stamm-`lib/` des Pakets ist ein Platzhalter, und die funktionierende Implementierung liegt unter `runtimes/`. Mein Plug-in-Host stieß mit `Assembly.LoadFrom` genau darauf, weil der Stammordner des Plug-ins den Platzhalter enthielt. Die Lösung ist derselbe `AssemblyLoadContext` wie in Schritt 6 oder ein vollständiges Deployment mit den RID-spezifischen Assets.

**Ein anderer Assembly-Name in der Meldung.** Wenn der Fehler Ihre eigene Bibliothek oder ein anderes Paket nennt, gelten die SqlClient-Details oben nicht. Das allgemeine Vorgehen bei [einem "Could not load file or assembly"-Fehler in einer veröffentlichten App](/de/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) behandelt Host-Tracing und Trimming. Für die EF-Tooling-Variante eines Versionskonflikts, bei der `dotnet ef` statt Ihrer App fehlschlägt, siehe [die MissingMethodException nach dem Upgrade der EF Core Tools](/de/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/).

## Verwandte Beiträge

- [Eine .NET-Solution mit Directory.Packages.props auf Central Package Management migrieren](/de/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)
- [EF Core 6 auf EF Core 11 migrieren: die Breaking Changes, die wirklich wehtun](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [FileNotFoundException "Could not load file or assembly" in einer veröffentlichten App beheben](/de/2026/05/fix-could-not-load-file-or-assembly-in-published-app/)
- [Die native json-Spalte vs. nvarchar(max) in SQL Server mit EF Core 11](/de/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/), das `SqlDbType.Json` aus SqlClient 7 im Einsatz zeigt
- [Was ist der Unterschied zwischen dotnet build und dotnet publish](/de/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)

## Quellen

- [Breaking Changes in EF Core 11: Microsoft.Data.SqlClient wurde auf 7.0 aktualisiert](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes)
- [Release Notes zu Microsoft.Data.SqlClient 7.0.0](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.0.md) und [Release Notes zu 7.0.1](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.1.md)
- [dotnet/SqlClient#4310: Die Assembly-Version bleibt über alle 7.x-Versionen bei 7.0.0.0, Hinweise zum Laden von Plug-ins](https://github.com/dotnet/SqlClient/issues/4310)
- [dotnet/efcore#38845: die Meldung zu EF Core 10.0.11](https://github.com/dotnet/efcore/issues/38845)
- [dotnet/SqlClient#4064](https://github.com/dotnet/SqlClient/issues/4064) und [#4117](https://github.com/dotnet/SqlClient/pull/4117): die Type Forwards für `SqlAuthenticationMethod`
- [NuGet-Warnung NU1605](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1605) und [Fehler NU1109](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1109)
- [Eine .NET-Anwendung mit Plug-ins erstellen](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support) und [Standard-Probing](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/default-probing)
