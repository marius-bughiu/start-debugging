---
title: "Microsoft.Data.SqlClient vs System.Data.SqlClient in .NET 11"
description: "Verwenden Sie Microsoft.Data.SqlClient. System.Data.SqlClient ist veraltet, meldet bereits CS0618 bei jedem Typ, den Sie anfassen, und verliert seine .NET-Assets, wenn .NET 8 am 2026-11-10 das Supportende erreicht, am selben Tag, an dem .NET 11 erscheint. Die gemessene Funktionslücke, der Encrypt-Standardwert, der die Migration bricht, und die Paketaufteilung in 7.0."
pubDate: 2026-09-17
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "sql-server"
  - "migration"
lang: "de"
translationOf: "2026/09/microsoft-data-sqlclient-vs-system-data-sqlclient-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-17
---

Verwenden Sie **`Microsoft.Data.SqlClient`**. Das ist kein knapper Vergleich und war es seit 2022 nicht mehr. `System.Data.SqlClient` ist formal veraltet, die Beschreibung des NuGet-Pakets lautet wörtlich "DEPRECATED - Use Microsoft.Data.SqlClient.", jeder öffentliche Typ trägt `[Obsolete]`, und nach Microsofts eigenem Stufenplan verschwinden seine .NET-Assets, sobald .NET 8 am **2026-11-10** das Supportende erreicht -- dem Tag, an dem auch .NET 11 erscheint. Zu entscheiden bleibt nur, welche `Microsoft.Data.SqlClient`-Linie Sie nehmen (7.0 oder das 6.1 LTS) und wie Sie die Migration überstehen, denn die Pakete unterscheiden sich in weit mehr als einem Namespace.

Alles Folgende wurde auf macOS 26.6.2 (Apple M4) mit dem .NET SDK `10.0.302` geprüft, gegen `Microsoft.Data.SqlClient` 7.0.3 und `System.Data.SqlClient` 4.9.1, die aktuellen Releases zum Zeitpunkt des Schreibens. Die Asset-Auswahl ist unter `net11.0` identisch: keines der beiden Pakete enthält einen `net10.0`- oder `net11.0`-Ordner, also löst ein .NET-11-Projekt `runtimes/unix/lib/net9.0/Microsoft.Data.SqlClient.dll` und `runtimes/unix/lib/net8.0/System.Data.SqlClient.dll` auf, genau das, was ein `net10.0`-Projekt auflöst.

## Die Matrix

| | `Microsoft.Data.SqlClient` 7.0.3 | `System.Data.SqlClient` 4.9.1 |
| --- | --- | --- |
| Supportstatus | STS, in Entwicklung (7.0 GA am 2026-03-17) | Veraltet, nur Wartung |
| Ausgeliefert aus | [dotnet/SqlClient](https://github.com/dotnet/SqlClient) | [dotnet/maintenance-packages](https://github.com/dotnet/maintenance-packages) |
| Öffentliche Typen | 91 in 7 Namespaces | 51 in 5 Namespaces |
| `[Obsolete]` in der öffentlichen API | Nein | Ja, CS0618 bei jedem Typ |
| Höchstes .NET-Asset | `net9.0` | `net8.0` |
| .NET-Asset entfällt bei | nicht geplant | Supportende .NET 8, 2026-11-10 |
| `Encrypt`-Standardwert | `true` seit 4.0 | `false` |
| Typ der `Encrypt`-Eigenschaft | `SqlConnectionEncryptOption` | `bool` |
| TDS 8.0 / `Encrypt=Strict` | Ja seit 5.0 | Nein |
| TLS 1.3 | Ja, über TDS 8.0 | Nein |
| Microsoft Entra ID-Authentifizierung | Ja, über `Extensions.Azure` | Nein |
| `SqlBatch` | Ja seit 5.2 | Nein |
| Always Encrypted mit Secure Enclaves | Ja | Nein |
| Datenklassifizierung / Vertraulichkeit | Ja (6 Typen) | Nein |
| SQL Server 2025 `json`-Typ (`SqlJson`) | Ja seit 6.0 | Nein |
| SQL Server 2025 `vector`-Typ (`SqlVector<T>`) | Ja seit 6.1 | Nein |
| Konfigurierbare Wiederholungslogik | Ja | Nein |
| Schlüsselwörter der Verbindungszeichenfolge | 48 | 38 |
| Publish-Ausgabe, Hello-World-Konsole | 7.35 MB / 23 Assemblies | 1.07 MB / 2 Assemblies |

Die Typ- und Schlüsselwortzahlen stammen daraus, beide Assemblies in einen `MetadataLoadContext` zu laden und `GetExportedTypes()` sowie `SqlConnectionStringBuilder.GetProperties()` zu vergleichen, nicht aus dem Lesen von Release Notes.

## Die Abkündigungsuhr ist das ganze Argument

Microsoft hat den [Abkündigungsplan](https://github.com/dotnet/announcements/issues/322) im August 2024 veröffentlicht, und er ist ungewöhnlich konkret. Version 5.0.0 sollte alles unterhalb von .NET 8 und .NET Framework 4.6.2 streichen und `[Obsolete]` zu den .NET-Assets hinzufügen. Nach dem GA von .NET 9 nichts weiter. Nach dem Supportende von .NET 8 werden die .NET-Bibliotheksassets entfernt, und es bleiben nur Konsumenten von .NET Framework 4.6.2+, die über .NET Framework selbst und nicht über das Paket bedient werden. Die Ankündigung ist deutlich: Microsoft erwartet nach diesem Punkt keine weitere Aktualisierung des Pakets.

.NET 8 erreicht das [Supportende am 2026-11-10](https://devblogs.microsoft.com/dotnet/dotnet-8-9-end-of-support/). .NET 11 erreicht am selben Tag RTM. Die Frage "welcher SqlClient unter .NET 11" beantwortet sich also selbst: an dem Tag, an dem .NET 11 als unterstützte Laufzeit existiert, hat `System.Data.SqlClient` überhaupt keine unterstützte .NET-Geschichte mehr. Es wird weiterhin wiederhergestellt. Ein `net11.0`-Projekt greift bereitwillig zum `net8.0`-Asset und läuft. Es ist dann schlicht nicht gewarteter Code in Ihrem Verbindungspfad.

Beachten Sie, dass das Paket in eine Richtung vom Plan abgewichen ist: 4.9.1 erschien am 2026-02-12 mit einem `net8.0`-Asset, das der ursprüngliche Plan nicht zugesagt hatte, und das Repository wechselte zu `dotnet/maintenance-packages`. Das ist Wartung, nicht Entwicklung. Die Abhängigkeit im nuspec lautet weiterhin `runtime.native.System.Data.SqlClient.sni` **4.4.0**, ein nativer SNI-Build von 2017.

## Was der Compiler Ihnen bereits sagt

Sie müssen der Ankündigung nicht glauben. Referenzieren Sie 4.9.1 aus einem modernen Projekt und fassen Sie irgendetwas an:

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

Dasselbe Programm gegen `Microsoft.Data.SqlClient` 7.0.3 kompiliert mit null Warnungen und gibt `Encrypt default: True` aus. Diese eine Zeile ist der folgenreichste Verhaltensunterschied zwischen den beiden Paketen, und der Rest dieses Beitrags widmet ihr echte Aufmerksamkeit.

## Die Lücke, die kein Shim schließt

Die 10 Schlüsselwörter der Verbindungszeichenfolge, die es nur in `Microsoft.Data.SqlClient` gibt, sind keine Bequemlichkeiten. Der Vergleich der `SqlConnectionStringBuilder`-Eigenschaften ergibt exakt: `Authentication`, `AttestationProtocol`, `ColumnEncryptionSetting`, `CommandTimeout`, `EnclaveAttestationUrl`, `FailoverPartnerSPN`, `HostNameInCertificate`, `IPAddressPreference`, `ServerCertificate`, `ServerSPN`. Der umgekehrte Vergleich ist leer: `System.Data.SqlClient` hat kein Schlüsselwort, das dem modernen Treiber fehlt.

Geben Sie diese Schlüsselwörter an den alten Builder, und Sie erhalten genau die Fehlerbilder, die auftreten, wenn eine Altanwendung an SQL Server 2022 oder 2025 angebunden werden soll:

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

`Encrypt=Strict` ist die Client-Hälfte von [TDS 8.0](https://learn.microsoft.com/en-us/sql/relational-databases/security/networking/tds-8), der Protokollrevision, die SQL Server 2022 eingeführt hat, damit der TLS-Handshake vor TDS stattfindet statt darin. TDS 8.0 macht TLS 1.3 von einem SQL Server-Client aus überhaupt erst erreichbar. `System.Data.SqlClient` wurde dafür nie aktualisiert, also kein TLS 1.3 und kein Weg dorthin. Wenn Ihr Sicherheitsteam eine TLS-1.3-Vorgabe hat, wurde die Treiberwahl bereits von jemand anderem getroffen.

Dasselbe gilt für Microsoft Entra ID. `Authentication=Active Directory Default`, `Active Directory Managed Identity` und Verwandte werden schlicht nicht geparst. Es gibt auch keinen Token-Weg: `SqlConnection.AccessTokenCallback` ist eines der Member, die es nur im modernen Treiber gibt, neben `RetryLogicProvider`, `SspiContextProvider`, `ServerProcessId` und der gesamten `RegisterColumnEncryptionKeyStoreProviders`-Familie.

Wenn Sie sich mit SQL Server 2025 verbinden und den nativen `json`-Spaltentyp oder `vector`-Spalten nutzen wollen, sind `Microsoft.Data.SqlTypes.SqlJson` (6.0) und `Microsoft.Data.SqlTypes.SqlVector<T>` (6.1) die einzigen unterstützten Client-Repräsentationen. `SqlVector<T>` sendet Vektoren in einer kompakten Binärform über TDS statt als JSON-Zeichenfolgen. Wenn Sie diesen Spaltentyp überhaupt erwägen, deckt der [Vergleich zwischen nativer json-Spalte und nvarchar(max)](/de/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/) die Speicherseite derselben Entscheidung ab.

## Das eine ehrliche Argument für das alte Paket, gemessen

`System.Data.SqlClient` ist klein. Das ist sein gesamter verbliebener Vorteil, und er ist real. Ich habe eine Hello-World-Konsolenanwendung (`dotnet publish -c Release -r osx-arm64 --self-contained false`) gegen beide Treiber veröffentlicht:

| Paket | Publish-Ausgabe | Assemblies | Transitive Pakete |
| --- | --- | --- | --- |
| `System.Data.SqlClient` 4.9.1 | 1.07 MB | 2 | 4 |
| `Microsoft.Data.SqlClient` 7.0.3 | 7.35 MB | 23 | 22 |
| `Microsoft.Data.SqlClient` 6.1.7 | 17.3 MB | 29 | 29 |

Diese 6.1.7-Zeile ist der Grund, warum das 7.0-Release selbst dann zählt, wenn Sie bereits auf dem modernen Treiber waren. Vergleicht man die beiden Publish-Ordner, entfallen in 7.0.3 `Azure.Core`, `Azure.Identity`, `Microsoft.Identity.Client`, `Microsoft.Identity.Client.Broker`, `Microsoft.Identity.Client.Extensions.Msal`, `Microsoft.Identity.Client.NativeInterop`, `System.ClientModel`, `System.Memory.Data`, `Microsoft.Bcl.AsyncInterfaces` und, die größte Einzeldatei der gesamten 6.1.7-Ausgabe, `msalruntime_arm64.dylib` mit **7.5 MB**. Eine native MSAL-Broker-Binärdatei, in einer Konsolenanwendung, die sich nirgendwo authentifiziert. Version 7.0 hat all das in das optionale Paket `Microsoft.Data.SqlClient.Extensions.Azure` verschoben, und die resultierende Ausgabe ist 10.2 MB kleiner.

`Microsoft.Data.SqlClient` bleibt damit rund 7-mal so groß im Deployment wie das veraltete Paket. Wenn das für Sie wirklich zählt -- ein getrimmtes Container-Image, eine Native-AOT-Binärdatei -- wägen Sie es gegen die 22 Pakete ab, die es zusätzlich in Ihren Restore-Graph zieht. An der Empfehlung ändert es nichts. 6 MB Assemblies sind keinen nicht unterstützten TLS-Stack wert. Aber es ist die eine Zahl, bei der das alte Paket gewinnt, und etwas anderes zu behaupten wäre unredlich.

## Der `Encrypt`-Wechsel bricht die Migration

Die meisten Migrationen von `System.Data.SqlClient` zu `Microsoft.Data.SqlClient`, die scheitern, scheitern hier. Der alte Standardwert ist `Encrypt=false`. Der moderne ist seit 4.0 `Encrypt=true`. Verbindungszeichenfolgen, die ein Jahrzehnt lang funktioniert haben, scheitern plötzlich an der Zertifikatsprüfung gegen einen Entwicklungs-SQL-Server mit selbstsigniertem Zertifikat.

Der Reflex ist `TrustServerCertificate=true`, und außerhalb einer kontrollierten Entwicklungsmaschine ist das die falsche Lösung: sie macht aus der Verschlüsselung einen nicht authentifizierten Tunnel. `Microsoft.Data.SqlClient` bietet zwei bessere Werkzeuge, beides Schlüsselwörter, die der alte Treiber nicht hat:

```csharp
// Microsoft.Data.SqlClient 7.0.3
// The server's cert is issued to sql-prod.internal but you connect by IP or alias.
var cs = "Server=10.0.4.12,1433;Database=orders;"
       + "Encrypt=Strict;"
       + "HostNameInCertificate=sql-prod.internal;"
       + "Authentication=Active Directory Default";
```

`HostNameInCertificate` löst den Fall des abweichenden Namens, ohne die Prüfung abzuschalten. `ServerCertificate` verweist auf eine bestimmte PEM- oder CER-Datei für einen selbstsignierten Server oder einen Server mit privater CA, ebenfalls ohne die Prüfung abzuschalten. Mit diesen beiden lässt sich fast jedes reale `TrustServerCertificate=true` in einer Codebasis durch etwas ersetzen, das weiterhin validiert.

Noch eine Falle im selben Bereich: `SqlConnectionStringBuilder.Encrypt` hat in 5.0 den Typ von `bool` zu `SqlConnectionEncryptOption` gewechselt. Zuweisungen wie `builder.Encrypt = true` kompilieren dank impliziter Konvertierung weiterhin, es sieht also quellcodekompatibel aus. Es ist ein **binärer** Breaking Change. Jede Assembly, die Sie nicht gegen den neuen Treiber neu kompilieren, wirft zur Laufzeit `MissingMethodException`. Wenn Sie eine gemeinsame Datenzugriffsbibliothek ausliefern, kompilieren und veröffentlichen Sie sie neu, tauschen Sie nicht nur den Treiber darunter aus. Dieselbe Fehlerklasse erzeugt den [Fehler Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0'](/de/2026/09/fix-could-not-load-file-or-assembly-microsoft-data-sqlclient-version-7-0-0-0/), wenn eine veraltete 6.x-Kopie den Restore gewinnt.

## Vier weitere Dinge, die bei der Migration zubeißen

**Entra-Authentifizierung braucht jetzt ein zweites Paket.** In 7.0 erzeugt das Vergessen eine klare Meldung statt eines Rätsels, was eine echte Verbesserung ist:

```text
System.ArgumentException: Cannot find an authentication provider for 'ActiveDirectoryDefault'.
Install the 'Microsoft.Data.SqlClient.Extensions.Azure' NuGet package to use
Active Directory (Entra ID) authentication methods.
```

Fügen Sie `Microsoft.Data.SqlClient.Extensions.Azure` hinzu, festgepinnt auf dieselbe Version wie der Kerntreiber. Seit 7.0.2 verwenden Kerntreiber und Begleitpakete abgestimmte Versionsnummern, also `7.0.3` für beide.

**Einige Typen wechseln den Namespace, aber nicht alle.** `SqlDataRecord` und `SqlMetaData` gehen von `Microsoft.SqlServer.Server` nach `Microsoft.Data.SqlClient.Server`. `SqlFileStream` geht von `System.Data.SqlTypes` nach `Microsoft.Data.SqlTypes`. `SqlNotificationRequest` geht von `System.Data.Sql` nach `Microsoft.Data.Sql`. `OperationAbortedException` geht von `System.Data` nach `Microsoft.Data`. Die SQL-CLR-Attribute bleiben aber, wo sie sind: `SqlFunctionAttribute`, `SqlUserDefinedTypeAttribute`, `IBinarySerialize` und der Rest liegen heute in der Assembly von `System.Data.SqlClient` und beim modernen Treiber in einem separaten Paket `Microsoft.SqlServer.Server`, weshalb dieses Paket in der Transitivliste auftaucht. Machen Sie kein blindes Suchen und Ersetzen auf `System.Data`. `CommandType`, `DbType`, `IsolationLevel`, `DataTable` und jeder Typ aus `System.Data.Common` bleiben exakt dort, wo sie sind.

**Datums- und Zeitparameter verhalten sich anders.** `DbType.Time` mit einem `DateTime`-Wert akzeptierte der alte Treiber; der moderne will einen `TimeSpan`. `DbType.Date` mit einem `DateTime`-Wert schneidet die Zeitanteile ab, statt sie zu senden. Wenn Sie `AddWithValue`-Aufrufe rund um Datumsspalten haben, versteckt sich dort eine stille Verhaltensänderung. Geben Sie `SqlDbType`, Länge, Präzision und Skalierung explizit an, wo es darauf ankommt.

**Der Globalization-Invariant-Modus wird nicht unterstützt.** Wenn Ihr Container `InvariantGlobalization=true` setzt, um Startzeit und Größe zu sparen, wird `Microsoft.Data.SqlClient` in dieser Konfiguration nicht unterstützt. Das trifft genau die Teams, die die oben beschriebene Trimming-Arbeit machen.

Und bevor Sie die Migration für erledigt erklären, führen Sie `dotnet list package --include-transitive` aus. Das Entfernen Ihrer direkten Referenz entfernt nicht die, die ein altes ORM oder ein SQL-CLR-Helper mitschleppt. Zwei SqlClient-Pakete in einem Graph kompilieren problemlos und scheitern dann in dem Moment, in dem eine `SqlConnection` aus dem einen in eine API übergeht, die die des anderen erwartet, denn die Namen sind identisch und die Typen nicht.

## Welche Microsoft.Data.SqlClient-Linie Sie nehmen sollten

| Linie | Veröffentlicht | Support | Supportende |
| --- | --- | --- | --- |
| 7.0 (`7.0.3`) | 2026-03-17 | STS | wird vom nächsten Release bestimmt |
| 6.1 (`6.1.7`) | 2025-08-14 | **LTS** | 2028-08-14 |

Nehmen Sie **7.0.3** für einen neuen .NET-11-Dienst. Sie bekommen das 10 MB schlankere Paket, steckbares SSPI über `SspiContextProvider`, verbessertes Routing für Azure SQL Hyperscale und `SqlClientDiagnosticListener`-Parität unter .NET Framework. Nehmen Sie **6.1.7**, wenn Sie eine datierte Supportzusage auf dem Papier brauchen oder mitten in einer Migration stecken und die `Extensions.Azure`-Aufteilung gerade nicht verkraften. Beide unterstützen SQL Server 2017 bis 2025, Azure SQL und Fabric. Alles ab 6.0 abwärts ist bereits außerhalb des Supports, einschließlich der 5.1-LTS-Linie, die am 2026-01-20 endete.

Die Empfehlung bleibt, wie eingangs gesagt: migrieren Sie. Der Compiler warnt Sie bereits, die Paketbeschreibung sagt bereits veraltet, und die Laufzeit, auf die das alte Paket zielt, erreicht das Supportende an dem Tag, an dem .NET 11 erscheint. Die Arbeit besteht aus einem Pakettausch, einem Namespace-Durchgang, einem gründlichen Blick auf jedes `Encrypt` und `TrustServerCertificate` in Ihrer Konfiguration und einer Neukompilierung jeder Assembly, die `SqlConnectionStringBuilder` berührt. Planen Sie einen Tag für einen normalen Dienst ein. Das ist ein deutlich besserer Tag als der, an dem eine TLS-1.3-Vorgabe auf einen ungewarteten Treiber trifft.

## Verwandt

- [Fix: Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0' nach dem EF Core-Update](/de/2026/09/fix-could-not-load-file-or-assembly-microsoft-data-sqlclient-version-7-0-0-0/)
- [Von .NET Framework 4.8 auf .NET 11 migrieren im Jahr 2026](/de/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/)
- [SQL Server-Kompatibilitätsgrad 150 vs 160: was sich für EF Core 11-Abfragen ändert](/de/2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries/)
- [Native json-Spalte vs nvarchar(max) zum Speichern von JSON in SQL Server mit EF Core 11](/de/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/)
- [Fix: EF Core MigrateAsync und CanConnectAsync wiederholen bei 'Login failed for user' 60 Sekunden lang](/de/2026/09/fix-migrateasync-canconnectasync-keep-retrying-on-login-failed-for-user-ef-core/)

## Quellen

- [Announcement: System.Data.SqlClient package is now deprecated](https://github.com/dotnet/announcements/issues/322), Issue 322 in dotnet/announcements, mit dem vollständigen Stufenplan zur Abkündigung.
- [Migrate from System.Data.SqlClient to Microsoft.Data.SqlClient](https://learn.microsoft.com/en-us/sql/connect/ado-net/migrate-system-data-sql-client-to-microsoft-data-sql-client), MS Learn, aktualisiert am 2026-09-16.
- [Microsoft.Data.SqlClient namespace and compatibility](https://learn.microsoft.com/en-us/sql/connect/ado-net/introduction-microsoft-data-sqlclient-namespace), MS Learn.
- [SqlClient driver support lifecycle](https://learn.microsoft.com/en-us/sql/connect/ado-net/sqlclient-driver-support-lifecycle), MS Learn, für die Supporttabellen zu 7.0 und 6.1.
- [Microsoft.Data.SqlClient 7.0.0 release notes](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.0.md), dotnet/SqlClient.
- [TDS 8.0](https://learn.microsoft.com/en-us/sql/relational-databases/security/networking/tds-8), MS Learn, zum Zusammenhang von `Encrypt=Strict` und TLS 1.3.
- [.NET 8 and .NET 9 will reach end of support on November 10, 2026](https://devblogs.microsoft.com/dotnet/dotnet-8-9-end-of-support/), .NET Blog.
- [System.Data.SqlClient auf NuGet](https://www.nuget.org/packages/System.Data.SqlClient), Version 4.9.1, veröffentlicht am 2026-02-12.
