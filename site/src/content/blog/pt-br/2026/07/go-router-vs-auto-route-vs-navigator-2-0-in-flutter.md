---
title: "go_router vs auto_route vs Navigator 2.0 no Flutter"
description: "go_router e auto_route ambos ficam em cima do Navigator 2.0, então a escolha real é entre roteamento declarativo por URL, rotas tipadas geradas por código ou implementar a Router API na mão. Uma matriz de decisão com a config de cada um, e quando o Navigator puro ainda vence."
pubDate: 2026-07-07
tags:
  - "flutter"
  - "dart"
  - "go-router"
  - "auto-route"
  - "navigation"
lang: "pt-br"
translationOf: "2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-07
---

Resposta curta: para a maioria dos apps Flutter em 2026, use `go_router`. Ele é mantido pela equipe do Flutter, é a opção que a documentação oficial recomenda, e transforma URLs em telas com o mínimo de cerimônia. Considere o `auto_route` quando você quiser chamadas de navegação fortemente tipadas e verificadas em tempo de compilação, e estiver disposto a rodar um gerador de código para obtê-las. Só desça para o Navigator 2.0 puro (implementando `RouterDelegate` e `RouteInformationParser` você mesmo) quando tiver um modelo de navegação genuinamente incomum que nenhum dos dois pacotes expressa, porque você está assumindo muito código repetitivo. E se o seu app é pequeno e não tem requisitos de deep link ou de URL para web, o `Navigator.push` imperativo simples ainda é uma resposta perfeitamente boa.

O que quase todo mundo erra nessa comparação é tratar os três como escolhas paralelas. Eles não são. "Navigator 2.0" é a `Router` API do framework Flutter, e tanto o `go_router` quanto o `auto_route` são construídos em cima dela. Então a decisão não é "pacote A vs pacote B vs o framework"; é "em qual camada eu quero escrever meu roteamento". Este post usa `go_router` 17.3.0, `auto_route` 11.1.0, Flutter 3.44 stable e Dart 3.x.

## O bolo de camadas: o que "Navigator 2.0" realmente é

O Flutter tem duas APIs de navegação vivendo lado a lado.

O Navigator 1.0 é o imperativo que você já conhece: `Navigator.of(context).push(MaterialPageRoute(...))` e `Navigator.pop(context)`. Você empilha e desempilha telas como uma pilha. É simples e funciona, e para um app pequeno é tudo de que você precisa.

O Navigator 2.0, mais precisamente chamado de `Router` API, é declarativo. Em vez de empurrar imperativamente, você entrega ao framework uma lista de objetos `Page` que descrevem toda a pilha, e quando o estado do seu app muda, você passa uma nova lista. Duas peças fazem isso funcionar: um `RouteInformationParser` que transforma uma URL recebida (`RouteInformation`) no seu próprio tipo de dado específico do app, e um `RouterDelegate` que lê esse dado mais o estado do seu app e compila o `Navigator` com as `pages` certas. A [documentação oficial de navegação e roteamento](https://docs.flutter.dev/ui/navigation) descreve exatamente essa divisão.

O problema é que escrever um `RouterDelegate` e um `RouteInformationParser` corretos na mão dá muito trabalho. Você é responsável por analisar caminhos, manter a lista de páginas, lidar com o botão de voltar do sistema, sincronizar URLs do navegador e restaurar deep links. A documentação do Flutter é direta sobre isso:

> Se você preferir não usar um pacote de roteamento e quiser controle total sobre a navegação e o roteamento no seu app, sobrescreva `RouteInformationParser` e `RouterDelegate`.

Esse "se você preferir controle total" é o sinal. Para todo mundo mais, um pacote de roteamento embrulha essa maquinaria. `go_router` e `auto_route` são ambos esse embrulho. Eles consomem o Navigator 2.0; não competem com ele. Então quando alguém pergunta "go_router ou Navigator 2.0?", a resposta honesta é que o go_router *é* o Navigator 2.0 com o código repetitivo já escrito para você.

## O que o go_router otimiza: URLs como fonte da verdade

O `go_router` é publicado pelo publisher verificado `flutter.dev` e é [mantido pela equipe do Flutter](https://pub.dev/packages/go_router). Seu modelo é URL-first: você declara uma tabela de rotas com padrões de caminho, e navegar é uma questão de ir até um caminho. Deep links, URLs de web e navegação dentro do app todos resolvem pela mesma tabela, e é por isso que um deep link e um toque num botão chegam à mesma tela.

Uma configuração mínima:

```dart
// Flutter 3.44, go_router 17.3.0
final router = GoRouter(
  routes: [
    GoRoute(
      path: '/',
      builder: (context, state) => const HomeScreen(),
      routes: [
        GoRoute(
          path: 'orders/:id',
          builder: (context, state) {
            final id = state.pathParameters['id']!;
            return OrderScreen(orderId: id);
          },
        ),
      ],
    ),
  ],
);

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) =>
      MaterialApp.router(routerConfig: router);
}
```

A navegação é uma string:

```dart
// go_router 17.3.0 - navigate by URL
context.go('/orders/42');   // replace the stack, land on order 42
context.push('/orders/42'); // push on top of the current stack
```

A força aqui também é o lado afiado: os alvos de navegação são strings. `context.go('/orders/42')` não é verificado pelo compilador. Erre o caminho ou renomeie uma rota e você descobre em runtime. O `go_router` tem uma resposta, [rotas tipadas via `go_router_builder`](https://pub.dev/packages/go_router_builder), que gera classes `GoRouteData` tipadas para que você possa chamar `OrderRoute(id: 42).go(context)` no lugar. Mas isso é geração de código opcional parafusada em cima de um pacote cujo idioma padrão são strings, e na prática muitos códigos com go_router nunca a ligam.

O `go_router` também é dono das duas features pelas quais as pessoas de fato o adotam. `ShellRoute` e `StatefulShellRoute.indexedStack` te dão uma shell persistente (uma barra de navegação inferior que sobrevive às trocas de aba), e um callback `redirect` de nível superior lida com o controle de autenticação para toda a árvore. Se você quiser o passo a passo completo de shells e config de deep link, veja [configurando rotas aninhadas e deep links com go_router](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/).

Uma nota de status que importa para uma decisão de vários anos: a equipe do Flutter lista o `go_router` como feature-complete. A [declaração de roadmap deles](https://pub.dev/packages/go_router) diz:

> Este pacote é considerado feature-complete. O foco principal da equipe do Flutter será resolver correções de bugs e garantir estabilidade.

Leia isso como estabilidade, não abandono. Significa que a API que você aprende hoje é improvável de mudar debaixo de você, e correções de bugs continuam chegando. Também significa que capacidades novas e grandes têm mais chance de chegar como pacotes da comunidade do que como features centrais do go_router.

## O que o auto_route otimiza: rotas tipadas a partir de geração de código

O `auto_route` 11.1.0 é um pacote da comunidade feito por Milad Akarie. Ele ataca exatamente a fraqueza do padrão do go_router: a navegação tipada por strings. Você anota cada página com `@RoutePage()`, roda o `build_runner`, e ele gera uma rota fortemente tipada para cada tela. As chamadas de navegação são então verificadas pelo compilador e seus argumentos são tipados.

```dart
// Flutter 3.44, auto_route 11.1.0
@RoutePage()
class OrderScreen extends StatelessWidget {
  const OrderScreen({super.key, required this.orderId});
  final int orderId; // a real int, not a string yanked from a path

  @override
  Widget build(BuildContext context) => const Placeholder();
}

@AutoRouterConfig()
class AppRouter extends RootStackRouter {
  @override
  List<AutoRoute> get routes => [
        AutoRoute(page: HomeRoute.page, initial: true),
        AutoRoute(page: OrderRoute.page, path: '/orders/:id'),
      ];
}
```

Depois de `dart run build_runner build`, a navegação é tipada de ponta a ponta:

```dart
// auto_route 11.1.0 - typed navigation, checked by the compiler
context.router.push(OrderRoute(orderId: 42)); // orderId is an int
```

Renomeie `orderId`, mude o tipo dele ou apague a rota, e o código que navega até ela para de compilar. Essa é toda a proposta, e para um app grande com dezenas de telas e argumentos não triviais é uma diferença de produtividade real e diária. Você nunca serializa um objeto numa query string e o analisa de volta na mão.

O `auto_route` também traz equivalentes de primeira classe das features do go_router. A navegação aninhada usa um widget `AutoRouter` como o outlet para rotas filhas; a navegação com abas usa o [`AutoTabsRouter`](https://pub.dev/packages/auto_route), que preserva o estado das abas fora da tela do jeito que o `StatefulShellRoute` faz. O controle de autenticação usa guards: você estende `AutoRouteGuard`, implementa `onNavigation`, e anexa o guard por rota ou globalmente.

```dart
// auto_route 11.1.0 - a route guard
class AuthGuard extends AutoRouteGuard {
  @override
  void onNavigation(NavigationResolver resolver, StackRouter router) {
    if (isSignedIn) {
      resolver.next(true);
    } else {
      router.push(const LoginRoute());
    }
  }
}
```

O custo é o gerador de código. Você adiciona `auto_route_generator` e `build_runner` como dependências de desenvolvimento, e toda vez que adiciona ou muda um `@RoutePage` você regenera. Em desenvolvimento ativo você roda `build_runner watch`. Isso é um imposto real: builds a frio mais lentos, um arquivo `.gr.dart` gerado na sua árvore, e a necessidade ocasional de apagar a saída gerada e recompilar quando as coisas ficam fora de sincronia. Se a navegação tipada vale um passo de geração de código é a troca central de toda esta comparação.

## A decisão, como uma matriz

| Preocupação | go_router 17.3.0 | auto_route 11.1.0 | Navigator 2.0 puro |
| --- | --- | --- | --- |
| Mantenedor | Equipe do Flutter (flutter.dev) | Comunidade (Milad Akarie) | Framework Flutter |
| Chamadas de navegação | Strings (`context.go('/x')`), tipadas opcionalmente via builder | Tipadas, verificadas pelo compilador por padrão | Você define |
| Geração de código | Não (opcional para rotas tipadas) | Sim (`build_runner`) | Não |
| Deep links / URLs de web | Embutido | Embutido | Você implementa |
| Shell persistente / abas | `StatefulShellRoute` | `AutoTabsRouter` | Você implementa |
| Controle de autenticação | Callback `redirect` | `AutoRouteGuard` | Você implementa |
| Código repetitivo | Baixo | Baixo a médio (mais arquivos gerados) | Alto |
| Melhor quando | Maioria dos apps; web; deep links | App grande, muitos args tipados, você gosta de codegen | Modelo de navegação verdadeiramente customizado |

As linhas que devem guiar sua escolha são "chamadas de navegação" e "geração de código". Se a navegação verificada em tempo de compilação importa o bastante para justificar um passo de build, `auto_route`. Se você prefere não rodar um gerador e está confortável com caminhos em string (ou vai optar pelo `go_router_builder` mais tarde), `go_router`. Todo o resto, ambos os pacotes fazem com competência.

## Quando o Navigator 2.0 puro é a escolha certa (raramente)

Não recorra a um `RouterDelegate` escrito à mão só para se sentir no controle. As situações onde ele genuinamente compensa são estreitas:

- Seu estado de navegação não mapeia para uma árvore de URLs de jeito nenhum. Pense num editor de grafo de nós, num assistente cuja pilha é computada a partir de uma máquina de estados, ou num app onde "a pilha" é uma projeção de alguma outra estrutura de dados. As tabelas de rotas dos pacotes assumem uma árvore de caminhos; se o seu modelo não é isso, você pode brigar mais com o pacote do que com o framework.
- Você está construindo seu próprio pacote de roteamento ou uma abstração de nível de framework e precisa das primitivas diretamente.
- Você precisa de comportamento no nível de `Page`/`Navigator.pages` que nenhum dos pacotes expõe.

Para esses casos, a API pura te dá controle total sobre a `List<Page>` e o ciclo de analisar e restaurar. Para todo o resto, o código repetitivo que você escreveria é código repetitivo que os pacotes já escreveram, testaram e entregam. A orientação da documentação do Flutter é inequívoca: apps com necessidades avançadas de navegação "deveriam usar um pacote de roteamento como o go_router", e a API pura é enquadrada como a saída de emergência para quem explicitamente quer controle total.

## Não esqueça: para um app pequeno, o Navigator 1.0 ainda está bom

Existe um modo de falha em que um app de cinco telas adota um pacote de roteamento, um gerador de código e uma abstração de tabela de rotas de que ele nunca precisou. Se o seu app não tem alvo web, nem deep links, nem requisito de reconstruir uma tela a partir de uma URL, a navegação imperativa não é um erro legado, é a ferramenta do tamanho certo:

```dart
// Flutter 3.44 - imperative navigation, still correct for simple apps
Navigator.of(context).push(
  MaterialPageRoute<void>(
    builder: (context) => const SecondScreen(),
  ),
);
```

A documentação oficial abençoa isso explicitamente para "aplicações pequenas sem deep linking complexo". No momento em que você adiciona um build web, links compartilháveis, ou uma navegação inferior que precisa sobreviver às trocas de aba, migre para `go_router` ou `auto_route`. Não antes.

## As pegadinhas que cada escolha te entrega

Algumas coisas mordem as pessoas depois que elas já se comprometeram:

- **go_router: strings não são verificadas.** Renomear um caminho é uma quebra silenciosa até você bater nela em runtime. Ou adote o `go_router_builder` para rotas tipadas cedo, ou mantenha todo caminho num único arquivo de constantes e nunca coloque uma string crua inline.
- **go_router: `context` depois de um await.** A navegação declarativa não te isenta do lint `use_build_context_synchronously`. Navegar com um `BuildContext` obsoleto depois de um gap `async` é o mesmo bug que sempre foi; veja [usando o BuildContext com segurança depois de um await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).
- **auto_route: drift de arquivo gerado.** Depois de um merge bagunçado ou de um bump do Dart SDK, o `.gr.dart` gerado pode ficar obsoleto e produzir erros desconcertantes. A correção é quase sempre `dart run build_runner build --delete-conflicting-outputs`, não ficar encarando o diff.
- **auto_route: mais uma ferramenta de codegen no seu pipeline.** Se você já roda o Freezed, o json_serializable ou o gerador do Riverpod, o `auto_route` é mais uma coisa que precisa ficar em sincronia. No CI, um passo de `build_runner` esquecido quebra o build, não a sua máquina.
- **Ambos: deep links ainda precisam de config nativa.** Nenhum dos pacotes consegue fazer o Android e o iOS entregarem uma URL para o Flutter sozinho. Você ainda edita o `AndroidManifest.xml` e os entitlements do iOS para registrar seu scheme ou app links. O pacote resolve a URL depois que ela chega; fazer ela chegar é trabalho de plataforma.
- **Migrar entre eles não é de graça.** As tabelas de rotas do go_router e as classes anotadas do auto_route são estruturalmente diferentes. Trocar no meio do projeto significa reescrever a camada de rotas, então escolha com o horizonte de dois anos em mente, não esta sprint.

Se você ainda está decidindo sua stack mais ampla em vez de só o roteamento, a mesma tensão "oficial-e-sem-graça vs rico-em-features-da-comunidade" também aparece no gerenciamento de estado, que eu percorro em [Provider vs Riverpod vs Bloc](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/), e na própria escolha de plataforma em [Flutter vs React Native vs MAUI](/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/).

O resumo que sobrevive ao contato com um projeto real: o `go_router` é o padrão porque é oficial, estável e nativo de URL. O `auto_route` ganha seu lugar em apps grandes onde a navegação verificada em tempo de compilação vale um gerador de código. O Navigator 2.0 puro é para o app raro cujo modelo de navegação não cabe numa tabela de rotas. E o `Navigator.push` simples ainda é a resposta correta para um app pequeno que não precisa de nada disso. Escolha a camada mais baixa que resolve o seu problema real, não a mais poderosa.

## Related

- [How to set up nested routes and deep links with go_router in Flutter](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/)
- [How to use BuildContext safely after an await in Flutter](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)
- [Provider vs Riverpod vs Bloc for Flutter state management in 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)
- [Flutter vs React Native vs MAUI for a new mobile project in 2026](/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/)
- [Migrate a Flutter 2 app to Flutter 3.x: null safety checklist](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)

## Sources

- [Navigation and routing - Flutter docs](https://docs.flutter.dev/ui/navigation)
- [go_router - pub.dev (maintained by flutter.dev)](https://pub.dev/packages/go_router)
- [go_router_builder - pub.dev](https://pub.dev/packages/go_router_builder)
- [auto_route - pub.dev](https://pub.dev/packages/auto_route)
- [auto_route_library - Milad-Akarie on GitHub](https://github.com/Milad-Akarie/auto_route_library)
