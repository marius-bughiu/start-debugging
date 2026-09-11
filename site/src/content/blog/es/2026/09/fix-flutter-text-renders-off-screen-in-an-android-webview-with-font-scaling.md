---
title: "Solución: el Text de Flutter se dibuja fuera de la pantalla en un WebView de Android cuando el escalado de fuente del sistema está activado"
description: "Flutter web de la 3.41 a la 3.44 reporta un override de altura de línea de ~625x cuando el textZoom de un WebView de Android no es 100. Actualiza a la 3.47 o elimina el override en MaterialApp.builder."
pubDate: 2026-09-11
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-web"
  - "android"
  - "accessibility"
lang: "es"
translationOf: "2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling"
translatedBy: "claude"
translationDate: 2026-09-11
---

Si tu app web de Flutter corre dentro de un `WebView` de Android y todos los `Text` simples desaparecen en cuanto el usuario cambia el tamaño de fuente del sistema, se trata de un bug conocido del motor web. Desde Flutter 3.41.0 hasta 3.44.9, el motor interpreta mal el `textZoom` del WebView como si fuera una preferencia de altura de línea del usuario. `MediaQuery.lineHeightScaleFactorOverride` devuelve aproximadamente `624.9`, así que una línea de 18 px se maqueta con unos 12 900 px de alto y sus glifos se pintan muy por debajo del viewport. Actualiza a Flutter 3.47.0 o posterior (la 3.47.3 es la estable actual), donde se reescribió el código de detección. En versiones anteriores, elimina el override erróneo en `MaterialApp.builder`. Si controlas el host de Android, también puedes fijar `textZoom` en 100.

Este artículo cubre Flutter 3.44.8 (Dart 3.12.2), que es la versión del reporte del bug, y lo compara con el código fuente del motor en la 3.47.3. El comportamiento a nivel de widgets que se describe abajo se reprodujo con `flutter test` en la 3.44.8.

## Cómo se ve la pantalla rota

No hay ninguna excepción ni error en la consola. Las fuentes web cargan con HTTP 200, el evento `flutter-first-frame` se dispara y el scheduler sigue funcionando. Todos los síntomas son geométricos:

- Todos los widgets `Text` son invisibles, mientras que los íconos, bordes, imágenes y fondos de `Container` se siguen pintando.
- Todo lo que está debajo del primer `Text` en una `Column` también desaparece, porque el texto inflado lo empuja miles de píxeles hacia abajo.
- Las barras de altura fija como `NavigationBar` recortan sus etiquetas, y los `TextField` crecen hasta su `maxHeight`.
- En modo release, algunas rutas se reemplazan por el `ErrorWidget` gris. En una compilación de depuración, espera un [desbordamiento de RenderFlex](/es/2026/05/fix-renderflex-overflowed-in-flutter/) medido en miles de píxeles, no el puñado habitual que se sale del borde.

El disparador es específico. La misma compilación se ve bien en Chrome de escritorio, en la app del navegador Chrome del mismo celular, en GeckoView y en un WebView del emulador estándar con la configuración predeterminada. Solo falla en un Android System WebView cuyo `textZoom` no es exactamente 100. El control deslizante de tamaño de fuente del sistema en Ajustes > Accesibilidad establece ese valor automáticamente en cualquier WebView que no lo sobrescriba.

Imprimir los valores de `MediaQuery` desde dentro de la app lo deja claro. En [flutter/flutter#190350](https://github.com/flutter/flutter/issues/190350), quien reportó el bug ejecutó una app estándar de `flutter create` en Flutter 3.44.8 y solo cambió `adb shell settings put system font_scale`:

```text
font_scale  textZoom  lineHeightScaleFactorOverride  textScaler  Text visible
0.85        85        624.9374824709756              0.85        no
1.0         100       null                           1.0         yes
1.15        115       624.9347955648752              1.15        no
1.3         130       624.9375229225718              1.3         no
```

`textScaler` es correcto en cada paso. `lineHeightScaleFactorOverride` es `null` en 100 y ronda 624.94 en cualquier otro nivel de zoom, tanto si el texto se hizo más pequeño como más grande. Un valor que se mantiene igual sin importar hacia dónde se mueva la entrada no es una medición. Es un valor centinela que se está filtrando.

## Por qué el motor web reporta una altura de línea de 625x

Desde Flutter 3.41, el motor web admite las preferencias de [espaciado de texto de WCAG 1.4.12](https://www.w3.org/WAI/WCAG21/Understanding/text-spacing.html) que aplican las extensiones del navegador y las hojas de estilo de usuario. Esto lo agregó el [PR #178081](https://github.com/flutter/flutter/pull/178081). Flutter dibuja el texto en un canvas, así que no puede leer esos overrides de CSS desde su propio contenido. En su lugar, `EnginePlatformDispatcher._addTypographySettingsObserver` agrega a `document.body` un elemento sonda `<p>` oculto con estilos inline deliberadamente absurdos y luego lo observa con un `ResizeObserver`. En la 3.44.8, la parte relevante de `engine/src/flutter/lib/web_ui/lib/src/engine/platform_dispatcher.dart` se ve así:

```dart
// Flutter 3.44.8, lib/web_ui/lib/src/engine/platform_dispatcher.dart (abridged)
const spacingDefault = 9999.0;
_typographyMeasurementElement!.style
  ..lineHeight = '${spacingDefault}px'
  ..letterSpacing = '${spacingDefault}px'
  ..wordSpacing = '${spacingDefault}px'
  ..margin = '0px 0px ${spacingDefault}px 0px';
domDocument.body!.append(_typographyMeasurementElement!);
final double typographyMeasurementElementFontSize =
    parseFontSize(_typographyMeasurementElement!)?.toDouble() ?? _defaultRootFontSize;
final double defaultLineHeightFactor = spacingDefault / typographyMeasurementElementFontSize;

// Inside the ResizeObserver callback:
final double? computedLineHeightScaleFactor =
    fontSize != null && lineHeight != null && lineHeight != spacingDefault
    ? lineHeight / fontSize
    : null;
_updateLineHeightScaleFactorOverride(
  computedLineHeightScaleFactor == defaultLineHeightFactor
      ? null
      : computedLineHeightScaleFactor,
);
```

La idea es que, si nada fuera de Flutter tocó la sonda, su `line-height` calculado sigue siendo exactamente `9999px` y el override se queda en `null`. Cualquier otro valor indica una preferencia del usuario, y su proporción respecto al tamaño de fuente se convierte en el nuevo factor de altura de línea.

El `textZoom` del WebView de Android rompe ambas comprobaciones. Escala el `font-size` raíz y también escala el `line-height` en píxeles de la sonda, lo cual no es una preferencia del usuario en absoluto. Haz las cuentas para un `textZoom` de 115 y un tamaño raíz predeterminado de 16 px:

1. El tamaño de fuente de la sonda es `16 * 1.15 = 18.4px`, así que `defaultLineHeightFactor = 9999 / 18.4 = 543.4`.
2. El `line-height` calculado es `9999 * 1.15 = 11498.85px`. Eso no es `9999`, así que el motor lo trata como un override.
3. `computedLineHeightScaleFactor = 11498.85 / 18.4 = 624.9375`, que es exactamente `9999 / 16`. El factor de zoom se cancela, y por eso el valor reportado apenas cambia entre niveles de zoom.
4. `624.9375` no es igual a `543.4`, así que se publica como `MediaQueryData.lineHeightScaleFactorOverride`.

El framework toma este valor tal cual. `Text.build` lee `MediaQuery.maybeLineHeightScaleFactorOverrideOf(context)` y lo fuerza en el `TextStyle.height` del span, y en `StrutStyle.height` cuando hay un strut definido, sin importar `inherit`. `TextStyle.height` es un multiplicador del tamaño de fuente, como se describe en [el artículo sobre leadingDistribution](/es/2026/01/flutter-text-the-leadingdistribution-detail-that-changes-how-your-ui-breathes/), así que la caja de línea termina siendo 625 veces más alta que los glifos. Los widgets que construyen un `RichText` directamente, como `Icon`, nunca consultan el override. Por eso los íconos sobreviven en una pantalla donde todo el texto desapareció.

Esta es una variante de un bug anterior. [#178856](https://github.com/flutter/flutter/issues/178856) describía el mismo valor anormal tras cambiar el tamaño de fuente del navegador en tiempo de ejecución, y el [PR #178862](https://github.com/flutter/flutter/pull/178862) lo corrigió el 2 de diciembre de 2025. Esa corrección seguía comparando exactamente contra `9999`, así que un zoom que ya está activo en el primer pintado se cuela. Un bisect en el hilo del issue ubica la regresión entre 3.39.0-0.2.pre (buena) y 3.40.0-0.1.pre (mala). Entre las versiones estables, el centinela de 9999 px está presente en todos los tags desde 3.41.0 hasta 3.44.9 y ausente en 3.38.x.

El renderer no importa. El hilo reproduce el bug con CanvasKit, con CanvasKit forzado a CPU y con skwasm a partir de una compilación con [`flutter build web --wasm`](/es/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), porque el defecto está en código Dart compartido.

## Reproducción mínima

El lado web es una app estándar que imprime los overrides con `RichText`, para que el reporte siga siendo legible mientras el bug está activo:

```dart
// Flutter 3.44.8, web target. Serve build/web and load it in an Android WebView.
import 'package:flutter/material.dart';

void main() => runApp(
      const MaterialApp(home: Scaffold(body: SafeArea(child: Probe()))),
    );

class Probe extends StatelessWidget {
  const Probe({super.key});

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        RichText(
          text: TextSpan(
            text: 'line=${mq.lineHeightScaleFactorOverride}\n'
                'scale10=${mq.textScaler.scale(10)}',
            style: const TextStyle(fontSize: 15, color: Colors.black),
          ),
        ),
        const Text('PLAIN TEXT', style: TextStyle(fontSize: 18, color: Colors.red)),
      ],
    );
  }
}
```

Compílala con `flutter build web --release` y sirve `build/web`. Luego ejecuta `adb shell settings put system font_scale 1.15` y abre la página en un `android.webkit.WebView` simple con JavaScript habilitado. El host no necesita llamar a `setTextZoom`, porque el WebView toma la escala del sistema por sí solo.

Si no tienes un dispositivo, puedes reproducir la mitad del framework en un test de widgets inyectando el valor que reporta el motor:

```dart
// Flutter 3.44.8, flutter_test
testWidgets('engine-reported override inflates Text', (tester) async {
  await tester.pumpWidget(MaterialApp(
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context)
          .copyWith(textScaler: const TextScaler.linear(1.15))
          .applyTextStyleOverrides(
            lineHeightScaleFactorOverride: 624.9375,
            letterSpacingOverride: null,
            wordSpacingOverride: null,
            paragraphSpacingOverride: null,
          ),
      child: child!,
    ),
    home: const Scaffold(
      body: SingleChildScrollView(
        child: Text('plain', key: Key('t'), style: TextStyle(fontSize: 18)),
      ),
    ),
  ));
  debugPrint('${tester.getSize(find.byKey(const Key('t'))).height}');
});
```

En la 3.44.8 esto imprime `12936.0`, que es la misma altura de línea de 12 936 px que midió quien reportó el issue en el WebView real.

## Solución 1: actualizar a Flutter 3.47

El [PR #186474](https://github.com/flutter/flutter/pull/186474), fusionado el 19 de mayo de 2026, reescribió la lógica de la sonda. Se escribió para un bug de Safari con la opción "no usar nunca tamaños de fuente menores que" ([#185931](https://github.com/flutter/flutter/issues/185931)), que producía el mismo factor inflado mediante el mismo mecanismo. La corrección llegó primero en la 3.46.0-0.1.pre y está en todas las versiones estables de la 3.47. La línea de hotfixes 3.44.x, incluida la 3.44.9 del 5 de agosto de 2026, nunca la recibió. El código nuevo:

```dart
// Flutter 3.47.3, lib/web_ui/lib/src/engine/platform_dispatcher.dart (abridged)
const spacingDefault = 100.0;
final double defaultLineHeightFactor =
    spacingDefault / (typographyMeasurementElementFontSize / findBrowserTextScaleFactor());

bool isDefault(double? value, double defaultValue) {
  if (value == null) {
    return true;
  }
  return (value - defaultValue).abs() < _typographyPrecisionErrorTolerance ||
      (value - defaultValue * computedTextScaleFactor).abs() <
          _typographyPrecisionErrorTolerance;
}
```

`findBrowserTextScaleFactor()` es el tamaño de fuente raíz dividido entre 16, que es 1.15 con un `textZoom` de 115. La altura de línea con zoom de `100 * 1.15` ahora cuenta como "predeterminada", y lo mismo pasa con el espaciado entre letras, el espaciado entre palabras y el margen de párrafo con zoom. El override se queda en `null` mientras `textScaler` sigue reportando 1.15. El centinela también bajó de 9999 px a 100 px, así que una futura detección errónea daría un factor de alrededor de 6 en lugar de 625.

Una advertencia: #190350 sigue abierto y nadie en el hilo ha publicado una prueba en dispositivo con la 3.47. El análisis anterior proviene de leer el código fuente, no de una ejecución en un WebView. Después de actualizar, ejecuta la sonda con `RichText` en un dispositivo real con `font_scale` 1.15 y confirma `line=null` antes de quitar cualquier workaround. Si de todos modos vas a actualizar desde la 3.44, vale la pena leer sobre el [cambio de renderer de escritorio en la 3.47](/es/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) para los demás targets de tu app.

```bash
flutter upgrade
flutter --version
```

## Solución 2: eliminar los overrides inverosímiles en MaterialApp.builder

Si todavía no puedes salir de la 3.41 a la 3.44, o no controlas la app host, corrígelo en la raíz del árbol de widgets. `MediaQuery.applyTextStyleOverrides` reemplaza los cuatro overrides de espaciado para todo lo que está debajo. Establece cada uno exactamente en lo que le pasas, `null` incluido, y conserva `textScaler`, así que la elección de tamaño de fuente del usuario se sigue aplicando.

El workaround publicado en el issue pone los cuatro en `null`. Eso funciona, pero también descarta las preferencias reales de espaciado de texto de WCAG, que es justamente la funcionalidad para la que existe la sonda. Una protección más acotada descarta solo los valores que ninguna configuración real del usuario podría producir:

```dart
// Flutter 3.41.0 to 3.44.9, workaround for flutter/flutter#190350
import 'package:flutter/widgets.dart';

/// Drops text spacing overrides that no real user preference can produce.
Widget sanitizeTextSpacing(BuildContext context, Widget? child) {
  final mq = MediaQuery.of(context);
  double? sane(double? value, double max) =>
      value == null || value.abs() > max ? null : value;

  final lineHeight = sane(mq.lineHeightScaleFactorOverride, 4);
  final letter = sane(mq.letterSpacingOverride, 100);
  final word = sane(mq.wordSpacingOverride, 100);
  final paragraph = sane(mq.paragraphSpacingOverride, 1000);

  if (lineHeight == mq.lineHeightScaleFactorOverride &&
      letter == mq.letterSpacingOverride &&
      word == mq.wordSpacingOverride &&
      paragraph == mq.paragraphSpacingOverride) {
    return child ?? const SizedBox.shrink();
  }
  return MediaQuery.applyTextStyleOverrides(
    lineHeightScaleFactorOverride: lineHeight,
    letterSpacingOverride: letter,
    wordSpacingOverride: word,
    paragraphSpacingOverride: paragraph,
    child: child ?? const SizedBox.shrink(),
  );
}
```

Conéctalo en cada raíz de la app:

```dart
// Flutter 3.44.8
MaterialApp(
  builder: sanitizeTextSpacing,
  home: const HomePage(),
);
```

WCAG 1.4.12 pide una altura de línea de 1.5 y un espaciado entre letras de 0.12em, así que un tope de factor de 4 y un tope de 100 px dejan margen de sobra para las preferencias reales. En la 3.44.8 lo probé con un test de widgets. Un override de `624.9375` se convierte en `null`, y el `Text` de 18 px mide 30 px en lugar de 12 936 px. Un override de `1.5` pasa sin cambios. `textScaler.scale(10)` devuelve `11.5` en ambos casos.

Algunos detalles importan aquí:

- **Cada raíz lo necesita.** El builder solo cubre su propio `MaterialApp`. Si ejecutas apps separadas de carga, mantenimiento u onboarding con su propio `MaterialApp` o `WidgetsApp`, envuelve cada una.
- **Sigue los cambios en tiempo de ejecución.** `MediaQuery.of(context)` se suscribe a los datos del entorno, así que cuando el usuario cambia el tamaño de fuente con la página abierta, el motor vuelve a publicar y la protección se ejecuta de nuevo.
- **`MediaQuery.withNoTextScaling` no ayuda.** Solo restablece `textScaler`, que nunca fue el problema. Limitar la escala de texto deja el override de altura de línea en su lugar.
- **Es inofensivo después de actualizar.** En la 3.47 el motor debería reportar `null` en el caso del WebView, así que la protección devuelve `child` sin tocarlo. Puedes quitarla una vez que la actualización se haya confirmado en un dispositivo.

## Solución 3: fijar textZoom en 100 en el host de Android

Si también distribuyes el host nativo, puedes asegurarte de que el WebView nunca pase la escala de fuente del sistema a la página. De las tres soluciones, esta es la más tosca. El contenido web de Flutter deja de seguir por completo el tamaño de fuente del usuario, porque `textScaler` se queda en 1.0. Úsala solo cuando la app web tenga su propio control de tamaño de texto dentro de la app.

En un host de Kotlin:

```kotlin
// Android System WebView, API 14+
webView.settings.javaScriptEnabled = true
webView.settings.textZoom = 100
```

En un host de Flutter que usa `webview_flutter` 4.14.1, la configuración está en el controlador de la plataforma Android de `webview_flutter_android` 4.14.1:

```dart
// webview_flutter 4.14.1, webview_flutter_android 4.14.1
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

WebViewController buildController(Uri appUrl) {
  final controller = WebViewController()
    ..setJavaScriptMode(JavaScriptMode.unrestricted)
    ..loadRequest(appUrl);

  final platform = controller.platform;
  if (platform is AndroidWebViewController) {
    // Opt out of Android's system font scale for this WebView.
    platform.setTextZoom(100);
  }
  return controller;
}
```

Esto también explica los reportes de que el bug no se puede reproducir. Según el hilo del issue, los hosts construidos sobre `flutter_inappwebview` son inmunes porque ese plugin establece `textZoom` en 100 por defecto. Los hosts construidos sobre `android.webkit.WebView` simple o `webview_flutter` se ven afectados en cuanto el usuario mueve el control deslizante de fuente de su valor predeterminado.

## Casos parecidos que no son este bug

- **No se renderiza nada en dispositivos Samsung con GPU Xclipse.** Si también faltan los íconos y los fondos, y solo en CanvasKit, estás ante [#188164](https://github.com/flutter/flutter/issues/188164), una regresión de renderizado de ANGLE sobre Vulkan. Ocurre incluso con `textZoom` en 100.
- **Espacios enormes entre widgets en Safari 26.5.** Este es [#185931](https://github.com/flutter/flutter/issues/185931). Tiene la misma causa raíz a través de la configuración de tamaño mínimo de fuente de Safari, y aplican las mismas soluciones.
- **El texto se desborda después de `flutter upgrade` en Android o iOS nativos.** La sonda tipográfica solo existe en el motor web. En targets móviles, revisa `TextScaler` y las restricciones de tu layout. Los accesores por aspecto como `MediaQuery.textScalerOf`, que funcionan igual que el que se usa para [leer el radio de las esquinas de la pantalla en Flutter 3.44](/es/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/), te permiten registrar exactamente lo que reporta la plataforma.

Una forma rápida de saber si te está afectando este bug: registra `PlatformDispatcher.instance.lineHeightScaleFactorOverride` al iniciar. Cualquier valor por encima de alrededor de 3 en la web significa que el motor leyó mal la sonda, no que el usuario lo haya pedido.

## Relacionados

- [Solución: A RenderFlex overflowed by N pixels en Flutter](/es/2026/05/fix-renderflex-overflowed-in-flutter/), para la franja del modo de depuración que produce este bug.
- [El detalle de `leadingDistribution` en el `Text` de Flutter](/es/2026/01/flutter-text-the-leadingdistribution-detail-that-changes-how-your-ui-breathes/), para ver cómo `TextStyle.height` se convierte en la geometría de la caja de línea.
- [Cómo compilar una app web de Flutter con WebAssembly](/es/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), ya que el bug es el mismo con skwasm.
- [Flutter 3.47 convierte a Impeller en el renderer predeterminado en escritorio](/es/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/), para la versión que incluye la corrección del motor.

## Fuentes

- [flutter/flutter#190350](https://github.com/flutter/flutter/issues/190350): el reporte sobre el `textZoom` del WebView de Android, el bisect y los workarounds.
- [flutter/flutter#178856](https://github.com/flutter/flutter/issues/178856) y [PR #178862](https://github.com/flutter/flutter/pull/178862): la primera variante con cambio de tamaño de fuente en tiempo de ejecución y su corrección parcial.
- [PR #178081](https://github.com/flutter/flutter/pull/178081): el soporte de overrides de espaciado de texto en web que agregó la sonda.
- [PR #186474](https://github.com/flutter/flutter/pull/186474) y [flutter/flutter#185931](https://github.com/flutter/flutter/issues/185931): la detección tolerante al zoom incluida en la 3.46 y la 3.47.
- [`platform_dispatcher.dart` en la 3.44.8](https://github.com/flutter/flutter/blob/3.44.8/engine/src/flutter/lib/web_ui/lib/src/engine/platform_dispatcher.dart) y [en la 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/engine/src/flutter/lib/web_ui/lib/src/engine/platform_dispatcher.dart).
- Documentación de la API de [`MediaQuery.applyTextStyleOverrides`](https://api.flutter.dev/flutter/widgets/MediaQuery/applyTextStyleOverrides.html) y [`MediaQueryData.lineHeightScaleFactorOverride`](https://api.flutter.dev/flutter/widgets/MediaQueryData/lineHeightScaleFactorOverride.html).
- [`WebSettings.setTextZoom`](https://developer.android.com/reference/android/webkit/WebSettings#setTextZoom(int)) y [`AndroidWebViewController.setTextZoom`](https://pub.dev/documentation/webview_flutter_android/latest/webview_flutter_android/AndroidWebViewController/setTextZoom.html).
