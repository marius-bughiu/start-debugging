# System.Text.Json options and generated metadata

Requires the .NET 8 runtime and the .NET 8 SDK or newer. Installing only a newer major runtime does not satisfy a `net8.0` application's default runtime requirement. There are no additional package dependencies.

From this folder:

```sh
dotnet run -c Release
```

The program checks reflection-disabled serialization failures, a source-generated serialize/deserialize round trip, explicit `TypeInfoResolver` configuration, `MakeReadOnly`, rejected mutation, and an independently configurable options copy. It throws if an observed result differs from the expected value. A successful run ends with `All checks passed.`

The default project setting disables reflection defaults. To exercise the same cases with reflection defaults enabled on CoreCLR:

```sh
dotnet run -c Release --property:JsonSerializerIsReflectionEnabledByDefault=true
```

To build and execute against .NET 10 instead, install its SDK/runtime and select the project's alternate target:

```sh
dotnet run -c Release --property:ExampleTargetFramework=net10.0
dotnet run -c Release --property:ExampleTargetFramework=net10.0 --property:JsonSerializerIsReflectionEnabledByDefault=true
```

`ExampleTargetFramework` defaults to `net8.0`. It changes the build target; it does not enable runtime roll-forward or make a .NET 8 binary into a .NET 10 build.

With the .NET 8 Native AOT toolchain installed, the tested macOS arm64 publish command is:

```sh
dotnet publish -c Release -r osx-arm64 --property:PublishAot=true -o ./publish
./publish/SystemTextJsonOptions
```

The test harness deliberately invokes reflection-sensitive overloads to demonstrate failure cases. Native AOT publishing reports `IL2026` and `IL3050` analysis warnings for these calls, including options-taking overloads whose resolver is explicitly source-generated. Those warnings are retained, not suppressed. The native binary was executed successfully on the platform recorded in [VERIFICATION.md](VERIFICATION.md); this is not a warning-free production template or a performance benchmark. The simplest application path is the overload taking generated `JsonTypeInfo<T>` directly.

References: [System.Text.Json source generation](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation), [MakeReadOnly](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.makereadonly?view=net-8.0), and [trimmed serialization defaults](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed).
