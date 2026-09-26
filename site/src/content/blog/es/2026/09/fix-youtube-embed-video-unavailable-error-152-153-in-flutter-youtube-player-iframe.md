---
title: "Solución: el embed de YouTube muestra \"Video unavailable\" (Error 152 / 153) en Flutter con youtube_player_iframe"
description: "El error 153 significa que YouTube no recibió ningún Referer; el 152 significa que la página dice ser youtube.com. Actualiza youtube_player_iframe a 6.0.2 y define origin como https://<el id de tu app>, o usa youtube-nocookie en 5.x."
pubDate: 2026-09-26
template: error-page
tags:
  - "errors"
  - "flutter"
  - "webview"
  - "ios"
  - "android"
lang: "es"
translationOf: "2026/09/fix-youtube-embed-video-unavailable-error-152-153-in-flutter-youtube-player-iframe"
translatedBy: "claude"
translationDate: 2026-09-26
---

YouTube ahora se niega a reproducir un embed a menos que pueda identificar quién lo está incrustando, y en una app de Flutter esa identidad es el origen de la página HTML que `youtube_player_iframe` carga en el WebView. El error 153 significa que la página no tenía ningún origen, así que no se envió ningún `Referer`. El error 152 significa que la página decía ser `https://www.youtube.com`, que es exactamente lo que `youtube_player_iframe` 5.2.2 y anteriores hacen por defecto. La solución es actualizar a `youtube_player_iframe` 6.0.2 y definir `YoutubePlayerParams(origin: 'https://com.yourcompany.yourapp')`. Si estás atado a 5.x, define `origin: 'https://www.youtube-nocookie.com'` en su lugar, y nunca el ID de tu app.

Todo lo que sigue se midió en un simulador de iOS 26.5 (iPhone 17 Pro Max, Xcode 27.0) con Flutter 3.44.8 / Dart 3.12.2, `webview_flutter` 4.14.1 y `webview_flutter_wkwebview` 3.26.1, y se contrastó con el código fuente de `youtube_player_iframe` 5.2.2 y 6.0.2. No ejecuté la matriz en Android, así que las notas sobre Android vienen de la documentación de YouTube y del código fuente del paquete, no de un dispositivo.

## El error en contexto

El área del reproductor muestra la propia tarjeta de error de YouTube en lugar del video:

```text
Video unavailable
Error 153
Video player configuration error
```

o, en la otra variante (reportada en [youtube_player_flutter#1155](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155) con `youtube_player_iframe` ^5.2.1):

```text
This video is unavailable
Error 152-4
Watch on YouTube
```

A partir de agosto de 2025, apps que no habían cambiado en meses dejaron de reproducir los mismos videos de un día para otro, y por eso issues como [#1084 "Working App Broke In prod, Youtube Changed Something"](https://github.com/sarbagyastha/youtube_player_flutter/issues/1084) y [#1124 "Error code 153"](https://github.com/sarbagyastha/youtube_player_flutter/issues/1124) acumularon decenas de comentarios de "a mí también". Los videos son públicos e incrustables, se reproducen en Chrome para celular y fallan solo dentro de la app.

## Por qué YouTube rechaza el embed

La página [YouTube API Services Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality) dice que los clientes que usan el reproductor incrustado, incluida la IFrame Player API, "must provide identification through the HTTP Referer request header". Un navegador lo hace por su cuenta: el `<iframe>` que apunta a `youtube.com/embed/...` se solicita con un `Referer` derivado de la página que lo contiene, bajo la política recomendada `strict-origin-when-cross-origin`. Un WebView móvil no tiene ninguna página de la cual derivarlo a menos que tú se la des. Para HTML local, la vía documentada es la URL base: `loadDataWithBaseURL` en Android y `loadHTMLString:baseURL:` en iOS, con un valor de la forma `https://<app-id>`, por ejemplo `https://com.google.android.youtube`.

La [referencia de la IFrame API](https://developers.google.com/youtube/iframe_api_reference) ahora describe el error 153 como "The request does not include the HTTP Referer header or equivalent API Client identification." El error 152 no está documentado. `youtube_player_iframe` lo trata como otro código de "no incrustable", pero en mis mediciones aparece con un video perfectamente incrustable cada vez que el origen de la página que lo incrusta es `https://www.youtube.com`. YouTube identifica al que incrusta como el propio YouTube y se niega.

Ahora mira lo que hace el paquete. `youtube_player_iframe` no carga una URL de YouTube; carga un `assets/player.html` empaquetado con `WebViewController.loadHtmlString`, y esa página crea el reproductor a través de la IFrame API. En 5.2.2 el código relevante es:

```dart
// youtube_player_iframe 5.2.2, lib/src/player_params.dart
this.origin = 'https://www.youtube.com',

// youtube_player_iframe 5.2.2, lib/src/controller/youtube_player_controller.dart
baseUrl: kIsWeb ? Uri.base.origin : params.origin,
// ...
'host': params.origin ?? 'https://www.youtube.com',
```

Así que por defecto la página HTML local recibe el origen `https://www.youtube.com`, el reproductor se crea con `host: 'https://www.youtube.com'`, y las variables del reproductor `origin` y `widget_referrer` también son `https://www.youtube.com`. Eso es el error 152. Y como un solo parámetro alimenta tanto el origen de la página como el host del iframe, no puedes arreglarlo poniendo el ID de tu app en `origin`: el reproductor intenta entonces cargar el iframe desde `https://com.yourcompany.yourapp`, que no existe.

La versión 6.0.0 (16 de mayo de 2026) separó ambos. `origin` ahora vale `null` por defecto, un nuevo `privacyEnhancedMode` (por defecto `true`) elige el host, y la URL base recurre a ese host:

```dart
// youtube_player_iframe 6.0.2, lib/src/player_params.dart
String get host => privacyEnhancedMode
    ? 'https://www.youtube-nocookie.com'
    : 'https://www.youtube.com';

// youtube_player_iframe 6.0.2, lib/src/controller/youtube_player_controller.dart
baseUrl: kIsWeb ? Uri.base.origin : (params.origin ?? params.host),
```

El mantenedor cerró [#1155](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155) con "Fixed with v6.0.0", y los reportes del 153 ([#1124](https://github.com/sarbagyastha/youtube_player_flutter/issues/1124), [#1150](https://github.com/sarbagyastha/youtube_player_flutter/issues/1150)) se cerraron el 30 de mayo de 2026 con la salida de 6.0.1.

## Reproducción mínima: una matriz de orígenes de página

Para ver qué combinación acepta YouTube, reduje el paquete a lo que realmente hace: un `WebViewController` que carga una pequeña página HTML con `loadHtmlString`, crea un `YT.Player` con un `host` dado, llama a `playVideo()` en `onReady` y reporta cada `onStateChange` y `onError` de vuelta a Dart mediante un canal de JavaScript. El video es `M7lc1UVf-VE`, la demo de la IFrame API del propio YouTube, que es incrustable.

```dart
// Flutter 3.44.8, webview_flutter 4.14.1, webview_flutter_wkwebview 3.26.1
String playerHtml({required String host, String? origin}) => '''
<!DOCTYPE html><html><body style="margin:0"><div id="p"></div>
<script>
function send(m) { Log.postMessage(m); }
var tag = document.createElement('script');
tag.src = 'https://www.youtube.com/iframe_api';
document.body.appendChild(tag);
function onYouTubeIframeAPIReady() {
  new YT.Player('p', {
    host: '$host', videoId: 'M7lc1UVf-VE',
    playerVars: {autoplay: 1, mute: 1, playsinline: 1, enablejsapi: 1
      ${origin == null ? '' : ", origin: '$origin', widget_referrer: '$origin'"}},
    events: {
      onReady: function (e) { send('onReady'); e.target.playVideo(); },
      onStateChange: function (e) { send('state=' + e.data); },
      onError: function (e) { send('ERROR=' + e.data); }
    }
  });
}
</script></body></html>''';

final controller = WebViewController.fromPlatformCreationParams(
  WebKitWebViewControllerCreationParams(
    allowsInlineMediaPlayback: true,
    mediaTypesRequiringUserAction: const <PlaybackMediaTypes>{},
  ),
)
  ..setJavaScriptMode(JavaScriptMode.unrestricted)
  ..addJavaScriptChannel('Log', onMessageReceived: (m) => debugPrint(m.message))
  ..loadHtmlString(
    playerHtml(host: 'https://www.youtube.com', origin: 'https://www.youtube.com'),
    baseUrl: 'https://www.youtube.com', // the 5.2.2 default
  );
```

Estos son los resultados, con cada caso ejecutado durante 25 segundos en el simulador (`state=1` es "reproduciendo"):

| Caso | Origen de la página (`baseUrl`) | `host` del reproductor | Resultado |
| --- | --- | --- | --- |
| `youtube_player_iframe` 5.2.2 por defecto | `https://www.youtube.com` | `https://www.youtube.com` | `ERROR=152` |
| 6.0.x con `privacyEnhancedMode: false` | `https://www.youtube.com` | `https://www.youtube.com` | `ERROR=152` |
| Sin URL base (`about:blank`, origen `null`) | ninguno | `https://www.youtube.com` | `ERROR=153` |
| Workaround de 5.x, valor por defecto de 6.0.x | `https://www.youtube-nocookie.com` | `https://www.youtube-nocookie.com` | `state=1`, se reproduce |
| ID de app + host nocookie | `https://com.example.ytrepro` | `https://www.youtube-nocookie.com` | `state=1`, se reproduce |
| ID de app + host youtube.com | `https://com.example.ytrepro` | `https://www.youtube.com` | `state=1`, se reproduce |
| ID de app en el `origin` de 5.x (también pasa a ser el host) | `https://com.example.ytrepro` | `https://com.example.ytrepro` | nunca llega a `onReady` |

De esa tabla salen dos reglas. Una página sin origen recibe el 153, una página que se hace pasar por `youtube.com` recibe el 152, y cualquier otra con un origen `https://` real se reproduce. Y el host del iframe debe ser un host real de YouTube, que es la razón por la que poner el ID de tu app en el parámetro `origin` de 5.x produce un reproductor vacío y silencioso en lugar de una solución.

## Solución 1: actualiza a youtube_player_iframe 6.0.2 y define origin con el ID de tu app

Esta es la solución recomendada. Necesita Flutter 3.38 o posterior y Dart 3.10 o posterior, los nuevos mínimos de 6.0.0.

```yaml
# pubspec.yaml, Flutter 3.38+ (tested on 3.44.8)
dependencies:
  youtube_player_iframe: ^6.0.2
```

```dart
// youtube_player_iframe 6.0.2, Flutter 3.44.8
final controller = YoutubePlayerController.fromVideoId(
  videoId: 'M7lc1UVf-VE',
  autoPlay: false,
  params: const YoutubePlayerParams(
    // Your Android applicationId / iOS bundle identifier, as an https URL.
    origin: 'https://com.yourcompany.yourapp',
    showFullscreenButton: true,
  ),
);
```

Con `origin` definido, 6.0.2 lo usa como URL base de `loadHtmlString` y como las variables del reproductor `origin` y `widget_referrer`, mientras que el iframe sigue cargándose desde `youtube-nocookie.com` (o `youtube.com` si desactivas `privacyEnhancedMode`). Esa es la fila "ID de app + host nocookie" de arriba, y coincide con el formato `https://<app-id>` que documenta YouTube. También es el enfoque en el que convergieron los colaboradores en el [PR #1126](https://github.com/sarbagyastha/youtube_player_flutter/pull/1126), que propuso exactamente esta separación entre origen y host antes de que 6.0.0 la incluyera.

Si dejas `origin` sin definir, 6.0.2 igual funciona: el origen de la página recurre a `https://www.youtube-nocookie.com` (la fila "valor por defecto de 6.0.x"). Definir el ID de tu app sigue siendo mejor porque es lo que piden los términos de YouTube, y no depende de que YouTube siga tratando `youtube-nocookie.com` como un origen de incrustación aceptable.

Actualizar desde 5.x tiene un cambio incompatible con el que te toparás de inmediato: `YoutubePlayerScaffold` ya no existe. Reemplázalo por `YoutubePlayer`, que ahora maneja la pantalla completa por sí mismo:

```dart
// youtube_player_iframe 6.0.2 (was YoutubePlayerScaffold in 5.x)
@override
Widget build(BuildContext context) {
  return Scaffold(
    body: YoutubePlayer(
      controller: controller,
      aspectRatio: 16 / 9,
    ),
  );
}
```

6.0.1 también eliminó el parámetro `modestbranding`, así que bórralo si lo pasas.

## Solución 2: atado a 5.x, usa youtube-nocookie como origin

Si todavía no puedes pasar a Flutter 3.38, `youtube_player_iframe` 5.2.2 (Flutter 3.24+) se puede arreglar con un cambio de una línea que varias personas confirmaron en [#1112](https://github.com/sarbagyastha/youtube_player_flutter/issues/1112) y [#1155](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155):

```dart
// youtube_player_iframe 5.2.2, Flutter 3.24+
final controller = YoutubePlayerController(
  params: const YoutubePlayerParams(
    origin: 'https://www.youtube-nocookie.com',
  ),
);
```

En 5.x este único valor se convierte a la vez en el origen de la página, el host del iframe y las variables del reproductor, que es la fila "Workaround de 5.x" de la tabla: un host real de YouTube y un origen de página que no es `youtube.com`. No pongas aquí el ID de tu app en 5.x. También se convierte en el host del iframe y el reproductor nunca carga.

## Solución 3: tu propio WebView, dale a la página una URL base

Si incrustas YouTube tú mismo con `webview_flutter` o `flutter_inappwebview` en lugar de a través del paquete, la regla es la misma. Pasa siempre una URL base cuando cargues HTML local, y que sea el ID de tu app:

```dart
// webview_flutter 4.14.1
await controller.loadHtmlString(
  html,
  baseUrl: 'https://com.yourcompany.yourapp', // never omit: null gives Error 153
);
```

Si cargas directamente una URL de embed en lugar de HTML local, agrega el header tú mismo. `loadRequest` acepta headers en ambas plataformas, que es la vía `loadUrl(url, additionalHttpHeaders)` / `loadRequest:` que describe la documentación de YouTube:

```dart
// webview_flutter 4.14.1
await controller.loadRequest(
  Uri.parse('https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?playsinline=1'),
  headers: const {'Referer': 'https://com.yourcompany.yourapp/'},
);
```

Lo mismo vale para `flutter_inappwebview`, que `youtube_player_flutter` usa internamente: pasa `baseUrl: WebUri('https://com.yourcompany.yourapp')` a `loadData`. [#1150](https://github.com/sarbagyastha/youtube_player_flutter/issues/1150) es la versión de Windows (WebView2) de este error en ese paquete.

## Trampas y errores parecidos

**Puede que tu manejador de errores no reconozca el 152 o el 153 como lo que son.** `youtube_player_iframe` 6.0.2 mapea los códigos crudos mediante `YoutubeError.fromCode`, que conoce `152` (`sameAsNotEmbeddable2`) pero no `153`, así que un 153 llega como `YoutubeError.unknown`. En 5.2.2 tanto el 152 como el 153 se mapean a `unknown`. Si muestras un mensaje de "video no incrustable" basado en el enum, mostrarás lo incorrecto. Registra el código crudo mientras depuras esto.

**Desactivar `privacyEnhancedMode` en 6.x trae de vuelta el 152** a menos que también definas `origin`. Con `privacyEnhancedMode: false` y sin `origin`, la URL base recurre a `https://www.youtube.com`, que es la segunda fila de la tabla. Define `origin` con el ID de tu app y el host youtube.com se reproduce sin problema.

**Los errores 150 y 101 son otro problema.** Significan que el dueño desactivó la incrustación para ese video. Ningún cambio de origen o de Referer los arregla; abre el video en la app de YouTube con `url_launcher` en su lugar.

**"This video is unavailable, Error code: 15"** de septiembre de 2025 ([#1112](https://github.com/sarbagyastha/youtube_player_flutter/issues/1112), [#1125](https://github.com/sarbagyastha/youtube_player_flutter/issues/1125)) pertenecía a la misma familia de comprobaciones de identidad en 5.x y responde a las mismas soluciones de origen.

**Flutter web es diferente.** En web el paquete ignora tu `origin` y usa `Uri.base.origin`, el origen real de tu sitio, porque el navegador envía el `Referer` por sí mismo. Si obtienes el 153 ahí, es casi seguro que tu servidor está enviando `Referrer-Policy: no-referrer` o `same-origin`, que elimina el header en la solicitud cross-origin del iframe. Cámbialo a `strict-origin-when-cross-origin`, como recomienda YouTube, o agrega `<meta name="referrer" content="strict-origin-when-cross-origin">` a `web/index.html`. Simon Willison se topó con lo mismo con el valor por defecto `same-origin` de Django y [lo documentó](https://til.simonwillison.net/youtube/fixing-153-embed). Si además sirves tu compilación de Flutter web detrás de un almacenamiento en caché agresivo, asegúrate de que el nuevo `index.html` realmente llegue a los usuarios; [las compilaciones cacheadas obsoletas tras recargar](/es/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) son una trampa aparte.

**Los delegados de navegación pueden deshacer la solución.** Si envuelves el reproductor en tu propio `NavigationDelegate` y bloqueas toda navegación que no sea a tu dominio, puedes bloquear los propios frames del embed. Permite explícitamente los hosts de YouTube; el enfoque de coincidencia de hosts de [cómo impedir que un WebView de Flutter navegue a URLs externas](/es/2026/09/how-to-block-a-flutter-webview-from-navigating-to-external-urls/) funciona con una lista de permitidos de `www.youtube.com`, `www.youtube-nocookie.com` y `m.youtube.com`.

**Abrir la URL del video no es el mismo bug.** [flutter/flutter#178705](https://github.com/flutter/flutter/issues/178705) reporta el 153 al abrir un enlace con `launchUrl`, que sale por completo de tu app. Se cerró como inválido y tiene que ver con el navegador o la app de YouTube del dispositivo, no con tu WebView.

## Relacionados

- [Cómo impedir que un WebView de Flutter navegue a URLs externas](/es/2026/09/how-to-block-a-flutter-webview-from-navigating-to-external-urls/) cubre la coincidencia de hosts con `NavigationDelegate` en `webview_flutter` 4.14.1.
- [Solución: el texto de Flutter se renderiza fuera de pantalla en un WebView de Android con escalado de fuente del sistema](/es/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/) es otro bug de incrustación en WebView con una solución de un solo parámetro.
- [Solución: Flutter web sirve una compilación cacheada obsoleta tras recargar](/es/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) importa si publicas el cambio en el `index.html` web de arriba.
- [Flutter 3.44 separa Material y Cupertino del SDK](/es/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) vale la pena leerlo antes de la actualización a Flutter 3.38+ que necesita `youtube_player_iframe` 6.x.

## Fuentes

- [YouTube API Services: Required Minimum Functionality, identidad del cliente de la API y formato del Referer](https://developers.google.com/youtube/terms/required-minimum-functionality)
- [Referencia de la YouTube IFrame Player API, códigos de onError](https://developers.google.com/youtube/iframe_api_reference)
- [Changelog de youtube_player_iframe (5.2.2, 6.0.0, 6.0.1, 6.0.2)](https://pub.dev/packages/youtube_player_iframe/changelog)
- [sarbagyastha/youtube_player_flutter#1155: Error 152-4 en 5.2.1, corregido en 6.0.0](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155)
- [sarbagyastha/youtube_player_flutter#1124: Error code 153](https://github.com/sarbagyastha/youtube_player_flutter/issues/1124)
- [sarbagyastha/youtube_player_flutter#1112: Error code 15 y el workaround del origen youtube-nocookie](https://github.com/sarbagyastha/youtube_player_flutter/issues/1112)
- [sarbagyastha/youtube_player_flutter#1126: enviar el origen por separado del host](https://github.com/sarbagyastha/youtube_player_flutter/pull/1126)
- [Simon Willison: Error 153 Video player configuration error en embeds de YouTube](https://til.simonwillison.net/youtube/fixing-153-embed)
