---
title: "Correção: embed do YouTube mostra \"Video unavailable\" (Error 152 / 153) no Flutter com youtube_player_iframe"
description: "O Error 153 significa que o YouTube não recebeu Referer; o 152 significa que a página afirma ser youtube.com. Atualize o youtube_player_iframe para 6.0.2 e defina origin como https://<id do seu app>, ou use youtube-nocookie na 5.x."
pubDate: 2026-09-26
template: error-page
tags:
  - "errors"
  - "flutter"
  - "webview"
  - "ios"
  - "android"
lang: "pt-br"
translationOf: "2026/09/fix-youtube-embed-video-unavailable-error-152-153-in-flutter-youtube-player-iframe"
translatedBy: "claude"
translationDate: 2026-09-26
---

O YouTube agora se recusa a reproduzir um embed a menos que consiga identificar quem está incorporando o vídeo, e em um app Flutter essa identidade é a origem da página HTML que o `youtube_player_iframe` carrega na WebView. O Error 153 significa que a página não tinha origem nenhuma, então nenhum `Referer` foi enviado. O Error 152 significa que a página afirmou ser `https://www.youtube.com`, que é exatamente o que o `youtube_player_iframe` 5.2.2 e anteriores fazem por padrão. A correção é atualizar para o `youtube_player_iframe` 6.0.2 e definir `YoutubePlayerParams(origin: 'https://com.yourcompany.yourapp')`. Se você está preso na 5.x, defina `origin: 'https://www.youtube-nocookie.com'` em vez disso, e nunca o ID do seu app.

Tudo abaixo foi medido em um simulador iOS 26.5 (iPhone 17 Pro Max, Xcode 27.0) com Flutter 3.44.8 / Dart 3.12.2, `webview_flutter` 4.14.1 e `webview_flutter_wkwebview` 3.26.1, e conferido com o código-fonte do `youtube_player_iframe` 5.2.2 e 6.0.2. Não rodei a matriz no Android, então as observações sobre Android vêm da documentação do YouTube e do código-fonte do pacote, não de um dispositivo.

## O erro em contexto

A área do player renderiza o próprio cartão de erro do YouTube em vez do vídeo:

```text
Video unavailable
Error 153
Video player configuration error
```

ou, na outra variante (relatada em [youtube_player_flutter#1155](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155) com `youtube_player_iframe` ^5.2.1):

```text
This video is unavailable
Error 152-4
Watch on YouTube
```

A partir de agosto de 2025, apps que não mudavam havia meses pararam de reproduzir os mesmos vídeos da noite para o dia, e é por isso que issues como [#1084 "Working App Broke In prod, Youtube Changed Something"](https://github.com/sarbagyastha/youtube_player_flutter/issues/1084) e [#1124 "Error code 153"](https://github.com/sarbagyastha/youtube_player_flutter/issues/1124) acumularam dezenas de comentários "aqui também". Os vídeos são públicos e permitem incorporação, reproduzem no Chrome do celular e falham só dentro do app.

## Por que o YouTube rejeita o embed

A página [YouTube API Services Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality) diz que clientes que usam o player incorporado, incluindo a IFrame Player API, "devem se identificar por meio do cabeçalho de requisição HTTP Referer". Um navegador faz isso sozinho: o `<iframe>` que aponta para `youtube.com/embed/...` é requisitado com um `Referer` derivado da página que o contém, sob a política recomendada `strict-origin-when-cross-origin`. Uma WebView móvel não tem página da qual derivá-lo, a menos que você forneça uma. Para HTML local, o caminho documentado é a URL base: `loadDataWithBaseURL` no Android e `loadHTMLString:baseURL:` no iOS, com um valor no formato `https://<app-id>`, por exemplo `https://com.google.android.youtube`.

A [referência da IFrame API](https://developers.google.com/youtube/iframe_api_reference) agora lista o erro 153 como "A requisição não inclui o cabeçalho HTTP Referer ou identificação equivalente do cliente da API." O erro 152 não está documentado. O `youtube_player_iframe` o trata como mais um código de "não incorporável", mas nas minhas medições ele dispara em um vídeo perfeitamente incorporável sempre que a origem da página que o incorpora é `https://www.youtube.com`. O YouTube identifica quem incorpora como o próprio YouTube e recusa.

Agora veja o que o pacote faz. O `youtube_player_iframe` não carrega uma URL do YouTube; ele carrega um `assets/player.html` empacotado com `WebViewController.loadHtmlString`, e essa página cria o player pela IFrame API. Na 5.2.2 o código relevante é:

```dart
// youtube_player_iframe 5.2.2, lib/src/player_params.dart
this.origin = 'https://www.youtube.com',

// youtube_player_iframe 5.2.2, lib/src/controller/youtube_player_controller.dart
baseUrl: kIsWeb ? Uri.base.origin : params.origin,
// ...
'host': params.origin ?? 'https://www.youtube.com',
```

Então, por padrão, a página HTML local recebe a origem `https://www.youtube.com`, o player é criado com `host: 'https://www.youtube.com'`, e as player vars `origin` e `widget_referrer` também são `https://www.youtube.com`. Isso é o erro 152. E como um único parâmetro alimenta tanto a origem da página quanto o host do iframe, você não consegue corrigir colocando o ID do seu app em `origin`: o player então tenta carregar o iframe de `https://com.yourcompany.yourapp`, que não existe.

A versão 6.0.0 (16 de maio de 2026) separou os dois. `origin` agora tem padrão `null`, um novo `privacyEnhancedMode` (padrão `true`) escolhe o host, e a URL base recorre a esse host:

```dart
// youtube_player_iframe 6.0.2, lib/src/player_params.dart
String get host => privacyEnhancedMode
    ? 'https://www.youtube-nocookie.com'
    : 'https://www.youtube.com';

// youtube_player_iframe 6.0.2, lib/src/controller/youtube_player_controller.dart
baseUrl: kIsWeb ? Uri.base.origin : (params.origin ?? params.host),
```

O mantenedor fechou a [#1155](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155) com "Fixed with v6.0.0" e os relatos de 153 ([#1124](https://github.com/sarbagyastha/youtube_player_flutter/issues/1124), [#1150](https://github.com/sarbagyastha/youtube_player_flutter/issues/1150)) foram fechados em 30 de maio de 2026, quando a 6.0.1 saiu.

## Reprodução mínima: uma matriz de origens de página

Para ver qual combinação o YouTube aceita, reduzi o pacote ao que ele realmente faz: um `WebViewController` que carrega uma pequena página HTML com `loadHtmlString`, cria um `YT.Player` com um determinado `host`, chama `playVideo()` no `onReady` e reporta cada `onStateChange` e `onError` de volta ao Dart por um canal JavaScript. O vídeo é `M7lc1UVf-VE`, a demo da IFrame API do próprio YouTube, que permite incorporação.

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

Estes são os resultados, com cada caso rodando por 25 segundos no simulador (`state=1` é "reproduzindo"):

| Caso | Origem da página (`baseUrl`) | `host` do player | Resultado |
| --- | --- | --- | --- |
| Padrão do `youtube_player_iframe` 5.2.2 | `https://www.youtube.com` | `https://www.youtube.com` | `ERROR=152` |
| 6.0.x com `privacyEnhancedMode: false` | `https://www.youtube.com` | `https://www.youtube.com` | `ERROR=152` |
| Sem URL base (`about:blank`, origem `null`) | nenhuma | `https://www.youtube.com` | `ERROR=153` |
| Contorno da 5.x, padrão da 6.0.x | `https://www.youtube-nocookie.com` | `https://www.youtube-nocookie.com` | `state=1`, reproduz |
| ID do app + host nocookie | `https://com.example.ytrepro` | `https://www.youtube-nocookie.com` | `state=1`, reproduz |
| ID do app + host youtube.com | `https://com.example.ytrepro` | `https://www.youtube.com` | `state=1`, reproduz |
| ID do app no `origin` da 5.x (também vira o host) | `https://com.example.ytrepro` | `https://com.example.ytrepro` | nunca chega ao `onReady` |

Duas regras saem dessa tabela. Uma página sem origem recebe 153, uma página que finge ser `youtube.com` recebe 152, e qualquer outra coisa com uma origem `https://` real reproduz. E o host do iframe precisa ser um host real do YouTube, e é por isso que colocar o ID do seu app no parâmetro `origin` da 5.x produz um player vazio e silencioso em vez de uma correção.

## Correção 1: atualize para o youtube_player_iframe 6.0.2 e defina origin como o ID do seu app

Esta é a correção recomendada. Ela exige Flutter 3.38 ou posterior e Dart 3.10 ou posterior, os novos mínimos da 6.0.0.

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

Com `origin` definido, a 6.0.2 o usa como URL base do `loadHtmlString` e como as player vars `origin` e `widget_referrer`, enquanto o iframe continua carregando de `youtube-nocookie.com` (ou `youtube.com` se você desligar o `privacyEnhancedMode`). Essa é a linha "ID do app + host nocookie" acima, e corresponde ao formato `https://<app-id>` que o YouTube documenta. É também a abordagem na qual os colaboradores convergiram no [PR #1126](https://github.com/sarbagyastha/youtube_player_flutter/pull/1126), que propôs exatamente essa separação entre origin e host antes de a 6.0.0 lançá-la.

Se você deixar `origin` sem definir, a 6.0.2 ainda funciona: a origem da página recorre a `https://www.youtube-nocookie.com` (a linha "padrão da 6.0.x"). Definir o ID do seu app ainda é melhor, porque é o que os termos do YouTube pedem, e não depende de o YouTube continuar tratando `youtube-nocookie.com` como um incorporador aceitável.

Atualizar a partir da 5.x tem uma breaking change que você vai encontrar de imediato: o `YoutubePlayerScaffold` não existe mais. Substitua-o por `YoutubePlayer`, que agora cuida da tela cheia sozinho:

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

A 6.0.1 também removeu o parâmetro `modestbranding`, então apague-o se você o passa.

## Correção 2: preso na 5.x, use youtube-nocookie como origin

Se você ainda não pode migrar para o Flutter 3.38, o `youtube_player_iframe` 5.2.2 (Flutter 3.24+) pode ser corrigido com uma mudança de uma linha que várias pessoas confirmaram na [#1112](https://github.com/sarbagyastha/youtube_player_flutter/issues/1112) e na [#1155](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155):

```dart
// youtube_player_iframe 5.2.2, Flutter 3.24+
final controller = YoutubePlayerController(
  params: const YoutubePlayerParams(
    origin: 'https://www.youtube-nocookie.com',
  ),
);
```

Na 5.x esse único valor vira ao mesmo tempo a origem da página, o host do iframe e as player vars, que é a linha "contorno da 5.x" da tabela: um host real do YouTube e uma origem de página que não é `youtube.com`. Não coloque o ID do seu app aqui na 5.x. Ele vira também o host do iframe e o player nunca carrega.

## Correção 3: sua própria WebView, dê uma URL base à página

Se você incorpora o YouTube por conta própria com `webview_flutter` ou `flutter_inappwebview` em vez de usar o pacote, a regra é a mesma. Sempre passe uma URL base ao carregar HTML local, e faça dela o ID do seu app:

```dart
// webview_flutter 4.14.1
await controller.loadHtmlString(
  html,
  baseUrl: 'https://com.yourcompany.yourapp', // never omit: null gives Error 153
);
```

Se você carrega uma URL de embed diretamente em vez de HTML local, adicione o cabeçalho você mesmo. O `loadRequest` aceita cabeçalhos nas duas plataformas, que é o caminho `loadUrl(url, additionalHttpHeaders)` / `loadRequest:` que a documentação do YouTube descreve:

```dart
// webview_flutter 4.14.1
await controller.loadRequest(
  Uri.parse('https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?playsinline=1'),
  headers: const {'Referer': 'https://com.yourcompany.yourapp/'},
);
```

O mesmo vale para o `flutter_inappwebview`, que o `youtube_player_flutter` usa por baixo dos panos: passe `baseUrl: WebUri('https://com.yourcompany.yourapp')` para `loadData`. A [#1150](https://github.com/sarbagyastha/youtube_player_flutter/issues/1150) é a versão Windows (WebView2) desse erro naquele pacote.

## Armadilhas e erros parecidos

**Seu tratador de erros pode não reconhecer 152 ou 153 pelo que são.** O `youtube_player_iframe` 6.0.2 mapeia os códigos brutos por meio de `YoutubeError.fromCode`, que conhece `152` (`sameAsNotEmbeddable2`) mas não `153`, então um 153 chega como `YoutubeError.unknown`. Na 5.2.2, tanto 152 quanto 153 são mapeados para `unknown`. Se você mostra uma mensagem de "vídeo não incorporável" com base no enum, vai mostrar a coisa errada. Registre o código bruto no log enquanto depura isso.

**Desligar o `privacyEnhancedMode` na 6.x traz o 152 de volta**, a menos que você também defina `origin`. Com `privacyEnhancedMode: false` e sem `origin`, a URL base recorre a `https://www.youtube.com`, que é a segunda linha da tabela. Defina `origin` como o ID do seu app e o host youtube.com reproduz normalmente.

**Os erros 150 e 101 são outro problema.** Eles significam que o dono desativou a incorporação daquele vídeo. Nenhuma mudança de origem ou de Referer os corrige; abra o vídeo no app do YouTube com `url_launcher` em vez disso.

**"This video is unavailable, Error code: 15"** de setembro de 2025 ([#1112](https://github.com/sarbagyastha/youtube_player_flutter/issues/1112), [#1125](https://github.com/sarbagyastha/youtube_player_flutter/issues/1125)) era da mesma família de verificações de identidade na 5.x e responde às mesmas correções de origem.

**O Flutter web é diferente.** Na web, o pacote ignora o seu `origin` e usa `Uri.base.origin`, a origem real do seu site, porque o navegador envia o `Referer` sozinho. Se você recebe 153 ali, quase certamente o seu servidor está enviando `Referrer-Policy: no-referrer` ou `same-origin`, o que remove o cabeçalho na requisição cross-origin do iframe. Troque para `strict-origin-when-cross-origin`, como o YouTube recomenda, ou adicione `<meta name="referrer" content="strict-origin-when-cross-origin">` ao `web/index.html`. Simon Willison esbarrou na mesma coisa com o padrão `same-origin` do Django e [escreveu sobre isso](https://til.simonwillison.net/youtube/fixing-153-embed). Se você também serve o build web do Flutter atrás de um cache agressivo, garanta que o novo `index.html` chegue de fato aos usuários; [builds em cache desatualizados após recarregar](/pt-br/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) são uma armadilha à parte.

**Navigation delegates podem desfazer a correção.** Se você envolve o player no seu próprio `NavigationDelegate` e impede toda navegação que não seja o seu domínio, pode bloquear os próprios frames do embed. Permita os hosts do YouTube explicitamente; a abordagem de correspondência de host em [como impedir que uma WebView do Flutter navegue para URLs externas](/pt-br/2026/09/how-to-block-a-flutter-webview-from-navigating-to-external-urls/) funciona com uma allowlist de `www.youtube.com`, `www.youtube-nocookie.com` e `m.youtube.com`.

**Abrir a URL do vídeo não é o mesmo bug.** A [flutter/flutter#178705](https://github.com/flutter/flutter/issues/178705) relata 153 ao abrir um link com `launchUrl`, que sai completamente do seu app. Ela foi fechada como inválida e diz respeito ao navegador ou ao app do YouTube no dispositivo, não à sua WebView.

## Relacionados

- [Como impedir que uma WebView do Flutter navegue para URLs externas](/pt-br/2026/09/how-to-block-a-flutter-webview-from-navigating-to-external-urls/) cobre a correspondência de host com `NavigationDelegate` no `webview_flutter` 4.14.1.
- [Corrigir texto do Flutter renderizado fora da tela em uma WebView Android com escala de fonte do sistema](/pt-br/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/) é outro bug de incorporação em WebView com correção de um parâmetro.
- [Corrigir o Flutter web servindo um build em cache desatualizado após recarregar](/pt-br/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) importa se você publicar a mudança no `index.html` da web descrita acima.
- [Flutter 3.44 separando Material e Cupertino do SDK](/pt-br/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) vale a leitura antes da atualização para Flutter 3.38+ que o `youtube_player_iframe` 6.x exige.

## Fontes

- [YouTube API Services: Required Minimum Functionality, identidade do cliente da API e formato do Referer](https://developers.google.com/youtube/terms/required-minimum-functionality)
- [Referência da YouTube IFrame Player API, códigos do onError](https://developers.google.com/youtube/iframe_api_reference)
- [Changelog do youtube_player_iframe (5.2.2, 6.0.0, 6.0.1, 6.0.2)](https://pub.dev/packages/youtube_player_iframe/changelog)
- [sarbagyastha/youtube_player_flutter#1155: Error 152-4 na 5.2.1, corrigido na 6.0.0](https://github.com/sarbagyastha/youtube_player_flutter/issues/1155)
- [sarbagyastha/youtube_player_flutter#1124: Error code 153](https://github.com/sarbagyastha/youtube_player_flutter/issues/1124)
- [sarbagyastha/youtube_player_flutter#1112: Error code 15 e o contorno com a origem youtube-nocookie](https://github.com/sarbagyastha/youtube_player_flutter/issues/1112)
- [sarbagyastha/youtube_player_flutter#1126: enviar origin separado do host](https://github.com/sarbagyastha/youtube_player_flutter/pull/1126)
- [Simon Willison: Error 153 Video player configuration error em embeds do YouTube](https://til.simonwillison.net/youtube/fixing-153-embed)
