---
title: "Fix: Unable to find a valid iOS Simulator runtime durante la compilación de MAUI"
description: "Xcode 15+ no incluye runtimes del simulador de iOS. MAUI falla la compilación cuando SupportedOSPlatformVersion no tiene un runtime instalado que coincida. Instala uno con xcodebuild -downloadPlatform iOS o desde Settings de Xcode, y verifica con xcrun simctl list runtimes."
pubDate: 2026-05-16
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "maui"
  - "maui-11"
  - "ios"
  - "xcode"
  - "simulator"
lang: "es"
translationOf: "2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build"
translatedBy: "claude"
translationDate: 2026-05-16
---

La solución: a partir de Xcode 15 el runtime del simulador de iOS ya no se incluye con el propio Xcode, y a partir de Xcode 26 el runtime del Xcode anterior tampoco se migra automáticamente. La cadena de herramientas de MAUI iOS lee `SupportedOSPlatformVersion` desde tu csproj, le pide a Xcode un simulador con esa versión o superior, y se rinde con `Unable to find a valid iOS Simulator runtime` cuando nada coincide. Ejecuta `xcrun simctl list runtimes` para confirmar qué está realmente instalado, y luego descarga uno desde Xcode en Settings, Platforms, el botón más, o hazlo sin interfaz con `xcodebuild -downloadPlatform iOS`. Si `SupportedOSPlatformVersion` en tu csproj es mayor que todos los runtimes instalados, bájala a una versión que tengas o instala el runtime que coincida.

```text
/usr/local/share/dotnet/packs/Microsoft.iOS.Sdk/18.2.9270/targets/Xamarin.Shared.Sdk.targets(1245,3):
error : Unable to find a valid iOS Simulator runtime. Please install one from Xcode > Settings > Platforms.

xcodebuild: error: Unable to find a destination matching the provided destination specifier:
        { platform:iOS Simulator, OS:18.2, name:iPhone 16 Pro }

Could not find the simulator runtime 'com.apple.CoreSimulator.SimRuntime.iOS-18-2'.
```

Esta guía está escrita contra .NET 11 preview 4, MAUI 11 preview 4, Xcode 26.0 y `Microsoft.iOS.Sdk` 18.2.9270. El comportamiento apareció en el momento en que Apple separó los runtimes del simulador del instalador de Xcode en Xcode 15, y se volvió mucho más visible en Xcode 26 porque Apple dejó de importar silenciosamente la caché de runtimes del Xcode previo durante el primer arranque. Si actualizaste hace poco y tu pipeline de compilación empezó a fallar sin razón aparente, casi seguro esta es la causa.

## Por qué Xcode 15 rompió las compilaciones de MAUI iOS

Durante la mayor parte de la historia de Xcode, el instalador llevaba el runtime del simulador de iOS en el mismo `.xip` que descargabas desde el portal de desarrollador, que es parte de la razón por la que Xcode solía pesar más de 7 GB. Con Xcode 15 Apple dividió los runtimes en un modelo de descarga separada: la aplicación Xcode incluye la cadena de herramientas (compiladores, SDKs, headers) y la propia aplicación del simulador de iOS, pero cada imagen de runtime concreta (`iOS 17.4`, `iOS 18.2`, y así sucesivamente) es una descarga separada a la que te subscribes. El instalador adelgaza a aproximadamente 3 GB, y tú jalas solo las plataformas que necesitas.

Eso es genial para el uso de disco y terrible para las primeras compilaciones. Un proyecto MAUI que apunta a `net11.0-ios` resuelve el SDK objetivo desde `Microsoft.iOS.Sdk`, le pasa a `xcodebuild` una cadena de destino que incluye una versión de runtime, y luego `xcrun simctl create` o `xcrun simctl boot` intenta encontrar un runtime que coincida en `~/Library/Developer/CoreSimulator/Profiles/Runtimes` y `/Library/Developer/CoreSimulator/Profiles/Runtimes`. Sin nada instalado, ninguna de esas llamadas tiene éxito y obtienes el error de arriba.

Xcode 26 añadió un detalle nuevo. Apple ahora trata los runtimes como independientes del bundle de Xcode por completo, y el nuevo framework `CoreSimulator` mantiene una matriz de compatibilidad por Xcode. Si tenías Xcode 16 con el simulador iOS 18.2 instalado, luego actualizaste a Xcode 26 y tu csproj apunta a `iOS 19.0`, el runtime 18.2 sigue en disco pero no es lo que MAUI está pidiendo. La redacción del error es la misma, que es por lo que confunde a la gente al actualizar.

## Qué pide MAUI en realidad

Cuando ejecutas `dotnet build -t:Run -f net11.0-ios -p:_DeviceName=":v2:runtime=com.apple.CoreSimulator.SimRuntime.iOS-19-0,devicetype=com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"`, los targets de MAUI iOS en `Microsoft.iOS.Sdk` hacen varias cosas:

1. Resuelven `SupportedOSPlatformVersion` y `_MtouchTargetiOSVersion` desde tu proyecto.
2. Invocan `xcrun simctl list runtimes -j` para descubrir qué está instalado localmente.
3. Eligen el primer runtime cuya versión sea mayor o igual a tu objetivo y que coincida con la plataforma (`iOS-Simulator`).
4. Si nada coincide, la tarea MSBuild lanza el error `Unable to find a valid iOS Simulator runtime` antes incluso de llamar a `xcrun simctl boot`.

Esto está implementado en la tarea `_DetectSimulator` en `Xamarin.Shared.Sdk.targets`. La conclusión: el error significa que tu lista de runtimes instalados está vacía para la plataforma, o todos los runtimes instalados tienen una versión menor que el objetivo de tu csproj.

## Verifica qué hay instalado realmente

Antes de cambiar nada en tu csproj, lista los runtimes:

```bash
# macOS, any shell
xcrun simctl list runtimes --json | jq '.runtimes[] | {name, version, identifier, isAvailable}'
```

Una máquina sana imprime algo como:

```json
{
  "name": "iOS 19.0",
  "version": "19.0",
  "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-19-0",
  "isAvailable": true
}
```

Una máquina rota después de una actualización de Xcode imprime un arreglo `runtimes` vacío, o runtimes marcados con `"isAvailable": false` y una cadena `availabilityError` que explica que el runtime es "incompatible con esta versión de Xcode". Un runtime marcado como no disponible está en disco pero Xcode se negará a usarlo, así que MAUI lo trata como ausente.

También puedes ver la misma información desde dentro de Xcode en **Settings, Platforms**. La lista muestra los runtimes instalados con un check y te permite instalar o eliminar cada uno.

## Instala el runtime desde la línea de comandos

Si no tienes interfaz o estás en CI, no hagas clic por la UI de Xcode. Xcode 15 introdujo un flag `-downloadPlatform` para `xcodebuild`:

```bash
# Xcode 15+, downloads the latest iOS simulator runtime
# compatible with this Xcode version
xcodebuild -downloadPlatform iOS

# Xcode 16+, pin to a specific build of the runtime
xcodebuild -downloadPlatform iOS -buildVersion 18.2
```

El comando se ejecuta en primer plano, imprime un porcentaje de progreso y escribe el runtime a `~/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS <version>.simruntime`. Son aproximadamente 8 GB por runtime, así que planea en consecuencia en CI. Apple lo documenta en [Downloading and installing additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components).

Para versiones más antiguas de Xcode (solo Xcode 15), la forma anterior es `xcodebuild -downloadAllPlatforms`, que descarga el runtime de cada plataforma compatible. Es mucho más pesado que `-downloadPlatform iOS` y casi nunca lo querrás en CI.

Si necesitas un runtime que no es parte del conjunto de compatibilidad del Xcode actual, por ejemplo quieres iOS 17.4 para reproducir un bug de cliente en Xcode 26, instálalo desde un `.dmg` o `.simruntime` descargado:

```bash
# Manually install a simruntime image from disk
xcrun simctl runtime add "/path/to/iOS 17.4.simruntime"
```

El subcomando `xcrun simctl runtime` existe en Xcode 16+ y es la forma soportada de registrar un runtime descargado por separado. Puedes listar las imágenes de runtime registradas con `xcrun simctl runtime list`.

## Alinea SupportedOSPlatformVersion con lo que tienes

Si instalaste `iOS 18.2` pero tu csproj apunta a `iOS 19.0`, el error se repetirá. Abre la sección específica de iOS de tu csproj y baja el objetivo o acepta que necesitas un runtime más nuevo:

```xml
<!-- .NET 11, MAUI 11, Microsoft.iOS.Sdk 18.2.9270 -->
<PropertyGroup Condition="$(TargetFramework.Contains('-ios'))">
  <SupportedOSPlatformVersion>15.0</SupportedOSPlatformVersion>
</PropertyGroup>
```

`SupportedOSPlatformVersion` es la versión **mínima** de iOS que tu aplicación soporta en runtime. El runtime del simulador que arranques debe ser mayor o igual a este número. El simulador real que MAUI lanza por defecto es el runtime instalado de mayor versión, no el mínimo, así que si tienes iOS 19.0 instalado tu aplicación sigue arrancando en iOS 19.0 aunque el piso del proyecto sea 15.0.

No subas `SupportedOSPlatformVersion` para silenciar el error, esa es la palanca equivocada. La jugada correcta es instalar el runtime y dejar el mínimo del proyecto donde realmente necesita estar para tu audiencia.

## Fija un simulador específico desde dotnet build

Cuando tienes múltiples runtimes instalados y quieres uno específico, pasa `_DeviceName` al target Run de iOS de MAUI. Esta es la misma cadena que `xcrun simctl` usa internamente:

```bash
# .NET 11 preview 4, MAUI 11 preview 4
dotnet build -t:Run -f net11.0-ios \
  -p:_DeviceName=":v2:runtime=com.apple.CoreSimulator.SimRuntime.iOS-18-2,devicetype=com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"
```

El prefijo `:v2:` es obligatorio, MAUI lo parsea como el selector de dispositivo de nuevo formato. El identificador de runtime coincide con lo que `xcrun simctl list runtimes` imprime bajo `identifier`. El identificador de tipo de dispositivo coincide con `xcrun simctl list devicetypes`.

Si omites `_DeviceName`, MAUI elige el último simulador de iPhone instalado en el mayor runtime instalado, lo cual está bien para desarrollo local y es sorprendentemente frágil en CI cuando aterriza una nueva versión puntual de Xcode.

## Arreglo específico para CI

En un runner fresco `macos-15` o `macos-26` de GitHub Actions, Xcode está preinstalado pero el runtime del simulador de iOS que coincide con tu `SupportedOSPlatformVersion` podría no estarlo. Las imágenes hospedadas de Apple incluyen uno o dos runtimes incorporados; los agentes de build de otros proveedores varían. El patrón seguro es instalar explícitamente antes de ejecutar `dotnet build`:

```yaml
# .github/workflows/maui-ios.yml
- name: Select Xcode
  run: sudo xcode-select -s /Applications/Xcode_26.0.app

- name: Install iOS 18.2 simulator runtime
  run: xcodebuild -downloadPlatform iOS -buildVersion 18.2

- name: Verify runtime is registered
  run: xcrun simctl list runtimes

- name: Build MAUI iOS
  run: dotnet build src/App/App.csproj -c Release -f net11.0-ios
```

Dos cosas muerden a la gente aquí. Primero, el runner cachea entre jobs solo si optas explícitamente, así que cada job vuelve a descargar 8 GB salvo que conectes [`actions/cache`](https://github.com/actions/cache) con clave en la versión del runtime. Segundo, `xcodebuild -downloadPlatform` no falla si el runtime ya está instalado, pero sí vuelve a buscar metadatos. Con caché caliente el comando termina en segundos.

Si tu CI está corriendo un Xcode más antiguo (Xcode 14 o anterior), `-downloadPlatform` no existe. O actualizas Xcode, o recurres a una herramienta de terceros como `xcodes` (`brew install xcodes`) y `sudo xcodes runtimes install "iOS 18.2"`. El `xcodes` mantenido por la comunidad era la única buena respuesta antes de Xcode 15 y sigue siendo útil cuando necesitas runtimes antiguos que Apple ya no hospeda en el portal de desarrollador.

## El servicio CoreSimulator atascado tras actualizar

A veces el runtime está instalado, `xcrun simctl list runtimes` lo muestra como disponible, y MAUI sigue fallando. La causa suele ser un `CoreSimulatorService` rancio que cacheó la lista de runtimes del Xcode previo a la actualización. Mátalo:

```bash
sudo killall -9 com.apple.CoreSimulator.CoreSimulatorService
```

El servicio se relanza en la siguiente llamada a `xcrun simctl` y vuelve a leer el directorio de runtimes. Esto está documentado en varios issues de `dotnet/macios`, incluyendo [dotnet/macios#22243](https://github.com/dotnet/macios/issues/22243), y aparece sobre todo después de que `softwareupdate -ai` actualiza CoreSimulator sin reiniciar.

Si matar el servicio no ayuda, también limpia `~/Library/Developer/CoreSimulator/Caches` y reinicia. `CoreSimulator` mantiene una caché de datos derivados que ocasionalmente apunta a una ruta de runtime borrada.

## Cuando el Xcode incorrecto está seleccionado

El otro falso positivo común: `xcode-select -p` apunta a un Xcode diferente al que instalaste el runtime. Los runtimes están técnicamente registrados contra el Xcode activo a través de `CoreSimulator`, y cambiar Xcodes puede dejar al nuevo Xcode activo sin runtimes visibles aunque los archivos existan:

```bash
# Show the active Xcode
xcode-select -p
# /Applications/Xcode_26.0.app/Contents/Developer

# Switch to a specific Xcode
sudo xcode-select -s /Applications/Xcode_26.0.app
```

MAUI también respeta `DEVELOPER_DIR`. Si un paso de CI lo exporta, anula a `xcode-select`. La discrepancia entre `xcode-select` y `DEVELOPER_DIR` es uno de esos bugs que solo aparece la segunda vez que el pipeline corre, cuando una variable de entorno cacheada entra en conflicto con el default fresco de un runner. La [guía de troubleshooting de MAUI](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting?view=net-maui-10.0) documenta la precedencia de selección de Xcode: `DEVELOPER_DIR`, luego archivos plist deprecados, luego `xcode-select -p`, luego `/Applications/Xcode.app`.

## Gotchas tras la solución

Algunas cosas siguen tropezando a la gente después de instalar el runtime:

1. **Slices de simulador Apple Silicon vs Intel**. Los runtimes del simulador iOS 17.0+ solo incluyen la slice arm64. Si corres en un Mac Intel bajo Rosetta, no puedes arrancarlos. Usa un runtime más viejo o actualiza el agente de build.
2. **Confusión con Mac Catalyst**. `net11.0-maccatalyst` no necesita un runtime de simulador, corre nativamente en macOS. Si una compilación de Mac Catalyst falla con este error, casi seguro tienes un target `net11.0-ios` colado en el mismo proyecto y tu IDE lo eligió.
3. **Discrepancias de `-buildVersion`**. `xcodebuild -downloadPlatform iOS -buildVersion 18.2` acepta versiones de marketing como `18.2`, no números de build internos como `22C150`. Pasar un número de build descarga silenciosamente la última versión en su lugar.
4. **Las subidas a App Store Connect siguen funcionando sin simulador**. Las compilaciones para dispositivo (`-p:RuntimeIdentifier=ios-arm64`) no necesitan el runtime del simulador para nada. Si tu CI solo despacha a TestFlight, puedes saltarte la instalación por completo y montar solo la firma.

Si también peleas con errores de compilación del lado Android en el mismo proyecto, el mismo patrón (la cadena de herramientas espera un componente que el instalador ya no incluye) aparece allí también: ve el artículo sobre [el fallo de Gradle al producir APK en MAUI Android](/es/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/). Para errores del lado de iOS que parecen similares pero no están relacionados con simuladores, la [solución de la discrepancia de dispositivo del perfil de aprovisionamiento](/es/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) cubre ese camino. Si quieres alejarte por completo de móvil multiplataforma en este proyecto, el post sobre [correr MAUI solo en Windows y macOS](/es/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) recorre los target frameworks solo de escritorio. Para el contexto de la ola del release de MAUI 11, el post sobre [el default de CoreCLR en MAUI en .NET 11 preview 4](/es/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) explica qué cambió debajo del capó.

La solución más corta es casi siempre `xcodebuild -downloadPlatform iOS` seguido de un `dotnet build`. La solución más larga es escribir esa única línea en tu script de CI para que el siguiente agente que se una al equipo no pierda una tarde con esto.

## Enlaces de fuentes

- [Downloading and installing additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
- [Troubleshoot known issues - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting?view=net-maui-10.0)
- [dotnet/macios#22243 - Can't find simulator when a particular iOS SDK version doesn't contain a simulator](https://github.com/dotnet/macios/issues/22243)
- [dotnet/maui#23352 - iOS build failed with iossimulator-x64 RuntimeIdentifier](https://github.com/dotnet/maui/issues/23352)
- [Build with a specific version of Xcode](https://learn.microsoft.com/en-us/dotnet/ios/cli)
