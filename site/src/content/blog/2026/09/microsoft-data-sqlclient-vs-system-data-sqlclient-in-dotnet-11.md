---
title: "Microsoft.Data.SqlClient vs System.Data.SqlClient in .NET 11"
description: "Use Microsoft.Data.SqlClient. System.Data.SqlClient is deprecated, already emits CS0618 on every type you touch, and loses its .NET assets when .NET 8 goes end of support on November 10, 2026, the same day .NET 11 ships. The measured feature gap, the Encrypt default that breaks the migration, and the 7.0 package split."
pubDate: 2026-09-17
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "sql-server"
  - "migration"
---

Use **`Microsoft.Data.SqlClient`**. This is not a close comparison and it has not been one since 2022. `System.Data.SqlClient` is formally deprecated, its NuGet description is literally "DEPRECATED - Use Microsoft.Data.SqlClient.", every public type in it carries `[Obsolete]`, and per Microsoft's own staged plan its .NET assets disappear once .NET 8 reaches end of support on **November 10, 2026** -- which is also the day .NET 11 ships. The only decision left is which `Microsoft.Data.SqlClient` line to take (7.0 or the 6.1 LTS) and how to survive the migration, because the packages differ in more than a namespace.

Everything below was verified on macOS 26.6.2 (Apple M4) with the .NET SDK `10.0.302`, against `Microsoft.Data.SqlClient` 7.0.3 and `System.Data.SqlClient` 4.9.1, the current releases as I write this. The asset selection is identical on `net11.0`: neither package ships a `net10.0` or `net11.0` folder, so a .NET 11 project resolves `runtimes/unix/lib/net9.0/Microsoft.Data.SqlClient.dll` and `runtimes/unix/lib/net8.0/System.Data.SqlClient.dll`, exactly what a `net10.0` project resolves.

## The matrix

| | `Microsoft.Data.SqlClient` 7.0.3 | `System.Data.SqlClient` 4.9.1 |
| --- | --- | --- |
| Support status | STS, shipping (7.0 GA March 17, 2026) | Deprecated, maintenance only |
| Ships from | [dotnet/SqlClient](https://github.com/dotnet/SqlClient) | [dotnet/maintenance-packages](https://github.com/dotnet/maintenance-packages) |
| Public types | 91 across 7 namespaces | 51 across 5 namespaces |
| `[Obsolete]` on public API | No | Yes, CS0618 on every type |
| Highest .NET asset | `net9.0` | `net8.0` |
| .NET asset removed when | not planned | .NET 8 EOL, November 10, 2026 |
| `Encrypt` default | `true` since 4.0 | `false` |
| `Encrypt` property type | `SqlConnectionEncryptOption` | `bool` |
| TDS 8.0 / `Encrypt=Strict` | Yes since 5.0 | No |
| TLS 1.3 | Yes, via TDS 8.0 | No |
| Microsoft Entra ID auth | Yes, via `Extensions.Azure` | No |
| `SqlBatch` | Yes since 5.2 | No |
| Always Encrypted with secure enclaves | Yes | No |
| Data classification / sensitivity | Yes (6 types) | No |
| SQL Server 2025 `json` type (`SqlJson`) | Yes since 6.0 | No |
| SQL Server 2025 `vector` type (`SqlVector<T>`) | Yes since 6.1 | No |
| Configurable retry logic | Yes | No |
| Connection string keywords | 48 | 38 |
| Publish output, hello-world console | 7.35 MB / 23 assemblies | 1.07 MB / 2 assemblies |

The type and keyword counts come from loading both assemblies into a `MetadataLoadContext` and diffing `GetExportedTypes()` and `SqlConnectionStringBuilder.GetProperties()`, not from reading release notes.

## The deprecation clock is the whole argument

Microsoft published the [deprecation plan](https://github.com/dotnet/announcements/issues/322) in August 2024, and it is unusually specific. Version 5.0.0 was to drop everything below .NET 8 and .NET Framework 4.6.2 and add `[Obsolete]` to the .NET assets. After .NET 9 GA, nothing more. After .NET 8 end of support, the .NET library assets are removed and only .NET Framework 4.6.2+ consumers remain, serviced through .NET Framework itself rather than through the package. The announcement's words are plain: Microsoft does not expect to update the package again after that point.

.NET 8 reaches [end of support on November 10, 2026](https://devblogs.microsoft.com/dotnet/dotnet-8-9-end-of-support/). .NET 11 reaches RTM the same day. So the question "which SqlClient on .NET 11" answers itself: on the day .NET 11 exists as a supported runtime, `System.Data.SqlClient` has no supported .NET story at all. It will still restore. A `net11.0` project will happily pick up the `net8.0` asset and run. It will simply be unserviced code sitting in your connection path.

Note that the package did drift from the plan in one direction: 4.9.1 shipped on February 12, 2026 with a `net8.0` asset the original plan did not promise, and the repo moved to `dotnet/maintenance-packages`. That is maintenance, not development. The nuspec dependency is still `runtime.native.System.Data.SqlClient.sni` **4.4.0**, a native SNI build from 2017.

## What the compiler already tells you

You do not have to take the announcement's word for it. Reference 4.9.1 from a modern project and touch anything:

```csharp
// net10.0 (identical on net11.0), System.Data.SqlClient 4.9.1
using System.Data.SqlClient;

var b = new SqlConnectionStringBuilder { DataSource = "localhost", InitialCatalog = "db" };
Console.WriteLine($"Encrypt default: {b.Encrypt}");
```

```text
warning CS0618: 'SqlConnectionStringBuilder' is obsolete:
'Use the Microsoft.Data.SqlClient package instead.'
```

```text
Encrypt default: False
```

The same program against `Microsoft.Data.SqlClient` 7.0.3 builds with zero warnings and prints `Encrypt default: True`. That one line is the most consequential behavioural difference between the two packages, and the rest of this post spends real time on it.

## The gap you cannot close with a shim

The 10 connection string keywords that exist only in `Microsoft.Data.SqlClient` are not conveniences. Diffing `SqlConnectionStringBuilder` properties gives exactly: `Authentication`, `AttestationProtocol`, `ColumnEncryptionSetting`, `CommandTimeout`, `EnclaveAttestationUrl`, `FailoverPartnerSPN`, `HostNameInCertificate`, `IPAddressPreference`, `ServerCertificate`, `ServerSPN`. The reverse diff is empty: `System.Data.SqlClient` has no keyword the modern driver lacks.

Feed those keywords to the old builder and you get the failure modes people hit when they try to connect a legacy app to SQL Server 2022 or 2025:

```csharp
// System.Data.SqlClient 4.9.1
new SqlConnectionStringBuilder("Server=localhost;Encrypt=Strict");
// FormatException: String 'Strict' was not recognized as a valid Boolean.

new SqlConnectionStringBuilder("Server=localhost;Authentication=Active Directory Default");
// ArgumentException: Keyword not supported: 'authentication'.

new SqlConnectionStringBuilder("Server=localhost;HostNameInCertificate=sql.contoso.com");
// ArgumentException: Keyword not supported: 'hostnameincertificate'.

new SqlConnectionStringBuilder("Server=localhost;ServerCertificate=/etc/ssl/sql.pem");
// ArgumentException: Keyword not supported: 'servercertificate'.
```

`Encrypt=Strict` is the client half of [TDS 8.0](https://learn.microsoft.com/en-us/sql/relational-databases/security/networking/tds-8), the protocol revision SQL Server 2022 introduced so that the TLS handshake happens before TDS rather than inside it. TDS 8.0 is what makes TLS 1.3 reachable from a SQL Server client. `System.Data.SqlClient` was never updated for it, which means no TLS 1.3, and no path to it. If your security team has a TLS 1.3 mandate, the driver choice is already made for you by someone else.

The same applies to Microsoft Entra ID. `Authentication=Active Directory Default`, `Active Directory Managed Identity`, and friends simply do not parse. There is no token callback story either: `SqlConnection.AccessTokenCallback` is one of the members that exists only on the modern driver, alongside `RetryLogicProvider`, `SspiContextProvider`, `ServerProcessId`, and the whole `RegisterColumnEncryptionKeyStoreProviders` family.

If you are connecting to SQL Server 2025 and want to use the native `json` column type or `vector` columns, `Microsoft.Data.SqlTypes.SqlJson` (6.0) and `Microsoft.Data.SqlTypes.SqlVector<T>` (6.1) are the only supported client representations. `SqlVector<T>` in particular sends vectors in a compact binary form over TDS instead of JSON strings. If you are weighing that column type at all, the [native json column vs nvarchar(max) comparison](/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/) covers the storage side of the same decision.

## The one honest argument for the old package, measured

`System.Data.SqlClient` is small. That is its entire remaining advantage, and it is real. I published a hello-world console app (`dotnet publish -c Release -r osx-arm64 --self-contained false`) against each driver:

| Package | Publish output | Assemblies | Transitive packages |
| --- | --- | --- | --- |
| `System.Data.SqlClient` 4.9.1 | 1.07 MB | 2 | 4 |
| `Microsoft.Data.SqlClient` 7.0.3 | 7.35 MB | 23 | 22 |
| `Microsoft.Data.SqlClient` 6.1.7 | 17.3 MB | 29 | 29 |

That 6.1.7 row is why the 7.0 release matters even if you were already on the modern driver. Diffing the two publish folders, 7.0.3 drops `Azure.Core`, `Azure.Identity`, `Microsoft.Identity.Client`, `Microsoft.Identity.Client.Broker`, `Microsoft.Identity.Client.Extensions.Msal`, `Microsoft.Identity.Client.NativeInterop`, `System.ClientModel`, `System.Memory.Data`, `Microsoft.Bcl.AsyncInterfaces` and, the single largest file in the whole 6.1.7 output, `msalruntime_arm64.dylib` at **7.5 MB**. A native MSAL broker binary, in a console app that never authenticates to anything. Version 7.0 moved all of it into the optional `Microsoft.Data.SqlClient.Extensions.Azure` package, and the resulting output is 10.2 MB smaller.

So `Microsoft.Data.SqlClient` is still about 7x the deployed footprint of the deprecated package. If that genuinely matters to you -- a trimmed container image, a Native AOT binary -- weigh it against the 22 packages it also pulls into your restore graph. It does not change the recommendation. 6 MB of assemblies is not worth an unsupported TLS stack. But it is the one number where the old package wins, and pretending otherwise would be dishonest.

## The `Encrypt` flip is the migration break

Most `System.Data.SqlClient` to `Microsoft.Data.SqlClient` migrations that fail, fail here. The old default is `Encrypt=false`. The modern default has been `Encrypt=true` since 4.0. Connection strings that worked for a decade start failing certificate validation against a dev SQL Server with a self-signed cert.

The reflex fix is `TrustServerCertificate=true`, and it is the wrong one outside a controlled dev box: it turns encryption into an unauthenticated tunnel. `Microsoft.Data.SqlClient` gives you two better tools, both of them keywords the old driver does not have:

```csharp
// Microsoft.Data.SqlClient 7.0.3
// The server's cert is issued to sql-prod.internal but you connect by IP or alias.
var cs = "Server=10.0.4.12,1433;Database=orders;"
       + "Encrypt=Strict;"
       + "HostNameInCertificate=sql-prod.internal;"
       + "Authentication=Active Directory Default";
```

`HostNameInCertificate` fixes the name-mismatch case without disabling validation. `ServerCertificate` points at a specific PEM or CER file for a self-signed or private-CA server, again without disabling validation. Between the two, almost every real `TrustServerCertificate=true` in a codebase can be replaced with something that still validates.

One more trap in the same area: `SqlConnectionStringBuilder.Encrypt` changed type from `bool` to `SqlConnectionEncryptOption` in 5.0. Assignments like `builder.Encrypt = true` still compile thanks to an implicit conversion, so it looks source-compatible. It is a **binary** breaking change. Any assembly you do not recompile against the new driver will throw `MissingMethodException` at runtime. If you ship a shared data-access library, rebuild and republish it, do not just swap the driver underneath. The same class of mistake produces the [Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0' error](/2026/09/fix-could-not-load-file-or-assembly-microsoft-data-sqlclient-version-7-0-0-0/) when a stale 6.x copy wins the restore.

## Four more things that bite during the migration

**Entra auth now needs a second package.** In 7.0, forgetting it produces a clear message rather than a mystery, which is a genuine improvement:

```text
System.ArgumentException: Cannot find an authentication provider for 'ActiveDirectoryDefault'.
Install the 'Microsoft.Data.SqlClient.Extensions.Azure' NuGet package to use
Active Directory (Entra ID) authentication methods.
```

Add `Microsoft.Data.SqlClient.Extensions.Azure` pinned to the same version as the core driver. Since 7.0.2 the core driver and its companion packages use aligned version numbers, so `7.0.3` for both.

**Some types move namespaces, and not all of them.** `SqlDataRecord` and `SqlMetaData` go from `Microsoft.SqlServer.Server` to `Microsoft.Data.SqlClient.Server`. `SqlFileStream` goes from `System.Data.SqlTypes` to `Microsoft.Data.SqlTypes`. `SqlNotificationRequest` goes from `System.Data.Sql` to `Microsoft.Data.Sql`. `OperationAbortedException` goes from `System.Data` to `Microsoft.Data`. But the SQL CLR attributes stay put: `SqlFunctionAttribute`, `SqlUserDefinedTypeAttribute`, `IBinarySerialize` and the rest are in `System.Data.SqlClient`'s assembly today and in a separate `Microsoft.SqlServer.Server` package under the modern driver, which is why that package shows up in the transitive list. Do not do a blind find-and-replace on `System.Data`. `CommandType`, `DbType`, `IsolationLevel`, `DataTable` and every `System.Data.Common` type stay exactly where they are.

**Date and time parameters behave differently.** `DbType.Time` with a `DateTime` value was accepted by the old driver; the modern one wants a `TimeSpan`. `DbType.Date` with a `DateTime` truncates the time components instead of sending them. If you have `AddWithValue` calls around date columns, this is where a silent behaviour change hides. Specify `SqlDbType`, length, precision and scale explicitly for anything that matters.

**Globalization-invariant mode is not supported.** If your container sets `InvariantGlobalization=true` to shave startup and size, `Microsoft.Data.SqlClient` is not supported in that configuration. This bites teams doing exactly the trimming work described above.

And before you declare the migration done, run `dotnet list package --include-transitive`. Removing your direct reference does not remove the one an old ORM or SQL CLR helper drags in. Two SqlClient packages in one graph compiles fine and then fails the moment a `SqlConnection` from one crosses into an API expecting the other, because the names are identical and the types are not.

## Which Microsoft.Data.SqlClient line to take

| Line | Released | Support | End of support |
| --- | --- | --- | --- |
| 7.0 (`7.0.3`) | March 17, 2026 | STS | set by the next release |
| 6.1 (`6.1.7`) | August 14, 2025 | **LTS** | August 14, 2028 |

Take **7.0.3** for a new .NET 11 service. You get the 10 MB slimmer package, pluggable SSPI via `SspiContextProvider`, enhanced routing for Azure SQL Hyperscale, and `SqlClientDiagnosticListener` parity on .NET Framework. Take **6.1.7** if you need a dated support commitment on paper, or if you are mid-migration and cannot absorb the `Extensions.Azure` split right now. Both support SQL Server 2017 through 2025, Azure SQL, and Fabric. Everything at 6.0 and below is already out of support, including the 5.1 LTS line, which ended January 20, 2026.

The recommendation stands as stated up top: migrate. The compiler is already warning you, the package description already says deprecated, and the runtime the old package targets goes end of support the day .NET 11 ships. The work is a package swap, a namespace pass, a hard look at every `Encrypt` and `TrustServerCertificate` in your configuration, and a rebuild of every assembly that touches `SqlConnectionStringBuilder`. Budget a day for a normal service. It is a much better day than the one where a TLS 1.3 mandate lands on an unserviced driver.

## Related

- [Fix: Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0' after updating EF Core](/2026/09/fix-could-not-load-file-or-assembly-microsoft-data-sqlclient-version-7-0-0-0/)
- [Migrate from .NET Framework 4.8 to .NET 11 in 2026](/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/)
- [SQL Server compatibility level 150 vs 160: what changes for EF Core 11 queries](/2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries/)
- [Native json column vs nvarchar(max) for storing JSON in SQL Server with EF Core 11](/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/)
- [Fix: EF Core MigrateAsync and CanConnectAsync keep retrying on 'Login failed for user' for 60 seconds](/2026/09/fix-migrateasync-canconnectasync-keep-retrying-on-login-failed-for-user-ef-core/)

## Sources

- [Announcement: System.Data.SqlClient package is now deprecated](https://github.com/dotnet/announcements/issues/322), dotnet/announcements issue 322, with the full staged deprecation plan.
- [Migrate from System.Data.SqlClient to Microsoft.Data.SqlClient](https://learn.microsoft.com/en-us/sql/connect/ado-net/migrate-system-data-sql-client-to-microsoft-data-sql-client), MS Learn, updated September 16, 2026.
- [Microsoft.Data.SqlClient namespace and compatibility](https://learn.microsoft.com/en-us/sql/connect/ado-net/introduction-microsoft-data-sqlclient-namespace), MS Learn.
- [SqlClient driver support lifecycle](https://learn.microsoft.com/en-us/sql/connect/ado-net/sqlclient-driver-support-lifecycle), MS Learn, for the 7.0 and 6.1 support tables.
- [Microsoft.Data.SqlClient 7.0.0 release notes](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.0.md), dotnet/SqlClient.
- [TDS 8.0](https://learn.microsoft.com/en-us/sql/relational-databases/security/networking/tds-8), MS Learn, for the `Encrypt=Strict` and TLS 1.3 relationship.
- [.NET 8 and .NET 9 will reach end of support on November 10, 2026](https://devblogs.microsoft.com/dotnet/dotnet-8-9-end-of-support/), .NET Blog.
- [System.Data.SqlClient on NuGet](https://www.nuget.org/packages/System.Data.SqlClient), version 4.9.1, published February 12, 2026.
