---
title: "Microsoft.Data.SqlClient vs System.Data.SqlClient en .NET 11"
description: "Usa Microsoft.Data.SqlClient. System.Data.SqlClient está obsoleto, ya emite CS0618 en cada tipo que toques y pierde sus assets de .NET cuando .NET 8 llegue al fin de soporte el 2026-11-10, el mismo día en que sale .NET 11. La brecha de funcionalidad medida, el valor por defecto de Encrypt que rompe la migración y la división del paquete en 7.0."
pubDate: 2026-09-17
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "sql-server"
  - "migration"
lang: "es"
translationOf: "2026/09/microsoft-data-sqlclient-vs-system-data-sqlclient-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-17
---

Usa **`Microsoft.Data.SqlClient`**. Esta no es una comparación reñida y no lo es desde 2022. `System.Data.SqlClient` está formalmente obsoleto, la descripción de su paquete NuGet dice literalmente "DEPRECATED - Use Microsoft.Data.SqlClient.", cada tipo público lleva `[Obsolete]` y, según el propio plan escalonado de Microsoft, sus assets de .NET desaparecen cuando .NET 8 llegue al fin de soporte el **2026-11-10**, que además es el día en que sale .NET 11. La única decisión que queda es qué línea de `Microsoft.Data.SqlClient` tomar (7.0 o la LTS 6.1) y cómo sobrevivir a la migración, porque los paquetes se diferencian en mucho más que un namespace.

Todo lo que sigue fue verificado en macOS 26.6.2 (Apple M4) con el SDK de .NET `10.0.302`, contra `Microsoft.Data.SqlClient` 7.0.3 y `System.Data.SqlClient` 4.9.1, las versiones actuales al momento de escribir esto. La selección de assets es idéntica en `net11.0`: ninguno de los dos paquetes trae una carpeta `net10.0` ni `net11.0`, así que un proyecto .NET 11 resuelve `runtimes/unix/lib/net9.0/Microsoft.Data.SqlClient.dll` y `runtimes/unix/lib/net8.0/System.Data.SqlClient.dll`, exactamente lo que resuelve un proyecto `net10.0`.

## La matriz

| | `Microsoft.Data.SqlClient` 7.0.3 | `System.Data.SqlClient` 4.9.1 |
| --- | --- | --- |
| Estado de soporte | STS, en desarrollo (7.0 GA el 2026-03-17) | Obsoleto, solo mantenimiento |
| Se publica desde | [dotnet/SqlClient](https://github.com/dotnet/SqlClient) | [dotnet/maintenance-packages](https://github.com/dotnet/maintenance-packages) |
| Tipos públicos | 91 en 7 namespaces | 51 en 5 namespaces |
| `[Obsolete]` en la API pública | No | Sí, CS0618 en cada tipo |
| Asset de .NET más alto | `net9.0` | `net8.0` |
| El asset de .NET se elimina cuando | no está previsto | fin de soporte de .NET 8, 2026-11-10 |
| Valor por defecto de `Encrypt` | `true` desde 4.0 | `false` |
| Tipo de la propiedad `Encrypt` | `SqlConnectionEncryptOption` | `bool` |
| TDS 8.0 / `Encrypt=Strict` | Sí desde 5.0 | No |
| TLS 1.3 | Sí, vía TDS 8.0 | No |
| Autenticación con Microsoft Entra ID | Sí, vía `Extensions.Azure` | No |
| `SqlBatch` | Sí desde 5.2 | No |
| Always Encrypted con enclaves seguros | Sí | No |
| Clasificación de datos / sensibilidad | Sí (6 tipos) | No |
| Tipo `json` de SQL Server 2025 (`SqlJson`) | Sí desde 6.0 | No |
| Tipo `vector` de SQL Server 2025 (`SqlVector<T>`) | Sí desde 6.1 | No |
| Lógica de reintentos configurable | Sí | No |
| Palabras clave de cadena de conexión | 48 | 38 |
| Salida de publicación, consola hello-world | 7.35 MB / 23 ensamblados | 1.07 MB / 2 ensamblados |

Los conteos de tipos y palabras clave salen de cargar ambos ensamblados en un `MetadataLoadContext` y comparar `GetExportedTypes()` y `SqlConnectionStringBuilder.GetProperties()`, no de leer notas de versión.

## El reloj de la obsolescencia es todo el argumento

Microsoft publicó el [plan de obsolescencia](https://github.com/dotnet/announcements/issues/322) en agosto de 2024, y es inusualmente específico. La versión 5.0.0 debía eliminar todo lo anterior a .NET 8 y .NET Framework 4.6.2 y añadir `[Obsolete]` a los assets de .NET. Después del GA de .NET 9, nada más. Después del fin de soporte de .NET 8, los assets de biblioteca para .NET se eliminan y solo quedan los consumidores de .NET Framework 4.6.2+, atendidos a través de .NET Framework y no del paquete. Las palabras del anuncio son claras: Microsoft no espera volver a actualizar el paquete después de ese punto.

.NET 8 llega al [fin de soporte el 2026-11-10](https://devblogs.microsoft.com/dotnet/dotnet-8-9-end-of-support/). .NET 11 llega a RTM el mismo día. Así que la pregunta "cuál SqlClient en .NET 11" se responde sola: el día en que .NET 11 exista como runtime con soporte, `System.Data.SqlClient` no tendrá ninguna historia de .NET con soporte. Seguirá restaurándose. Un proyecto `net11.0` tomará tranquilamente el asset `net8.0` y funcionará. Simplemente será código sin mantenimiento sentado en tu ruta de conexión.

Ten en cuenta que el paquete sí se desvió del plan en una dirección: 4.9.1 salió el 2026-02-12 con un asset `net8.0` que el plan original no prometía, y el repositorio se mudó a `dotnet/maintenance-packages`. Eso es mantenimiento, no desarrollo. La dependencia declarada en el nuspec sigue siendo `runtime.native.System.Data.SqlClient.sni` **4.4.0**, una compilación nativa de SNI de 2017.

## Lo que el compilador ya te dice

No tienes que creerle al anuncio. Referencia 4.9.1 desde un proyecto moderno y toca cualquier cosa:

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

El mismo programa contra `Microsoft.Data.SqlClient` 7.0.3 compila con cero advertencias e imprime `Encrypt default: True`. Esa única línea es la diferencia de comportamiento más importante entre los dos paquetes, y el resto de este artículo le dedica tiempo real.

## La brecha que no puedes cerrar con un shim

Las 10 palabras clave de cadena de conexión que solo existen en `Microsoft.Data.SqlClient` no son comodidades. Comparar las propiedades de `SqlConnectionStringBuilder` da exactamente: `Authentication`, `AttestationProtocol`, `ColumnEncryptionSetting`, `CommandTimeout`, `EnclaveAttestationUrl`, `FailoverPartnerSPN`, `HostNameInCertificate`, `IPAddressPreference`, `ServerCertificate`, `ServerSPN`. La comparación inversa queda vacía: `System.Data.SqlClient` no tiene ninguna palabra clave que le falte al driver moderno.

Pásale esas palabras clave al builder viejo y obtienes los modos de fallo que aparecen cuando alguien intenta conectar una aplicación heredada a SQL Server 2022 o 2025:

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

`Encrypt=Strict` es la mitad del cliente de [TDS 8.0](https://learn.microsoft.com/en-us/sql/relational-databases/security/networking/tds-8), la revisión de protocolo que introdujo SQL Server 2022 para que el handshake de TLS ocurra antes de TDS y no dentro de él. TDS 8.0 es lo que hace alcanzable TLS 1.3 desde un cliente de SQL Server. `System.Data.SqlClient` nunca se actualizó para eso, lo que significa nada de TLS 1.3 y ningún camino hacia él. Si tu equipo de seguridad tiene un mandato de TLS 1.3, la elección del driver ya la tomó otra persona por ti.

Lo mismo aplica a Microsoft Entra ID. `Authentication=Active Directory Default`, `Active Directory Managed Identity` y compañía sencillamente no se parsean. Tampoco hay historia de tokens: `SqlConnection.AccessTokenCallback` es uno de los miembros que solo existe en el driver moderno, junto a `RetryLogicProvider`, `SspiContextProvider`, `ServerProcessId` y toda la familia `RegisterColumnEncryptionKeyStoreProviders`.

Si te conectas a SQL Server 2025 y quieres usar el tipo de columna nativo `json` o columnas `vector`, `Microsoft.Data.SqlTypes.SqlJson` (6.0) y `Microsoft.Data.SqlTypes.SqlVector<T>` (6.1) son las únicas representaciones de cliente con soporte. `SqlVector<T>` en particular envía vectores en una forma binaria compacta sobre TDS en lugar de cadenas JSON. Si estás evaluando ese tipo de columna, la [comparación entre la columna json nativa y nvarchar(max)](/es/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/) cubre el lado del almacenamiento de la misma decisión.

## El único argumento honesto a favor del paquete viejo, medido

`System.Data.SqlClient` es pequeño. Esa es toda su ventaja restante, y es real. Publiqué una aplicación de consola hello-world (`dotnet publish -c Release -r osx-arm64 --self-contained false`) contra cada driver:

| Paquete | Salida de publicación | Ensamblados | Paquetes transitivos |
| --- | --- | --- | --- |
| `System.Data.SqlClient` 4.9.1 | 1.07 MB | 2 | 4 |
| `Microsoft.Data.SqlClient` 7.0.3 | 7.35 MB | 23 | 22 |
| `Microsoft.Data.SqlClient` 6.1.7 | 17.3 MB | 29 | 29 |

Esa fila de 6.1.7 es la razón por la que el lanzamiento de 7.0 importa incluso si ya estabas en el driver moderno. Comparando las dos carpetas de publicación, 7.0.3 elimina `Azure.Core`, `Azure.Identity`, `Microsoft.Identity.Client`, `Microsoft.Identity.Client.Broker`, `Microsoft.Identity.Client.Extensions.Msal`, `Microsoft.Identity.Client.NativeInterop`, `System.ClientModel`, `System.Memory.Data`, `Microsoft.Bcl.AsyncInterfaces` y, el archivo más grande de toda la salida de 6.1.7, `msalruntime_arm64.dylib` con **7.5 MB**. Un binario nativo del broker de MSAL, en una aplicación de consola que nunca se autentica contra nada. La versión 7.0 movió todo eso al paquete opcional `Microsoft.Data.SqlClient.Extensions.Azure`, y la salida resultante es 10.2 MB más pequeña.

Así que `Microsoft.Data.SqlClient` sigue siendo unas 7 veces la huella desplegada del paquete obsoleto. Si eso te importa de verdad -- una imagen de contenedor recortada, un binario Native AOT -- sopésalo contra los 22 paquetes que además mete en tu grafo de restauración. No cambia la recomendación. 6 MB de ensamblados no valen una pila TLS sin soporte. Pero es el único número en el que gana el paquete viejo, y fingir lo contrario sería deshonesto.

## El cambio de `Encrypt` es lo que rompe la migración

La mayoría de las migraciones de `System.Data.SqlClient` a `Microsoft.Data.SqlClient` que fallan, fallan aquí. El valor por defecto viejo es `Encrypt=false`. El moderno es `Encrypt=true` desde 4.0. Cadenas de conexión que funcionaron durante una década empiezan a fallar la validación del certificado contra un SQL Server de desarrollo con un certificado autofirmado.

El arreglo reflejo es `TrustServerCertificate=true`, y es el equivocado fuera de una máquina de desarrollo controlada: convierte el cifrado en un túnel sin autenticar. `Microsoft.Data.SqlClient` te da dos herramientas mejores, ambas palabras clave que el driver viejo no tiene:

```csharp
// Microsoft.Data.SqlClient 7.0.3
// The server's cert is issued to sql-prod.internal but you connect by IP or alias.
var cs = "Server=10.0.4.12,1433;Database=orders;"
       + "Encrypt=Strict;"
       + "HostNameInCertificate=sql-prod.internal;"
       + "Authentication=Active Directory Default";
```

`HostNameInCertificate` arregla el caso de nombre que no coincide sin desactivar la validación. `ServerCertificate` apunta a un archivo PEM o CER específico para un servidor autofirmado o con una CA privada, otra vez sin desactivar la validación. Entre las dos, casi todo `TrustServerCertificate=true` real en una base de código puede reemplazarse por algo que sigue validando.

Otra trampa en la misma área: `SqlConnectionStringBuilder.Encrypt` cambió de tipo, de `bool` a `SqlConnectionEncryptOption`, en 5.0. Asignaciones como `builder.Encrypt = true` siguen compilando gracias a una conversión implícita, así que parece compatible a nivel de código fuente. Es un cambio disruptivo **binario**. Cualquier ensamblado que no recompiles contra el nuevo driver lanzará `MissingMethodException` en tiempo de ejecución. Si distribuyes una biblioteca compartida de acceso a datos, recompílala y vuelve a publicarla, no cambies solo el driver por debajo. La misma clase de error produce el [error Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0'](/es/2026/09/fix-could-not-load-file-or-assembly-microsoft-data-sqlclient-version-7-0-0-0/) cuando una copia 6.x obsoleta gana la restauración.

## Cuatro cosas más que muerden durante la migración

**La autenticación con Entra ahora necesita un segundo paquete.** En 7.0, olvidarlo produce un mensaje claro en lugar de un misterio, lo cual es una mejora real:

```text
System.ArgumentException: Cannot find an authentication provider for 'ActiveDirectoryDefault'.
Install the 'Microsoft.Data.SqlClient.Extensions.Azure' NuGet package to use
Active Directory (Entra ID) authentication methods.
```

Agrega `Microsoft.Data.SqlClient.Extensions.Azure` fijado a la misma versión que el driver principal. Desde 7.0.2 el driver principal y sus paquetes acompañantes usan números de versión alineados, así que `7.0.3` para ambos.

**Algunos tipos cambian de namespace, y no todos.** `SqlDataRecord` y `SqlMetaData` pasan de `Microsoft.SqlServer.Server` a `Microsoft.Data.SqlClient.Server`. `SqlFileStream` pasa de `System.Data.SqlTypes` a `Microsoft.Data.SqlTypes`. `SqlNotificationRequest` pasa de `System.Data.Sql` a `Microsoft.Data.Sql`. `OperationAbortedException` pasa de `System.Data` a `Microsoft.Data`. Pero los atributos de SQL CLR se quedan donde están: `SqlFunctionAttribute`, `SqlUserDefinedTypeAttribute`, `IBinarySerialize` y el resto están hoy en el ensamblado de `System.Data.SqlClient` y en un paquete `Microsoft.SqlServer.Server` aparte bajo el driver moderno, que es por lo que ese paquete aparece en la lista de transitivos. No hagas un buscar y reemplazar a ciegas sobre `System.Data`. `CommandType`, `DbType`, `IsolationLevel`, `DataTable` y todos los tipos de `System.Data.Common` se quedan exactamente donde están.

**Los parámetros de fecha y hora se comportan distinto.** `DbType.Time` con un valor `DateTime` lo aceptaba el driver viejo; el moderno quiere un `TimeSpan`. `DbType.Date` con un valor `DateTime` trunca los componentes de hora en lugar de enviarlos. Si tienes llamadas a `AddWithValue` alrededor de columnas de fecha, ahí es donde se esconde un cambio silencioso de comportamiento. Especifica `SqlDbType`, longitud, precisión y escala de forma explícita para todo lo que importe.

**El modo globalization-invariant no tiene soporte.** Si tu contenedor pone `InvariantGlobalization=true` para recortar arranque y tamaño, `Microsoft.Data.SqlClient` no tiene soporte en esa configuración. Esto muerde justo a los equipos que hacen el trabajo de recorte descrito arriba.

Y antes de declarar terminada la migración, ejecuta `dotnet list package --include-transitive`. Quitar tu referencia directa no quita la que arrastra un ORM viejo o un helper de SQL CLR. Dos paquetes de SqlClient en un mismo grafo compilan sin problema y luego fallan en el momento en que una `SqlConnection` de uno cruza a una API que espera la del otro, porque los nombres son idénticos y los tipos no.

## Qué línea de Microsoft.Data.SqlClient tomar

| Línea | Publicada | Soporte | Fin de soporte |
| --- | --- | --- | --- |
| 7.0 (`7.0.3`) | 2026-03-17 | STS | lo define la siguiente versión |
| 6.1 (`6.1.7`) | 2025-08-14 | **LTS** | 2028-08-14 |

Toma **7.0.3** para un servicio nuevo en .NET 11. Obtienes el paquete 10 MB más ligero, SSPI conectable vía `SspiContextProvider`, enrutamiento mejorado para Azure SQL Hyperscale y paridad de `SqlClientDiagnosticListener` en .NET Framework. Toma **6.1.7** si necesitas un compromiso de soporte con fecha por escrito, o si estás a mitad de migración y no puedes absorber ahora la división de `Extensions.Azure`. Ambos soportan SQL Server 2017 hasta 2025, Azure SQL y Fabric. Todo lo de 6.0 hacia abajo ya está fuera de soporte, incluida la línea LTS 5.1, que terminó el 2026-01-20.

La recomendación se mantiene como se dijo arriba: migra. El compilador ya te está avisando, la descripción del paquete ya dice obsoleto y el runtime al que apunta el paquete viejo llega al fin de soporte el día en que sale .NET 11. El trabajo es un cambio de paquete, una pasada de namespaces, una mirada seria a cada `Encrypt` y `TrustServerCertificate` de tu configuración, y una recompilación de cada ensamblado que toque `SqlConnectionStringBuilder`. Presupuesta un día para un servicio normal. Es un día mucho mejor que aquel en que un mandato de TLS 1.3 cae sobre un driver sin mantenimiento.

## Relacionado

- [Fix: Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0' después de actualizar EF Core](/es/2026/09/fix-could-not-load-file-or-assembly-microsoft-data-sqlclient-version-7-0-0-0/)
- [Migrar de .NET Framework 4.8 a .NET 11 en 2026](/es/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/)
- [Nivel de compatibilidad de SQL Server 150 vs 160: qué cambia para las consultas de EF Core 11](/es/2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries/)
- [Columna json nativa vs nvarchar(max) para almacenar JSON en SQL Server con EF Core 11](/es/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/)
- [Fix: EF Core MigrateAsync y CanConnectAsync siguen reintentando en 'Login failed for user' durante 60 segundos](/es/2026/09/fix-migrateasync-canconnectasync-keep-retrying-on-login-failed-for-user-ef-core/)

## Fuentes

- [Announcement: System.Data.SqlClient package is now deprecated](https://github.com/dotnet/announcements/issues/322), issue 322 de dotnet/announcements, con el plan escalonado de obsolescencia completo.
- [Migrate from System.Data.SqlClient to Microsoft.Data.SqlClient](https://learn.microsoft.com/en-us/sql/connect/ado-net/migrate-system-data-sql-client-to-microsoft-data-sql-client), MS Learn, actualizado el 2026-09-16.
- [Microsoft.Data.SqlClient namespace and compatibility](https://learn.microsoft.com/en-us/sql/connect/ado-net/introduction-microsoft-data-sqlclient-namespace), MS Learn.
- [SqlClient driver support lifecycle](https://learn.microsoft.com/en-us/sql/connect/ado-net/sqlclient-driver-support-lifecycle), MS Learn, para las tablas de soporte de 7.0 y 6.1.
- [Microsoft.Data.SqlClient 7.0.0 release notes](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.0.md), dotnet/SqlClient.
- [TDS 8.0](https://learn.microsoft.com/en-us/sql/relational-databases/security/networking/tds-8), MS Learn, para la relación entre `Encrypt=Strict` y TLS 1.3.
- [.NET 8 and .NET 9 will reach end of support on November 10, 2026](https://devblogs.microsoft.com/dotnet/dotnet-8-9-end-of-support/), .NET Blog.
- [System.Data.SqlClient en NuGet](https://www.nuget.org/packages/System.Data.SqlClient), versión 4.9.1, publicada el 2026-02-12.
