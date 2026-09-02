---
title: "Migrate off BinaryFormatter after its removal in modern .NET"
description: "BinaryFormatter's implementation was deleted in .NET 9 and still throws PlatformNotSupportedException on .NET 10 and .NET 11: how to choose a replacement serializer, read already-persisted NRBF blobs with NrbfDecoder, and what breaks in WinForms, WPF, and ResX."
pubDate: 2026-09-02
updatedDate: 2026-09-02
template: migration
tags:
  - "migration"
  - "binaryformatter"
  - "serialization"
  - "system-text-json"
  - "dotnet-10"
  - "dotnet-11"
  - "security"
  - "dotnet"
---

A service that serialises its own types into its own storage takes one to three days to move off `BinaryFormatter`. A codebase where NRBF payloads crossed a boundary you do not control (a queue, a shared database column, a desktop client that ships on its own schedule) takes weeks, because the hard part is not the serializer swap, it is draining the old payloads. The in-box implementation was deleted in .NET 9 Preview 6 and has stayed deleted: on .NET 9, .NET 10, and .NET 11 preview, `BinaryFormatter.Serialize` and `BinaryFormatter.Deserialize` throw [`PlatformNotSupportedException`](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/9.0/binaryformatter-removal) for every project type, and the old `EnableUnsafeBinaryFormatterSerialization` MSBuild property on its own no longer brings it back. This guide is written against .NET 10.0.11 (GA) with notes for the .NET 11 SDK (preview 7, August 2026), `System.Formats.Nrbf` 10.0.11, and `System.Runtime.Serialization.Formatters` 10.0.11.

## Why this is not optional

- **There is no flag left.** In .NET 8 the disable switch flipped on by default and `<EnableUnsafeBinaryFormatterSerialization>true</EnableUnsafeBinaryFormatterSerialization>` still worked. From .NET 9 the property alone is inert; the implementing code is not in the shared framework at all.
- **The compatibility package is explicitly unsupported.** `System.Runtime.Serialization.Formatters` ships a working implementation, vulnerabilities included. It is a stop-gap for a deadline, not a destination.
- **The risk is the format, not the bugs.** NRBF encodes which types to instantiate inside the payload, which is [CWE-502, "Deserialization of Untrusted Data"](https://cwe.mitre.org/data/definitions/502.html). No amount of patching fixes a format whose job is to let the payload choose the constructor.
- **You can read the old blobs without deserializing them.** `NrbfDecoder`, shipped in .NET 9 alongside the removal, decodes NRBF into records without loading a single custom type. This is what makes a phased migration possible instead of a big-bang cutover.

## What breaks

| Area | Change | Severity |
| --- | --- | --- |
| `BinaryFormatter.Serialize` / `Deserialize` | Throws `PlatformNotSupportedException` on every call, all project types | high |
| `EnableUnsafeBinaryFormatterSerialization` | No longer sufficient on its own; needs the compatibility package too | high |
| Persisted NRBF blobs | Nothing in the framework will deserialize them any more | high |
| `SoapFormatter`, `NetDataContractSerializer` | Gone or classed as [dangerous serializers](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-security-guide); not a migration target | high |
| WinForms/WPF clipboard, drag-and-drop | Only an intrinsic type list round-trips. `DataFormats.Serializable` and custom formats fail for anything else | high |
| WinForms Designer / ResX | Design-time serialization of custom types needs a `TypeConverter` instead | medium |
| `Exception(SerializationInfo, StreamingContext)` | Obsolete as `SYSLIB0051`; legacy exception serialization is dead weight | medium |
| MSBuild `MSB3825` | Warning about binary-formatted resources; suppress with `GenerateResourceWarnOnBinaryFormatterUse` | low |
| `SettingsPropertyValue.PropertyValue` | Typed as `object`, so `System.Configuration` user settings holding custom types cannot be migrated without an API break | high |

## Pre-flight checklist

- .NET SDK 10.0.100 or later installed (`dotnet --list-sdks`).
- An inventory: `grep -rn "BinaryFormatter\|IFormatter\|SoapFormatter\|NetDataContractSerializer" --include=*.cs .` plus a scan of your NuGet dependencies, because transitive callers are the ones that surprise you.
- Round-trip tests around every serialization boundary **before** you touch anything. Serialization bugs are silent; they show up as a null field three releases later.
- A sample of real persisted payloads pulled out of production storage. Synthetic payloads will not exercise version drift.
- A decision, written down, on whether you control both producer and consumer of each payload. If you do not, you need the dual-read path in step 4, not a straight swap.

## Migration steps

1. **Inventory every payload boundary, not every call site.** Group the `BinaryFormatter` usages by where the bytes go: in-memory only (a deep-clone helper), process-local cache, durable storage (database column, blob, file on disk), and cross-process (clipboard, queue, remoting-style RPC). In-memory and process-local uses can be swapped in a single commit. Durable and cross-process uses need a format transition window. Record the closed set of types that reach each boundary.

   Verification: every hit from the `grep` above is assigned to exactly one of the four buckets, and each durable boundary has a named owner and a named list of serialized types.

2. **Choose the replacement serializer per boundary.** There is no drop-in replacement, and you do not have to pick the same one everywhere. The [official comparison](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/choose-a-serializer) breaks down as: `System.Text.Json` when the payload can be text and you can annotate types (the only option in the list with both first-class AOT support and source generation); `DataContractSerializer` when you cannot change the types at all, because it is the only recommended serializer that honours `[Serializable]` and `ISerializable`; [MessagePack for C#](https://github.com/MessagePack-CSharp/MessagePack-CSharp) or [protobuf-net](https://github.com/protobuf-net/protobuf-net) when the payload must stay compact binary.

   Verification: each boundary from step 1 has one serializer written next to it, with a one-line reason. If the reason is "it was the default", go back.

3. **Swap the in-memory and process-local uses first.** These are free wins and they shrink the surface for the harder steps. A `[Serializable]` type moving to `System.Text.Json` needs explicit opt-in for anything that was previously implicit: fields are not serialized unless you ask, private members need a custom contract, and `[Serializable]` itself means nothing.

   ```csharp
   // .NET 10.0.11, C# 14
   using System.Text.Json;
   using System.Text.Json.Serialization;

   [JsonSourceGenerationOptions(IncludeFields = true)]
   [JsonSerializable(typeof(CartSnapshot))]
   internal partial class CartContext : JsonSerializerContext;

   public sealed class CartSnapshot
   {
       public int Version;                 // a field, so IncludeFields is required
       public string? CouponCode { get; set; }
       public List<int> LineItemIds { get; set; } = [];
   }

   byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(snapshot, CartContext.Default.CartSnapshot);
   CartSnapshot? back = JsonSerializer.Deserialize(bytes, CartContext.Default.CartSnapshot);
   ```

   Verification: `dotnet test` is green, and a round-trip assertion compares every public **and** private member, not just the ones you remembered.

4. **Add a dual-read path at every durable boundary.** This is the step that lets you ship. `NrbfDecoder.StartsWithPayloadHeader` tells you whether the bytes you just read are legacy NRBF, and if so you decode them, re-serialize with the new serializer, and write them back. Reads migrate the corpus lazily; writes are new-format only from day one.

   ```csharp
   // .NET 10.0.11, System.Formats.Nrbf 10.0.11
   using System.Formats.Nrbf;

   internal static CartSnapshot Load(string path)
   {
       byte[] raw = File.ReadAllBytes(path);

       if (!NrbfDecoder.StartsWithPayloadHeader(raw))
       {
           return JsonSerializer.Deserialize(raw, CartContext.Default.CartSnapshot)!;
       }

       CartSnapshot upgraded = ReadLegacy(raw);
       File.WriteAllBytes(path, JsonSerializer.SerializeToUtf8Bytes(upgraded, CartContext.Default.CartSnapshot));
       return upgraded;
   }
   ```

   Verification: a test that writes a real production NRBF sample to a temp file, calls `Load`, asserts the values, and then asserts that a second `Load` no longer takes the legacy branch.

5. **Implement `ReadLegacy` with `NrbfDecoder`, one type at a time.** `NrbfDecoder` decodes; it never instantiates your types, never loads an assembly, and never recurses. You do the construction, which is exactly why it is safe on untrusted input. `ClassRecord` exposes members by name with typed accessors, and `TypeNameMatches` compares type names while ignoring assembly identity, so type forwarding and assembly version bumps do not break you.

   ```csharp
   // .NET 10.0.11, System.Formats.Nrbf 10.0.11
   using System.Formats.Nrbf;

   private static CartSnapshot ReadLegacy(byte[] raw)
   {
       using MemoryStream stream = new(raw);
       ClassRecord root = NrbfDecoder.DecodeClassRecord(stream);

       if (!root.TypeNameMatches(typeof(CartSnapshot)))
       {
           throw new InvalidDataException($"Unexpected payload type '{root.TypeName.AssemblyQualifiedName}'.");
       }

       SZArrayRecord<int> ids = (SZArrayRecord<int>)root.GetArrayRecord(nameof(CartSnapshot.LineItemIds))!;
       if (ids.Length > 10_000)
       {
           throw new InvalidDataException("Line item array exceeds the sane limit.");
       }

       return new CartSnapshot
       {
           Version = root.HasMember(nameof(CartSnapshot.Version)) ? root.GetInt32(nameof(CartSnapshot.Version)) : 1,
           CouponCode = root.GetString(nameof(CartSnapshot.CouponCode)),
           LineItemIds = [.. ids.GetArray()],
       };
   }
   ```

   `HasMember` is the versioning escape hatch: a field that was added or renamed between the payload being written and today is a `false`, not an exception. The length check before `GetArray` is not optional, because NRBF makes it cheap for a hostile payload to promise two billion nulls.

   Verification: a decode test per legacy type against a stored real payload, plus one test asserting that an oversized or wrong-typed payload throws `InvalidDataException` rather than allocating.

6. **If you truly cannot change the types, use `DataContractSerializer` instead of steps 3 to 5.** It is the only recommended option that honours the `[Serializable]` and `ISerializable` programming model, so types stay untouched. The catch is that known types must be supplied up front, including private ones, and a few common types (notably `DateTimeOffset`) are not on the default allow-list. `PreserveObjectReferences` restores the object-identity and cycle behaviour that `BinaryFormatter` gave you for free.

   ```csharp
   // .NET 10.0.11
   using System.Runtime.Serialization;

   DataContractSerializer serializer = new(
       typeof(CartSnapshot),
       new DataContractSerializerSettings
       {
           KnownTypes = [typeof(PercentageCoupon), typeof(FixedAmountCoupon), typeof(DateTimeOffset)],
           PreserveObjectReferences = true,
       });
   ```

   Do not reach for `NetDataContractSerializer` because the name looks closer. It embeds type information in the payload the same way `BinaryFormatter` does and is listed as a dangerous serializer.

   Verification: a round-trip test over the full known-type closure, including a graph with a deliberate cycle, passing with `PreserveObjectReferences = true`.

7. **Handle WinForms and WPF separately.** Since .NET 9 both frameworks use an internal NRBF subset for clipboard, drag-and-drop, and design-time resources, but only for an intrinsic list: the primitives, `string`, `decimal`, `TimeSpan`, `DateTime`, `nint`, `nuint`, `PointF`, `RectangleF`, plus `Bitmap` and `ImageListStreamer` on WinForms, and arrays and lists of those. Anything else falls back to `BinaryFormatter` and fails. The prescribed fix for clipboard and drag-and-drop is to put a `string` or `byte[]` on the clipboard yourself, typically JSON, and parse it on the receiving side. For Designer/ResX serialization of a custom type, register a `TypeConverter` so the Designer uses it instead of falling through to `BinaryFormatter`.

   Verification: a manual copy-paste and a drag-and-drop between two running instances of the app for every custom format, plus a Designer round-trip (open a form, save, reopen) with no `MSB3825` and no runtime exception.

8. **Only then decide about the compatibility package.** If a third-party dependency calls `BinaryFormatter` internally and you cannot wait for its fix, install `System.Runtime.Serialization.Formatters` in the **application** project only. The package does not change `BinaryFormatter`'s type identity, so libraries in the graph pick up the working implementation without being rebuilt.

   ```xml
   <!-- .NET 10.0.11. Unsupported, and a temporary measure. -->
   <PropertyGroup>
     <TargetFramework>net10.0</TargetFramework>
     <EnableUnsafeBinaryFormatterSerialization>true</EnableUnsafeBinaryFormatterSerialization>
   </PropertyGroup>

   <ItemGroup>
     <PackageReference Include="System.Runtime.Serialization.Formatters" Version="10.0.11" />
   </ItemGroup>
   ```

   For ResX specifically there is a second gate: set the `System.Resources.Extensions.UseBinaryFormatter` AppContext switch to `true` as well.

   Verification: the package reference exists in exactly one project file, and there is a dated tracking issue naming the dependency that forced it.

## Verification

- `grep -rn "BinaryFormatter" --include=*.cs src/` returns nothing outside the legacy decode path and its tests.
- `dotnet build -warnaserror` is clean, with no `SYSLIB0011` and no `MSB3825`.
- `dotnet test -c Release` is green and includes at least one decode test per legacy type against a real production payload sample.
- A staging run reads the production corpus: log the count of payloads that took the legacy branch and confirm it trends to zero over the transition window.
- Logs show no first-chance `PlatformNotSupportedException`.
- If the app is WinForms or WPF, clipboard and drag-and-drop have been exercised across two processes, not just inside one.

## Rollback plan

The code change is reversible; the data change is not. Once step 4 rewrites a blob in the new format, the old bytes are gone, so a rollback to a build that only understands NRBF cannot read them. Two consequences worth planning around: keep the previous-format bytes for the length of your rollback window (write the upgraded payload to a new column or key rather than overwriting in place, and drop the old one only after the window closes), and keep the legacy `NrbfDecoder` read path in the codebase for at least one release after the migration counter hits zero. If you deploy with the compatibility package as a bridge, the rollback is trivial but the security exposure is real for the whole time it is deployed, so date the tracking issue.

## Gotchas worth knowing before you start

**`[Serializable]` means nothing to `System.Text.Json`.** Types that round-tripped through `BinaryFormatter` with private fields and no public constructor will silently produce `{}` under JSON. The failure is not an exception, it is empty output, which is why the round-trip test in step 3 has to compare private state.

**Object identity disappears.** `BinaryFormatter` preserved references and handled cycles. `System.Text.Json` needs `ReferenceHandler.Preserve`, `DataContractSerializer` needs `PreserveObjectReferences = true`, and if you skip both, a shared child object silently becomes two objects after a round-trip. Where the old code relied on reference equality after deserialization, that assumption is now wrong.

**`NrbfDecoder` is a decoder, not a `BinaryFormatter` emulator.** Its behaviour deliberately does not match `BinaryFormatter`'s, so you cannot use a successful decode as evidence that a `BinaryFormatter` call would have been safe. It also does not support non-zero-indexed arrays, which .NET Framework could write into NRBF payloads but .NET never read.

**Some libraries cannot be migrated at all.** `SettingsPropertyValue.PropertyValue` is typed as `object`, so a `System.Configuration` settings file could hold literally anything. There is no closed set of types to decode against, which means no `NrbfDecoder` path exists without an API break. Types like this are why the inventory in step 1 comes first.

**Exception serialization is a separate obsoletion.** `SYSLIB0051` covers the `Exception(SerializationInfo, StreamingContext)` constructor and the rest of legacy serialization support. Custom exceptions across your codebase probably still carry that constructor; deleting it is safe once nothing round-trips exceptions through a formatter, and it is a good grep to run in the same pass.

**Cross-version conversion has to run somewhere that still has an implementation.** If you are also leaving .NET Framework behind, write the one-shot blob conversion tool while you still have a runtime with a working `BinaryFormatter`, or use `System.Formats.Nrbf`, which multi-targets .NET Standard 2.0 and .NET Framework precisely so the decode side can run anywhere.

## Related

- The BinaryFormatter step sits inside the larger jump in [the .NET 8 to .NET 11 upgrade checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), and it is usually the most expensive line item in [moving a .NET Framework 4.8 codebase to .NET 11](/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/).
- If JSON is your replacement, the `[Serializable]` type hierarchies that BinaryFormatter handled implicitly need [explicit `JsonDerivedType` annotations](/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/), and awkward shapes usually end up in [a custom `JsonConverter`](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).
- Teams doing this at the same time as a Newtonsoft cleanup should read [the large-codebase Newtonsoft to System.Text.Json migration](/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/) first, because the two passes touch the same files.
- Trimmed and AOT builds hit an adjacent wall: see [reflection-based serialization has been disabled for this application](/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/) and the wider [PlatformNotSupportedException in Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/) triage.

## Sources

- [BinaryFormatter migration guide](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/), Microsoft Learn
- [Breaking change: In-box BinaryFormatter implementation removed and always throws](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/9.0/binaryformatter-removal), Microsoft Learn
- [Read BinaryFormatter (NRBF) payloads](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/read-nrbf-payloads), Microsoft Learn
- [Choose a serializer](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/choose-a-serializer), Microsoft Learn
- [WinForms and WPF OLE guidance](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/winforms-wpf-ole-guidance), Microsoft Learn
- [BinaryFormatter removal from .NET 9 is complete](https://github.com/dotnet/announcements/issues/317), dotnet/announcements
- [BinaryFormatter obsoletion plan](https://github.com/dotnet/designs/blob/main/accepted/2020/better-obsoletion/binaryformatter-obsoletion.md), dotnet/designs
- [MS-NRBF: .NET Remoting Binary Format specification](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-nrbf/)
