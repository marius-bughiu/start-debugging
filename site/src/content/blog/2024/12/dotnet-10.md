---
title: "What’s new in .NET 10"
description: "What's new in .NET 10: LTS release with 3 years of support, new JIT optimizations, array devirtualization, stack allocation improvements, and more."
pubDate: 2024-12-01
updatedDate: 2026-01-04
tags:
  - "dotnet"
  - "dotnet-10"
---
.NET 10 will be released in November 2025. .NET 10 is a Long Term Support (LTS) version, which will receive free support and patches for 3 years from the release date, up until November 2028.

.NET 10 will be released together with C# 14. See [what’s new in C# 14](/2024/12/csharp-14/).

There are several new features and improvements in the .NET 10 runtime:

-   [Array interface method devirtualization & array enumeration de-abstraction](/2025/04/net-10-array-ennumeration-performance-improvements-jit-array-de-abstraction/)
-   Inlining of late devirtualized methods
-   Devirtualization based on inlining observations
-   [Stack allocation of arrays of value types](/2025/04/net-10-stack-allocation-of-arrays-of-value-types/)
-   Improved code layout to avoid jump instructions and to improve likelihood of sharing an instruction cache line
-   [SearchValues added support for strings](/2026/01/net-10-performance-searchvalues/)

## End of support

.NET 10 is a Long Term Support (LTS) version, and will go out of support in November 2028.
