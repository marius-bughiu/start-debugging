---
title: "So tragen Sie den vollständigen öffentlichen Schlüssel einer Assembly mit starkem Namen in InternalsVisibleTo eines SDK-Projekts ein"
description: "Eine signierte Assembly muss ihre Friend-Assembly über den vollständigen öffentlichen Schlüssel mit 320 Zeichen benennen, nicht über das Token, sonst schlägt der Build mit CS1726 oder CS0281 fehl. Den Schlüssel liefern sn -p und sn -tp oder ein plattformübergreifendes .NET-Skript; danach gehört er in die Key-Metadaten eines InternalsVisibleTo-Elements in der .csproj. Behandelt werden außerdem der Fallback über die PublicKey-Eigenschaft, der DynamicProxyGenAssembly2-Schlüssel für Moq und die Falle mit Zeilenumbrüchen."
pubDate: 2026-10-04
template: how-to
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "msbuild"
  - "unit-testing"
  - "how-to"
lang: "de"
translationOf: "2026/10/how-to-add-a-strong-named-assemblys-full-public-key-to-internalsvisibleto"
translatedBy: "claude"
translationDate: 2026-10-04
---

Kurze Antwort: Wenn die Assembly, die den Zugriff gewährt, einen starken Namen hat, muss `InternalsVisibleTo` den **vollständigen öffentlichen Schlüssel** der Friend-Assembly enthalten (die lange Hex-Zeichenfolge, die mit `0024000004800000...` beginnt), niemals das 16 Zeichen lange `PublicKeyToken`. In einem SDK-Projekt brauchen Sie dafür keine `AssemblyInfo.cs`: Fügen Sie `<InternalsVisibleTo Include="MyLib.Tests" Key="0024000004800000940000000602..." />` in eine `ItemGroup` ein, und das SDK erzeugt das Attribut für Sie. Den Schlüssel erhalten Sie aus der `.snk` der Friend-Assembly unter Windows mit `sn -p key.snk key.pub`, gefolgt von `sn -tp key.pub`, oder auf jedem Betriebssystem mit dem kleinen .NET-Skript weiter unten. Der Schlüssel muss eine durchgehende Zeichenfolge ohne Leerzeichen oder Zeilenumbrüche sein, sonst ignoriert der Compiler die Freigabe stillschweigend.

Alles in diesem Beitrag lief unter .NET 10 (SDK 10.0.302) auf macOS, mit einer Klassenbibliothek mit starkem Namen und einem Testprojekt mit starkem Namen, daher sind die zitierten Fehlertexte echte Compilerausgaben. Das MSBuild-Element wird seit dem .NET 5 SDK unterstützt, und die Regeln auf der Compilerseite haben sich seit .NET Framework 2.0 nicht geändert.

## Die zwei Fehler, die Sie ohne den vollständigen Schlüssel bekommen

Ausgangspunkt ist das Setup, das die meisten haben: eine signierte Bibliothek und ein signiertes Testprojekt, dazu das Element, das bei unsignierten Projekten problemlos funktioniert.

```xml
<!-- Contoso.Core.csproj, .NET 10 SDK -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <SignAssembly>true</SignAssembly>
    <AssemblyOriginatorKeyFile>../lib.snk</AssemblyOriginatorKeyFile>
  </PropertyGroup>
  <ItemGroup>
    <InternalsVisibleTo Include="Contoso.Core.Tests" />
  </ItemGroup>
</Project>
```

```csharp
// Contoso.Core/PriceCalculator.cs, .NET 10, C# 14
namespace Contoso.Core;

internal static class PriceCalculator
{
    internal static decimal ApplyDiscount(decimal price, decimal percent) =>
        price * (1 - percent / 100m);
}
```

Der Build schlägt in der **Bibliothek** fehl, und zwar in einer Datei, die Sie nie geschrieben haben:

```text
obj/Debug/net10.0/Contoso.Core.AssemblyInfo.cs(20,12): error CS1726: Friend assembly reference
'Contoso.Core.Tests' is invalid. Strong-name signed assemblies must specify a public key in their
InternalsVisibleTo declarations.
```

Das SDK hat das `InternalsVisibleTo`-Element in der generierten `AssemblyInfo.cs` in `[assembly: InternalsVisibleTo("Contoso.Core.Tests")]` umgewandelt, und der Compiler weist es zurück. Der Grund ist die Identität: Der Name einer Assembly mit starkem Namen ist das Tupel aus einfachem Namen, Version, Kultur und öffentlichem Schlüssel. Eine Freigabe nur für einen einfachen Namen würde es jedem erlauben, eine unsignierte `Contoso.Core.Tests.dll` zu kompilieren und Ihre Interna zu lesen, was den Sinn des Signierens zunichtemacht. Also muss die Freigabe den Schlüssel nennen.

Der Versuch mit dem Token, das die meisten zur Hand haben, weil es in jedem assemblyqualifizierten Namen auftaucht, erzeugt denselben Fehler:

```xml
<InternalsVisibleTo Include="Contoso.Core.Tests, PublicKeyToken=90d333c425def132" />
```

```text
error CS1726: Friend assembly reference 'Contoso.Core.Tests, PublicKeyToken=90d333c425def132' is invalid.
Strong-name signed assemblies must specify a public key in their InternalsVisibleTo declarations.
```

Das Token ist ein 8 Byte langes SHA-1-Fragment des Schlüssels. Es identifiziert den Schlüssel, kann ihn aber nicht verifizieren, daher akzeptiert der Compiler nur den vollständigen Schlüssel. Auch Version, Kultur und Prozessorarchitektur werden abgelehnt: Das Attribut nimmt den einfachen Namen plus optional `PublicKey=`.

Der zweite Fehler tritt auf, wenn Sie zwar einen Schlüssel übergeben, aber den falschen. So sieht die Build-Ausgabe aus, wenn die Bibliothek den Zugriff mit ihrem eigenen Schlüssel gewährt (ein häufiger Copy-Paste-Fehler) oder mit dem Schlüssel einer alten `.snk`:

```text
Contoso.Core.Tests/Program.cs(1,32): error CS0281: Friend access was granted by 'Contoso.Core,
Version=1.0.0.0, Culture=neutral, PublicKeyToken=d2571df32581560a', but the public key of the output
assembly ('0024000004800000940000000602000000240000525341310004000001000100d938...') does not
match that specified by the InternalsVisibleTo attribute in the granting assembly.
```

CS0281 wird im **Friend**-Projekt gemeldet, und er ist der nützlichere der beiden, weil er den Schlüssel ausgibt, den die Friend-Assembly tatsächlich hat. Ist die Friend-Assembly signiert, können Sie diese Hex-Zeichenfolge direkt aus der Fehlermeldung in die Freigabe kopieren. Sind die Klammern leer (`('')`), ist die Friend-Assembly gar nicht signiert: Signieren Sie sie entweder, oder entfernen Sie den Schlüssel aus der Freigabe.

## Schritt 1: den vollständigen öffentlichen Schlüssel der Friend-Assembly ermitteln

Sie brauchen den öffentlichen Schlüssel der Assembly, die den Zugriff **erhält** (das Testprojekt, das Benchmark-Projekt, die Proxy-Assembly der Mocking-Bibliothek), nicht den Schlüssel der Bibliothek, die ihn gewährt.

### Unter Windows, mit sn.exe

Das Strong Name Tool wird mit dem Windows SDK ausgeliefert und liegt in einer Developer Command Prompt im Pfad. Es kann den Schlüssel nicht direkt aus einer Schlüsselpaar-`.snk` ausgeben, daher sind zwei Schritte nötig:

```bash
# Windows, Developer Command Prompt for VS 2026
sn -p Contoso.Core.Tests.snk Contoso.Core.Tests.pub
sn -tp Contoso.Core.Tests.pub
```

`sn -p` extrahiert die öffentliche Hälfte in eine neue Datei. `sn -tp` gibt den öffentlichen Schlüssel und sein Token aus. Der Schlüssel wird über mehrere Zeilen umbrochen ausgegeben; fügen Sie die Zeilen zu einer Zeichenfolge zusammen, bevor Sie ihn verwenden. Wenn Sie nur die kompilierte DLL haben, liest `sn -Tp Contoso.Core.Tests.dll` (großes `T`) den Schlüssel stattdessen aus der Assembly.

### Auf jedem Betriebssystem, mit einem .NET-Skript

`sn.exe` gibt es unter macOS und Linux nicht, und es ist auch nicht Teil des .NET SDK. Das Format ist einfach genug, um es selbst zu berechnen. Speichern Sie Folgendes als `snkpub.cs` und führen Sie es mit `dotnet run snkpub.cs -- <file>` aus (dateibasierte Apps benötigen das .NET 10 SDK):

```csharp
// snkpub.cs, .NET 10, C# 14: print the full public key (and token) of a .snk, a .pub or a signed .dll
using System.Reflection;
using System.Security.Cryptography;

var path = args[0];
byte[] publicKey;
if (path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
{
    publicKey = AssemblyName.GetAssemblyName(path).GetPublicKey()
        ?? throw new InvalidOperationException("Assembly is not strong-named.");
}
else if (File.ReadAllBytes(path) is [0x06 or 0x07, ..] capiBlob) // full key pair .snk
{
    using var rsa = new RSACryptoServiceProvider();
    rsa.ImportCspBlob(capiBlob);
    byte[] blob = rsa.ExportCspBlob(includePrivateParameters: false); // PUBLICKEYBLOB
    BitConverter.TryWriteBytes(blob.AsSpan(4), 0x00002400); // aiKeyAlg = CALG_RSA_SIGN, as the compiler writes it
    // Strong-name public key = SigAlgID (CALG_RSA_SIGN) + HashAlgID (CALG_SHA1) + blob length + blob
    publicKey = [.. BitConverter.GetBytes(0x00002400), .. BitConverter.GetBytes(0x00008004),
                 .. BitConverter.GetBytes(blob.Length), .. blob];
}
else
{
    publicKey = File.ReadAllBytes(path); // public-key-only file from "sn -p", already in this format
}
byte[] hash = SHA1.HashData(publicKey);
byte[] token = hash[^8..];
Array.Reverse(token);
Console.WriteLine($"PublicKey={Convert.ToHexStringLower(publicKey)}");
Console.WriteLine($"PublicKeyToken={Convert.ToHexStringLower(token)}");
```

Eine `.snk`-Datei ist ein Windows-CryptoAPI-`PRIVATEKEYBLOB`. Der öffentliche Strong-Name-Schlüssel, der in die Metadaten wandert, besteht aus einem 12 Byte langen Header (Signaturalgorithmus, Hashalgorithmus, Blob-Länge), gefolgt vom CryptoAPI-`PUBLICKEYBLOB`. Die einzige nicht offensichtliche Zeile ist der `aiKeyAlg`-Patch: Der Compiler schreibt immer `CALG_RSA_SIGN` (`0x2400`) in den Blob-Header, während ein von `RSACryptoServiceProvider` oder manchen Tools erzeugter Schlüssel `CALG_RSA_KEYX` (`0xA400`) enthält. Ohne den Patch gibt das Skript einen Schlüssel aus, der sich in einem einzigen Byte vom echten unterscheidet, und Sie bekommen CS0281 mit zwei Schlüsseln, die auf den ersten Blick identisch aussehen. Genau darauf bin ich beim Testen für diesen Beitrag gestoßen.

Um das Skript gegen einen Schlüssel zu prüfen, den alle kennen, führen Sie es auf [`DynProxy.snk`](https://github.com/castleproject/Core/blob/master/src/Castle.Core/DynamicProxy/DynProxy.snk) von Castle DynamicProxy aus. Es gibt denselben `0024...5cc7`-Schlüssel aus, den Moq für `DynamicProxyGenAssembly2` dokumentiert (Token `a621a9e7e5c32e69`). Die signierte DLL statt der `.snk` zu übergeben ist die sicherste Prüfung überhaupt, weil Sie dann genau den Schlüssel lesen, mit dem der Compiler tatsächlich vergleicht.

## Schritt 2: den Schlüssel in die Projektdatei eintragen

Die Datei `Microsoft.NET.GenerateAssemblyInfo.targets` des .NET SDK liest bei jedem `InternalsVisibleTo`-Element die Metadaten `Key`. Fügen Sie den Schlüssel dort ein:

```xml
<!-- Contoso.Core.csproj, .NET 10 SDK -->
<ItemGroup>
  <InternalsVisibleTo Include="Contoso.Core.Tests"
                      Key="0024000004800000940000000602000000240000525341310004000001000100d938683d143669037eaa216c149c0baf08cfb48998c27cb406ec4e2309ddfe74001f10da9326b9d3b9c259f641ebd3bad32e0ec01921bafab048495084d59b765ef2e991bbb44e638472162f1075d8a0c83e9a69233a95b8b777c28f9ae125d037aec966cab5cb55c7f601888de0acbcdd6785ba17cf31cabbffca0fbe3595b6" />
</ItemGroup>
```

Die generierte `obj/Debug/net10.0/Contoso.Core.AssemblyInfo.cs` enthält jetzt:

```csharp
[assembly: System.Runtime.CompilerServices.InternalsVisibleTo(@"Contoso.Core.Tests, PublicKey=0024000004800000940000000602...")]
```

Nach dem Build kann das Testprojekt `PriceCalculator.ApplyDiscount` wieder aufrufen. Metadaten namens `PublicKey` funktionieren als Alias für `Key`; die Targets kopieren sie hinüber, bevor das Attribut generiert wird, sodass `<InternalsVisibleTo Include="Contoso.Core.Tests" PublicKey="0024..." />` identisch kompiliert. Verwenden Sie `Key`, denn das ist der Name, den das SDK dokumentiert.

Wenn Sie das Attribut lieber im Quellcode haben, funktioniert das weiterhin und ist immer noch besser als eine riesige einzelne Zeile, weil C# die Verkettung konstanter Zeichenfolgen zur Kompilierzeit zusammenfasst:

```csharp
// Contoso.Core/FriendAssemblies.cs, .NET 10, C# 14
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("Contoso.Core.Tests, PublicKey=" +
    "0024000004800000940000000602000000240000525341310004000001000100d938683d143669037eaa" +
    "216c149c0baf08cfb48998c27cb406ec4e2309ddfe74001f10da9326b9d3b9c259f641ebd3bad32e0ec0" +
    "1921bafab048495084d59b765ef2e991bbb44e638472162f1075d8a0c83e9a69233a95b8b777c28f9ae1" +
    "25d037aec966cab5cb55c7f601888de0acbcdd6785ba17cf31cabbffca0fbe3595b6")]
```

Mischen Sie nicht beide Stile für dieselbe Friend-Assembly; sonst erhalten Sie zwei Attribute, und nur eines davon wird aktualisiert, wenn der Schlüssel rotiert.

## Ein Schlüssel für viele Friend-Assemblies: die PublicKey-Eigenschaft

Die meisten Solutions signieren jedes Projekt mit derselben `.snk`. Dann braucht jede Freigabe denselben Schlüssel, und 320 Hex-Zeichen pro Element zu wiederholen ist reines Rauschen. Dieselbe Targets-Datei hat einen Fallback: Hat ein `InternalsVisibleTo`-Element kein `Key`, verwendet sie die MSBuild-**Eigenschaft** `$(PublicKey)`. Das dotnet/arcade-SDK, mit dem dotnet/runtime gebaut wird, setzt `$(PublicKey)` auf diese Weise, und so gewähren diese Repos ihren Test-Assemblies Zugriff auf Interna.

```xml
<!-- Directory.Build.props at the repo root, .NET 10 SDK -->
<Project>
  <PropertyGroup>
    <SignAssembly>true</SignAssembly>
    <AssemblyOriginatorKeyFile>$(MSBuildThisFileDirectory)build/Contoso.snk</AssemblyOriginatorKeyFile>
    <PublicKey>0024000004800000940000000602000000240000525341310004000001000100d938683d...</PublicKey>
  </PropertyGroup>
</Project>
```

```xml
<!-- Any library project -->
<ItemGroup>
  <InternalsVisibleTo Include="$(AssemblyName).Tests" />
  <InternalsVisibleTo Include="Contoso.Benchmarks" />
</ItemGroup>
```

Zwei Dinge habe ich dabei überprüft. Erstens füllt das SDK `$(PublicKey)` **nicht** automatisch aus `AssemblyOriginatorKeyFile`: Mit aktiviertem Signieren und ohne die Eigenschaft schlägt das nackte Element weiterhin mit CS1726 fehl. Zweitens ändert das Setzen der Eigenschaft nichts daran, wie die Bibliothek selbst signiert wird; die signierte DLL hatte weiterhin ihr eigenes Token aus ihrer `.snk`. Die Eigenschaft speist nur den Attributgenerator. Ein Element mit explizitem `Key` hat weiterhin Vorrang vor der Eigenschaft, und genau das wollen Sie für Friend-Assemblies von Drittanbietern wie die im nächsten Abschnitt.

## Zugriff für Moq, NSubstitute und andere Castle-Proxys gewähren

Ein `internal`-Interface in einer Bibliothek mit starkem Namen zu mocken erfordert eine zweite Freigabe, weil der Mock-Typ zur Laufzeit in eine dynamische Assembly namens `DynamicProxyGenAssembly2` emittiert wird, nicht in Ihre Test-Assembly. Castle DynamicProxy signiert diese dynamische Assembly mit einem festen Schlüssel, daher sieht die Freigabe immer gleich aus, für Moq, NSubstitute und FakeItEasy gleichermaßen:

```xml
<!-- .NET 10 SDK; key from Castle.Core's DynProxy.snk, documented by Moq -->
<ItemGroup>
  <InternalsVisibleTo Include="DynamicProxyGenAssembly2"
                      Key="0024000004800000940000000602000000240000525341310004000001000100c547cac37abd99c8db225ef2f6c8a3602f3b3606cc9891605d02baa56104f4cfc0734aa39b93bf7852f7d9266654753cc297e7d2edfe0bac1cdcf9f717241550e0a7b191195b7667bb4f64bcb8e2121380fd1d9d46ad2d92d2d15605093924cceaf74c4861eff62abf69b9291ed0a340e113be11e6a7d3113e92484cf7045cc7" />
</ItemGroup>
```

Ohne sie ist der Fehler eine Laufzeitausnahme von Castle, die Ihnen mitteilt, dass der Typ für `DynamicProxyGenAssembly2` nicht zugänglich ist, und die Meldung selbst enthält das hinzuzufügende Attribut. Ist Ihre Bibliothek nicht signiert, genügt das nackte `<InternalsVisibleTo Include="DynamicProxyGenAssembly2" />`.

## Fallstricke

**Zeilenumbrüche und Leerzeichen machen die Freigabe ohne Fehler unwirksam.** Es ist verlockend, ein 320 Zeichen langes `Key`-Attribut in der `.csproj` über mehrere Zeilen umzubrechen. MSBuild behält die Leerzeichen bei, der Compiler kann das Ergebnis nicht parsen, und Sie bekommen in der Bibliothek nur eine Warnung:

```text
warning CS1700: Assembly reference 'Contoso.Core.Tests, PublicKey=00240000048000009400...' is invalid and cannot be resolved
```

gefolgt von `error CS0122: 'PriceCalculator' is inaccessible due to its protection level` im Testprojekt. Wenn Sie Warnungen als Fehler behandeln, sehen Sie es sofort; andernfalls sieht CS0122 so aus, als fehle die Freigabe komplett. Halten Sie den Schlüssel auf einer Zeile, oder verwenden Sie die oben gezeigte C#-Verkettung.

**Die Friend-Assembly muss tatsächlich signiert sein.** Eine Freigabe mit Schlüssel passt nur auf eine Friend-Assembly, die mit diesem Schlüssel signiert ist. In meinem Durchlauf führte das Abschalten von `SignAssembly` im Testprojekt zu CS0281 mit leerem Schlüssel, `('')`. Die umgekehrte Richtung ist nachsichtig: Eine unsignierte Bibliothek kann einer signierten Friend-Assembly über den einfachen Namen Zugriff gewähren, und der Compiler akzeptiert das.

**Public Signing und Delay Signing zählen als signiert.** Open-Source-Repos committen oft nur die öffentliche Hälfte ihres Schlüssels und setzen `<PublicSign>true</PublicSign>`, damit Mitwirkende unter Linux und macOS ohne den privaten Schlüssel kompilieren können. Das funktioniert auch für Friend-Prüfungen: Ein Testprojekt, das nur mit der `.pub`-Datei public-signiert war, wurde gegen eine Freigabe mit seinem Schlüssel kompiliert und ausgeführt. Der Compiler vergleicht Schlüssel, er verifiziert keine Signaturen. Eine delay-signierte oder public-signierte Assembly unter .NET Framework auszuführen ist ein separates Problem, aber .NET Core und neuer ignorieren Strong-Name-Signaturen beim Laden.

**Den Schlüssel zu rotieren bedeutet, jede Freigabe zu aktualisieren.** Eine neue `.snk` zu erzeugen (etwa weil die alte 1024 Bit hatte oder geleakt ist) ändert den öffentlichen Schlüssel und das Token, sodass sich jedes `InternalsVisibleTo`, das die Friend-Assembly nennt, mit ändern muss. Die Eigenschaft `$(PublicKey)` in `Directory.Build.props` macht daraus eine Änderung an einer Zeile. Suchen Sie im Repo auch nach dem alten Token: Assemblyqualifizierte Typnamen in Konfigurationsdateien und Binding Redirects enthalten es.

**Starke Namen bringen Ihnen weniger als früher.** Unter .NET Core und .NET 5+ validiert die Laufzeit keine Strong-Name-Signaturen, und das Binding ignoriert den Schlüssel bei der Vereinheitlichung. Die aktuelle Empfehlung von Microsoft lautet, dass die meisten Bibliotheken keinen starken Namen brauchen, es sei denn, sie werden von .NET-Framework-Code genutzt, der ihn verlangt. Wenn Sie die gesamte Solution kontrollieren und nur modernes .NET adressieren, beseitigt das Abschalten des Signierens diese ganze Problemklasse. Wenn Sie an .NET-Framework-Nutzer ausliefern, behalten Sie das Signieren bei und verwenden Sie die obigen Muster.

**Eine Freigabe ist weiter gefasst, als Sie vielleicht brauchen.** Eine Freigabe öffnet der Friend-Assembly jeden internen Typ, nicht nur den einen, den Sie brauchten. Für Integrationstests gegen Minimal Hosting ist eine `public partial class Program` meist die engere Wahl.

### Weiterlesen

- [Integrationstests mit WebApplicationFactory in ASP.NET Core 11 schreiben](/de/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) behandelt `public partial class Program` als Alternative dazu, einer Test-Assembly alle Ihre Interna freizugeben.
- [So beheben Sie "Could not load file or assembly" in einer veröffentlichten .NET-App](/de/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) erklärt die Binding-Seite der Assembly-Identität, wo das Public Key Token ebenfalls auftaucht.
- [Eine .NET-Solution mit Directory.Packages.props auf Central Package Management migrieren](/de/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) nutzt dasselbe Muster einer MSBuild-Datei auf Root-Ebene wie die gemeinsame Eigenschaft `$(PublicKey)`.
- [xUnit v3 vs NUnit vs MSTest im Jahr 2026](/de/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/) hilft bei der Wahl des Frameworks für das Testprojekt, dem Sie Zugriff gewähren.
- [Einen DbContext mocken, ohne das Change Tracking zu beschädigen](/de/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) erinnert daran, dass nicht jedes interne Element einen Castle-Proxy braucht, um testbar zu sein.

### Quellen

- [Ergänzende Hinweise zu `InternalsVisibleToAttribute`](https://learn.microsoft.com/en-us/dotnet/fundamentals/runtime-libraries/system-runtime-compilerservices-internalsvisibletoattribute), .NET-Dokumentation
- [Friend-Assemblies](https://learn.microsoft.com/en-us/dotnet/standard/assembly/friend), .NET-Dokumentation
- [MSBuild-Referenz für .NET-SDK-Projekte: `InternalsVisibleTo`](https://learn.microsoft.com/en-us/dotnet/core/project-sdk/msbuild-props#internalsvisibleto), .NET-Dokumentation
- [Sn.exe (Strong Name Tool)](https://learn.microsoft.com/en-us/dotnet/framework/tools/sn-exe-strong-name-tool), .NET-Framework-Dokumentation
- [Assemblies mit starkem Namen](https://learn.microsoft.com/en-us/dotnet/standard/assembly/strong-named) und [Leitfaden zu starken Namen für Bibliotheken](https://learn.microsoft.com/en-us/dotnet/standard/library-guidance/strong-naming), .NET-Dokumentation
- [`Microsoft.NET.GenerateAssemblyInfo.targets`](https://github.com/dotnet/sdk/blob/main/src/Tasks/Microsoft.NET.Build.Tasks/targets/Microsoft.NET.GenerateAssemblyInfo.targets), dotnet/sdk (die Metadaten `Key` und `PublicKey` sowie der Fallback auf `$(PublicKey)`)
- [`DynProxy.snk`](https://github.com/castleproject/Core/blob/master/src/Castle.Core/DynamicProxy/DynProxy.snk), castleproject/Core
