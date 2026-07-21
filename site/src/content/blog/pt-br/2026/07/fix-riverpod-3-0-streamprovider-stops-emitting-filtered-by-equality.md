---
title: "Correção: StreamProvider do Riverpod 3.0 para de emitir porque atualizações são filtradas por =="
description: "No Riverpod 3.0 todo provider filtra as notificações de listeners com ==, não por identidade. Um StreamProvider que reemite o mesmo objeto mutável para de reconstruir a UI depois do primeiro frame. Veja por que isso acontece e três formas de corrigir. Testado no flutter_riverpod 3.3.2, Flutter 3.44, Dart 3.x."
pubDate: 2026-07-21
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "streams"
lang: "pt-br"
translationOf: "2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality"
translatedBy: "claude"
translationDate: 2026-07-21
---

Se você atualizou para o Riverpod 3.0 e um `StreamProvider` de repente reconstrói seu widget exatamente uma vez e depois fica em silêncio, a causa é uma única linha nas notas de migração que é fácil de pular: no 3.0 todo provider filtra as notificações de listeners com `==` em vez de por identidade. Quando seu stream emite a mesma instância de objeto duas vezes (uma lista mutável que você altera no lugar, um modelo apoiado por um controller que você empurra de novo), o Riverpod compara o novo valor com o anterior, encontra que são iguais e descarta a notificação. O stream continua disparando. Seu `StreamSubscription` fora do Riverpod ainda veria cada evento. Mas o `ref.watch` nunca reconstrói, porque, no que diz respeito ao Riverpod, nada mudou. A correção é emitir um novo valor, não igual, a cada vez, ou sobrescrever `updateShouldNotify`. Este post foi testado no `flutter_riverpod` 3.3.2 (junho de 2026), Flutter 3.44 e Dart 3.x.

## O que de fato mudou no 3.0

Antes do 3.0, o Riverpod era inconsistente sobre como decidia se um novo valor justificava notificar os listeners. Alguns tipos de provider comparavam com `==`, alguns usavam `identical` e alguns tinham lógica própria. O `StreamProvider` ficava do lado da identidade dessa linha: qualquer evento que o stream produzisse era empurrado aos listeners, porque um evento de stream recém-entregue era, na prática, tratado como novo.

O Riverpod 3.0 consolidou tudo isso em uma única regra. Do [guia oficial de migração do 3.0](https://riverpod.dev/docs/3.0_migration): "all providers now use `==` to filter updates." O guia cita os providers com maior probabilidade de serem afetados: "The most likely way for you to be impacted by this change is when using `StreamProvider`/`StreamNotifier`, as stream values will now be filtered by `==`."

Essa é uma boa mudança para a consistência. Ela significa que um provider que recalcula um valor igual ao anterior não vai reconstruir desnecessariamente todos os widgets abaixo dele, que é a mesma otimização que você buscaria de outra forma com `select`. O problema é o modo de falha silenciosa que isso introduz para um padrão que era completamente aceitável no 2.x: emitir um objeto mutável, alterá-lo e emiti-lo de novo.

## A reprodução mínima

Aqui está a menor coisa que quebra. Um repositório guarda uma `List<int>`, adiciona elementos a ela e empurra a mesma lista por um `StreamController` após cada adição.

```dart
// flutter_riverpod 3.3.2, Dart 3.x
import 'dart:async';

class CounterRepository {
  final _values = <int>[];
  final _controller = StreamController<List<int>>.broadcast();

  Stream<List<int>> get stream => _controller.stream;

  void add(int value) {
    _values.add(value);
    _controller.add(_values); // same List instance every time
  }
}
```

Conecte-o a um `StreamProvider` e observe:

```dart
// flutter_riverpod 3.3.2
final repositoryProvider = Provider((ref) => CounterRepository());

final valuesProvider = StreamProvider<List<int>>((ref) {
  return ref.watch(repositoryProvider).stream;
});

class ValuesView extends ConsumerWidget {
  const ValuesView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(valuesProvider);
    return async.when(
      data: (values) => Text('Count: ${values.length}'),
      loading: () => const CircularProgressIndicator(),
      error: (e, _) => Text('Error: $e'),
    );
  }
}
```

No 2.x isso mostra `Count: 1`, depois `Count: 2`, depois `Count: 3` conforme você chama `add`. No 3.0 mostra `Count: 1` e depois nunca mais atualiza. O widget fica travado na primeira emissão.

## Por que == retorna true aqui mesmo que os dados tenham mudado

A armadilha é que `_values` é o mesmo objeto em cada emissão. Quando você chama `_controller.add(_values)` uma segunda vez, o stream entrega a referência idêntica de `List`. O Riverpod envolve cada evento do stream em um `AsyncData<List<int>>` e pergunta se o novo `AsyncValue` é igual ao anterior.

O `AsyncValue` implementa igualdade por valor, e duas instâncias de `AsyncData` são iguais quando os valores que elas contêm são iguais. Para sua lista, `==` recai na igualdade padrão de `List`, que para uma `List` comum é igualdade por referência: uma lista é igual apenas a si mesma. Como é literalmente o mesmo objeto, `previous == next` é `true`. O Riverpod conclui que o valor não mudou e suprime a notificação. A mutação que você fez entre as emissões é invisível para a comparação porque não há "snapshot anterior" para comparar. Existe apenas uma lista, e ela sempre é igual a si mesma.

Essa é a parte que o guia de migração subestima. Uma [issue no GitHub sobre exatamente esse comportamento](https://github.com/rrousselGit/riverpod/issues/4310) descreve isso como uma falha silenciosa que custou três dias de depuração: callbacks diretos de `stream.listen` ainda recebem cada evento, então o stream parece saudável isoladamente, mas a camada de provider silenciosamente deduplica. A discrepância entre "o stream dispara" e "a UI não reconstrói" é o que torna isso tão difícil de detectar.

## Correção 1: emita uma nova instância a cada vez

A correção mais direta, e a que você quase sempre quer, é parar de reutilizar o mesmo objeto mutável. Emita um snapshot imutável para que cada evento seja um valor distinto que não seja `==` ao anterior.

```dart
// flutter_riverpod 3.3.2, Dart 3.x
void add(int value) {
  _values.add(value);
  _controller.add(List<int>.unmodifiable(_values)); // fresh instance each emit
}
```

`List<int>.unmodifiable(_values)` aloca uma nova lista contendo os elementos atuais. É um objeto diferente da emissão anterior, então `previous == next` é `false` e o Riverpod notifica. Como bônus, você não está mais vazando uma lista mutável para dentro da sua árvore de widgets, que era um bug latente independentemente da versão do Riverpod: qualquer consumidor poderia ter alterado o estado interno do seu repositório através da referência que recebeu.

Essa não é uma regra específica do Riverpod. Empurrar a mesma coleção mutável por um stream e alterá-la no lugar é frágil com qualquer consumidor que tire um snapshot ou compare valores. Emissões imutáveis são a correção duradoura.

## Correção 2: use igualdade por valor deliberadamente, aí funciona sozinho

Às vezes você *quer* que `==` compare o conteúdo, porque está emitindo uma classe de modelo e quer que a UI pule reconstruções quando nada de significativo mudou. Nesse caso, dê ao seu tipo emitido uma igualdade por valor de verdade e o comportamento do 3.0 se torna um trunfo em vez de um bug.

```dart
// Dart 3.x records give you value equality for free
final positionProvider = StreamProvider<({double lat, double lng})>((ref) {
  return locationStream(); // each event is a new record
});
```

Os records do Dart comparam estruturalmente, então dois records com os mesmos campos são `==`. Isso significa que um stream de GPS que emite as mesmas coordenadas duas vezes vai corretamente pular a reconstrução, e um que emite uma nova posição vai dispará-la. O mesmo vale para uma classe com `==`/`hashCode` gerados pelo `freezed`, ou um `operator ==` escrito à mão. A regra geral: se o valor é imutável e tem igualdade por valor, o 3.0 faz a coisa certa automaticamente. Ele só se comporta mal quando você contrabandeia um objeto mutável pela verificação de igualdade mantendo a mesma referência.

## Correção 3: sobrescreva updateShouldNotify em um StreamNotifier

Se você genuinamente não puder mudar o que o stream emite (uma fonte de terceiros, um repositório legado que não é seu), você pode sobrescrever a comparação. Isso só está disponível na API baseada em classe, então você converte o `StreamProvider` funcional em um `StreamNotifierProvider` e sobrescreve `updateShouldNotify`.

```dart
// flutter_riverpod 3.3.2 with riverpod_annotation 3.x
@riverpod
class Values extends _$Values {
  @override
  Stream<List<int>> build() {
    return ref.watch(repositoryProvider).stream;
  }

  @override
  bool updateShouldNotify(
    AsyncValue<List<int>> previous,
    AsyncValue<List<int>> next,
  ) {
    return true; // always notify, restore the 2.x behavior for this provider
  }
}
```

Retornar `true` incondicionalmente restaura o comportamento pré-3.0 de "notificar a cada emissão" para este provider específico sem mudar o padrão global do resto do seu app. Você também pode torná-lo mais inteligente, por exemplo comparando comprimentos ou um contador de versão, se reconstruções incondicionais forem agressivas demais. Note que o `StreamProvider((ref) => ...)` funcional cru não tem hook `updateShouldNotify`, então esta correção exige a forma baseada em classe. Se você ainda está decidindo entre os estilos funcional e baseado em classe, o guia de [migração do Riverpod 2.x para o 3.0](/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/) mostra quando cada um vale a pena.

## Como confirmar que este é o seu bug e não outra coisa

O sintoma (um widget apoiado por stream que atualiza uma vez e congela) tem algumas causas possíveis, então verifique se é o filtro de igualdade antes de recorrer a estas correções:

1. Adicione um `print` dentro da fonte do stream, logo antes de `_controller.add(...)`. Se ele imprimir a cada evento mas o widget não reconstruir, os eventos estão chegando ao stream mas sendo filtrados mais abaixo.
2. Anexe um listener cru temporário: `ref.watch(repositoryProvider).stream.listen((v) => debugPrint('raw: $v'))`. Se o listener cru disparar a cada vez mas `ref.watch(valuesProvider)` não reconstruir, a camada de provider está deduplicando, o que confirma o filtro `==`.
3. Verifique se o objeto emitido é a mesma instância. Se você está empurrando um campo, uma lista em cache ou um modelo singleton, você quase certamente está caindo nisso.

Se, em vez disso, o próprio stream para de disparar, esse é um problema diferente: um `StreamSubscription` que foi cancelado, um controller que foi fechado, ou um provider que foi descartado e recriado. Para o lado do descarte dos ciclos de vida de stream, veja [cancelar um StreamSubscription no dispose](/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/).

## Armadilhas relacionadas no mesmo release 3.0

O filtro de igualdade é uma de um grupo de mudanças do 3.0 que aparecem em tempo de execução e não em tempo de compilação, o que é o que as torna caras de depurar. Duas outras que vale conhecer antes de você entregar:

- **Erros agora saem embrulhados.** Um provider que lança uma exceção não relança mais sua exceção original diretamente. Veja [Riverpod 3.0 lançando ProviderException em vez do erro original](/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/) para saber como desembrulhá-la.
- **Providers que falham tentam de novo automaticamente.** Um `FutureProvider` ou `StreamProvider` que dá erro vai tentar de novo com backoff exponencial por padrão, o que pode mascarar um bug ou martelar um endpoint que está falhando. Desligue isso por provider ou globalmente conforme descrito em [desabilitar a repetição automática de providers do Riverpod 3.0](/2026/07/how-to-disable-riverpod-3-0-automatic-provider-retry/).

E se as lacunas assíncronas dentro do seu notifier tocam `ref` depois de um `await`, proteja-as com a verificação de mounted coberta em [verificar Ref.mounted depois de uma lacuna assíncrona](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/).

## A regra de uma linha para lembrar

O Riverpod 3.0 reconstrói quando `previous != next`. Se seu `StreamProvider` reutiliza um objeto mutável, `previous` e `next` são a mesma referência, então são sempre iguais e ele nunca reconstrói. Emita snapshots imutáveis (ou dê ao seu tipo de valor uma igualdade de verdade) e o framework faz a coisa certa. Recorra a `updateShouldNotify` apenas quando você não puder controlar o valor emitido. Para uma visão mais ampla de quando um `StreamProvider` e seu `AsyncValue` são de fato a ferramenta certa versus os widgets builder mais antigos, a comparação entre [FutureBuilder e StreamBuilder contra o AsyncValue do Riverpod](/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) é uma boa próxima leitura.

## Fontes

- [Migrating from 2.0 to 3.0, Riverpod official docs](https://riverpod.dev/docs/3.0_migration)
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new)
- [rrousselGit/riverpod issue #4310: updateShouldNotify changes are downplayed in the migration guide](https://github.com/rrousselGit/riverpod/issues/4310)
- [StreamProvider class reference, flutter_riverpod](https://pub.dev/documentation/flutter_riverpod/latest/flutter_riverpod/StreamProvider-class.html)
