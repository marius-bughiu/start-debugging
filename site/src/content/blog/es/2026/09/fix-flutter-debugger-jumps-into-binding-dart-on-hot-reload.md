---
title: "Solución: el depurador de Flutter salta a binding.dart en cada hot reload sin mostrar ningún error"
description: "Un bug de dwds en Flutter 3.35 para web enviaba una pausa falsa en cada hot reload. Actualiza a Flutter 3.38+, o vuelve a poner VS Code en 'Debug my code' para que se omitan los frames de paquetes."
pubDate: 2026-09-26
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-web"
  - "hot-reload"
  - "vs-code"
  - "debugging"
lang: "es"
translationOf: "2026/09/fix-flutter-debugger-jumps-into-binding-dart-on-hot-reload"
translatedBy: "claude"
translationDate: 2026-09-26
---

Si ejecutas una aplicación Flutter web desde VS Code o Android Studio y cada hot reload abre `package:flutter/src/foundation/binding.dart` (normalmente cerca de la línea 845) sin ninguna excepción a la vista, no estás haciendo nada mal. Es un bug de dwds, el servicio de depuración web, que llegó con Flutter 3.35: durante un hot reload pausaba Chrome para volver a registrar los puntos de interrupción y reportaba esa pausa interna al IDE como si fuera real. Se corrigió en dwds 25.1.0+1, que llegó por primera vez a stable en Flutter 3.38.0. Actualiza (la versión stable actual es 3.47.5). Si estás atascado en 3.35.x, cambia el modo de depuración de VS Code en la barra de estado de vuelta a "Debug my code" (depurar mi código), o pasa `--no-web-experimental-hot-reload`.

Todo lo que sigue se verificó contra el código fuente de Flutter 3.35.4, 3.35.7, 3.38.0 y 3.47.5, los changelogs de dwds 24.4.0+2 y 25.1.0+1, y el esquema de configuración de Dart-Code 3.144.

## El error en contexto

No hay texto de error, y esa es la parte confusa. Guardas un archivo (o pulsas el botón de hot reload), la recarga termina y luego el editor cambia a un archivo que nunca abriste:

```text
package:flutter/src/foundation/binding.dart   (line 845, highlighted as the current frame)

  @protected
  void postEvent(String eventKind, Map<String, dynamic> eventData) {
    developer.postEvent(eventKind, eventData);   // <- debugger "paused" here
  }
```

El panel CALL STACK dice que el isolate está pausado, pero no por una excepción ni en un punto de interrupción. Pulsas Continue, la aplicación sigue ejecutándose y vuelve a pasar en la siguiente recarga. Algunas personas ven otro archivo, con un mensaje en lugar del código fuente:

```text
Could not load source 'package:flutter/src/foundation/binding.dart': Bad state: source reference is no longer valid.
```

Variantes del mismo reporte mencionan `package:flutter/src/painting/decoration_image.dart` o `package:provider/src/devtool.dart`. Esa lista resulta ser la mejor pista de lo que está pasando.

El reporte típico es Flutter 3.35.4 o 3.35.5 en el canal stable, Dart 3.9.2, ejecutándose en Chrome y depurado desde VS Code. El mismo síntoma se confirmó en Android Studio. Ejecutar `flutter run -d chrome` en una terminal no lo muestra, porque en una terminal nada salta a un archivo fuente.

## Por qué el depurador se detiene en binding.dart

Flutter 3.35 activó por defecto el hot reload con estado para la web (el flag `--web-experimental-hot-reload` pasó a `defaultsTo: true`). Para que tus puntos de interrupción sigan funcionando a través de una recarga, dwds pausa el isolate de JavaScript en Chrome, vuelve a registrar los puntos de interrupción contra el código nuevo y reanuda. Esa pausa es un detalle de implementación. El bug era que dwds 24.4.x siempre emitía un evento `PauseInterrupted` al pausar, incluida esta pausa interna.

El IDE no puede notar la diferencia. Como lo explicó Danny Tuppeny, mantenedor de Dart-Code, en [flutter/flutter#176693](https://github.com/flutter/flutter/issues/176693), el evento `PauseInterrupted` enviado durante la recarga "to DAP/VS Code looks like a legitimate pause" (para DAP/VS Code parece una pausa legítima). Así que VS Code hace lo que hace con cualquier pausa: toma el frame superior de la pila de llamadas y abre ese archivo.

¿Qué archivo? El código Dart que se estuviera ejecutando cuando Chrome pausó. En una compilación de depuración, Flutter publica eventos del VM service constantemente: `SchedulerBinding` envía `Flutter.Frame` después de los frames, las extensiones de servicio envían `Flutter.ServiceExtensionStateChanged`, y todo eso pasa por un único método en `BindingBase`:

```dart
// Flutter 3.35.4, packages/flutter/lib/src/foundation/binding.dart, lines 843-846
@protected
void postEvent(String eventKind, Map<String, dynamic> eventData) {
  developer.postEvent(eventKind, eventData);
}
```

En el código fuente de 3.35.4, `developer.postEvent(eventKind, eventData);` es exactamente la línea 845, y por eso tantos reportes mencionan esa línea. Los otros archivos donde cae la gente también llaman a `postEvent`: `decoration_image.dart` llama a `developer.postEvent('Flutter.ImageSizesForFrame', ...)`, y `devtool.dart` de `provider` publica sus propios eventos para la extensión Provider DevTools. La pausa cae sobre quien sea que esté hablando con el VM service en ese instante.

La variante "source reference is no longer valid" es la misma pausa con peor sincronización: la recarga acaba de cambiar los scripts por los nuevos, así que la referencia al script asociada al frame obsoleto ya no se resuelve.

### Por qué solo algunos desarrolladores lo vieron

VS Code solo salta a un frame pausado si cuenta como tu código. Dart-Code lo decide con dos configuraciones, ambas en `false` por defecto:

- `dart.debugSdkLibraries`: marca las bibliotecas `dart:*` como depurables.
- `dart.debugExternalPackageLibraries`: marca los paquetes externos de pub como depurables, y el esquema de Dart-Code es explícito en que esto incluye `package:flutter`.

Son las mismas configuraciones que recorre el elemento de la barra de estado mientras hay una sesión de depuración activa: "Debug my code", "Debug my code + packages", "Debug my code + packages + SDK". Con el valor por defecto "Debug my code", todos los frames de la pausa falsa pertenecen a `package:flutter`, ninguno cuenta como código de usuario y VS Code no tiene adónde saltar. Si alguna vez cambiaste a "+ packages" para entrar en un método del framework, `binding.dart` pasó a ser "tu" código y el editor saltaba ahí en cada recarga. Por eso también un miembro del equipo de Flutter probó primero 3.35.6, no vio ningún problema y marcó el issue como corregido, antes de que Danny señalara que la grabación usaba "Debug my code".

## Reproducción mínima

Solo necesitas esto si quieres confirmar que te estás topando con este bug y no con otra cosa.

```bash
# Flutter 3.35.4 stable, Dart 3.9.2, Chrome, VS Code with Dart-Code
flutter create repro_binding
cd repro_binding
code .
```

```jsonc
// .vscode/settings.json -- Flutter 3.35.x, Dart-Code extension
{
  "dart.debugExternalPackageLibraries": true
}
```

Selecciona Chrome como dispositivo, pulsa F5, cambia el texto del contador en `lib/main.dart` y guarda. En 3.35.x el editor abre `binding.dart` en la línea de `developer.postEvent`. Quita la configuración (o elige "Debug my code" en la barra de estado) y el salto se detiene, aunque el isolate sigue pausándose brevemente. En Flutter 3.38.0 o posterior no ocurre ninguna de las dos cosas.

## Solución 1: actualiza a Flutter 3.38 o posterior

Esta es la solución real. El cambio en dwds es [dart-lang/webdev#2695](https://github.com/dart-lang/webdev/pull/2695), "Don't send PauseInterrupted event during a hot reload", fusionado el 2025-10-09. En lugar de enviar un evento de pausa normal, `ChromeProxyService` ahora le indica al depurador que la pausa es interna, y el depurador señala la finalización mediante un completer en lugar de un evento. Se publicó como el hotfix `25.1.0+1` de dwds, cuya entrada en el changelog dice "Fix an issue in `reloadSources` where a `PauseInterrupted` event was sent" y enlaza a [dart-lang/sdk#61560](https://github.com/dart-lang/sdk/issues/61560).

Lo que te importa es qué versión de dwds fija tu SDK de Flutter en `packages/flutter_tools/pubspec.yaml`:

| Flutter | dwds fijado | Pausa falsa en hot reload web |
| --- | --- | --- |
| 3.32.8 | 24.3.10 | No (hot reload web con estado desactivado por defecto) |
| 3.35.4 | 24.4.0+2 | Sí |
| 3.35.7 (último hotfix de 3.35) | 24.4.0+2 | Sí |
| 3.38.0 | 25.1.0+2 | No |
| 3.47.5 (stable, septiembre de 2026) | 27.1.2 | No |

La corrección nunca se aplicó por cherry-pick a la línea 3.35, así que ningún hotfix de 3.35 te va a ayudar. Revisa en qué versión estás y avanza:

```bash
# any Flutter version
flutter --version
flutter channel stable
flutter upgrade
```

Si el proyecto fija su SDK mediante FVM o un archivo `.flutter-version`, actualiza eso en su lugar; de lo contrario, el IDE sigue lanzando el SDK viejo incluso después de actualizar el global:

```bash
# FVM 3.x
fvm install 3.47.5
fvm use 3.47.5
```

Luego reinicia la sesión de depuración. Una sesión en curso conserva su proceso `flutter run` original, y ese proceso mantiene el dwds viejo.

## Solución 2: vuelve a poner VS Code en "Debug my code"

Si todavía no puedes actualizar (una imagen de CI bloqueada, un plugin que no soporta versiones más nuevas de Dart), oculta el síntoma. Con una sesión de depuración en curso, haz clic en el elemento del modo de depuración a la izquierda de la barra de estado y elige "Debug my code". O configúralo para el workspace:

```jsonc
// .vscode/settings.json -- Flutter 3.35.x workaround, Dart-Code extension
{
  "dart.debugExternalPackageLibraries": false,
  "dart.debugSdkLibraries": false
}
```

Este es el workaround que Danny recomendó en el issue. El isolate sigue pausándose brevemente durante la recarga, pero como todos los frames están en `package:flutter` o `dart:*`, VS Code los trata a todos como código externo y no te roba el foco. Cuando de verdad necesites entrar en un paquete, cambia a "+ packages" para esa sesión y acepta los saltos hasta que vuelvas a cambiar.

Esto no ayuda en Android Studio ni en IntelliJ, que no tienen un interruptor equivalente para este caso. Ahí usa la Solución 3.

## Solución 3: desactiva el hot reload web con estado en 3.35

La opción tosca es volver al formato de módulos web anterior a 3.35, que no hace el baile de pausar y volver a registrar en absoluto:

```bash
# Flutter 3.35.x, terminal
flutter run -d chrome --no-web-experimental-hot-reload
```

En VS Code, ponlo en `launch.json` para que se aplique solo a este proyecto:

```jsonc
// .vscode/launch.json -- Flutter 3.35.x, Dart-Code extension
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "web (no stateful reload)",
      "type": "dart",
      "request": "launch",
      "program": "lib/main.dart",
      "deviceId": "chrome",
      "toolArgs": ["--no-web-experimental-hot-reload"]
    }
  ]
}
```

La configuración de usuario `dart.flutterRunAdditionalArgs` también funciona, pero se aplica a todos los proyectos de la máquina, y así es como la gente termina olvidando que está ahí un año después. En Android Studio, abre Run > Edit Configurations, selecciona la configuración de Flutter y pon `--no-web-experimental-hot-reload` en "Additional run args".

El costo es real: sin el nuevo formato de módulos, el target web vuelve al comportamiento anterior, en el que una recarga reinicia la aplicación y pierdes el estado en cada guardado. Trátalo como un puente hasta que puedas actualizar, y quítalo después. En Flutter 3.47.5 el texto de ayuda del flag ya dice "(deprecated; will be removed in a future release)", así que una entrada `toolArgs` olvidada terminará rompiendo tu configuración de lanzamiento.

## Trampas y casos parecidos

**Estás en 3.38 o posterior y sigue pasando.** Antes que nada, mira el encabezado del panel CALL STACK. Si dice "Paused on exception", no es el bug de dwds, es una excepción real, y el panel Breakpoints mostrará marcada la opción "Uncaught Exceptions" o "All Exceptions". Con "All Exceptions", el depurador también se detiene en excepciones que el código del framework o de paquetes lanza y captura por su cuenta. Desmárcala, recarga y comprueba si la pausa desaparece. Si dice "Paused on breakpoint", abre el panel Breakpoints: VS Code guarda los puntos de interrupción por workspace, incluidos los que pusiste dentro de `binding.dart` mientras recorrías el framework hace meses. Elimínalo.

**Pasa en Android, iOS o escritorio.** La pausa falsa era exclusiva de la web, porque vivía en dwds, que solo se ejecuta para targets web. El VM service nativo no pausa el isolate para volver a registrar puntos de interrupción al recargar. En un target móvil o de escritorio, una detención en `binding.dart` es una excepción o un punto de interrupción olvidado, así que usa las comprobaciones anteriores.

**El hot reload tumba la sesión de depuración en lugar de pausarla.** Flutter 3.35.2 tenía otro bug web en el que el hot reload lanzaba una excepción desde `dwds/src/injected/client.js` y rompía la sesión ([flutter/flutter#174932](https://github.com/flutter/flutter/issues/174932)). Bug distinto, misma cura: actualizar.

**La página muestra código viejo después de una recarga.** Si la recarga "funciona" pero el navegador ejecuta una compilación obsoleta, estás ante un problema de caché, no del depurador. Consulta [por qué Flutter web sirve una compilación obsoleta en caché después de recargar](/es/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/).

**El hot reload se cuelga con un punto de interrupción puesto.** Si tienes un punto de interrupción dentro de un override de `State.reassemble` (o en código que este llama), la llamada al servicio `ext.flutter.reassemble` se detiene ahí en cada recarga, y la herramienta puede agotar el tiempo de espera ([flutter/flutter#23285](https://github.com/flutter/flutter/issues/23285)). Es un punto de interrupción real haciendo su trabajo, no el bug de dwds: continúa más allá de él o muévelo.

## Relacionado

- Si estás perfilando en lugar de depurar, [cómo perfilar el jank en una aplicación Flutter con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) cubre la vista Performance que consume esos eventos `Flutter.Frame`.
- [Por qué `appFlavor` queda en null después de un hot restart con `flutter attach`](/es/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/) es otro caso en el que la ruta de recarga se comporta distinto a un lanzamiento normal.
- El [servidor MCP de Dart y Flutter](/es/2026/05/dart-flutter-mcp-server-claude-code-cursor/) habla con el mismo VM service y DTD que dwds expone en la web.
- ¿Eliges un renderizador web al mismo tiempo que actualizas? [CanvasKit vs skwasm para Flutter web en 2026](/es/2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026/) repasa las ventajas y desventajas.

## Fuentes

- [dart-lang/sdk#61560: Hot Reload opens `binding.dart` at line 845 on every reload (no errors shown)](https://github.com/dart-lang/sdk/issues/61560)
- [flutter/flutter#176693: [Web] Hot Reload jumping on binding.dart file even if "uncaught exceptions" are turned off](https://github.com/flutter/flutter/issues/176693)
- [flutter/flutter#174951: Error when hot reload since latest versions](https://github.com/flutter/flutter/issues/174951)
- [dart-lang/webdev#2695: Don't send PauseInterrupted event during a hot reload](https://github.com/dart-lang/webdev/pull/2695)
- [Changelog de dwds en pub.dev](https://pub.dev/packages/dwds/changelog)
- [Documentación de la API de BindingBase.reassembleApplication](https://api.flutter.dev/flutter/foundation/BindingBase/reassembleApplication.html)
- [Documentación de Flutter: Hot reload](https://docs.flutter.dev/tools/hot-reload)
- [Novedades de Flutter 3.38](https://blog.flutter.dev/whats-new-in-flutter-3-38-3f7b258f7228)
