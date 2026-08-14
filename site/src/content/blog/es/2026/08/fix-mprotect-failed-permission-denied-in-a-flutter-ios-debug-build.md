---
title: "Solución: mprotect failed: 13 (Permission denied) en una compilación debug de Flutter para iOS"
description: "iOS impide que la Dart VM marque páginas de memoria como ejecutables, así que el JIT muere al arrancar. Actualiza a Flutter 3.35.0 o posterior para iOS 26, y a 3.32.0 para iOS 18.4. No hay entitlement que lo resuelva."
pubDate: 2026-08-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "ios"
  - "xcode"
lang: "es"
translationOf: "2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build"
translatedBy: "claude"
translationDate: 2026-08-14
---

Actualiza Flutter. Este fallo es iOS negándose a dejar que la Dart VM convierta una página de memoria escribible en ejecutable, que es exactamente lo que necesita el JIT y exactamente sobre lo que corre el modo debug. Flutter 3.35.0 (Dart 3.9.0, 2025-08-14) es la primera versión estable que sobrevive a esto en dispositivos físicos con iOS 26; Flutter 3.32.0 (Dart 3.8.0) fue la primera que sobrevivió en iOS 18.4. No existe entitlement, clave de Info.plist ni flag de compilación que puedas añadir a un SDK antiguo para hacer que desaparezca. Si ya estás en 3.35.0 o posterior y sigue fallando, a tu esquema de Xcode le falta el LLDB Init File, que es la segunda mitad de la solución.

## El fallo, completo

La app muere durante `Dart_Initialize`, antes de que se construya un solo widget:

```
../../../flutter/third_party/dart/runtime/vm/virtual_memory_posix.cc: 428: error: mprotect failed: 13 (Permission denied)
version=3.7.0 (stable) (Wed Feb 5 04:53:58 2025 -0800) on "ios_arm64"
pid=726, thread=259, isolate_group=vm-isolate(0x11ea52800), isolate=vm-isolate(0x11ebe5800)
os=ios, arch=arm64, comp=no, sim=no
  pc 0x0000000110302e84 fp 0x000000016eee4f50 Dart_DumpNativeStackTrace+0x18
  pc 0x000000010feb1428 fp 0x000000016eee4f70 dart::Assert::Fail(char const*, ...) const+0x30
  pc 0x000000010ffac33c fp 0x000000016eee5420 dart::Code::FinalizeCode(...)+0x82c
  pc 0x0000000110039cb0 fp 0x000000016eee5a30 dart::StubCode::Init()+0x320
  pc 0x000000010fefc4f4 fp 0x000000016eee64e0 dart::Dart::DartInit(Dart_InitializeParams const*)+0x2b18
  pc 0x00000001102e9754 fp 0x000000016eee6960 Dart_Initialize+0x60
  pc 0x000000010fe71e24 fp 0x000000016eee6f30 flutter::DartVM::Create(...)+0x1d64
=== Crash occurred when compiling unknown function in unoptimized JIT mode in unknown pass
```

Tres detalles lo identifican sin lugar a dudas. El frame es `dart::StubCode::Init()`, que se ejecuta antes de que exista tu código, así que nada de tu Dart es responsable. El `13` es `EACCES` del `mprotect` de POSIX. Y la última línea nombra el modo JIT explícitamente.

## Por qué iOS rechaza la llamada a mprotect

Las compilaciones debug de Flutter ejecutan la Dart VM en modo JIT. Eso no es un detalle de implementación del que puedas salirte: el hot reload funciona compilando Dart nuevo a código máquina dentro del proceso en ejecución, lo que significa que la VM escribe bytes en una página y luego los ejecuta.

La política W^X de Apple dice que una página puede ser escribible o ejecutable, nunca ambas a la vez. La forma clásica de sortearlo es reservar una página RW, escribir el código compilado y luego llamar a `mprotect(PROT_READ | PROT_EXEC)` para cambiarla. La Dart VM hacía exactamente eso, en `VirtualMemory::Protect` dentro de `runtime/vm/virtual_memory_posix.cc`.

A partir de las betas de iOS 18.4, y con más rigor todavía en iOS 26, el kernel dejó de permitir esa transición a las apps de terceros, incluso con el entitlement `get-task-allow` que lleva una compilación de desarrollo. `mprotect` devuelve `EACCES`, salta el `ASSERT` de la VM y el proceso aborta. Esto es todo el contenido de [flutter/flutter#163984](https://github.com/flutter/flutter/issues/163984), un P1 que estuvo abierto de febrero a julio de 2025 y acumuló 61 comentarios.

Dos consecuencias que conviene interiorizar antes de empezar a cambiar cosas:

**Las compilaciones release y profile no se ven afectadas.** Son AOT. El código máquina ya está en el binario de la app, el cargador lo mapea como ejecutable y la VM nunca pide un cambio de protección. Si tu CI está en verde y tu build de TestFlight arranca, eso es lo esperado y no es prueba de que tu configuración esté bien.

**El simulador no se ve afectado.** Corre sobre el kernel de macOS, que no aplica la restricción. Un equipo donde una persona prueba en simulador y otra en dispositivo verá esto partido justo por la mitad, que es lo que hace tan confusa la primera hora de depuración.

## Qué versión de Flutter necesito realmente

La solución llegó en dos piezas, en dos versiones estables distintas. Verifiqué la ascendencia de los commits con la API de comparación de GitHub contra las etiquetas de release del SDK de Dart, en lugar de fiarme del hilo del issue.

| Objetivo | Primera estable que funciona | Dart | Publicada |
| --- | --- | --- | --- |
| Dispositivo físico con iOS 18.4 | Flutter 3.32.0 | 3.8.0 | 2025-05-20 |
| Dispositivo físico con iOS 26 | Flutter 3.35.0 | 3.9.0 | 2025-08-14 |
| iOS 26, la herramienta maneja LLDB | Flutter 3.38.0 | 3.10.0 | 2025-11-12 |

La primera pieza es el hook `NOTIFY_DEBUGGER_ABOUT_RX_PAGES` en la VM, añadido en el commit `939699a9` de Dart el 2025-02-28. Es ancestro de la etiqueta `3.8.0`, así que todo desde Flutter 3.32.0 en adelante lo tiene.

La segunda pieza es el mapeo dual de páginas de código, tres commits de junio de 2025 (`d194fcec`, `dc0567c0`, `c111f693`). Esos son ancestros de `3.9.0` pero no de `3.8.1`, y por eso 3.32.x falla en iOS 26 mientras que 3.35.0 no. En lugar de cambiar la protección de un único mapeo, la VM ahora mapea la misma memoria física dos veces: una vista RW por la que escribe el compilador, y una vista RX separada desde la que ejecuta la CPU. Ninguna llamada a `mprotect`, nada que el kernel pueda rechazar.

Así que la instrucción práctica es una línea:

```bash
# Latest stable at time of writing is 3.47.0 (Dart 3.13.0, 2026-08-12)
flutter upgrade
flutter clean
```

El `flutter clean` no es superstición. La herramienta de Flutter escribe archivos LLDB generados en `ios/Flutter/ephemeral/`, y las copias obsoletas de un SDK anterior provocaron fallos que se reportaron repetidamente en el issue mientras se desplegaba la solución.

## Estoy en Flutter 3.35 o posterior y sigue fallando

Entonces la VM está bien y el lado del depurador no. El mapeo dual es necesario pero no suficiente: el mapeo RX solo se vuelve válido cuando el depurador toca las páginas, así que LLDB tiene que formar parte del arranque. Flutter lo conecta a través del esquema de Xcode, y si al esquema le falta ese ajuste, recuperas el mismo fallo de `mprotect`.

La herramienta intenta migrar el esquema por ti en cada compilación debug o profile. Cuando no puede, imprime esto:

```
Running Flutter in debug mode on new iOS versions requires a LLDB Init File,
but the Runner scheme does not have it set. To ensure debug mode works, please
complete the following:
  * Open Xcode > Product > Scheme > Edit Scheme and for the Run and Test actions,
    set LLDB Init File to:

  $(SRCROOT)/Flutter/ephemeral/flutter_lldbinit
```

Haz exactamente eso, y fíjate en que quiere tanto la acción Run como la acción Test. La migración comprueba cada una por separado y se quejará de la que falte. Si ya tienes tu propio LLDB Init File, Flutter no lo sobrescribirá; en su lugar te dice que encadenes al suyo desde el tuyo:

```
command source /path/to/ios/Flutter/ephemeral/flutter_lldbinit
```

Para un proyecto add-to-app la ruta es distinta, porque el módulo Flutter se compila como un paquete Swift y los archivos generados acaban en la salida del paquete. Configura el LLDB Init File del esquema como `$(FLUTTER_SWIFT_PACKAGE_OUTPUT)/Scripts/flutter_lldbinit`, o inclúyelo de forma relativa a tu propio archivo:

```
command source --relative-to-command-file "../my_flutter_app/build/ios/SwiftPackages/Scripts/flutter_lldbinit"
```

Los hosts add-to-app reciben aquí una advertencia en lugar de un error, porque la herramienta no puede saber cuál de tus esquemas es el que usas para lanzar. Escanea todos los `.xcscheme` del proyecto buscando la cadena `customLLDBInitFile` y solo avisa si ninguno la tiene. Un proyecto con cinco esquemas donde el configurado es el equivocado pasará esa comprobación y seguirá fallando.

## Cómo funciona el JIT ahora, si mprotect está bloqueado

Vale la pena entenderlo, porque explica la restricción de la sección siguiente.

El `ios/Flutter/ephemeral/flutter_lldb_helper.py` generado pone un punto de interrupción en un símbolo que la VM exporta solo como señal para el depurador, y luego escribe en las páginas desde el lado del depurador, al que sí se le permite modificar la memoria ejecutable de un proceso depurado:

```python
# Generated by Flutter 3.44.2 into ios/Flutter/ephemeral/flutter_lldb_helper.py
import lldb

def handle_new_rx_page(frame: lldb.SBFrame, bp_loc, extra_args, intern_dict):
    """Intercept NOTIFY_DEBUGGER_ABOUT_RX_PAGES and touch the pages."""
    base = frame.register["x0"].GetValueAsAddress()
    page_len = frame.register["x1"].GetValueAsUnsigned()

    data = bytearray(page_len)
    data[0:8] = b'IHELPED!'

    error = lldb.SBError()
    frame.GetThread().GetProcess().WriteMemory(base, data, error)
    if not error.Success():
        print(f'Failed to write into {base}[+{page_len}]', error)
        return

def __lldb_init_module(debugger: lldb.SBDebugger, _):
    target = debugger.GetDummyTarget()
    bp = target.BreakpointCreateByRegex("^NOTIFY_DEBUGGER_ABOUT_RX_PAGES$")
    bp.SetScriptCallbackFunction('{}.handle_new_rx_page'.format(__name__))
    bp.SetAutoContinue(True)
    print("-- LLDB integration loaded --")
```

El marcador `IHELPED!` es un diagnóstico: `NOTIFY_DEBUGGER_ABOUT_RX_PAGES` vuelve a leer los primeros ocho bytes y puede así distinguir entre "el depurador se encargó de esto" y "nunca se puso un punto de interrupción", que es la diferencia entre una configuración que funciona y el fallo del principio de este artículo.

Si ves `-- LLDB integration loaded --` en la consola de Xcode, el init file está bien conectado.

## Qué cambió en Flutter 3.38 y posteriores

Desde Flutter 3.38.0 la herramienta dejó de delegar en Xcode para los dispositivos físicos y maneja `devicectl` y `lldb` por su cuenta (PRs [#173417](https://github.com/flutter/flutter/pull/173417), [#173443](https://github.com/flutter/flutter/pull/173443) y [#173724](https://github.com/flutter/flutter/pull/173724)). `flutter run` lanza la app detenida y luego alimenta a LLDB con esta secuencia:

```
device select <device-id>
breakpoint set --func-regex '^NOTIFY_DEBUGGER_ABOUT_RX_PAGES$'
breakpoint command add --script-type python <breakpoint-id>
device process attach --pid <app-pid>
process continue
```

Está detrás de un feature flag activado por defecto en todos los canales. Confirmado contra una instalación local de Flutter 3.44.2, `packages/flutter_tools/lib/src/features.dart` declara:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/features.dart
const lldbDebugging = Feature(
  name: 'support for debugging with LLDB for physical iOS devices',
  configSetting: 'enable-lldb-debugging',
  environmentOverride: 'FLUTTER_LLDB_DEBUGGING',
  master: FeatureChannelSetting(available: true, enabledByDefault: true),
  beta: FeatureChannelSetting(available: true, enabledByDefault: true),
  stable: FeatureChannelSetting(available: true, enabledByDefault: true),
);
```

Requiere iOS 17 o posterior y Xcode 26 o posterior. Por debajo de cualquiera de los dos umbrales, la herramienta cae silenciosamente al arranque vía Xcode, y por eso una máquina que todavía tiene Xcode 16 puede mostrar síntomas completamente distintos a los de un colega con la misma versión de Flutter. Comprueba `xcodebuild -version` antes de comparar notas.

Puedes desactivarlo de forma global o por proyecto si se porta mal:

```bash
flutter config --no-enable-lldb-debugging
```

```yaml
# pubspec.yaml, disables LLDB debugging for this project only
flutter:
  config:
    enable-lldb-debugging: false
```

## Qué hago si no puedo actualizar Flutter

Si estás anclado a un SDK antiguo, y los anclajes en 3.7.x eran comunes en el hilo del issue, no hay backport ni hay solución dentro de la app. Tus opciones son probar en el simulador, probar en un dispositivo que siga con iOS 18.3 o anterior, o ejecutar `flutter run --profile`, que es AOT y por tanto inmune. El modo profile te cuesta el hot reload pero conserva DevTools, la línea de tiempo y el inspector de widgets, así que es un parche usable para trabajo de UI que no sea muy iterativo.

Actualizar un SDK anclado desde hace mucho a lo largo de cuatro versiones estables es un proyecto en sí mismo. Si gestionas varias apps con anclajes distintos, [apuntar a varias versiones de Flutter desde un mismo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) es la forma más barata de escalonarlo en lugar de actualizarlo todo a la vez.

## Trampas que parecen este bug pero no lo son

**Una compilación debug ahora necesita que el depurador siga conectado.** Arrancar un debugserver en el dispositivo es lo que hace legal el JIT, así que una compilación debug lanzada desde la pantalla de inicio sin depurador conectado fallará igual. Esto no es una regresión que reportar; es el mecanismo. Usa una compilación profile o release para cualquier cosa que entregues a alguien que pruebe.

**La depuración inalámbrica en iOS 26 es lenta, no está rota.** Flutter 3.44 imprime "Wireless debugging on iOS 26 may be slower than expected. For better performance, consider using a wired (USB) connection." Cada entrega de una página RX es un viaje de ida y vuelta al depurador, y por Wi-Fi eso se acumula. Varios reportes de bloqueos de diez segundos en el issue original resultaron ser esto. Conecta el cable antes de abrir un bug.

**Compilaciones release en CI quejándose de `customLLDBInitFile`.** La migración del esquema solo corre para compilaciones debug y profile, pero un esquema mal configurado puede aparecer igualmente en pipelines de release. Si tu CI falla por el init file en una compilación release, el problema es el esquema, no este fallo: una compilación release no tiene JIT y no necesita LLDB.

**Los flavors tienen sus propios esquemas.** Flutter migra el esquema que resuelve para el flavor que se está compilando. Si tienes esquemas `dev`, `staging` y `prod` y solo ejecutas `dev` localmente, los otros dos quedan sin migrar hasta que alguien los compile, y cada uno fallará una vez.

**Cualquier cosa que mencione `mprotect` en Android es otro problema.** Los fallos de compilación en Android relacionados con páginas de memoria casi siempre son el requisito de páginas de 16 KB, que es un asunto de empaquetado y alineación, no de JIT. Eso tiene [su propia solución con NDK r28 y zipalign](/es/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).

## Relacionado

Si la app nunca llega a lanzarse, el fallo está antes de la VM: [Failed to build iOS app con Xcode 16 y Flutter 3.x](/es/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/) y [CocoaPods no encuentra versiones compatibles para un pod](/es/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/) cubren los dos fallos que explican la mayor parte del resto. Como este crash solo se reproduce en hardware, también vale la pena tener un [flujo de trabajo con dispositivo real para depurar Flutter iOS desde Windows](/es/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) para que un Mac no sea un requisito previo para reproducirlo. Y si la actualización a 3.35 o posterior arrastra mucha otra rotura, la [checklist de null safety de Flutter 3.x](/es/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) es el orden que uso para bases de código antiguas.

## Fuentes

- [Debug mode and hot reload fail on iOS 26 due to JIT restriction `error: mprotect failed: 13 (Permission denied)`](https://github.com/flutter/flutter/issues/163984), el issue P1 de seguimiento, por el volcado original del crash y la cronología de la solución.
- [Add lldb init file](https://github.com/flutter/flutter/pull/164344) (flutter/flutter#164344, mergeado el 2025-03-06), incluido en las [notas de la versión Flutter 3.32.0](https://docs.flutter.dev/release/release-notes/release-notes-3.32.0).
- [Notas de la versión Flutter 3.38.0](https://docs.flutter.dev/release/release-notes/release-notes-3.38.0), por LLDB y `devicectl` convirtiéndose en la ruta de arranque por defecto en iOS 17+ con Xcode 26+.
- [Integrate a Flutter app into your iOS project](https://docs.flutter.dev/add-to-app/ios/project-setup), por las rutas del LLDB Init File en add-to-app.
- Commits del SDK de Dart `939699a9` (`[vm] Add NOTIFY_DEBUGGER_ABOUT_RX_PAGES hook`), `d194fcec` (`[vm] Use dual mapping of code pages on certain OS versions`), `dc0567c0` y `c111f693`, con la ascendencia de etiquetas comprobada contra los tags de release `3.8.1` y `3.9.0`.
- Código citado de una instalación local de Flutter 3.44.2 stable: `packages/flutter_tools/lib/src/features.dart`, `lib/src/ios/lldb.dart`, `lib/src/xcode_project.dart`, `lib/src/migrations/lldb_init_migration.dart` y `lib/src/build_system/targets/ios.dart`.
