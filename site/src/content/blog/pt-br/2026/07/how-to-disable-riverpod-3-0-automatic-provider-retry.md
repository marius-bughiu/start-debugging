---
title: "Como desativar a nova tentativa automática de provider do Riverpod 3.0"
description: "O Riverpod 3.0 tenta novamente um provider que falhou ate 10 vezes por padrao. Passe uma funcao de retry que retorna null no ProviderScope, ProviderContainer ou em um provider individual para desligar ou limitar esse comportamento."
pubDate: 2026-07-20
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "async"
lang: "pt-br"
translationOf: "2026/07/how-to-disable-riverpod-3-0-automatic-provider-retry"
translatedBy: "claude"
translationDate: 2026-07-20
---

O Riverpod 3.0 adicionou a nova tentativa automatica: quando um provider lanca uma excecao enquanto esta compilando, o Riverpod silenciosamente o tenta de novo ate 10 vezes com um backoff exponencial que comeca em 200ms e dobra ate chegar a 6,4 segundos. Para desligar isso, passe um callback `retry` que retorna `null`. Voce pode fazer isso globalmente no `ProviderScope` ou no `ProviderContainer`, ou por provider no construtor do provider ou na anotacao `@Riverpod`. Isto foi testado no `flutter_riverpod` 3.x (a linha 3.0 foi lancada em setembro de 2025; a versao atual e a 3.3.2, de junho de 2026), Flutter 3.44 e Dart 3.x.

O one-liner, se voce so quer que isso suma em todo lugar:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
ProviderScope(
  retry: (retryCount, error) => null, // never retry
  child: MyApp(),
)
```

Todo o resto neste post e sobre por que a nova tentativa existe, quando o padrao realmente esta ajudando voce e como limita-lo em vez de mata-lo por completo.

## Por que um provider que antes falhava uma vez agora falha dez vezes

No Riverpod 2.x, um provider cujo `build` lancava uma excecao ia direto para `AsyncError` e permanecia la ate que algo o invalidasse. Uma falha, um estado de erro. Previsivel.

O Riverpod 3.0 mudou esse padrao. O raciocinio faz sentido: muitas falhas de provider sao transitorias. Um `FutureProvider` que chama um endpoint HTTP falha porque a rede teve uma instabilidade, nao porque o codigo esta errado. Tentar de novo com backoff significa que a interface se recupera sozinha em vez de ficar parada em uma tela de erro que uma atualizacao manual teria resolvido. A documentacao oficial descreve o padrao como tentar novamente "up to 10 times, with an exponential backoff going from 200ms to 6.4 seconds."

O problema e que esse comportamento e invisivel ate te morder. Um provider que falha de forma deterministica, digamos porque analisa uma resposta malformada ou atinge um 404 que nunca vai virar um 200, agora queima todas as 10 tentativas antes de assentar em um estado de erro. Durante essas tentativas seu spinner de carregamento continua girando, seus logs se enchem com o mesmo stack trace dez vezes, e qualquer efeito colateral dentro do `build` (um evento de analytics, uma linha de log, o incremento de um contador) dispara dez vezes em vez de uma. Em testes e pior: um provider que deveria falhar rapido em vez disso trava enquanto o cronograma de novas tentativas se desenrola, e seu teste estoura o tempo limite.

## Reproduzindo a tempestade de novas tentativas

Aqui esta o menor provider que mostra o comportamento. Ele lanca incondicionalmente e registra cada vez que o `build` roda.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
import 'package:flutter_riverpod/flutter_riverpod.dart';

int _attempts = 0;

final brokenProvider = FutureProvider<int>((ref) async {
  _attempts++;
  print('build attempt #$_attempts');
  throw StateError('this will never succeed');
});
```

Observe a partir de um widget:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
class Screen extends ConsumerWidget {
  const Screen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(brokenProvider);
    return value.when(
      data: (n) => Text('$n'),
      loading: () => const CircularProgressIndicator(),
      error: (e, _) => Text('failed: $e'),
    );
  }
}
```

No Riverpod 2.x o console imprime `build attempt #1` uma vez e o widget mostra o erro imediatamente. No Riverpod 3.0 o console imprime dez tentativas espalhadas por aproximadamente 13 segundos (200ms + 400ms + 800ms + ... ate 6,4s), e o spinner permanece na tela o tempo todo antes de o erro finalmente ser renderizado. Esse intervalo de 13 segundos entre "a requisicao falhou" e "o usuario ve um erro" e a surpresa que a maioria das equipes encontra primeiro.

## O callback de retry, e como retornar null o desativa

Todo hook de retry no Riverpod 3.0 tem o mesmo formato. Ele recebe a contagem atual de novas tentativas e o erro, e retorna um `Duration?`. Retorne uma duracao para esperar esse tempo e tentar de novo; retorne `null` para desistir e expor o erro.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
Duration? myRetry(int retryCount, Object error) {
  if (retryCount >= 5) return null;                       // cap attempts
  if (error is ProviderException) return null;            // don't retry wrapped deps
  return Duration(milliseconds: 200 * (1 << retryCount)); // 200ms, 400ms, 800ms...
}
```

`1 << retryCount` e apenas `2^retryCount`, entao isso reproduz a curva exponencial embutida. Para desativar a nova tentativa por completo, a funcao inteira se reduz a uma linha que ignora seus argumentos e sempre retorna `null`.

### Desligue para o app inteiro

`ProviderScope` e o widget que hospeda o estado dos seus providers em um app Flutter. Da a ele um `retry` e todo provider abaixo dele herda a politica, a menos que a sobrescreva.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
void main() {
  runApp(
    ProviderScope(
      retry: (retryCount, error) => null,
      child: const MyApp(),
    ),
  );
}
```

Em Dart puro, ou em qualquer lugar onde voce cria um container manualmente, o mesmo parametro fica no `ProviderContainer`:

```dart
// Dart 3.x, riverpod 3.x
final container = ProviderContainer(
  retry: (retryCount, error) => null,
);
```

### Desligue para um unico provider

Desligar globalmente e um instrumento tosco. Normalmente voce quer a nova tentativa para os dois providers de rede onde ela ajuda e desligada para o provider que analisa a configuracao local e so pode falhar por causa de um bug. Todo construtor de provider recebe seu proprio parametro `retry`, e um valor por provider vence o valor no nivel do escopo.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
final configProvider = FutureProvider<AppConfig>(
  (ref) async => AppConfig.fromAsset(await rootBundle.loadString('config.json')),
  retry: (retryCount, error) => null, // parsing bugs won't fix themselves
);
```

O mesmo parametro existe nos providers baseados em classe. Para um `NotifierProvider` ou `AsyncNotifierProvider`, ele fica ao lado do tear-off do construtor:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
final todoListProvider = NotifierProvider<TodoList, List<Todo>>(
  TodoList.new,
  retry: (retryCount, error) => null,
);
```

### Desligue em providers gerados por codigo

Se voce usa `riverpod_generator`, a anotacao carrega um argumento `retry`. Aponte-o para uma funcao nomeada para que o provider gerado a utilize.

```dart
// Flutter 3.44, Dart 3.x, riverpod_annotation 3.x
Duration? noRetry(int retryCount, Object error) => null;

@Riverpod(retry: noRetry)
Future<int> counter(Ref ref) async {
  throw StateError('fails once, stays failed');
}
```

Rode `dart run build_runner build` depois de mudar a anotacao. O `counterProvider` gerado agora carrega a politica de nao tentar novamente, e voce nunca toca no arquivo gerado.

## O que o padrao ja pula

Antes de desativar a nova tentativa globalmente, saiba que o padrao nao e tao agressivo quanto "tentar tudo dez vezes." Duas categorias sao excluidas de fabrica.

`Error` (ao contrario de `Exception`) nunca e tentado de novo. Em Dart, `Error` sinaliza um erro de programacao: uma assercao que falhou, uma verificacao de null em um valor null, um cast ruim. Esses nao sao recuperaveis esperando, entao o Riverpod os expoe imediatamente. Se seu provider lanca `StateError` ou `TypeError`, a nova tentativa padrao nao entra em acao. O `brokenProvider` acima lanca `StateError`, que e um subtipo de `Error`, entao numa leitura estrita ele apareceria imediatamente; troque-o por uma `Exception` comum se voce quiser ver a tempestade completa de dez tentativas no console.

`ProviderException` tambem e pulada. Quando o provider A le o provider B e B falhou, o Riverpod envolve a falha de B em uma `ProviderException` antes que ela chegue ao A. Tentar A novamente seria inutil porque o proprio A esta bem; e o B que precisa se recuperar. A nova tentativa padrao reconhece esse involucro e nao o tenta de novo, o que evita uma cascata em que todo provider em uma cadeia de dependencias roda seu proprio cronograma de novas tentativas. Se voce ja se perguntou por que o tipo do involucro importa, e a mesma `ProviderException` por tras do `try`/`catch` quebrado quando [o Riverpod 3.0 lanca ProviderException em vez do seu erro original](/pt-br/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/).

Entao "desativar a nova tentativa" na pratica significa "parar de tentar novamente `Exception`s recuperaveis." Erros e falhas de dependencia ja estavam aparecendo imediatamente.

## Limitando a nova tentativa em vez de mata-la

Desativar a nova tentativa e a decisao certa para providers que carregam dados locais, analisam assets ou realizam qualquer operacao onde a falha significa um bug em vez de um solucao. Mas para I/O genuinamente instavel, uma nova tentativa limitada e melhor do que nenhuma. O padrao e: limite as tentativas a um numero baixo, pule os erros que voce sabe que sao permanentes e mantenha um backoff curto.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
Duration? networkRetry(int retryCount, Object error) {
  // Give up after 3 tries.
  if (retryCount >= 3) return null;
  // A 404 will not become a 200 by waiting.
  if (error is NotFoundException) return null;
  // Otherwise back off: 300ms, 600ms, 1.2s.
  return Duration(milliseconds: 300 * (1 << retryCount));
}

final userProvider = FutureProvider<User>(
  (ref) => api.fetchUser(),
  retry: networkRetry,
);
```

Tres tentativas ao longo de cerca de dois segundos geralmente sao suficientes para superar uma falha transitoria sem fazer o usuario encarar um spinner por 13 segundos. O padrao de 10 tentativas e ajustado para resiliencia em vez de responsividade; a maioria dos apps quer a troca oposta para providers voltados ao usuario.

## Desative a nova tentativa em todos os testes

Esta e a mudanca que a maioria das equipes esquece, e ela produz o sintoma mais confuso: um teste que costumava validar um estado de erro agora estoura o tempo limite. Um `ProviderContainer` criado da forma normal herda a nova tentativa padrao, entao um provider que voce *quer* que falhe passa 13 segundos tentando de novo antes que seu `expect` sobre o erro chegue a rodar.

O Riverpod 3.0 vem com `ProviderContainer.test`, um construtor que adiciona descarte automatico para testes, e voce deveria passar a ele um retry no-op.

```dart
// Dart 3.x, riverpod 3.x, flutter_test
import 'package:flutter_test/flutter_test.dart';
import 'package:riverpod/riverpod.dart';

void main() {
  test('brokenProvider surfaces its error immediately', () async {
    final container = ProviderContainer.test(
      retry: (retryCount, error) => null,
    );

    await expectLater(
      container.read(brokenProvider.future),
      throwsA(isA<StateError>()),
    );
  });
}
```

Sem a sobrescrita de `retry` este teste acabaria passando, mas apenas depois do cronograma completo de novas tentativas, o que ou estoura o tempo limite do seu teste ou faz a suite se arrastar. Defina o retry no-op em um helper de teste compartilhado para que todo container o receba por padrao e ninguem precise lembrar.

## A pegadinha com efeitos colaterais no build

A razao pela qual a nova tentativa vale a pena entender em vez de desativar cegamente e que os metodos `build` de provider nao deveriam ter efeitos colaterais visiveis externamente, mas na pratica frequentemente tem. Se o seu `build` registra em analytics, incrementa uma metrica ou escreve em um cache antes de lancar, cada nova tentativa repete esse efeito colateral. Dez tentativas significam dez eventos de analytics para uma unica falha logica. Limitar a nova tentativa a uma contagem baixa, ou desativa-la em providers cujo `build` nao e idempotente, mantem sua telemetria honesta. Se voce esta buscando estado depois de um `await` dentro desses metodos, a mesma disciplina que faz voce [verificar Ref.mounted apos um gap assincrono](/pt-br/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/) se aplica a providers com muitas novas tentativas, porque uma nova tentativa roda o corpo assincrono inteiro de novo.

Mais uma sutileza: as contagens de novas tentativas sao zeradas quando o provider e invalidado e recompilado do zero. O orcamento de 10 tentativas e por sequencia continua de falhas, nao por sessao do app. Um provider que falha, esgota suas novas tentativas, e invalidado por um pull-to-refresh e falha de novo comeca um novo orcamento de 10 tentativas. Se voce conta com a nova tentativa para eventualmente parar, certifique-se de que a invalidacao nao esteja silenciosamente zerando-a.

## Escolhendo o seu padrao

Para um novo app Riverpod 3.0, a configuracao pragmatica e: mantenha uma nova tentativa limitada e curta no nivel do `ProviderScope` para o caso comum, e sobrescreva providers individuais para `null` onde a nova tentativa nao pode ajudar. Isso te da resiliencia nas leituras de rede sem o spinner de 13 segundos em falhas deterministicas.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
ProviderScope(
  retry: (retryCount, error) {
    if (retryCount >= 2) return null; // app-wide default: 3 attempts max
    return Duration(milliseconds: 300 * (1 << retryCount));
  },
  child: const MyApp(),
)
```

Se voce esta vindo do Riverpod 2.x e quer o antigo comportamento de "falha uma vez, permanece falho" em todo lugar enquanto avalia o recurso, o `retry: (_, __) => null` global e o ponto de partida honesto. Ligue-o de volta por provider assim que souber quais realmente se beneficiam. As notas de migracao cobrem o resto do que mudou junto com a nova tentativa na [atualizacao do Riverpod 2.x para o 3.0](/pt-br/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/), e se voce ainda esta decidindo se o Riverpod e a ferramenta certa afinal, a [comparacao entre Provider, Riverpod e Bloc](/pt-br/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) coloca isso em contexto. Para o lado de renderizacao de carregamento e erro dos mesmos providers, veja como [mostrar estados de carregamento e erro com AsyncValue](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## Fontes

- [Automatic retry](https://riverpod.dev/docs/concepts2/retry) - documentacao do Riverpod sobre a assinatura do callback de retry, os padroes e a configuracao por provider.
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) - o anuncio do recurso de retry e o comportamento de backoff padrao.
- [Migrating from 2.0 to 3.0](https://riverpod.dev/docs/3.0_migration) - orientacao de migracao incluindo `ProviderContainer.test`.
- [riverpod changelog](https://pub.dev/packages/riverpod/changelog) - historico de versoes para a linha 3.x.
