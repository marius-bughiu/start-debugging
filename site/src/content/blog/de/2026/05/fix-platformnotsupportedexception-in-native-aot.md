---
title: "Fix: PlatformNotSupportedException: Operation is not supported on this platform unter Native AOT"
description: "Native AOT entfernt JIT und Interpreter, daher werfen Reflection Emit, Compile auf Expression-Bäumen und nicht gesehene MakeGenericType zur Laufzeit. Finden Sie den Aufruf über IL3050 und ersetzen Sie ihn durch einen Source Generator oder einen vorgefertigten Pfad."
pubDate: 2026-05-10
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "native-aot"
  - "trimming"
lang: "de"
translationOf: "2026/05/fix-platformnotsupportedexception-in-native-aot"
translatedBy: "claude"
translationDate: 2026-05-10
---

Die Lösung: Native AOT veröffentlicht ein einzelnes natives Binary ohne JIT und ohne Interpreter, daher wirft jeder Codepfad, der zur Laufzeit IL emittiert, einen `Expression<T>`-Baum kompiliert oder die Laufzeit auffordert, eine generische Instanziierung zu backen, die sie nie gesehen hat, eine `PlatformNotSupportedException`. Der erste Schritt ist immer derselbe: kompilieren Sie neu mit `dotnet publish -r <rid> -c Release` und lesen Sie die `IL3050`-Warnung, die das verursachende Member benennt; ersetzen Sie es dann durch eine AOT-kompatible Alternative (einen Source Generator, ein vorinstanziiertes Generic oder einen Feature Switch).

```text
System.PlatformNotSupportedException: Operation is not supported on this platform.
   at System.Reflection.Emit.DynamicMethod..ctor(String name, Type returnType, Type[] parameterTypes)
   at SomeLibrary.Internal.ExpressionCompiler.Compile(LambdaExpression expr)
   at SomeLibrary.PublicEntryPoint.DoTheThing()
   at Program.<Main>$(String[] args) in /src/Program.cs:line 12
```

```text
System.PlatformNotSupportedException: Dynamic code generation is not supported on this platform.
   at System.Reflection.Emit.AssemblyBuilder.DefineDynamicAssembly(...)
   at System.Linq.Expressions.Compiler.LambdaCompiler.CompileLambda(LambdaExpression lambda, Boolean hasClosureArgument)
   at System.Linq.Expressions.Expression`1[[T]].Compile()
```

Diese Anleitung wurde gegen das .NET 11 SDK (Preview 4), `Microsoft.NET.Sdk` 11.0.0-preview.4 und C# 14 verfasst. Der Wortlaut der Exception und die zugrundeliegende Beschränkung sind stabil, seit Native AOT als unterstützte Bereitstellung in .NET 8 ausgeliefert wurde, daher gilt alles Weitere unverändert für .NET 8, 10 und 11. Die Version .NET 9 hat die Analyzer-Geschichte rund um `RequiresDynamicCodeAttribute` ergänzt, die IL3050 stützt, und .NET 11 verschärft sie weiter, indem mehr BCL-Pfade in AOT-sichere Varianten überführt werden.

Zwei unterschiedliche Meldungen teilen sich denselben Exception-Typ. `Operation is not supported on this platform` stammt aus dem schnellen JIT-Emit-Pfad, der über `RuntimeFeature.IsDynamicCodeSupported == false` stolpert. `Dynamic code generation is not supported on this platform` stammt aus `Reflection.Emit` selbst, sobald etwas versucht, ein `DynamicAssembly` oder ein `DynamicMethod` zu erzeugen. Beide haben dieselbe Ursache und dieselbe Lösungsfläche, also verschwenden Sie keine Zeit damit, sie als getrennte Bugs zu behandeln.

## Warum ein Single-File Native-AOT-Binary kein IL emittieren kann

`dotnet publish /p:PublishAot=true` erzeugt ein vollständig vorab kompiliertes natives Image. Der JIT ist nicht statisch gelinkt. Der Mono-Interpreter ist nicht statisch gelinkt. Der CoreCLR-`Reflection.Emit`-Writer wird herauskompiliert. Zur Laufzeit liefert `System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported` `false`, und jede API, die darauf angewiesen ist, frisches IL zu schreiben oder einen frischen Delegate aus rohem Maschinencode zusammenzubauen, gibt entweder ein `IsSupported`-Wächter-Fehlschlagen oder diese Exception zurück.

Die vier Formen, die in echtem Code an diese Beschränkung stoßen:

1. **Direkte `Reflection.Emit`-Verwendung.** `DynamicMethod`, `AssemblyBuilder.DefineDynamicAssembly`, `TypeBuilder`, `ILGenerator.Emit`. Sie werfen sofort.
2. **`Expression<T>.Compile()` über einen nicht trivialen Baum.** Der Expression-Compiler senkt intern auf `DynamicMethod` ab. `Compile(preferInterpretation: true)` fällt unter .NET 8 und 10 auf den Interpreter zurück, aber der Interpreter wird ebenfalls aus Native AOT entfernt, daher wirft sogar die `true`-Überladung, sofern die BCL keinen baumlaufenden Fallback hat.
3. **`Type.MakeGenericType` / `MethodInfo.MakeGenericMethod` mit Typargumenten, die der Compiler nicht gesehen hat.** `List<int>` funktioniert, weil der AOT-Compiler es instanziiert hat. `MakeGenericType(someTypeFromReflection)` über einen Wertetyp, den der Compiler nie erreicht hat, wirft.
4. **Transitiv alles, was auf den oben genannten aufbaut.** Die per Expression kompilierten Mapper von AutoMapper, FastMember, die offenen Generics von MediatR, der Konverter-Cache von Newtonsoft.Json, der Pfad für kompilierte Abfragen in EF Core über POCO-Graphen, die der Model Builder nicht abgedeckt hat, gRPC.Core mit seinem älteren Codegen sowie die Dataverse- / Service-Fabric- / WCF-Clients, die auf dynamischen Proxys aufsetzen.

In einem JIT-Build erzeugt die Laufzeit einfach Tier-0-Codegen für die neue Methode und macht weiter. Unter Native AOT hat sie keinen Ort, an dem der neue Code abgelegt werden kann, daher wirft sie im ersten Moment, in dem die API aufgerufen wird.

## Minimaler Reproduzierer

```csharp
// .NET 11 SDK preview 4, C# 14, <PublishAot>true</PublishAot>
using System.Linq.Expressions;

Expression<Func<int, int>> expr = x => x + 1;
var compiled = expr.Compile();   // throws on Native AOT
Console.WriteLine(compiled(41));
```

`.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <PublishAot>true</PublishAot>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
</Project>
```

Veröffentlichen unter Linux x64:

```bash
dotnet publish -r linux-x64 -c Release
```

Der Publish-Schritt gibt aus:

```text
warning IL3050: Using member 'System.Linq.Expressions.Expression`1<TDelegate>.Compile()' which has 'RequiresDynamicCodeAttribute' can break functionality when AOT compiling. Compiling a lambda requires dynamic code.
```

Binary ausführen:

```text
Unhandled exception. System.PlatformNotSupportedException: Dynamic code generation is not supported on this platform.
```

Dies ist die kanonische Variante des Fehlers. Dieselbe Form gilt, egal ob der Verursacher Ihr eigener Code, ein NuGet-Paket oder ein transitiv mitgezogenes Framework-Stück ist.

## Die Lösung im Detail

Die folgenden Lösungen sind nach Aufwand sortiert, vom günstigsten zum invasivsten. Nehmen Sie die erste, die durchkompiliert.

### 1. API durch eine AOT-kompatible Alternative ersetzen (bevorzugt)

Fast jede problematische API hat inzwischen einen AOT-freundlichen Ersatz, den das .NET-Team genau wegen dieser Klasse von Exception ausgeliefert hat.

| AOT-feindlich | AOT-freundlicher Ersatz |
|---|---|
| `Newtonsoft.Json` | `System.Text.Json` mit einem `[JsonSerializable]`-Source-Generator-Kontext |
| `AutoMapper` (per Expression kompiliert) | Quellgenerierte Mapper (Source-Generator-Modus von Mapster, Riok.Mapperly, `MapTo`) |
| `MediatR` (Registrierung offener Generics) | Handgeschriebene Handler-Interfaces oder `Mediator` (das mit Source Generator) |
| `Microsoft.AspNetCore.Mvc.Controllers` | `WebApplication.CreateSlimBuilder` + Minimal APIs mit `JsonSerializerContext` |
| Zur Laufzeit erzeugtes EF-Core-Modell | `OptimizeQuery` / `dotnet ef dbcontext optimize` zum Vorab-Erzeugen des Modells |
| `Castle.DynamicProxy`-Interzeptoren | Quellgenerierte Decorator (etwa via Roslyn oder PolySharp) |
| `Expression<T>.Compile()` | `delegate*<...>`, ein `Func<...>`-Literal oder ein handgeschriebener `IL`-Ersatz, der zur Build-Zeit kompiliert wird |

Konkretes Beispiel, das den Lambda-Compile-Aufruf ersetzt:

```csharp
// .NET 11, C# 14
// Before: AOT-hostile
Expression<Func<int, int>> expr = x => x + 1;
var compiled = expr.Compile();

// After: pure delegate, no expression tree, no Compile()
Func<int, int> compiled = x => x + 1;
```

Wenn Sie die Form des Expression-Baums wirklich brauchen (weil Sie den Body inspizieren), behalten Sie den Baum, hören aber auf, `Compile()` aufzurufen, und stellen den Konsumenten auf einen `delegate` um, den Sie selbst geschrieben haben.

### 2. `RuntimeFeature.IsDynamicCodeSupported` als Feature Switch verwenden

Wenn der dynamische Pfad optional ist, gaten Sie ihn hinter dem Runtime-Feature-Flag und liefern einen langsamen, aber AOT-sicheren Fallback aus:

```csharp
// .NET 11, C# 14
using System.Runtime.CompilerServices;

public static T Materialize<T>(IDataReader reader)
{
    if (RuntimeFeature.IsDynamicCodeSupported)
    {
        return EmitMaterializer<T>.Compile()(reader);   // existing fast path
    }

    return ReflectionMaterializer<T>.Materialize(reader); // slower but no IL emit
}
```

Der AOT-Compiler wertet `IsDynamicCodeSupported` für das veröffentlichte Binary statisch zu `false` aus und schneidet den gesamten dynamischen Zweig samt `EmitMaterializer<T>` heraus. Kein IL3050 mehr, kein Laufzeit-Wurf mehr. Wichtig: Der Analyzer schneidet nur, wenn der Test der wörtliche Property-Lesezugriff ist; weisen Sie ihn nicht erst einer lokalen Variable zu und kapseln Sie ihn nicht in eine Methode, sonst behält der Trimmer den toten Zweig.

### 3. Generics vorinstanziieren, die der Compiler nicht sehen kann

Wenn die Meldung `MakeGenericType` oder `MakeGenericMethod` benennt, weiß der AOT-Compiler nicht, welches `T` er backen soll. Zwei Auswege:

```csharp
// .NET 11, C# 14
// Tell the AOT compiler exactly which generic instantiations to keep.
[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicConstructors)]
public class Repository<T> { /* ... */ }

// And in your DI bootstrap, use closed generics:
services.AddScoped<Repository<User>>();
services.AddScoped<Repository<Order>>();
// not: services.AddScoped(typeof(Repository<>));
```

Oder wechseln Sie für einen rein reflektiven Aufruf zur quellgenerierten Entsprechung. ASP.NET Core 11 liefert AOT-sichere Überladungen für die gängigen Dependency-Injection-Formen aus; das Runtime-Team hat zudem AOT-freundliche `Activator.CreateInstance<T>()`-Intrinsics für parameterlose Konstruktoren ergänzt.

### 4. Methode als `RequiresDynamicCode` markieren und Aufrufe aus AOT-Pfaden vermeiden

Wenn Sie eine Bibliothek schreiben und eine Methode tatsächlich dynamisches Codegen braucht, geben Sie die Anforderung an Ihre Aufrufer weiter, damit der Analyzer auf deren Ebene warnen kann:

```csharp
// .NET 11, C# 14
[RequiresDynamicCode("Builds a per-type accessor with Reflection.Emit. " +
                     "Not supported in Native AOT. Use SourceGenAccessor<T> instead.")]
public static Func<object, object> BuildGetter(PropertyInfo prop) => /* emit */;
```

Das Attribut behebt die Laufzeit-Exception nicht, wandelt aber den stillen Crash in eine Build-Zeit-IL3050 um, was genau der Vertrag ist, den Native-AOT-Konsumenten erwarten.

### 5. Abhängigkeit entfernen

Letzte Möglichkeit. Wenn eine Bibliothek, von der Sie abhängen, `Reflection.Emit` fest verdrahtet und keinen AOT-Modus bietet, sind die einzigen ehrlichen Optionen (a) die Bibliothek zu ersetzen, (b) dieses Subsystem hinter einer Nicht-AOT-Prozessgrenze zu lassen (ein per JIT veröffentlichter Worker hinter einer HTTP- oder Named-Pipe-Grenze) oder (c) darauf zu warten, dass der Upstream-Maintainer einen AOT-Pfad ausliefert. Klemmen Sie die Exception nicht mit einem `try/catch` ab; das Programm befindet sich danach in einem undefinierten Zustand, weil der Konsument fast sicher von der fehlgeschlagenen Operation abhängt.

## Häufige Varianten und ähnliche Fehler

- **`PlatformNotSupportedException: System.Reflection.Emit.DynamicMethod` aus `System.Linq.Expressions`.** Dieselbe Ursache wie bei Compile(), tritt häufig in `Queryable`-Providern und JSON-Convertern auf. Suchen Sie im Publish-Log nach der IL3050-Zeile, die die ursprüngliche Methode benennt. Wenn Sie aus einem JSON-Serialisierer hierherkommen, sehen Sie sich [unsere Anleitung zum Schreiben AOT-sicherer System.Text.Json-Converter](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) an.
- **`PlatformNotSupportedException: Operation is not supported on this platform` aus `Assembly.Load(byte[])`.** Native AOT erlaubt es nicht, zur Laufzeit weitere verwaltete Assemblies zu laden. Es gibt keinen Fallback. Verlagern Sie das Plug-in-Laden in einen Nicht-AOT-Host.
- **`PlatformNotSupportedException: Cannot emit a dynamic assembly.` aus `Castle.DynamicProxy`.** Castle hat ab 5.x keinen AOT-Pfad; ersetzen Sie die Interzeption durch quellgenerierte Decorator oder lagern Sie den per Proxy abgedeckten Service aus dem AOT-Binary aus.
- **`NotSupportedException: BinaryFormatter serialization and deserialization are disabled.`** Anderer Exception-Typ, aber dasselbe Grundthema "aus dem AOT-Binary entfernt". Klemmen Sie es nicht mit `try/catch` ab; schreiben Sie die Serialisierung auf System.Text.Json um.
- **`PlatformNotSupportedException: ... requires the JIT.`** Diese Meldung sehen Sie auf Mono-Interpreter-Zielen (iOS, watchOS, MAUI Catalyst), wenn der Interpreter ebenfalls deaktiviert ist. Die Lösungsfläche ist dieselbe wie unter Native AOT: das Generic vorbacken, auf einen Source Generator umstellen oder den Pfad hinter einen Feature Switch packen.
- **Der Fehler tritt nur auf einer einzigen Plattform auf.** Manche Pakete liefern ein NuGet-Runtime-Asset pro RID. Der `linux-x64`-Build kompiliert eventuell mit deaktiviertem `Reflection.Emit`, während `win-x64` funktioniert. Testen Sie das Publish immer für jede ausgelieferte RID.

## Wie Sie überprüfen, ob es wirklich behoben ist

Drei Prüfungen, bevor Sie Sieg verkünden:

1. `dotnet publish -r <rid> -c Release` produziert keine `IL3050`-Warnung mehr. Heben Sie sie mit `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` und `<IsAotCompatible>true</IsAotCompatible>` zu Fehlern an.
2. Das veröffentlichte Binary führt den zuvor fehlschlagenden Pfad unter `DOTNET_TieredCompilation=0` und `DOTNET_ReadyToRun=0` aus. Native AOT respektiert diese Variablen nicht, aber sie sind ein schneller Weg, um zu bestätigen, dass Sie nicht versehentlich einen self-contained JIT-Build testen.
3. Die Imports-Tabelle des veröffentlichten Binarys enthält keinen Verweis auf den JIT (`clrjit.dll` / `libclrjit.so`). Unter Linux sollte `nm --dynamic` auf dem Binary keine `clrjit`-Symbole zeigen.

Wenn alle drei durchgehen, haben Sie ein AOT-sauberes Binary und die Exception kommt nicht über denselben Pfad zurück.

## Verwandt

- [Wie man Native AOT mit ASP.NET Core Minimal APIs verwendet](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) geht den gesamten Publish-Pfad und die IL3050-Warnungsfläche für einen typischen Webservice durch.
- [Wie man die Cold-Start-Zeit für eine .NET 11 AWS Lambda reduziert](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) ist der Grund, aus dem die meisten Teams überhaupt zu Native AOT greifen.
- [Wie man einen eigenen JsonConverter in System.Text.Json schreibt](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) ist der AOT-sichere Ersatz, wenn Sie versucht waren, einem `JsonSerializer` reflektive Metadaten in die Hand zu drücken.
- [Wie man einen Source Generator für INotifyPropertyChanged schreibt](/de/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) ist das Muster, das Sie verwenden, sobald eine bestehende Bibliothek `Reflection.Emit` für Sie tun möchte.
- [Rider 2026.1 bringt einen ASM-Viewer, der JIT- und Native-AOT-Ausgabe dekodiert](/de/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) ist nützlich, wenn Sie überprüfen möchten, dass der Trimmer den dynamischen Zweig wirklich entfernt hat.

## Quellen

- [Native AOT deployment overview, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [IL3050: Avoid calling members annotated with RequiresDynamicCodeAttribute when publishing as Native AOT, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/warnings/il3050)
- [Introduction to AOT warnings, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/fixing-warnings)
- [Intrinsic APIs marked RequiresDynamicCode, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/intrinsic-requiresdynamiccode-apis)
- [How to make libraries compatible with Native AOT, .NET Blog](https://devblogs.microsoft.com/dotnet/creating-aot-compatible-libraries/)
- [AOT with Reflection, dotnet/runtime discussion #95244](https://github.com/dotnet/runtime/discussions/95244)
- [RuntimeFeature.IsDynamicCodeSupported, .NET API browser](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.runtimefeature.isdynamiccodesupported)
