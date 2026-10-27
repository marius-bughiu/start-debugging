---
title: "Como chamar a API da OpenAI a partir de um app Flutter web sem expor a chave de API"
description: "Tudo o que você compila em um build Flutter web, incluindo valores de --dart-define, vai para o navegador em texto puro. O único padrão seguro é um pequeno proxy de backend que guarda a chave, autentica o usuário, fixa o modelo e repassa o SSE da Responses API em streaming. Proxy completo em Dart com shelf e cliente Flutter, testados com Flutter 3.44, Dart 3.12 e http 1.6."
pubDate: 2026-10-27
template: how-to
tags:
  - "flutter"
  - "flutter-web"
  - "dart"
  - "openai"
  - "security"
  - "how-to"
lang: "pt-br"
translationOf: "2026/10/how-to-call-the-openai-api-from-a-flutter-web-app-without-exposing-the-api-key"
translatedBy: "claude"
translationDate: 2026-10-27
---

**Resposta curta:** não é possível esconder uma chave de API da OpenAI dentro de um app Flutter web. `--dart-define`, `String.fromEnvironment`, um asset `.env` incluído no pacote e a ofuscação acabam todos em arquivos que o navegador baixa, e a chave também fica visível no cabeçalho `Authorization` de cada requisição no DevTools. Coloque a chave em um servidor que você controla, faça o app Flutter chamar esse servidor com o token de sessão do próprio usuário e deixe o servidor montar a requisição para a OpenAI (modelo fixo, tokens limitados, `safety_identifier` definido) e repassar a resposta em streaming. Abaixo está um proxy completo e testado, escrito em Dart com `shelf`, e um cliente Flutter web que renderiza a resposta em streaming token por token.

Tudo aqui foi compilado e executado com Flutter 3.44.8, Dart 3.12.2, `package:http` 1.6.0 e `package:shelf` 1.4 contra a Responses API da OpenAI (`POST /v1/responses`). O proxy foi testado de ponta a ponta em um navegador contra um upstream falso local que emite o mesmo formato de server-sent events da OpenAI, então o comportamento de streaming e de CORS descrito abaixo foi medido, não presumido.

## Por que `--dart-define` e arquivos `.env` não protegem a chave

A primeira tentativa mais comum é assim:

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

Compilado com uma chave falsa:

```bash
flutter build web --release --dart-define=OPENAI_API_KEY=sk-proj-DEMO1234567890leak
grep -o '.\{30\}sk-proj-[A-Za-z0-9]*.\{5\}' build/web/main.dart.js
```

O build de release, minificado pelo dart2js, ainda contém esta linha:

```text
A.aC(["Authorization","Bearer sk-proj-DEMO1234567890leak"],s,
```

`String.fromEnvironment` é uma constante de tempo de compilação, então o compilador incorpora o valor como um literal de string. A minificação renomeia identificadores, nunca criptografa strings. Também compilei o mesmo app com `flutter build web --wasm`, e a chave está em `main.dart.wasm` como bytes em texto puro (`grep -a` a encontra). Se você precisa relembrar o que o build Wasm produz, veja [como compilar um app Flutter web com WebAssembly](/pt-br/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/): ele muda o runtime, não quem pode ler suas constantes.

As outras variantes populares falham do mesmo jeito:

- Um arquivo `.env` listado em `assets:` no `pubspec.yaml` é servido em `/assets/.env` (os assets do Flutter web são arquivos estáticos comuns). Qualquer pessoa pode baixá-lo.
- `flutter build --obfuscate` não está disponível para builds web (a documentação do Flutter aponta a minificação como alternativa), e no mobile ele apenas renomeia símbolos, nunca literais de string.
- Dividir a chave em pedaços e concatená-la em tempo de execução só atrasa uma pessoa por um minuto. A string final continua aparecendo no cabeçalho da requisição.

Não existe correção no lado do cliente, porque o navegador precisa enviar a chave para a OpenAI. Quem controla o navegador controla a requisição. A própria [orientação de segurança de chaves de API](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety) da OpenAI diz o mesmo: nunca implante a chave em navegadores ou apps móveis, roteie as requisições pelo seu próprio backend. Uma chave vazada não é apenas um problema de cobrança. Dependendo das permissões, ela pode ler suas respostas, arquivos e vector stores armazenados, e usar todos os modelos aos quais seu projeto tem acesso.

## O que o proxy precisa fazer (e por que "apenas repassar o corpo" não basta)

Um proxy que copia o corpo recebido para a OpenAI e só adiciona a chave apenas muda o problema de lugar: agora qualquer pessoa pode usar a URL do seu proxy como um endpoint gratuito da OpenAI. Um proxy útil faz cinco coisas:

1. **Autentica quem chama** com uma credencial que pertence ao usuário (um ID token do Firebase, seu cookie de sessão, um access token OIDC), e não com um segredo compartilhado do app, que também poderia ser extraído.
2. **Limita a taxa por usuário**, para que uma conta não consiga esgotar seu orçamento.
3. **Aceita apenas os campos esperados.** O cliente envia um prompt. O servidor decide o modelo, as instruções e `max_output_tokens`. Se o cliente pudesse escolher `model`, um atacante escolheria o mais caro.
4. **Monta a requisição upstream** com a chave secreta e um `safety_identifier`, uma string estável por usuário (máximo de 64 caracteres, com hash se derivada de um e-mail) que permite à OpenAI atribuir um abuso a um dos seus usuários em vez de a toda a sua organização. Ele substitui o parâmetro `user` mais antigo, veja o [artigo da OpenAI sobre safety identifier](https://help.openai.com/en/articles/5428082-how-to-incorporate-a-safety-identifier).
5. **Repassa a resposta em streaming sem buffer**, para que o usuário veja os tokens à medida que chegam, em vez de esperar a conclusão completa.

## Passos para colocar a OpenAI atrás do seu próprio endpoint

1. Crie um projeto de servidor Dart para o proxy e adicione `shelf` e `http`.
2. Armazene a chave da OpenAI como um segredo do lado do servidor (variável de ambiente ou o gerenciador de segredos da sua plataforma), nunca no repositório do Flutter.
3. Implemente `POST /api/chat`: verifique o usuário, limite a taxa, valide o prompt, chame `/v1/responses` com `stream: true` e repasse o stream SSE.
4. Restrinja o CORS à origem do seu app web, ou sirva o build do Flutter a partir da mesma origem e dispense o CORS por completo.
5. No app Flutter, chame `/api/chat` com o token do usuário e interprete os eventos `response.output_text.delta` do stream.
6. Implante o proxy (Cloud Run, Fly.io, uma VM, qualquer coisa que execute um executável Dart ou um contêiner) e passe a URL dele ao build do Flutter com `--dart-define=CHAT_PROXY_URL=...`. Uma URL pode ser distribuída; um segredo não.

## O proxy: cerca de 100 linhas de Dart

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

Alguns detalhes fazem mais trabalho do que parece:

- **`'shelf.io.buffer_output': false`** é o que faz o streaming funcionar. Sem ele, o `shelf_io` coloca o corpo da resposta em buffer e o navegador recebe tudo só no final. Com ele, o curl recebeu cada evento SSE no mesmo ritmo de 400 ms em que o upstream falso os escreveu.
- **`store: false`** diz à OpenAI para não manter a resposta para recuperação posterior. Deixe ativado se você depende de `previous_response_id` para conversas de vários turnos, mas então guarde também os IDs de resposta no servidor, para que um usuário não possa continuar a conversa de outro adivinhando IDs.
- **O corpo do erro upstream é registrado em log, não devolvido.** As mensagens de erro da OpenAI podem incluir detalhes de organização ou projeto que você não precisa entregar a um navegador.
- **`OPENAI_BASE_URL`** existe para que você possa apontar o proxy para um upstream falso nos testes, que é exatamente como o verifiquei. Os IDs de modelo mudam com frequência; consulte a lista atual na [página de modelos da OpenAI](https://developers.openai.com/api/docs/models) e altere `_model` no servidor sem mexer no app.

Executá-lo contra o upstream falso com curl mostra as três proteções funcionando:

```bash
# no token -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8080/api/chat -d '{"prompt":"hi"}'

# valid token, client tries to pick a model -> streams, model is ignored
curl -sN -X POST localhost:8080/api/chat -H 'Authorization: Bearer demo-alice' \
  -d '{"prompt":"hi","model":"gpt-6-astra"}'
```

O upstream falso registrou o que de fato saiu do servidor: `"model":"gpt-6-luna"`, `"safety_identifier":"alice"` e `Authorization: Bearer <server key>`. O campo `model` do cliente nunca passou. Uma segunda requisição do mesmo usuário em menos de dois segundos recebeu `429 slow down`.

## Substituindo a autenticação de demonstração

`_verifyUser` é a única parte que você precisa reescrever antes de publicar. A regra é que a credencial deve identificar um usuário e ser emitida por algo que o atacante não consiga imitar:

- **Firebase Authentication:** o app Flutter chama `FirebaseAuth.instance.currentUser!.getIdToken()` e o envia como bearer token. O proxy verifica a assinatura do JWT contra as chaves públicas de assinatura do Google e confere `aud` (o ID do seu projeto Firebase), `iss` e `exp`, e então usa a claim `sub` como `userId`.
- **Sua própria sessão de backend:** se o app Flutter é servido do mesmo site que sua API existente, um cookie de sessão `SameSite=Lax` ou `Strict` é suficiente, e você nem precisa de um cabeçalho `Authorization`.
- **OIDC (Entra ID, Auth0, Keycloak):** valide a assinatura, a audience e o scope do access token exatamente como faria com qualquer outra API. A [configuração de CORS e JWT para uma API protegida em ASP.NET Core](/pt-br/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) cobre as mesmas regras de preflight e de cabeçalhos do lado do servidor.

Apps públicos anônimos são o caso difícil. Sem login, o melhor que você pode fazer é limitar a taxa por IP, adicionar uma verificação de bots como Firebase App Check ou Cloudflare Turnstile e definir um orçamento mensal rígido no projeto da OpenAI. Parta do princípio de que o endpoint será descoberto e automatizado por scripts.

O mapa `_lastCall` em memória também só funciona para uma única instância. Ao escalar horizontalmente, mova a limitação de taxa para o Redis ou para o limitador de taxa da sua plataforma, e adicione um orçamento diário de tokens por usuário lendo `usage` do evento `response.completed`.

## O cliente Flutter web: streaming de SSE com `package:http`

Desde o `package:http` 1.3.0, o `BrowserClient` usa a Fetch API em vez de `XMLHttpRequest`, então `client.send()` na web expõe o corpo da resposta como um stream real de chunks. É tudo o que você precisa para ler server-sent events; não há necessidade de um pacote SSE separado.

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

Em um widget, acrescente cada delta a um `StringBuffer` dentro de `setState`:

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

Compilei este cliente com `flutter build web --release --dart-define=CHAT_PROXY_URL=http://localhost:8080/api/chat`, servi-o a partir de `localhost:8081` (uma origem diferente da do proxy, então o CORS foi exercitado) e cliquei no botão em um navegador. O upstream falso emite uma palavra a cada 400 ms, e a interface registrou os deltas em 25, 416, 820, 1223 e 1627 ms: renderização incremental real, não um único blob em buffer no final. Um `grep` no `main.dart.js` desse build encontra a URL do proxy e nenhum vestígio da chave do servidor.

Se o usuário puder sair da tela no meio da resposta, mantenha a `StreamSubscription` em vez de usar `await for` e cancele-a em `dispose`. Cancelar fecha o fetch, o que fecha a conexão upstream do proxy e impede que a OpenAI gere (e cobre) o restante. O padrão é o mesmo de [como cancelar uma StreamSubscription em dispose no Flutter](/pt-br/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/); o `package:http` 1.6.0 corrigiu especificamente o cancelamento de streams de resposta na web que estão aguardando o próximo chunk, então fique na 1.6.0 ou posterior.

## Armadilhas ao implantar

**Erros de CORS sem código de status.** Se `ALLOWED_ORIGIN` não corresponder exatamente à origem da página (esquema, host e porta), o navegador bloqueia a resposta e o Dart vê apenas um `ClientException: Failed to fetch` genérico. A requisição ainda pode ter chegado à OpenAI e custado dinheiro. A correção mais limpa é evitar o CORS: sirva `build/web` da mesma origem que `/api/chat`, seja pelo próprio proxy ou atrás de um único proxy reverso. Durante o desenvolvimento, o Flutter 3.38 e posteriores podem encaminhar um prefixo de caminho para o seu proxy local por meio de uma [regra de proxy em `web_dev_config.yaml`](https://docs.flutter.dev/platform-integration/web/web-dev-config-file), o que também dá chamadas de mesma origem em `flutter run -d chrome`.

**O buffering da plataforma quebra o streaming.** Alguns hosts e CDNs colocam respostas `text/event-stream` em buffer ou impõem um timeout de resposta de 30 a 60 segundos. Se os tokens chegam todos de uma vez em produção mas fazem streaming localmente, verifique as configurações de streaming de resposta da plataforma antes de culpar o Dart. O Nginx precisa de `proxy_buffering off;` (ou de um cabeçalho de resposta `X-Accel-Buffering: no`) para o location.

**Mantenha camadas de cache longe de `/api/`.** Se você colocar uma CDN, um service worker personalizado ou um cache HTTP na frente do app, exclua o caminho do proxy para que respostas em streaming nunca sejam armazenadas em cache nem reproduzidas. Builds desatualizados são um problema à parte, tratado em [por que o Flutter web serve um build em cache desatualizado após recarregar](/pt-br/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/).

**A mesma regra vale para o mobile.** Um build Android ou iOS torna a extração um pouco menos conveniente, não impossível: as strings são recuperáveis de `libapp.so` com ferramentas padrão. Ferramentas como o [FlutterGuard CLI](/pt-br/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/) existem justamente para mostrar o que um atacante consegue extrair de um build de release. Use o mesmo proxy para todas as plataformas.

**Voz em tempo real é a única exceção, e ainda precisa de um servidor.** Para a Realtime API sobre WebRTC, o navegador pode se conectar diretamente à OpenAI, mas apenas com uma chave efêmera de curta duração (`ek_...`) que o seu servidor emite chamando `POST /v1/realtime/client_secrets` com a chave real. A chave padrão continua nunca saindo do servidor. Veja o [guia da Realtime API com WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc) da OpenAI.

**Prefere .NET no servidor?** O formato do proxy não depende do Dart. Uma minimal API do ASP.NET Core que faz streaming de uma resposta de LLM com `HttpClient` e `IAsyncEnumerable` é apresentada passo a passo em [chamar a API do Claude a partir de uma minimal API do .NET 11 com streaming](/pt-br/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/); troque a URL upstream e o corpo da requisição pelos da OpenAI e mantenha as mesmas regras de autenticação, limitação de taxa e fixação de modelo.

### Leia a seguir

- [Como configurar CORS para uma API protegida por JWT no ASP.NET Core 11](/pt-br/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/)
- [Como chamar a API do Claude a partir de uma minimal API do .NET 11 com streaming](/pt-br/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/)
- [Como cancelar uma StreamSubscription em dispose no Flutter](/pt-br/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)
- [FlutterGuard CLI: o que um atacante consegue extrair de um app Flutter 3.x?](/pt-br/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/)

### Fontes

- [Best practices for API key safety](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety) (Central de Ajuda da OpenAI)
- [How to incorporate a safety identifier](https://help.openai.com/en/articles/5428082-how-to-incorporate-a-safety-identifier) (Central de Ajuda da OpenAI)
- [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses) (documentação da OpenAI)
- [Realtime API with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc) (documentação da OpenAI)
- [package:http changelog](https://pub.dev/packages/http/changelog) (BrowserClient com Fetch na 1.3.0, correção de cancelamento de streams na web na 1.6.0)
- [package:shelf](https://pub.dev/packages/shelf) (pub.dev)
- [Set up a web development configuration file](https://docs.flutter.dev/platform-integration/web/web-dev-config-file) (documentação do Flutter)
