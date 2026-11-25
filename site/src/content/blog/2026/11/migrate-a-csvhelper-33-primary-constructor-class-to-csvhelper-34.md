---
title: "Migrate a CsvHelper 33 class with a primary constructor to CsvHelper 34 (fix CSVH002)"
description: "Why CsvHelper 34 fails with CSVH002 on a write-only class whose primary constructor takes another object, and four verified fixes on CsvHelper 34.1.0 and .NET 11 that write byte-identical CSV to 33.1."
pubDate: 2026-11-25
updatedDate: 2026-11-25
template: migration
tags:
  - "migration"
  - "dotnet"
  - "csharp"
  - "csv"
  - "csvhelper"
  - "source-generators"
---

If you upgrade from CsvHelper 33.1 to CsvHelper 34 and mark a class like `public partial class Row(Source source)` with `[CsvRecord]`, the build fails with `error CSVH002: '...source' has type 'Source', which cannot be read from a CSV field`. CsvHelper 34 generates a reader and a writer for every `[CsvRecord]` type, and the reader must call a constructor. With no parameterless constructor, the generator picks the one with the most parameters, your primary constructor, and it cannot read a `Source` from a CSV field. `[CsvIgnore]` cannot fix it: it is not valid on parameters. The fix is to give the generator another constructor: add `[CsvConstructor] private Row() : this(new Source()) { }`, or turn the class into a positional record, or, if you only write the file, drop `[CsvRecord]` and write with `WriteCsv` from CsvHelper.Linq. All four options below write byte-identical output to CsvHelper 33.1.

Everything in this guide was run on macOS (arm64) with the .NET SDK 11.0.100 targeting `net11.0`, against CsvHelper 33.1.0, 34.0.0 and 34.1.0 and CsvHelper.Linq 34.1.0 from nuget.org. 34.0.0 was tagged on 28 October 2026 and 34.1.0 on 19 November 2026. The compiler errors, exceptions and CSV output quoted here are copied from those builds. The example class is the one from the Stack Overflow question that prompted this guide, ["How can I define a CsvRecord in CsvHelper 34 with a primary constructor that takes an object?"](https://stackoverflow.com/questions/80014535).

## Why move to CsvHelper 34 at all

- **No reflection at run time.** CsvHelper 33 built its class maps with reflection on first use. 34 uses a source generator that writes the mapping code at compile time, so record reading and writing are trimming and native AOT safe. If you are publishing with [native AOT](/2026/06/what-is-native-aot-and-what-does-it-cost-you/), this is the reason to upgrade.
- **A rewritten reader.** The 34 reader parses UTF-8 bytes instead of characters, with SIMD on .NET 8 and later. The [v34 migration guide](https://github.com/JoshClose/CsvHelper/blob/master/docs/releases/v34.0.0/migration.md) describes it as a rewrite, and almost every public type changed.
- **Mapping errors at build time.** A member CsvHelper cannot read or write is a compile error (CSVH001 to CSVH012) instead of a runtime surprise on the first file. That is exactly the error this guide is about.

The cost is that 34 is not a drop-in upgrade. `CsvConfiguration`, `ClassMap<T>` and `new CsvWriter(writer, culture)` are gone, and any class you read or write as a record has to opt in.

## What breaks for a write-only "projection" class

This is the 33.1 class. It exists only to flatten a `TargetFrameworkResult` into four columns for a report:

```csharp
// CsvHelper 33.1.0, .NET 11
public class CsvTargetFrameworkResult(TargetFrameworkResult targetFrameworkResult)
{
    public string? ProjectName { get; set; } = targetFrameworkResult.Project?.Name;
    public string? RepositoryName { get; set; } = targetFrameworkResult.Repository?.Name;
    public string? Path { get; set; } = targetFrameworkResult.Path;
    public string Version { get; set; } = string.Join(';', targetFrameworkResult.TargetFrameworks);
}
```

In 33.1 it is written with reflection, and nothing ever tries to read it. In 34 the same class hits two different walls depending on what you do with it:

| What you do in 34 | Result | When |
| --- | --- | --- |
| Leave the class as it is, call `CsvWriter.WriteRecords` | `InvalidOperationException: CsvTargetFrameworkResult has no CSV record writer` | run time |
| Add `[CsvRecord]` and `partial`, as the migration guide says | `CSVH002`, build fails | compile time |
| Put `[CsvIgnore]` on the constructor parameter | `CS0592` plus `CSVH002`, build fails | compile time |
| Put `[CsvConverter]` on the constructor parameter | builds, then `InvalidOperationException` on the first write | run time |
| Add a `[CsvConstructor]` constructor that chains to the primary one | works | |

The models used throughout, so you can reproduce every row of that table:

```csharp
// Model.cs, shared by every project in this guide
namespace Repro;

public class TargetFrameworkResult
{
    public string? Path { get; set; }
    public Project? Project { get; set; }
    public Repository? Repository { get; set; }
    public List<string> TargetFrameworks { get; set; } = [];
}
public class Project { public string? Name { get; set; } }
public class Repository { public string? Name { get; set; } }

public static class Data
{
    public static List<TargetFrameworkResult> Results() =>
    [
        new() { Path = "src/Api/Api.csproj", Project = new() { Name = "Api" }, Repository = new() { Name = "shop" }, TargetFrameworks = ["net10.0", "net8.0"] },
        new() { Path = "src/Legacy, Old/Legacy.csproj", Project = new() { Name = "Legacy \"v1\"" }, Repository = null, TargetFrameworks = ["net48"] },
    ];
}
```

The second row has a comma, embedded quotes and a null on purpose, so the output exercises quoting and null handling. CsvHelper 33.1 writes this, with CRLF line endings:

```text
ProjectName,RepositoryName,Path,Version
Api,shop,src/Api/Api.csproj,net10.0;net8.0
"Legacy ""v1""",,"src/Legacy, Old/Legacy.csproj",net48
```

That file is the baseline. Every fix below was compared to it with `cmp`.

## Why the generator wants your constructor

The [records documentation](https://github.com/JoshClose/CsvHelper/blob/master/docs/pages/records.md) lists what a `[CsvRecord]` type reads: settable public and internal properties and fields, base class members, and "the parameters of the constructor". The constructor is chosen in this order:

1. the constructor marked `[CsvConstructor]`;
2. else the parameterless constructor;
3. else the public or internal constructor with the most parameters, which for a primary constructor is the primary constructor.

A primary constructor on a class removes the implicit parameterless constructor, so rule 3 applies and `targetFrameworkResult` becomes a column the generator must parse. `TargetFrameworkResult` has no static `Parse` method and no converter, so the generator reports CSVH002.

It does not matter that you only call `WriteRecords`. `[CsvRecord]` always generates both a mapper (reader) and a record writer, and the mapper has to compile. On CsvHelper 34.0.0 the message pointed you the wrong way:

```text
error CSVH002: 'CsvTargetFrameworkResult.targetFrameworkResult' has type 'Repro.TargetFrameworkResult', which cannot be read from a CSV field; use a type with a static Parse method or add [CsvIgnore]
```

Following that advice gives you a second error, because `CsvIgnoreAttribute` targets only properties, fields and indexers:

```text
error CS0592: Attribute 'CsvIgnore' is not valid on this declaration type. It is only valid on 'property, indexer, field' declarations.
```

The original reporter filed this as [JoshClose/CsvHelper#2402](https://github.com/JoshClose/CsvHelper/issues/2402). The maintainer's answer was that ignoring a parameter cannot work: the constructor still has to be called, and the only value available for a left-out parameter is `null`, which the property initializers would dereference. [PR #2417](https://github.com/JoshClose/CsvHelper/pull/2417) shipped in 34.1.0 and changed the message instead. On 34.1.0 the same class now reports:

```text
error CSVH002: 'CsvTargetFrameworkResult.targetFrameworkResult' has type 'Repro.TargetFrameworkResult', which cannot be read from a CSV field; it is a parameter of the constructor that creates the records (the one with the most parameters), and constructor parameters cannot be ignored; mark another constructor [CsvConstructor] (it can be private), or give the parameter a [CsvConverter]
```

The first suggestion is the right one for this shape of class. The second one is a trap for write-only classes, covered in the gotchas below.

## Pre-flight checklist

- .NET SDK 6.0.400 or later (Roslyn 4.3), and C# 9 or later. The generator ships inside the CsvHelper package; an older compiler does not run it, and every record call then throws "has no CSV record writer" at run time.
- Upgrade straight to CsvHelper 34.1.0, not 34.0.0. The chained `[CsvConstructor]` fix also builds and writes the same bytes on 34.0.0, but 34.1.0 has the corrected CSVH002 message and the `[CsvRecordMap]` and override fixes listed in the [34.1.0 changelog](https://github.com/JoshClose/CsvHelper/blob/master/docs/releases/v34.1.0/changelog.md).
- Before you touch any code, write one representative file with 33.1 and keep it. You will `cmp` against it.
- Find every class you pass to `WriteRecords` or `GetRecords`: in 34 each one needs `[CsvRecord]`, a `[CsvRecordMap]` map class, or a hand-written mapper.

## Migration steps

1. **Bump the package and port the writer call.** Change `<PackageReference Include="CsvHelper" Version="33.1.0" />` to `Version="34.1.0"`. Replace `new CsvWriter(new StreamWriter(path), CultureInfo.InvariantCulture)` with `CsvWriter.ToFile(path)`; 34 needs no culture and formats with the invariant culture by default. Verify: the project builds except for the record types, and every remaining error is CSVH001 or CSVH002.

2. **Mark the class `[CsvRecord]` and `partial`.** This produces the CSVH002 above for any class whose only constructor takes a non-CSV type. Verify: the error names the constructor parameter, not a property. A property with a complex type is a different problem, fixed with `[CsvIgnore]` or by making that type a nested `[CsvRecord]`.

3. **Add a `[CsvConstructor]` constructor that chains to the primary one.** It can be private, because the generated code is part of your `partial` class:

    ```csharp
    // CsvHelper 34.1.0, .NET 11, C# 14
    using CsvHelper;
    using Repro;

    [CsvRecord]
    public partial class CsvTargetFrameworkResult(TargetFrameworkResult targetFrameworkResult)
    {
        [CsvConstructor]
        private CsvTargetFrameworkResult() : this(new TargetFrameworkResult()) { }

        public string? ProjectName { get; set; } = targetFrameworkResult.Project?.Name;
        public string? RepositoryName { get; set; } = targetFrameworkResult.Repository?.Name;
        public string? Path { get; set; } = targetFrameworkResult.Path;
        public string Version { get; set; } = string.Join(';', targetFrameworkResult.TargetFrameworks);
    }
    ```

    Verify: `dotnet build` is clean, with zero warnings.

4. **Write the file and compare it to the 33.1 output.**

    ```csharp
    // CsvHelper 34.1.0, .NET 11
    var rows = Data.Results().Select(r => new CsvTargetFrameworkResult(r));
    using (var csv = CsvWriter.ToFile("out.csv"))
    {
        csv.WriteRecords(rows);
    }
    ```

    Verify: `cmp out.csv baseline-33.csv` prints nothing. In the run for this guide it was byte-identical: same header, same column order, same quoting of `"Legacy ""v1"""` and of the path with a comma, empty field for the null `RepositoryName`, CRLF line endings.

5. **Read the file back once, even if you never read it in production.**

    ```csharp
    // CsvHelper 34.1.0, .NET 11
    using var reader = CsvReader.FromFile("out.csv");
    foreach (var r in reader.GetRecords<CsvTargetFrameworkResult>())
        Console.WriteLine($"{r.ProjectName} | {r.RepositoryName} | {r.Path} | {r.Version}");
    ```

    Verify: both rows come back with the values you wrote. This proves your `[CsvConstructor]` does not throw, which matters for the `null!` variant described below.

With `-p:EmitCompilerGeneratedFiles=true` you can see what step 3 bought you. In the generated `CsvTargetFrameworkResult.CsvRecord.g.cs`, the mapper creates records with `new global::CsvTargetFrameworkResult()` followed by an object initializer for the four properties, and the record writer is four `writer.WriteField(record.X)` calls. CsvHelper never needs a `TargetFrameworkResult` from the file: it calls your private constructor, which passes an empty object to the primary constructor, and then overwrites the four properties with the column values.

## Three other shapes that work

The chained constructor is the smallest diff, but it is not the only option. Each of these was built against CsvHelper 34.1.0 and produced output byte-identical to the 33.1 baseline.

### A positional record

If the class is just a bag of four strings, a positional record makes the CSV shape the primary constructor and moves the "made from another object" constructor to a secondary one:

```csharp
// CsvHelper 34.1.0, .NET 11, C# 14
[CsvRecord]
[method: CsvConstructor]
public partial record CsvTargetFrameworkResult(string? ProjectName, string? RepositoryName, string? Path, string Version)
{
    public CsvTargetFrameworkResult(TargetFrameworkResult result) : this(
        result.Project?.Name,
        result.Repository?.Name,
        result.Path,
        string.Join(';', result.TargetFrameworks))
    {
    }
}
```

`[method: CsvConstructor]` targets the primary constructor. Strictly, you do not need it here: the primary constructor has four parameters and the secondary one has one, so rule 3 already picks the primary constructor, but stating it protects you from someone adding a second four-parameter constructor later (that would be CSVH003, ambiguous constructors). The columns are written in constructor parameter order, which here matches the 33.1 property order. If you reorder the parameters, you reorder the file. If you are unsure whether a record is the right fit, the trade-offs are in [record vs class vs struct in C#](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/).

### A conventional class with a private parameterless constructor

This is the version the accepted Stack Overflow answer recommends when the type is read as well as written. It avoids property initializers that depend on a constructor parameter, so there is nothing for a dummy argument to break:

```csharp
// CsvHelper 34.1.0, .NET 11, C# 14
[CsvRecord]
public partial class CsvTargetFrameworkResult
{
    [CsvConstructor]
    private CsvTargetFrameworkResult() { }

    public CsvTargetFrameworkResult(TargetFrameworkResult result)
    {
        ProjectName = result.Project?.Name;
        RepositoryName = result.Repository?.Name;
        Path = result.Path;
        Version = string.Join(';', result.TargetFrameworks);
    }

    public string? ProjectName { get; set; }
    public string? RepositoryName { get; set; }
    public string? Path { get; set; }
    public string Version { get; set; } = "";
}
```

### No `[CsvRecord]` at all: `WriteCsv` from CsvHelper.Linq

If the class is never read, you can leave the 33.1 class completely unchanged, no attribute, no `partial`, and write it with the `WriteCsv` extension from the [CsvHelper.Linq](https://www.nuget.org/packages/CsvHelper.Linq) package. For types that are not `[CsvRecord]`, `WriteCsv` writes the public properties and fields of simple types: first the members the widest public constructor sets, in its order, then the rest in declaration order. Members of complex types are left out.

```xml
<!-- .csproj -->
<PackageReference Include="CsvHelper" Version="34.1.0" />
<PackageReference Include="CsvHelper.Linq" Version="34.1.0" />
```

```csharp
// CsvHelper 34.1.0 + CsvHelper.Linq 34.1.0, .NET 11
using CsvHelper.Linq;
using Repro;

long written = Data.Results()
    .Select(r => new CsvTargetFrameworkResult(r))
    .WriteCsv("out.csv");

public class CsvTargetFrameworkResult(TargetFrameworkResult targetFrameworkResult)
{
    public string? ProjectName { get; set; } = targetFrameworkResult.Project?.Name;
    public string? RepositoryName { get; set; } = targetFrameworkResult.Repository?.Name;
    public string? Path { get; set; } = targetFrameworkResult.Path;
    public string Version { get; set; } = string.Join(';', targetFrameworkResult.TargetFrameworks);
}
```

Note that `WriteCsv` returns a `long`, not an `int`; `int n = ...WriteCsv(...)` is a `CS0266` compile error. The same extension writes anonymous types, so if the class existed only to name the columns, you can delete it:

```csharp
// CsvHelper 34.1.0 + CsvHelper.Linq 34.1.0, .NET 11
Data.Results()
    .Select(r => new
    {
        ProjectName = r.Project?.Name,
        RepositoryName = r.Repository?.Name,
        r.Path,
        Version = string.Join(';', r.TargetFrameworks),
    })
    .WriteCsv("out.csv");
```

Both produced the same bytes as the 33.1 baseline. The [CsvHelper.Linq docs](https://github.com/JoshClose/CsvHelper/blob/master/docs/pages/linq.md) state that `WriteCsv` and `AppendCsv` are safe for trimming and native AOT, even though the query provider in the same package is not.

## Which fix to pick

| Your class | Use |
| --- | --- |
| Only written, you want the smallest diff | Chained `[CsvConstructor]` (step 3), or plain class plus `WriteCsv` |
| Only written, exists just to name columns | Anonymous type plus `WriteCsv`, delete the class |
| Written and read back | Conventional class with private `[CsvConstructor]`, or a positional record |
| You need `[CsvColumn]`, `[CsvFormat]`, converters per column | `[CsvRecord]` with any of the constructor fixes; `WriteCsv` honours only `[CsvIgnore]` and the `[CsvColumn]` name for plain types |
| The type belongs to another library | A `[CsvRecordMap]` map class, but read the last gotcha first |

## Gotchas found while testing

**`this(null!)` writes fine and breaks on read.** The first answer most people reach for is `[CsvConstructor] private Row() : this(null!) { }`. It compiles and it writes the correct file. Reading that file back fails on the first record:

```text
CsvFormatException: Cannot read record 2 as CsvTargetFrameworkResult: Object reference not set to an instance of an object.
```

The property initializers run as part of the primary constructor and dereference the `null`. If any code path, a test, an import tool, a colleague, ever calls `GetRecords<T>()` on the type, pass a real default such as `new TargetFrameworkResult()`. If the type is truly write-only, `WriteCsv` is the more honest choice than a mapper that throws.

**`[CsvConverter]` on the parameter builds, then fails on the first write.** The 34.1.0 message suggests a converter as an alternative. For this shape it moves the error to run time:

```text
System.InvalidOperationException: Records of CsvTargetFrameworkResult cannot be written: the constructor parameter 'targetFrameworkResult' has no property or field to write it from.
```

A constructor parameter becomes a column in both directions, and the writer needs a property or field with the same name to read the value from. A converter is for a parameter whose value is really in the file in a custom format, not for an object the file never contains.

**An unchanged class compiles and throws only at run time.** Leaving the 33.1 class without `[CsvRecord]` and calling `csv.WriteRecords(rows)` builds cleanly and throws on the first call:

```text
System.InvalidOperationException: CsvTargetFrameworkResult has no CSV record writer. Mark it [CsvRecord] and partial, and reference the CsvHelper source generator, or register one with CsvRecordWriter.Register.
```

Because nothing fails at build time, an export path covered by no test will ship broken. Search the solution for `WriteRecords` and `GetRecords` and check each type argument.

**Column order now follows the constructor first.** For `[CsvRecord]` types, 34 writes constructor parameters first, then the other members in declaration order, base class members first. With a private parameterless `[CsvConstructor]` nothing changes. With a positional record the order is the parameter order. In 33.1, the order came from reflection over the properties. If a downstream consumer reads columns by position, compare the header line, not just the values.

**A null string reads back as an empty string.** `RepositoryName` was `null` when written and came back as `""` from `GetRecords`. CsvHelper 33.1 reading the same file into a plain class also gave `""`, so this is not a regression. If you need null and empty to round-trip separately, set `NullValue = "NULL"` on the writer options and `NullValues = ["NULL"]` on the reader, or use `[CsvNullValues]` on the member.

**A `[CsvRecordMap]` does not rescue this shape.** If the projection class lives in a library you cannot edit, the map class route looks attractive. A map uses the mapped type's constructors with the same three rules, and it cannot call a private constructor of the mapped type, so the class as written has no constructor a map can use. Per the PR #2417 notes, the escape hatch is a stand-in member with the parameter's name and a `[CsvConverter]` on the map, which brings back the write problem above. For a type you cannot change that is only written, `WriteCsv` is the practical answer.

## Verification

Run these after migrating each record type:

- `dotnet build` reports zero CSVH errors and zero CSVH005/CSVH010 warnings.
- `cmp` of a file written by 34.1.0 against one written by 33.1.0 from the same data prints nothing, or every difference is one you intended (column order, line endings via `NewLine`).
- A round-trip test, `WriteRecords` then `GetRecords<T>()`, passes for every type that is not deliberately write-only.
- If you publish with trimming or native AOT, the publish has no new IL2026/IL3050 warnings from CsvHelper. `WriteRecords`, `GetRecords` and `WriteCsv` should not produce any.

## Rollback plan

Rolling back is a package downgrade plus reverting the writer construction, as long as you did not adopt 34-only APIs. The `[CsvRecord]` and `[CsvConstructor]` attributes do not exist in 33.1, so a rollback also means removing them; the extra private constructor and the `partial` keyword are harmless and can stay. Keep the 33.1 baseline file until the 34 export has been in production for a release cycle.

## Related

- [How to read a large CSV in .NET 11 without running out of memory](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) compares CsvHelper with the other streaming options.
- [What is a source generator and when do I need one?](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) explains the mechanism CsvHelper 34 now relies on.
- [Record vs class vs struct in C#](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) helps decide between the positional record and class fixes.
- [What is native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) covers the publish mode that makes the reflection-free mapping worth the migration.

## Sources

- [CsvHelper v34.0.0 migration guide](https://github.com/JoshClose/CsvHelper/blob/master/docs/releases/v34.0.0/migration.md), "Records" and "Class maps" sections.
- [CsvHelper records documentation](https://github.com/JoshClose/CsvHelper/blob/master/docs/pages/records.md): members that are read, constructor selection, "A constructor for types made from other objects", writing records, compile-time diagnostics.
- [CsvHelper.Linq documentation](https://github.com/JoshClose/CsvHelper/blob/master/docs/pages/linq.md), "Writing query results".
- [CsvHelper v34.1.0 changelog](https://github.com/JoshClose/CsvHelper/blob/master/docs/releases/v34.1.0/changelog.md).
- [JoshClose/CsvHelper#2402](https://github.com/JoshClose/CsvHelper/issues/2402), "Should CsvIgnore be applicable to constructor parameters?", and [PR #2417](https://github.com/JoshClose/CsvHelper/pull/2417), which changed the CSVH002 message.
- [Stack Overflow question 80014535](https://stackoverflow.com/questions/80014535) and its answers.
