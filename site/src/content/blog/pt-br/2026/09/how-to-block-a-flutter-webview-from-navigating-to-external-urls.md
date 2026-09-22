---
title: "Como impedir que uma WebView do Flutter navegue para URLs externas com NavigationDelegate"
description: "Mantenha uma WebView do Flutter no seu próprio domínio com webview_flutter 4.14.1: faça o parse da URL, compare Uri.host em vez de usar startsWith, entregue mailto: e tel: ao url_launcher e saiba o que Android e iOS realmente enviam para onNavigationRequest."
pubDate: 2026-09-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "webview"
  - "security"
  - "android"
  - "ios"
lang: "pt-br"
translationOf: "2026/09/how-to-block-a-flutter-webview-from-navigating-to-external-urls"
translatedBy: "claude"
translationDate: 2026-09-22
---

**Resposta curta:** com `webview_flutter` 4.14.1 no Flutter 3.44, dê ao `WebViewController` um `NavigationDelegate` cujo `onNavigationRequest` faz o parse de `request.url` com `Uri.tryParse`, retorna `NavigationDecision.navigate` somente quando `uri.scheme == 'https'` e `uri.host` está na sua allowlist, e retorna `NavigationDecision.prevent` para todo o resto, opcionalmente abrindo o link bloqueado no navegador do sistema com `url_launcher`. Não use `url.startsWith('https://example.com')`: isso deixa passar `https://example.com.evil.net` e `https://example.com@evil.net`. E conheça os limites: no Android o callback nunca vê navegações de subframes nem envios de formulário via POST.

O restante deste post constrói essa política passo a passo, mostra a tabela de testes que prova que a verificação ingênua está errada e percorre as diferenças entre plataformas que decidem o que o seu callback consegue ou não bloquear. Tudo abaixo foi compilado e testado com `webview_flutter` 4.14.1, `webview_flutter_android` 4.14.1, `webview_flutter_wkwebview` 3.26.1 e `url_launcher` 6.3.2 no Flutter 3.44.8 / Dart 3.12.2.

## Por que uma WebView sai do seu site

Uma central de ajuda embutida, uma página de checkout ou uma tela de termos de serviço normalmente devem mostrar um único site. A página não sabe disso. Ela contém links no rodapé para o Twitter, um selo "powered by", um botão de OAuth, um endereço de suporte `mailto:` e talvez conteúdo gerado por usuários com links arbitrários. Toque em qualquer um deles e a WebView carrega tudo alegremente dentro do seu app, sem barra de endereço, sem botão de voltar a menos que você tenha criado um, e com o nome do seu app no topo da tela. Isso é um problema de UX (os usuários ficam presos em um site de terceiros) e um problema de confiança (uma página de phishing renderizada dentro do seu app herda a credibilidade do seu app).

O `webview_flutter` expõe um único hook para isso: `NavigationDelegate.onNavigationRequest`. A assinatura na versão 4.14.1 é:

```dart
// webview_flutter 4.14.1
FutureOr<NavigationDecision> Function(NavigationRequest request)? onNavigationRequest
```

`NavigationRequest` carrega exatamente dois campos, `url` (uma `String`) e `isMainFrame` (um `bool`), e `NavigationDecision` tem dois valores, `navigate` e `prevent`. Todo o resto fica por sua conta.

## O exemplo do README é o bug

O README oficial do pacote mostra este trecho:

```dart
// From the webview_flutter 4.14.1 README
onNavigationRequest: (NavigationRequest request) {
  if (request.url.startsWith('https://www.youtube.com/')) {
    return NavigationDecision.prevent;
  }
  return NavigationDecision.navigate;
},
```

Como demonstração de denylist, tudo bem. Inverta para uma allowlist, que é o que a maioria das pessoas faz, e você obtém `if (request.url.startsWith('https://example.com')) navigate else prevent`. Prefixos de string não são como URLs funcionam. Passei 16 URLs tanto pela verificação ingênua por prefixo quanto pela classe de política construída abaixo:

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

Duas linhas são as perigosas. `https://example.com.evil.net/login` é um host que pertence a quem registrou `evil.net`. `https://example.com@evil.net/login` coloca `example.com` na parte de userinfo da URL, então o navegador se conecta a `evil.net`. Ambas passam na verificação por prefixo e são renderizadas dentro do seu app. As outras divergências são falsos negativos: um host em maiúsculas ou um subdomínio é expulso da WebView sem motivo.

A correção é deixar o `Uri` fazer o parse. `Uri.parse('https://EXAMPLE.com@evil.net:8443/x').host` retorna `evil.net`: em minúsculas, com userinfo e porta removidos. Compare isso, nunca a string bruta.

## Construindo a política de allowlist

Mantenha a decisão em uma classe Dart simples, sem imports do Flutter ou de plugins. Isso a torna testável com `flutter test`, o que importa porque você não consegue rodar uma WebView real em um teste de widget.

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

Algumas escolhas aqui são deliberadas:

- **Três resultados, não dois.** `NavigationDecision` é binário, mas "fora da WebView" se divide em "abrir em outro lugar" e "descartar". Um link para a sua página no Twitter deve abrir o navegador. Uma URL `javascript:` ou `file:` não deve ir a lugar nenhum.
- **A verificação de subdomínio usa `'.$allowed'`**, com o ponto no início. `host.endsWith('example.com')` aceitaria `notexample.com`, que é a mesma classe de bug da verificação por prefixo.
- **`http` nunca é permitido dentro do app.** Se o seu próprio site ainda serve um link `http`, ele vai sair do app em vez de carregar sem TLS. Mude isso só se realmente precisar, e observe que o Android já bloqueia tráfego em texto claro por padrão desde a API 28, a menos que a sua configuração de segurança de rede permita.
- **`about:blank` é permitido.** No iOS, `loadHtmlString` sem `baseUrl` e um frame em branco recém-aberto aparecem ambos como `about:blank`. Bloqueá-lo quebra esses fluxos.
- **Esquemas desconhecidos são bloqueados, não lançados.** `intent://` no Android pode apontar para qualquer activity exportada no dispositivo. Se você precisa de um esquema personalizado específico (o seu próprio `myapp://` ou `market://`), adicione-o explicitamente a `externalSchemes`.

A tabela acima é a saída deste arquivo de teste, que roda em cerca de um segundo com `flutter test`:

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

## Conectando a política ao NavigationDelegate

Os passos, em ordem:

1. Adicione os pacotes: `flutter pub add webview_flutter url_launcher`. O `webview_flutter` 4.14.1 exige Flutter 3.38 ou superior, Android SDK 24+ e iOS 13+.
2. Crie o `WebViewController` uma única vez, em `initState`, não em `build`.
3. Chame `setNavigationDelegate` com um `onNavigationRequest` que mapeia cada `LinkAction` para uma `NavigationDecision`.
4. Para `openExternally`, dispare `launchUrl` com `LaunchMode.externalApplication` e retorne `prevent` imediatamente.
5. Chame `loadRequest` por último, depois que o delegate estiver configurado.

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

O `flutter analyze` não reporta nenhum problema neste arquivo. Dois detalhes merecem destaque.

O callback retorna de forma síncrona. `onNavigationRequest` aceita um `Future<NavigationDecision>`, mas no iOS o plugin faz `await` do seu callback dentro do `decidePolicyForNavigationAction` do WebKit, então cada milissegundo gasto ali é um milissegundo em que a página fica congelada. Aguardar `launchUrl` (que espera o sistema operacional trocar de app) é exatamente o que não se deve fazer ali. Decida de forma síncrona, retorne e lance em segundo plano com `unawaited`.

A verificação de `mounted` depois de `await launchUrl` está ali porque o usuário pode ter fechado a página quando o sistema operacional responder. Se esse padrão é novo para você, eu o expliquei em detalhes em [usando BuildContext com segurança depois de um await](/pt-br/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).

## O que Android e iOS realmente enviam para onNavigationRequest

Esta é a parte que a documentação trata superficialmente com "some platforms may also trigger this callback from calls to `loadRequest`". Li as implementações de plataforma em `webview_flutter_android` 4.14.1 e `webview_flutter_wkwebview` 3.26.1, e as duas se comportam de maneira bem diferente.

### Android: o lado nativo cancela primeiro, o Dart reemite

No Android o callback é acionado por `WebViewClient.shouldOverrideUrlLoading`. Quando você define `onNavigationRequest`, o plugin chama `setSynchronousReturnValueForShouldOverrideUrlLoading(true)`. A partir daí, o `WebViewClientProxyApi` nativo retorna `request.isForMainFrame() && true` para toda navegação: toda navegação de frame principal é cancelada imediatamente, antes mesmo de o Dart ser consultado. O Dart então executa o seu callback e, se ele retornar `navigate`, o plugin chama `loadUrl` com a mesma URL e os headers da requisição original.

Consequências:

- **Subframes nunca são consultados.** `_handleNavigation` retorna cedo quando `isForMainFrame` é false, porque `loadUrl` não consegue carregar uma URL dentro de um iframe. Um iframe na sua página pode navegar para qualquer lugar e o seu callback nunca é executado. É por isso que o código acima não se dá ao trabalho de fiscalizar `isMainFrame == false`.
- **Navegações via POST ignoram o callback.** A própria documentação do Android afirma que `shouldOverrideUrlLoading` não é chamado para requisições POST. Um `<form method="post" action="https://evil.net/collect">` em uma página que você permitiu vai ser enviado e carregar `evil.net` na sua WebView.
- **`loadRequest` não é verificado.** URLs que você mesmo carrega pelo controller não passam por `shouldOverrideUrlLoading`.
- **Voltar, avançar e recarregar não são verificados.** São operações de histórico, não navegações novas.
- **Downloads passam pelo mesmo callback.** O `DownloadListener` do plugin chama `_handleNavigation` para uma URL de download, então uma allowlist também impede downloads de outros hosts.

### iOS e macOS: o WebKit espera a sua resposta

No WebKit o callback é acionado por `WKNavigationDelegate.webView(_:decidePolicyFor:decisionHandler:)`. O plugin aguarda o seu callback e mapeia `navigate` para `.allow` e `prevent` para `.cancel`. Nada é reemitido, então corpos de POST e headers chegam intactos.

Consequências:

- **O `loadRequest` inicial passa pelo seu callback.** Se a sua allowlist não inclui a URL que você carrega em `initState`, você obtém uma página em branco e nenhum erro. A regra de `about:blank` na política existe pelo mesmo motivo quando você usa `loadHtmlString`.
- **Subframes são consultados.** Todo carregamento de iframe, incluindo players do YouTube embutidos, Stripe elements e reCAPTCHA, chega com `isMainFrame: false`. Trate-os como navegações de frame principal e você quebra todos os embeds da página.
- **Links com `target="_blank"` chegam duas vezes.** Uma requisição de nova janela tem primeiro um target frame nulo, então `isMainFrame` é `false`. O `WKUIDelegate` `onCreateWebView` do plugin então carrega essa requisição na mesma WebView, e ela volta pelo seu callback como uma navegação de frame principal. A segunda chamada é onde a sua política se aplica, o que é mais um motivo para deixar `isMainFrame == false` passar.

Se você precisa de uma fiscalização consistente de iframes nas duas plataformas, o navigation delegate é a ferramenta errada. Envie um header `Content-Security-Policy` com `frame-src` a partir do seu próprio servidor, que ambas as WebViews respeitam.

## Armadilhas que deixam tráfego escapar da allowlist

O navigation delegate controla navegações de página. Ele não enxerga:

- **Sub-recursos.** Imagens, scripts, chamadas `fetch` e `XMLHttpRequest` para outros hosts carregam normalmente. `onNavigationRequest` não é um firewall. Se uma página que você permitiu puder ser induzida a executar script de um atacante, esse script pode exfiltrar dados com um `fetch` e o seu callback nunca será disparado. Corrija a página (CSP `connect-src`), não a WebView.
- **Mudanças de rota em single-page apps.** `history.pushState` muda a URL sem uma navegação. Escute `onUrlChange` se precisar acompanhar isso; não dá para bloquear, mas também não dá para mudar a origem, então não é uma rota de fuga.
- **POST no Android**, abordado acima. Se os usuários podem enviar formulários no site embutido, valide as URLs de `action` no servidor.
- **Cadeias de redirecionamento.** Um redirecionamento de servidor de uma URL permitida para outro host é reportado a `shouldOverrideUrlLoading` no Android (o caso `WebResourceRequest.isRedirect()`) e à verificação de política de navegação no WebKit, então a allowlist continua valendo. Teste mesmo assim com o seu fluxo de login real, porque provedores de OAuth adoram um redirecionamento de quatro saltos.

Mais três que pegam na prática:

- **OAuth e SSO.** Se o seu site autentica usuários via `accounts.google.com` ou um tenant do Entra ID, esses hosts precisam estar na allowlist, senão o fluxo escapa para o navegador e nunca volta. O Google também se recusa a mostrar a página de login em uma WebView embutida, então a correção de verdade para o login do Google é `flutter_web_auth_2` ou um SDK nativo, não uma allowlist mais longa.
- **Links `intent://` no Android.** Sites que fazem deep link para apps usam URLs `intent://...#Intent;...;end`. O Chrome entende essas URLs; o `url_launcher` não faz o parse da sintaxe de intent. Bloqueá-las, como a política faz, é o padrão seguro. Se você precisar delas, faça o parse do parâmetro `S.browser_fallback_url` e abra essa URL no lugar.
- **Domínios internacionalizados.** O `Uri` do Dart não faz conversão IDNA: `Uri.parse('https://bücher.example/x').host` é `b%C3%BCcher.example`, enquanto `https://xn--bcher-kva.example/x` continua `xn--bcher-kva.example`. As WebViews geralmente reportam a forma punycode, então coloque a grafia `xn--` na sua allowlist.

Se a sua WebView mostra o seu próprio build Flutter web em vez de um site comum, o roteamento dentro do app fica no seu router, não na WebView, e [rotas aninhadas e deep links com go_router](/pt-br/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) é o texto mais relevante. O escalonamento de fonte dentro desse build Flutter web embutido é uma armadilha à parte que descrevi em [Text do Flutter renderizando fora da tela em uma WebView do Android](/pt-br/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/).

## Decisões assíncronas se comportam de forma diferente em cada plataforma

Como o Android cancela primeiro e reemite depois, um callback `async` no Android nunca bloqueia a página: a página antiga continua na tela, totalmente interativa, até o seu `Future` completar e o plugin chamar `loadUrl`. Se o usuário tocar em um segundo link nesse meio-tempo, as duas decisões são executadas e vence o `loadUrl` que rodar por último. No iOS o mesmo callback `async` mantém aberto o decision handler do WebKit, então a página espera. Se a sua política realmente precisa de I/O (por exemplo, buscar uma allowlist remota), carregue-a uma vez antes de a página abrir e mantenha `onNavigationRequest` síncrono, como no exemplo acima. Isso dá um comportamento idêntico nas duas plataformas.

Se você precisa de um controle que a API multiplataforma não expõe, como interceptar requisições de sub-recursos com `shouldInterceptRequest`, não existe hook em Dart para isso na versão 4.14.1. Isso significa código nativo, e a abordagem de [adicionar código específico de plataforma no Flutter sem plugins](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) se aplica. Tente a allowlist primeiro; ela basta para a grande maioria das páginas embutidas.

Por fim, lembre-se de que tudo o que você distribui no binário do app, incluindo a allowlist, pode ser lido por qualquer pessoa que descompacte o APK ou o IPA. Para uma lista de hostnames isso não tem problema, mas é um bom lembrete do [que um atacante consegue extrair de um app Flutter](/pt-br/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/): a allowlist protege os seus usuários de se perderem por aí, ela não é um segredo.

## Fontes

- [webview_flutter 4.14.1 no pub.dev](https://pub.dev/packages/webview_flutter), incluindo o exemplo de `onNavigationRequest` do README e a tabela de suporte por plataforma.
- [Referência da API `NavigationDelegate`](https://pub.dev/documentation/webview_flutter/latest/webview_flutter/NavigationDelegate-class.html).
- [Código-fonte do webview_flutter_android](https://github.com/flutter/packages/tree/main/packages/webview_flutter/webview_flutter_android): `android_webview_controller.dart` (`_handleNavigation`) e `WebViewClientProxyApi.java` (`shouldOverrideUrlLoading`).
- [Código-fonte do webview_flutter_wkwebview](https://github.com/flutter/packages/tree/main/packages/webview_flutter/webview_flutter_wkwebview): `webkit_webview_controller.dart` (`decidePolicyForNavigationAction`, `onCreateWebView`).
- [Android `WebViewClient.shouldOverrideUrlLoading`](https://developer.android.com/reference/android/webkit/WebViewClient#shouldOverrideUrlLoading(android.webkit.WebView,%20android.webkit.WebResourceRequest)).
- [Apple `webView(_:decidePolicyFor:decisionHandler:)`](https://developer.apple.com/documentation/webkit/wknavigationdelegate/webview(_:decidepolicyfor:decisionhandler:)-2ni62).
- [url_launcher 6.3.2 no pub.dev](https://pub.dev/packages/url_launcher) e [`LaunchMode`](https://pub.dev/documentation/url_launcher/latest/url_launcher/LaunchMode.html).
- [Dart `Uri.host`](https://api.dart.dev/stable/dart-core/Uri/host.html).
