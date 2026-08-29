---
title: "Fix: Doesn't support required ABI al instalar una app .NET MAUI de Android"
description: "El APK no contiene ninguna biblioteca nativa para la CPU del dispositivo. Desde .NET 9 los RuntimeIdentifiers por defecto de Android son solo de 64 bits, así que la solución es fijar RuntimeIdentifiers de forma explícita. Cubre ADB0020, XA0036, NETSDK1083, la correspondencia entre ABI y RID, el texto de la Play Console y por qué el fragmento de cuatro RID que todo el mundo copia falla en .NET 11."
pubDate: 2026-08-29
template: error-page
tags:
  - "errors"
  - "maui"
  - "dotnet"
  - "android"
  - "dotnet-11"
  - "coreclr"
lang: "es"
translationOf: "2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app"
translatedBy: "claude"
translationDate: 2026-08-29
---

El paquete de la app no contiene ninguna biblioteca nativa para la CPU de la máquina en la que estás instalando. Android rechaza la instalación en lugar de ejecutar el binario equivocado. Desde .NET 9, un proyecto `net9.0-android` o posterior compila solo `arm64-v8a` y `x86_64`, mientras que ese mismo proyecto en .NET 8 compilaba cuatro ABI, así que el detonante habitual es una actualización y no algo que hayas cambiado tú. Se arregla fijando `$(RuntimeIdentifiers)` en el target framework de Android. El conjunto correcto de RID depende de la versión de .NET en la que estés, porque .NET 11 eliminó Android x86 por completo, lo que hace que el fragmento de cuatro RID que aparece en la mayoría de resultados de búsqueda ahora rompa la compilación.

## El error en contexto

La misma causa raíz aparece con tres redacciones distintas, según quién esté instalando.

Al desplegar desde Visual Studio o con `dotnet build -t:Run` obtienes un error de compilación de .NET for Android:

```
error ADB0020: The package does not support the CPU architecture of this device.
```

Si instalas el APK tú mismo con `adb` del SDK de Android, este informa del fallo subyacente:

```
adb: failed to install com.company.app-Signed.apk:
Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]
```

ADB0020 es exactamente la traducción que hace .NET for Android de eso, más el antiguo `INSTALL_FAILED_CPU_ABI_INCOMPATIBLE`. Y la Google Play Console lo dice en términos de catálogo de dispositivos, que es de donde viene la expresión "required ABI":

```
Doesn't support required ABI: arm64-v8a, x86_64
```

En el teléfono de un usuario, la misma condición se muestra como "Tu dispositivo no es compatible con esta versión" en Play Store, o como un escueto "Aplicación no instalada" si el APK se instaló de forma lateral.

## ¿Qué ABI quiere realmente el dispositivo?

Pregúntaselo. Todo dispositivo Android y todo emulador publica sus ABI soportadas por orden de prioridad:

```bash
adb shell getprop ro.product.cpu.abilist
```

Un teléfono moderno responde `arm64-v8a,armeabi-v7a`. Un dispositivo solo de 64 bits responde `arm64-v8a`. Una imagen de emulador en un Mac con Apple Silicon responde `arm64-v8a`, y una imagen x86_64 de Google responde `x86_64,arm64-v8a` únicamente si incorpora traducción de ARM, algo en lo que no conviene confiar.

Después pregúntale al paquete qué lleva dentro. Las bibliotecas nativas viven bajo `lib/<abi>/` dentro del APK:

```bash
unzip -l bin/Release/net11.0-android/com.company.app-Signed.apk | grep 'lib/'
```

```text
lib/arm64-v8a/libmonodroid.so
lib/arm64-v8a/libSystem.Native.so
lib/x86_64/libmonodroid.so
lib/x86_64/libSystem.Native.so
```

En un app bundle el prefijo es `base/lib/`:

```bash
unzip -l bin/Release/net11.0-android/com.company.app-Signed.aab | grep 'base/lib/'
```

La intersección de esas dos listas está vacía. Ese es todo el problema. El listado de arriba se instala en un emulador de Apple Silicon y en un teléfono moderno, y falla en cualquier dispositivo cuyo `abilist` sea solo `armeabi-v7a`.

## Qué cambió en .NET 9

.NET 8 y anteriores compilaban las cuatro ABI de Android por defecto. .NET 9 redujo el valor por defecto de `$(RuntimeIdentifiers)` para Android al par de 64 bits:

```text
net8.0-android    armeabi-v7a  arm64-v8a  x86  x86_64
net9.0-android                 arm64-v8a       x86_64
net10.0-android                arm64-v8a       x86_64
net11.0-android                arm64-v8a       x86_64
```

El razonamiento es que .NET sigue a los fabricantes de las plataformas móviles, y Google exige una compilación de 64 bits para publicar en Play desde 2019. Nada te avisa en tiempo de compilación, porque desde el punto de vista de la compilación no hay nada mal. Te enteras cuando alguien del equipo de pruebas con un teléfono antiguo no puede instalar, o cuando el catálogo de dispositivos de la Play Console elimina en silencio varios miles de modelos de tu lista de compatibles.

Si tu app es un proyecto personal o apunta a hardware reciente, el nuevo valor por defecto es el correcto y deberías dejarlo tal cual. Dos ABI de 64 bits en lugar de cuatro reducen aproximadamente a la mitad el tamaño de un APK de MAUI.

## La solución

Fija `$(RuntimeIdentifiers)` de forma explícita, condicionado al target framework de Android para que no se filtre a tus compilaciones de iOS o Windows:

```xml
<!-- .NET 9 and .NET 10 -->
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">
  <RuntimeIdentifiers>android-arm;android-arm64;android-x86;android-x64</RuntimeIdentifiers>
</PropertyGroup>
```

Un proyecto con un solo target puede usar la condición más simple sobre la cadena del TFM:

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net10.0-android'">
  <RuntimeIdentifiers>android-arm;android-arm64;android-x64</RuntimeIdentifiers>
</PropertyGroup>
```

Ese segundo conjunto es el que conviene usar por defecto. Restaura ARM de 32 bits, que es la única ABI de 32 bits con hardware real detrás, y omite x86 de 32 bits, que en la práctica significa imágenes de emulador antiguas y un puñado de tabletas con Intel Atom.

Recompila después de cambiar esto. Las bibliotecas nativas por ABI se preparan en `obj/`, y una compilación incremental reutilizará tan tranquila un layout anterior a la propiedad.

## Los nombres de ABI no son runtime identifiers

Este es el primer intento fallido más habitual. `$(AndroidSupportedAbis)` aceptaba nombres de ABI, así que la gente pega nombres de ABI en la propiedad que la reemplazó:

```xml
<!-- wrong -->
<RuntimeIdentifiers>armeabi-v7a;arm64-v8a;x86;x86_64</RuntimeIdentifiers>
```

```text
error NETSDK1083: The specified RuntimeIdentifier 'armeabi-v7a' is not recognized.
```

Los dos vocabularios se corresponden uno a uno:

| ABI de Android | Runtime identifier de .NET |
| --- | --- |
| `armeabi-v7a` | `android-arm` |
| `arm64-v8a` | `android-arm64` |
| `x86` | `android-x86` |
| `x86_64` | `android-x64` |

Fíjate en que `x86_64` corresponde a `android-x64` y no a `android-x86_64`, y en que `android-x86` es la de 32 bits. Confundir esas dos produce una compilación que funciona y un APK que no se instala en nada de lo que tengas.

## La página de ADB0020 recomienda una propiedad que ya no funciona

Seguir la página oficial de ADB0020 te lleva a un segundo error. Propone:

```xml
<AndroidSupportedAbis>armeabi-v7a;x86;x86_64;arm64-v8a</AndroidSupportedAbis>
```

Ese consejo es anterior a .NET 6. Añádelo a un proyecto moderno y la compilación te lo dice:

```text
warning XA0036: The 'AndroidSupportedAbis' MSBuild property is no longer supported. Edit the project
file in a text editor, remove any uses of 'AndroidSupportedAbis', and use the 'RuntimeIdentifiers'
MSBuild property instead.
```

Como XA0036 es una advertencia y no un error, la compilación termina bien, la propiedad se ignora y el APK sigue llevando dos ABI. Si has heredado un proyecto migrado desde Xamarin.Forms, busca un `AndroidSupportedAbis` olvidado en algún `Directory.Build.props` o en un argumento del servidor de compilación antes de concluir que `RuntimeIdentifiers` no está surtiendo efecto.

## .NET 11 vuelve a cambiar la respuesta

No pegues el fragmento de cuatro RID en un proyecto `net11.0-android`. [MAUI pasó a CoreCLR en Android, iOS y Mac Catalyst en .NET 11 Preview 4](/es/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/), y CoreCLR no arrastró consigo todas las arquitecturas que soportaba Mono. Android x86 ya no está, y pedirla rompe la compilación en lugar de descartarse en silencio:

```text
error NETSDK1082: There was no runtime pack for Microsoft.Android.Runtime available for the specified
RuntimeIdentifier 'android-x86'.
```

ARM de 32 bits tuvo que esperar más. Figuraba como pendiente de revisión cuando CoreCLR pasó a ser el valor por defecto, y el soporte llegó en la Preview 7. Dado que [la Preview 6 eliminó por completo la vía de Mono en móvil](/es/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/), ya no queda la salida de emergencia de `$(UseMonoRuntime)`. Para un proyecto de .NET 11 el conjunto que funciona es:

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-android'">
  <RuntimeIdentifiers>android-arm;android-arm64;android-x64</RuntimeIdentifiers>
</PropertyGroup>
```

Si estás en un SDK de la Preview 6 o anterior, quita también `android-arm` y asume solo 64 bits hasta que puedas actualizar. .NET 11 llega a GA en noviembre de 2026.

La consecuencia práctica para los emuladores: una imagen de sistema x86 de 32 bits nunca podrá ejecutar una app MAUI de .NET 11. Si tu CI todavía arranca una, pásala a `x86_64`, o a `arm64-v8a` en runners con Apple Silicon.

## Mantén rápido el ciclo de desarrollo

Compilar cuatro ABI para depurar en un solo dispositivo es tiempo tirado. `$(RuntimeIdentifier)`, en singular, prevalece sobre la forma en plural y compila exactamente una:

```bash
dotnet build -f net11.0-android -t:Run -p:RuntimeIdentifier=android-arm64
```

Enlázalo a la configuración Debug y deja el conjunto completo para Release:

```xml
<PropertyGroup Condition="'$(Configuration)' == 'Debug' and $(TargetFramework.Contains('-android'))">
  <RuntimeIdentifier>android-arm64</RuntimeIdentifier>
</PropertyGroup>
```

Una advertencia sobre pasar la propiedad en plural por línea de comandos: MSBuild parte los valores de `-p:` por los puntos y coma, así que `-p:RuntimeIdentifiers=android-arm64;android-x64` te da un error de análisis del shell o de MSBuild en lugar de dos RID. Escapa el separador como `%3B`:

```bash
dotnet publish -f net11.0-android -c Release -p:RuntimeIdentifiers=android-arm64%3Bandroid-x64
```

## Qué exige realmente Google Play

Play exige un binario de 64 bits junto a cualquier binario de 32 bits desde agosto de 2019. Nunca ha exigido el de 32 bits. Así que el valor por defecto de .NET 9 cumple, y volver a añadir `android-arm` es una decisión de alcance, no una corrección de cumplimiento.

Comprueba la cifra real antes de gastar tamaño de APK en ello. En la Play Console, el catálogo de dispositivos de la versión muestra a cuántos dispositivos compatibles llega un bundle, y la diferencia entre una compilación de dos ABI y una de tres es la población de teléfonos que solo admiten `armeabi-v7a` y siguen en uso en tus mercados. Para muchas apps, en 2026 esa cifra es lo bastante pequeña como para ignorarla; para apps que se distribuyen en regiones con ciclos largos de renovación de dispositivos, no lo es.

Si publicas un app bundle, Play lo divide por ABI de todos modos, así que cada usuario descarga una sola arquitectura. La ABI extra te cuesta tiempo de compilación y tamaño de subida, no tamaño de instalación.

## Relacionados

- Las bibliotecas nativas son también el motivo por el que [Google Play rechaza una app de Flutter o .NET MAUI por no admitir páginas de memoria de 16 KB](/es/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/), una comprobación que se ejecuta contra las mismas entradas `lib/<abi>/` que has listado arriba.
- El cambio de runtime que hay detrás de las modificaciones de arquitectura de .NET 11 se trata en [MAUI pasa a CoreCLR por defecto en Android, iOS y Mac Catalyst](/es/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/).
- Un `AndroidSupportedAbis` olvidado suele llegar junto al resto de propiedades de compilación heredadas que se tratan en [migrar de Xamarin.Forms a MAUI 11](/es/2026/05/migrate-from-xamarin-forms-to-maui-11/).
- Si la compilación falla antes siquiera de producir un paquete instalable, empieza por [Gradle build failed to produce an APK file in MAUI Android](/es/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/).

## Fuentes

- [Error ADB0020 de .NET for Android](https://learn.microsoft.com/es-es/dotnet/android/messages/adb0020), para la correspondencia entre `INSTALL_FAILED_NO_MATCHING_ABIS` y el error de compilación.
- [Advertencia XA0036 de .NET for Android](https://learn.microsoft.com/es-es/dotnet/android/messages/xa0036), para el texto de obsolescencia de `AndroidSupportedAbis`.
- [Migración de proyectos de Xamarin.Android](https://learn.microsoft.com/es-es/dotnet/maui/migration/android-projects), que documenta el reemplazo de ABI por `RuntimeIdentifiers`.
- [Catálogo de RID de .NET](https://learn.microsoft.com/es-es/dotnet/core/rid-catalog) para los nombres de los runtime identifiers de Android.
- [CoreCLR progress and the Mono timeline for .NET MAUI](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/), para la eliminación de la vía de Mono en la Preview 6 y el estado de arm32.
- [dotnet/maui#27697](https://github.com/dotnet/maui/issues/27697), el reporte que sacó a la luz el cambio de valores por defecto de .NET 9 como una regresión de compatibilidad en Play Store.
- [Admitir arquitecturas de 64 bits](https://developer.android.com/google-play/64-bit) en la documentación para desarrolladores de Google Play.
