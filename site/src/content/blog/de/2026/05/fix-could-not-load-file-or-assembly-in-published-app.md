---
title: "Fix: System.IO.FileNotFoundException: Could not load file or assembly in einer veröffentlichten App"
description: "Läuft mit dotnet run, scheitert nach dotnet publish. Die DLL fehlt meist im Publish-Ordner, nicht im Runtime. Prüfen Sie deps.json, Private an ProjectReference und Trimming."
pubDate: 2026-05-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "msbuild"
  - "publish"
  - "trimming"
lang: "de"
translationOf: "2026/05/fix-could-not-load-file-or-assembly-in-published-app"
translatedBy: "claude"
translationDate: 2026-05-12
---

Der Fix: Eine `FileNotFoundException: Could not load file or assembly` nach `dotnet publish` bedeutet fast immer, dass die DLL nicht im Publish-Ordner liegt, nicht dass der Runtime sie nicht finden kann. Listen Sie die Publish-Ausgabe auf, identifizieren Sie das fehlende Assembly anhand des Namens und behandeln Sie es als Packaging-Fehler. Die vier Ursachen, die neunzig Prozent der realen Meldungen abdecken, sind ein `ProjectReference` mit `Private=false`, ein `PackageReference` mit `PrivateAssets="all"`, das Trimming, das ein per Reflection geladenes Assembly entfernt, und ein Self-Contained- gegenüber Framework-Dependent-Publish, das die falsche RID wählt. Setzen Sie `COREHOST_TRACE=1`, führen Sie die veröffentlichte Binary einmal aus, und das Host-Log zeigt Ihnen, welchen Probing-Pfad es versucht hat.

```text
Unhandled exception. System.IO.FileNotFoundException: Could not load file or assembly 'Contoso.Shared, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null'. The system cannot find the file specified.
File name: 'Contoso.Shared, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null'
   at MyApp.Program.Main(String[] args)

--- End of stack trace from previous location ---
   at System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw()
   at System.Runtime.CompilerServices.TaskAwaiter.ThrowForNonSuccess(Task task)
```

Diese Anleitung ist gegen .NET 11 preview 4 (Runtime `Microsoft.NETCore.App` 11.0.0-preview.4) und das .NET SDK 11.0.100-preview.4 auf Windows, Linux und macOS geschrieben. Der Ausnahmetyp, die vierteilige Assembly-Identität in der Meldung und die Probing-Regeln des Hosts haben sich seit .NET Core 3.0 nicht geändert; was sich in .NET 8 und .NET 11 geändert hat, ist der Analyzer des Trimmers, der jetzt direkt `IL2026`- / `IL3050`-Warnungen ausgibt, damit Sie das nicht mehr zur Laufzeit entdecken. Sagt die Meldung `Could not load file or assembly` gefolgt von `or one of its dependencies`, ist die Abhängigkeit die fehlende Datei, nicht die zuerst genannte. Lesen Sie den zweiten Teil, bevor Sie irgendetwas anfassen.

## Warum der Runtime das Assembly nicht findet

Der .NET-Host (`dotnet.exe` oder der Apphost-Stub, der bei `dotnet publish` neben Ihrer `.exe` erzeugt wird) lädt Assemblies aus einer festen Menge von Probing-Pfaden, die aus Ihrer `<app>.deps.json` abgeleitet werden. Er sucht nicht im `PATH`, er sucht nicht in der GAC, und er greift nicht auf den bin-Ordner des Projekts zurück, das ihn gebaut hat. Die Pfade, die er der Reihe nach prüft, sind:

1. Das Verzeichnis des Apphosts (`AppContext.BaseDirectory`).
2. Das Shared-Framework-Verzeichnis für Framework-Dependent-Apps (`{DOTNET_ROOT}/shared/Microsoft.NETCore.App/{version}`).
3. Die NuGet-Fallback-Ordner, wenn die `useNuGet`-Auflösung aktiv ist (nur in der Entwicklung).
4. Alles, was in `additionalProbingPaths` in `<app>.runtimeconfig.dev.json` deklariert ist, was in einer veröffentlichten App **nicht** vorhanden ist.

Wenn die Entwicklermaschine das Assembly im NuGet-Cache hat und die runtimeconfig dorthin zeigt, findet `dotnet run` es. Die veröffentlichte App hat weder den Cache noch die Entwicklungs-runtimeconfig, also wirft derselbe Aufruf die Ausnahme. Die Ausnahme ist der Host, der Ihnen mitteilt, dass die Assembly-Identität in `<app>.deps.json` auf keine Datei auf dem Datenträger aufgelöst werden konnte.

Die offizielle Microsoft-Learn-Seite [Understand dependency loading in .NET](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/overview) ist die maßgebliche Referenz für die Probing-Reihenfolge; die [Host-Tracing-Anleitung](https://github.com/dotnet/runtime/blob/main/docs/design/features/host-tracing.md) beschreibt, wie Sie das Probing-Log in eine Datei dumpen.

## Eine minimale Reproduktion

```xml
<!-- .NET 11, SDK 11.0.100-preview.4 -->
<!-- src/MyApp/MyApp.csproj -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <RootNamespace>MyApp</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\Contoso.Shared\Contoso.Shared.csproj">
      <Private>false</Private>
    </ProjectReference>
  </ItemGroup>
</Project>
```

```csharp
// .NET 11, C# 14
using Contoso.Shared;

var greeter = new Greeter();
Console.WriteLine(greeter.Hello("world"));
```

`dotnet run` läuft. `dotnet publish -c Release -r win-x64 -o ./out` beendet ohne Fehler. `./out/MyApp.exe` wirft `Could not load file or assembly 'Contoso.Shared'`. Das Flag `<Private>false</Private>` weist MSBuild an, `Contoso.Shared.dll` nicht in die Ausgabe des Konsumenten zu kopieren, unter der Annahme, dass die GAC oder ein anderes Deployment-Vehikel sie bereitstellt. Für .NET-(Core-)Apps gibt es keine GAC, also fehlt die Datei schlicht.

Das ist die kanonische Form des Bugs: eine einzige Eigenschaft irgendwo im Projektgraphen sagt MSBuild, die DLL nicht einzubeziehen, und der Publish-Schritt respektiert das. Der Fix besteht darin, die Eigenschaft zu finden und zu entfernen.

## Fix 1: hören Sie auf, die Kopie zu unterdrücken

Öffnen Sie die Projektdatei des Eltern-Projekts des fehlenden Assemblys und suchen Sie nach einer dieser Eigenschaften an der Referenz:

```xml
<!-- These three lines all suppress the copy. Remove them. -->
<ProjectReference Include="..\Contoso.Shared\Contoso.Shared.csproj">
  <Private>false</Private>
</ProjectReference>

<Reference Include="Contoso.Shared">
  <CopyLocal>false</CopyLocal>
</Reference>

<PackageReference Include="Some.Library" Version="1.0.0">
  <PrivateAssets>all</PrivateAssets>
</PackageReference>
```

`Private=false` und `CopyLocal=false` sind äquivalent für Projekt- und Assembly-Referenzen. `PrivateAssets="all"` an einem `PackageReference` bedeutet, dass das Asset zur Buildzeit konsumiert wird, aber nicht zum konsumierenden Projekt fließt, sodass die DLL aus `deps.json` ausgeschlossen wird. Die legitime Verwendung von `PrivateAssets="all"` ist für Analyzer-, Source-Generator- und Build-Task-Pakete (bei denen der Runtime die DLL nie braucht). Ist das Paket `Microsoft.Extensions.Logging.Abstractions` oder etwas, das Sie zur Laufzeit aufrufen, ist das Flag falsch. Entfernen Sie es, führen Sie `dotnet publish` aus und stellen Sie sicher, dass die DLL jetzt neben Ihrer App liegt.

Die MS-Learn-Seite [Controlling dependency assets](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files#controlling-dependency-assets) listet jeden Wert auf, den `PrivateAssets` akzeptiert, und was jeder davon deaktiviert.

## Fix 2: schalten Sie Host-Tracing ein und lesen Sie das Probe-Log

Wissen Sie nicht, welche DLL fehlt, fragen Sie den Host. Setzen Sie `COREHOST_TRACE=1` und `COREHOST_TRACEFILE=corehost.log`, bevor Sie die veröffentlichte Binary starten:

```powershell
# Windows, PowerShell, .NET 11
$env:COREHOST_TRACE = "1"
$env:COREHOST_TRACE_VERBOSITY = "4"
$env:COREHOST_TRACEFILE = "corehost.log"
./out/MyApp.exe
```

```bash
# Linux / macOS, bash, .NET 11
COREHOST_TRACE=1 COREHOST_TRACE_VERBOSITY=4 COREHOST_TRACEFILE=corehost.log ./out/MyApp
```

Das Log ist lang, aber der zu durchsuchende Abschnitt ist `Attempting to load`. Jeder Versuch wird mit dem vollständigen Pfad protokolliert, den der Host versucht hat. Der letzte fehlgeschlagene Versuch vor der Ausnahme ist die Antwort:

```text
Attempting to load: C:\out\Contoso.Shared.dll - false
Attempting to load: C:\out\runtimes\win-x64\lib\net11.0\Contoso.Shared.dll - false
File [C:\out\Contoso.Shared.dll] does not exist
```

Jetzt wissen Sie, dass der Host `Contoso.Shared.dll` direkt unter dem App-Ordner erwartet und nicht gefunden hat. Der Fix besteht darin, die Publish-Ausgabe so anzupassen, dass sie die Datei an diesem Pfad enthält, nicht darin, Probing-Pfade oder Load Contexts hinzuzufügen.

## Fix 3: wenn Trimming das Assembly stillschweigend entfernt

Trimming einer Self-Contained-.NET-11-App entfernt jedes Assembly, das der Trimmer per statischer Analyse nicht als erreichbar nachweisen kann. `Assembly.Load("Plugins.Foo")`, `Type.GetType("Some.Type, Some.Assembly")` und die meisten Reflection-basierten DI-Container sind für den Trimmer unsichtbar. Das Assembly wird aus der Publish-Ausgabe ausgeschlossen und taucht zur Laufzeit als `FileNotFoundException` auf.

Um zu bestätigen, dass Trimming die Ursache ist, publizieren Sie einmal mit den Trimmer-Warnungen als Fehler:

```xml
<!-- .NET 11 -->
<PropertyGroup>
  <PublishTrimmed>true</PublishTrimmed>
  <TrimmerSingleWarn>false</TrimmerSingleWarn>
  <SuppressTrimAnalysisWarnings>false</SuppressTrimAnalysisWarnings>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
</PropertyGroup>
```

Schlägt der Publish jetzt mit `IL2026` oder `IL3050` fehl und zeigt auf Ihre Reflection-Aufrufstelle, ist Trimming die Ursache. Der Fix besteht darin, das Assembly als Root zu kennzeichnen, damit der Trimmer es behält:

```xml
<!-- .NET 11 -->
<ItemGroup>
  <TrimmerRootAssembly Include="Plugins.Foo" />
</ItemGroup>
```

Für einen einzelnen Typ markieren Sie die Methode, die das Laden auslöst, mit `DynamicDependencyAttribute`:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public static class PluginLoader
{
    [DynamicDependency(DynamicallyAccessedMemberTypes.PublicConstructors, "Plugins.Foo.Entry", "Plugins.Foo")]
    public static object Load() => Activator.CreateInstance(Type.GetType("Plugins.Foo.Entry, Plugins.Foo")!)!;
}
```

Die vollständige Liste der Trimmer-Roots und Dependency-Attribute steht in [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming). Für einen tieferen Blick auf die Runtime-Seite zeigt der Artikel zu [Native AOT mit ASP.NET Core Minimal APIs](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) dieselben Trimmer-Warnungen in einer aggressiveren Form.

## Fix 4: falsche RID oder Framework-Dependent als Self-Contained veröffentlicht

Ist das im Fehler aufgeführte Assembly `Microsoft.NETCore.App` oder eine seiner Komponenten (`System.Private.CoreLib.dll`, `System.Runtime.dll`), liegt das Problem nicht an Ihrem Code, sondern daran, dass die veröffentlichte App framework-dependent ist, die Zielmaschine aber kein passendes Shared Framework installiert hat:

```text
Could not load file or assembly 'System.Runtime, Version=11.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a'
```

Diese Meldung bedeutet, dass der Host `MyApp.dll` gefunden und `MyApp.runtimeconfig.json` gelesen hat, dann `Microsoft.NETCore.App 11.0.0` angefordert und nichts erhalten hat. Installieren Sie entweder das Shared Framework auf der Zielmaschine (`dotnet --list-runtimes`), oder veröffentlichen Sie erneut als Self-Contained:

```bash
# .NET 11
dotnet publish -c Release -r win-x64 --self-contained true -o ./out
```

Der Runtime liefert jede Framework-DLL nach `./out`, die App hängt nicht mehr vom installierten Runtime der Maschine ab, und die FileNotFoundException verschwindet. Der zugehörige Beitrag [Kaltstartzeit eines .NET-11-AWS-Lambdas reduzieren](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) diskutiert die Publish-Tradeoffs (Größe vs. Portabilität vs. Cold Start) ausführlicher.

Der andere RID-förmige Fehler ist ein NuGet-Paket mit nativen Binärdateien, das nur einige RIDs ausliefert. Wenn Sie für `osx-arm64` publizieren, ein Paket aber nur `win-x64`- und `linux-x64`-Native enthält, wird das `runtimes/win-x64/native/foo.dll` des Pakets aus Ihrem Publish ausgeschlossen, und der verwaltete Wrapper wirft `FileNotFoundException`. Der Fix besteht darin, die Lücke beim Paket-Owner zu melden oder auf eine Version zu pinnen, die die benötigte RID ausliefert. Der `runtimes/`-Ordner des Pakets ist die maßgebliche Quelle.

## Stolperfallen und ähnlich aussehende Fälle

**`Could not load file or assembly 'X' or one of its dependencies`.** Das genannte Assembly ist auf der Festplatte. Eine seiner Abhängigkeiten nicht. Führen Sie `dotnet-dump analyze` oder `dnSpy` gegen `X.dll` aus, um seine Liste referenzierter Assemblies zu lesen, oder nutzen Sie den Host-Trace aus Fix 2, um den Fehler auf zweiter Ebene zu finden. Den ersten Namen als fehlende Datei zu behandeln, schickt Sie im Kreis.

**`FileLoadException`, nicht `FileNotFoundException`.** Ein `FileLoadException: Could not load file or assembly 'X, Version=2.0.0.0'` bedeutet, dass die Datei vorhanden ist, aber Version, Kultur oder Public Key Token nicht zu dem passen, was angefordert wurde. Das ist ein Assembly-Binding-Redirect-Problem (häufig, wenn eine transitive Abhängigkeit nur auf oberster Ebene aktualisiert wurde). Der Fix besteht darin, eine passende Version zu Ihrer Top-Level-`PackageReference` hinzuzufügen, damit der aufgelöste Graph auf eine Version kollabiert. Der Runtime liest in .NET (Core) keine `app.config`-Binding-Redirects mehr; nur der .NET-Framework-Runtime tat das. Wenn Sie von `app.config` portiert haben, werden die Redirects jetzt ignoriert, und die in `deps.json` aufgelöste Version ist die geladene.

**`TypeLoadException` und `MissingMethodException`.** Das sind keine "Assembly-nicht-gefunden"-Fehler. Sie bedeuten, dass das Assembly geladen wurde, aber der Typ oder die Methode darin eine andere Signatur hat, als der Aufrufer erwartet, fast immer eine Versions-Inkonsistenz. Die Form des Fixes ist dieselbe wie bei `FileLoadException`: den Versionsgraphen ausrichten.

**`BadImageFormatException`.** Die Datei liegt auf der Festplatte und hat den richtigen Namen, aber sie hat die falsche Architektur (eine `x86`-DLL in einem `x64`-Prozess geladen oder eine verwaltete DLL als native geladen). Prüfen Sie die RID und die `Platform` auf beiden Seiten. Das ist eine verwandte Kategorie, kein `FileNotFoundException` in Verkleidung.

**Single-File-Publish.** Mit `PublishSingleFile=true` extrahiert der Apphost beim ersten Start die gebündelten Assemblies in einen Temp-Ordner (`%TEMP%/.net/<appname>/<hash>`). Sehen Sie `FileNotFoundException` für ein Assembly, das Sie innerhalb des Single-File-Bundles sehen können (`dotnet-bundle list`), ist die häufigste Ursache ein eigener Aufruf `AssemblyLoadContext.LoadFromAssemblyPath(Assembly.GetExecutingAssembly().Location)`. `Assembly.Location` ist in .NET 6+ für Single-File-Bundles leer, das Pfadargument ist also falsch. Wechseln Sie zu `AppContext.BaseDirectory`, oder verwenden Sie `Assembly.LoadFromAssemblyName` und lassen Sie den Host die gebündelte Datei auflösen.

**ASP.NET-Core-Deployment auf IIS.** Liefert der Publish die Datei, IIS wirft aber trotzdem die Ausnahme, prüfen Sie, ob die `Identity` des App-Pools Lesezugriff auf den Publish-Ordner hat und ob `aspnetcorev2.dll` auf der aktuellen Version ist (`%programfiles%\IIS\Asp.Net Core Module\V2\aspnetcorev2.dll`). Ein veraltetes ANCM nimmt eine alte `deps.json` auf. Das ist ein Deployment-Problem, kein Build-Problem.

**Plugins / dynamische Load Contexts.** Laden Sie Plugins über `AssemblyLoadContext`, erbt der Plugin-Kontext nicht die Assemblies des Default-Kontexts. Ein Plugin, das `Newtonsoft.Json` aufruft, braucht seine eigene `Newtonsoft.Json.dll` neben dem Plugin, oder einen `AssemblyDependencyResolver`, der aus dem Plugin-Pfad konstruiert wird. Dieselbe Form wie Fix 1, aber die Oberfläche ist der Plugin-Ordner, nicht der App-Ordner. Die MS-Learn-Anleitung unter [Create a .NET application with plugins](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support) zeigt das Resolver-Muster durchgängig.

**Der Build hat sie kopiert, der Publish nicht.** Publish führt einen anderen Satz von MSBuild-Targets aus als Build (`ComputeFilesToPublish` statt `BuiltProjectOutputGroup`). Ein `<Content Include="Foo.dll" CopyToOutputDirectory="PreserveNewest" />` legt die Datei in `bin/` ab, aber nur `<None Include="Foo.dll"><Pack>true</Pack><CopyToPublishDirectory>PreserveNewest</CopyToPublishDirectory></None>` (oder `<Content>` mit dem Publish-Flag) bringt sie in den Publish-Ordner. Erscheint die DLL in `bin/Release/net11.0/`, aber nicht in `bin/Release/net11.0/publish/`, ist das die Ursache.

## Verwandt

- [Fix: Der Typ- oder Namespace-Name kann nach einer Projektreferenz nicht gefunden werden](/de/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) ist die Build-Zeit-Verwandte dieser Ausnahme: dieselben Inkonsistenzen bei `Private` und `TargetFramework` zeigen sich beim Build als `CS0246` oder zur Laufzeit als `FileNotFoundException`.
- [Fix: MSBuild MSB3027 could not copy exceeded retry count](/de/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) behandelt den passenden Kopierfehler zur Publish-Zeit, der einen halben Publish-Ordner hinterlässt.
- [Fix: PlatformNotSupportedException in Native AOT](/de/2026/05/fix-platformnotsupportedexception-in-native-aot/) ist der trim-and-publish-ähnliche Fall, in dem das Assembly vorhanden ist, ein Codepfad aber nicht.
- [Kaltstartzeit eines .NET-11-AWS-Lambdas reduzieren](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) diskutiert die Self-Contained- vs. Framework-Dependent-Tradeoffs für denselben Publish-Schritt.
- [Native AOT mit ASP.NET Core Minimal APIs verwenden](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) ist der tiefere Blick auf die Trimmer-Warnungen, die diese Bug-Klasse zur Buildzeit abfangen.

## Quellen

- [Understand dependency loading in .NET](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/overview) (MS Learn)
- [Host tracing in the .NET runtime host](https://github.com/dotnet/runtime/blob/main/docs/design/features/host-tracing.md) (`dotnet/runtime`)
- [Controlling dependency assets with PackageReference](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files#controlling-dependency-assets) (MS Learn)
- [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming) (MS Learn)
- [`DynamicDependencyAttribute` API reference](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.dynamicdependencyattribute) (MS Learn)
- [Create a .NET application with plugins](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support) (MS Learn)
- [`AppContext.BaseDirectory` API reference](https://learn.microsoft.com/en-us/dotnet/api/system.appcontext.basedirectory) (MS Learn)
