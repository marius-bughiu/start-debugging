---
title: "Como migrar um app Flutter do GetX para o Riverpod"
description: "Migração passo a passo do GetX para o Riverpod 3.x em um app Flutter real: GetxController para Notifier, .obs para providers derivados, Get.find para ref.watch, Get.to para go_router, além de snackbars, theming e testes. Testado no Flutter 3.27.1, Dart 3.11, flutter_riverpod 3.3.1."
pubDate: 2026-05-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "getx"
  - "state-management"
  - "migration"
  - "how-to"
lang: "pt-br"
translationOf: "2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod"
translatedBy: "claude"
translationDate: 2026-05-06
---

A versão curta: instale `flutter_riverpod` ao lado do GetX, envolva seu app em um `ProviderScope` e migre uma tela por vez. Substitua cada `GetxController` por um `Notifier` (ou `AsyncNotifier` para trabalho assíncrono), traduza cada campo `.obs` em estado de notifier ou em um `Provider` que deriva dele, troque `Get.find<T>()` por `ref.watch(myProvider)` e mova o roteamento para `go_router` para finalmente abandonar `Get.to`. Snackbars, diálogos e mudanças de tema são reconstruídos contra as APIs regulares do Flutter. Testado no Flutter 3.27.1, Dart 3.11, flutter_riverpod 3.3.1, riverpod_generator 2.6.5 e go_router 14.6.

GetX ficou popular porque respondia a toda pergunta com um único import. Estado, rotas, injeção de dependência, snackbars, internacionalização, theming, tudo a partir de `package:get`. Essa era sua força em 2021 e se tornou seu problema em 2026: uma única dependência que controla metade do seu runtime, uma cultura de atalhos sem `BuildContext` (`Get.context!`, `Get.snackbar`) que dificulta o raciocínio sobre o app, e uma cadência de manutenção que não acompanha mais o ritmo de releases do Flutter. Riverpod é o tradeoff oposto. Ele faz uma única coisa (grafo de estado com dependências explícitas) e força você a se apoiar nas APIs padrão do Flutter para roteamento e shell de UI. A migração é em sua maior parte mecânica, mas alguns padrões vão resistir. Este post percorre os que pegam todo time.

## O que você está realmente traduzindo

Antes de tocar em qualquer código, anote o que o GetX está fazendo por você. A maioria dos apps se apoia em cinco coisas:

1. `GetxController` mais `Rx<T>` / `.obs` para estado.
2. `Get.put` / `Get.lazyPut` / `Get.find` para injeção de dependência.
3. `Obx` e `GetBuilder` para reconstruir widgets quando o estado muda.
4. `Get.to`, `Get.toNamed`, `Get.back` para navegação.
5. `Get.snackbar`, `Get.dialog`, `Get.changeTheme` para efeitos colaterais de UI.

Riverpod cuida de 1-3 diretamente, com o boilerplate gerado por código apropriado. Por design, ele não faz 4 ou 5. Você vai substituir a navegação por `go_router` (ou pelo `Navigator` integrado), e snackbars / diálogos / mudanças de tema voltam a ser widgets Flutter comuns lendo estado de um provider. Esta é a parte da migração que surpreende as pessoas: Riverpod tem escopo menor que o GetX, e esse é justamente o ponto.

## Adicione Riverpod sem remover GetX

A migração gradual só funciona se ambas as bibliotecas puderem coexistir. Elas podem, com uma ressalva: `Get.put` mantém seu próprio service locator, e Riverpod tem sua própria árvore de providers, então uma peça de estado tem exatamente um dono por vez. Escolha esse dono por tela, não por tipo.

```yaml
# pubspec.yaml. Flutter 3.27.1, Dart 3.11.
dependencies:
  flutter:
    sdk: flutter
  get: ^4.7.2
  flutter_riverpod: ^3.3.1
  riverpod_annotation: ^2.6.1
  go_router: ^14.6.2

dev_dependencies:
  build_runner: ^2.4.13
  riverpod_generator: ^2.6.5
  custom_lint: ^0.7.0
  riverpod_lint: ^2.6.5
```

Envolva seu `GetMaterialApp` existente em um `ProviderScope`. Você pode manter `GetMaterialApp` até o roteamento ser migrado; as duas árvores não brigam.

```dart
// lib/main.dart, Flutter 3.27.1
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:get/get.dart';

void main() {
  runApp(const ProviderScope(child: MyApp()));
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return GetMaterialApp(
      title: 'Migrating to Riverpod',
      home: const HomePage(),
      getPages: const [
        // existing GetX routes for screens not yet migrated
      ],
    );
  }
}
```

Adicione `riverpod_lint` ao `analysis_options.yaml` uma vez. Ele pega os dois erros que mais incomodam: ler um provider durante o build com `ref.read` e esquecer de tornar um notifier `final` quando você o armazena.

## GetxController para Notifier, a passagem mecânica

Pegue o controller mais simples que você tem. Counters são o hello-world do GetX, e a conversão é quase linha por linha.

```dart
// Before: GetX 4.7, Flutter 3.27.1
import 'package:get/get.dart';

class CounterController extends GetxController {
  final RxInt count = 0.obs;
  final RxBool busy = false.obs;

  Future<void> incrementAfterDelay() async {
    busy.value = true;
    await Future.delayed(const Duration(milliseconds: 200));
    count.value++;
    busy.value = false;
  }
}
```

O equivalente em Riverpod 3.x usa geração de código. O `counterProvider` gerado faz o papel de `Get.put` mais `Obx`: ele detém o estado, sabe como reconstruir dependentes, e se descarta quando nada lê dele.

```dart
// After: flutter_riverpod 3.3.1, riverpod_generator 2.6.5, Dart 3.11
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'counter.g.dart';

class CounterState {
  const CounterState({this.count = 0, this.busy = false});

  final int count;
  final bool busy;

  CounterState copyWith({int? count, bool? busy}) =>
      CounterState(count: count ?? this.count, busy: busy ?? this.busy);
}

@riverpod
class Counter extends _$Counter {
  @override
  CounterState build() => const CounterState();

  Future<void> incrementAfterDelay() async {
    state = state.copyWith(busy: true);
    await Future.delayed(const Duration(milliseconds: 200));
    state = state.copyWith(count: state.count + 1, busy: false);
  }
}
```

Execute `dart run build_runner watch -d` uma vez e deixe rodando. O gerador emite `counterProvider`, e seu widget o lê do mesmo jeito que costumava ler um `Obx`:

```dart
// flutter_riverpod 3.3.1
class CounterPage extends ConsumerWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(counterProvider);
    final ctrl = ref.read(counterProvider.notifier);
    return Scaffold(
      body: Center(
        child: s.busy
            ? const CircularProgressIndicator()
            : Text('${s.count}'),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: ctrl.incrementAfterDelay,
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

Duas coisas para internalizar. Primeiro, `ref.watch` se inscreve; `ref.read` não. Use `ref.read` apenas dentro de callbacks (toques em botão, métodos de ciclo de vida), nunca no método build. Segundo, a atribuição `state =` faz o equivalente a `count.value++` mais o rebuild, atomicamente. Não existe mais um momento entre `busy.value = true` e o rebuild em que outra parte do código possa observar um par de campos inconsistente. Essa única mudança elimina uma categoria de bug que apps GetX tendem a acumular.

## Trabalho assíncrono: AsyncNotifier substitui o flag de loading manual

A maioria dos controllers GetX carrega seu próprio `isLoading.obs` porque `RxFuture` tem arestas. Riverpod trata o assíncrono como um estado de primeira classe com `AsyncValue<T>`. O mesmo padrão de buscar uma lista de usuários se reduz a isto:

```dart
// flutter_riverpod 3.3.1, Dart 3.11
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'users.g.dart';

@riverpod
class Users extends _$Users {
  @override
  Future<List<User>> build() async {
    final api = ref.watch(apiClientProvider);
    return api.fetchUsers();
  }

  Future<void> refresh() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() => ref.read(apiClientProvider).fetchUsers());
  }
}
```

O widget recebe os estados de loading, error e data sem um único campo booleano:

```dart
class UsersPage extends ConsumerWidget {
  const UsersPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final users = ref.watch(usersProvider);
    return users.when(
      data: (list) => ListView(children: [for (final u in list) Text(u.name)]),
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text('Failed: $e')),
    );
  }
}
```

Riverpod 3.0 também tenta novamente providers que falharam automaticamente por padrão. Se você não quer isso (um 401 não deveria ser repetido, por exemplo), defina `retry: (count, error) => null` no provider ou globalmente no `ProviderScope`. Leia as [notas de migração do 3.0 sobre retry](https://riverpod.dev/docs/3.0_migration) antes de mudar isso; o comportamento padrão é genuinamente útil mas pode mascarar bugs transitórios em testes.

## Injeção de dependência: Get.find vira ref.watch

GetX usa um service locator global. Em qualquer lugar do app, `Get.find<ApiClient>()` retorna a mesma instância. Riverpod substitui isso por um provider que constrói o valor uma vez por `ProviderContainer`.

```dart
// flutter_riverpod 3.3.1
@riverpod
ApiClient apiClient(Ref ref) {
  final dio = ref.watch(dioProvider);
  return ApiClient(dio);
}

@riverpod
Dio dio(Ref ref) {
  final dio = Dio(BaseOptions(baseUrl: 'https://api.example.com'));
  ref.onDispose(() => dio.close(force: true));
  return dio;
}
```

`ref.onDispose` é a parte para a qual o GetX nunca teve uma resposta limpa. Quando o último consumidor de `dioProvider` desaparece, o cliente HTTP é fechado; se ele voltar, o provider é reconstruído e você recebe um `Dio` novo. O ciclo de vida finalmente é explícito. Para serviços que realmente vivem para sempre, marque o provider com `keepAlive: true` (ou pule `autoDispose`) e tome essa decisão no código em vez de torcer para que `Get.put(permanent: true)` sobreviva a um hot restart.

Para manter ambos os sistemas de DI funcionando durante a migração, registre uma pequena ponte que entrega singletons resolvidos pelo GetX para consumidores Riverpod:

```dart
// Bridge: read from GetX, expose as a Riverpod provider
@riverpod
LegacyAuthService legacyAuth(Ref ref) => Get.find<LegacyAuthService>();
```

Descarte a ponte assim que o lado GetX não tiver mais nada para registrar.

## Derivações reativas: onde .obs realmente brilha, e como Riverpod o substitui

`.obs` faz com que estado derivado pareça gratuito. `final fullName = ''.obs;` mais `ever(firstName, (_) => fullName.value = '$firstName $lastName')` é uma linha. O equivalente Riverpod é um provider separado que lista suas entradas:

```dart
// flutter_riverpod 3.3.1
@riverpod
String fullName(Ref ref) {
  final first = ref.watch(firstNameProvider);
  final last = ref.watch(lastNameProvider);
  return '$first $last';
}
```

A vantagem é que `fullNameProvider` é recalculado apenas quando uma de suas entradas realmente muda (Riverpod 3 usa `==` para filtragem de igualdade, uma evolução em relação à antiga checagem `identical`), e qualquer widget que o lê é reconstruído apenas quando a string derivada muda. O custo é que você precisa nomear cada entrada. Essa nomeação é a escolha editorial mais difícil da migração. Resista à tentação de enterrar tudo em um mega-notifier; providers pequenos compõem melhor e são muito mais fáceis de testar.

Para derivações que precisam de cancelamento (uma caixa de busca que faz requisições à rede conforme o usuário digita), use um `AsyncNotifier` e cancele via `ref.onDispose` mais um `CancelToken`. Isso substitui o `debounce(query, ..., time: ...)` do GetX por código que sobrevive a testes unitários.

## Roteamento: descarte Get.to e adote go_router

Esta é a etapa que os times mais adiam porque o roteamento do GetX realmente funciona. Pague o custo cedo. Uma vez que `go_router` controla a navegação, o resto da migração acelera porque você não precisa mais de `Get.context` nos controllers.

```dart
// go_router 14.6.2, Flutter 3.27.1
final goRouterProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(path: '/', builder: (_, __) => const HomePage()),
      GoRoute(path: '/users/:id', builder: (_, s) => UserPage(id: s.pathParameters['id']!)),
    ],
    redirect: (ctx, state) {
      final auth = ProviderScope.containerOf(ctx).read(authProvider);
      if (!auth.isLoggedIn && state.matchedLocation != '/login') return '/login';
      return null;
    },
  );
});

class MyApp extends ConsumerWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(goRouterProvider);
    return MaterialApp.router(
      routerConfig: router,
      theme: ref.watch(themeProvider),
    );
  }
}
```

Substitua `Get.to(NextPage())` por `context.go('/next')`, `Get.toNamed('/users/42')` por `context.go('/users/42')`, e `Get.back()` por `context.pop()`. Os caminhos tipados como string parecem um retrocesso em relação a construtores de página tipados no início; na prática você escreve uma fina `extension` em `BuildContext` que envolve as strings, e a checagem de links vem do `go_router_builder` ou dos seus testes.

## Snackbars, diálogos, temas: de volta ao Flutter puro

`Get.snackbar` é conveniente porque não precisa de um `BuildContext`. Essa conveniência é também o motivo pelo qual você não consegue testá-lo. A resposta idiomática do Riverpod é um sinal apenas de estado que a UI consome:

```dart
// flutter_riverpod 3.3.1
@riverpod
class Toast extends _$Toast {
  @override
  String? build() => null;

  void show(String message) => state = message;
  void clear() => state = null;
}

class ToastListener extends ConsumerWidget {
  const ToastListener({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.listen(toastProvider, (_, next) {
      if (next != null) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(next)));
        ref.read(toastProvider.notifier).clear();
      }
    });
    return child;
  }
}
```

Envolva a parte da sua árvore que tem um ancestral `Scaffold` em `ToastListener`. Agora qualquer controller pode chamar `ref.read(toastProvider.notifier).show('Saved')` sem tocar em `BuildContext`, e os testes verificam o estado do provider em vez de interceptar uma overlay.

Theming é parecido. `Get.changeTheme` se torna um `themeProvider` que o `MaterialApp.router` observa. Localização pode continuar usando `Get.locale` até você migrá-la por último, ou ir para `flutter_localizations` mais um `localeProvider`.

## Testes ficam mais rápidos e mais claros

O maior ganho está nos testes. Um teste de controller GetX normalmente precisa de `Get.testMode = true` mais um teardown cuidadoso de singletons. Um teste Riverpod cria um `ProviderContainer`, sobrescreve exatamente os providers de que se importa, e descarta no final:

```dart
// flutter_test, flutter_riverpod 3.3.1
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

void main() {
  test('Counter increments after delay', () async {
    final container = ProviderContainer(overrides: const []);
    addTearDown(container.dispose);

    final notifier = container.read(counterProvider.notifier);
    expect(container.read(counterProvider).count, 0);

    final f = notifier.incrementAfterDelay();
    expect(container.read(counterProvider).busy, true);
    await f;
    expect(container.read(counterProvider).count, 1);
    expect(container.read(counterProvider).busy, false);
  });
}
```

Sobrescreva providers para injetar fakes (`apiClientProvider.overrideWithValue(FakeApi())`) e você não precisa mais de um framework de mocking para a maioria dos casos. Listeners pausam quando não estão visíveis no Riverpod 3, mas em testes todo container é "visível" por padrão a menos que você modele explicitamente, então a mudança é invisível para suítes de teste existentes.

## Pegadinhas que a migração sempre encontra

**`autoDispose` versus singletons.** Providers `@riverpod` gerados por código são auto-dispose por padrão. Se você converteu um controller `Get.put(permanent: true)` e percebe que o estado se reseta quando você sai da tela, marque o provider com `@Riverpod(keepAlive: true)`. Faça isso deliberadamente; estado permanente é um vazamento de memória esperando para acontecer.

**Lendo providers em `initState`.** Um padrão GetX comum é `final c = Get.find<MyController>()` em `initState`. O equivalente Riverpod é `ref.read(myProvider.notifier)` em `initState`, mas apenas dentro de um `ConsumerStatefulWidget`. Ler dentro de `build` é aceitável para `ref.watch`; ler `notifier` uma vez em `initState` e guardar é um cheiro ruim, porque a identidade do notifier pode mudar após um `ref.invalidate`. Prefira `ref.read` no local da chamada.

**Tarefas em background sob mudanças de rota.** Riverpod 3 pausa listeners em widgets invisíveis, o que normalmente é o que você quer, mas isso muda o timing de trabalho que antes era mantido vivo pelo `Obx` ansioso do GetX. Se um refresh de rede precisa continuar rodando enquanto o usuário está em outra aba, dê esse trabalho a um `AsyncNotifier` com `keepAlive: true` em vez de esperar que um widget pausado o conduza.

**Hot restart descarta o lado GetX primeiro.** Durante a fase de biblioteca dupla, um hot restart reseta as instâncias de `Get.put` mas o estado do Riverpod sobrevive se o `ProviderScope` está no topo da árvore. Isso é genuinamente útil para a migração: você pode dar hot-restart, ver o estado controlado pelo Riverpod permanecer, e confirmar o que ainda falta migrar.

**Erros de build em `Obx` após exclusão.** Quando você remove o import do GetX de um arquivo, chamadas `Obx(...)` remanescentes se tornam um erro de compilação rígido em vez de um aviso de runtime. Procure no projeto por `Obx(` e `GetBuilder<` antes de fazer commit; o compilador vai pegá-las, mas uma única passada de grep economiza um ciclo de build.

## Como isso se encaixa com o resto do seu pipeline Flutter

A migração raramente é a única tarefa Flutter em andamento. Se você também executa [uma matriz de CI multi-versão](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), fixe explicitamente tanto `flutter_riverpod` quanto os arquivos `*.g.dart` gerados para que um bump do Dart SDK não regenere silenciosamente boilerplate que quebra um branch antigo. Trabalho CPU-bound que costumava viver em um controller GetX (parsing, hashing, reduces grandes) pertence [a uma isolate Dart](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) de qualquer forma, e a mudança para `AsyncNotifier` deixa esse handoff mais limpo porque o estado de loading já é de primeira classe. Se um notifier precisa chamar código nativo, [adicione-o por meio de um platform channel sem escrever um plugin](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/), e então exponha o channel como seu próprio provider para que os testes possam sobrescrevê-lo. E quando a migração estiver concluída e você publicar uma build que precisa ser depurada em um dispositivo real, o [workflow de iOS-pelo-Windows com dispositivo real](/pt-br/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) ainda se aplica; nada na biblioteca de estado muda como a porta do observatory se comporta.

O modelo mental mais curto para a migração: GetX troca correção por ergonomia, Riverpod troca ergonomia por correção. Você não está reescrevendo seu app, está renomeando e re-escopo do seu grafo de estado. Faça isso tela a tela, deixe a fase de biblioteca dupla rodando até que cada `Get.find` tenha sumido, e não pule a etapa de roteamento. Quando o último import de `package:get` sair do `pubspec.yaml`, a base de código será menor, e os testes serão a parte que você deixa de temer.

## Links de referência

- [Guia de migração do Riverpod 3.0](https://riverpod.dev/docs/3.0_migration)
- [flutter_riverpod no pub.dev](https://pub.dev/packages/flutter_riverpod)
- [riverpod_generator no pub.dev](https://pub.dev/packages/riverpod_generator)
- [go_router no pub.dev](https://pub.dev/packages/go_router)
- [Receitas de teste do Riverpod](https://riverpod.dev/docs/essentials/testing)
- [Pacote GetX no pub.dev](https://pub.dev/packages/get)
