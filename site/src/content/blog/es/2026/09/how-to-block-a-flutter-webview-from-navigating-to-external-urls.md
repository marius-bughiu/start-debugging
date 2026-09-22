---
title: "Cómo impedir que un WebView de Flutter navegue a URLs externas con NavigationDelegate"
description: "Mantén un WebView de Flutter dentro de tu propio dominio con webview_flutter 4.14.1: analiza la URL, compara Uri.host en lugar de usar startsWith, delega mailto: y tel: a url_launcher, y conoce lo que Android e iOS realmente envían a onNavigationRequest."
pubDate: 2026-09-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "webview"
  - "security"
  - "android"
  - "ios"
lang: "es"
translationOf: "2026/09/how-to-block-a-flutter-webview-from-navigating-to-external-urls"
translatedBy: "claude"
translationDate: 2026-09-22
---

**Respuesta corta:** con `webview_flutter` 4.14.1 en Flutter 3.44, dale al `WebViewController` un `NavigationDelegate` cuyo `onNavigationRequest` analice `request.url` con `Uri.tryParse`, devuelva `NavigationDecision.navigate` solo cuando `uri.scheme == 'https'` y `uri.host` esté en tu lista de permitidos, y devuelva `NavigationDecision.prevent` para todo lo demás, abriendo opcionalmente el enlace bloqueado en el navegador del sistema con `url_launcher`. No uses `url.startsWith('https://example.com')`: deja pasar `https://example.com.evil.net` y `https://example.com@evil.net`. Y conoce los límites: en Android el callback nunca ve las navegaciones de subframes ni los envíos de formularios por POST.

El resto de este artículo construye esa política paso a paso, muestra la tabla de pruebas que demuestra que la comprobación ingenua es incorrecta y recorre las diferencias entre plataformas que deciden qué puede y qué no puede bloquear tu callback. Todo lo que sigue se compiló y probó con `webview_flutter` 4.14.1, `webview_flutter_android` 4.14.1, `webview_flutter_wkwebview` 3.26.1 y `url_launcher` 6.3.2 sobre Flutter 3.44.8 / Dart 3.12.2.

## Por qué un WebView se escapa de tu sitio

Un centro de ayuda embebido, una página de pago o una pantalla de términos de servicio normalmente están pensados para mostrar un solo sitio. La página no lo sabe. Contiene enlaces en el pie a Twitter, una insignia de "powered by", un botón de OAuth, una dirección de soporte `mailto:` y quizá contenido generado por usuarios con enlaces arbitrarios. Toca cualquiera de ellos y el WebView lo carga sin problema dentro de tu app, sin barra de direcciones, sin botón de atrás a menos que hayas construido uno y con el nombre de tu app en la parte superior de la pantalla. Eso es un problema de UX (los usuarios quedan varados en un sitio de terceros) y un problema de confianza (una página de phishing renderizada dentro de tu app hereda la credibilidad de tu app).

`webview_flutter` expone un solo hook para esto: `NavigationDelegate.onNavigationRequest`. Su firma en 4.14.1 es:

```dart
// webview_flutter 4.14.1
FutureOr<NavigationDecision> Function(NavigationRequest request)? onNavigationRequest
```

`NavigationRequest` lleva exactamente dos campos, `url` (un `String`) e `isMainFrame` (un `bool`), y `NavigationDecision` tiene dos valores, `navigate` y `prevent`. Todo lo demás depende de ti.

## El ejemplo del README es el bug

El README oficial del paquete muestra este fragmento:

```dart
// From the webview_flutter 4.14.1 README
onNavigationRequest: (NavigationRequest request) {
  if (request.url.startsWith('https://www.youtube.com/')) {
    return NavigationDecision.prevent;
  }
  return NavigationDecision.navigate;
},
```

Como demostración de una lista de bloqueo está bien. Conviértelo en una lista de permitidos, que es lo que hace la mayoría, y obtienes `if (request.url.startsWith('https://example.com')) navigate else prevent`. Los prefijos de cadena no son la forma en que funcionan las URLs. Pasé 16 URLs tanto por la comprobación ingenua de prefijo como por la clase de política que se construye más abajo:

```text
URL                                                  naive     policy
https://example.com/pricing                          internal  allowInWebView
https://help.example.com/articles/42                 external  allowInWebView
https://EXAMPLE.com/Pricing                          external  allowInWebView
https://example.com:8443/admin                       internal  allowInWebView
https://example.com.evil.net/login                   internal  openExternally
https://example.com@evil.net/login                   internal  openExternally
https://notexample.com/                              external  openExternally
https://evil.net/?next=https://example.com           external  openExternally
http://example.com/                                  external  openExternally
mailto:support@example.com                           external  openExternally
tel:+15550100                                        external  openExternally
about:blank                                          external  allowInWebView
about:srcdoc                                         external  block
javascript:alert(1)                                  external  block
intent://scan/#Intent;scheme=zxing;end               external  block
file:///data/data/com.example/shared_prefs/x.xml     external  block
```

Dos filas son las peligrosas. `https://example.com.evil.net/login` es un host que pertenece a quien haya registrado `evil.net`. `https://example.com@evil.net/login` pone `example.com` en la parte de userinfo de la URL, así que el navegador se conecta a `evil.net`. Ambas pasan la comprobación de prefijo y se renderizan dentro de tu app. Las demás discrepancias son falsos negativos: un host en mayúsculas o un subdominio se expulsan del WebView sin motivo.

La solución es dejar que `Uri` haga el análisis. `Uri.parse('https://EXAMPLE.com@evil.net:8443/x').host` devuelve `evil.net`: en minúsculas, sin userinfo ni puerto. Compara eso, nunca la cadena cruda.

## Construir la política de lista de permitidos

Mantén la decisión en una clase de Dart simple, sin imports de Flutter ni de plugins. Eso la hace comprobable con pruebas unitarias mediante `flutter test`, lo cual importa porque no puedes ejecutar un WebView real en una prueba de widgets.

```dart
// Flutter 3.44, Dart 3.12, webview_flutter 4.14.1
enum LinkAction { allowInWebView, openExternally, block }

class LinkPolicy {
  const LinkPolicy({
    required this.allowedHosts,
    this.allowSubdomains = true,
    this.externalSchemes = const {'mailto', 'tel', 'sms'},
  });

  /// Hosts that may load inside the WebView, lower case, no scheme, no port.
  final Set<String> allowedHosts;
  final bool allowSubdomains;

  /// Schemes handed to the OS instead of the WebView.
  final Set<String> externalSchemes;

  LinkAction decide(String url) {
    final uri = Uri.tryParse(url);
    if (uri == null) return LinkAction.block;

    switch (uri.scheme) {
      case 'https':
        return _isAllowedHost(uri.host)
            ? LinkAction.allowInWebView
            : LinkAction.openExternally;
      case 'http':
        // Never load cleartext in-app, even for your own host.
        return LinkAction.openExternally;
      case 'about':
        return url == 'about:blank'
            ? LinkAction.allowInWebView
            : LinkAction.block;
      default:
        return externalSchemes.contains(uri.scheme)
            ? LinkAction.openExternally
            : LinkAction.block; // javascript:, file:, intent:, data:, ...
    }
  }

  bool _isAllowedHost(String host) {
    // Uri.host is already lower case and has userinfo and port stripped.
    if (allowedHosts.contains(host)) return true;
    if (!allowSubdomains) return false;
    return allowedHosts.any((allowed) => host.endsWith('.$allowed'));
  }
}
```

Algunas decisiones aquí son deliberadas:

- **Tres resultados, no dos.** `NavigationDecision` es binario, pero "no en el WebView" se divide en "ábrelo en otro lugar" y "descártalo". Un enlace a tu página de Twitter debería abrir el navegador. Una URL `javascript:` o `file:` no debería ir a ninguna parte.
- **La comprobación de subdominios usa `'.$allowed'`**, con el punto inicial. `host.endsWith('example.com')` aceptaría `notexample.com`, que es la misma clase de bug que la comprobación de prefijo.
- **`http` nunca se permite dentro de la app.** Si tu propio sitio todavía sirve un enlace `http`, saldrá de la app en lugar de cargarse sin TLS. Cambia esto solo si de verdad lo necesitas, y ten en cuenta que Android bloquea el tráfico en texto claro por defecto desde la API 28, a menos que tu configuración de seguridad de red lo permita.
- **`about:blank` está permitido.** En iOS, `loadHtmlString` sin un `baseUrl` y un frame en blanco recién abierto aparecen ambos como `about:blank`. Bloquearlo rompe esos flujos.
- **Los esquemas desconocidos se bloquean, no se lanzan.** `intent://` en Android puede apuntar a cualquier actividad exportada del dispositivo. Si necesitas un esquema personalizado específico (tu propio `myapp://` o `market://`), agrégalo a `externalSchemes` explícitamente.

La tabla de arriba es la salida de este archivo de pruebas, que se ejecuta en alrededor de un segundo con `flutter test`:

```dart
// Flutter 3.44, Dart 3.12
import 'package:flutter_test/flutter_test.dart';
import 'package:wvguard/link_policy.dart';

void main() {
  const policy = LinkPolicy(allowedHosts: {'example.com'});

  final cases = <String, LinkAction>{
    'https://help.example.com/articles/42': LinkAction.allowInWebView,
    'https://EXAMPLE.com/Pricing': LinkAction.allowInWebView,
    'https://example.com.evil.net/login': LinkAction.openExternally,
    'https://example.com@evil.net/login': LinkAction.openExternally,
    'https://notexample.com/': LinkAction.openExternally,
    'http://example.com/': LinkAction.openExternally,
    'mailto:support@example.com': LinkAction.openExternally,
    'javascript:alert(1)': LinkAction.block,
    'intent://scan/#Intent;scheme=zxing;end': LinkAction.block,
  };

  for (final entry in cases.entries) {
    test(entry.key, () => expect(policy.decide(entry.key), entry.value));
  }
}
```

## Conectar la política al NavigationDelegate

Los pasos, en orden:

1. Agrega los paquetes: `flutter pub add webview_flutter url_launcher`. `webview_flutter` 4.14.1 requiere Flutter 3.38 o posterior, Android SDK 24+ e iOS 13+.
2. Crea el `WebViewController` una sola vez, en `initState`, no en `build`.
3. Llama a `setNavigationDelegate` con un `onNavigationRequest` que mapee cada `LinkAction` a un `NavigationDecision`.
4. Para `openExternally`, dispara `launchUrl` con `LaunchMode.externalApplication` y devuelve `prevent` de inmediato.
5. Llama a `loadRequest` al final, después de que el delegate esté configurado.

```dart
// Flutter 3.44, Dart 3.12, webview_flutter 4.14.1, url_launcher 6.3.2
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'link_policy.dart';

class HelpCenterPage extends StatefulWidget {
  const HelpCenterPage({super.key});

  @override
  State<HelpCenterPage> createState() => _HelpCenterPageState();
}

class _HelpCenterPageState extends State<HelpCenterPage> {
  static final Uri _home = Uri.parse('https://help.example.com/');
  static const LinkPolicy _policy = LinkPolicy(allowedHosts: {'example.com'});

  late final WebViewController _controller;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(
        NavigationDelegate(onNavigationRequest: _onNavigationRequest),
      )
      ..loadRequest(_home);
  }

  NavigationDecision _onNavigationRequest(NavigationRequest request) {
    // Android never asks about subframes; iOS does. Leave iframes alone here.
    if (!request.isMainFrame) return NavigationDecision.navigate;

    switch (_policy.decide(request.url)) {
      case LinkAction.allowInWebView:
        return NavigationDecision.navigate;
      case LinkAction.openExternally:
        unawaited(_openExternally(Uri.parse(request.url)));
        return NavigationDecision.prevent;
      case LinkAction.block:
        debugPrint('Blocked navigation to ${request.url}');
        return NavigationDecision.prevent;
    }
  }

  Future<void> _openExternally(Uri uri) async {
    final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!opened && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('No app can open $uri')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Help')),
      body: WebViewWidget(controller: _controller),
    );
  }
}
```

`flutter analyze` no reporta problemas en este archivo. Vale la pena destacar dos detalles.

El callback retorna de forma síncrona. `onNavigationRequest` acepta un `Future<NavigationDecision>`, pero en iOS el plugin hace `await` de tu callback dentro de `decidePolicyForNavigationAction` de WebKit, así que cada milisegundo que pasas ahí es un milisegundo en que la página queda congelada. Esperar a `launchUrl` (que espera a que el sistema operativo cambie de app) es exactamente lo que no debes hacer ahí. Decide de forma síncrona, retorna y lanza en segundo plano con `unawaited`.

La comprobación de `mounted` después de `await launchUrl` está ahí porque el usuario puede haber cerrado la página para cuando el sistema operativo responda. Si ese patrón es nuevo para ti, lo cubrí en detalle en [usar BuildContext de forma segura después de un await](/es/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).

## Lo que Android e iOS realmente envían a onNavigationRequest

Esta es la parte que la documentación pasa por alto con "some platforms may also trigger this callback from calls to `loadRequest`". Leí las implementaciones de plataforma en `webview_flutter_android` 4.14.1 y `webview_flutter_wkwebview` 3.26.1, y las dos se comportan de forma muy distinta.

### Android: el lado nativo cancela primero, Dart vuelve a emitir

En Android el callback lo dispara `WebViewClient.shouldOverrideUrlLoading`. Cuando configuras `onNavigationRequest`, el plugin llama a `setSynchronousReturnValueForShouldOverrideUrlLoading(true)`. A partir de ahí, el `WebViewClientProxyApi` nativo devuelve `request.isForMainFrame() && true` para cada navegación: cada navegación de frame principal se cancela de inmediato, antes de que siquiera se le haya preguntado a Dart. Luego Dart ejecuta tu callback y, si devuelve `navigate`, el plugin llama a `loadUrl` con la misma URL y los encabezados de la solicitud original.

Consecuencias:

- **Nunca se pregunta por los subframes.** `_handleNavigation` retorna temprano cuando `isForMainFrame` es false, porque `loadUrl` no puede cargar una URL en un iframe. Un iframe en tu página puede navegar a cualquier parte y tu callback nunca se ejecuta. Por eso el código de arriba no se molesta en vigilar `isMainFrame == false`.
- **Las navegaciones por POST se saltan el callback.** La propia documentación de Android indica que `shouldOverrideUrlLoading` no se llama para solicitudes POST. Un `<form method="post" action="https://evil.net/collect">` en una página que permitiste se enviará y cargará `evil.net` en tu WebView.
- **`loadRequest` no se comprueba.** Las URLs que cargas tú mismo a través del controller no pasan por `shouldOverrideUrlLoading`.
- **Atrás, adelante y recargar no se comprueban.** Son operaciones de historial, no navegaciones nuevas.
- **Las descargas se enrutan por el mismo callback.** El `DownloadListener` del plugin llama a `_handleNavigation` para una URL de descarga, así que una lista de permitidos también detiene las descargas desde otros hosts.

### iOS y macOS: WebKit espera tu respuesta

En WebKit el callback lo dispara `WKNavigationDelegate.webView(_:decidePolicyFor:decisionHandler:)`. El plugin espera tu callback y mapea `navigate` a `.allow` y `prevent` a `.cancel`. Nada se vuelve a emitir, así que los cuerpos de POST y los encabezados se conservan intactos.

Consecuencias:

- **El `loadRequest` inicial pasa por tu callback.** Si tu lista de permitidos no incluye la URL que cargas en `initState`, obtienes una página en blanco y ningún error. La regla de `about:blank` en la política existe por la misma razón cuando usas `loadHtmlString`.
- **Sí se pregunta por los subframes.** Cada carga de iframe, incluidos los reproductores de YouTube embebidos, los elementos de Stripe y reCAPTCHA, llega con `isMainFrame: false`. Trátalos como navegaciones de frame principal y romperás cada embed de la página.
- **Los enlaces `target="_blank"` llegan dos veces.** Una solicitud de nueva ventana primero tiene un frame de destino nulo, así que `isMainFrame` es `false`. Luego el `WKUIDelegate` `onCreateWebView` del plugin carga esa solicitud en el mismo WebView, que vuelve a pasar por tu callback como una navegación de frame principal. La segunda llamada es donde se aplica tu política, lo cual es otra razón para dejar pasar `isMainFrame == false`.

Si necesitas vigilar los iframes de forma consistente en ambas plataformas, el navigation delegate es la herramienta equivocada. Envía un encabezado `Content-Security-Policy` con `frame-src` desde tu propio servidor, que ambos WebViews respetan.

## Trampas que dejan pasar tráfico por fuera de la lista de permitidos

El navigation delegate controla las navegaciones de página. No ve:

- **Subrecursos.** Las imágenes, los scripts y las llamadas `fetch` y `XMLHttpRequest` a otros hosts se cargan con normalidad. `onNavigationRequest` no es un firewall. Si se puede lograr que una página que permitiste ejecute un script de un atacante, ese script puede exfiltrar datos con un `fetch` y tu callback nunca se disparará. Corrige la página (CSP `connect-src`) en lugar del WebView.
- **Cambios de ruta en single-page apps.** `history.pushState` cambia la URL sin una navegación. Escucha `onUrlChange` si necesitas rastrearlo; no se puede bloquear, pero tampoco puede cambiar el origen, así que no es una vía de escape.
- **POST en Android**, cubierto arriba. Si los usuarios pueden enviar formularios en el sitio embebido, valida las URLs de `action` del lado del servidor.
- **Cadenas de redirecciones.** Una redirección del servidor desde una URL permitida hacia otro host se reporta a `shouldOverrideUrlLoading` en Android (el caso de `WebResourceRequest.isRedirect()`) y a la comprobación de la política de navegación en WebKit, así que la lista de permitidos sigue aplicándose. Pruébalo de todos modos con tu flujo real de inicio de sesión, porque a los proveedores de OAuth les encanta una redirección de cuatro saltos.

Tres más que muerden en la práctica:

- **OAuth y SSO.** Si tu sitio inicia la sesión de los usuarios a través de `accounts.google.com` o un tenant de Entra ID, esos hosts deben estar en la lista de permitidos o el flujo rebota al navegador y nunca regresa. Además, Google se niega a mostrar su página de inicio de sesión en un WebView embebido, así que la solución real para el inicio de sesión con Google es `flutter_web_auth_2` o un SDK nativo, no una lista de permitidos más larga.
- **Enlaces `intent://` en Android.** Los sitios que hacen deep link hacia apps usan URLs `intent://...#Intent;...;end`. Chrome las entiende; `url_launcher` no analiza la sintaxis de intents. Bloquearlas, como hace la política, es el valor por defecto seguro. Si las necesitas, analiza el parámetro `S.browser_fallback_url` y abre esa URL en su lugar.
- **Dominios internacionalizados.** El `Uri` de Dart no hace conversión IDNA: `Uri.parse('https://bücher.example/x').host` es `b%C3%BCcher.example`, mientras que `https://xn--bcher-kva.example/x` se queda como `xn--bcher-kva.example`. Los WebViews generalmente reportan la forma punycode, así que pon la escritura `xn--` en tu lista de permitidos.

Si tu WebView muestra tu propia compilación de Flutter web en lugar de un sitio normal, el enrutamiento dentro de la app vive en tu router, no en el WebView, y [rutas anidadas y deep links con go_router](/es/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) es el artículo más relevante. El escalado de fuentes dentro de esa compilación embebida de Flutter web es otra trampa distinta que documenté en [Flutter Text renderizándose fuera de pantalla en un WebView de Android](/es/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/).

## Las decisiones asíncronas se comportan distinto según la plataforma

Como Android cancela primero y vuelve a emitir después, un callback `async` en Android nunca bloquea la página: la página anterior permanece en pantalla, completamente interactiva, hasta que tu `Future` se completa y el plugin llama a `loadUrl`. Si el usuario toca un segundo enlace mientras tanto, ambas decisiones se ejecutan y gana el `loadUrl` que se ejecute al último. En iOS el mismo callback `async` mantiene abierto el decision handler de WebKit, así que la página espera. Si tu política realmente necesita E/S (por ejemplo, obtener una lista de permitidos remota), cárgala una vez antes de que se abra la página y mantén `onNavigationRequest` síncrono, como en el ejemplo de arriba. Eso da un comportamiento idéntico en ambas plataformas.

Si necesitas un control que la API multiplataforma no expone, como interceptar solicitudes de subrecursos con `shouldInterceptRequest`, no hay ningún hook de Dart para eso en 4.14.1. Eso implica código nativo, y aplica el enfoque de [agregar código específico de plataforma en Flutter sin plugins](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/). Prueba primero la lista de permitidos; es suficiente para la gran mayoría de las páginas embebidas.

Por último, recuerda que cualquier cosa que incluyas en el binario de la app, incluida la lista de permitidos, la puede leer cualquiera que desempaquete el APK o el IPA. Eso está bien para una lista de nombres de host, pero es un buen recordatorio de [lo que un atacante puede extraer de una app de Flutter](/es/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/): la lista de permitidos protege a tus usuarios de desviarse, no es un secreto.

## Fuentes

- [webview_flutter 4.14.1 en pub.dev](https://pub.dev/packages/webview_flutter), incluido el ejemplo de `onNavigationRequest` del README y la tabla de plataformas compatibles.
- [Referencia de la API de `NavigationDelegate`](https://pub.dev/documentation/webview_flutter/latest/webview_flutter/NavigationDelegate-class.html).
- [Código fuente de webview_flutter_android](https://github.com/flutter/packages/tree/main/packages/webview_flutter/webview_flutter_android): `android_webview_controller.dart` (`_handleNavigation`) y `WebViewClientProxyApi.java` (`shouldOverrideUrlLoading`).
- [Código fuente de webview_flutter_wkwebview](https://github.com/flutter/packages/tree/main/packages/webview_flutter/webview_flutter_wkwebview): `webkit_webview_controller.dart` (`decidePolicyForNavigationAction`, `onCreateWebView`).
- [Android `WebViewClient.shouldOverrideUrlLoading`](https://developer.android.com/reference/android/webkit/WebViewClient#shouldOverrideUrlLoading(android.webkit.WebView,%20android.webkit.WebResourceRequest)).
- [Apple `webView(_:decidePolicyFor:decisionHandler:)`](https://developer.apple.com/documentation/webkit/wknavigationdelegate/webview(_:decidepolicyfor:decisionhandler:)-2ni62).
- [url_launcher 6.3.2 en pub.dev](https://pub.dev/packages/url_launcher) y [`LaunchMode`](https://pub.dev/documentation/url_launcher/latest/url_launcher/LaunchMode.html).
- [`Uri.host` de Dart](https://api.dart.dev/stable/dart-core/Uri/host.html).
