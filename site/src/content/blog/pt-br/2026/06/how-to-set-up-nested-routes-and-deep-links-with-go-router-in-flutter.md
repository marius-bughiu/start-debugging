---
title: "Como configurar rotas aninhadas e deep links com go_router no Flutter"
description: "Construa um shell persistente com rotas aninhadas usando ShellRoute e StatefulShellRoute e, em seguida, configure deep links baseados em rotas que reconstroem toda a pilha de páginas. Configuração completa para Android e iOS, além das armadilhas que quebram a pilha de retorno."
pubDate: 2026-06-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "go-router"
  - "navigation"
lang: "pt-br"
translationOf: "2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-22
---

Para aninhar rotas no Flutter com `go_router`, coloque as rotas filhas na lista `routes:` de uma `GoRoute` pai para que a URL construa uma pilha de páginas, e envolva um grupo de rotas em um `ShellRoute` (ou `StatefulShellRoute.indexedStack` para preservar o estado das abas) quando elas devem compartilhar uma interface persistente como uma barra de navegação inferior. Os deep links vêm então quase de graça: o `go_router` analisa a rota recebida contra essa árvore de rotas e reconstrói a pilha correspondente, de modo que um link para `/orders/42` leva o usuário para a página de detalhe do pedido com `/orders` por baixo na pilha de retorno. O único trabalho manual é a configuração nativa da plataforma que diz ao Android e ao iOS para entregar a URL ao Flutter em primeiro lugar. Este guia usa `go_router` 17.3.0 (junho de 2026), Flutter 3.44 stable e Dart 3.x.

As duas ideias que as pessoas confundem são o aninhamento e os deep links, e elas são realmente distintas. O aninhamento tem a ver com o formato da sua árvore de rotas: quais telas ficam dentro de quais e qual layout persiste entre elas. Os deep links têm a ver com uma URL externa que entra no aplicativo e se resolve em uma tela. Eles se encontram em exatamente um ponto: o `go_router` usa a mesma tabela de rotas declarativa para renderizar a navegação interna e para resolver um deep link, e é por isso que uma árvore de rotas bem formada lhe dá deep links corretos sem código adicional.

## Como as sub-rotas transformam uma URL em uma pilha de páginas

Uma `GoRoute` pode carregar sua própria lista `routes:`. Quando a rota correspondente desce mais fundo do que o pai, o `go_router` percorre a árvore e adiciona uma página por nível, de modo que a pilha de retorno resultante espelha os segmentos da URL.

```dart
// go_router 17.3.0, Flutter 3.44, Dart 3.x
final router = GoRouter(
  routes: [
    GoRoute(
      path: '/orders',
      builder: (context, state) => const OrdersScreen(),
      routes: [
        // matches /orders/42 -> stack is [OrdersScreen, OrderDetailScreen]
        GoRoute(
          path: ':id',
          builder: (context, state) {
            final id = state.pathParameters['id']!;
            return OrderDetailScreen(orderId: id);
          },
        ),
      ],
    ),
  ],
);
```

Dois detalhes importam aqui. Primeiro, os caminhos filhos são relativos: o filho é `':id'`, não `'/orders/:id'`. Uma barra inicial em uma sub-rota a torna uma rota absoluta de nível superior e quebra o aninhamento, o que é um dos erros de configuração mais comuns. Segundo, como a pilha é construída a partir da URL, pressionar o botão de voltar do sistema em `/orders/42` retorna para `/orders` mesmo que o usuário tenha chegado diretamente por um deep link. Essa é toda a recompensa do roteamento declarativo: a pilha de retorno é uma função do caminho, não de como o usuário chegou lá.

Leia um parâmetro de rota a partir de `state.pathParameters` e um parâmetro de consulta a partir de `state.uri.queryParameters`. Ambos são simples strings, então faça o parse e valide-os no builder em vez de confiar na URL.

## Compartilhando um layout com ShellRoute

As sub-rotas lhe dão profundidade, mas não lhe dão uma moldura persistente. Se `/orders` e `/profile` devem ambas ser renderizadas dentro do mesmo scaffold com a mesma barra inferior, o que você quer é um `ShellRoute`. Um `ShellRoute` introduz um `Navigator` aninhado: suas rotas filhas são renderizadas em um widget `child` que você coloca dentro do seu shell, e o próprio shell nunca é reconstruído à medida que o usuário se move entre as filhas.

```dart
// go_router 17.3.0 -- one shared scaffold, swappable body
ShellRoute(
  builder: (context, state, child) => ScaffoldWithNavBar(child: child),
  routes: [
    GoRoute(path: '/orders', builder: (_, __) => const OrdersScreen()),
    GoRoute(path: '/profile', builder: (_, __) => const ProfileScreen()),
  ],
),
```

O `child` passado ao builder do shell é a sub-rota correspondente atual. Seu `ScaffoldWithNavBar` coloca `child` no `body` e renderiza o `BottomNavigationBar` ao redor dele. Tocar em uma aba chama `context.go('/profile')`, o navigator aninhado troca o body e o scaffold permanece montado. Essa persistência é toda a razão para recorrer ao `ShellRoute` em vez de uma simples lista de rotas de nível superior.

A limitação: o `ShellRoute` mantém um único navigator, então todas as abas compartilham uma pilha de retorno e o body é reconstruído do zero cada vez que você troca. A posição de rolagem, a entrada de formulário e qualquer estado efêmero dentro de uma aba são perdidos na troca. Para muitos aplicativos isso é aceitável. Para um aplicativo no estilo Instagram, onde cada aba precisa lembrar onde estava, você precisa da variante com estado.

## Dando a cada aba sua própria pilha de retorno com StatefulShellRoute

`StatefulShellRoute.indexedStack` cria um `Navigator` separado por ramo e mantém todos os ramos vivos em um `IndexedStack`, de modo que trocar de abas preserva a pilha e o estado de cada aba. Esse é o padrão de 2026 para qualquer aplicativo com uma barra de navegação inferior onde as abas devem ser independentes.

```dart
// go_router 17.3.0 -- independent stacks per tab
StatefulShellRoute.indexedStack(
  builder: (context, state, navigationShell) =>
      ScaffoldWithNavBar(navigationShell: navigationShell),
  branches: [
    StatefulShellBranch(
      routes: [
        GoRoute(
          path: '/orders',
          builder: (_, __) => const OrdersScreen(),
          routes: [
            GoRoute(
              path: ':id',
              builder: (context, state) =>
                  OrderDetailScreen(orderId: state.pathParameters['id']!),
            ),
          ],
        ),
      ],
    ),
    StatefulShellBranch(
      routes: [
        GoRoute(path: '/profile', builder: (_, __) => const ProfileScreen()),
      ],
    ),
  ],
)
```

O builder lhe entrega um `StatefulNavigationShell` em vez de um `child` simples. Você troca de ramo com `navigationShell.goBranch(index)`, não com `context.go(...)`, porque `goBranch` restaura a pilha existente daquele ramo em vez de iniciar uma navegação nova:

```dart
// go_router 17.3.0 -- the nav bar drives the shell, not context.go
BottomNavigationBar(
  currentIndex: navigationShell.currentIndex,
  onTap: (index) => navigationShell.goBranch(
    index,
    // re-tapping the active tab pops to its root, like native apps
    initialLocation: index == navigationShell.currentIndex,
  ),
  items: const [
    BottomNavigationBarItem(icon: Icon(Icons.list), label: 'Orders'),
    BottomNavigationBarItem(icon: Icon(Icons.person), label: 'Profile'),
  ],
)
```

Versões recentes também expõem um flag `preload` em `StatefulShellBranch`, que constrói a primeira rota de um ramo antes de o usuário visitá-la, trocando algum custo de inicialização por uma primeira troca de aba instantânea. Deixe-o desativado a menos que um profiler mostre que a primeira troca está travando.

## Configurando as plataformas para que um deep link chegue ao Flutter

Um deep link só funciona se o sistema operacional rotear a URL para o seu aplicativo. O `go_router` não pode fazer essa parte por você; ele assume o controle apenas depois que o Flutter recebe o link. Os deep links integrados do Flutter estão ativados por padrão no Flutter 3.44, então você basicamente adiciona as rotas da plataforma e, no Android, ativa a verificação de App Links.

Há dois tipos de links, e a configuração nativa difere:

- **Esquema personalizado** (`myapp://orders/42`): trivial de configurar, funciona offline, mas qualquer aplicativo pode reivindicar o mesmo esquema. Adequado para transferências internas de aplicativo para aplicativo.
- **Universal links / App Links** (`https://example.com/orders/42`): vinculados a um domínio que você possui por meio de um arquivo de associação hospedado, então apenas o seu aplicativo pode reivindicá-los. É isso que você quer para links compartilhados pela web.

No Android, adicione um `intent-filter` à atividade principal em `android/app/src/main/AndroidManifest.xml`. O atributo `android:autoVerify="true"` é o que promove um simples link `https` a um App Link verificado:

```xml
<!-- AndroidManifest.xml -->
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="example.com" />
</intent-filter>
```

Os deep links do Flutter estão ativados por padrão, mas se você algum dia precisar alterná-los, o flag explícito é uma entrada `meta-data` chamada `flutter_deeplinking_enabled` definida como `true` ou `false`. Os App Links também exigem um arquivo `assetlinks.json` hospedado em `https://example.com/.well-known/assetlinks.json` contendo o nome do pacote do seu aplicativo e a impressão digital de assinatura, ou o sistema operacional recorrerá a abrir o navegador.

No iOS, a chave equivalente em `Info.plist` é `FlutterDeepLinkingEnabled`. Os universal links precisam de um entitlement de Associated Domains (`applinks:example.com`) mais um arquivo `apple-app-site-association` hospedado no seu domínio. Um esquema personalizado, por outro lado, usa uma entrada `CFBundleURLTypes` em `Info.plist`. O XML preciso para ambas as plataformas fica nos cookbooks do Flutter linkados no final; os nomes de chave acima são as partes essenciais.

## A configuração passo a passo

Esta é a sequência completa para ir de um aplicativo plano a rotas aninhadas com deep links funcionando.

1. **Adicione e fixe a dependência.** Execute `flutter pub add go_router` e confirme que o `pubspec.yaml` mostra `go_router: ^17.3.0`. Fixe a versão maior porque o `go_router` teve mudanças incompatíveis na API do shell entre versões maiores.
2. **Defina a árvore de rotas.** Construa um único `GoRouter` com suas rotas de nível superior. Aninhe as telas de detalhe dentro da lista `routes:` do pai usando caminhos relativos (`':id'`, nunca `'/parent/:id'`).
3. **Adicione um shell para o layout compartilhado.** Envolva as rotas com abas em `StatefulShellRoute.indexedStack` (pilhas de abas independentes) ou `ShellRoute` (uma pilha compartilhada). Renderize `navigationShell` ou `child` dentro do body do seu scaffold.
4. **Conecte o router ao aplicativo.** Passe-o para `MaterialApp.router(routerConfig: router)` para que o widget `Router` do Flutter controle a navegação e o manipulador de deep links da plataforma seja conectado.
5. **Navegue por caminho.** Use `context.go('/orders/42')` para substituir a pilha, `context.push('/orders/42')` para empilhar por cima e `navigationShell.goBranch(index)` para trocar de abas sem perder o estado delas.
6. **Configure as plataformas.** Adicione o `intent-filter` do Android com `autoVerify` e o entitlement de Associated Domains do iOS, e hospede os arquivos `assetlinks.json` / `apple-app-site-association` para os links verificados.
7. **Teste o link de ponta a ponta.** No Android, `adb shell am start -W -a android.intent.action.VIEW -d "https://example.com/orders/42"`. No simulador do iOS, `xcrun simctl openurl booted "https://example.com/orders/42"`. O aplicativo deve abrir diretamente na tela de detalhe do pedido com `/orders` na pilha de retorno.

## Armadilhas que quebram a navegação silenciosamente

**Caminhos de rota filha absolutos.** Uma rota filha escrita como `'/orders/:id'` em vez de `':id'` se torna silenciosamente uma rota de nível superior. O aninhamento quebra e o botão de voltar para de retornar a `/orders`. Esse é o erro mais comum.

**Mostrar um diálogo ou uma rota de tela cheia dentro de um shell.** Uma tela de login ou um modal geralmente não devem ser renderizados dentro do scaffold da barra de navegação inferior. Dê à rota um `parentNavigatorKey` apontando para a chave do navigator raiz para que ela empilhe sobre o shell em vez de dentro dele. Sem isso, sua página de login aparece com uma barra inferior anexada.

**Usar `context.go` para trocar de abas.** Dentro de um `StatefulShellRoute`, chamar `context.go('/profile')` funciona, mas descarta a pilha salva daquele ramo. Use sempre `navigationShell.goBranch(index)` a partir da barra de navegação para que cada aba lembre onde estava.

**Ler um context após um redirecionamento assíncrono.** Redirecionamentos e navegação assíncrona podem reconstruir ou descartar o widget que os disparou. Se você navegar após um `await`, proteja a retomada da mesma forma que faria em qualquer outro lugar, como abordado em [usar BuildContext com segurança após um await](/pt-br/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/). Ignorar isso provoca a [falha de procurar o ancestral de um widget desativado](/pt-br/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/).

**Supor que um deep link é válido.** `state.pathParameters['id']` é o que quer que a URL contivesse, incluindo lixo de um link digitado à mão ou obsoleto. Faça o parse, valide-o e roteie para uma tela de não encontrado em caso de falha. Combine isso com um [tratamento elegante de erros de rede](/pt-br/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) quando o recurso do deep link precisa ser buscado e pode não existir mais.

**Descartar controllers em telas que persistem.** Com `StatefulShellRoute.indexedStack`, as telas das abas permanecem vivas em segundo plano, então seus controllers não são descartados ao trocar de aba. Isso geralmente é o que você quer, mas seja deliberado sobre isso, da mesma forma que seria ao [descartar controllers para evitar vazamentos](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) em rotas que realmente aparecem e somem.

## Quando enxertar rotas tipadas por cima

Tudo acima usa rotas em forma de string. Elas são fáceis de ler, mas fáceis de digitar errado, e um string de rota incorreto falha em tempo de execução, não em tempo de compilação. Para um aplicativo grande, adicione `go_router_builder` para gerar classes de rota com segurança de tipos a partir de definições anotadas, de modo que `OrderDetailRoute(id: 42).go(context)` substitua o string cru e o compilador detecte um parâmetro faltante. O formato da árvore de rotas, os shells e a configuração de deep links são idênticos; as rotas tipadas são uma camada de geração de código sobre o mesmo `GoRouter`. Comece com strings, confirme que o modelo de navegação está correto e então introduza rotas tipadas assim que a estrutura estiver estável. Se você também está escolhendo uma abordagem de gerenciamento de estado para as telas que essas rotas renderizam, os trade-offs em [Provider vs Riverpod vs Bloc](/pt-br/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) combinam naturalmente com essa configuração de roteamento.

## Fontes

- [Pacote go_router no pub.dev](https://pub.dev/packages/go_router) (versão 17.3.0, junho de 2026)
- [API da classe ShellRoute](https://pub.dev/documentation/go_router/latest/go_router/ShellRoute-class.html)
- [API da classe StatefulShellRoute](https://pub.dev/documentation/go_router/latest/go_router/StatefulShellRoute-class.html)
- [Tópico de deep linking, documentação do go_router](https://pub.dev/documentation/go_router/latest/topics/Deep%20linking-topic.html)
- [Documentação de deep linking do Flutter](https://docs.flutter.dev/ui/navigation/deep-linking)
