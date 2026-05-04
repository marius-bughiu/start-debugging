---
title: "Cómo empaquetar una aplicación .NET MAUI para la Microsoft Store"
description: "Guía completa para empaquetar una aplicación .NET MAUI 11 para Windows como MSIX, agrupar x64/x86/ARM64 en un .msixupload y enviarla a través de Partner Center: reserva de identidad, Package.appxmanifest, banderas de dotnet publish, agrupación con MakeAppx y la entrega del certificado de confianza de la Store."
pubDate: 2026-05-04
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "windows"
  - "msix"
  - "microsoft-store"
  - "partner-center"
  - "how-to"
lang: "es"
translationOf: "2026/05/how-to-package-a-maui-app-for-the-microsoft-store"
translatedBy: "claude"
translationDate: 2026-05-04
---

Respuesta corta: reserva primero el nombre de la app en Partner Center, copia los valores de Identity generados a `Platforms/Windows/Package.appxmanifest`, configura `WindowsPackageType=MSIX` y `AppxPackageSigningEnabled=true` en tu `.csproj`, luego ejecuta `dotnet publish -f net10.0-windows10.0.19041.0 -c Release -p:RuntimeIdentifierOverride=win-x64` una vez por cada arquitectura que quieras distribuir. Combina los archivos `.msix` resultantes con `MakeAppx.exe bundle` en un único `.msixbundle`, envuelve eso en un `.msixupload` (un zip simple con el bundle y su bundle de símbolos), y súbelo como el paquete de un envío en Partner Center. La Store vuelve a firmar tu bundle con su propio certificado, así que el `PackageCertificateThumbprint` local solo necesita ser de confianza en tu máquina de compilación.

Esta guía recorre la pipeline completa para .NET MAUI 11.0.0 sobre .NET 11, Windows App SDK 1.7 y el flujo de envío de Partner Center tal como está en mayo de 2026. Todo lo que sigue se validó contra `dotnet new maui` desde el SDK de .NET 11.0.100, con `Microsoft.WindowsAppSDK` 1.7.250401001 y `Microsoft.Maui.Controls` 11.0.0. Las diferencias con consejos previos de .NET 8 y .NET 9 se señalan donde la receta cambia.

## Por qué dejó de funcionar "solo dale a Publicar"

El asistente de publicación de MAUI en Visual Studio incluye un destino "Microsoft Store", pero no ha producido un `.msixupload` aceptable por la Store en ninguna versión de MAUI desde .NET 6. El asistente genera un único `.msix` de una sola arquitectura y se detiene ahí, lo que significa que las subidas o fallan la validación de Partner Center directamente (cuando tu envío anterior estaba agrupado) o te encierran silenciosamente en una sola arquitectura para toda la vida del listado. El equipo de MAUI ha rastreado este vacío como [dotnet/maui#22445](https://github.com/dotnet/maui/issues/22445) desde 2024 y la corrección no ha llegado en MAUI 11. La CLI es la ruta soportada.

La segunda razón por la que el asistente engaña es la identidad. El `.msix` que produce está firmado con el certificado local que le hayas indicado, pero un envío a la Store requiere que el elemento `Identity` de tu app (`Name`, `Publisher` y `Version`) coincida exactamente con los valores que Partner Center reservó para ti. Si el manifiesto dice `CN=DevCert` y Partner Center espera `CN=4D2D9D08-...`, la subida falla con un código de error genérico estilo 12345 que no nombra el campo culpable. Reservar el nombre primero y pegar los valores de Partner Center en el manifiesto antes de compilar es la única forma de evitar ese bucle.

La buena noticia: una vez que tienes el manifiesto correcto, los comandos de la CLI son estables entre .NET 8, 9, 10 y 11. Solo cambió la forma del runtime identifier: `win10-x64` se retiró en .NET 10 a favor del portable `win-x64`, según [NETSDK1083](https://learn.microsoft.com/en-us/dotnet/core/tools/sdk-errors/netsdk1083). Todo lo demás es la misma invocación de `MSBuild` que envió Xamarin en 2020.

## Paso 1: Reserva el nombre y obtén los valores de identidad

Inicia sesión en [Partner Center](https://partner.microsoft.com/dashboard/apps-and-games/overview) y crea una nueva app. Reserva el nombre. Abre **Identidad del producto** (o **Administración de la app > Identidad de la app** dependiendo de la versión del panel que veas); necesitas tres cadenas:

- **Package/Identity Name**, por ejemplo `12345Contoso.MyMauiApp`.
- **Package/Identity Publisher**, la cadena larga `CN=...` que Microsoft te asigna, por ejemplo `CN=4D2D9D08-7BAC-4F2C-9D32-2A2F3C9F0E4A`.
- **Package/Publisher display name**, la versión legible que aparece en el listado de la Store.

Estos tres valores deben aterrizar literalmente en `Platforms/Windows/Package.appxmanifest`. La plantilla de MAUI envía un manifiesto de marcador de posición con `Name="maui-package-name-placeholder"`, que el sistema de compilación normalmente reescribe desde tu `.csproj`. Para compilaciones de la Store, sobrescríbelo explícitamente para que el elemento `Identity` sobreviva a la compilación.

```xml
<!-- Platforms/Windows/Package.appxmanifest, .NET MAUI 11 -->
<Identity
    Name="12345Contoso.MyMauiApp"
    Publisher="CN=4D2D9D08-7BAC-4F2C-9D32-2A2F3C9F0E4A"
    Version="1.0.0.0" />

<Properties>
  <DisplayName>My MAUI App</DisplayName>
  <PublisherDisplayName>Contoso</PublisherDisplayName>
  <Logo>Images\StoreLogo.png</Logo>
</Properties>
```

El `Version` aquí usa el esquema Win32 de cuatro partes (`Major.Minor.Build.Revision`) y Partner Center trata el cuarto segmento como reservado: debe ser `0` para cualquier envío a la Store. Si codificas números de build de CI en la versión, ponlos en el tercer segmento.

Mientras estás en el manifiesto, configura `<TargetDeviceFamily>` a `Windows.Desktop` con un `MinVersion` de `10.0.17763.0` (el piso para Windows App SDK 1.7) y un `MaxVersionTested` que coincida con lo que realmente probaste. Establecer `MaxVersionTested` demasiado alto hace que Partner Center marque el envío para certificación adicional; demasiado bajo hace que Windows se niegue a instalar en versiones más recientes del sistema.

## Paso 2: Configura el proyecto para compilaciones MSIX

Las propiedades de `.csproj` siguientes reemplazan toda la guía "Configurar proyecto para MSIX" de la documentación de Visual Studio. Agrega este bloque una vez y olvídate de él.

```xml
<!-- MyMauiApp.csproj, .NET MAUI 11.0.0 on .NET 11 -->
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'windows' and '$(Configuration)' == 'Release'">
  <WindowsPackageType>MSIX</WindowsPackageType>
  <AppxPackage>true</AppxPackage>
  <AppxPackageSigningEnabled>true</AppxPackageSigningEnabled>
  <GenerateAppxPackageOnBuild>true</GenerateAppxPackageOnBuild>
  <AppxAutoIncrementPackageRevision>False</AppxAutoIncrementPackageRevision>
  <AppxSymbolPackageEnabled>true</AppxSymbolPackageEnabled>
  <AppxBundle>Never</AppxBundle>
  <PackageCertificateThumbprint>AA11BB22CC33DD44EE55FF66AA77BB88CC99DD00</PackageCertificateThumbprint>
</PropertyGroup>

<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'windows' and '$(RuntimeIdentifierOverride)' != ''">
  <RuntimeIdentifier>$(RuntimeIdentifierOverride)</RuntimeIdentifier>
</PropertyGroup>
```

Dos de estas propiedades no son obvias.

`AppxBundle=Never` parece incorrecto porque la Store quiere un bundle, pero la compilación de .NET MAUI solo sabe producir un único `.msix` de una sola arquitectura por invocación de `dotnet publish`. Establecer `AppxBundle=Always` aquí provoca que la compilación intente la generación de bundle al estilo UWP contra un proyecto no UWP y emite el críptico error `The target '_GenerateAppxPackage' does not exist in the project` rastreado en [dotnet/maui#17680](https://github.com/dotnet/maui/issues/17680). Compilas por arquitectura y haces el bundle tú mismo en el siguiente paso.

`AppxSymbolPackageEnabled=true` produce un `.appxsym` junto a cada `.msix`. El `.msixupload` que envías es un zip cuyo contenido es el bundle más un bundle de símbolos hermano, y Partner Center elimina silenciosamente la analítica de fallos si falta cualquiera de los dos lados. No te avisa; simplemente obtienes trazas de pila vacías en el panel de Salud seis semanas después.

El segundo `<PropertyGroup>` es un workaround para [WindowsAppSDK#3337](https://github.com/microsoft/WindowsAppSDK/issues/3337), que ha estado abierto desde que el proyecto se mudó a GitHub y no muestra señales de cerrarse. Sin él, `dotnet publish` selecciona el RID implícito antes de que el target MSIX lo lea, y el paquete resultante apunta a la arquitectura del host de compilación en lugar de la que pasaste en la línea de comandos.

El `PackageCertificateThumbprint` solo importa para instalaciones por sideload. Partner Center vuelve a firmar tu bundle con el certificado asociado a tu cuenta de publisher, así que un certificado autofirmado está bien para envíos a la Store. Genera uno con `New-SelfSignedCertificate -Type Custom -Subject "CN=Contoso" -KeyUsage DigitalSignature -CertStoreLocation "Cert:\CurrentUser\My" -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")`, copia el thumbprint al archivo del proyecto y confía en el certificado en el almacén **Personas de confianza** en cualquier máquina donde hagas sideload antes de que el listado de la Store esté activo.

## Paso 3: Compila un MSIX por arquitectura

La Store acepta x64 y ARM64 hoy, además de una compilación opcional x86 para la larga cola de PCs antiguos. Ejecuta `dotnet publish` una vez por arquitectura, desde un **Símbolo del sistema para desarrolladores de Visual Studio** para que las herramientas del SDK de Windows estén en `PATH`.

```powershell
# .NET MAUI 11.0.0 on .NET 11, Windows App SDK 1.7
$tfm = "net10.0-windows10.0.19041.0"
$project = "src\MyMauiApp\MyMauiApp.csproj"

foreach ($rid in @("win-x64", "win-x86", "win-arm64")) {
    dotnet publish $project `
        -f $tfm `
        -c Release `
        -p:RuntimeIdentifierOverride=$rid
}
```

Después de que terminen las tres ejecuciones, los paquetes por arquitectura aterrizan en:

```
src\MyMauiApp\bin\Release\net10.0-windows10.0.19041.0\win-x64\AppPackages\MyMauiApp_1.0.0.0_Test\MyMauiApp_1.0.0.0_x64.msix
src\MyMauiApp\bin\Release\net10.0-windows10.0.19041.0\win-x86\AppPackages\MyMauiApp_1.0.0.0_Test\MyMauiApp_1.0.0.0_x86.msix
src\MyMauiApp\bin\Release\net10.0-windows10.0.19041.0\win-arm64\AppPackages\MyMauiApp_1.0.0.0_Test\MyMauiApp_1.0.0.0_arm64.msix
```

Cada carpeta contiene también un bundle de símbolos `.appxsym`. Copia los seis artefactos a una carpeta de staging plana para que el paso de bundling pueda operar sobre un único directorio.

```powershell
$staging = "artifacts\msix"
New-Item -ItemType Directory -Force -Path $staging | Out-Null

Get-ChildItem -Recurse -Include *.msix, *.appxsym `
    -Path "src\MyMauiApp\bin\Release\$tfm" |
    Copy-Item -Destination $staging
```

Tu log de `dotnet build` reportará `package version 1.0.0.0` para cada arquitectura. Deben coincidir exactamente, de lo contrario `MakeAppx.exe bundle` rechaza el conjunto de entrada con `error 0x80080204: The package family is invalid`.

## Paso 4: Agrupa las arquitecturas en un `.msixbundle`

`MakeAppx.exe` viene con el SDK de Windows 11 en `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makeappx.exe`. Las versiones más nuevas del SDK se instalan en paralelo; elige la que coincida con tu `MaxVersionTested`.

```powershell
$makeappx = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makeappx.exe"
$version = "1.0.0.0"

& $makeappx bundle `
    /bv $version `
    /d $staging `
    /p "artifacts\MyMauiApp_${version}_x86_x64_arm64.msixbundle"
```

El switch `/d` le dice a `MakeAppx` que ingiera cada `.msix` de la carpeta y produzca un bundle gordo cuyo mapa de arquitecturas cubra las tres. El valor `/bv` (bundle version) debe ser igual al `Version` del `Package.appxmanifest`; los desajustes hacen que Partner Center rechace el envío con `package version mismatch`.

Ejecuta una segunda pasada para agrupar los archivos de símbolos:

```powershell
& $makeappx bundle `
    /bv $version `
    /d $staging `
    /p "artifacts\MyMauiApp_${version}_x86_x64_arm64.appxsymbundle"
```

`MakeAppx` deduce la extensión del archivo del conjunto de entrada y omite los archivos `.msix` cuando agrupa símbolos. Si olvidas el bundle de símbolos, la subida igual tiene éxito, pero los Reportes de Salud quedan vacíos.

## Paso 5: Empaqueta como `.msixupload`

Un `.msixupload` es solo un zip con una extensión específica. Partner Center detecta automáticamente los archivos hermanos de bundle y bundle de símbolos dentro de él.

```powershell
$upload = "artifacts\MyMauiApp_${version}_x86_x64_arm64.msixupload"

Compress-Archive `
    -Path "artifacts\MyMauiApp_${version}_x86_x64_arm64.msixbundle", `
          "artifacts\MyMauiApp_${version}_x86_x64_arm64.appxsymbundle" `
    -DestinationPath ($upload -replace '\.msixupload$', '.zip') -Force

Move-Item -Force ($upload -replace '\.msixupload$', '.zip') $upload
```

PowerShell 5.1 se niega a escribir una extensión que no sea `.zip` directamente con `Compress-Archive`, por eso el snippet escribe primero un `.zip` y lo renombra. PowerShell 7.4+ acepta la extensión directamente.

## Paso 6: Sube a través de Partner Center

Abre tu app reservada en Partner Center, haz clic en **Iniciar tu envío**, salta a la sección **Paquetes** y suelta el `.msixupload`. Partner Center valida el paquete al instante y muestra problemas en tres categorías:

- **Desajuste de identidad.** El `Identity Name` o `Publisher` en tu manifiesto no coincide con los valores que Partner Center reservó. Abre la página **Identidad del producto** del panel junto a `Package.appxmanifest`, corrige el manifiesto, recompila, vuelve a hacer el bundle y vuelve a subir. No edites el zip `.msixupload` directamente; el bundle está firmado y el ciclo descomprimir-editar-recomprimir invalida la firma.
- **Capacidades.** Cualquier `<Capability>` que declares mapea a una categoría de la Store que puede requerir certificación adicional. `runFullTrust` (que MAUI establece implícitamente porque las apps de escritorio Win32 lo necesitan) está aprobada para cuentas normales de la Store; `extendedExecutionUnconstrained` y capacidades similares requieren revisión adicional.
- **Versión mínima.** Si `MinVersion` en `<TargetDeviceFamily>` es más antiguo que la versión más baja de Windows que la Store soporta actualmente (10.0.17763.0 a mayo de 2026), el paquete es rechazado. La solución es elevarlo en el manifiesto, no bajar el SDK.

Una vez que la validación pasa, completa los metadatos del listado, la clasificación por edad y el precio como lo harías para cualquier otra app de la Store. La primera revisión normalmente se completa en 24-48 horas; las actualizaciones a apps existentes generalmente se aprueban en menos de 12.

## Cinco gotchas que te van a comer una tarde

**1. El primer envío decide bundle vs MSIX único para siempre.** Si alguna vez subes un único `.msix` para un listado, todo envío futuro también debe ser un único `.msix`; no puedes promover un listado existente a un bundle, y no puedes degradar un bundle a un `.msix` único. Decide desde el principio y quédate con bundles aunque hoy solo distribuyas una arquitectura.

**2. El `Package Family Name` en Partner Center no es lo mismo que el `Identity Name`.** El PFN es `Identity.Name + "_" + primeros 13 caracteres del hash del Publisher`, y Windows lo deriva automáticamente. Si copias el PFN al `Identity.Name` del manifiesto, la subida falla con el engañoso error "package identity does not match" documentado en [dotnet/maui#32801](https://github.com/dotnet/maui/issues/32801).

**3. Windows App SDK es una dependencia de framework, no un redistribuible que envías.** La Store instala el paquete `Microsoft.WindowsAppRuntime.1.7` correspondiente automáticamente siempre que uses la referencia `WindowsAppSDK` dependiente del framework de la plantilla MAUI. Si cambias a self-contained, el MSIX resultante es 80MB más grande y Partner Center lo rechaza por exceder el presupuesto de tamaño por arquitectura del nivel gratuito de la Store.

**4. Los nombres de proyecto con guiones bajos rompen MakeAppx.** Un `.csproj` llamado `My_App.csproj` produce paquetes cuyos nombres de archivo contienen guiones bajos en posiciones donde `MakeAppx bundle` los interpreta como separadores de versión, lo que falla con `error 0x80080204`. Renombra el proyecto para usar guiones, o agrega `<AssemblyName>MyApp</AssemblyName>` para sobrescribir el nombre de salida. Esto se rastrea en [dotnet/maui#26486](https://github.com/dotnet/maui/issues/26486).

**5. El sufijo `Test` es real.** La carpeta `AppPackages\MyMauiApp_1.0.0.0_Test` se llama así porque `dotnet publish` por defecto produce certificados de prueba. El `.msix` dentro de la carpeta está bien para la Store; solo el nombre de la carpeta es engañoso. Copia el `.msix`, ignora el directorio `_Test` y sigue adelante.

## Dónde encaja esto en una pipeline de CI

Nada en esta pipeline requiere Visual Studio. Un runner limpio de GitHub Actions `windows-latest` con el SDK de .NET 11 y el workload de MAUI instalados produce el mismo `.msixupload` desde estos comandos. El único material sensible es el thumbprint del certificado de firma y el PFX, ambos caben en secretos del repositorio. Después de la subida, la [API de envíos de Microsoft Store](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services) te permite empujar el mismo artefacto directamente a un envío en borrador sin tocar el panel, lo que cierra el ciclo de un release totalmente automatizado.

Si estás eliminando frameworks móviles de destino del mismo proyecto para que la compilación de Windows no arrastre también workloads de Android e iOS, la [configuración de MAUI 11 solo para Windows y macOS](/es/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) cubre las reescrituras de `<TargetFrameworks>` que necesitas antes de que cualquiera de los comandos de publish de arriba funcione limpiamente. Para el lado del Manifest Designer del `Package.appxmanifest` y el pequeño conjunto de configuraciones de tema que la Store lee, [soportar modo oscuro en una app MAUI](/es/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) recorre las claves de recurso que aparecen en el generador de capturas del listado. Si tu listado de la Store muestra una página de Maps, el [recorrido de clustering de pines de mapa de MAUI 11](/2026/04/dotnet-maui-11-map-pin-clustering/) cubre la capacidad `MapsKey` que necesitas declarar en el manifiesto antes de que el equipo de certificación apruebe la app. Y para un recorrido más amplio de lo nuevo en el framework que se envía en tu bundle, [novedades de .NET MAUI 10](/2025/04/whats-new-in-net-maui-10/) es lo más cercano a un pilar de notas de versión que tiene la documentación.

## Enlaces de fuentes

- [Use the CLI to publish packaged apps for Windows - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/windows/deployment/publish-cli?view=net-maui-10.0)
- [Publish a .NET MAUI app for Windows (overview)](https://learn.microsoft.com/en-us/dotnet/maui/windows/deployment/overview?view=net-maui-10.0)
- [App manifest schema reference](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/root-elements)
- [Create a certificate for package signing](https://learn.microsoft.com/en-us/windows/msix/package/create-certificate-package-signing)
- [MakeAppx.exe tool reference](https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool)
- [Microsoft Store Submission API](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)
- [WindowsAppSDK Issue #3337 - RID workaround](https://github.com/microsoft/WindowsAppSDK/issues/3337)
- [dotnet/maui Issue #22445 - .msixupload missing](https://github.com/dotnet/maui/issues/22445)
- [dotnet/maui Issue #32801 - package identity mismatch](https://github.com/dotnet/maui/issues/32801)
