---
title: "Why does string.GetHashCode() return a different value every run in .NET?"
description: "Since .NET Core, string.GetHashCode() is seeded with a random per-process value (Marvin hashing), so the same string hashes differently in every process. Why the runtime does it, which types are affected (HashCode.Combine, ValueTuple, records with string members), how Dictionary<string, T> quietly avoids the cost, and how to get a stable hash with XxHash3 or FNV-1a, verified on .NET 10.0.10."
pubDate: 2026-11-06
tags:
  - "dotnet"
  - "csharp"
  - "dotnet-10"
  - "hashing"
---

`string.GetHashCode()` returns a different value in every process because, starting with .NET Core 1.0 and in every release since (including .NET 10 and .NET 11), the runtime computes string hashes with the Marvin algorithm seeded by 8 random bytes generated once at process startup. Within one process the value is consistent, so `Dictionary<string, T>` works, but the next run gets a new seed and therefore new hash codes. This is deliberate protection against hash-flooding attacks, there is no supported switch to turn it off, and the fix is to stop persisting or sharing `GetHashCode()` results and use a real, specified hash such as `XxHash3` from `System.IO.Hashing` when you need a value that survives a restart. Everything below was run on .NET 10.0.10 (SDK 10.0.302, macOS arm64), with runtime source quoted from the `release/10.0` branch.

## Three runs, three different answers

The smallest repro is a file-based app that prints a handful of hash codes. Save it as `probe.cs` and run it with `dotnet run probe.cs` (or build once with `dotnet build probe.cs -o out` and run `dotnet out/probe.dll` several times):

```csharp
// .NET 10 (runtime 10.0.10), C# 14
#:package System.IO.Hashing@10.0.14
#:property PublishAot=false
using System.IO.Hashing;
using System.Text;

Console.WriteLine($"\"hello\".GetHashCode()             = {"hello".GetHashCode()}");
Console.WriteLine($"\"hello\".GetHashCode() again       = {"hello".GetHashCode()}");
Console.WriteLine($"OrdinalIgnoreCase(\"HELLO\")        = {"HELLO".GetHashCode(StringComparison.OrdinalIgnoreCase)}");
Console.WriteLine($"InvariantCulture(\"hello\")         = {StringComparer.InvariantCulture.GetHashCode("hello")}");
Console.WriteLine($"42.GetHashCode()                  = {42.GetHashCode()}");
Console.WriteLine($"Guid.GetHashCode()                = {Guid.Parse("6f9619ff-8b86-d011-b42d-00cf4fc964ff").GetHashCode()}");
Console.WriteLine($"HashCode.Combine(1, 2)            = {HashCode.Combine(1, 2)}");
Console.WriteLine($"(1, 2).GetHashCode() [ValueTuple] = {(1, 2).GetHashCode()}");
Console.WriteLine($"Tuple.Create(1, 2).GetHashCode()  = {Tuple.Create(1, 2).GetHashCode()}");
Console.WriteLine($"new P(1, 2).GetHashCode()         = {new P(1, 2).GetHashCode()}");
Console.WriteLine($"new R(\"a\").GetHashCode()          = {new R("a").GetHashCode()}");
Console.WriteLine($"XxHash3(UTF-8 \"hello\")            = {XxHash3.HashToUInt64(Encoding.UTF8.GetBytes("hello")):x16}");

record P(int X, int Y);
record R(string S);
```

Three consecutive runs on .NET 10.0.10 printed this (the `new R("a")` line comes from a second probe with the same setup, run twice):

| Expression | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| `"hello".GetHashCode()` | -1074274209 | 640222222 | -1836549843 |
| same call again, same process | -1074274209 | 640222222 | -1836549843 |
| `GetHashCode(StringComparison.OrdinalIgnoreCase)` | -1310218671 | -776747791 | -1065442932 |
| `StringComparer.InvariantCulture.GetHashCode` | 70205785 | -686249423 | 1471932901 |
| `42.GetHashCode()` | 42 | 42 | 42 |
| `Guid.GetHashCode()` | -1880918398 | -1880918398 | -1880918398 |
| `HashCode.Combine(1, 2)` | 483027529 | 725763188 | 371432384 |
| `(1, 2).GetHashCode()` (ValueTuple) | 483027529 | 725763188 | 371432384 |
| `Tuple.Create(1, 2).GetHashCode()` | 35 | 35 | 35 |
| `new P(1, 2).GetHashCode()` (record of `int`) | 1641433880 | 1641433880 | 1641433880 |
| `new R("a").GetHashCode()` (record of `string`) | 1771118389 | -1103870537 | not run |
| `XxHash3` over UTF-8 bytes | 9555e8555c62dcfd | 9555e8555c62dcfd | 9555e8555c62dcfd |

Two things stand out. Inside one process every value is stable, which is all the `GetHashCode` contract has ever promised. Across processes, anything that touches a string hash or `System.HashCode` changes, while primitive hashes (`int`, `long`, enums, `Guid`) do not.

## Where the randomness comes from

The implementation of `string.GetHashCode()` in [`String.Comparison.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/String.Comparison.cs) is short:

```csharp
// dotnet/runtime, release/10.0, String.Comparison.cs
public override int GetHashCode()
{
    ulong seed = Marvin.DefaultSeed;
    return Marvin.ComputeHash32(ref Unsafe.As<char, byte>(ref _firstChar),
        (uint)_stringLength * 2 /* in bytes, not chars */, (uint)seed, (uint)(seed >> 32));
}
```

And `Marvin.DefaultSeed` in [`Marvin.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Marvin.cs) is a static property initialized from the operating system's random number generator:

```csharp
// dotnet/runtime, release/10.0, Marvin.cs
public static ulong DefaultSeed { get; } = GenerateSeed();

private static unsafe ulong GenerateSeed()
{
    ulong seed;
    Interop.GetRandomBytes((byte*)&seed, sizeof(ulong));
    return seed;
}
```

So the seed is fixed for the lifetime of the process and different for every process. `GetHashCode(StringComparison.OrdinalIgnoreCase)`, `string.GetHashCode(ReadOnlySpan<char>)` and the culture-aware comparers all go through the same seeded path, which is why every string row in the table moves.

`System.HashCode` does the same thing independently. [`HashCode.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/HashCode.cs) holds `private static readonly uint s_seed = GenerateGlobalSeed();`, also filled by `Interop.GetRandomBytes`, and mixes it into every `Combine` and `ToHashCode` call. `ValueTuple<T1, T2>.GetHashCode()` is built on `HashCode.Combine`, which is why `(1, 2)` and `HashCode.Combine(1, 2)` print the same random number. The older `System.Tuple` uses its own combiner and stays at 35.

### Why the runtime pays for this

A hash table is only fast while keys spread across buckets. If an attacker knows the hash function, they can generate thousands of distinct strings with the same hash, send them as form field names, JSON property names or query string keys, and turn every dictionary insert into a linear scan. That is the hash-flooding denial of service class of attack that hit many web stacks in 2011. A per-process random seed means the attacker cannot precompute collisions offline, because the collisions for your process depend on a secret they do not have.

.NET Framework 4.5 and later also have a randomized string hash, but it is off by default for compatibility: you had to opt in with the [`<UseRandomizedStringHashAlgorithm enabled="1" />`](https://learn.microsoft.com/en-us/dotnet/framework/configure-apps/file-schema/runtime/userandomizedstringhashalgorithm-element) element in `app.config`. .NET Core flipped the default and removed the choice. Code that "worked" on .NET Framework 4.x because the hash happened to be the same every run breaks the moment it is ported, and that is usually when people first search for this.

The [`String.GetHashCode` documentation](https://learn.microsoft.com/en-us/dotnet/api/system.string.gethashcode) has said for years that hash codes can differ across .NET implementations, versions and platforms, that "two subsequent runs of the same program may return different hash codes", and that they should never be persisted. Randomization just makes the warning impossible to ignore.

## What actually breaks

`GetHashCode` is designed for one job: placing objects into buckets of an in-memory hash table that lives in the same process. Every failure report boils down to using it for something else:

- **Persisting it.** Storing `name.GetHashCode()` in a database column, a file name, a cache key in Redis, or a checksum field. After a restart, lookups by the recomputed value find nothing.
- **Sharing it between processes.** Two instances of the same service behind a load balancer compute different hashes for the same tenant ID, so "hash the key and pick shard `hash % n`" sends the same tenant to different shards depending on which instance handled the request.
- **Deterministic bucketing.** Feature flag rollouts and A/B tests that do `Math.Abs(userId.GetHashCode()) % 100 < 10` put a user in a different cohort on every deploy, or on every pod.
- **Tests that assert hash values.** A snapshot or unit test that hard-codes `GetHashCode()` output passes once and then fails on the next run.
- **Sorting or shuffling by hash.** `OrderBy(x => x.Name.GetHashCode())` gives a different order each run, which is fine for a throwaway shuffle and wrong for anything that must be reproducible.

The randomness also leaks into your own types. A `record` with a `string` member, an anonymous type with a `string` property, or a hand-written `GetHashCode()` that calls `HashCode.Combine` all inherit the per-process seed, as the `new R("a")` row shows. A `record` containing only `int` members happened to be stable in this test, because the compiler-generated hash combines `EqualityComparer<T>.Default` results for `EqualityContract` and each field with a multiply-and-add instead of calling `HashCode`. Treat that as an implementation detail of the C# compiler, not a guarantee, for the same reason the docs give for strings. If you want a deeper look at what records generate for equality, the [record vs class vs struct decision matrix](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) walks through the synthesized members.

One thing randomization does **not** change is `Dictionary<TKey, TValue>` enumeration order. The enumerator walks the internal `_entries` array, which is filled in insertion order (with removed slots reused), so the hash seed decides which bucket a key lands in but not the order `foreach` returns entries. If your enumeration order changes between runs, look for a `HashSet`/`Dictionary` that is rebuilt from a source with an unstable order, not at the string hash.

## How `Dictionary<string, T>` avoids paying for Marvin

Marvin is slower than a simple multiplicative hash, and string-keyed dictionaries are everywhere, so the runtime cheats in a controlled way. When you create a `Dictionary<string, TValue>` or `HashSet<string>` with the default comparer, `StringComparer.Ordinal` or `StringComparer.OrdinalIgnoreCase`, [`NonRandomizedStringEqualityComparer.GetStringComparer`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Collections/Generic/NonRandomizedStringEqualityComparer.cs) swaps in an internal comparer that calls `string.GetNonRandomizedHashCode()`, an unseeded hash. Every insert counts how many entries it had to walk in the target bucket, and in [`Dictionary.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Collections/Generic/Dictionary.cs) a chain longer than `HashHelpers.HashCollisionThreshold` (100) triggers this:

```csharp
// dotnet/runtime, release/10.0, Dictionary.cs (TryInsert)
if (!typeof(TKey).IsValueType && collisionCount > HashHelpers.HashCollisionThreshold
    && comparer is NonRandomizedStringEqualityComparer)
{
    // If we hit the collision threshold we'll need to switch to the comparer which is using randomized string hashing
    // i.e. EqualityComparer<string>.Default.
    Resize(entries.Length, true);
}
```

`Resize(..., forceNewHashCodes: true)` replaces the comparer with the randomized Marvin one and rehashes every key. You can watch it happen with reflection. This probe picks keys that all land in bucket 0 under the unseeded hash and prints the internal comparer type whenever it changes:

```csharp
// .NET 10 (runtime 10.0.10), C# 14 -- reflects over internals, for illustration only
#:property PublishAot=false
using System.Reflection;

var nonRandom = typeof(string).GetMethod("GetNonRandomizedHashCode",
    BindingFlags.Instance | BindingFlags.NonPublic, Type.EmptyTypes)!;
int H(string s) => (int)nonRandom.Invoke(s, null)!;

var dict = new Dictionary<string, int>(capacity: 200);
var flags = BindingFlags.Instance | BindingFlags.NonPublic;
int size = ((Array)typeof(Dictionary<string, int>).GetField("_buckets", flags)!.GetValue(dict)!).Length;

var keys = new List<string>();
for (int i = 0; keys.Count < 105; i++)
{
    string k = "key" + i;
    if ((uint)H(k) % (uint)size == 0) keys.Add(k);
}

var comparerField = typeof(Dictionary<string, int>).GetField("_comparer", flags)!;
string Internal() => comparerField.GetValue(dict)!.GetType().FullName!;
for (int i = 0; i < keys.Count; i++)
{
    string before = Internal();
    dict.Add(keys[i], i);
    if (i == 0 || before != Internal())
        Console.WriteLine($"after {i + 1,3} keys: internal comparer = {Internal()}");
}
Console.WriteLine($"public Comparer property = {dict.Comparer.GetType().FullName}");
```

Output, identical on two runs:

```text
after   1 keys: internal comparer = System.Collections.Generic.NonRandomizedStringEqualityComparer+OrdinalComparer
after 102 keys: internal comparer = System.Collections.Generic.RandomizedStringEqualityComparer+OrdinalComparer
public Comparer property = System.Collections.Generic.StringEqualityComparer
```

The 102nd colliding key walked a chain of 101 entries, crossed the threshold, and the dictionary switched itself to Marvin. The public `Comparer` property keeps reporting the comparer you asked for, so none of this is visible in normal code. Two practical consequences follow. First, normal string dictionaries get a fast unseeded hash and only pay for Marvin under attack-like conditions. Second, `GetNonRandomizedHashCode` printed the same value (-1691972363 for `"hello"`) in both runs, but it is `internal`, undocumented, and free to change in any release, so it is not the stable hash you are looking for. If read speed on a string-keyed lookup table is what you are after, [`FrozenDictionary`](/2024/04/net-8-performance-dictionary-vs-frozendictionary/) is the supported tool, not a custom comparer.

It also explains why you should not "fix" randomization by passing a custom `IEqualityComparer<string>` with a deterministic hash to your dictionaries. You would gain nothing in speed over the built-in unseeded path and lose the automatic fallback that protects you when keys come from untrusted input.

## Getting a hash that is stable across runs

When a value has to survive a restart or be computed identically on another machine, pick an algorithm with a specification and choose the byte encoding yourself. `System.IO.Hashing` (an official Microsoft package, 10.0.14 at the time of writing, with builds for .NET 8 through 10, .NET Standard 2.0 and .NET Framework 4.6.2) ships [`XxHash3`](https://learn.microsoft.com/en-us/dotnet/api/system.io.hashing.xxhash3), `XxHash64`, `XxHash32`, `XxHash128` and the CRC family:

```csharp
// .NET 10, C# 14, System.IO.Hashing 10.0.14
using System.IO.Hashing;
using System.Runtime.InteropServices;
using System.Text;

static class StableHash
{
    // Portable: same result in any language that implements XXH3 over UTF-8.
    public static ulong Utf8(string value) =>
        XxHash3.HashToUInt64(Encoding.UTF8.GetBytes(value));

    // Allocation-free, .NET-only: hashes the UTF-16 code units directly.
    // Stable across runs and machines with the same byte order.
    public static ulong Utf16(ReadOnlySpan<char> value) =>
        XxHash3.HashToUInt64(MemoryMarshal.AsBytes(value));

    // Deterministic bucketing for rollouts: 0..99, same answer on every pod and every deploy.
    public static int Bucket(string userId) => (int)(Utf8(userId) % 100);
}
```

`XxHash3` of the UTF-8 bytes of `"hello"` printed `9555e8555c62dcfd` in all three runs above, and so did `XxHash32` (`fb0077f9`). The choice between the UTF-8 and UTF-16 versions matters: hashing UTF-8 matches what a Python, Go or Rust service computes from the same string, while `MemoryMarshal.AsBytes` skips the encoding step but hashes .NET's in-memory UTF-16 layout, which only other .NET code (on a little-endian machine) will reproduce. If you work with spans a lot, the [overview of what `Span<T>` buys you](/2026/06/what-is-span-and-when-does-it-make-my-code-faster/) covers the `MemoryMarshal` side.

If you cannot take a package dependency, 32-bit FNV-1a is a dozen lines and fully specified. It printed `4f9f2cab` for `"hello"` in every run:

```csharp
// .NET 10, C# 14 -- FNV-1a, 32-bit, over UTF-8
static uint Fnv1a32(string s)
{
    uint hash = 2166136261;
    foreach (byte b in Encoding.UTF8.GetBytes(s))
    {
        hash ^= b;
        hash *= 16777619;
    }
    return hash;
}
```

Pick based on what the hash is for:

- **Cache keys, shard selection, rollout buckets, dedup fingerprints**: `XxHash3` (64-bit) or `XxHash128` if collisions across millions of keys matter. Fast, non-cryptographic, stable by specification.
- **Integrity checks against corruption**: `Crc32` or `Crc64`, also in `System.IO.Hashing`.
- **Anything an adversary can influence where a collision has security impact** (content addressing, signatures, deduplication of uploaded files): `SHA256.HashData`. Non-cryptographic hashes are trivially collidable on purpose.

For distributed cache keys in particular, the simplest stable key is often the string itself, or a hash of it that you compute explicitly. The [HybridCache vs IMemoryCache vs IDistributedCache comparison](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) shows key handling for the L2 case, and none of it involves `GetHashCode()`.

## Gotchas worth knowing

- **There is no runtime switch.** No `runtimeconfig.json` property or environment variable turns string hash randomization off in .NET Core or .NET 5+. Answers that suggest `UseRandomizedStringHashAlgorithm` only apply to .NET Framework.
- **"Stable within the process" includes static caches.** A value computed at startup and kept in memory is fine. The same value written to disk, sent over the wire, or logged and compared later is not.
- **Primitive stability is not a promise either.** `42.GetHashCode()` returning 42 and `Guid.GetHashCode()` matching across runs are current implementation details. The [`Object.GetHashCode` supplemental docs](https://learn.microsoft.com/en-us/dotnet/fundamentals/runtime-libraries/system-object-gethashcode) tell you not to persist any hash code, so do not build on these either.
- **`HashCode` is randomized even for integers.** A custom `GetHashCode()` built from `HashCode.Combine(Id, Version)` changes per process, even though each `int` input is stable. That is correct for hash tables and wrong for persistence, so do not reuse `GetHashCode()` as your "stable ID" method; add a separate, explicitly named method.
- **Culture-aware hashes add a second axis.** `StringComparer.InvariantCulture` and `CurrentCulture` hashes are randomized and also depend on the ICU or NLS version, so they can differ even between two processes that happen to get the same seed.

The rule that falls out of all this is short: `GetHashCode()` is a bucket index for in-process hash tables and nothing else. The moment a hash leaves the process, choose an algorithm by name.

## Sources

- [`String.GetHashCode` API docs](https://learn.microsoft.com/en-us/dotnet/api/system.string.gethashcode), including the remarks on stability and persistence.
- [`Object.GetHashCode` supplemental API remarks](https://learn.microsoft.com/en-us/dotnet/fundamentals/runtime-libraries/system-object-gethashcode).
- [`System.HashCode` API docs](https://learn.microsoft.com/en-us/dotnet/api/system.hashcode).
- [`XxHash3` in System.IO.Hashing](https://learn.microsoft.com/en-us/dotnet/api/system.io.hashing.xxhash3).
- [`<UseRandomizedStringHashAlgorithm>` element](https://learn.microsoft.com/en-us/dotnet/framework/configure-apps/file-schema/runtime/userandomizedstringhashalgorithm-element) for .NET Framework.
- dotnet/runtime `release/10.0` source: [`String.Comparison.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/String.Comparison.cs), [`Marvin.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Marvin.cs), [`HashCode.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/HashCode.cs), [`NonRandomizedStringEqualityComparer.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Collections/Generic/NonRandomizedStringEqualityComparer.cs), [`Dictionary.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Collections/Generic/Dictionary.cs).
