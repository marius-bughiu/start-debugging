---
title: "Como manter a aba selecionada da NavigationBar sincronizada com a rota atual usando StatefulShellRoute no go_router"
description: "Controle NavigationBar.selectedIndex a partir de StatefulNavigationShell.currentIndex, nunca de um campo com setState nem de uma cópia feita no initState. Medido no Flutter 3.44.8 e no go_router 18.0.2: quais padrões saem de sincronia em deep links, context.go e pushes entre branches, por que índices baseados na localização mentem e como reagir a mudanças de aba com didUpdateWidget."
pubDate: 2026-10-11
template: how-to
tags:
  - "flutter"
  - "dart"
  - "go-router"
  - "navigation"
  - "how-to"
lang: "pt-br"
translationOf: "2026/10/how-to-keep-the-navigationbar-selected-tab-in-sync-with-the-current-route-in-go-router"
translatedBy: "claude"
translationDate: 2026-10-11
---

**Resposta curta:** não guarde a aba selecionada por conta própria. Dentro de um `StatefulShellRoute`, o go_router já sabe qual branch está ativo e entrega isso a você como `navigationShell.currentIndex`. Passe esse valor direto para `NavigationBar.selectedIndex` a cada build e troque de aba com `navigationShell.goBranch(index)`. Um campo `_selectedIndex` atualizado em `onDestinationSelected`, ou uma cópia de `currentIndex` feita no `initState`, só muda quando o usuário toca na barra. Por isso ele fica desatualizado assim que um deep link, um `context.go` dentro de uma página ou um handler de notificação muda a rota. Tudo abaixo foi executado com `flutter test` no Flutter 3.44.8 (Dart 3.12.2) e no go_router 18.0.2, a versão mais recente em outubro de 2026.

O relato de bug costuma ser assim: "abro o app por um link para `/profile` e a barra continua destacando Home", ou "um botão na página Orders leva o usuário para Settings, a página Settings aparece, mas a barra ainda diz Orders". A página está certa e a barra está errada, porque duas fontes de verdade discordam: a localização do roteador e um pedaço de estado do widget que só a própria barra atualiza.

## Por que a barra e a rota saem de sincronia

Uma `NavigationBar` é um widget simples. Ela renderiza o `selectedIndex` que você der e chama `onDestinationSelected` quando o usuário toca. Ela não sabe que existe um roteador. Se você mantém o índice em um `StatefulWidget`, o único caminho de código que o atualiza é o handler de toque, e tocar é apenas uma das muitas formas de a rota mudar:

- o app inicia em um deep link ou em um `initialLocation` que aponta para a segunda aba
- uma página chama `context.go('/profile/settings')` (um link "ver tudo", um redirecionamento pós-login, um handler de push notification)
- um `redirect` envia o usuário para outro lugar
- o botão voltar do navegador no Flutter web, ou a restauração de estado depois que o SO encerrou o processo

Nenhum desses casos toca no seu campo `_selectedIndex`. O roteador reconstrói o shell com o novo branch, seu scaffold é reconstruído com o valor antigo do campo e a barra mente.

O go_router resolve isso para você, desde que você deixe. Ao montar um `StatefulShellRoute`, ele cria um `StatefulNavigationShell` e calcula `currentIndex` no construtor a partir da navigator key do branch que correspondeu à localização atual (veja `route.dart` no código-fonte do go_router, `_indexOfBranchNavigatorKey`). Um novo widget de shell é criado a cada mudança de rota, então `currentIndex` é sempre a resposta do próprio roteador para "qual branch está aparecendo agora".

## Um app mínimo que reproduz a divergência

Dois branches, Orders e Profile. A página Orders tem um botão que salta direto para o branch Profile, exatamente o tipo de navegação dentro da página que quebra um índice feito à mão:

```dart
// Flutter 3.44.8, Dart 3.12.2, go_router 18.0.2
final router = GoRouter(
  initialLocation: '/orders',
  routes: [
    StatefulShellRoute.indexedStack(
      builder: (context, state, navigationShell) =>
          AppScaffold(navigationShell: navigationShell),
      branches: [
        StatefulShellBranch(routes: [
          GoRoute(
            path: '/orders',
            builder: (context, state) => const OrdersPage(),
            routes: [
              GoRoute(
                path: ':id',
                builder: (context, state) =>
                    OrderPage(id: state.pathParameters['id']!),
              ),
            ],
          ),
        ]),
        StatefulShellBranch(routes: [
          GoRoute(
            path: '/profile',
            builder: (context, state) => const ProfilePage(),
            routes: [
              GoRoute(
                path: 'settings',
                builder: (context, state) => const SettingsPage(),
              ),
            ],
          ),
        ]),
      ],
    ),
  ],
);
```

E o scaffold que a maioria das pessoas escreve primeiro, porque é a cara de todo exemplo de `NavigationBar` sem roteador:

```dart
// Flutter 3.44.8, go_router 18.0.2 -- DRIFTS, do not copy
class AppScaffold extends StatefulWidget {
  const AppScaffold({super.key, required this.navigationShell});
  final StatefulNavigationShell navigationShell;

  @override
  State<AppScaffold> createState() => _AppScaffoldState();
}

class _AppScaffoldState extends State<AppScaffold> {
  int _selectedIndex = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: widget.navigationShell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _selectedIndex,
        onDestinationSelected: (index) {
          setState(() => _selectedIndex = index);
          widget.navigationShell.goBranch(index);
        },
        destinations: const [
          NavigationDestination(icon: Icon(Icons.list), label: 'Orders'),
          NavigationDestination(icon: Icon(Icons.person), label: 'Profile'),
        ],
      ),
    );
  }
}
```

Uma variante um pouco mais esperta inicializa o campo a partir do shell (`_selectedIndex = widget.navigationShell.currentIndex;` no `initState`). Isso corrige a partida a frio e mais nada. O `StatefulNavigationShell` tem uma key estável por rota de shell, e seu scaffold fica na mesma posição da árvore com o mesmo tipo, então o Flutter preserva o `State` entre mudanças de rota. O `initState` roda uma vez por sessão do app, não uma vez por navegação.

## O que cada padrão realmente mostra

Executei todos eles com testes de widget (`tester.tap`, `GoRouter.go`, `GoRouter.push`) e li `NavigationBar.selectedIndex` depois de `pumpAndSettle`. "Correto" é a aba cujo branch contém a página visível.

| Cenário | Página exibida | Campo com `setState` | Cópia no `initState` | `navigationShell.currentIndex` |
| --- | --- | --- | --- | --- |
| Partida a frio em `/profile` | Profile | 0 (errado) | 1 | 1 |
| `context.go('/profile/settings')` a partir de Orders | Settings | 0 (errado) | 0 (errado) | 1 |
| `router.go('/profile')` de fora da árvore de widgets | Profile | 0 (errado) | 0 (errado) | 1 |
| `context.go('/orders/42')` a partir de Profile | Order 42 | 0 | 1 (errado) | 0 |
| Usuário toca em Profile e depois em Orders | Profile, Orders | 1, 0 | 1, 0 | 1, 0 |

Só a última linha, a que todo desenvolvedor testa manualmente, funciona nos três. O índice do shell estava certo em todos os cenários.

## A correção: ler currentIndex a cada build

O scaffold correto é stateless. Não há nada para guardar, porque o roteador guarda:

```dart
// Flutter 3.44.8, Dart 3.12.2, go_router 18.0.2
class AppScaffold extends StatelessWidget {
  const AppScaffold({super.key, required this.navigationShell});
  final StatefulNavigationShell navigationShell;

  void _onTap(int index) {
    navigationShell.goBranch(
      index,
      // Tapping the tab you are already on pops that branch back to its root.
      initialLocation: index == navigationShell.currentIndex,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: navigationShell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: navigationShell.currentIndex,
        onDestinationSelected: _onTap,
        destinations: const [
          NavigationDestination(icon: Icon(Icons.list), label: 'Orders'),
          NavigationDestination(icon: Icon(Icons.person), label: 'Profile'),
        ],
      ),
    );
  }
}
```

Os passos, em ordem:

1. Faça o scaffold do shell receber o `StatefulNavigationShell` do builder do `StatefulShellRoute` e renderizá-lo como `body`.
2. Defina `NavigationBar.selectedIndex` como `navigationShell.currentIndex`. Apague qualquer campo `_selectedIndex` e todo `setState` que o tocava.
3. Em `onDestinationSelected`, chame `navigationShell.goBranch(index)`. Não chame `context.go('/profile')` para trocar de aba: funciona, mas descarta a pilha salva daquele branch em vez de restaurá-la.
4. Passe `initialLocation: index == navigationShell.currentIndex` para que um segundo toque na aba ativa a redefina para a raiz do branch, que é o comportamento que usuários de iOS e Android esperam.
5. Se o mesmo scaffold renderiza um `NavigationRail` em telas largas, alimente-o com o mesmo `currentIndex`. Uma fonte, dois widgets, nenhum código de sincronização.

Não existe um passo "atualizar a barra quando a rota mudar". Um toque chama `goBranch`, o roteador muda a localização, o go_router monta um novo shell com um novo `currentIndex` e a barra acompanha. O toque nem precisa reconstruir nada localmente.

O guia de 2026/06 sobre [rotas aninhadas e deep links com o go_router](/pt-br/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) mostra essa mesma ligação como parte de uma configuração completa de shell. Este post trata de por que os atalhos ao redor dela quebram.

## Reagindo a mudanças de aba sem guardar o índice

Às vezes você realmente precisa saber quando a aba mudou: registrar uma visualização de tela, pausar um vídeo na aba que o usuário deixou, rolar uma lista de volta ao topo. A tentação é trazer de volta o campo `_selectedIndex` "só para isso". Você não precisa dele. Torne o scaffold um `StatefulWidget` de novo, mas compare o shell antigo e o novo em `didUpdateWidget`:

```dart
// Flutter 3.44.8, Dart 3.12.2, go_router 18.0.2
class _AppScaffoldState extends State<AppScaffold> {
  @override
  void didUpdateWidget(AppScaffold oldWidget) {
    super.didUpdateWidget(oldWidget);
    final from = oldWidget.navigationShell.currentIndex;
    final to = widget.navigationShell.currentIndex;
    if (from != to) {
      analytics.logTabChange(from: from, to: to);
    }
  }

  @override
  Widget build(BuildContext context) {
    // selectedIndex still comes from widget.navigationShell.currentIndex
    return Scaffold(body: widget.navigationShell /* , bottomNavigationBar: ... */);
  }
}
```

Acionado por `router.go('/profile')` e depois `router.go('/orders')`, isso registrou `initState 0`, `tab changed 0 -> 1`, `tab changed 1 -> 0`. Dispara para toques, deep links e navegação programática da mesma forma, porque observa a resposta do roteador e não a entrada da barra. Mantenha o trabalho em `didUpdateWidget` leve e sem navegação: chamar `goBranch` de dentro de um callback da fase de build é um jeito rápido de receber [setState() or markNeedsBuild() called during build](/pt-br/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/).

## Armadilhas e casos extremos

### Derivar o índice da localização mente após um push entre branches

O outro padrão comum, herdado do `ShellRoute` simples, é calcular o índice a partir da URL: `state.uri.path.startsWith('/profile') ? 1 : 0`. Ele sobrevive a deep links e a `context.go`, e por isso as pessoas confiam nele. Ele quebra com `push`.

Quando a página Profile chama `context.push('/orders/42')`, o go_router 18.0.2 empilha a página do pedido no navigator do branch *atual*. Verifiquei isso em um teste: a página empilhada fica dentro do scaffold do shell, `currentIndex` continua 1 e, depois de trocar para Orders e voltar para Profile, a aba Profile ainda mostra Order 42 no topo da sua pilha. A localização, porém, agora é `/orders/42`, então a barra derivada da localização destaca Orders enquanto o usuário está dentro da pilha de Profile. Toque em Orders e você recebe o branch Orders, não a página que estava vendo. `currentIndex` informou 1 o tempo todo, o que corresponde ao lugar onde a página realmente vive.

Se você quer que o detalhe de um pedido abra sob a aba Orders, use `context.go('/orders/42')` (ele troca de branch e `currentIndex` passa a ser 0). Se quer que fique por cima da aba atual, `push` serve. Em ambos os casos, deixe `currentIndex` decidir qual aba fica acesa.

### O ShellRoute simples não tem currentIndex

Um `ShellRoute` não stateful oferece um único navigator aninhado e um `child`, sem branches e sem índice. Nesse caso você precisa mapear localização para aba por conta própria. Faça isso a partir do `GoRouterState` do builder (ou de `GoRouterState.of(context)`) e compare com `uri.path`, não com `matchedLocation`. No meu teste, depois de `push('/orders/7')` a partir de `/profile`, o estado do shell informou `uri=/orders/7`, `fullPath=/orders/:id` e `matchedLocation=/profile`. A mesma ressalva sobre push da seção anterior se aplica, e é mais um motivo para migrar layouts com abas para `StatefulShellRoute.indexedStack` se você também quer que cada aba mantenha sua própria pilha de volta (a [comparação entre go_router, auto_route e Navigator 2.0](/pt-br/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/) cobre o que cada roteador oferece para abas).

### Rotas em tela cheia no navigator raiz

Um checkout ou um visualizador de mídia muitas vezes vive sob o caminho de um branch, mas deve cobrir a barra, então é declarado com `parentNavigatorKey: rootNavigatorKey`. Empilhá-lo a partir de Profile deixou `currentIndex` em 1 sem nenhum scaffold em cena, e fechá-lo voltou para Profile com a aba certa acesa. Ir até ele diretamente com `router.go('/orders/checkout')` construiu o shell por baixo com `currentIndex` 0, porque a rota pertence ao branch Orders. Nos dois casos a barra está correta quando reaparece, sem nenhum código.

### Um branch sem destino na barra

É comum ter um branch alcançável apenas por link, por exemplo um branch Inbox aberto a partir de uma notificação, sem ícone na barra. Aí `currentIndex` será 2 com dois destinos, e a `NavigationBar` dispara um assert `0 <= selectedIndex && selectedIndex < destinations.length` em builds de debug. Mapeie branches para destinos explicitamente em vez de repassar o índice:

```dart
// Flutter 3.44.8, go_router 18.0.2
// Branch order: 0 orders, 1 profile, 2 inbox (no bar destination).
const _branchForDestination = [0, 1];

int _destinationFor(int branch) {
  final i = _branchForDestination.indexOf(branch);
  return i == -1 ? 0 : i; // NavigationBar cannot show "nothing selected"
}

NavigationBar(
  selectedIndex: _destinationFor(navigationShell.currentIndex),
  onDestinationSelected: (i) =>
      navigationShell.goBranch(_branchForDestination[i]),
  destinations: const [ /* Orders, Profile */ ],
);
```

`NavigationRail.selectedIndex` aceita nulo, então em um rail você pode retornar `null` e não mostrar nenhuma seleção para branches ocultos.

### Reordenar ou ocultar abas em tempo de execução

Se os destinos mudam conforme uma feature flag ou o papel do usuário, a lista de branches no roteador normalmente não muda. Mantenha os índices dos branches fixos e remapeie-os por uma tabela, como acima. Alterar os próprios branches dinamicamente significa uma nova configuração de roteador, e o changelog do go_router 18.0.2 registra uma correção para rotas empilhadas dentro de um shell que se perdiam quando uma configuração de roteamento dinâmica mudava, então fique na 18.0.2 ou superior se fizer isso.

### Testando a sincronização

Todo cenário da tabela acima é um teste de widget barato. Monte um `MaterialApp.router` com seu roteador real, inicie em um deep link com `initialLocation`, chame `router.go(...)` a partir do teste e faça a asserção em `tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex`. Se suas abas mostram conteúdo dependente do tempo, combine isso com a abordagem de [testar um widget Flutter em um ponto fixo no tempo](/pt-br/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/) para que as asserções sejam determinísticas. Um teste por ponto de entrada de navegação (deep link, `go` dentro da página, handler de notificação) detecta a divergência antes de um usuário.

## A regra prática

Se você se pegar escrevendo `setState` ao lado de uma `NavigationBar` dentro de um shell do go_router, pare. O roteador é dono da localização, a localização decide o branch e `StatefulNavigationShell.currentIndex` é essa decisão. Leia, nunca copie, e a barra não sai de sincronia, não importa como o usuário chegou ali.

## Fontes

- [go_router 18.0.2 on pub.dev](https://pub.dev/packages/go_router) and its [changelog](https://pub.dev/packages/go_router/changelog)
- [StatefulShellRoute class API](https://pub.dev/documentation/go_router/latest/go_router/StatefulShellRoute-class.html)
- [StatefulNavigationShell class API](https://pub.dev/documentation/go_router/latest/go_router/StatefulNavigationShell-class.html) (`currentIndex`, `goBranch`)
- [go_router source: `lib/src/route.dart`](https://github.com/flutter/packages/blob/main/packages/go_router/lib/src/route.dart)
- [Official StatefulShellRoute example](https://github.com/flutter/packages/blob/main/packages/go_router/example/lib/stateful_shell_route.dart)
- [NavigationBar class API](https://api.flutter.dev/flutter/material/NavigationBar-class.html)
