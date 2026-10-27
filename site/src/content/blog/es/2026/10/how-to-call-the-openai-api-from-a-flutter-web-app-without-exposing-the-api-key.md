---
title: "Cómo llamar a la API de OpenAI desde una app web de Flutter sin exponer la clave de API"
description: "Todo lo que compilas en una build web de Flutter, incluidos los valores de --dart-define, llega al navegador en texto plano. El único patrón seguro es un pequeño proxy de backend que guarda la clave, autentica al usuario, fija el modelo y devuelve el SSE de la Responses API en streaming. Proxy completo con Dart shelf y cliente Flutter, probado con Flutter 3.44, Dart 3.12 y http 1.6."
pubDate: 2026-10-27
template: how-to
tags:
  - "flutter"
  - "flutter-web"
  - "dart"
  - "openai"
  - "security"
  - "how-to"
lang: "es"
translationOf: "2026/10/how-to-call-the-openai-api-from-a-flutter-web-app-without-exposing-the-api-key"
translatedBy: "claude"
translationDate: 2026-10-27
---

**Respuesta corta:** no puedes ocultar una clave de API de OpenAI dentro de una app web de Flutter. `--dart-define`, `String.fromEnvironment`, un asset `.env` incluido en el paquete y la ofuscación terminan en archivos que el navegador descarga, y además la clave es visible en el encabezado `Authorization` de cada solicitud en DevTools. Pon la clave en un servidor que controles, haz que la app Flutter llame a ese servidor con el token de sesión del propio usuario y deja que el servidor construya la solicitud a OpenAI (modelo fijo, tokens limitados, `safety_identifier` definido) y devuelva la respuesta en streaming. A continuación tienes un proxy completo y probado, escrito en Dart con `shelf`, y un cliente web de Flutter que muestra la respuesta en streaming token por token.

Todo esto se compiló y ejecutó con Flutter 3.44.8, Dart 3.12.2, `package:http` 1.6.0 y `package:shelf` 1.4 contra la Responses API de OpenAI (`POST /v1/responses`). El proxy se probó de extremo a extremo en un navegador contra un upstream falso local que emite la misma forma de eventos enviados por el servidor que OpenAI, así que el comportamiento de streaming y CORS descrito abajo está medido, no supuesto.

## Por qué `--dart-define` y los archivos `.env` no protegen la clave

El primer intento habitual se ve así:

```dart
// Flutter 3.44, Dart 3.12, http 1.6 -- DO NOT SHIP THIS
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

const apiKey = String.fromEnvironment('OPENAI_API_KEY');

void main() => runApp(MaterialApp(
      home: TextButton(
        onPressed: () => http.post(
          Uri.parse('https://api.openai.com/v1/responses'),
          headers: {'Authorization': 'Bearer $apiKey'},
        ),
        child: const Text('Ask'),
      ),
    ));
```

Compilado con una clave falsa:

```bash
flutter build web --release --dart-define=OPENAI_API_KEY=sk-proj-DEMO1234567890leak
grep -o '.\{30\}sk-proj-[A-Za-z0-9]*.\{5\}' build/web/main.dart.js
```

La build de release, minificada por dart2js, sigue conteniendo esta línea:

```text
A.aC(["Authorization","Bearer sk-proj-DEMO1234567890leak"],s,
```

`String.fromEnvironment` es una constante en tiempo de compilación, así que el compilador inserta el valor como un literal de cadena. La minificación renombra identificadores, nunca cifra cadenas. También compilé la misma app con `flutter build web --wasm`, y la clave está en `main.dart.wasm` como bytes en claro (`grep -a` la encuentra). Si necesitas un repaso de lo que produce la build Wasm, consulta [cómo compilar una app web de Flutter con WebAssembly](/es/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/): cambia el runtime, no quién puede leer tus constantes.

Las otras variantes populares fallan de la misma manera:

- Un archivo `.env` listado en `assets:` de `pubspec.yaml` se sirve en `/assets/.env` (los assets de Flutter web son archivos estáticos normales). Cualquiera puede descargarlo.
- `flutter build --obfuscate` no está disponible para builds web (la documentación de Flutter remite a la minificación), y en móvil solo renombra símbolos, nunca literales de cadena.
- Dividir la clave en trozos y concatenarla en tiempo de ejecución solo retrasa a una persona un minuto. La cadena final sigue apareciendo en el encabezado de la solicitud.

No existe una solución del lado del cliente porque el navegador tiene que enviar la clave a OpenAI. Quien controla el navegador controla la solicitud. La propia [guía de seguridad de claves de API](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety) de OpenAI dice lo mismo: nunca despliegues la clave en navegadores ni en apps móviles, enruta las solicitudes a través de tu propio backend. Una clave filtrada no es solo un problema de facturación. Según sus permisos, puede leer tus respuestas almacenadas, archivos y almacenes de vectores, y usar todos los modelos a los que tenga acceso tu proyecto.

## Qué tiene que hacer el proxy (y por qué "solo reenviar el cuerpo" no basta)

Un proxy que copia el cuerpo entrante a OpenAI y solo añade la clave nada más traslada el problema: ahora cualquiera puede usar la URL de tu proxy como un endpoint gratuito de OpenAI. Un proxy útil hace cinco cosas:

1. **Autentica a quien llama** con una credencial que pertenece al usuario (un ID token de Firebase, tu cookie de sesión, un access token OIDC), no con un secreto compartido de la app que a su vez se podría extraer.
2. **Limita la frecuencia por usuario**, para que una sola cuenta no pueda agotar tu presupuesto.
3. **Acepta solo los campos que esperas.** El cliente envía un prompt. El servidor decide el modelo, las instrucciones y `max_output_tokens`. Si el cliente pudiera elegir `model`, un atacante elegiría el más caro.
4. **Construye la solicitud upstream** con la clave secreta y un `safety_identifier`, una cadena estable por usuario (máximo 64 caracteres, con hash si se deriva de un correo) que permite a OpenAI atribuir el abuso a uno de tus usuarios en lugar de a toda tu organización. Reemplaza al parámetro `user` anterior, consulta el [artículo de OpenAI sobre el identificador de seguridad](https://help.openai.com/en/articles/5428082-how-to-incorporate-a-safety-identifier).
5. **Devuelve la respuesta en streaming sin búfer**, para que el usuario vea los tokens según llegan en lugar de esperar la respuesta completa.

## Pasos para poner OpenAI detrás de tu propio endpoint

1. Crea un proyecto de servidor Dart para el proxy y añade `shelf` y `http`.
2. Guarda la clave de OpenAI como un secreto del lado del servidor (variable de entorno o el gestor de secretos de tu plataforma), nunca en el repositorio de Flutter.
3. Implementa `POST /api/chat`: verifica al usuario, limita la frecuencia, valida el prompt, llama a `/v1/responses` con `stream: true` y reenvía el flujo SSE.
4. Restringe CORS al origen de tu app web, o sirve la build de Flutter desde el mismo origen y evita CORS por completo.
5. En la app Flutter, llama a `/api/chat` con el token del usuario y analiza los eventos `response.output_text.delta` del flujo.
6. Despliega el proxy (Cloud Run, Fly.io, una VM, cualquier cosa que ejecute un ejecutable de Dart o un contenedor) y pásale su URL a la build de Flutter con `--dart-define=CHAT_PROXY_URL=...`. Una URL se puede publicar sin problema; un secreto no.

## El proxy: unas 100 líneas de Dart

```yaml
# pubspec.yaml for the proxy
name: chat_proxy
environment:
  sdk: ^3.12.0
dependencies:
  http: ^1.6.0
  shelf: ^1.4.2
```

```dart
// bin/server.dart -- Dart 3.12, shelf 1.4, http 1.6
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:shelf/shelf.dart';
import 'package:shelf/shelf_io.dart' as io;

final _apiKey = Platform.environment['OPENAI_API_KEY']!;
final _baseUrl =
    Platform.environment['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1';
final _allowedOrigin =
    Platform.environment['ALLOWED_ORIGIN'] ?? 'https://app.example.com';
const _model = 'gpt-6-luna'; // pinned on the server, never taken from the client
const _maxInputChars = 4000;
final _client = http.Client();
final _lastCall = <String, DateTime>{};

Future<void> main() async {
  final handler =
      const Pipeline().addMiddleware(_cors()).addHandler(_router);
  await io.serve(handler, InternetAddress.anyIPv4,
      int.parse(Platform.environment['PORT'] ?? '8080'));
}

Future<Response> _router(Request req) async {
  if (req.method == 'POST' && req.url.path == 'api/chat') return _chat(req);
  return Response.notFound('not found');
}

Future<Response> _chat(Request req) async {
  // 1. Who is calling? Replace with real verification (Firebase ID token,
  //    your own session cookie, an OIDC access token, ...).
  final userId = await _verifyUser(req.headers['authorization']);
  if (userId == null) return Response(401, body: 'unauthorized');

  // 2. Cheap per-user throttle: one request every 2 seconds.
  final now = DateTime.now();
  final last = _lastCall[userId];
  if (last != null && now.difference(last) < const Duration(seconds: 2)) {
    return Response(429, body: 'slow down');
  }
  _lastCall[userId] = now;

  // 3. Accept only the fields you expect. The client sends a prompt, nothing else.
  final body = jsonDecode(await req.readAsString()) as Map<String, dynamic>;
  final prompt = body['prompt'];
  if (prompt is! String || prompt.isEmpty || prompt.length > _maxInputChars) {
    return Response(400, body: 'bad prompt');
  }

  // 4. Build the upstream request on the server, with the secret key.
  final upstreamReq = http.Request('POST', Uri.parse('$_baseUrl/responses'))
    ..headers.addAll({
      'Authorization': 'Bearer $_apiKey',
      'Content-Type': 'application/json',
    })
    ..body = jsonEncode({
      'model': _model,
      'instructions': 'You are a helpful assistant inside the Acme app.',
      'input': prompt,
      'max_output_tokens': 800,
      'stream': true,
      'store': false,
      'safety_identifier': userId,
    });

  final upstream = await _client.send(upstreamReq);
  if (upstream.statusCode != 200) {
    final detail = await upstream.stream.bytesToString();
    stderr.writeln('upstream ${upstream.statusCode}: $detail');
    return Response(502, body: 'upstream error');
  }

  // 5. Pipe the SSE stream straight through, unbuffered.
  return Response.ok(
    upstream.stream,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
    context: {'shelf.io.buffer_output': false},
  );
}

Future<String?> _verifyUser(String? authorization) async {
  // Demo only: accept "Bearer demo-<user>". Never ship this.
  if (authorization == null || !authorization.startsWith('Bearer demo-')) {
    return null;
  }
  return authorization.substring('Bearer demo-'.length);
}

Middleware _cors() => (inner) => (req) async {
      final cors = {
        'Access-Control-Allow-Origin': _allowedOrigin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Vary': 'Origin',
      };
      if (req.method == 'OPTIONS') return Response.ok(null, headers: cors);
      final res = await inner(req);
      return res.change(headers: cors);
    };
```

Algunos detalles hacen más trabajo del que parece:

- **`'shelf.io.buffer_output': false`** es lo que hace que el streaming funcione. Sin él, `shelf_io` almacena el cuerpo de la respuesta en búfer y el navegador recibe todo al final. Con él, curl recibió cada evento SSE con la misma cadencia de 400 ms con la que el upstream falso los escribió.
- **`store: false`** le indica a OpenAI que no conserve la respuesta para recuperarla después. Déjalo activado si dependes de `previous_response_id` para conversaciones de varios turnos, pero entonces guarda también los IDs de respuesta en el servidor, para que un usuario no pueda continuar la conversación de otro adivinando IDs.
- **El cuerpo del error upstream se registra, no se devuelve.** Los mensajes de error de OpenAI pueden incluir detalles de la organización o del proyecto que no necesitas entregar a un navegador.
- **`OPENAI_BASE_URL`** existe para que puedas apuntar el proxy a un upstream falso en las pruebas, que es exactamente como lo verifiqué. Los IDs de modelo cambian con frecuencia; consulta la lista actual en la [página de modelos de OpenAI](https://developers.openai.com/api/docs/models) y cambia `_model` en el servidor sin tocar la app.

Ejecutarlo contra el upstream falso con curl muestra las tres protecciones funcionando:

```bash
# no token -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8080/api/chat -d '{"prompt":"hi"}'

# valid token, client tries to pick a model -> streams, model is ignored
curl -sN -X POST localhost:8080/api/chat -H 'Authorization: Bearer demo-alice' \
  -d '{"prompt":"hi","model":"gpt-6-astra"}'
```

El upstream falso registró lo que realmente salió del servidor: `"model":"gpt-6-luna"`, `"safety_identifier":"alice"` y `Authorization: Bearer <server key>`. El campo `model` del cliente nunca pasó. Una segunda solicitud del mismo usuario en menos de dos segundos recibió `429 slow down`.

## Cómo reemplazar la autenticación de demostración

`_verifyUser` es la única parte que debes reescribir antes de publicar. La regla es que la credencial debe identificar a un usuario y haber sido emitida por algo que el atacante no pueda suplantar:

- **Firebase Authentication:** la app Flutter llama a `FirebaseAuth.instance.currentUser!.getIdToken()` y lo envía como token bearer. El proxy verifica la firma del JWT contra las claves públicas de firma de Google y comprueba `aud` (el ID de tu proyecto de Firebase), `iss` y `exp`, y luego usa el claim `sub` como `userId`.
- **Tu propia sesión de backend:** si la app Flutter se sirve desde el mismo sitio que tu API existente, una cookie de sesión `SameSite=Lax` o `Strict` es suficiente, y no necesitas ningún encabezado `Authorization`.
- **OIDC (Entra ID, Auth0, Keycloak):** valida la firma, la audiencia y el scope del access token exactamente como harías con cualquier otra API. La [configuración de CORS y JWT para una API protegida de ASP.NET Core](/es/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) cubre las mismas reglas de preflight y encabezados desde el lado del servidor.

Las apps públicas anónimas son el caso difícil. Sin inicio de sesión, lo mejor que puedes hacer es limitar la frecuencia por IP, añadir una verificación de bots como Firebase App Check o Cloudflare Turnstile y fijar un presupuesto mensual estricto en el proyecto de OpenAI. Asume que el endpoint será descubierto y automatizado con scripts.

Además, el mapa `_lastCall` en memoria solo funciona con una instancia. Cuando escales horizontalmente, mueve la limitación a Redis o al limitador de frecuencia de tu plataforma, y añade un presupuesto diario de tokens por usuario leyendo `usage` del evento `response.completed`.

## El cliente web de Flutter: streaming SSE con `package:http`

Desde `package:http` 1.3.0, `BrowserClient` usa la Fetch API en lugar de `XMLHttpRequest`, así que `client.send()` en la web expone el cuerpo de la respuesta como un verdadero flujo de fragmentos. Eso es todo lo que necesitas para leer eventos enviados por el servidor; no hace falta un paquete SSE aparte.

```dart
// Flutter 3.44, Dart 3.12, http 1.6
import 'dart:convert';

import 'package:http/http.dart' as http;

const proxyUrl = String.fromEnvironment(
  'CHAT_PROXY_URL',
  defaultValue: 'https://api.example.com/api/chat',
);

/// Streams the text deltas of one Responses API answer through your proxy.
Stream<String> askProxy(String prompt, String userToken) async* {
  final client = http.Client(); // BrowserClient (fetch) on the web
  try {
    final req = http.Request('POST', Uri.parse(proxyUrl))
      ..headers['Authorization'] = 'Bearer $userToken'
      ..headers['Content-Type'] = 'application/json'
      ..body = jsonEncode({'prompt': prompt});
    final res = await client.send(req);
    if (res.statusCode != 200) {
      throw http.ClientException('proxy returned ${res.statusCode}');
    }
    final lines =
        res.stream.transform(utf8.decoder).transform(const LineSplitter());
    await for (final line in lines) {
      if (!line.startsWith('data: ')) continue;
      final event = jsonDecode(line.substring(6)) as Map<String, dynamic>;
      switch (event['type']) {
        case 'response.output_text.delta':
          yield event['delta'] as String;
        case 'error':
          throw http.ClientException('${event['message']}');
      }
    }
  } finally {
    client.close();
  }
}
```

En un widget, añade cada delta a un `StringBuffer` dentro de `setState`:

```dart
// Flutter 3.44, Dart 3.12
Future<void> _ask() async {
  setState(() => _answer.clear());
  await for (final delta in askProxy(_controller.text, await _idToken())) {
    if (!mounted) return;
    setState(() => _answer.write(delta));
  }
}
```

Compilé este cliente con `flutter build web --release --dart-define=CHAT_PROXY_URL=http://localhost:8080/api/chat`, lo serví desde `localhost:8081` (un origen distinto al del proxy, de modo que se ejercitó CORS) e hice clic en el botón en un navegador. El upstream falso emite una palabra cada 400 ms, y la UI registró los deltas a los 25, 416, 820, 1223 y 1627 ms: renderizado incremental real, no un único bloque en búfer al final. `grep` sobre el `main.dart.js` de esa build encuentra la URL del proxy y ningún rastro de la clave del servidor.

Si el usuario puede navegar a otra pantalla a mitad de la respuesta, conserva el `StreamSubscription` en lugar de usar `await for`, y cancélalo en `dispose`. Cancelar cierra el fetch, lo que cierra la conexión upstream del proxy y evita que OpenAI siga generando (y facturando) el resto. El patrón es el mismo que en [cómo cancelar un StreamSubscription en dispose en Flutter](/es/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/); `package:http` 1.6.0 corrigió específicamente la cancelación de flujos de respuesta web que esperan el siguiente fragmento, así que quédate en 1.6.0 o posterior.

## Problemas habituales al desplegar

**Errores de CORS sin código de estado.** Si `ALLOWED_ORIGIN` no coincide exactamente con el origen de la página (esquema, host y puerto), el navegador bloquea la respuesta y Dart solo ve un genérico `ClientException: Failed to fetch`. Aun así, la solicitud puede haber llegado a OpenAI y haber costado dinero. La solución más limpia es evitar CORS: sirve `build/web` desde el mismo origen que `/api/chat`, ya sea desde el propio proxy o detrás de un único proxy inverso. Durante el desarrollo, Flutter 3.38 y posteriores pueden reenviar un prefijo de ruta a tu proxy local mediante una [regla de proxy en `web_dev_config.yaml`](https://docs.flutter.dev/platform-integration/web/web-dev-config-file), lo que también te da llamadas del mismo origen bajo `flutter run -d chrome`.

**El búfer de la plataforma rompe el streaming.** Algunos hosts y CDN almacenan en búfer las respuestas `text/event-stream` o imponen un tiempo de espera de respuesta de 30 a 60 segundos. Si los tokens llegan todos de golpe en producción pero fluyen en local, revisa la configuración de streaming de respuestas de la plataforma antes de culpar a Dart. Nginx necesita `proxy_buffering off;` (o un encabezado de respuesta `X-Accel-Buffering: no`) para esa location.

**Mantén las capas de caché lejos de `/api/`.** Si pones un CDN, un service worker propio o una caché HTTP delante de la app, excluye la ruta del proxy para que las respuestas en streaming nunca se almacenen en caché ni se reproduzcan. Las builds obsoletas son un problema aparte, tratado en [por qué Flutter web sirve una build en caché obsoleta tras recargar](/es/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/).

**La misma regla aplica a móvil.** Una build de Android o iOS hace la extracción algo menos cómoda, no imposible: las cadenas se pueden recuperar de `libapp.so` con herramientas estándar. Herramientas como [FlutterGuard CLI](/es/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/) existen precisamente para mostrar qué puede extraer un atacante de una build de release. Usa el mismo proxy para todas las plataformas.

**La voz en tiempo real es la única excepción, y aun así necesita un servidor.** Para la Realtime API sobre WebRTC, el navegador puede conectarse directamente a OpenAI, pero solo con una clave efímera de corta duración (`ek_...`) que tu servidor genera llamando a `POST /v1/realtime/client_secrets` con la clave real. La clave estándar nunca sale del servidor. Consulta la [guía de la Realtime API con WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc) de OpenAI.

**¿Prefieres .NET en el servidor?** La forma del proxy no depende de Dart. Una minimal API de ASP.NET Core que devuelve en streaming una respuesta de un LLM con `HttpClient` e `IAsyncEnumerable` se explica paso a paso en [llamar a la API de Claude desde una minimal API de .NET 11 con streaming](/es/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/); cambia la URL upstream y el cuerpo de la solicitud por los de OpenAI y mantén las mismas reglas de autenticación, limitación de frecuencia y fijación del modelo.

### Sigue leyendo

- [Cómo configurar CORS para una API protegida con JWT en ASP.NET Core 11](/es/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/)
- [Cómo llamar a la API de Claude desde una minimal API de .NET 11 con streaming](/es/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/)
- [Cómo cancelar un StreamSubscription en dispose en Flutter](/es/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)
- [FlutterGuard CLI: ¿qué puede extraer un atacante de una app Flutter 3.x?](/es/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/)

### Fuentes

- [Best practices for API key safety](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety) (Centro de ayuda de OpenAI)
- [How to incorporate a safety identifier](https://help.openai.com/en/articles/5428082-how-to-incorporate-a-safety-identifier) (Centro de ayuda de OpenAI)
- [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses) (documentación de OpenAI)
- [Realtime API with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc) (documentación de OpenAI)
- [package:http changelog](https://pub.dev/packages/http/changelog) (BrowserClient sobre Fetch en 1.3.0, corrección de cancelación de flujos web en 1.6.0)
- [package:shelf](https://pub.dev/packages/shelf) (pub.dev)
- [Set up a web development configuration file](https://docs.flutter.dev/platform-integration/web/web-dev-config-file) (documentación de Flutter)
