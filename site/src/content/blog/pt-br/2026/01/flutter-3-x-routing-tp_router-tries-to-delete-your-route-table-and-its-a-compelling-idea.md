---
title: "Routing no Flutter 3.x: tp_router tenta apagar sua tabela de rotas (e é uma ideia interessante)"
description: "tp_router é um router de Flutter dirigido por gerador que elimina tabelas de rotas manuais. Anote suas páginas, rode build_runner e navegue com APIs tipadas em vez de caminhos baseados em string."
pubDate: 2026-01-08
tags:
  - "flutter"
lang: "pt-br"
translationOf: "2026/01/flutter-3-x-routing-tp_router-tries-to-delete-your-route-table-and-its-a-compelling-idea"
translatedBy: "claude"
translationDate: 2026-04-30
---
O routing do Flutter é uma daquelas coisas que você só nota quando dói. As primeiras telas são fáceis. Depois o app cresce, os paths evoluem, e "só adicionar mais uma rota" vira um imposto de manutenção. Em 7 de janeiro de 2026, um post da comunidade propôs uma solução opinada: `tp_router`, um router dirigido por gerador que mira em **zero configuração manual de tabela de rotas**.

Thread original: [tp_router: Stop Writing Route Tables (r/FlutterDev)](https://www.reddit.com/r/FlutterDev/comments/1q6dq85/tp_router_stop_writing_route_tables/)  
Links do projeto: [GitHub](https://github.com/lwj1994/tp_router), [pub.dev](https://pub.dev/packages/tp_router)

## O modo de falha: strings em todo lugar

A maioria dos times já viveu alguma versão disso:

```dart
// Define route table
final routes = {
  '/user': (context) => UserPage(
    id: int.parse(ModalRoute.of(context)!.settings.arguments as String),
  ),
};

// Navigate
Navigator.pushNamed(context, '/user', arguments: '42');
```

"Funciona", até não funcionar: o nome da rota muda, o tipo do argumento muda, e você obtém crashes em runtime em partes do app que não tocou.

## Anotação primeiro, geração depois

A proposta do `tp_router` é simples: anote a página, rode o gerador e depois navegue através de tipos gerados em vez de strings.

Do post:

```dart
@TpRoute(path: '/user/:id')
class UserPage extends StatelessWidget {
  final int id; // Auto-parsed from path
  final String section;

  const UserPage({
    required this.id,
    this.section = 'profile',
    super.key,
  });
}

// Navigate by calling .tp()
UserRoute(id: 42, section: 'posts').tp(context);
```

Essa última linha é todo o ponto: se você renomear `section` ou mudar `id` de `int` para `String`, você quer que o compilador quebre seu build, não seus usuários.

## A pergunta real: mantém a fricção baixa conforme o app cresce?

Se você já usou `auto_route`, já sabe que routing dirigido por anotação pode funcionar bem, mas você ainda acaba escrevendo uma lista central:

```dart
@AutoRouterConfig(routes: [
  AutoRoute(page: UserRoute.page, path: '/user/:id'),
  AutoRoute(page: HomeRoute.page, path: '/'),
])
class AppRouter extends RootStackRouter {}
```

`tp_router` está tentando remover esse último passo por completo.

## Colocando para rodar em um projeto Flutter 3.x

As dependências mostradas na thread são:

```yaml
dependencies:
  tp_router: ^0.1.0
  tp_router_annotation: ^0.1.0

dev_dependencies:
  build_runner: ^2.4.0
  tp_router_generator: ^0.1.0
```

Gerar as rotas:

-   `dart run build_runner build`

E conectar:

```dart
void main() {
  final router = TpRouter(routes: tpRoutes);
  runApp(MaterialApp.router(routerConfig: router.routerConfig));
}
```

Se você quer menos boilerplate de routing e mais segurança em tempo de compilação, vale a pena fazer um spike rápido com `tp_router`. Mesmo que você não adote, a direção é certa: trate navegação como API tipada, não como folclore baseado em string.
