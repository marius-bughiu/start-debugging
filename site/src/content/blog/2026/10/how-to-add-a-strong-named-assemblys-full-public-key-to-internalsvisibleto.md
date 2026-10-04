---
title: "How to add a strong-named assembly's full public key to InternalsVisibleTo in an SDK-style project"
description: "A signed assembly must name its friend by the full 320-character public key, not the token, or the build fails with CS1726 or CS0281. Get the key with sn -p and sn -tp, or with a cross-platform .NET script, then put it in the Key metadata of an InternalsVisibleTo item in the .csproj. Covers the PublicKey property fallback, Moq's DynamicProxyGenAssembly2 key, and the line-break trap."
pubDate: 2026-10-04
template: how-to
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "msbuild"
  - "unit-testing"
  - "how-to"
---

Short answer: when the assembly that grants access is strong-named, `InternalsVisibleTo` must carry the friend assembly's **full public key** (the long hex string starting with `0024000004800000...`), never the 16-character `PublicKeyToken`. In an SDK-style project you do not need an `AssemblyInfo.cs` for this: add `<InternalsVisibleTo Include="MyLib.Tests" Key="0024000004800000940000000602..." />` to an `ItemGroup` and the SDK generates the attribute for you. Get the key from the friend's `.snk` with `sn -p key.snk key.pub` followed by `sn -tp key.pub` on Windows, or with the small .NET script below on any OS. The key must be one unbroken string with no spaces or line breaks, or the compiler silently ignores the grant.

Everything in this post was run on .NET 10 (SDK 10.0.302) on macOS, against a strong-named class library and a strong-named test project, so the error texts quoted below are real compiler output. The MSBuild item has been supported since the .NET 5 SDK, and the rules on the compiler side have not changed since .NET Framework 2.0.

## The two errors you get without the full key

Start with the setup most people have: a signed library and a signed test project, plus the item that works fine for unsigned projects.

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

Building fails inside the **library**, on a file you never wrote:

```text
obj/Debug/net10.0/Contoso.Core.AssemblyInfo.cs(20,12): error CS1726: Friend assembly reference
'Contoso.Core.Tests' is invalid. Strong-name signed assemblies must specify a public key in their
InternalsVisibleTo declarations.
```

The SDK turned the `InternalsVisibleTo` item into `[assembly: InternalsVisibleTo("Contoso.Core.Tests")]` in the generated `AssemblyInfo.cs`, and the compiler refuses it. The reason is identity: a strong-named assembly's name is the tuple of simple name, version, culture and public key. A grant to a simple name alone would let anyone compile an unsigned `Contoso.Core.Tests.dll` and read your internals, which defeats the point of signing. So the grant has to name the key.

Trying the token, which is what most people have handy because it shows up in every assembly-qualified name, produces the same error:

```xml
<InternalsVisibleTo Include="Contoso.Core.Tests, PublicKeyToken=90d333c425def132" />
```

```text
error CS1726: Friend assembly reference 'Contoso.Core.Tests, PublicKeyToken=90d333c425def132' is invalid.
Strong-name signed assemblies must specify a public key in their InternalsVisibleTo declarations.
```

The token is an 8-byte SHA-1 fragment of the key. It identifies the key but cannot verify it, so the compiler only accepts the full key. Version, culture and processor architecture are rejected too: the attribute takes the simple name plus, optionally, `PublicKey=`.

The second error shows up when you do pass a key, but it is the wrong one. This is the build output when the library grants access with its own key (a common copy-paste mistake) or with the key of an old `.snk`:

```text
Contoso.Core.Tests/Program.cs(1,32): error CS0281: Friend access was granted by 'Contoso.Core,
Version=1.0.0.0, Culture=neutral, PublicKeyToken=d2571df32581560a', but the public key of the output
assembly ('0024000004800000940000000602000000240000525341310004000001000100d938...') does not
match that specified by the InternalsVisibleTo attribute in the granting assembly.
```

CS0281 is reported in the **friend** project, and it is the more useful of the two because it prints the key the friend actually has. If the friend is signed, you can copy that hex string straight out of the error message into the grant. If the parentheses are empty (`('')`), the friend is not signed at all: either sign it, or remove the key from the grant.

## Step 1: get the friend's full public key

You need the public key of the assembly that is **receiving** access (the test project, the benchmark project, the mocking library's proxy assembly), not the key of the library that grants it.

### On Windows, with sn.exe

The Strong Name tool ships with the Windows SDK and is on the path in a Developer Command Prompt. It cannot print the key straight from a key-pair `.snk`, so it is a two-step dance:

```bash
# Windows, Developer Command Prompt for VS 2026
sn -p Contoso.Core.Tests.snk Contoso.Core.Tests.pub
sn -tp Contoso.Core.Tests.pub
```

`sn -p` extracts the public half into a new file. `sn -tp` prints the public key and its token. The key is printed wrapped over several lines; join them into one string before you use it. If you only have the compiled DLL, `sn -Tp Contoso.Core.Tests.dll` (capital `T`) reads the key out of the assembly instead.

### On any OS, with a .NET script

`sn.exe` does not exist on macOS or Linux and is not part of the .NET SDK. The format is simple enough to compute yourself. Save this as `snkpub.cs` and run it with `dotnet run snkpub.cs -- <file>` (file-based apps need the .NET 10 SDK):

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

A `.snk` file is a Windows CryptoAPI `PRIVATEKEYBLOB`. The strong-name public key that goes into metadata is a 12-byte header (signature algorithm, hash algorithm, blob length) followed by the CryptoAPI `PUBLICKEYBLOB`. The one non-obvious line is the `aiKeyAlg` patch: the compiler always writes `CALG_RSA_SIGN` (`0x2400`) into the blob header, while a key generated by `RSACryptoServiceProvider` or by some tools carries `CALG_RSA_KEYX` (`0xA400`). Without the patch, the script prints a key that differs from the real one in a single byte, and you get CS0281 with two keys that look identical at a glance. I hit exactly that while testing this post.

To check the script against a key everyone knows, run it on Castle DynamicProxy's [`DynProxy.snk`](https://github.com/castleproject/Core/blob/master/src/Castle.Core/DynamicProxy/DynProxy.snk). It prints the same `0024...5cc7` key that Moq documents for `DynamicProxyGenAssembly2` (token `a621a9e7e5c32e69`). Passing the signed DLL instead of the `.snk` is the safest check of all, because then you are reading the key the compiler will actually compare against.

## Step 2: put the key in the project file

The .NET SDK's `Microsoft.NET.GenerateAssemblyInfo.targets` reads a `Key` metadata on every `InternalsVisibleTo` item. Paste the key there:

```xml
<!-- Contoso.Core.csproj, .NET 10 SDK -->
<ItemGroup>
  <InternalsVisibleTo Include="Contoso.Core.Tests"
                      Key="0024000004800000940000000602000000240000525341310004000001000100d938683d143669037eaa216c149c0baf08cfb48998c27cb406ec4e2309ddfe74001f10da9326b9d3b9c259f641ebd3bad32e0ec01921bafab048495084d59b765ef2e991bbb44e638472162f1075d8a0c83e9a69233a95b8b777c28f9ae125d037aec966cab5cb55c7f601888de0acbcdd6785ba17cf31cabbffca0fbe3595b6" />
</ItemGroup>
```

The generated `obj/Debug/net10.0/Contoso.Core.AssemblyInfo.cs` now contains:

```csharp
[assembly: System.Runtime.CompilerServices.InternalsVisibleTo(@"Contoso.Core.Tests, PublicKey=0024000004800000940000000602...")]
```

Build, and the test project can call `PriceCalculator.ApplyDiscount` again. A `PublicKey` metadata works as an alias for `Key`; the targets copy it across before generating the attribute, so `<InternalsVisibleTo Include="Contoso.Core.Tests" PublicKey="0024..." />` builds identically. Use `Key`, since that is the name the SDK documents.

If you prefer the attribute in source, that still works and still beats a giant single line, because C# folds constant string concatenation at compile time:

```csharp
// Contoso.Core/FriendAssemblies.cs, .NET 10, C# 14
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("Contoso.Core.Tests, PublicKey=" +
    "0024000004800000940000000602000000240000525341310004000001000100d938683d143669037eaa" +
    "216c149c0baf08cfb48998c27cb406ec4e2309ddfe74001f10da9326b9d3b9c259f641ebd3bad32e0ec0" +
    "1921bafab048495084d59b765ef2e991bbb44e638472162f1075d8a0c83e9a69233a95b8b777c28f9ae1" +
    "25d037aec966cab5cb55c7f601888de0acbcdd6785ba17cf31cabbffca0fbe3595b6")]
```

Do not mix both styles for the same friend; you end up with two attributes and only one of them gets updated when the key rotates.

## One key for many friends: the PublicKey property

Most solutions sign every project with the same `.snk`. Then every grant needs the same key, and repeating 320 hex characters per item is noise. The same targets file has a fallback: when an `InternalsVisibleTo` item has no `Key`, it uses the MSBuild **property** `$(PublicKey)`. The dotnet/arcade SDK that dotnet/runtime builds with sets `$(PublicKey)` this way, which is how those repos grant internals to their test assemblies.

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

Two things I verified about this. First, the SDK does **not** fill `$(PublicKey)` for you from `AssemblyOriginatorKeyFile`: with signing on and no property, the bare item still fails with CS1726. Second, setting the property does not change how the library itself is signed; the signed DLL still had its own token from its `.snk`. The property only feeds the attribute generator. An item with an explicit `Key` still wins over the property, which is what you want for third-party friends like the one in the next section.

## Granting access to Moq, NSubstitute and other Castle proxies

Mocking an `internal` interface in a strong-named library needs a second grant, because the mock type is emitted at runtime into a dynamic assembly called `DynamicProxyGenAssembly2`, not into your test assembly. Castle DynamicProxy signs that dynamic assembly with a fixed key, so the grant always looks the same, for Moq, NSubstitute and FakeItEasy alike:

```xml
<!-- .NET 10 SDK; key from Castle.Core's DynProxy.snk, documented by Moq -->
<ItemGroup>
  <InternalsVisibleTo Include="DynamicProxyGenAssembly2"
                      Key="0024000004800000940000000602000000240000525341310004000001000100c547cac37abd99c8db225ef2f6c8a3602f3b3606cc9891605d02baa56104f4cfc0734aa39b93bf7852f7d9266654753cc297e7d2edfe0bac1cdcf9f717241550e0a7b191195b7667bb4f64bcb8e2121380fd1d9d46ad2d92d2d15605093924cceaf74c4861eff62abf69b9291ed0a340e113be11e6a7d3113e92484cf7045cc7" />
</ItemGroup>
```

Without it, the failure is a runtime exception from Castle telling you the type is not accessible to `DynamicProxyGenAssembly2`, and the message itself includes the attribute to add. If your library is not signed, the bare `<InternalsVisibleTo Include="DynamicProxyGenAssembly2" />` is enough.

## Gotchas

**Line breaks and spaces break the grant without an error.** It is tempting to wrap a 320-character `Key` attribute across lines in the `.csproj`. MSBuild keeps the whitespace, the compiler cannot parse the result, and you get only a warning on the library:

```text
warning CS1700: Assembly reference 'Contoso.Core.Tests, PublicKey=00240000048000009400...' is invalid and cannot be resolved
```

followed by `error CS0122: 'PriceCalculator' is inaccessible due to its protection level` in the test project. If you treat warnings as errors you see it immediately; otherwise CS0122 looks like the grant is missing entirely. Keep the key on one line, or use the C# concatenation shown above.

**The friend must actually be signed.** A grant with a key only matches a friend signed with that key. In my run, turning `SignAssembly` off in the test project produced CS0281 with an empty key, `('')`. The reverse direction is lenient: an unsigned library can grant access to a signed friend by simple name, and the compiler accepts it.

**Public signing and delay signing count as signed.** Open-source repos often commit only the public half of their key and set `<PublicSign>true</PublicSign>`, so contributors can build on Linux and macOS without the private key. That works for friend checks too: a test project public-signed with just the `.pub` file built and ran against a grant using its key. The compiler compares keys, it does not verify signatures. Running a delay-signed or public-signed assembly under .NET Framework is a separate problem, but .NET Core and later ignore strong-name signatures at load time.

**Rotating the key means updating every grant.** Generating a new `.snk` (for example because the old one was 1024-bit, or leaked) changes the public key and the token, so every `InternalsVisibleTo` that names the friend has to change with it. The `$(PublicKey)` property in `Directory.Build.props` makes that a one-line change. Search for the old token in the repo as well: assembly-qualified type names in config files and binding redirects carry it.

**Strong naming buys you less than it used to.** On .NET Core and .NET 5+, the runtime does not validate strong-name signatures and binding ignores the key for unification purposes. Microsoft's current guidance is that most libraries do not need to be strong-named unless they are consumed by .NET Framework code that requires it. If you control the whole solution and only target modern .NET, turning signing off removes this entire class of problem. If you ship to .NET Framework consumers, keep signing and use the patterns above.

**A grant is broader than you may need.** A grant opens every internal type to the friend, not just the one you needed. For integration tests against minimal hosting, a `public partial class Program` is usually the narrower choice.

### Read next

- [How to write integration tests with WebApplicationFactory in ASP.NET Core 11](/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) covers the `public partial class Program` alternative to granting a test assembly all your internals.
- [How to fix "Could not load file or assembly" in a published .NET app](/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) explains the binding side of assembly identity, where the public key token also shows up.
- [How to migrate a .NET solution to Central Package Management with Directory.Packages.props](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) uses the same root-level MSBuild file pattern as the shared `$(PublicKey)` property.
- [xUnit v3 vs NUnit vs MSTest in 2026](/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/) helps pick the framework for the test project you are granting access to.
- [How to mock a DbContext without breaking change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) is a reminder that not every internal needs a Castle proxy to be testable.

### Sources

- [`InternalsVisibleToAttribute` supplemental remarks](https://learn.microsoft.com/en-us/dotnet/fundamentals/runtime-libraries/system-runtime-compilerservices-internalsvisibletoattribute), .NET documentation
- [Friend assemblies](https://learn.microsoft.com/en-us/dotnet/standard/assembly/friend), .NET documentation
- [MSBuild reference for .NET SDK projects: `InternalsVisibleTo`](https://learn.microsoft.com/en-us/dotnet/core/project-sdk/msbuild-props#internalsvisibleto), .NET documentation
- [Sn.exe (Strong Name tool)](https://learn.microsoft.com/en-us/dotnet/framework/tools/sn-exe-strong-name-tool), .NET Framework documentation
- [Strong-named assemblies](https://learn.microsoft.com/en-us/dotnet/standard/assembly/strong-named) and [Strong naming guidance for libraries](https://learn.microsoft.com/en-us/dotnet/standard/library-guidance/strong-naming), .NET documentation
- [`Microsoft.NET.GenerateAssemblyInfo.targets`](https://github.com/dotnet/sdk/blob/main/src/Tasks/Microsoft.NET.Build.Tasks/targets/Microsoft.NET.GenerateAssemblyInfo.targets), dotnet/sdk (the `Key`, `PublicKey` metadata and `$(PublicKey)` fallback)
- [`DynProxy.snk`](https://github.com/castleproject/Core/blob/master/src/Castle.Core/DynamicProxy/DynProxy.snk), castleproject/Core
