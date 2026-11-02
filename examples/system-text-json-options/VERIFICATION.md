# Verification — November 2, 2026

All executions below ran locally on macOS arm64. There are no project package dependencies.

| Build target | Actual SDK | Actual runtime | Checks | Result |
| --- | --- | --- | --- | --- |
| `net8.0`, CoreCLR | 8.0.427 | 8.0.33 | Reflection defaults disabled and enabled; all console assertions | Passed |
| `net10.0`, CoreCLR | 10.0.302 | 10.0.10 | Separate build with `ExampleTargetFramework=net10.0`; reflection defaults disabled and enabled; all assertions | Passed |
| `net8.0`, Native AOT `osx-arm64` | 8.0.427 | Native binary from .NET 8.0.33 toolchain | Publish and execute this project's exact source with reflection defaults disabled | Passed |

The two complete article `Program.cs` samples were also extracted and independently compiled/executed against both targets. Their exact published output matched. The reflection article's alternate `TypeInfoResolver` snippet was run in a complete harness against both targets. That is ten CoreCLR executions in total: four complete-project variants, four complete article programs, and two resolver-snippet harnesses.

The source-generated path serializes `Widget(42, "Ada")` and checks an equal deserialized record. The project checks that default serialization and serialization with empty options fail when reflection defaults are disabled. It also checks that an unconfigured `MakeReadOnly()` fails, configured options freeze, repeated freezing succeeds, mutation is rejected, and a copy is initially mutable and freezes on serialization. With reflection defaults enabled, `populateMissingResolver: true` selects `DefaultJsonTypeInfoResolver`; with defaults disabled and no resolver supplied, it fails.

## Reproduction commands

Use the SDK corresponding to the target. From the example directory:

```sh
dotnet run -c Release
dotnet run -c Release --property:JsonSerializerIsReflectionEnabledByDefault=true
dotnet run -c Release --property:ExampleTargetFramework=net10.0
dotnet run -c Release --property:ExampleTargetFramework=net10.0 --property:JsonSerializerIsReflectionEnabledByDefault=true
dotnet publish -c Release -r osx-arm64 --property:PublishAot=true -o ./publish
./publish/SystemTextJsonOptions
```

For the local checks, `UseSharedCompilation=false` and `NuGetAudit=false` were also passed, package sources were cleared, and cached Microsoft toolchain packages were used for Native AOT. Those settings isolate the checks; the project does not require them. The runtime configuration files confirmed `Microsoft.NETCore.App` 8.0.0 and 10.0.0 target requirements, respectively; execution used the installed patch runtimes listed above.

## Reflection-disabled output

```text
Reflection enabled: False
Default serialization: InvalidOperationException
Empty options serialization: InvalidOperationException
{"Id":42,"Name":"Ada"}
Round trip: 42 Ada
Options resolver: passed
Unconfigured MakeReadOnly: InvalidOperationException
Frozen: True
Frozen mutation: InvalidOperationException
{"ID":42,"NAME":"Ada"}
Copy frozen: False
{"id":42,"name":"Ada"}
Populate missing resolver: InvalidOperationException
All checks passed.
```

The native binary printed this same output and exited with code 0. The enabled runs instead report `Reflection enabled: True`, a passing default serialization, and `Populate missing resolver: reflection resolver`.

## Warnings and limits

Native AOT publishing retained `IL2026` and `IL3050` warnings for the deliberately exercised reflection-sensitive overloads. These include the options-taking serialization overloads, even where an explicit generated resolver is supplied, and `MakeReadOnly(bool)`. The macOS linker also reported that `-ld_classic` is no longer supported and was ignored. No warning was suppressed. The direct generated `JsonTypeInfo<Widget>` path is the simpler application example; this full harness also demonstrates failures and alternative overloads.

This was not a performance or binary-size measurement. Successful execution covers these fixed inputs on macOS arm64; it does not establish warning-free Native AOT compatibility for every model, library, or platform. No Windows or Linux native binary was executed.

## Verified source hashes

- `Program.cs` SHA-256: `45b27efdc7522ebeab104e15f5dc055434e54b6c4178f8155c8e3252be08b587`
- `SystemTextJsonOptions.csproj` SHA-256: `a02d93486af1d2c0ccacb7d8f6b9ce9e09973bc0ca3e1d972d09453c88cd9d05`
