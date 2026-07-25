---
title: "Migre um StatefulWidget com setState para um Notifier do Riverpod no Flutter"
description: "Um caminho passo a passo do setState local do widget para um Notifier do Riverpod 3.x: classifique o que realmente sai do widget, escreva o Notifier, converta para ConsumerWidget e sobreviva ao filtro por ==, à reexecução do build() e aos padrões de autoDispose que pegam quem vem do setState. Testado no Flutter 3.44, Dart 3.x e flutter_riverpod 3.3.2."
pubDate: 2026-07-25
updatedDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "pt-br"
translationOf: "2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-25
---

Tirar uma tela do `setState` e colocá-la em um `Notifier` do Riverpod leva cerca de uma hora depois que você já fez isso duas vezes, e a maior parte dessa hora é decidir o que **não** deve migrar. Este guia foi testado no Flutter 3.44 (estável, maio de 2026), Dart 3.x e `flutter_riverpod` 3.3.2, com `riverpod_generator` 4.0.4 e `riverpod_annotation` 4.0.3 para a variante com geração de código. O que quebra raramente é o compilador: as três coisas que pegam são o Riverpod 3.0 filtrando notificações com `==` (então a mutação de lista no lugar que passava batido com `setState` agora para de reconstruir a interface silenciosamente), o `Notifier.build()` executando de novo onde o `initState` rodava uma única vez, e o descarte automático tendo padrões diferentes para providers gerados e escritos à mão. Faça isso quando dois widgets precisarem do mesmo estado, ou quando você quiser testar a lógica sem montar um widget. Não faça para uma tela que é dona de um único booleano.

## Por que esse estado deve sair do widget

- **Dois leitores, uma fonte.** Um selo de carrinho no `AppBar` e uma tela de carrinho a duas rotas de distância precisam das mesmas linhas. Com `setState` você ou eleva o estado para um ancestral comum e empurra callbacks para baixo, ou mantém duas cópias e torce para que concordem.
- **A lógica fica testável em unidade.** Um `Notifier` é um objeto Dart comum. Você consegue controlá-lo a partir de um `ProviderContainer.test()` em um bloco `test()` normal, sem `pumpWidget`, sem `WidgetTester` e sem agendamento de frames.
- **O estado sobrevive à rota quando você quer.** Um `NotifierProvider` mantém seu valor através de um `Navigator.pop`, que é exatamente o que um carrinho, um formulário em rascunho ou um assistente de várias etapas precisam. O estado do widget morre com o elemento.
- **As mutações ganham nome.** `setState(() => _lines = [..._lines, line])` espalhado por seis callbacks vira `cartProvider.notifier.add(line)`, que é um único lugar para registrar em log, proteger ou limitar.

Nada disso defende mover tudo. Um `TextEditingController`, um `AnimationController`, um `FocusNode`, um `ScrollController` e um `GlobalKey<FormState>` pertencem ao widget e devem ficar em um objeto `State`.

## O que quebra

| Área | Mudança | Severidade |
| ---- | ------- | ---------- |
| Classe base do widget | `StatefulWidget` vira `ConsumerWidget`, ou `ConsumerStatefulWidget` se controladores ficarem | alta |
| Mutação de coleção no lugar | O Riverpod 3.0 filtra com `==`; `state.add(x)` seguido de `state = state` não reconstrói | alta |
| Chamadas a `setState` | Substituídas pela atribuição de `state` dentro do `Notifier` | alta |
| `initState` | Migra para `Notifier.build()`, que pode rodar mais de uma vez | média |
| `dispose` | Vai para `ref.onDispose`, apenas para recursos pertencentes ao provider | média |
| Tempo de vida do estado | Providers gerados descartam automaticamente por padrão; os escritos à mão não | média |
| `context` depois de um `await` | `context.mounted` dentro do widget vira `ref.mounted` dentro do notifier | média |
| Testes de widget | `pumpWidget` precisa de um `ProviderScope` em volta ou toda leitura lança exceção | baixa |

## Checklist de preparação

1. Flutter 3.44 estável e Dart 3.x na máquina e no CI (`flutter --version`).
2. `flutter_riverpod: ^3.3.2` no `pubspec.yaml`, e `ProviderScope` envolvendo o `runApp`. Se você ainda está no 2.x, faça essa atualização antes e separadamente: veja [a migração do Riverpod 2.x para o Riverpod 3.0](/pt-br/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/).
3. Decida agora se vai usar geração de código ou não, não no meio do caminho. A geração de código precisa de `riverpod_annotation: ^4.0.3` mais `riverpod_generator: ^4.0.4` e `build_runner` em `dev_dependencies`.
4. `riverpod_lint` e `custom_lint` habilitados no `analysis_options.yaml`. Ele pega `ref.read` dentro de um método `build`, que é o erro mais comum desta migração.
5. Um teste de widget que fixe o comportamento atual da tela antes de você mexer nela. Você quer um sinal vermelho/verde, não uma impressão.
6. Uma branch. Isso é reversível, mas não em três commits pequenos.

## O ponto de partida

Uma tela de carrinho guardando tudo em `State`, com um callback empurrado para um filho para que o selo consiga atualizar:

```dart
// Flutter 3.44, Dart 3.x -- before
class CartScreen extends StatefulWidget {
  const CartScreen({super.key});
  @override
  State<CartScreen> createState() => _CartScreenState();
}

class _CartScreenState extends State<CartScreen> {
  List<CartLine> _lines = const [];
  bool _isSubmitting = false;
  final _couponController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _lines = CartStorage.instance.load();
  }

  @override
  void dispose() {
    _couponController.dispose();
    super.dispose();
  }

  void _add(CartLine line) {
    setState(() => _lines = [..._lines, line]);
  }

  void _setQuantity(String sku, int quantity) {
    setState(() {
      _lines = [
        for (final l in _lines)
          if (l.sku == sku) l.copyWith(quantity: quantity) else l,
      ];
    });
  }

  Future<void> _submit() async {
    setState(() => _isSubmitting = true);
    await CheckoutApi.submit(_lines);
    if (!mounted) return;
    setState(() => _isSubmitting = false);
  }

  @override
  Widget build(BuildContext context) => CartView(
        lines: _lines,
        isSubmitting: _isSubmitting,
        couponController: _couponController,
        onQuantityChanged: _setQuantity,
      );
}
```

## Passos da migração

1. **Classifique cada campo do objeto `State`.** Divida-os em duas listas no papel antes de escrever código. O estado de domínio que outro widget poderia plausivelmente precisar (`_lines`, `_isSubmitting`) vai para o notifier. Os objetos de framework atrelados ao elemento deste widget (`_couponController`, focus nodes, controladores de animação, chaves de formulário) ficam. *Verificação:* cada campo está em exatamente uma lista, e nada da lista "fica" é lido por outra rota.

2. **Modele o estado como um único valor imutável.** Dois campos soltos viram uma classe para que uma única atribuição de `state` descreva a tela inteira. *Verificação:* `dart analyze` está limpo e a classe tem `copyWith`.

   ```dart
   // Flutter 3.44, Dart 3.x
   class CartState {
     const CartState({this.lines = const [], this.isSubmitting = false});
     final List<CartLine> lines;
     final bool isSubmitting;

     int get itemCount => lines.fold(0, (sum, l) => sum + l.quantity);

     CartState copyWith({List<CartLine>? lines, bool? isSubmitting}) =>
         CartState(
           lines: lines ?? this.lines,
           isSubmitting: isSubmitting ?? this.isSubmitting,
         );
   }
   ```

3. **Escreva o `Notifier`.** O `build()` devolve o estado inicial e substitui o `initState`. Cada antigo closure de `setState` vira um método público que atribui `state`. *Verificação:* o arquivo compila sem nenhuma referência a `BuildContext`, `setState` ou qualquer tipo de widget.

   ```dart
   // flutter_riverpod 3.3.2 -- no codegen
   import 'package:flutter_riverpod/flutter_riverpod.dart';

   final cartProvider = NotifierProvider<CartNotifier, CartState>(
     CartNotifier.new,
   );

   class CartNotifier extends Notifier<CartState> {
     @override
     CartState build() => CartState(lines: CartStorage.instance.load());

     void add(CartLine line) {
       state = state.copyWith(lines: [...state.lines, line]);
     }

     void setQuantity(String sku, int quantity) {
       state = state.copyWith(
         lines: [
           for (final l in state.lines)
             if (l.sku == sku) l.copyWith(quantity: quantity) else l,
         ],
       );
     }

     Future<void> submit() async {
       state = state.copyWith(isSubmitting: true);
       await CheckoutApi.submit(state.lines);
       if (!ref.mounted) return;
       state = state.copyWith(isSubmitting: false);
     }
   }
   ```

   A forma com geração de código é a mesma classe com o provider inferido:

   ```dart
   // riverpod_annotation 4.0.3, riverpod_generator 4.0.4
   @Riverpod(keepAlive: true)
   class Cart extends _$Cart {
     @override
     CartState build() => CartState(lines: CartStorage.instance.load());
     // ...same methods
   }
   ```

4. **Faça testes de unidade do notifier antes de tocar em um único widget.** Essa é a recompensa, então colha cedo. *Verificação:* `flutter test test/cart_notifier_test.dart` passa sem nenhum widget montado.

   ```dart
   // flutter_riverpod 3.3.2
   test('setQuantity replaces the matching line', () {
     final container = ProviderContainer.test();
     container.read(cartProvider.notifier).add(const CartLine(sku: 'A', quantity: 1));
     container.read(cartProvider.notifier).setQuantity('A', 3);
     expect(container.read(cartProvider).itemCount, 3);
   });
   ```

5. **Converta o widget.** Se nada do passo 1 ficou para trás, o `StatefulWidget` se reduz a `ConsumerWidget` e o `build` ganha um `WidgetRef`. Como o controlador do cupom ficou, esta tela vira um `ConsumerStatefulWidget`. *Verificação:* `flutter analyze` reporta zero problemas, incluindo as regras do `riverpod_lint`.

   ```dart
   // Flutter 3.44, flutter_riverpod 3.3.2 -- after
   class CartScreen extends ConsumerStatefulWidget {
     const CartScreen({super.key});
     @override
     ConsumerState<CartScreen> createState() => _CartScreenState();
   }

   class _CartScreenState extends ConsumerState<CartScreen> {
     final _couponController = TextEditingController();

     @override
     void dispose() {
       _couponController.dispose();
       super.dispose();
     }

     @override
     Widget build(BuildContext context) {
       final cart = ref.watch(cartProvider);
       return CartView(
         lines: cart.lines,
         isSubmitting: cart.isSubmitting,
         couponController: _couponController,
         onQuantityChanged: (sku, qty) =>
             ref.read(cartProvider.notifier).setQuantity(sku, qty),
       );
     }
   }
   ```

6. **Aplique a regra watch/read em cada ponto de chamada.** `ref.watch` no `build` porque você quer reconstruções. `ref.read(provider.notifier)` nos callbacks porque não quer. Nunca use `ref.watch` dentro de um `onPressed`. *Verificação:* procure `ref.read(` no arquivo e confirme que cada ocorrência está dentro de um callback ou de um método assíncrono, nunca no `build`.

7. **Apague os callbacks empurrados para baixo e deixe o outro widget observar diretamente.** Este é o passo que paga a migração. O selo para de receber uma contagem através de três construtores e lê o provider por conta própria. *Verificação:* os widgets intermediários não declaram mais os parâmetros removidos, e adicionar um item pela tela do carrinho atualiza o selo em outra rota.

   ```dart
   // flutter_riverpod 3.3.2
   class CartBadge extends ConsumerWidget {
     const CartBadge({super.key});
     @override
     Widget build(BuildContext context, WidgetRef ref) {
       final count = ref.watch(cartProvider.select((s) => s.itemCount));
       return Badge(label: Text('$count'));
     }
   }
   ```

   O `select` importa aqui. Sem ele o selo reconstrói sempre que `isSubmitting` muda, o que com `setState` nunca acontecia porque ele nem estava naquela subárvore.

8. **Mova a limpeza pertencente ao provider para `ref.onDispose`.** Tudo o que o notifier criou (um `StreamSubscription`, um timer, um socket) é liberado ali, não no `dispose` do widget. *Verificação:* alterne a tela e confirme que não há assinaturas duplicadas nos logs.

   ```dart
   @override
   CartState build() {
     final sub = PriceFeed.stream.listen(_onPriceChanged);
     ref.onDispose(sub.cancel);
     return CartState(lines: CartStorage.instance.load());
   }
   ```

## Verificação

Rode esta lista antes de fazer o merge:

- `flutter analyze` reporta zero problemas com o `riverpod_lint` habilitado.
- `flutter test` passa, e os testes de widget agora envolvem a tela em um `ProviderScope`. Sem ele, o primeiro `ref.watch` lança exceção em tempo de execução, não em tempo de compilação.
- A tela constrói e cada interação que antes usava `setState` continua atualizando a interface. Passe por cada uma; o modo de falha do filtro por `==` (veja abaixo) não produz erro nenhum, apenas um widget congelado.
- Empilhe a tela, saia dela e empilhe de novo. Confirme que a persistência do estado é a que você pretendia, não a que aconteceu por acidente.
- Checagem em modo profile com o DevTools: a contagem de reconstruções do pai deve ser igual ou menor que antes. Se subiu, está faltando um `select`.

## Plano de rollback

Esta migração é reversível com `git revert` desde que você a tenha mantido na própria branch, porque nada muda em disco nem na rede. A única coisa que o revert não restaura é o comportamento que dependia do novo tempo de vida: se você já publicou e os usuários se acostumaram com o carrinho sobrevivendo a uma navegação de volta, reverter para o estado local do widget o descarta silenciosamente no pop. Reverta o código e teste de novo os fluxos de navegação, não só o build.

## Problemas que encontramos

**A mutação no lugar parou de reconstruir.** Com `setState`, `_lines.add(line)` dentro do closure funcionava, porque o `setState` marca o elemento como sujo independentemente do que mudou. O Riverpod 3.0 compara o estado antigo com o novo usando `==` e pula a notificação quando são iguais, então isso não faz absolutamente nada:

```dart
// broken on flutter_riverpod 3.x
void add(CartLine line) {
  state.lines.add(line); // mutates the same List instance
  state = state;         // identical, == is true, no listeners notified
}
```

Sempre construa um valor novo, como faz o passo 3. É o mesmo filtro por igualdade que pega as pessoas quando [um StreamProvider do Riverpod 3.0 para de emitir](/pt-br/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/). Aqui ele pega mais forte se a sua classe de estado usa `equatable` ou um tipo de valor do `freezed`, porque aí até um objeto reconstruído corretamente com conteúdo inalterado será filtrado.

**`build()` não é `initState`.** O `initState` roda uma vez por elemento. O `Notifier.build()` roda de novo sempre que uma dependência observada muda, e redefine `state` para o que quer que ele retorne. Se você usar `ref.watch(authProvider)` dentro do `build()`, uma renovação de token apaga o carrinho. Use `ref.read` para valores que você só quer na inicialização, e reserve o `ref.watch` no `build()` para dependências que genuinamente devem redefinir o estado.

**Os padrões de descarte automático diferem entre as duas sintaxes.** Um `NotifierProvider(CartNotifier.new)` escrito à mão fica vivo por padrão; você adere com `isAutoDispose: true`. Um provider gerado com `@riverpod` é descartado automaticamente por padrão; você sai com `@Riverpod(keepAlive: true)`. Times que escrevem as duas formas na mesma base de código acabam com um carrinho que se esvazia sozinho em algumas telas e em outras não, sem nenhum erro que explique isso.

**O `mounted` mudou de lugar.** Dentro do widget você continua usando `context.mounted` e a habitual [proteção com `mounted` depois de um intervalo assíncrono](/pt-br/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/). Dentro do notifier não existe `BuildContext`, então a checagem é [`ref.mounted` depois do await](/pt-br/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/). Esquecer disso lança exceção quando o provider foi descartado enquanto a requisição estava em andamento.

**Controladores não pertencem ao notifier.** Colocar um `TextEditingController` no estado do provider parece organizado até o provider sobreviver ao widget e você estar digitando em um controlador cujos listeners já não existem. Mantenha as [regras de descarte de controladores](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) exatamente onde estavam.

## Leituras relacionadas

- [Provider vs Riverpod vs Bloc para gerenciamento de estado no Flutter em 2026](/pt-br/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) se você ainda está escolhendo o destino.
- [Migrar do Riverpod 2.x para o Riverpod 3.0](/pt-br/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/), a atualização a fazer antes desta.
- [Migrar do FutureBuilder para um AsyncNotifier do Riverpod](/pt-br/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/) para o equivalente assíncrono desta migração.
- [Qual pacote do Riverpod você realmente precisa](/pt-br/2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need/), porque `riverpod` e `flutter_riverpod` não são intercambiáveis.
- [Mostrar estados de carregamento e erro com AsyncValue](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) quando o notifier começar a fazer IO.

## Fontes

- [Novidades do Riverpod 3.0](https://riverpod.dev/docs/whats_new) para o `Ref` unificado, `ref.mounted`, `ProviderContainer.test()` e o filtro de notificações por `==`.
- [Referência de providers do Riverpod](https://riverpod.dev/docs/concepts2/providers) para o contrato de `Notifier` e `build()`.
- [Descarte automático no Riverpod](https://riverpod.dev/docs/concepts2/auto_dispose) para `isAutoDispose` e `ref.keepAlive()`.
- [Migrando de 2.0 para 3.0](https://riverpod.dev/docs/3.0_migration) para a remoção das interfaces `AutoDispose`.
- [flutter_riverpod no pub.dev](https://pub.dev/packages/flutter_riverpod) e [riverpod_generator no pub.dev](https://pub.dev/packages/riverpod_generator) para as versões fixadas 3.3.2 e 4.0.4.
- [Notas de versão do Flutter](https://docs.flutter.dev/release/release-notes) para a linha de base 3.44 estável.
