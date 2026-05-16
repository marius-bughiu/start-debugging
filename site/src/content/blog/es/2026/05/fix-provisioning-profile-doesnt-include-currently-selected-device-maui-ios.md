---
title: "Solución: El perfil de aprovisionamiento no incluye el dispositivo seleccionado actualmente en MAUI iOS"
description: "El perfil que Visual Studio eligió se generó antes de registrar el UDID de este iPhone. Vuelve a registrar el dispositivo, regenera el perfil de desarrollo, descárgalo y vuelve a desplegar."
pubDate: 2026-05-16
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "maui"
  - "maui-11"
  - "ios"
  - "xcode"
  - "signing"
lang: "es"
translationOf: "2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios"
translatedBy: "claude"
translationDate: 2026-05-16
---

La solución: el perfil de aprovisionamiento de desarrollo con el que MAUI intentó firmar no incluye el UDID del iPhone. O bien el perfil se generó antes de registrar el dispositivo, o el dispositivo está registrado bajo un equipo distinto del que Visual Studio está usando, o el Bundle ID en tu csproj no coincide con el App ID al que está vinculado el perfil. Agrega el UDID en Apple Developer Account, regenera el perfil iOS App Development para que incluya el nuevo dispositivo, haz clic en Download All Profiles en Visual Studio (o `Download Manual Profiles` en Xcode si usas la ruta CLI) y vuelve a desplegar. Si estás en aprovisionamiento automático, desconectar y volver a conectar el dispositivo suele disparar que Visual Studio vuelva a ejecutar el aprovisionamiento y capture el nuevo UDID.

```text
Could not find any available provisioning profiles for iOS.
error : The provisioning profile doesn't include the currently selected device "iPhone (00008130-001A2C3D0EF8401E)".

error MT1006: Could not install the application 'com.example.app' on the device 'iPhone'.
error : A valid provisioning profile for this executable was not found. (0xe8008015)
```

Esta guía está escrita contra .NET 11 GA, el target framework `net11.0-ios`, .NET MAUI 11.0.0, Xcode 16.4 y Visual Studio 17.14 emparejado con un host de compilación Mac. El mismo error y la misma solución se aplican sin cambios en .NET MAUI 8 y 9; solo cambian los IDs de workload (`maui-ios`, `ios`) y el Xcode mínimo incluido entre versiones. La excepción la lanza `mlaunch`, la herramienta que MAUI usa por debajo para enviar un bundle `.app` a un dispositivo real, después de que `codesign` ya haya aceptado el binario. La compilación en sí tiene éxito. Lo que te rechaza es el paso de instalación.

## Por qué MAUI iOS empareja los perfiles con los UDID de los dispositivos

El modelo de firma de código de iOS de Apple tiene tres piezas móviles: un certificado de firma (tu identidad de desarrollador), un App ID (el identificador de bundle al que está vinculado el perfil) y un perfil de aprovisionamiento (un blob firmado que une un certificado, un App ID, un equipo y una lista de UDIDs de dispositivos permitidos). Un perfil de desarrollo solo es válido para los dispositivos que Apple escribió en él en el momento de la generación. Conectas un iPhone nuevo y cualquier perfil de desarrollo preexistente, silenciosamente, no lo cubre. El sistema operativo rechaza la instalación con `0xe8008015`, el error MISAgent para "no valid provisioning profile". El `mlaunch` de MAUI lo expone como el mensaje "provisioning profile doesn't include the currently selected device" y, en cadenas de herramientas más antiguas, como el más críptico `MT1006`.

No hay advertencia en tiempo de compilación. `codesign` solo verifica el certificado y el App ID del perfil; no inspecciona la lista de dispositivos. La lista de dispositivos la aplica `installd` en el propio iPhone, que es por eso que el error siempre aparece al desplegar, nunca al compilar.

Tres cosas causan esto:

1. El UDID del dispositivo no está en el perfil (lo más común, sobre todo justo después de conectar un dispositivo de prueba nuevo).
2. El Bundle ID en tu csproj se ha desviado del App ID al que el perfil está vinculado (renombrar un proyecto, cambiar el prefijo de la organización, copiar una plantilla).
3. Visual Studio está firmando con un perfil de un equipo distinto del que registró el dispositivo (un equipo personal vs un equipo de organización, o un perfil obsoleto cacheado localmente).

## Una reproducción mínima

Toma cualquier proyecto MAUI 11 iOS, pon Bundle Signing en Manual, apunta `CodesignProvision` a un perfil de desarrollo que se generó la semana pasada y conecta hoy un iPhone completamente nuevo.

```xml
<!-- .NET 11, .NET MAUI 11.0.0, net11.0-ios -->
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-ios' and '$(Configuration)' == 'Debug'">
  <CodesignKey>Apple Development: Marius Bughiu (ABCDE12345)</CodesignKey>
  <CodesignProvision>MyApp Dev Profile</CodesignProvision>
  <CodesignEntitlements>Platforms/iOS/Entitlements.plist</CodesignEntitlements>
</PropertyGroup>
```

Después:

```bash
# .NET 11.0.100, MAUI workload 11.0.0
dotnet build -t:Run -f net11.0-ios -p:_DeviceName=":v2:udid=00008130-001A2C3D0EF8401E"
```

La compilación tiene éxito. El despliegue falla con el mensaje de dispositivo no incluido, porque el perfil llamado `MyApp Dev Profile` se generó antes de que `00008130-001A2C3D0EF8401E` fuera un dispositivo que Apple conociera.

## Ruta de solución A: aprovisionamiento automático que se ha quedado obsoleto

Si tu esquema de `iOS Bundle Signing` está configurado en **Automatic Provisioning** (el valor por defecto recomendado para desarrollo), se supone que Visual Studio vuelve a ejecutar el aprovisionamiento cada vez que se conecta un nuevo dispositivo y regenera silenciosamente el perfil para incluirlo. Cuando ese mecanismo se atasca, el error que estás leyendo es el síntoma.

1. Abre **Tools > Options > Xamarin > Apple Accounts**, selecciona tu equipo, haz clic en **View Details**. Confirma que el equipo que esperas es el equipo que Visual Studio está usando. Si ves dos equipos (un equipo personal "Marius Bughiu" y un equipo de organización), cada uno tiene su propio pool de perfiles y Visual Studio solo va a auto-aprovisionar contra el equipo actualmente vinculado al proyecto.
2. Haz clic derecho en el proyecto, **Properties**, **iOS > Bundle Signing**. Confirma que **Scheme** es **Automatic Provisioning**, que **Signing Identity** y **Provisioning Profile** están ambos en **Automatic**, y que **Configure Automatic Provisioning** muestra una marca verde. Si el diálogo informa un error, léelo; "Authentication Service Is Unavailable" casi siempre significa que hay un acuerdo no aceptado en [App Store Connect](https://appstoreconnect.apple.com/) o [Apple Developer](https://developer.apple.com/account).
3. Desconecta el iPhone del host de compilación Mac, espera dos segundos, vuelve a conectarlo. Visual Studio escucha el evento USB y vuelve a ejecutar el aprovisionamiento automático, que es lo que registra un nuevo UDID y regenera el perfil de desarrollo. Mira el panel **Output > General** buscando `Automatic provisioning succeeded` antes de redesplegar.
4. Si cambiaste de Mac desde la última compilación exitosa, probablemente la clave privada de tu certificado de firma nunca cruzó. Visual Studio te lo dirá en el diálogo Apple Accounts con el estado **Not in Keychain**. Exporta el `.p12` desde Keychain Access en el Mac original e impórtalo vía **Import Certificate** en el diálogo Apple Accounts, luego reintenta.

El aprovisionamiento automático aún requiere que el host de compilación Mac esté emparejado y accesible. Si `Pair to Mac` aparece en amarillo, el evento de dispositivo USB no se propagará y tu UDID nuevo nunca se registra. Vuelve a emparejar primero.

## Ruta de solución B: aprovisionamiento manual, la ruta explícita del csproj

Si mantienes la firma iOS bajo control explícito (CI, distribución empresarial, una cuenta Apple compartida entre el equipo), haz el registro y la regeneración a mano.

1. En el Mac, **Xcode > Window > Devices and Simulators**, selecciona el iPhone, copia la cadena **Identifier**. Este es el UDID que verifica `installd`. El formato es `00008130-001A2C3D0EF8401E` para un dispositivo A12+. No lo escribas a mano; cópialo. Los UDIDs tienen 25 caracteres con un guion; un carácter mal y el perfil silenciosamente no coincide.
2. En un navegador, [Devices en Apple Developer](https://developer.apple.com/account/resources/devices/list), **+**, selecciona la plataforma **iOS, tvOS, watchOS**, pega el UDID, dale un nombre memorable, **Continue**, **Register**.
3. [Profiles](https://developer.apple.com/account/resources/profiles/list), busca tu perfil de desarrollo, **Edit**, marca el dispositivo recién agregado en la lista de Devices, **Save**, **Download**. Editar el perfil lo regenera; el nombre del archivo permanece igual, los contenidos cambian. Apple no envía el archivo nuevo a tu máquina; tienes que descargarlo.
4. Instala el perfil regenerado. En Mac, hacer doble clic en el `.mobileprovision` lo registra con `~/Library/MobileDevice/Provisioning Profiles/`. En Windows, en Visual Studio ve a **Tools > Options > Xamarin > Apple Accounts**, selecciona tu equipo, **View Details**, **Download All Profiles**. El perfil se sincroniza tanto a Windows como al Mac emparejado.
5. Confirma que tu csproj apunta al perfil correcto. La cadena en `CodesignProvision` debe coincidir exactamente con el **Name** del perfil en Apple Developer, no con el nombre del archivo, no con el UUID:

    ```xml
    <!-- .NET 11, .NET MAUI 11.0.0 -->
    <PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-ios' and '$(Configuration)' == 'Debug'">
      <CodesignKey>Apple Development: Marius Bughiu (ABCDE12345)</CodesignKey>
      <CodesignProvision>MyApp Dev Profile</CodesignProvision>
    </PropertyGroup>
    ```

    El `CodesignKey` es el nombre común del certificado como aparece en Keychain Access bajo **My Certificates**. El `CodesignProvision` es el nombre del perfil que escribiste en el paso 3 del flujo de Apple Developer. Ambos distinguen mayúsculas y minúsculas. Consulta [CodesignKey](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties#codesignkey) y [CodesignProvision](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties#codesignprovision) para el esquema completo.

6. Recompila y vuelve a desplegar. Si la falla persiste, salta a los gotchas más abajo; el UDID se ha registrado correctamente, así que algo más está mal.

## Verifica que el perfil realmente contenga el dispositivo

Antes de desmontar el proyecto, demuestra que el perfil es correcto. `security` en macOS decodifica la envoltura CMS alrededor de un `.mobileprovision`:

```bash
# macOS, security tool ships with the OS
security cms -D -i ~/Library/MobileDevice/Provisioning\ Profiles/<UUID>.mobileprovision \
  | plutil -convert xml1 -o - - \
  | grep -A1000 ProvisionedDevices \
  | head -50
```

Deberías ver un elemento `<string>` con tu UDID dentro de `<key>ProvisionedDevices</key>`. Si falta, el perfil en tu carpeta Provisioning Profiles es la copia anterior a la regeneración. Bórralo y vuelve a descargar desde Visual Studio o Xcode. macOS no sobrescribe un perfil existente con uno más nuevo del mismo UUID a menos que primero elimines el archivo antiguo; esto atrapa a mucha gente que cree tener "el perfil nuevo" pero en realidad tiene el de la semana pasada.

Ya que estás ahí, verifica el valor `<key>application-identifier</key>`. Debe ser igual a `<TEAM_ID>.<bundle-id>`, donde el bundle id es exactamente el **Application ID** en tu csproj. Si difieren, tu csproj o tu `Info.plist` se desviaron. Consulta la sección de desviación del Bundle ID en los gotchas.

## Gotchas y casos parecidos

**Estás desplegando al simulador, no a un dispositivo.** El simulador no requiere perfil de aprovisionamiento en absoluto, pero `mlaunch` seguirá quejándose si tu proyecto fuerza un perfil vía `CodesignProvision` y accidentalmente seleccionaste un target `iPhone 15 Pro Simulator`. Cambia el **Debug Target** en la barra de herramientas de Visual Studio a **iOS Remote Devices** y elige el dispositivo físico.

**Estás ejecutando Distribution, no Development.** Un perfil de desarrollo solo incluye dispositivos habilitados para Development y solo firma con un certificado `Apple Development`. Si `Configuration` es `Release` y el proyecto usa un certificado `Apple Distribution`, se requiere un perfil de distribución ad-hoc y tu perfil dev no será seleccionado. Consulta la guía oficial sobre [publicación para distribución ad-hoc](https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc?view=net-maui-10.0) para los pasos manuales paralelos.

**Desviación del Bundle ID.** El Application ID en **Project Properties > MAUI Shared > General** debe coincidir con el Bundle ID que cubre un App ID wildcard o explícito. Un perfil wildcard `com.example.*` cubre `com.example.app` pero no `com.example.app.dev`. Si bifurcaste un sample y nunca actualizaste el App ID, tu perfil es rechazado por desajuste de App ID y `mlaunch` lo reporta como el error de dispositivo no incluido porque el SO mete ambas verificaciones bajo el mismo código 0xe8008015.

**Perfil wildcard pero una entitlement que necesita App ID explícito.** Push Notifications, App Groups, Apple Pay, iCloud, Game Center, HealthKit, HomeKit, NFC, Associated Domains, In-App Purchase y Wireless Accessory Configuration requieren todos un App ID explícito. Si habilitaste una de estas en `Entitlements.plist` mientras tu perfil es wildcard, la instalación falla. Cambia a un App ID explícito que coincida con tu bundle identifier y regenera el perfil con la entitlement marcada.

**Dos perfiles, mismo App ID, equipos diferentes.** Los perfiles cacheados no se indexan por equipo. Si alguna vez iniciaste sesión en un equipo Apple Developer distinto en la misma máquina, los perfiles de ambos equipos viven uno al lado del otro en `~/Library/MobileDevice/Provisioning Profiles/`. Visual Studio elige uno, a menudo el más antiguo o el primero alfabéticamente, y la lista de dispositivos no coincide porque el dispositivo está registrado bajo el otro equipo. Borra los archivos de perfil obsoletos y vuelve a descargar vía **Download All Profiles**.

**El dispositivo está supervisado o ha perdido la confianza.** En el iPhone, **Settings > General > VPN & Device Management** debería listar el certificado de desarrollador y permitirte tocar **Trust**. Si se descartó "Trust This Computer", `installd` rechaza el despliegue sin una razón clara y `mlaunch` puede exponer el mensaje de dispositivo no incluido. Vuelve a emparejar, toca Trust, reintenta.

**Las cuentas Apple ID gratuitas tienen una vida útil de perfil de 7 días.** Los equipos personales (sin membresía pagada) generan perfiles de desarrollo que expiran siete días después de la creación. La expiración se manifiesta en tiempo de despliegue de la misma manera que el caso de dispositivo faltante. La solución es regenerar haciendo clic en Run desde Xcode al menos una vez, o actualizar a una cuenta Apple Developer Program pagada.

**`MT1006: Could not install the application`.** Esta es la envoltura de `mlaunch` para cualquier fallo de despliegue, no una causa específica. La primera línea hermana en el log de compilación es el error real; en el caso de dispositivo faltante es la línea "provisioning profile doesn't include". El artículo de Khalid Abuhakmeh sobre [missing entitlements](https://khalidabuhakmeh.com/fix-dotnet-maui-missingentitlement-and-provisioning-profiles-issues) recorre la variante de entitlements de la misma superficie MT1006.

## Relacionado

- El equivalente Android de "el wrapper de la build oculta el error real" está cubierto en [el paseo por el fallo XA1029 de compilación de Gradle](/es/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/).
- Si estás configurando hot-reload de iOS en el mismo proyecto, [dotnet watch en MAUI Android e iOS en .NET 11 preview 4](/es/2026/05/dotnet-watch-maui-android-ios-net-11-preview-4/) cubre el bucle de watch al que puedes volver una vez arreglada la firma.
- Para flujos de distribución una vez que el bucle de desarrollo funcione, mira [empaquetar una aplicación MAUI para la Microsoft Store](/es/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) para el lado Windows y la [documentación de distribución ad-hoc](https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc?view=net-maui-10.0) para el lado iOS.
- Si tu target es solo escritorio y quieres saltarte la firma móvil por completo, [una aplicación MAUI que se ejecuta solo en Windows y macOS, sin targets móviles](/es/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) muestra cómo descartar el TFM `net11.0-ios`.
- Para el contexto de runtime subyacente en iOS en .NET 11, el post [CoreCLR como predeterminado de MAUI para Android e iOS en .NET 11 preview 4](/es/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) cubre lo que cambió bajo `mlaunch`.

## Fuentes

- [Manual provisioning for .NET MAUI iOS apps](https://learn.microsoft.com/en-us/dotnet/maui/ios/device-provisioning/manual-provisioning?view=net-maui-10.0) (Microsoft Learn)
- [Automatic provisioning for .NET MAUI iOS apps](https://learn.microsoft.com/en-us/dotnet/maui/ios/device-provisioning/automatic-provisioning?view=net-maui-10.0) (Microsoft Learn)
- [Device provisioning for .NET MAUI apps on iOS](https://learn.microsoft.com/en-us/dotnet/maui/ios/device-provisioning/?view=net-maui-10.0) (Microsoft Learn)
- [Build properties for iOS: CodesignKey and CodesignProvision](https://learn.microsoft.com/en-us/dotnet/ios/building-apps/build-properties#codesignkey) (Microsoft Learn)
- [Publish a .NET MAUI iOS app for ad-hoc distribution](https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc?view=net-maui-10.0) (Microsoft Learn)
- [Manual iOS Provisioning, dotnet/maui#7056](https://github.com/dotnet/maui/issues/7056) (GitHub)
- [Khalid Abuhakmeh: Fix .NET MAUI MissingEntitlement and Provisioning Profiles Issues](https://khalidabuhakmeh.com/fix-dotnet-maui-missingentitlement-and-provisioning-profiles-issues)
