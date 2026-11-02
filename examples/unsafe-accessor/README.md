# UnsafeAccessor member access

Requires the .NET 8 runtime, with the .NET 8 SDK or a newer SDK. Installing only a newer major runtime does not satisfy a `net8.0` application's default runtime requirement. From this folder:

```sh
dotnet run -c Release
```

The program exits unsuccessfully if an observed value differs from the expected result. It covers overloaded private constructors, instance and static methods/properties, fields, and a readonly-field write observed through its accessor.

Static accessors use a nullable first parameter to identify the declaring type. Its value is unused; no instance is required for the static member.

The readonly case deliberately bypasses normal C# field-access rules. It does not establish that arbitrary writes are supported under every JIT/AOT optimization or that other reads must observe a mutation. Prefer constructor initialization or an explicitly mutable design in application code.

Source: [UnsafeAccessorAttribute API](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute).
