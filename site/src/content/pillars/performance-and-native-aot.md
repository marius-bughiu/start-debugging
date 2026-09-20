---
title: "The performance and Native AOT cheat sheet"
description: "Making .NET code faster and smaller in one place: profiling, allocation and Span, caching, the JIT and GC work in .NET 11, and what Native AOT costs you."
tagline: "Measure first, then pick the knob."
pubDate: 2026-09-20
updatedDate: 2026-09-20
indexTags:
  - "performance"
  - "native-aot"
---

This pillar collects everything on the site about **making code faster and smaller** - profiling before you guess, allocation and `Span<T>` work, caching, the JIT and compression changes in the .NET 11 cycle, and the constraints Native AOT puts on your code.

## What to read first

Measure first: [profiling with dotnet-trace](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) and [diagnosing a managed memory leak with gcdump and dump](/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/) are the two loops worth learning. Before you tune anything, [tiered compilation](/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/) and [PGO](/2026/07/what-is-pgo-in-dotnet-and-do-i-need-to-opt-in/) explain what the runtime already does for free - the newest example is [the JIT devirtualizing generic virtual methods](/2026/09/dotnet-11-jit-devirtualizes-generic-virtual-methods/).

For allocation, [what `Span<T>` actually speeds up](/2026/06/what-is-span-and-when-does-it-make-my-code-faster/) leads and [List vs Span vs ReadOnlySpan](/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) picks the type. Shipping smaller? [Native AOT vs ReadyToRun vs JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) settles the fork, [what Native AOT costs you](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) is the honest ledger, and [trim-safe code](/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) is the discipline; the failure you'll hit first is [reflection-based serialization disabled](/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/). On the server, [HybridCache vs IMemoryCache vs IDistributedCache](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) and [detecting N+1 queries](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) remove more time than any micro-optimisation.

## What's on this page

The list below auto-collects posts tagged with any of: `performance`, `native-aot` - which pulls in the Flutter and Dart performance posts too. Newest first.

Companion pillars: [async and concurrency](/pillars/async-and-concurrency-in-csharp/) and [the .NET 11 tracker](/pillars/dotnet-11-tracker/).
