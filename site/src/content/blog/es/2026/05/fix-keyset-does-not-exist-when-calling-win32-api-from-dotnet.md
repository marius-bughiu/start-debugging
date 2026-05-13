---
title: "Solución: System.Security.Cryptography.CryptographicException: Keyset does not exist"
description: "La clave privada del certificado reside en un archivo de claves de Windows que la identidad del proceso no puede leer. Ajusta la ACL, carga el PFX con MachineKeySet o usa EphemeralKeySet."
pubDate: 2026-05-13
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "cryptography"
  - "x509"
  - "windows"
lang: "es"
translationOf: "2026/05/fix-keyset-does-not-exist-when-calling-win32-api-from-dotnet"
translatedBy: "claude"
translationDate: 2026-05-13
---

La solución: esto es `NTE_BAD_KEYSET` (HRESULT `0x80090016`) propagándose desde una llamada de criptografía Win32. El objeto del certificado que tienes en memoria contiene una clave pública, pero el **archivo de clave privada** en disco vive en una ubicación separada, y la identidad del proceso actual no tiene permiso de lectura sobre él, o ese archivo ya no existe para el perfil de usuario bajo el que se ejecuta. Tres resoluciones cubren casi todos los casos: otorga acceso de lectura a la identidad del proceso sobre la clave privada (complemento de certificados o `icacls` sobre el archivo del contenedor de claves), carga el PFX con `X509KeyStorageFlags.MachineKeySet | PersistKeySet` para que la clave acabe en el almacén de máquina, o carga el PFX con `EphemeralKeySet` para no necesitar archivo en disco.

```text
System.Security.Cryptography.CryptographicException: Keyset does not exist
   at System.Security.Cryptography.CryptographicException.ThrowCryptographicException(Int32 hr)
   at System.Security.Cryptography.X509Certificates.CertificatePal.GetPrivateKey[T](Func`2 createCsp, Func`2 createCng)
   at System.Security.Cryptography.X509Certificates.X509Certificate2.GetRSAPrivateKey()
   at MyApp.SigningService.Sign(Byte[] payload)
```

Esta guía se escribió contra .NET 11 preview 4 sobre Windows Server 2025 / Windows 11 24H2. El error ha sido idéntico desde .NET Framework 1.1 porque el mensaje viene literalmente de `NTE_BAD_KEYSET` en `winerror.h`. Lo que cambió en .NET moderno es el **comportamiento por defecto de almacenamiento de claves** cuando cargas un PFX: .NET 9 introdujo `X509CertificateLoader`, marcó como obsoletos los constructores `X509Certificate2(byte[])` y `new X509Certificate2(path, password)` para contenido PFX (`SYSLIB0057`), y cambió la ruta de carga recomendada. La nueva API **no** persiste silenciosamente las claves en disco como hacían los constructores antiguos. Si reemplazaste uno por otro de forma mecánica, el error que estás leyendo es la consecuencia.

Dos cosas que comprobar antes de aplicar cualquier solución a continuación. Primero, `certificate.HasPrivateKey` devuelve `true` incluso cuando el archivo de clave falta o no es accesible. La bandera registra si los **metadatos del certificado** anuncian una clave privada, no si efectivamente puedes abrirla. Segundo, el error es idéntico para un contenedor de claves ausente, un contenedor de claves en otro perfil de usuario y un contenedor de claves cuya ACL deniega tu proceso. El remedio depende de cuál de los tres tengas delante; las secciones siguientes los recorren en orden.

## Por qué un certificado tiene un archivo de claves siquiera

En Windows, un certificado X.509 es un documento público. La clave privada correspondiente nunca está en el archivo del certificado; vive en un contenedor de claves administrado por el proveedor criptográfico. Hay dos proveedores y dos ámbitos que conviene tener claros:

- **CAPI (Microsoft Cryptographic API)**: proveedor heredado, contenedores de claves almacenados en `%APPDATA%\Microsoft\Crypto\RSA\<SID>\` para el ámbito de usuario y `%ProgramData%\Microsoft\Crypto\RSA\MachineKeys\` para el ámbito de máquina. Cada contenedor es un único archivo con un nombre similar a un GUID.
- **CNG (Cryptography Next Generation)**: proveedor moderno, contenedores de claves en `%APPDATA%\Microsoft\Crypto\Keys\` y `%ProgramData%\Microsoft\Crypto\Keys\` respectivamente.

Cuando importas un PFX, el cargador escribe el certificado al **almacén de certificados Personal** (`Cert:\CurrentUser\My` o `Cert:\LocalMachine\My`) y el material de la clave en uno de esos cuatro directorios, según `X509KeyStorageFlags`. Sacar el certificado del almacén y meterlo en un `X509Certificate2` solo recupera la parte pública más un puntero al contenedor de claves. La primera vez que llamas a `GetRSAPrivateKey()`, `GetECDsaPrivateKey()` o a la propiedad obsoleta `PrivateKey`, el runtime abre ese contenedor mediante la API Win32 correspondiente. Si el archivo no está, el SID no tiene una ACE de lectura o la ruta apunta a un perfil que no existe en la sesión de inicio actual, obtienes `NTE_BAD_KEYSET`.

La conclusión es que el certificado y la clave están desacoplados, y la pregunta "¿tiene este proceso la clave privada?" es en realidad "¿tiene esta identidad de proceso acceso de lectura al archivo referenciado por este certificado?". Cada solución a continuación responde a esa pregunta de una forma distinta.

## Reproducción mínima

El programa más corto que reproduce el error tras cambiar al cargador de .NET 9+:

```csharp
// .NET 11 preview 4, Windows 11 24H2
using System.Security.Cryptography.X509Certificates;

var bytes = File.ReadAllBytes("signing.pfx");
var cert = X509CertificateLoader.LoadPkcs12(bytes, password: "test");

using var rsa = cert.GetRSAPrivateKey();
var signature = rsa!.SignData("hello"u8.ToArray(), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
```

Ejecuta esto desde una sesión interactiva de escritorio y funciona. Ejecuta el mismo binario como servicio de Windows bajo `NT SERVICE\MyService`, o desde un grupo de aplicaciones de IIS con `LoadUserProfile = false`, y `GetRSAPrivateKey()` lanza "Keyset does not exist". El PFX se cargó bien. El objeto del certificado se construyó. El fallo ocurre en el momento exacto en que intentas obtener la clave privada.

La razón: `X509CertificateLoader.LoadPkcs12` usa por defecto `X509KeyStorageFlags.DefaultKeySet`, lo que en Windows significa el almacén de claves de **usuario**. Una identidad de servicio sin un perfil de usuario cargado no tiene `%APPDATA%\Microsoft\Crypto\...` donde escribir, por lo que el archivo de clave se crea en una ubicación temporal inalcanzable en la siguiente llamada, o no se crea en absoluto.

## Solución 1: otorgar acceso de lectura a la identidad actual sobre la clave

Esta es la solución correcta cuando el certificado ya está instalado en el almacén de máquina y no controlas el código de importación (típico para servidores administrados por operaciones). Abre `certlm.msc` (LocalMachine) o `certmgr.msc` (CurrentUser), localiza el certificado en **Personal > Certificados**, haz clic derecho, **Todas las tareas > Administrar claves privadas**, y añade la identidad del proceso con permiso de **Lectura**.

La misma operación desde PowerShell, automatizada para un grupo de aplicaciones de IIS:

```powershell
# Windows 11 24H2 / Windows Server 2025, PowerShell 7.5
$cert = Get-ChildItem Cert:\LocalMachine\My | Where-Object Thumbprint -eq 'AABBCC...'
$keyFile = $cert.PrivateKey.Key.UniqueName  # CNG

$keyPath = Join-Path $env:ProgramData "Microsoft\Crypto\Keys\$keyFile"
$acl = Get-Acl $keyPath
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    'IIS APPPOOL\MyAppPool', 'Read', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl $keyPath $acl
```

Para certificados CAPI, sustituye `Crypto\Keys` por `Crypto\RSA\MachineKeys` y lee `cert.PrivateKey.CspKeyContainerInfo.UniqueKeyContainerName` en su lugar. El cmdlet `Get-PfxCertificate` parece tentador aquí pero no devuelve el certificado vivo del almacén; usa `Get-ChildItem Cert:\...` para que la propiedad `PrivateKey` apunte al contenedor en disco.

Para un servicio de Windows que corre bajo `NT SERVICE\<NombreServicio>`, el SID es virtual y lo otorgas con `icacls`:

```powershell
icacls $keyPath /grant "NT SERVICE\MyService:R"
```

Si no sabes bajo qué SID corre tu proceso, `whoami /user` desde una línea de comandos lanzada con esa identidad lo imprime. Para servicios de Windows en contenedores, `nt authority\system` y `nt authority\network service` son los sospechosos habituales.

## Solución 2: cargar el PFX con las banderas de almacenamiento de claves correctas

Esta es la solución correcta cuando tu aplicación posee el archivo del certificado y lo carga al arranque. Deja de depender de `DefaultKeySet` y sé explícito:

```csharp
// .NET 11 preview 4, long-running service that needs the key to survive restarts
var cert = X509CertificateLoader.LoadPkcs12FromFile(
    "signing.pfx",
    password: "test",
    keyStorageFlags: X509KeyStorageFlags.MachineKeySet
                   | X509KeyStorageFlags.PersistKeySet
                   | X509KeyStorageFlags.Exportable);
```

`MachineKeySet` escribe la clave en `%ProgramData%\Microsoft\Crypto\Keys` (CNG) bajo una ACL que la identidad del servicio puede leer. `PersistKeySet` mantiene el archivo en disco después de que se desecha el `X509Certificate2`; sin él, el comportamiento por defecto desde .NET Framework 4.7.2 es eliminar la clave en el momento en que el objeto del certificado sale del ámbito, lo que produce "Keyset does not exist" en la **segunda** llamada a la misma ruta de código. `Exportable` es opcional y solo se necesita si más tarde llamas a `ExportPkcs8PrivateKey` o escribes la clave a un almacén distinto. Nota: `PersistKeySet` y `EphemeralKeySet` son mutuamente exclusivos; pasar ambos lanza `CryptographicException` desde `X509CertificateLoader`.

Para una aplicación .NET 11 alojada donde solo necesitas la clave en el proceso y nunca quieres un archivo en disco, usa `EphemeralKeySet` y olvídate del problema de la persistencia:

```csharp
// .NET 11 preview 4, ASP.NET Core minimal API loading a cert from configuration
var cert = X509CertificateLoader.LoadPkcs12FromFile(
    path,
    password,
    keyStorageFlags: X509KeyStorageFlags.EphemeralKeySet);
```

`EphemeralKeySet` es la elección más robusta para contenedores, cargas con escalado a cero y cualquier entorno donde el perfil de usuario pueda faltar o reciclarse. La clave vive solo dentro de la instancia `X509Certificate2`; una vez que la desechas, la clave desaparece. El compromiso es que el certificado no es importable al almacén de Windows después, y en .NET Framework anterior a 4.7.2 / .NET Core anterior a 2.0 la bandera no existía. En Linux y macOS es una no-op porque no hay archivo de claves de Windows en primer lugar.

## Solución 3: peculiaridades de identidad de grupo de aplicaciones de IIS y de servicio de Windows

Los grupos de aplicaciones de IIS son la fuente individual más común de este error. Dos ajustes determinan si la búsqueda de tu clave privada funciona:

- **Cargar perfil de usuario**: en `applicationHost.config` o en el Administrador de IIS, bajo **Configuración avanzada** del grupo de aplicaciones, pon **Cargar perfil de usuario** a `True`. Sin esto, la identidad `IIS APPPOOL\MyAppPool` no tiene `%APPDATA%`, por lo que cualquier ruta de código que use por defecto `UserKeySet` o `DefaultKeySet` falla en la segunda llamada.
- **Modelo de proceso > Identidad**: déjalo en `ApplicationPoolIdentity` y otorga al SID virtual `IIS APPPOOL\MyAppPool` acceso de lectura sobre el archivo de clave (Solución 1). No corras grupos de aplicaciones como `LocalSystem` para "evitar" esto; eso es una escalada de privilegios real, no una solución.

Para servicios de Windows escritos con la [plantilla de servicio hospedado de .NET 11](/es/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) más `Microsoft.Extensions.Hosting.WindowsServices`, la configuración equivalente es registrar el servicio con su propia cuenta virtual:

```powershell
sc.exe create MyService binPath= "C:\svc\MyService.exe" obj= "NT SERVICE\MyService" start= auto
icacls "C:\ProgramData\Microsoft\Crypto\Keys\<keyfile>" /grant "NT SERVICE\MyService:R"
```

Evita ejecutar servicios bajo `LocalSystem` por la misma razón que los grupos de aplicaciones: también otorga lectura sobre cualquier otra clave de máquina en el host. El principio de menor privilegio se aplica a los contenedores de criptografía igual que a las rutas de archivo.

## Solución 4: Azure App Service, Azure Functions, contenedores

Los hosts en la nube sufren una versión más afilada de este problema porque el sistema de archivos subyacente no es tuyo. Tres mandos específicos de plataforma:

- **Azure App Service**: sube el PFX/PEM a **TLS/SSL settings > Private Key Certificates**, y luego configura el ajuste de aplicación `WEBSITE_LOAD_CERTIFICATES` a `*` o a la huella digital del certificado. El sandbox de App Service rechaza cargar la clave privada salvo que esa variable incluya la huella en una lista permitida; sin esto obtienes "Keyset does not exist" en cuanto llamas a `GetRSAPrivateKey()`. El ajuste `WEBSITE_LOAD_USER_PROFILE = 1` es el equivalente en App Service de **Cargar perfil de usuario** de IIS y se requiere si tu código resuelve a claves de usuario.
- **Azure Functions (Windows consumption / Premium)**: mismo requisito de `WEBSITE_LOAD_CERTIFICATES`. Para funciones de worker aislado, prefiere cargar el certificado desde `cert:\CurrentUser\My` antes que leer un PFX desde `D:\home\site\wwwroot`, porque esa ruta PFX es de solo lectura y `PersistKeySet` fallará silenciosamente.
- **Contenedores Linux (incluyendo planes Linux App Service y AKS)**: no hay archivo de claves de Windows, así que `X509KeyStorageFlags` distintas de `EphemeralKeySet` se ignoran efectivamente. El error que verás en imágenes `dotnet publish` no es "Keyset does not exist" sino `PlatformNotSupportedException` si recurres a `CspParameters` o al setter `PrivateKey = ...`. Usa la API moderna `CopyWithPrivateKey` y `EphemeralKeySet` y el código será portable.

Para [funciones AWS Lambda en .NET 11](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/), aplica la misma lógica que para los contenedores Linux: no hay almacén de claves de Windows, carga el PFX con `EphemeralKeySet` desde una capa Lambda o Secrets Manager, nunca desde `/tmp` entre invocaciones, porque el sandbox no garantiza que `/tmp` sobreviva entre arranques en frío.

## Solución 5: leer la clave con la API moderna, no con `PrivateKey`

La propiedad `X509Certificate2.PrivateKey` aún existe en .NET 11 pero está obsoleta (`SYSLIB0028` para el setter, `SYSLIB0058` para el getter en claves EC). Devuelve un `AsymmetricAlgorithm` que internamente llama a CAPI, incluso cuando el certificado se importó como CNG, y la capa de compatibilidad de CAPI es la que más fiablemente lanza "Keyset does not exist" cuando falta el contenedor de claves. Los accesos modernos hacen una comprobación adicional antes de abrir el archivo y exponen excepciones más claras:

```csharp
// .NET 11 preview 4
using var rsa = cert.GetRSAPrivateKey();
using var ecdsa = cert.GetECDsaPrivateKey();
using var dsa = cert.GetDSAPrivateKey();
```

Si `HasPrivateKey` es `true` pero `GetRSAPrivateKey()` devuelve `null`, el certificado usa un algoritmo no-RSA; prueba `GetECDsaPrivateKey()` en su lugar. Si `GetRSAPrivateKey()` lanza "Keyset does not exist", los metadatos afirman que existe una clave, el archivo no, y aplica una de las Soluciones 1 a 4.

## Trampas y errores parecidos

- **`X509CertificateLoader` no es opcional en .NET 11.** El antiguo constructor `new X509Certificate2(path, password)` está marcado con `SYSLIB0057` y se eliminará en una futura versión. Migra ahora y revisa tus elecciones de `X509KeyStorageFlags`, porque los valores por defecto del cargador son más estrictos.
- **`HasPrivateKey` miente.** Comprueba la extensión `keyUsage` del certificado y la presencia de un `CERT_KEY_PROV_INFO_PROP_ID`, no si el archivo bajo `Crypto\Keys` se abre limpiamente. Prueba recuperando realmente la clave, captura `CryptographicException` y trátalo como "sin clave", en lugar de ramificar sobre `HasPrivateKey`.
- **"Access is denied" es el error primo.** Misma causa raíz (ACL faltante), distinto camino de código: CAPI heredado devuelve `NTE_BAD_KEYSET`, CNG moderno a veces devuelve `0x80090010 NTE_PERM` que aparece como `CryptographicException: Access is denied`. La solución es idéntica; el resultado de búsqueda es distinto.
- **El PFX está bien; la referencia del almacén está obsoleta.** Si importaste un PFX, lo eliminaste de `Cert:\LocalMachine\My` y lo re-importaste, la ruta del archivo de clave dentro de los metadatos del certificado puede apuntar al contenedor antiguo (eliminado). Exporta, elimina por completo (con `Remove-Item Cert:\LocalMachine\My\<thumbprint>` más `certutil -delstore`) y re-importa.
- **`SqlClient` y `X509Chain.Build()` lanzan la misma excepción.** Ambos llaman a `GetRSAPrivateKey()` por debajo al validar cadenas o firmar cadenas de conexión. Una conexión SQL fallando con autenticación por certificado con este mensaje es el mismo bug que un firmante de JWT fallando con él; el [modo de fallo `SqlException: Timeout expired`](/es/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) no está relacionado.
- **Desajustes CryptoAPI vs CNG.** Importar un PFX generado por CAPI a través de CNG (o al revés) a veces deja la clave en un proveedor con metadatos apuntando al otro. `certutil -repairstore My <thumbprint>` reconstruye el enlace sin re-importar.
- **El perfil de usuario no está cargado.** Tareas programadas, grupos de aplicaciones de IIS sin `LoadUserProfile` y contenedores Docker de Windows ejecutándose como `ContainerUser` comparten esta característica. O activas el ajuste del perfil, o cambias a claves de máquina, o usas `EphemeralKeySet`.

## Relacionado

- [Solución: System.IO.FileNotFoundException: Could not load file or assembly](/es/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) cubre la otra mitad de los errores de despliegue "funciona en mi máquina", donde el problema es el binario y no la clave.
- [Solución: PlatformNotSupportedException en Native AOT](/es/2026/05/fix-platformnotsupportedexception-in-native-aot/) es lo que ves si publicas una aplicación Native AOT y llamas directamente a `new RSACryptoServiceProvider()`; el compilador AOT recorta la capa de compatibilidad de CAPI por completo.
- [Cómo implementar refresh tokens en ASP.NET Core Identity](/es/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) muestra la fontanería circundante para la razón más común por la que cargas una clave privada: firmar JWTs en un proveedor de identidad alojado.
- [Cómo reducir el tiempo de arranque en frío de un AWS Lambda en .NET 11](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) discute la carga de certificados en entornos serverless, donde `EphemeralKeySet` es la única bandera de almacenamiento de claves que hace lo correcto.
- [Cómo configurar registro estructurado con Serilog y Seq en .NET 11](/es/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) es útil para rastrear el momento exacto en que el acceso a la clave falla en un servicio en producción, ya que las operaciones de `X509Certificate2` no registran nada por defecto.

## Fuentes

- [`X509KeyStorageFlags` Enum, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.x509keystorageflags)
- [`X509CertificateLoader` class, .NET 9+, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.x509certificateloader)
- [`SYSLIB0057`: Obsolete X509Certificate2 PFX constructors](https://learn.microsoft.com/en-us/dotnet/fundamentals/syslib-diagnostics/syslib0057)
- [Private Key Lifetime on Windows, January 2021 .NET Framework rollup, Microsoft Support](https://support.microsoft.com/en-us/topic/private-key-lifetime-on-windows-and-the-january-2021-net-framework-security-and-quality-rollup-3f097a10-f798-4ffd-8511-4757ebaf2c70)
- [`dotnet/runtime` issue 67752: occasional "Keyset does not exist" with `GetRSAPrivateKey` on Windows](https://github.com/dotnet/runtime/issues/67752)
- [`dotnet/aspnetcore` issue 3218: Data Protection "Keyset does not exist" even with PrivateKey set programmatically](https://github.com/dotnet/aspnetcore/issues/3218)
- [Load certificates in Azure App Service, MS Learn](https://learn.microsoft.com/en-us/azure/app-service/configure-ssl-certificate-in-code)
