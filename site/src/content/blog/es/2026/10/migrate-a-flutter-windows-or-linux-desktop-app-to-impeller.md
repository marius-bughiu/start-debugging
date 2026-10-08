---
title: "Migra una aplicación de escritorio Flutter para Windows o Linux a Impeller (Flutter 3.47)"
description: "Flutter 3.47 convierte a Impeller en el renderizador predeterminado en Windows y Linux. Qué cambia en realidad por debajo (sigue siendo OpenGL ES, no Vulkan), cómo hacer una prueba A/B contra Skia sobre un binario compilado, un interruptor de emergencia por máquina para compilaciones de release, y por qué tus pruebas golden no lo notarán."
pubDate: 2026-10-08
updatedDate: 2026-10-08
template: migration
tags:
  - "migration"
  - "flutter"
  - "impeller"
  - "windows"
  - "linux"
lang: "es"
translationOf: "2026/10/migrate-a-flutter-windows-or-linux-desktop-app-to-impeller"
translatedBy: "claude"
translationDate: 2026-10-08
---

Flutter 3.47.0 (estable desde el 2026-08-12, Dart 3.13) cambia las aplicaciones de escritorio de Windows y Linux de Skia a Impeller sin que modifiques una sola línea del código de tu runner. Para la mayoría de las aplicaciones la migración es cuestión de una tarde: actualizar, confirmar que el registro del motor dice `Using the Impeller rendering backend (OpenGLESSDF)`, comparar capturas de pantalla y tiempos de fotograma contra una ejecución con `--no-enable-impeller`, y solo entonces decidir si publicas con Impeller o fijas Skia de forma temporal en `windows/runner/main.cpp` o `linux/runner/my_application.cc`. Lo que se rompe es sobre todo visual: la rasterización del texto (Impeller fuerza texto con campos de distancia con signo en escritorio, más una nueva corrección gamma), el antialiasing en GPU sin MSAA implícito, y algún que otro shader personalizado. Todo lo que sigue se comprobó contra el motor de Flutter 3.47.0 y el código fuente de `flutter_tools`.

## Qué cambia realmente bajo tu aplicación

Lo primero que conviene saber es lo que **no** cambia: la API gráfica. El embedder de Windows sigue renderizando mediante OpenGL ES a través de ANGLE, que lo traduce a Direct3D 11. `flutter_windows_engine.cc` en 3.47.0 crea un `egl::Manager` y un `CompositorOpenGL` sin importar el renderizador, y el embedder de Linux solo conoce dos tipos de renderizador, `opengl` y `software`. No hay ruta de Vulkan en ninguno de los dos embedders de escritorio. Impeller en escritorio es el backend GLES de Impeller ejecutándose sobre el mismo contexto GL que usaba Skia antes. En macOS es el backend Metal de Impeller.

Lo que cambia es todo lo que está por encima de las llamadas GL:

- **Los shaders vienen precompilados.** Impeller incluye un conjunto fijo de shaders ya compilados en lugar de generarlos y compilarlos en el primer uso, que es de donde venía el jank de la primera ejecución de Skia.
- **El texto se dibuja con SDF.** En Windows el embedder añade `--impeller-use-sdfs=true` siempre que Impeller está activado, a menos que pases tú mismo el switch. En Linux añade `--impeller-use-sdfs` de forma incondicional. Las notas de la versión 3.47 también añaden corrección gamma de glifos en ambas plataformas ([#187122](https://github.com/flutter/flutter/pull/187122), [#187871](https://github.com/flutter/flutter/pull/187871)).
- **El valor predeterminado está en el código del motor, no en tu proyecto.** `ImpellerSwitch::Default` significa "lo que decida el motor", y en 3.47 eso es `true` en Windows ([#188140](https://github.com/flutter/flutter/pull/188140)) y `TRUE` en `fl_dart_project_init` en Linux ([#187573](https://github.com/flutter/flutter/pull/187573)). Tu runner generado es byte por byte el mismo que en 3.44.

Ese último punto es la razón por la que esto necesita una pasada de migración deliberada. Nada en tu diff le dice a los revisores que el renderizador cambió.

## Qué se rompe

| Área | Cambio en 3.47 | Gravedad |
| --- | --- | --- |
| Renderizado de texto | Glifos SDF más corrección gamma; los bordes y el grosor de los glifos cambian ligeramente | media |
| Antialiasing | Las GPU de Windows sin MSAA implícito necesitan la ruta de MSAA fuera de pantalla ([#190374](https://github.com/flutter/flutter/pull/190374), incluido por cherry-pick en 3.47) | media |
| Capturas de pruebas de integración | Diferencias de píxeles contra líneas base capturadas con Skia | media |
| Fragment shaders personalizados | Compilados por `impellerc` para el destino GLES; los errores específicos del controlador aparecen de forma distinta | baja a media |
| Golden de `flutter test` | Sin afectar por defecto (consulta los detalles a tener en cuenta) | ninguna |
| Código del runner | Sin cambio en la plantilla; para desactivarlo hace falta una edición manual | baja |

## Lista de verificación previa

- Flutter 3.44.x todavía instalado en algún sitio (FVM, un segundo checkout o una imagen de CI) para poder compilar una línea base con Skia. Si ya ejecutas [varias versiones de Flutter desde un mismo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), añade 3.47 como una nueva rama en lugar de reemplazar la antigua.
- Una lista de las máquinas que realmente soportas: como mínimo un equipo Windows con GPU Intel integrada, uno con una GPU dedicada NVIDIA o AMD, y una máquina Linux con controladores Mesa. Las VM y las sesiones RDP merecen una fila propia.
- Un puñado de pantallas que ponen a prueba el renderizado: texto denso, texto rotado o escalado, custom painters, desenfoques y sombras, y cualquier shader de `FragmentProgram`.
- Si también publicas macOS desde la misma base de código, ten en cuenta que 3.47 sube el mínimo a macOS 12. Es una [migración aparte](/es/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/) con la que te encontrarás en la misma actualización del SDK.

## Pasos de migración

1. **Captura una línea base con Skia en 3.44.** Compila binarios de perfil y haz capturas de tus pantallas de estrés en cada máquina de destino:

   ```bash
   # Flutter 3.44.x
   flutter build windows --profile
   flutter build linux --profile
   ```

   Registra también los tiempos de fotograma. Basta con una [traza de rendimiento de DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) de los primeros 10 segundos tras el arranque y de tu desplazamiento más pesado. Verifica: tienes una traza y un conjunto de capturas por máquina.

2. **Actualiza a 3.47 y vuelve a compilar.**

   ```bash
   flutter upgrade
   flutter --version   # expect Flutter 3.47.x, Dart 3.13.x
   flutter clean
   flutter build windows --profile
   ```

   Verifica: `git status` no muestra cambios en `windows/runner/` ni en `linux/runner/`. Si los muestra, alguien ejecutó `flutter create .` y deberías revisar ese diff por separado.

3. **Confirma qué backend eligió el motor.** Ejecuta la aplicación con `flutter run -d windows` (o `-d linux`) y busca la línea de arranque del motor:

   ```text
   [IMPORTANT:flutter/shell/platform/embedder/embedder_surface_gl_impeller.cc(126)] Using the Impeller rendering backend (OpenGLESSDF).
   ```

   `OpenGLESSDF` significa Impeller con texto SDF, que es el resultado esperado en ambas plataformas. Si en cambio ves `Could not create Impeller context.`, el contexto GL no pudo satisfacer a Impeller y tienes un problema de controlador que atender antes que cualquier otra cosa. Ten en cuenta que no hay un respaldo silencioso a Skia en la superficie del embedder: la superficie de Impeller simplemente queda inválida. Verifica: la línea aparece exactamente una vez por ventana.

4. **Haz A/B del mismo binario contra Skia.** Con `flutter run`, el flag funciona en todas las plataformas de escritorio:

   ```bash
   flutter run -d windows --profile --no-enable-impeller
   ```

   Para un binario de depuración o de perfil ya compilado puedes cambiar el renderizador con las variables de entorno de switches del motor, que ambos embedders de escritorio leen mediante `GetSwitchesFromEnvironment()`:

   ```powershell
   # Flutter 3.47, Windows, debug or profile build only
   $env:FLUTTER_ENGINE_SWITCHES = "1"
   $env:FLUTTER_ENGINE_SWITCH_1 = "enable-impeller=false"
   .\build\windows\x64\runner\Profile\my_app.exe
   ```

   ```bash
   # Flutter 3.47, Linux, debug or profile build only
   FLUTTER_ENGINE_SWITCHES=1 FLUTTER_ENGINE_SWITCH_1=enable-impeller=false \
     ./build/linux/x64/profile/bundle/my_app
   ```

   Es la forma más rápida de entregarle a un tester una compilación y dos accesos directos. Verifica: la línea de registro de arranque desaparece cuando se define el switch, y vuelve cuando no.

5. **Compara capturas y trazas.** Coloca lado a lado las capturas de 3.44 con Skia, las de 3.47 con Skia y las de 3.47 con Impeller. La comparación útil es 3.47 Skia contra 3.47 Impeller, porque aísla el renderizador de todos los demás cambios de la versión. Espera que el texto se vea ligeramente distinto en todas partes. Busca lo que está mal en lugar de lo que es diferente: glifos recortados, sombras ausentes, bordes dentados en rectángulos redondeados, regiones negras. Verifica: cada diferencia está aceptada o tiene un repro mínimo.

6. **Decide y, si hace falta, fija Skia en el runner.** Si encontraste una regresión real, desactiva Impeller en la compilación desplegada. En Windows, en `windows/runner/main.cpp`:

   ```cpp
   // Flutter 3.47, windows/runner/main.cpp
   flutter::DartProject project(L"data");
   project.set_impeller_switch(flutter::ImpellerSwitch::Disabled);
   ```

   En Linux, en `linux/runner/my_application.cc`, antes de `fl_view_new(project)`:

   ```c
   // Flutter 3.47, linux/runner/my_application.cc
   g_autoptr(FlDartProject) project = fl_dart_project_new();
   fl_dart_project_set_enable_impeller(project, FALSE);
   ```

   Verifica: vuelve a compilar, ejecuta y confirma que la línea `Using the Impeller rendering backend` ya no aparece.

7. **Reporta el bug el mismo día.** La [documentación de Impeller](https://docs.flutter.dev/perf/impeller) dice que la opción de desactivarlo se eliminará en una versión futura, como ocurrió en iOS. Abre un issue con el prefijo `[Impeller]` en el título, un repro mínimo, la GPU y la versión del controlador, capturas de pantalla y una traza de rendimiento comprimida en zip. Verifica: el enlace al issue está en un comentario junto a la línea que lo desactiva, para que quien la elimine más adelante sepa por qué está ahí.

## Un interruptor de emergencia por máquina para compilaciones de release

El truco de `FLUTTER_ENGINE_SWITCHES` del paso 4 no funciona en compilaciones de release. `engine_switches.cc` envuelve toda la búsqueda en `#ifndef FLUTTER_RELEASE`, así que una aplicación distribuida la ignora. Si quieres publicar con Impeller pero conservar una vía de escape para el cliente cuya laptop de 2017 dibuja una ventana negra, lee tu propia variable de entorno en el runner:

```cpp
// Flutter 3.47, windows/runner/main.cpp
#include <cwchar>

flutter::DartProject project(L"data");

wchar_t value[8];
DWORD length = ::GetEnvironmentVariableW(L"MYAPP_DISABLE_IMPELLER", value, 8);
if (length > 0 && length < 8 && std::wcscmp(value, L"1") == 0) {
  project.set_impeller_switch(flutter::ImpellerSwitch::Disabled);
}
```

```c
// Flutter 3.47, linux/runner/my_application.cc
g_autoptr(FlDartProject) project = fl_dart_project_new();
if (g_strcmp0(g_getenv("MYAPP_DISABLE_IMPELLER"), "1") == 0) {
  fl_dart_project_set_enable_impeller(project, FALSE);
}
```

Soporte puede entonces indicarle al usuario afectado que defina una variable en lugar de esperar una nueva compilación. Un valor del registro o una línea en un archivo de configuración junto al ejecutable funciona igual si las variables de entorno resultan incómodas para tus usuarios. Trátalo como andamiaje temporal con la misma vida útil que la opción de desactivación del motor.

## Verificación

Tras la migración, en cada máquina de tu matriz:

- La aplicación arranca y el registro muestra `OpenGLESSDF` (o ninguna línea de Impeller si fijaste Skia).
- Tus pruebas de integración pasan. Las basadas en capturas necesitan nuevas líneas base; regéneralas en 3.47 de forma deliberada en lugar de dejar que una ejecución masiva de "update goldens" oculte una regresión real.
- El primer arranque tras una instalación limpia no tiene jank de compilación de shaders en la línea de tiempo. Esta es la mejora por la que estás pagando, así que mídela.
- Los tiempos de fotograma en estado estable de tu pantalla más pesada están dentro de tu presupuesto. Impeller no es uniformemente más rápido en cada fotograma; es más predecible.
- Redimensionar la ventana rápidamente no provoca un fallo en Linux (un fallo al redimensionar se corrigió durante el ciclo de 3.47 en [#187626](https://github.com/flutter/flutter/pull/187626), lo cual es una buena razón para no hacer cherry-pick de una beta anterior).

## Plan de reversión

La reversión es barata y reversible en ambos sentidos. Puedes bajar a 3.44.x, que nunca activó Impeller de forma predeterminada en Windows ni Linux, o quedarte en 3.47 y añadir la desactivación en el runner del paso 6. La segunda opción es mejor: conservas todas las demás correcciones de 3.47 y puedes volver atrás borrando una sola línea. Simplemente no cuentes con que la opción de desactivación exista para siempre.

## Detalles a tener en cuenta

**Los switches de entorno prevalecen sobre el switch del proyecto en Windows.** En el constructor de `FlutterWindowsEngine` primero se lee el `ImpellerSwitch` del proyecto, y luego el bucle sobre los switches de entorno lo sobrescribe. Un desarrollador con `FLUTTER_ENGINE_SWITCH_1=enable-impeller=true` olvidado en el perfil de su shell verá Impeller incluso en una rama que fijó `Disabled`. Revisa `env` antes de depurar cualquier otra cosa.

**`ImpellerSwitch::Default` no es `Enabled`.** Si quieres dejar Impeller activado pase lo que pase en una versión futura, establece `ImpellerSwitch::Enabled` de forma explícita. `Default` sigue al motor, que es exactamente lo que cambió bajo tus pies en 3.47.

**Los golden de `flutter test` no ven Impeller.** `flutter_tester_device.dart` lanza el shell de pruebas con `--enable-software-rendering --skia-deterministic-rendering` a menos que pases `--enable-impeller`. Tus golden de pruebas de widgets siguen pasando tras la actualización, lo cual no te dice nada sobre el renderizador de escritorio. Solo las pruebas de integración que ejecutan el `.exe` real o el bundle de Linux ejercitan Impeller.

**La desactivación en Linux tiene que ocurrir antes de que exista la vista.** `fl_dart_project_set_enable_impeller` establece un campo que `FlEngine` lee cuando arranca. Llámala justo después de `fl_dart_project_new()` y antes de `fl_view_new(project)`, no más tarde en `my_application_activate`.

**Las laptops con GPU híbrida eligen una GPU antes de que importe el renderizador.** En Windows, `DartProject::set_gpu_preference` con `flutter::GpuPreference::HighPerformancePreference` o `LowPowerPreference` decide qué adaptador usa ANGLE. Si una regresión solo se reproduce en una laptop con GPU Intel y NVIDIA a la vez, prueba ambas preferencias antes de culpar a Impeller.

**VM y sesiones remotas.** Las máquinas sin soporte de MSAA implícito sufrían una pantalla negra en Windows al principio del ciclo de 3.47; [#187288](https://github.com/flutter/flutter/pull/187288) y el respaldo de MSAA fuera de pantalla de [#190374](https://github.com/flutter/flutter/pull/190374) lo resolvieron. Si ves una ventana negra en una VM, confirma que tienes el último parche de 3.47 antes de abrir un nuevo issue.

**Shaders personalizados.** Los shaders de `FragmentProgram` siguen funcionando, pero ahora los ejecuta el backend GLES de Impeller sobre el controlador que exponga ANGLE o Mesa. Vuelve a probar cada archivo `.frag` en tu GPU soportada más antigua y evita depender de un comportamiento de precisión que casualmente funcionaba con Skia.

**La opción de desactivación tiene un plazo.** Cada desactivación que añades es una deuda con una fecha límite que no controlas. Pon el enlace al issue junto a ella y revísala en cada actualización de Flutter.

## Relacionado

- El resumen del día del lanzamiento de este cambio: [Flutter 3.47 makes Impeller the default renderer on Windows, Linux, and macOS](/es/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/).
- Medir el antes y el después: [cómo perfilar el jank en una aplicación Flutter con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).
- Ejecutar 3.44 y 3.47 en paralelo: [apuntar a varias versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).
- La otra migración de escritorio de la misma versión: [subir el destino de implementación de una aplicación Flutter para macOS a macOS 12](/es/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/).
- La decisión equivalente de renderizador en la web: [CanvasKit vs skwasm para Flutter web en 2026](/es/2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026/).

## Fuentes

- [Impeller rendering engine](https://docs.flutter.dev/perf/impeller) en docs.flutter.dev (estado en escritorio, fragmentos para desactivarlo, lista de verificación para reportar bugs).
- [Notas de la versión de Flutter 3.47.0](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0).
- [flutter/flutter#188140](https://github.com/flutter/flutter/pull/188140): convierte a Impeller en el renderizador predeterminado en Windows.
- [flutter/flutter#187573](https://github.com/flutter/flutter/pull/187573): activa Impeller de forma predeterminada en Linux.
- [flutter/flutter#188044](https://github.com/flutter/flutter/pull/188044): añade el switch de proyecto de Windows.
- [flutter/flutter#187288](https://github.com/flutter/flutter/pull/187288): corrige la pantalla negra en la ruta OpenGL de Windows.
- Código fuente de Flutter 3.47.0: `engine/src/flutter/shell/platform/windows/flutter_windows_engine.cc`, `engine/src/flutter/shell/platform/linux/fl_engine.cc`, `engine/src/flutter/shell/platform/common/engine_switches.cc` y `packages/flutter_tools/lib/src/test/flutter_tester_device.dart`.
