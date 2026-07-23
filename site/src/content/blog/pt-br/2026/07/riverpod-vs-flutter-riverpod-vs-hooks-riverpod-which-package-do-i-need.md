---
title: "riverpod vs flutter_riverpod vs hooks_riverpod: qual pacote eu realmente preciso?"
description: "Instale flutter_riverpod para quase todo app Flutter. Use riverpod apenas para código Dart puro, e hooks_riverpod apenas se você já usa flutter_hooks."
pubDate: 2026-07-23
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
lang: "pt-br"
translationOf: "2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need"
translatedBy: "claude"
translationDate: 2026-07-23
---

Se o pub.dev está te mostrando `riverpod`, `flutter_riverpod` e `hooks_riverpod` e você não consegue decidir qual adicionar, a resposta para quase todo app Flutter é `flutter_riverpod`. Adicione `riverpod` (sem o prefixo `flutter_`) apenas quando estiver escrevendo Dart puro sem dependência do Flutter, como uma CLI ou um servidor. Adicione `hooks_riverpod` apenas se você já usa o pacote `flutter_hooks` e quer `HookConsumerWidget`. Esses três não são gerenciadores de estado que competem entre si: são camadas da mesma biblioteca, e escolher o errado significa apenas um import um pouco errado, não uma arquitetura diferente. Todas as versões aqui têm como alvo o Riverpod 3.3.2 (a linha 3.0 saiu em 2025-09-10), Flutter 3.44 e Dart 3.12.

## São camadas, não rivais

A confusão vem do pub.dev listá-los lado a lado como se fossem alternativas como Provider e Bloc. Não são. `riverpod` é o motor central, escrito em Dart puro e sem nenhum import do Flutter. `flutter_riverpod` pega esse motor e adiciona a cola do Flutter: `ProviderScope`, `ConsumerWidget`, `Consumer` e o `WidgetRef` no qual você chama `ref.watch`. `hooks_riverpod` pega `flutter_riverpod` e adiciona mais uma coisa por cima: a integração com o pacote independente `flutter_hooks`, expondo `HookConsumerWidget`.

Cada pacote reexporta o que está abaixo dele. Quando você adiciona `flutter_riverpod`, também obtém tudo do `riverpod` sem listá-lo. Quando você adiciona `hooks_riverpod`, obtém tudo do `flutter_riverpod` também. É por isso que você nunca instala mais de um deles por vez, e por isso instalar `flutter_riverpod` e depois importar de `package:riverpod/riverpod.dart` é um erro que produz confusos erros de símbolos duplicados.

## Matriz de recursos

| Recurso | `riverpod` 3.3.2 | `flutter_riverpod` 3.3.2 | `hooks_riverpod` 3.3.2 |
| --- | --- | --- | --- |
| Depende do Flutter | Não | Sim | Sim |
| Motor de providers (`Provider`, `Notifier`, `ref.watch`) | Sim | Sim | Sim |
| Widget `ProviderScope` | Não | Sim | Sim |
| `ConsumerWidget` / `Consumer` | Não | Sim | Sim |
| `HookConsumerWidget` / `HookConsumer` | Não | Não | Sim |
| Requer `flutter_hooks` ao lado | Não | Não | Sim |
| Reexporta o pacote de baixo | -- | `riverpod` | `flutter_riverpod` |
| Adequado para | Código Dart puro | A maioria dos apps Flutter | Apps Flutter que já usam hooks |

O tipo `AsyncValue`, `ref.listen`, os modificadores de provider como `.autoDispose` e o comportamento de retry automático adicionado no 3.0 vivem todos no pacote central `riverpod`, então cada linha que os tem é idêntica entre os três. As únicas diferenças reais são as classes base de widget e a dependência do Flutter.

## Quando instalar flutter_riverpod

Este é o padrão, e cobre a grande maioria dos apps.

- Você está construindo um app Flutter normal (mobile, desktop ou web) e quer `ProviderScope` na raiz e `ConsumerWidget` nas suas telas.
- Você não usa, e não planeja usar, o pacote `flutter_hooks`.
- Você quer a menor superfície de dependências que ainda dê a integração completa com o Flutter.

A instalação é um único comando:

```bash
# Flutter 3.44, flutter_riverpod 3.3.2
flutter pub add flutter_riverpod
```

Um widget mínimo funcional fica assim:

```dart
// Flutter 3.44, Dart 3.12, flutter_riverpod 3.3.2
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final counterProvider = NotifierProvider<Counter, int>(Counter.new);

class Counter extends Notifier<int> {
  @override
  int build() => 0;
  void increment() => state++;
}

void main() {
  // ProviderScope comes from flutter_riverpod
  runApp(const ProviderScope(child: MyApp()));
}

class CounterView extends ConsumerWidget {
  const CounterView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(counterProvider);
    return Text('$count');
  }
}
```

`ProviderScope`, `ConsumerWidget` e `WidgetRef` são todos fornecidos pelo `flutter_riverpod`. O `NotifierProvider`, `Notifier` e `state` vêm do motor central que o `flutter_riverpod` reexporta. Você nunca importa `package:riverpod/riverpod.dart` diretamente em um app Flutter.

## Quando instalar o riverpod puro

Recorra ao pacote `riverpod` puro apenas quando não houver Flutter no projeto de forma alguma.

- Uma ferramenta de linha de comando em Dart que compartilha lógica baseada em providers com um app Flutter.
- Um servidor `dart_frog` ou `shelf` que quer o grafo de dependências do Riverpod no backend.
- Um pacote Dart puro do qual outros apps dependem, onde puxar o Flutter seria errado.

```bash
# Dart 3.12, riverpod 3.3.2
dart pub add riverpod
```

Em um contexto só Dart não há árvore de widgets, então em vez de `ProviderScope` você mesmo constrói um `ProviderContainer` e lê a partir dele:

```dart
// Dart 3.12, riverpod 3.3.2 (no Flutter)
import 'package:riverpod/riverpod.dart';

final greetingProvider = Provider<String>((ref) => 'hello from Dart');

void main() {
  final container = ProviderContainer();
  print(container.read(greetingProvider)); // hello from Dart
  container.dispose();
}
```

Se o seu projeto tem um `pubspec.yaml` com `flutter:` sob dependencies, este quase nunca é o pacote que você quer. Adicionar `riverpod` puro a um app Flutter e depois se perguntar por que `ConsumerWidget` e `ProviderScope` não resolvem é um dos erros de configuração do Riverpod mais comuns.

## Quando instalar hooks_riverpod

Instale `hooks_riverpod` apenas quando você já estiver comprometido com o `flutter_hooks` e quiser usar hooks dentro do mesmo widget que lê providers.

O fato-chave: `flutter_hooks` e Riverpod são dois pacotes independentes. `flutter_hooks` é um port dos hooks do React que gerencia estado local do widget, coisas como um `TextEditingController` ou um `AnimationController` limitados a um único widget. Riverpod gerencia estado compartilhado da aplicação. Eles resolvem problemas diferentes, e você pode usar qualquer um sem o outro. `hooks_riverpod` existe puramente para que um único widget possa fazer as duas coisas sem um conflito de herança de classe.

Esse conflito é real. `HookWidget` (do `flutter_hooks`) e `ConsumerWidget` (do `flutter_riverpod`) são ambas classes base, e uma classe Dart só pode estender uma superclasse. Você não pode escrever `class X extends HookWidget, ConsumerWidget`. `hooks_riverpod` resolve isso entregando `HookConsumerWidget`, uma única classe base que é as duas ao mesmo tempo:

```dart
// Flutter 3.44, hooks_riverpod 3.3.2, flutter_hooks 0.21.2
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

class SearchField extends HookConsumerWidget {
  const SearchField({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // useTextEditingController is a hook: local widget state
    final controller = useTextEditingController();
    // ref.watch is Riverpod: shared app state
    final results = ref.watch(searchResultsProvider);

    return TextField(controller: controller);
  }
}
```

Duas coisas a observar. Primeira, `hooks_riverpod` não empacota `flutter_hooks`, então você precisa adicionar os dois:

```bash
# Flutter 3.44
flutter pub add hooks_riverpod
flutter pub add flutter_hooks
```

Segunda, como `hooks_riverpod` reexporta `flutter_riverpod`, você não precisa, e não deve, listar também `flutter_riverpod` no `pubspec.yaml`. O único import de `hooks_riverpod` te dá `ProviderScope`, `ConsumerWidget` e `HookConsumerWidget` todos juntos. Um arquivo que só lê providers ainda pode estender o `ConsumerWidget` comum; você recorre a `HookConsumerWidget` apenas nos arquivos específicos que também chamam hooks.

A documentação oficial é direta sobre isso para iniciantes: se você é novo no Riverpod, não comece com hooks. Eles adicionam um segundo modelo mental sobre um que já é pouco familiar. Aprenda `flutter_riverpod` primeiro, e adote `hooks_riverpod` depois apenas se você se perceber querendo hooks para estado local. Se você gerencia controllers na mão hoje, a disciplina de descarte em [descartar controllers do Flutter para evitar vazamentos de memória](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) é exatamente o boilerplate que os hooks buscam remover, que é o caso honesto para adotá-los.

## O pacote de anotações substitui o pacote de runtime?

Uma dúvida frequente em seguida: se eu adicionar `riverpod_annotation` para o codegen do `@riverpod`, ainda preciso do `flutter_riverpod`? Sim. O pacote de anotações fornece apenas o marcador `@riverpod` e os tipos contra os quais o gerador emite. Ele não contém runtime: nem `ProviderScope`, nem `Notifier`, nem `ref`. Seu app ainda roda sobre um dos três pacotes de runtime, e o código gerado importa dele. Então um app Flutter com codegen depende dos dois, `flutter_riverpod` (runtime) e `riverpod_annotation` (anotações), não de um no lugar do outro.

A mesma regra de "um único pacote de runtime" vale nos testes. Um teste de widget que monta um `ProviderScope` usa `flutter_riverpod` (via `flutter_test`), enquanto um teste unitário em Dart puro que sobe um `ProviderContainer` usa o `riverpod` puro. Você não adiciona um pacote de teste separado para o Riverpod; o `ProviderContainer` e os `overrides` de que você precisa para os testes já vêm dentro do pacote de runtime que você instalou.

## O detalhe que de fato derruba as pessoas: os pacotes de codegen versionam de forma diferente

Aqui está a parte que surpreende até usuários experientes do Riverpod na era 3.x. Os pacotes de runtime (`riverpod`, `flutter_riverpod`, `hooks_riverpod`) estão na linha 3.3.x, mas os pacotes de geração de código estão em uma versão maior totalmente diferente:

| Pacote | Papel | Versão (2026-07) |
| --- | --- | --- |
| `flutter_riverpod` | runtime | 3.3.2 |
| `hooks_riverpod` | runtime | 3.3.2 |
| `riverpod` | runtime | 3.3.2 |
| `riverpod_annotation` | anotações de codegen | 4.0.3 |
| `riverpod_generator` | codegen (dev) | 4.0.4 |
| `riverpod_lint` | regras de lint (dev) | 3.x |

Se você usa a anotação `@riverpod` para gerar providers, você instala quatro pacotes, não um. `riverpod_annotation` é uma dependência normal; `riverpod_generator` e `build_runner` são dependências de desenvolvimento:

```bash
# Flutter 3.44, Riverpod 3.x
flutter pub add flutter_riverpod riverpod_annotation
flutter pub add dev:riverpod_generator dev:build_runner
flutter pub add dev:custom_lint dev:riverpod_lint   # optional, for lint rules
```

Depois gere com:

```bash
# runs the generator once, or use `watch` to keep it running
dart run build_runner watch -d
```

Não tente fixar `riverpod_annotation` em `^3.0.0` para casar com o runtime. A linha 4.x de anotações é a que casa com o runtime 3.3.x; os números de versão estão deliberadamente desacoplados porque o gerador evolui no seu próprio ritmo. Deixe o `flutter pub add` resolver as restrições e não as edite na mão para "alinhá-las", porque elas não deveriam se alinhar. Esta é a falha de `pub get` mais comum em um projeto Riverpod 3 recém-criado.

A geração de código é opcional. Tudo neste artigo funciona sem ela. A abordagem de anotações principalmente te poupa de escrever na mão o boilerplate de tipos de provider (`NotifierProvider<Counter, int>`), e é um bom padrão para projetos novos, mas é uma decisão separada de qual pacote de runtime você instala.

## O que digitar de fato

Tirando a explicação, a decisão é curta:

- Construindo um app Flutter, sem hooks: `flutter pub add flutter_riverpod`. É você, 90% das vezes.
- Dart puro, sem Flutter: `dart pub add riverpod`.
- App Flutter que já usa `flutter_hooks`: `flutter pub add hooks_riverpod flutter_hooks`.
- Usando a anotação `@riverpod` sobre qualquer um dos anteriores: adicione `riverpod_annotation` mais as dependências de desenvolvimento `riverpod_generator` e `build_runner`, e deixe o resolvedor escolher a linha 4.x.

Qualquer que seja o pacote de runtime que você escolher, os providers, a API do `Notifier` e o `AsyncValue` se comportam de forma idêntica, porque todos vêm do mesmo motor central. Você está apenas escolhendo quanta cola do Flutter e suporte a hooks empilhar por cima. Uma vez resolvido isso, o aprendizado de verdade está na API em si: como [o AsyncValue do Riverpod se compara ao FutureBuilder e ao StreamBuilder](/pt-br/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/), como [verificar ref.mounted após um gap async](/pt-br/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/), e como o novo [retry automático de providers no 3.0](/pt-br/2026/07/how-to-disable-riverpod-3-0-automatic-provider-retry/) muda o tratamento de erros. Se você ainda está decidindo se vai usar Riverpod, a [comparação Provider vs Riverpod vs Bloc](/pt-br/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) toma essa decisão; se você está saindo da linha antiga, o [guia de migração do Riverpod 2.x para o 3.0](/pt-br/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/) cobre as mudanças que quebram.

## Fontes

- [Riverpod: Getting started](https://riverpod.dev/docs/introduction/getting_started) -- comandos oficiais de instalação do `riverpod`, `flutter_riverpod`, `hooks_riverpod` e dos pacotes de codegen.
- [Riverpod: About hooks](https://riverpod.dev/docs/concepts/about_hooks) -- a relação entre `flutter_hooks`, `flutter_riverpod` e `HookConsumerWidget`, e o conselho para iniciantes.
- [riverpod_generator changelog](https://pub.dev/packages/riverpod_generator/changelog) -- confirma a linha 4.x de codegen emparelhada com o runtime 3.3.x.
- [flutter_hooks no pub.dev](https://pub.dev/packages/flutter_hooks) -- o pacote independente de hooks com o qual o `hooks_riverpod` se integra.
