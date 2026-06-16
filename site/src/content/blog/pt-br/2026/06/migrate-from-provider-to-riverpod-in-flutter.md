---
title: "Migre de provider para Riverpod no Flutter (provider 6.1.5 para Riverpod 3.x)"
description: "Uma migração passo a passo do pacote provider para Riverpod 3.x em um app Flutter real: ChangeNotifierProvider para Notifier, MultiProvider para ProviderScope, context.watch para ref.watch, ProxyProvider para composição com ref.watch, além das pegadinhas de igualdade e ciclo de vida que mordem. Testado no Flutter 3.27.1, Dart 3.11, provider 6.1.5, flutter_riverpod 3.3.1."
pubDate: 2026-06-16
updatedDate: 2026-06-16
template: migration
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "provider"
  - "state-management"
  - "migration"
lang: "pt-br"
translationOf: "2026/06/migrate-from-provider-to-riverpod-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-16
---

A versão curta: adicione `flutter_riverpod` ao lado de `provider`, envolva seu app em um `ProviderScope` em vez de um `MultiProvider` e migre um recurso de cada vez começando pelas folhas da sua árvore de dependências. Cada `ChangeNotifier` vira um `Notifier` (ou `AsyncNotifier` para trabalho assíncrono), `context.watch<T>()` vira `ref.watch(myProvider)`, `Provider.of` e `context.read` viram `ref.read`, e cada `ProxyProvider` colapsa em um simples `ref.watch` de outro provider. Um app de pequeno a médio porte é um trabalho de um a três dias; a parte que quebra não é a sintaxe, é que o Riverpod compara o estado por igualdade e mantém os providers vivos de forma diferente do que `provider` faz. Testado no Flutter 3.27.1, Dart 3.11, provider 6.1.5, flutter_riverpod 3.3.1, riverpod_annotation 2.6.1 e riverpod_generator 2.6.5.

O pacote `provider` (atualmente 6.1.5) tem sido a resposta padrão para gerenciamento de estado no Flutter desde 2019, e ainda funciona. Mas seu autor, Remi Rousselet, escreveu o Riverpod especificamente para corrigir os problemas estruturais do `provider`: estado lido através de `BuildContext` significa um `ProviderNotFoundException` em runtime em vez de um erro de compilação, o aninhamento de `ProxyProvider` fica ilegível passando de duas dependências, e você não pode ter dois providers do mesmo tipo sem ginástica com `ValueKey`. O Riverpod mantém o modelo mental (um grafo de objetos que reconstroem widgets quando mudam) e remove o acoplamento com `BuildContext`. Este guia é a migração mecânica, das folhas para cima, que não exige uma reescrita.

## Por que migrar do provider

- **Segurança em tempo de compilação em vez de `ProviderNotFoundException`.** No `provider`, ler um tipo que não está acima de você na árvore lança um erro em runtime. No Riverpod, os providers são globais de nível superior, então um erro de digitação é um erro de compilação e não há nada para "encontrar".
- **Sem mais a pirâmide de `MultiProvider`.** O Riverpod não tem árvore de providers para montar. Um único `ProviderScope` na raiz substitui a lista inteira `MultiProvider(providers: [...])`, e as dependências entre providers são expressas com `ref.watch`, não pela ordem de aninhamento.
- **Dois providers do mesmo tipo, de graça.** O `provider` indexa tudo por tipo, então dois `ChangeNotifierProvider<CartModel>` colidem. O Riverpod indexa pelo objeto do provider, então isso é um não problema.
- **Auto-dispose e family que realmente compõem.** O Riverpod oferece providers `autoDispose` e parametrizados (`family`) como recursos de primeira classe, que o `provider` só aproxima com `ChangeNotifierProvider.value` manual e gerenciamento de chaves.

## O que quebra

| Área | Mudança | Severidade |
| --- | --- | --- |
| Fiação da raiz | `MultiProvider` substituído por um único `ProviderScope` | média |
| Leituras | `context.watch<T>()` / `Provider.of<T>(context)` substituídos por `ref.watch` / `ref.read` | alta |
| Notifiers | `ChangeNotifier` + `notifyListeners()` substituídos por `Notifier` + reatribuição de estado | alta |
| Semântica de reconstrução | O Riverpod compara o estado por `==`; mutação no lugar não reconstrói mais | alta |
| Composição | `ProxyProvider` substituído por `ref.watch` da dependência | média |
| Widgets | `StatelessWidget` / `StatefulWidget` viram `ConsumerWidget` / `ConsumerStatefulWidget` | média |
| Ciclo de vida | `provider` faz dispose quando removido da árvore; o Riverpod mantém o estado até `autoDispose` | média |

As duas linhas `alta` nas áreas de reconstrução e notifier são onde os times perdem tempo. Todo o resto é localizar e substituir.

## Checklist pré-voo

- Flutter 3.27.1 / Dart 3.11 (ou mais novo) instalado: `flutter --version`.
- Uma árvore de trabalho `git` limpa e um branch que você possa descartar.
- Um inventário de cada provider que você registra hoje. Faça grep na sua base de código: `grep -rn "ChangeNotifierProvider\|ProxyProvider\|FutureProvider\|StreamProvider\|Provider.of\|context.watch\|context.read" lib/`.
- Uma anotação ao lado de cada um indicando se algo depende dele. Migre primeiro as coisas das quais nada depende.
- Uma suíte de testes funcional, mesmo que enxuta. Você vai executá-la depois de cada passo.

## Passos da migração

1. **Adicione o Riverpod ao lado do provider no `pubspec.yaml`.** Não remova o `provider` ainda. Ambos os pacotes coexistem porque possuem árvores separadas; uma dada parte do estado tem exatamente um dono por vez, então migre por recurso, não por tipo.

   ```yaml
   # pubspec.yaml. Flutter 3.27.1, Dart 3.11.
   dependencies:
     flutter:
       sdk: flutter
     provider: ^6.1.5            # keep until migration is done
     flutter_riverpod: ^3.3.1
     riverpod_annotation: ^2.6.1

   dev_dependencies:
     build_runner: ^2.4.13
     riverpod_generator: ^2.6.5
     custom_lint: ^0.7.0
     riverpod_lint: ^2.6.5
   ```

   Verifique: `flutter pub get` resolve sem conflitos de versão.

2. **Envolva a raiz do app em `ProviderScope` e mantenha o `MultiProvider` dentro dele por enquanto.** O `ProviderScope` é onde o Riverpod armazena todo o estado dos providers. Não é uma lista de providers, é um único limite. Deixe seu `MultiProvider` existente embaixo dele para que as telas não migradas continuem funcionando.

   ```dart
   // lib/main.dart, Flutter 3.27.1
   import 'package:flutter/material.dart';
   import 'package:flutter_riverpod/flutter_riverpod.dart';
   import 'package:provider/provider.dart';

   void main() {
     runApp(
       ProviderScope(                       // Riverpod root
         child: MultiProvider(              // legacy, shrinks as you migrate
           providers: [
             ChangeNotifierProvider(create: (_) => CartModel()),
             ChangeNotifierProvider(create: (_) => AuthModel()),
           ],
           child: const MyApp(),
         ),
       ),
     );
   }
   ```

   Verifique: o app ainda compila e roda de forma idêntica. Nada se moveu ainda.

3. **Converta um `ChangeNotifier` folha em um `Notifier`.** Escolha um model do qual nada mais depende. No `provider` você muta um campo e chama `notifyListeners()`. No Riverpod, `build()` retorna o estado inicial e você reatribui `state` para notificar. Não há `notifyListeners()`.

   ```dart
   // Before: provider 6.1.5
   class CartModel extends ChangeNotifier {
     final List<Item> _items = [];
     List<Item> get items => List.unmodifiable(_items);

     void add(Item item) {
       _items.add(item);
       notifyListeners();
     }
   }
   ```

   ```dart
   // After: flutter_riverpod 3.3.1, code generation
   import 'package:riverpod_annotation/riverpod_annotation.dart';

   part 'cart_model.g.dart';

   @riverpod
   class Cart extends _$Cart {
     @override
     List<Item> build() => const [];

     void add(Item item) {
       state = [...state, item];   // new list, not state.add(...)
     }
   }
   ```

   Execute `dart run build_runner build --delete-conflicting-outputs` para gerar `cartProvider`. Verifique: o gerador produz `cart_model.g.dart` sem erros.

4. **Mude a tela que o consome para um `ConsumerWidget`.** `StatelessWidget` vira `ConsumerWidget` e `build` ganha um `WidgetRef ref`. `context.watch<CartModel>()` vira `ref.watch(cartProvider)`. Para uma chamada de método, `context.read<CartModel>().add(x)` vira `ref.read(cartProvider.notifier).add(x)`.

   ```dart
   // Before
   class CartView extends StatelessWidget {
     @override
     Widget build(BuildContext context) {
       final items = context.watch<CartModel>().items;
       return Column(children: [
         for (final i in items) Text(i.name),
         ElevatedButton(
           onPressed: () => context.read<CartModel>().add(Item('pen')),
           child: const Text('Add'),
         ),
       ]);
     }
   }
   ```

   ```dart
   // After
   class CartView extends ConsumerWidget {
     @override
     Widget build(BuildContext context, WidgetRef ref) {
       final items = ref.watch(cartProvider);
       return Column(children: [
         for (final i in items) Text(i.name),
         ElevatedButton(
           onPressed: () => ref.read(cartProvider.notifier).add(Item('pen')),
           child: const Text('Add'),
         ),
       ]);
     }
   }
   ```

   Se o widget já tinha estado próprio, use `ConsumerStatefulWidget` mais `ConsumerState`, onde `ref` está disponível como um campo. Remova a linha `ChangeNotifierProvider(create: (_) => CartModel())` do `MultiProvider`. Verifique: a tela se comporta da mesma forma e a lista do `MultiProvider` ficou uma linha menor.

5. **Substitua `ProxyProvider` por composição com `ref.watch`.** Este é o passo que apaga mais código. Um `ProxyProvider` que constrói B a partir de A vira um provider que simplesmente observa A.

   ```dart
   // Before: ProxyProvider wiring
   ProxyProvider<AuthModel, ApiClient>(
     update: (_, auth, __) => ApiClient(token: auth.token),
   ),
   ```

   ```dart
   // After: a provider that watches its dependency
   @riverpod
   ApiClient apiClient(ApiClientRef ref) {
     final token = ref.watch(authProvider.select((a) => a.token));
     return ApiClient(token: token);
   }
   ```

   `ref.watch(...select(...))` é a substituição direta para o `context.select` do `provider`, e significa que `apiClient` só reconstrói quando `token` muda, não a cada atualização de `AuthModel`. Verifique: os widgets dependentes reconstroem quando o provider upstream muda.

6. **Migre `FutureProvider` e `StreamProvider` para seus equivalentes do Riverpod.** Os nomes são os mesmos; só a fiação difere. Um `FutureProvider` do `provider` é lido com encanamento no estilo `context.watch<AsyncSnapshot>`; o do Riverpod retorna um `AsyncValue<T>` no qual você faz switch diretamente.

   ```dart
   // After: flutter_riverpod 3.3.1
   @riverpod
   Future<User> currentUser(CurrentUserRef ref) {
     return ref.watch(apiClientProvider).fetchUser();
   }

   // in a ConsumerWidget
   final userAsync = ref.watch(currentUserProvider);
   return userAsync.when(
     data: (user) => Text(user.name),
     loading: () => const CircularProgressIndicator(),
     error: (e, _) => Text('Failed: $e'),
   );
   ```

   Verifique: os estados de carregamento e erro renderizam sem flags manuais `bool isLoading`. Para mais sobre esse padrão, veja o post sobre AsyncValue vinculado abaixo.

7. **Apague a dependência `provider`.** Assim que o `MultiProvider` estiver vazio, remova-o do `main.dart`, depois retire `provider: ^6.1.5` do `pubspec.yaml` e execute `flutter pub get`. O compilador vai apontar quaisquer chamadas remanescentes de `context.watch`/`context.read`/`Provider.of`. Verifique: o projeto compila com zero referências a `package:provider`.

## Verificação

Execute este checklist depois do último passo, não só no fim:

- `flutter analyze` não reporta erros nem avisos de `riverpod_lint`.
- `dart run build_runner build --delete-conflicting-outputs` completa sem problemas.
- `flutter test` passa. Os testes do Riverpod usam `ProviderContainer` (ou `ProviderContainer.test()` na 3.x) e `container.read(provider)`, substituindo seus antigos testes unitários de `ChangeNotifier`.
- Uma passada manual de teste de fumaça: cada tela migrada ainda reconstrói na mudança de estado, e nenhuma tela lança `ProviderNotFoundException` (não deve sobrar nenhuma, por construção).
- `grep -rn "package:provider" lib/` não retorna nada.

## Plano de rollback

Esta migração é reversível por recurso justamente porque ambos os pacotes coexistem. Se uma tela migrada se comportar mal, reverta o commit daquela tela: coloque a linha `ChangeNotifierProvider` de volta no `MultiProvider`, restaure a classe `ChangeNotifier` e mude o widget de volta para `StatelessWidget`. Como você migrou das folhas para cima e um recurso por commit, nenhum rollback toca em mais de uma tela. Não apague o `provider` do `pubspec.yaml` (passo 7) até ter confiança, já que essa é a única porta de mão única na sequência.

## Pegadinhas que encontramos

**Mutação no lugar para de reconstruir.** Essa é a surpresa número um. No `provider`, `_items.add(x); notifyListeners()` funciona porque você controla a notificação. Em um `Notifier` do Riverpod, o framework reconstrói só quando `state` recebe um valor que não é `==` ao antigo. `state.add(x)` muta a mesma lista, a referência não muda, e nada reconstrói. Sempre atribua uma nova coleção: `state = [...state, x]`. O mesmo vale para objetos de model, e é por isso que estado imutável (records, `copyWith` ou uma classe `freezed`) combina naturalmente com o Riverpod.

**Os providers não fazem dispose quando o widget sai da árvore.** Um `ChangeNotifierProvider` do `provider` sofre dispose quando sua subárvore é removida. Um provider do Riverpod, por padrão, mantém seu estado por toda a vida do `ProviderScope`. Se você contava com o controller de uma tela resetando quando navega para fora, agora você precisa de `autoDispose` (ou, com geração de código, esse é o padrão para providers anotados a menos que você chame `ref.keepAlive()`). Audite qualquer provider cujo comportamento antigo dependia do dispose baseado na árvore.

**`ref.read` dentro de `build()` é uma armadilha.** Ler outro provider com `ref.read` dentro de um `Notifier.build()` ou de um `build` de widget captura o valor uma vez e nunca atualiza. Use `ref.watch` para qualquer coisa que deva reagir, e reserve `ref.read` para handlers de eventos como callbacks de botão. O `riverpod_lint` aponta a maioria desses para você, e é por isso que vale a pena instalar a dependência de dev já no primeiro dia.

**`Consumer` existe em ambos os pacotes.** Se você importar os dois durante a migração, `Consumer` fica ambíguo. O `Consumer` do Riverpod recebe um builder `(context, ref, child)`; o do `provider` recebe `(context, value, child)`. Prefira converter o widget inteiro para `ConsumerWidget` em vez de soltar um `Consumer` do Riverpod dentro de um widget da era do provider, e você vai evitar o conflito de import por completo.

A migração recompensa quem é chato: uma folha, um commit, rode os testes, repita. Quando você apagar o `provider` do `pubspec.yaml`, a parte arriscada já aconteceu semanas atrás em passos pequenos e reversíveis.

## Relacionados

- Se você está vindo de uma biblioteca de estado diferente, a [migração de GetX para Riverpod](/pt-br/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) cobre a mesma abordagem das folhas para cima para um framework mais pesado.
- Ainda decidindo? A [comparação entre provider, Riverpod e Bloc](/pt-br/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) expõe os tradeoffs antes de você se comprometer.
- Para o lado assíncrono, [estados de carregamento e erro com AsyncValue](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) aprofunda em `when` e `AsyncNotifier`.
- Vindo de `FutureBuilder` puro? Veja [FutureBuilder/StreamBuilder vs Riverpod AsyncValue](/pt-br/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/).
- O erro de runtime mais comum depois da migração: [Cannot use ref after the widget was disposed](/pt-br/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/).

## Fontes

- [Documentação do Riverpod: migrando de pkg:provider (início rápido)](https://riverpod.dev/docs/from_provider/quickstart)
- [Documentação do Riverpod: a partir de ChangeNotifier](https://riverpod.dev/docs/migration/from_change_notifier)
- [Documentação do Riverpod: o que há de novo na 3.0](https://riverpod.dev/docs/whats_new)
- [provider 6.1.5 no pub.dev](https://pub.dev/packages/provider/versions/6.1.5)
- [changelog do flutter_riverpod](https://pub.dev/packages/flutter_riverpod/changelog)
