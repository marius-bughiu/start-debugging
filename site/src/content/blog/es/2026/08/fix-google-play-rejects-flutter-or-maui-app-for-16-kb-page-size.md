---
title: "Solución: Google Play rechaza una app Flutter o .NET MAUI por no soportar páginas de memoria de 16 KB"
description: "Play rechaza el bundle porque un .so de 64 bits todavía tiene segmentos ELF de 4 KB. Localiza la biblioteca culpable, recompílala con NDK r28+ y verifica con zipalign -P 16."
pubDate: 2026-08-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "maui"
  - "dotnet"
  - "dotnet-10"
  - "android"
  - "gradle"
lang: "es"
translationOf: "2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size"
translatedBy: "claude"
translationDate: 2026-08-14
---

El rechazo casi nunca tiene que ver con tu código. Google Play analiza las bibliotecas nativas de 64 bits de tu app bundle y bloquea la publicación si alguna tiene segmentos `LOAD` de ELF alineados a 4 KB (`0x1000`) en lugar de 16 KB (`0x4000`). Tanto el motor de Flutter como el runtime de .NET para Android llevan tiempo publicando binarios alineados a 16 KB, así que el culpable casi siempre es un plugin de terceros o una biblioteca de binding compilada con un NDK antiguo. Localízalo, actualízalo o recompílalo, y luego confirma con `zipalign -c -P 16 -v 4`.

## El error en contexto

Al subir el bundle a la Play Console aparece un mensaje que bloquea la publicación, más o menos así:

```
Your app's native libraries are not aligned to 16 KB.
Recompile your app with 16 KB native library alignment.

lib/arm64-v8a/libsomething.so
lib/arm64-v8a/libsomething_jni.so
```

La redacción actual de la propia documentación de Google no deja dudas sobre el alcance ni sobre la fecha:

> todas las apps que apunten a Android 15 (API nivel 35) o superior deben soportar páginas de memoria de 16 KB en dispositivos de 64 bits en Google Play. A partir del 2027-02-01, si tus actualizaciones no soportan páginas de memoria de 16 KB, no podrás publicarlas.

Vale la pena conocer el historial, porque buena parte de los consejos que siguen circulando citan fechas obsoletas: el requisito llegó originalmente el 2025-11-01 para apps nuevas y actualizaciones que apuntaban a Android 15+, se podía solicitar una prórroga hasta el 2026-05-31, y el bloqueo definitivo de actualizaciones no conformes está ahora en el 2027-02-01 según la [guía de tamaños de página de Android](https://developer.android.com/guide/practices/page-sizes).

## ¿Por qué una biblioteca alineada a 4 KB falla en un dispositivo de 16 KB?

Android ha asumido históricamente una página de memoria de 4 KB. Los dispositivos que salen con Android 15 o superior pueden usar una página de 16 KB, lo que reduce la presión sobre la tabla de páginas y mejora de forma medible el arranque de la app. El enlazador dinámico mapea cada segmento `PT_LOAD` de una biblioteca compartida en una dirección alineada a página. Si el `p_align` del segmento es 4096 pero el tamaño de página del kernel es 16384, el cargador no puede respetar los límites del segmento y `dlopen` falla. El usuario ve un fallo de instalación, o un arranque que muere de inmediato en `System.loadLibrary`.

En realidad hay dos requisitos de alineación distintos, y confundirlos es la mayor fuente de confusión:

- **Alineación de segmentos ELF.** Cada segmento `PT_LOAD` dentro de cada `.so` debe tener un `p_align` de al menos 16384. Esto es una propiedad de cómo se compiló y enlazó la biblioteca.
- **Alineación de entradas del zip.** Cuando las bibliotecas nativas se almacenan sin comprimir en el APK (`extractNativeLibs="false"`, que es el valor por defecto en compilaciones modernas), el enlazador las mapea directamente desde el APK. Por tanto, las propias entradas del zip deben empezar en un límite de 16 KB. Esto es una propiedad de cómo se ensambló el paquete.

Una biblioteca puede pasar una comprobación y fallar la otra. Play comprueba ambas, y solo para ABIs de 64 bits.

## ¿Qué versiones de Flutter y .NET MAUI ya cumplen?

Ambas cadenas de herramientas llevan tiempo en regla, y por eso el archivo problemático suele ser una dependencia.

**Flutter.** Revisando el SDK estable de Flutter 3.44.2 en disco (revisión del framework `c9a6c48`, motor `77e2e94`), `packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt` fija el NDK al que resuelve `flutter.ndkVersion`:

```kotlin
// Flutter 3.44.2 stable, FlutterExtension.kt
val ndkVersion: String = "28.2.13676358"
```

Ese es NDK r28, que emite segmentos alineados a 16 KB por defecto. El `DependencyVersionChecker.kt` del mismo SDK falla de forma dura por debajo de AGP 8.6.0 y advierte por debajo de AGP 8.11.1, mientras que `gradle_utils.dart` genera proyectos nuevos con AGP 9.0.1 y Gradle 9.1.0. Todo eso queda holgadamente por encima del AGP 8.5.1 que Google indica como mínimo para una alineación correcta de bibliotecas sin comprimir. Una app con Flutter 3.44 cumple por construcción, salvo que un plugin arrastre un `.so` obsoleto.

**.NET MAUI.** El SDK de .NET para Android fija la alineación del paquete de forma explícita. De `Microsoft.Android.Sdk.DefaultProperties.targets` en `Microsoft.Android.Sdk.Windows` 36.1.53, la versión incluida con la workload de .NET 10:

```xml
<!-- Microsoft.Android.Sdk 36.1.53 (.NET 10) -->
<AndroidZipAlignment Condition=" '$(AndroidZipAlignment)' == '' ">16</AndroidZipAlignment>
```

El comentario que la acompaña indica que solo se soportan los valores `4` y `16`. Así que la mitad del requisito relativa al zip está cubierta por defecto, y nunca deberías necesitar establecer esa propiedad tú mismo. Si heredaste un proyecto que fija `<AndroidZipAlignment>4</AndroidZipAlignment>`, borra esa línea.

Para la mitad del ELF, ejecuté una comprobación de alineación sobre las bibliotecas nativas de los packs de runtime de .NET 10 para Android en esta máquina (`Microsoft.Android.Runtime.*.36.1.53` y `Microsoft.NETCore.App.Runtime.Mono.android-arm64`). Todas las bibliotecas de runtime de 64 bits reportan un `p_align` de `0x4000`: `libmonosgen-2.0.so`, `libmono-android.release.so`, `libnet-android.release.so`, `libSystem.Native.so`, `libSystem.Security.Cryptography.Native.Android.so`, `libxamarin-native-tracing.so` y las bibliotecas de componentes de Mono. Tanto la variante Mono como la de CoreCLR están limpias.

## ¿Cómo compruebo la alineación de 16 KB en un APK o un AAB?

El `check_elf_alignment.sh` de Google es un script de bash, algo incómodo si compilas en Windows. La comprobación a nivel de zip viene con las build tools de Android y funciona en todas partes:

```powershell
# Windows, Android build-tools 35.0.0 or newer
& "$env:LOCALAPPDATA\Android\sdk\build-tools\35.0.0\zipalign.exe" -c -P 16 -v 4 app-release.apk
```

Para un app bundle, `bundletool` informa de la alineación configurada:

```bash
bundletool dump config --bundle=app-release.aab
```

Sin embargo, ninguna de las dos inspecciona las cabeceras ELF. Para comprobar los segmentos en sí, el NDK incluye `llvm-objdump`:

```bash
# ANDROID_NDK points at an r28 or newer installation
$ANDROID_NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-objdump -p libfoo.so | grep LOAD
```

Una biblioteca conforme imprime `align 2**14`. Cualquier cosa en `2**12` o `2**13` falla.

Si prefieres no depender de tener el NDK instalado, las cabeceras de programa son triviales de parsear directamente. Este es el script que usé para auditar los packs de runtime de .NET de arriba, y funciona allí donde funcione Python:

```python
# check_align.py - Python 3.9+, no dependencies
import glob, os, struct, sys

PT_LOAD = 1

def load_aligns(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"\x7fELF":
        return None
    is64 = data[4] == 2
    if is64:
        e_phoff = struct.unpack_from("<Q", data, 0x20)[0]
        e_phentsize = struct.unpack_from("<H", data, 0x36)[0]
        e_phnum = struct.unpack_from("<H", data, 0x38)[0]
    else:
        e_phoff = struct.unpack_from("<I", data, 0x1C)[0]
        e_phentsize = struct.unpack_from("<H", data, 0x2A)[0]
        e_phnum = struct.unpack_from("<H", data, 0x2C)[0]
    aligns = []
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        if struct.unpack_from("<I", data, off)[0] != PT_LOAD:
            continue
        fmt, delta = ("<Q", 0x30) if is64 else ("<I", 0x1C)
        aligns.append(struct.unpack_from(fmt, data, off + delta)[0])
    return is64, aligns

for pattern in sys.argv[1:]:
    for path in sorted(glob.glob(pattern, recursive=True)):
        result = load_aligns(path)
        if result is None:
            continue
        is64, aligns = result
        if not is64:
            continue  # Play only checks 64-bit ABIs
        worst = min(aligns) if aligns else 0
        status = "ALIGNED  " if worst >= 16384 else "UNALIGNED"
        print(f"{status} p_align={hex(worst)} {os.path.basename(path)}")
```

Descomprime el AAB o el APK y apúntalo al directorio de la ABI de 64 bits:

```bash
unzip -q app-release.aab -d extracted
python check_align.py "extracted/**/lib/arm64-v8a/*.so"
```

Las bibliotecas que se imprimen como `UNALIGNED` son exactamente las que Play va a listar.

## ¿Cómo arreglo una app Flutter sin alinear?

Empieza por identificar qué plugin es dueño del archivo. Busca en tu caché de pub y en el APK compilado, y luego relaciona el `.so` con un paquete:

```bash
flutter build apk --release
unzip -l build/app/outputs/flutter-apk/app-release.apk | grep "lib/arm64-v8a"
```

Una vez sepas cuál es el culpable, ve por este orden:

1. **Actualiza el plugin.** Con diferencia, la solución más habitual. La mayoría de los paquetes mantenidos recompilaron sus binarios durante 2025. Ejecuta `flutter pub outdated`, sube la dependencia problemática, recompila y vuelve a comprobar.
2. **Actualiza el SDK de Flutter y la cadena de herramientas de Android.** Confirma que estás en Flutter 3.32 o superior, AGP 8.5.1 o superior en `settings.gradle.kts`, y que usas `android { ndkVersion = flutter.ndkVersion }` en lugar de una cadena de NDK antigua fijada a mano. Un `ndkVersion = "25.1.8937393"` explícito y obsoleto en `android/app/build.gradle.kts` echa por tierra todo lo demás sin decir nada.
3. **Recompila tú mismo el código nativo** si el plugin se compila desde el código fuente y está atascado en NDK r27 o anterior. Añade las opciones de enlazado en su `CMakeLists.txt`:

   ```cmake
   target_link_options(${CMAKE_PROJECT_NAME} PRIVATE
       "-Wl,-z,max-page-size=16384"
       "-Wl,-z,common-page-size=16384")
   ```

4. **Elimina la dependencia** si está abandonada. Un paquete sin mantenimiento con un `.so` precompilado a 4 KB y sin código fuente es un bloqueo insalvable, y ninguna opción de compilación por tu parte puede arreglarlo. Haz un fork o reemplázalo.

## ¿Cómo arreglo una app .NET MAUI sin alinear?

El runtime de .NET 10 ya cumple, así que mira tus paquetes NuGet, y en concreto las bibliotecas de binding de Android que empotran un `.aar` o un `.so` precompilado. Los SDK de publicidad, de analítica, de pagos y los runtimes de ML son los sospechosos habituales.

```bash
# .NET 10, MAUI
dotnet publish -f net10.0-android -c Release
```

Luego descomprime el `.aab` resultante de `bin/Release/net10.0-android/publish/` y ejecuta el verificador contra `base/lib/arm64-v8a/`. Cuando el culpable es una biblioteca de binding, la solución es actualizar el paquete NuGet a una versión cuyo `.aar` original se haya recompilado con NDK r28. Si no existe ninguna, te toca reempaquetar el `.aar` tú mismo con la biblioteca nativa recompilada, o eliminar la dependencia.

Dos cosas a nivel de proyecto que conviene confirmar ya que estás ahí. Asegúrate de no haber desactivado las bibliotecas nativas sin comprimir, porque todo el mecanismo de alineación del zip depende de ello, y asegúrate de no seguir apuntando a un SDK antiguo de una forma que enmascare el problema en local pero no en Play. Ninguna de las dos es una mala configuración frecuente, pero ambas producen resultados confusos cuando se dan.

## ¿Qué pasa con libc.so y las bibliotecas de 32 bits que marca mi verificador?

Dos falsos positivos que te harán perder el tiempo si auditas el directorio equivocado. Los dos aparecieron de inmediato al escanear los packs de runtime de .NET 10.

**Las bibliotecas stub no se publican.** Los packs de runtime de Android contienen `libc.so`, `libdl.so`, `liblog.so`, `libm.so` y `libz.so` con `p_align = 0x1000`. Son stubs DSO de tiempo de enlazado; las implementaciones reales vienen del dispositivo. Nunca entran en tu APK, así que su alineación es irrelevante. Esta es la razón por la que debes auditar el paquete compilado y no una carpeta `obj/` o una caché de NuGet.

**Las bibliotecas de 32 bits están exentas.** Todas las bibliotecas del pack de runtime `android-arm` (armeabi-v7a) reportan `0x1000`, y eso es correcto y permanente: un proceso de 32 bits no tiene modo de página de 16 KB que soportar. Play solo comprueba las ABIs de 64 bits, y lo mismo hace la propia comprobación en tiempo de compilación del SDK de .NET para Android, cuyo mensaje de diagnóstico dice `Not a 64-bit ELF image.  Ignored.` Filtra tu escaneo a `arm64-v8a` y `x86_64`, exactamente como hace el script de arriba.

Si quieres demostrar la solución de principio a fin en lugar de fiarte del escaneo, crea un AVD a partir de la imagen de sistema "Google APIs Experimental 16 KB Page Size" del SDK Manager, y luego confirma que el emulador realmente usa páginas de 16 KB antes de instalar:

```bash
adb shell getconf PAGE_SIZE
```

Eso debe imprimir `16384`. Una app que se instale y arranque ahí pasará la comprobación de Play.

## Relacionado

Si la compilación ni siquiera llega a producir un bundle, el fallo de fondo suele estar en otro punto de la cadena de Gradle: [la tarea de Gradle assembleDebug fallando con código de salida 1](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) y [Gradle build failed to produce an .apk file en MAUI Android](/es/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) explican cómo sacar el error real de un log envuelto. Un NDK o un componente del SDK que falta aparece como [flutter doctor informando de que falta el componente cmdline-tools](/es/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/), y los conflictos nativos a nivel de dependencia suelen manifestarse primero como un [conflicto de AndroidX durante una compilación de Flutter para Android](/es/2026/05/fix-androidx-conflict-during-flutter-android-build/). Los equipos que siguen en la pila antigua se encontrarán con todo esto a la vez durante el [paso de Xamarin.Forms a MAUI 11](/es/2026/05/migrate-from-xamarin-forms-to-maui-11/).

## Fuentes

- [Support 16 KB page sizes](https://developer.android.com/guide/practices/page-sizes) (Android Developers), para el requisito, la fecha del 2027-02-01, las comprobaciones con `zipalign` y `llvm-objdump`, y las opciones de enlazado para NDK r27 y anteriores.
- [Prepare your apps for Google Play's 16 KB page size compatibility requirement](https://android-developers.googleblog.com/2025/05/prepare-play-apps-for-devices-with-16kb-page-size.html) (Android Developers Blog), para el anuncio original del 2025-11-01.
- [Preparing your .NET MAUI apps for Google Play's 16 KB page size requirement](https://devblogs.microsoft.com/dotnet/maui-google-play-16-kb-page-size-support/) (.NET Blog), para las indicaciones del lado de .NET y las mejoras reportadas de arranque y consumo.
- Datos de versiones y alineación medidos localmente contra Flutter 3.44.2 stable y la workload de .NET 10 para Android (`Microsoft.Android.Sdk.Windows` y `Microsoft.Android.Runtime.*` 36.1.53).
