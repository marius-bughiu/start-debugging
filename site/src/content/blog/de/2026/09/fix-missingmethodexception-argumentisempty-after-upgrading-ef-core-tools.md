---
title: "Fix: MissingMethodException 'AbstractionsStrings.ArgumentIsEmpty' nach dem Upgrade der EF Core Tools"
description: "dotnet ef wirft MissingMethodException bei ArgumentIsEmpty, weil Tools 10.0.6 kein passendes Microsoft.EntityFrameworkCore.Design mehr mitzieht. Design explizit auf Ihre EF Core Version fixieren."
pubDate: 2026-09-08
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "entity-framework"
  - "dotnet"
  - "dotnet-10"
  - "nuget"
lang: "de"
translationOf: "2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools"
translatedBy: "claude"
translationDate: 2026-09-08
---

Fügen Sie im **Startprojekt** eine explizite `PackageReference` auf `Microsoft.EntityFrameworkCore.Design` hinzu, fixiert auf dieselbe Version wie Ihre übrigen EF Core Pakete, und stellen Sie danach wieder her. `Microsoft.EntityFrameworkCore.Tools` 10.0.6, 10.0.7 und 10.0.8 haben ihre Abhängigkeit auf Design auf `>= 8.0.0` gesenkt, also löst NuGet bereitwillig Design 8.0.0 neben einer EF Core 10 Runtime auf, und die Design-Time-Assembly ruft eine Methode auf, die es nicht mehr gibt. Ein Upgrade der Tools auf 10.0.9 oder neuer behebt es ebenfalls, denn 10.0.9 hat die Versionsangleichung pro Framework wiederhergestellt.

## Der Fehler im Kontext

`dotnet ef migrations add` gegen einen kaputten Paketgraphen:

```
Build started...
Build succeeded.
System.MissingMethodException: Method not found: 'System.String Microsoft.EntityFrameworkCore.Diagnostics.AbstractionsStrings.ArgumentIsEmpty(System.Object)'.
   at Microsoft.EntityFrameworkCore.Utilities.Check.NotEmpty(String value, String parameterName)
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.AddMigrationImpl(String name, String outputDir, String contextType, String namespace)
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.AddMigration.<>c__DisplayClass0_0.<.ctor>b__0()
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.OperationBase.<>c__DisplayClass3_0`1.<Execute>b__0()
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.OperationBase.Execute(Action action)
Method not found: 'System.String Microsoft.EntityFrameworkCore.Diagnostics.AbstractionsStrings.ArgumentIsEmpty(System.Object)'.
```

Derselbe Paketgraph erzeugt bei `dotnet ef database update` oder `dotnet ef migrations list` eine völlig andere Ausnahme:

```
System.TypeLoadException: Method 'Identifier' in type 'Microsoft.EntityFrameworkCore.Design.Internal.CSharpHelper' from assembly 'Microsoft.EntityFrameworkCore.Design, Version=8.0.26.0, Culture=neutral, PublicKeyToken=adb9793829ddae60' does not have an implementation.
   at Microsoft.EntityFrameworkCore.Design.DesignTimeServiceCollectionExtensions.<>c__DisplayClass0_0.<AddEntityFrameworkDesignTimeServices>b__0(ServiceCollectionMap services)
   at Microsoft.EntityFrameworkCore.Infrastructure.EntityFrameworkServicesBuilder.TryAddProviderSpecificServices(Action`1 serviceMap)
```

In der Package Manager Console von Visual Studio zeigt sich dasselbe bei `Add-Migration` und `Update-Database`. Beide Meldungen haben eine einzige Ursache. Die `TypeLoadException` ist die nützlichere von beiden, weil sie die Version der schuldigen Assembly direkt in der Meldung ausgibt.

## Warum das passiert

`Microsoft.EntityFrameworkCore.Design` ist die Assembly, die das Scaffolding von Migrationen und das Reverse Engineering tatsächlich implementiert. Weder `dotnet ef` noch die Package Manager Console liefern sie mit: sie laden sie aus dem aufgelösten Abhängigkeitsgraphen Ihres Startprojekts. Die Design-Version ist damit die, die NuGet ausgewählt hat, und NuGet wählt die niedrigste Version, die alle Einschränkungen erfüllt.

Bis 10.0.5 deklarierte `Microsoft.EntityFrameworkCore.Tools` eine Abhängigkeit auf `Microsoft.EntityFrameworkCore.Design` mit einer Untergrenze gleich der eigenen Version, eine Referenz auf Tools reichte also, um ein passendes Design mitzuziehen. In 10.0.6 sank diese Untergrenze auf `8.0.0`. Die Änderung lässt sich direkt aus dem NuGet-Katalog ablesen:

| Tools Version | Veröffentlicht | Design-Abhängigkeit |
| --- | --- | --- |
| 10.0.5 | 2026-03-12 | `net8.0` -> `[10.0.5, )` |
| 10.0.6 | 2026-04-14 | `net8.0` -> `[8.0.0, )` |
| 10.0.7 | 2026-04-21 | `net8.0` -> `[8.0.0, )` |
| 10.0.8 | 2026-05-12 | `net8.0` -> `[8.0.0, )` |
| 10.0.9 | 2026-06-09 | `net8.0` -> `[8.0.26, )`, `net9.0` -> `[9.0.15, )`, `net10.0` -> `[10.0.9, )` |
| 10.0.10 | 2026-07-14 | gleiche Form, `net10.0` -> `[10.0.10, )` |
| 10.0.11 | 2026-08-11 | gleiche Form, `net10.0` -> `[10.0.11, )` |

Der Grund für die Änderung in 10.0.6 war berechtigt. Das Tools-Paket zielt auf `net8.0` und soll aus `net8.0`, `net9.0` und `net10.0` Projekten nutzbar sein, aber Design 10.0.x liefert nur ein `net10.0` Asset, sodass eine einzelne hohe Untergrenze die Wiederherstellung für Projekte auf älteren Frameworks brach. Die Absenkung auf `8.0.0` reparierte die Wiederherstellung und brach alle, deren EF Core Runtime 9.x oder 10.x war, weil eine einzelne `net8.0` Abhängigkeitsgruppe für jedes konsumierende Framework gilt. Tools 10.0.9 löste das sauber mit drei Abhängigkeitsgruppen, einer pro Zielframework.

Der Fehler ist ein reiner Bruch der Binärkompatibilität. `Check.NotEmpty` ruft in EF Core 10 `AbstractionsStrings.ArgumentIsEmpty(object)` auf; die 8.x und 9.x Builds dieser Ressourcenklasse haben eine andere Signatur. Der JIT löst den Aufruf bei der ersten Ausführung von `AddMigrationImpl` auf und wirft.

## Minimale Reproduktion

Zwei Paketreferenzen und ein `DbContext` genügen. Das ist das gesamte Projekt, verifiziert auf SDK 10.0.302 mit `dotnet-ef` 10.0.11 am 2026-09-08:

```xml
<!-- SDK 10.0.302. Reproduces the failure exactly as written. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.11" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Tools" Version="10.0.6" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 10, EF Core 10.0.11
using Microsoft.EntityFrameworkCore;

public class Blog { public int Id { get; set; } public string Name { get; set; } = ""; }

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    protected override void OnConfiguring(DbContextOptionsBuilder o)
        => o.UseSqlite("Data Source=app.db");
}
```

Nach `dotnet restore` sieht der Graph so aus:

```
$ dotnet list package --include-transitive
   > Microsoft.EntityFrameworkCore              10.0.11
   > Microsoft.EntityFrameworkCore.Abstractions 10.0.11
   > Microsoft.EntityFrameworkCore.Design       8.0.0
```

Alles auf Runtime-Seite ist 10.0.11 und die Design-Time-Assembly ist 8.0.0. `dotnet ef migrations add Initial` schlägt dann fehl.

## Der Fix im Detail

### 1. Design explizit im Startprojekt fixieren

Das ist der vom EF-Team empfohlene Fix und derjenige, der weiter funktioniert, egal was künftige Tools-Releases deklarieren:

```xml
<!-- SDK 10.0.302, EF Core 10.0.11. Version must match your other EF Core packages. -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.11">
  <PrivateAssets>all</PrivateAssets>
  <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
</PackageReference>
```

`PrivateAssets=all` hält die Design-Time-Assembly aus Ihrer veröffentlichten Ausgabe heraus, und deshalb lohnt es sich, den Metadatenblock auszuschreiben statt die einzeilige Kurzform zu nehmen. Damit funktioniert `dotnet ef migrations add Initial` selbst dann, wenn Tools noch auf 10.0.6 steht.

Das Wort **Startprojekt** ist entscheidend. `dotnet ef` kompiliert und lädt das Startprojekt, nicht das Projekt mit Ihrem `DbContext`. In einer Solution, in der `Data` den Kontext hält und `Api` der Einstiegspunkt ist, bringt eine Fixierung in `Data` nichts, weil `PrivateAssets=all` den Fluss über die Projektreferenz unterbindet:

```
$ dotnet list Api/Api.csproj package --include-transitive | grep Design
   > Microsoft.EntityFrameworkCore.Design       8.0.0
```

Der Befehl schlägt weiterhin mit derselben `MissingMethodException` fehl. Verschieben Sie die Referenz nach `Api`, und er läuft durch. Wenn Sie Design-Time-Pakete per Konvention im Kontextprojekt halten, fügen Sie die Referenz in beiden hinzu.

### 2. Oder Tools auf 10.0.9 oder neuer anheben

Wenn Sie keine Paketreferenz hinzufügen möchten, genügt ein Upgrade des Tools-Pakets für sich allein, weil 10.0.9 die Angleichung pro Framework wiederhergestellt hat:

```
$ dotnet list package --include-transitive | grep Design
   > Microsoft.EntityFrameworkCore.Design       10.0.9
```

Der Haken: Sie bekommen die Untergrenze des Tools-Pakets, nicht Ihre EF Core Version. Tools 10.0.9 neben EF Core 10.0.11 ergibt Design 10.0.9, was funktioniert, aber eine Versionsabweichung ist, die Sie nicht gewählt haben. Fix 1 bleibt die bessere Gewohnheit.

### 3. Oder Tools auf 10.0.5 zurücksetzen

Ein Downgrade auf 10.0.5 stellt die alte versionsgleiche Abhängigkeit wieder her und ist ein valider Notausstieg, wenn Sie mitten in einem Release stecken und nicht breitflächig Projektdateien anfassen können. Es ist aber eine Sackgasse: 10.0.5 liegt vor mehreren Monaten an Tooling-Fixes, und jedes spätere Upgrade wirft Sie direkt zurück in das kaputte Zeitfenster, sofern Sie nicht zusätzlich Fix 1 anwenden.

### 4. Central Package Management

Unter CPM liegt die Version in `Directory.Packages.props`, und es gilt dieselbe Regel: deklarieren Sie Design dort und referenzieren Sie es aus dem Startprojekt.

```xml
<!-- Directory.Packages.props, EF Core 10.0.11 -->
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.11" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.11" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Tools" Version="10.0.11" />
</ItemGroup>
```

Ein `PackageVersion` Eintrag allein fügt das Paket nicht hinzu. Er setzt nur die Version, falls etwas es referenziert. Wenn Design transitiv über Tools in den Graphen gelangt, hebt `CentralPackageTransitivePinningEnabled` auf `true` das transitive Design auf die von Ihnen deklarierte Version, was für eine große Solution eine sinnvolle zweite Verteidigungslinie ist.

## So prüfen Sie, welche Design-Version das Werkzeug lädt

Verlassen Sie sich nicht auf `dotnet ef --version`. Es meldet das globale Werkzeug, das unabhängig vom Projektgraphen ist:

```
$ dotnet ef --version
Entity Framework Core .NET Command-line Tools
10.0.11
```

Das gibt 10.0.11 aus, während das Projekt Design 8.0.0 lädt. Zwei Befehle liefern die echte Antwort. Der erste zeigt die aufgelöste Version und wer sie angefordert hat:

```
$ dotnet nuget why . Microsoft.EntityFrameworkCore.Design
Project 'EfToolsRepro' has the following dependency graph(s) for
'Microsoft.EntityFrameworkCore.Design':

  [net10.0]
  └── Microsoft.EntityFrameworkCore.Tools (v10.0.6)
      └── Microsoft.EntityFrameworkCore.Design (v8.0.0)
```

`dotnet nuget why` benötigt das .NET 9 SDK oder neuer und ist der schnellste Weg herauszufinden, welches Paket das alte Design hereinzieht, und das ist nicht immer Tools. Jede Bibliothek in Ihrer Solution, die Design direkt mit einer alten Untergrenze referenziert, kann dasselbe bewirken.

Die zweite Prüfung liest die Build-Ausgabe, gegen die das Tooling tatsächlich auflöst:

```
$ grep -o '"Microsoft.EntityFrameworkCore.Design/[0-9.]*"' bin/Debug/net10.0/Api.deps.json
"Microsoft.EntityFrameworkCore.Design/8.0.0"
```

Beachten Sie, dass die Design-Assembly selbst nicht nach `bin` kopiert wird. Sie wird über den Eintrag in `deps.json` aus dem globalen NuGet-Paketordner aufgelöst, die Suche nach der DLL neben Ihrer ausführbaren Datei sagt Ihnen also nichts.

## Stolperfallen und ähnlich aussehende Fehler

**Manche Befehle laufen weiterhin durch, und deshalb schließen viele ein Paketproblem zu früh aus.** Mit Design 8.0.26 neben EF Core 10.0.11 gibt `dotnet ef dbcontext info` Kontext, Provider und Datenquelle klaglos aus, und `dotnet ef dbcontext script` erzeugt korrektes SQL. Nur die Codepfade, die die nicht zusammenpassenden Typen berühren, brechen ab. Schließen Sie nicht daraus, dass Ihr Tooling stimmig ist, weil ein Befehl erfolgreich war.

**Lesen Sie die Signatur von `AddMigrationImpl` im Stack Trace.** Sie identifiziert die geladene Design-Version ohne weitere Untersuchung. Design 9.x hat einen Parameter `Boolean dryRun`, den 8.x und 10.x nicht haben:

```
// Design 9.0.15
at ...OperationExecutor.AddMigrationImpl(String name, String outputDir, String contextType, String namespace, Boolean dryRun)

// Design 8.0.26
at ...OperationExecutor.AddMigrationImpl(String name, String outputDir, String contextType, String namespace)
```

**"Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design" ist ein anderer Fehler mit benachbarter Ursache.** Dort fehlt Design vollständig, statt in der falschen Version vorzuliegen. Wissenswert ist, dass `Microsoft.EntityFrameworkCore.Tools` 11.0.0-preview.7.26381.103, veröffentlicht am 2026-08-11, eine leere `net10.0` Abhängigkeitsgruppe deklariert: gar keine Design-Abhängigkeit. Wenn Sie die Gewohnheit, nur Tools zu referenzieren, in ein EF Core 11 Upgrade mitnehmen, begegnet Ihnen [der Fehler, dass das Startprojekt Design nicht referenziert](/de/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/) statt dieser hier. Die explizite Fixierung aus Fix 1 deckt beides ab.

**"Unable to create an object of type 'DbContext'" hat nichts damit zu tun.** Das ist ein Problem der Design-Time-Factory oder des Host Builders, keine Versionsabweichung. Wenn Ihr Stack Trace `DbContextActivator` oder eine fehlende `IDesignTimeDbContextFactory` erwähnt, brauchen Sie [den Diagnosepfad für die DbContext-Erzeugung](/de/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) statt dieser Seite.

**`MissingMethodException` zur Laufzeit der Anwendung statt zur Design-Zeit.** Wenn die Ausnahme aus Ihrer Webanwendung und nicht aus `dotnet ef` kommt, ist meist eine Bibliothek schuld, die gegen eine andere EF Core Hauptversion kompiliert wurde, nicht das Design-Paket. Die Diagnose bleibt dieselbe: Führen Sie `dotnet nuget why` auf `Microsoft.EntityFrameworkCore` aus und suchen Sie ein Paket mit alter Untergrenze.

**Ein Migrations-Bundle erbt das Problem.** Da `dotnet ef migrations bundle` denselben Design-Time-Stack ausführt, um die ausführbare Datei zu bauen, kann ein kaputter Graph ein Bundle aus einem veralteten Modell erzeugen oder ganz fehlschlagen. Reparieren Sie die Referenz, bevor Sie das Artefakt erzeugen, das Sie gegen die Produktion laufen lassen wollen, wie in der [Anleitung zum Deployment mit Migrations-Bundle](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) beschrieben.

## Was beim Upgrade auf EF Core 11 zu tun ist

EF Core 11 ist im September 2026 in der Preview-Phase und erscheint im November 2026 zusammen mit .NET 11. Da das einzige SDK auf diesem Rechner 10.0.302 ist, entstand jede Befehlsausgabe oben gegen EF Core 10.0.11, nicht 11. Aus dem NuGet-Katalog verifizierbar ist heute die Form der Abhängigkeiten: Tools 11.0.0-preview.7 hat überhaupt keine Paketabhängigkeiten. Behandeln Sie `Microsoft.EntityFrameworkCore.Design` als Paket, das Sie immer selbst deklarieren, exakt in der Version Ihrer übrigen EF Core Pakete, dann ist diese Fehlerklasse unmöglich, unabhängig davon, was Tools deklariert. Das ist eine einzeilige Änderung, die sich lohnt, bevor Sie [die umfassendere Migration auf .NET 11](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) beginnen, denn ein Migrationsbefehl, der mitten in einem Upgrade scheitert, lässt sich nur sehr schwer einer NuGet-Untergrenze zuordnen.

Die allgemeine Regel, die dieser Vorfall zeigt: Halten Sie alle `Microsoft.EntityFrameworkCore.*` Pakete auf einer Version, auch die, die Sie nie per `using` einbinden. EF Core unterstützt keine Mischung von Hauptversionen über seine eigenen Assemblies hinweg, und das Tooling warnt Sie nicht, wenn NuGet still einen Graphen auflöst, der sie mischt.

## Verwandte Beiträge

- [Fix: Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/de/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/)
- [Fix: dotnet tool install --global dotnet-ef wirft einen Fehler](/de/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/)
- [Fix: dotnet ef migrations add scheitert mit "Unable to create an object of type DbContext"](/de/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)
- [EF Core 11 Migrationen in der Produktion mit einem Migrations-Bundle anwenden](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Fix: "The model for context 'X' has pending changes" in EF Core 11](/de/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)

## Quellen

- [dotnet/efcore#38124, Ankündigung: Änderung der Design-Paketabhängigkeit in Microsoft.EntityFrameworkCore.Tools 10.0.6](https://github.com/dotnet/efcore/issues/38124)
- [dotnet/efcore#38107, Add-Migration Ausnahme: AbstractionsStrings.ArgumentIsEmpty](https://github.com/dotnet/efcore/issues/38107)
- [dotnet/efcore#38123, als Duplikat von 38107 geschlossen, mit der TypeLoadException-Variante](https://github.com/dotnet/efcore/issues/38123)
- [Microsoft.EntityFrameworkCore.Tools auf NuGet, Abhängigkeitsgruppen pro Version](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Tools/)
- [Referenz der Entity Framework Core Werkzeuge für die .NET CLI](https://learn.microsoft.com/en-us/ef/core/cli/dotnet)
- [Referenz des Befehls dotnet nuget why](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-nuget-why)
