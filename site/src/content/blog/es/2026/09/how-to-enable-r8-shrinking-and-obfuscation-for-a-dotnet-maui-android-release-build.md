---
title: "Cómo habilitar la reducción y ofuscación con R8 en una compilación Release de .NET MAUI para Android"
description: "Establece AndroidLinkTool en r8, mantén el recorte activado y agrega un archivo ProguardConfiguration. Por qué .NET 10 y .NET 11 RC 1 todavía generan Java sin ofuscar, cómo lo cambia la nueva propiedad AndroidR8ObfuscationMode y cómo verificar que R8 realmente se ejecutó."
pubDate: 2026-09-13
template: how-to
tags:
  - "dotnet-maui"
  - "android"
  - "r8"
  - "dotnet-11"
  - "dotnet-10"
  - "google-play"
lang: "es"
translationOf: "2026/09/how-to-enable-r8-shrinking-and-obfuscation-for-a-dotnet-maui-android-release-build"
translatedBy: "claude"
translationDate: 2026-09-13
---

**Respuesta corta:** agrega `<AndroidLinkTool>r8</AndroidLinkTool>` a un `PropertyGroup` exclusivo de Release en el `.csproj` de tu app MAUI, deja el recorte activado (en Release viene activado por defecto) y coloca las reglas keep en un archivo `proguard.cfg` con la acción de compilación `ProguardConfiguration`. Eso activa la reducción y optimización con R8 de la parte Java de tu app. **No** ofusca nada en los SDK que se distribuyen hoy: .NET for Android 36.1.69 (.NET 10) y 37.0.0-rc.1.2257 (.NET 11 RC 1) inyectan `-dontobfuscate` en la configuración de R8. La ofuscación real llega con la nueva propiedad `AndroidR8ObfuscationMode`, cuyo valor por defecto es `private-members` en .NET 11 después de RC 1 y que es un backport opcional para la próxima versión de servicio de .NET 10.

Ese último detalle importa más que antes. Google anunció el 26 de agosto de 2026 que, a partir de febrero de 2027, los app bundles en Google Play necesitan al menos un 25% de cobertura de optimización, reducción y ofuscación de su código DEX (Android vitals solo emite alertas cuando un bundle contiene 10 MB de DEX en apps y 50 MB en juegos). Una app MAUI incorpora mucho Java de AndroidX y de los servicios de Google Play, así que la parte DEX no es pequeña.

Todo lo que sigue se rastreó en el código fuente de `dotnet/android` en las etiquetas de versión mencionadas arriba, así que puedes comprobar cada afirmación contra los targets de MSBuild por tu cuenta.

## Qué toca R8 en una app MAUI y qué no

Un paquete Android de MAUI contiene dos tipos de código, y cada uno lo reduce una herramienta distinta:

- **Código administrado** (tu C#, MAUI, la BCL): lo recorta ILLink cuando `PublishTrimmed` es `true`. R8 nunca lo ve. Ofuscar C# es un problema aparte que R8 no puede resolver.
- **Bytecode Java** (AndroidX, Material, servicios de Google Play, Firebase, cualquier `.aar` que enlaces, más los Java Callable Wrappers que la compilación genera para cada tipo administrado que extiende un tipo Java): se convierte en `classes.dex`. Por defecto lo hace el compilador D8, sin reducción. Con `AndroidLinkTool=r8`, R8 genera el DEX y reduce en una sola pasada.

Los porcentajes de Google Play se miden sobre el DEX, que es exactamente la mitad de R8. Así que cuando se habla de "habilitar R8 en MAUI", se refiere a hacer más pequeña esa mitad Java y, eventualmente, renombrarla.

La reducción por sí sola ya vale la pena. En [dotnet/android #12535](https://github.com/dotnet/android/issues/12535), un desarrollador midió una app .NET 10 en 36.1.69 con 20.18 MB de DEX sin comprimir usando D8 y 11.43 MB con R8 y las reglas por defecto del SDK. Eso es casi la mitad del código Java eliminado, sin escribir reglas keep a mano.

## El cambio mínimo en el proyecto

Esta es toda la configuración para una app MAUI que apunta a .NET 10 y .NET 11:

```xml
<!-- MyApp.csproj, .NET 10 (Microsoft.Android.Sdk 36.1.x) and .NET 11 RC 1 (37.0.0-rc.1) -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net11.0-android;net11.0-ios</TargetFrameworks>
    <OutputType>Exe</OutputType>
    <UseMaui>true</UseMaui>
  </PropertyGroup>

  <PropertyGroup Condition="'$(Configuration)' == 'Release' And $(TargetFramework.Contains('-android'))">
    <AndroidLinkTool>r8</AndroidLinkTool>
    <!-- Default in Release already. Written out because R8 without trimming strips Java types your C# still uses. -->
    <PublishTrimmed>true</PublishTrimmed>
  </PropertyGroup>

  <ItemGroup Condition="$(TargetFramework.Contains('-android'))">
    <ProguardConfiguration Include="Platforms/Android/proguard.cfg" />
  </ItemGroup>
</Project>
```

Luego publica como siempre:

```bash
dotnet publish -f net11.0-android -c Release
```

El `proguard.cfg` puede empezar vacío. Solo le agregas reglas cuando R8 elimina algo al que se accede por reflexión, lo cual se trata más adelante.

## Qué hace el SDK cuando estableces AndroidLinkTool

`AndroidLinkTool` es el único interruptor que necesitas, porque `Xamarin.Android.Common.targets` deriva el resto a partir de él. Resumido de los targets de .NET 10 y .NET 11:

```xml
<!-- Xamarin.Android.Common.targets (dotnet/android 36.1.69 and 37.0.0-rc.1.2257), condensed -->
<AndroidDexTool   Condition=" '$(AndroidLinkTool)' == 'r8' ">d8</AndroidDexTool>
<AndroidLinkTool  Condition=" '$(AndroidLinkTool)' == 'proguard' And '$(AndroidEnableDesugar)' == 'True' ">r8</AndroidLinkTool>
<AndroidEnableProguard Condition=" '$(AndroidLinkTool)' != '' ">True</AndroidEnableProguard>
<AndroidCreateProguardMappingFile Condition="'$(AndroidCreateProguardMappingFile)' == '' And '$(AndroidLinkTool)' == 'r8'">True</AndroidCreateProguardMappingFile>
<AndroidProguardMappingFile Condition=" '$(AndroidLinkTool)' == 'r8' And '$(AndroidCreateProguardMappingFile)' == 'True' ">$(OutputPath)mapping.txt</AndroidProguardMappingFile>
```

De ahí se desprenden algunas consecuencias:

- `AndroidLinkTool=proguard` se actualiza silenciosamente a `r8`, porque el desugaring está activado por defecto con D8. El .NET for Android moderno no usa la herramienta ProGuard independiente.
- El antiguo `AndroidEnableProguard=true` / `EnableProguard=true` de la era Xamarin todavía funciona, pero produce la advertencia XA1028 (o XA1027) y establece por defecto la herramienta de enlace en `proguard`, que luego se convierte en `r8`. Establece `AndroidLinkTool` directamente y evita la advertencia.
- Por defecto se genera un `mapping.txt` en `$(OutputPath)` (por ejemplo `bin/Release/net11.0-android/mapping.txt`), y `dotnet publish` lo copia a la carpeta de publicación. Cuando compilas un `.aab`, el archivo de mapeo también se incrusta en los metadatos del bundle como `com.android.tools.build.obfuscation/proguard.map`, así que Play Console lo toma sin que tengas que subirlo a mano. Para un `.apk` instalado manualmente, lo subes tú.

## Por qué R8 necesita el recorte activado

R8 no puede averiguar por sí mismo qué tipos Java sigue usando tu C#. Esa lista viene del recortador de .NET: después de que se ejecuta ILLink, un paso personalizado escribe `proguard_project_references.cfg` con una regla keep para cada tipo Java al que se enlaza un tipo administrado que sobrevivió. El target que lo genera está condicionado al recorte:

```xml
<!-- Microsoft.Android.Sdk.TypeMap.LlvmIr.targets, 37.0.0-rc.1.2257 -->
<Target Name="_GenerateProguardConfiguration"
    AfterTargets="_PrepareLinkedAssembliesForProguard"
    Condition=" '$(PublishTrimmed)' == 'true' and '$(_ProguardProjectConfiguration)' != '' "
```

Sin embargo, la decisión de ejecutar R8 no comprueba el recorte. `Xamarin.Android.D8.targets` solo necesita que la propiedad de ruta esté establecida, y `_ResolveAssemblies` la establece en cada compilación donde `AndroidLinkTool` no está vacío:

```xml
<!-- Xamarin.Android.D8.targets, same in 36.1.69 and 37.0.0-rc.1.2257 -->
<_UseR8 Condition=" ('$(AndroidLinkTool)' == 'r8' And '$(_ProguardProjectConfiguration)' != '') Or '$(AndroidEnableMultiDex)' == 'True' ">True</_UseR8>
```

Así que con `PublishTrimmed=false` (o `AndroidLinkMode=None` en Release, una solución alternativa común para problemas de reflexión), R8 se ejecuta igual, pero sin el archivo que protege tus enlaces. La compilación solo registra XA4304 ("ProGuard configuration file '...proguard_project_references.cfg' was not found"), y luego la app muere con `java.lang.ClassNotFoundException` la primera vez que toca un tipo Java que R8 eliminó. Esa secuencia exacta es [dotnet/android #6612](https://github.com/dotnet/android/issues/6612), donde los mantenedores confirmaron que R8 depende de que el enlazador de .NET esté habilitado.

Por eso también la condición de Release en el archivo de proyecto no es cosmética. Las compilaciones Debug no recortan, así que un `AndroidLinkTool=r8` sin condición hace que Debug también ejecute R8 sin el archivo de referencias, y con la implementación rápida activada además obtienes XA0119: "Using fast deployment and a code shrinker at the same time is not recommended".

## Qué archivos de configuración recibe realmente R8

Cuando R8 se ejecuta, el SDK ensambla sus entradas `--pg-conf` en este orden (elementos `_ProguardConfiguration` en `Xamarin.Android.Common.targets`):

1. `$(ProguardConfigFiles)`, si estableces esa propiedad.
2. El `proguard-android.txt` del SDK de Android (base sin optimización). En los SDK más nuevos con `AndroidR8ObfuscationMode=private-members`, se convierte en `proguard-android-optimize.txt`.
3. `obj/.../proguard/proguard_xamarin.cfg`: reglas keep del runtime para `mono.android.**`, `net.dot.jni.**` y similares. En los SDK que se distribuyen hoy, este archivo empieza con `-dontobfuscate`.
4. `proguard_project_references.cfg`: reglas keep para cada tipo Java al que se enlaza un tipo administrado que sobrevivió, generadas después de ILLink.
5. `proguard_project_primary.cfg`: una regla `-keep class X { *; }` por cada Java Callable Wrapper del mapa ACW, de modo que cada `Activity`, `Service` y `View` personalizado que define tu C# sobrevive.
6. Tus elementos `@(ProguardConfiguration)`.
7. Las reglas de consumidor (`proguard.txt`) extraídas de los archivos `.aar` referenciados.

Los elementos 4 y 5 son la razón por la que una app MAUI rara vez necesita reglas keep escritas a mano para sus propios tipos: la compilación ya sabe a qué clases Java puede llegar el lado administrado. Lo que no puede saber es a qué código llega Java por reflexión.

## Por qué hoy obtienes reducción pero no ofuscación

Las opciones de ProGuard son globales. Si cualquier archivo de configuración dice `-dontobfuscate`, la ofuscación queda desactivada para toda la ejecución de R8, y no existe un flag opuesto que puedas agregar en tu propio `proguard.cfg` para volver a activarla. Como `proguard_xamarin.cfg` en 36.1.69 y 37.0.0-rc.1.2257 contiene esa línea, una compilación MAUI con R8 habilitado en cualquiera de los dos SDK reduce y optimiza, pero mantiene intactos todos los nombres Java. El `mapping.txt` que escribe sigue registrando los miembros eliminados y los cambios de número de línea, pero no mostrará renombrados.

Las mediciones en #12535 coinciden: 34 de 15 235 clases renombradas en el `mapping.txt` de una app (0.2%), y Play Console reportando un 1% de ofuscación para otra. Establecer `AndroidCreateProguardMappingFile=true`, como sugieren algunas respuestas, no cambia nada aquí; solo controla si se escribe el archivo de mapeo.

El `-dontobfuscate` general fue la opción segura. JNI enlaza los pares administrados con las clases Java por nombre, así que renombrar un Java Callable Wrapper o un método de AndroidX enlazado rompería las búsquedas de `JNIEnv` en tiempo de ejecución. El mismo hilo encontró que eliminar la línea a mano tampoco basta: las reglas keep generadas no protegían los campos que los enlaces leen por nombre a través de JNI, así que las apps fallaban al iniciar. Espera el interruptor soportado que se describe abajo en lugar de parchear la configuración del SDK.

## Activar la ofuscación real con AndroidR8ObfuscationMode

[dotnet/android #12668](https://github.com/dotnet/android/pull/12668), fusionado el 10 de septiembre de 2026, reemplaza la regla general por una selectiva y agrega una propiedad pública:

| `AndroidR8ObfuscationMode` | Ofuscación | Base de optimización | Valor por defecto |
|---|---|---|---|
| `disabled` | ninguna, se conservan todos los nombres Java | `proguard-android.txt` | Servicio de .NET 10 |
| `private-members` | se renombran los miembros privados y de paquete | `proguard-android-optimize.txt` | .NET 11 después de RC 1 |

El mismo día, [#12752](https://github.com/dotnet/android/pull/12752) lo portó a `release/10.0.1xx` con `disabled` como valor por defecto, para que una actualización de servicio no cambie las apps existentes. Ninguna etiqueta publicada lo contiene todavía (36.1.69 es anterior, y `release/11.0.1xx-rc1` se creó antes de la fusión), así que espéralo en .NET 11 RC 2 y en la próxima actualización de servicio de .NET 10.

En el modo `private-members`, la tarea de R8 escribe estas reglas en lugar de `-dontobfuscate`:

```proguard
# Generated by the R8 task in dotnet/android main (post .NET 11 RC 1)
-keep,allowshrinking,allowoptimization class **
-keepclassmembers,allowshrinking,allowoptimization class ** {
   public protected *;
}
-keep,allowoptimization interface ** {
   public protected *;
}
-keep,allowshrinking class * implements **
```

Léelo así: cada clase conserva su nombre, cada miembro público y protegido conserva su nombre, y todo lo privado o de paquete puede renombrarse. El código no usado todavía puede eliminarse. Las reglas de interfaces existen porque la selección de proxies administrados llama a `Class.getInterfaces()`, algo que R8 no puede ver; sin ellas, la fusión de clases podría descartar una relación de interfaz y entregarle al código administrado el proxy equivocado.

Para activarlo en .NET 10 cuando llegue la versión de servicio, o para desactivarlo en .NET 11:

```xml
<!-- .NET 10 servicing (opt in) or .NET 11 (opt out with "disabled") -->
<PropertyGroup Condition="'$(Configuration)' == 'Release' And $(TargetFramework.Contains('-android'))">
  <AndroidLinkTool>r8</AndroidLinkTool>
  <AndroidR8ObfuscationMode>private-members</AndroidR8ObfuscationMode>
</PropertyGroup>
```

Cualquier otro valor hace fallar la compilación con XA1050: "The 'AndroidR8ObfuscationMode' MSBuild property has an invalid value". El PR también elimina los interruptores no documentados `_AndroidR8DontObfuscate` y `_AndroidR8DontOptimize`, así que quítalos de tu proyecto si los copiaste de algún hilo de issues.

Mantén tus expectativas calibradas. El PR informa que Google Play midió una plantilla `dotnet new maui -sc` con un 62% de optimización, 65% de reducción y 28% de ofuscación. Eso supera el umbral del 25%, pero la ofuscación es la más ajustada, porque los nombres visibles para JNI no pueden renombrarse. Trata `private-members` como "suficiente para el requisito de Play", no como protección para tu lógica en C#.

## Escribir reglas keep que realmente importan

R8 solo elimina el código Java que puede demostrar que es inalcanzable. El código para el que necesitas reglas es el código al que se llega de formas que R8 no puede ver:

```proguard
# Platforms/Android/proguard.cfg  (.NET 10 / .NET 11, R8 via AndroidLinkTool=r8)

# A Java SDK that loads its own classes with Class.forName and ships no consumer rules
-keep class com.example.vendorsdk.** { *; }

# Classes you look up by string from C#, e.g. Java.Lang.Class.ForName("com.example.Probe")
-keep class com.example.Probe { *; }

# JSON models serialized by a Java library (Gson, Moshi) that uses reflection
-keepattributes Signature,*Annotation*
-keep class com.example.api.models.** { <fields>; }

# Silence a known-harmless missing optional class instead of ignoring all warnings
-dontwarn androidx.window.extensions.**
```

Vale la pena agregar temporalmente dos reglas de diagnóstico mientras ajustas esto, porque tu propio archivo `ProguardConfiguration` se trata como configuración de la aplicación y puede usar opciones globales:

```proguard
# Temporary: dump what R8 removed and the fully merged configuration
-printusage r8-usage.txt
-printconfiguration r8-merged.txt
```

R8 resuelve esas rutas relativas respecto de la carpeta del archivo de configuración, así que ambos quedan junto a `proguard.cfg`. Busca `-dontobfuscate` en `r8-merged.txt` para confirmar qué comportamiento de ofuscación aplicó tu SDK, y busca el nombre de una clase en `r8-usage.txt` para comprobar que R8 la eliminó antes de escribirle una regla. Quita ambas líneas antes de hacer commit, porque agregan tiempo a cada compilación Release.

## Trampas que muerden en la práctica

- **Las advertencias de clases faltantes están ocultas por defecto.** `AndroidR8IgnoreWarnings` vale `True` por defecto, lo que agrega `-ignorewarnings` y (desde .NET 8) pasa `--map-diagnostics warning info`, así que los mensajes "Missing class" de R8 aparecen como líneas de información en un registro de compilación detallado. Por eso issues como [dotnet/maui #10901](https://github.com/dotnet/maui/issues/10901) (`androidx.window.extensions.WindowExtensions`) normalmente no hacen fallar la compilación. Establecerlo en `False` es más estricto y puede convertir una clase faltante en un error de compilación. Soluciónalo con un `-dontwarn` específico, no volviendo a cambiar el interruptor global.
- **Una ruta mal escrita es solo una advertencia.** Si la ruta de `ProguardConfiguration` no existe, obtienes XA4304 ("ProGuard configuration file '...' was not found") y R8 se ejecuta sin tus reglas. Trata XA4304 como error en CI con `<WarningsAsErrors>XA4304</WarningsAsErrors>`.
- **`EnableR8` y `AndroidLinkMode=r8` no hacen nada.** Ninguno existe como interruptor de R8. MSBuild acepta en silencio propiedades desconocidas, y `AndroidLinkMode` solo controla el recortador administrado (`None`, `SdkOnly`, `Full`). Solo `AndroidLinkTool=r8` activa R8.
- **Las reglas de bibliotecas con opciones globales se omiten.** A partir de .NET 11 Preview 7, un `proguard.txt` dentro de un `.aar` que contenga `-dontobfuscate`, `-dontoptimize`, `-printmapping` o similares se descarta con XA4322, que es la misma restricción que introdujo AGP 9. Si una biblioteca de un proveedor de repente falla después de la actualización, revisa el registro de compilación en busca de XA4322 y copia sus reglas keep (sin la opción global) en tu propio `proguard.cfg`.
- **La página de elementos de compilación de MS Learn está desactualizada.** Dice que los archivos `ProguardConfiguration` se ignoran a menos que `EnableProguard` sea `True`. Con `AndroidLinkTool=r8`, `AndroidEnableProguard` se fuerza a `True` por ti, así que los elementos sí se usan.
- **Las trazas de pila ofuscadas necesitan el archivo de mapeo.** Una vez que `private-members` está activado, los frames Java privados en un reporte de fallo se ven como `a.b.c`. Guarda el `mapping.txt` de cada compilación Release que distribuyas (el `.aab` lo lleva a Play, pero los reportadores de fallos como Firebase Crashlytics necesitan que se suba por separado).
- **R8 cuesta tiempo de compilación.** Espera que las compilaciones Release tarden notablemente más, ya que R8 hace un análisis de programa completo sobre todo el bytecode de AndroidX y de los servicios de Play. Mantenlo solo en Release.

## Comprobar que R8 realmente se ejecutó

No confíes solo en la propiedad; confírmalo con la salida de la compilación:

1. Compila con un registro binario: `dotnet publish -f net11.0-android -c Release -bl`. Abre `msbuild.binlog` en el MSBuild Structured Log Viewer y busca la tarea `R8` bajo `_CompileToDalvik`. Si solo encuentras `D8`, la propiedad nunca llegó a la compilación de Android, normalmente porque su condición no coincide con tu `TargetFramework`. Si R8 se ejecutó pero el registro contiene XA4304 para `proguard_project_references.cfg`, el recorte está desactivado y la app fallará en tiempo de ejecución.
2. Comprueba que `bin/Release/net11.0-android/mapping.txt` existe y tiene una marca de tiempo reciente.
3. Abre `obj/Release/net11.0-android/android-arm64/proguard/proguard_xamarin.cfg` (la carpeta RID exacta depende de tus `RuntimeIdentifiers`). En 36.1.69 o 37.0.0-rc.1.2257 empieza con `-dontobfuscate`. En un SDK con `AndroidR8ObfuscationMode=private-members`, empieza en cambio con el bloque `-keep,allowshrinking,allowoptimization class **`.
4. Sube el `.aab` a un canal de pruebas internas y lee los porcentajes de optimización, reducción y ofuscación en el explorador de app bundles de Play Console. Ese es el número que Google exige, así que es el que debes vigilar. Play lee los porcentajes de un archivo de metadatos de compilación `r8.json` cuando el bundle lo tiene, y si no, los estima a partir de `mapping.txt`. El SDK empieza a empaquetar `r8.json` con [dotnet/android #12646](https://github.com/dotnet/android/pull/12646), que está en `release/10.0.1xx` y `main` pero no en 37.0.0-rc.1.2257.

## Lecturas relacionadas

- Si Play también rechazó tu bundle por la alineación de bibliotecas nativas, la solución está en [Google Play rechaza una app MAUI por el tamaño de página de 16 KB](/es/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).
- Cambiar el runtime modifica el contenido del APK con el que trabaja R8; consulta [migrar una app MAUI para Android de Mono a CoreCLR en .NET 11](/es/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/).
- El otro requisito de Play de este ciclo se trata en [apuntar al nivel de API 36 de Android desde .NET MAUI](/es/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/).
- Cuando una compilación Release falla dentro de la cadena de herramientas de Java en lugar de hacerlo en silencio, empieza por [La compilación de Gradle no pudo producir un archivo .apk en MAUI Android](/es/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/).
- La técnica de `-printusage` de arriba es la misma que se usa para descartar R8 en [El inicio de sesión de Firebase Auth no persiste en una compilación Release de Flutter para Android](/es/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/).

## Fuentes

- [Propiedades de compilación de .NET for Android](https://learn.microsoft.com/en-us/dotnet/android/building-apps/build-properties) (`AndroidLinkTool`, `AndroidCreateProguardMappingFile`, `AndroidProguardMappingFile`, `AndroidR8IgnoreWarnings`)
- [Elementos de compilación de .NET for Android](https://learn.microsoft.com/en-us/dotnet/android/building-apps/build-items) (`ProguardConfiguration`, `AndroidAppBundleMetaDataFile`)
- [Especificación de la integración de D8 y R8](https://github.com/dotnet/android/blob/main/Documentation/guides/D8andR8.md) en dotnet/android
- [`Xamarin.Android.D8.targets`](https://github.com/dotnet/android/blob/37.0.0-rc.1.2257/src/Xamarin.Android.Build.Tasks/Xamarin.Android.D8.targets) y [`proguard_xamarin.cfg`](https://github.com/dotnet/android/blob/37.0.0-rc.1.2257/src/Xamarin.Android.Build.Tasks/Resources/proguard_xamarin.cfg) en 37.0.0-rc.1.2257
- [dotnet/android #6612: R8 sin el enlazador de .NET](https://github.com/dotnet/android/issues/6612) y [#12535: -dontobfuscate incondicional frente al requisito de Play](https://github.com/dotnet/android/issues/12535)
- [dotnet/android #12668: ofuscación y optimización configurables de miembros privados](https://github.com/dotnet/android/pull/12668) y el [backport a .NET 10 #12752](https://github.com/dotnet/android/pull/12752)
- [Android Developers Blog: reducir el uso de memoria y mejorar la migración entre dispositivos](https://android-developers.googleblog.com/2026/08/app-quality-memory-optimization-secure-onboarding.html) (requisito de optimización de DEX de febrero de 2027)
- [Optimización del código DEX en Android vitals](https://developer.android.com/topic/performance/vitals/code-optimization) (umbrales de DEX de 10 MB / 50 MB)
