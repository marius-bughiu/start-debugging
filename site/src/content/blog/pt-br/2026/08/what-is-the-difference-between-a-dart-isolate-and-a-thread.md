---
title: "Qual é a diferença entre um isolate de Dart e uma thread?"
description: "Uma thread compartilha memória com todas as outras threads do processo. Um isolate de Dart não: ele é dono do próprio heap, roda um único event loop e só conversa com outros isolates por mensagens. Veja o que isso significa no nível da VM, onde os isolate groups borram essa linha e como isso aparece no Flutter, no FFI e na web."
pubDate: 2026-08-29
tags:
  - "dart"
  - "flutter"
  - "isolates"
  - "concurrency"
  - "threading"
lang: "pt-br"
translationOf: "2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread"
translatedBy: "claude"
translationDate: 2026-08-29
---

Uma thread é um contexto de execução que compartilha o heap do processo com todas as outras threads, e é por isso que código com threads precisa de locks, atômicos e barreiras de memória. Um isolate de Dart é um contexto de execução que é dono da própria memória e roda um único event loop, e a única forma de alcançar outro isolate é enviando uma mensagem por uma porta. A consequência prática é que Dart não tem palavra-chave `lock`, não tem `volatile` e não tem condição de corrida sobre objetos Dart, e o preço é que tudo o que você entrega a outro isolate é copiado, a não ser que você use uma de duas saídas de emergência. Os isolates rodam sim sobre threads reais do sistema operacional, tiradas de um pool que a VM administra, mas o mapeamento não é um para um e você nunca programa contra ele. Tudo abaixo tem como alvo o Dart 3.12.2 e o Flutter 3.44.7.

Se você chegou aqui porque um cálculo está congelando sua UI e quer o código que resolve isso, a mecânica está no guia sobre [escrever um isolate de Dart para trabalho intensivo de CPU](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/). Este artigo é sobre o modelo por baixo, porque a maioria dos bugs com isolates é, na verdade, um modelo mental errado sobre o que é um isolate.

## O modelo: um heap e um event loop por isolate

A documentação da linguagem Dart resume em uma frase: "isolates são como threads ou processos, mas cada isolate tem a própria memória e uma única thread rodando um event loop". Há duas afirmações ali, e as duas importam.

Memória própria significa que cada isolate tem a própria cópia de cada campo global e estático. Um `int requestCount = 0` de nível superior não é uma variável no seu programa, é uma variável por isolate. Mutá-la em um worker deixa a cópia do isolate principal intacta, porque, como diz a documentação, "cada isolate tem os próprios campos globais, garantindo que nenhum estado de um isolate seja acessível a partir de qualquer outro isolate".

Um event loop significa que um isolate processa eventos um de cada vez, para sempre, em um laço que conceitualmente se parece com isto:

```dart
// The Dart event loop, conceptually. Dart 3.12.
while (eventQueue.waitForEvent()) {
  eventQueue.processNextEvent();
}
```

Nada interrompe um evento depois que ele começa. Um callback que gasta 90 ms fazendo parse de JSON segura o loop por 90 ms, e cada timer, cada future concluído e, no Flutter, cada frame esperam atrás dele. É o oposto de uma thread, que o escalonador do sistema operacional pode suspender no meio de uma instrução para outra thread rodar.

Junte as duas coisas e você tem o modelo de atores: estado isolado, processamento sequencial, troca de mensagens. Como afirma a documentação, "não haver estado compartilhado entre isolates significa que complexidades de concorrência como mutexes, locks e corridas de dados não vão acontecer".

## A condição de corrida que você não consegue escrever em Dart

Essa é a forma mais clara de sentir a diferença. Em C# o código a seguir é uma corrida de verdade, e corrigi-la exige `Interlocked` ou um lock:

```csharp
// C# 14, .NET 11. Two threads, one heap, one bug.
static int _counter;

var t1 = new Thread(() => { for (var i = 0; i < 100_000; i++) _counter++; });
var t2 = new Thread(() => { for (var i = 0; i < 100_000; i++) _counter++; });
t1.Start(); t2.Start(); t1.Join(); t2.Join();
Console.WriteLine(_counter); // Not 200000. Ever, reliably.
```

A tradução para Dart não tem corrida, e também não faz o que quem está chegando espera:

```dart
// Dart 3.12.
import 'dart:isolate';

int counter = 0; // one copy per isolate, not one per program

void bump(int times) {
  for (var i = 0; i < times; i++) {
    counter++;
  }
}

Future<void> main() async {
  await Future.wait([
    Isolate.run(() { bump(100000); return counter; }),
    Isolate.run(() { bump(100000); return counter; }),
  ]);
  print(counter); // 0
}
```

Cada isolate criado incrementa o próprio `counter` até 100000 e depois morre com ele. O isolate principal imprime `0`. Não há leitura corrompida para caçar nem lock para adicionar, porque nunca existiu uma variável única em disputa. Todo valor que precisa voltar tem que voltar como mensagem, que é exatamente o que o valor de retorno de `Isolate.run` é.

## O que realmente roda um isolate: o pool de threads da VM

Isolates não flutuam soltos. A VM do Dart os executa sobre threads do sistema operacional, e as regras dessa relação estão documentadas no texto sobre os internos da VM do Dart, de Vyacheslav Egorov.

Uma thread do sistema operacional "só pode entrar em um isolate por vez. Ela precisa deixar o isolate atual se quiser entrar em outro isolate". E no sentido contrário, "só pode existir uma única thread mutadora associada a um isolate por vez. A thread mutadora é a thread que executa código Dart e usa a API C pública da VM".

Ou seja, a invariante é um de cada vez nas duas direções, não um para um para sempre. Threads diferentes do sistema operacional podem executar o mesmo isolate em momentos diferentes, e uma thread pode servir vários isolates ao longo da vida dela. A VM não dedica uma thread a um isolate do jeito que `new Thread()` dedica uma a um delegate: "internamente a VM usa um pool de threads para gerenciar as threads do sistema operacional e o código é estruturado em torno do conceito de ThreadPool::Task e não do conceito de thread do sistema operacional". Trabalho de fundo, como garbage collection e compilação JIT, é postado nesse pool como tarefas.

A lição para o seu código é que isolates são a unidade sobre a qual você raciocina e threads são um detalhe de implementação por baixo. Você não consegue fixar um isolate em um núcleo, não consegue passar um isolate para uma API nativa que espera um handle de thread e não deve supor que a identidade da thread do sistema operacional do seu isolate seja estável entre pontos de suspensão.

## Isolate groups: o heap compartilhado que a linguagem esconde de você

É aqui que "cada isolate tem a própria memória" deixa de ser literalmente verdade no nível da implementação, e vale a pena saber porque isso explica os números de performance.

Desde o Dart 2.15 a VM organiza os isolates em isolate groups. `Isolate.spawn` e `Isolate.run` criam o novo isolate dentro do grupo atual; só `Isolate.spawnUri` inicia um grupo novo com uma cópia nova do programa. Dentro de um grupo, a VM compartilha as estruturas do programa e, como diz o documento sobre os internos da VM, os isolates de um grupo "compartilham o mesmo heap gerenciado pelo garbage collector".

O anúncio do Dart 2.15 quantifica o que isso trouxe: iniciar um isolate adicional em um grupo existente é "mais de 100 vezes mais rápido", e esses isolates "consomem entre 10 e 100 vezes menos memória" do que antes de os grupos existirem. É por isso que `spawnUri` é o caminho lento e `spawn` é o que você usa.

A garantia no nível da linguagem não muda. Você continua sem conseguir alcançar os objetos de outro isolate, o isolamento é aplicado acima do heap e o heap compartilhado é um detalhe de implementação. Mas é o motivo de outras duas coisas serem possíveis.

## Copiar é o preço, e há duas saídas

Por padrão, enviar um objeto por um `SendPort` copia o grafo de objetos inteiro. Envie um `Map` com 50000 entradas e o isolate receptor recebe uma cópia profunda, e mutá-la lá é invisível para quem enviou. A maior parte dos objetos Dart pode ser enviada. As exceções documentadas são objetos apoiados em recursos nativos, como `Socket`, além de `ReceivePort`, `DynamicLibrary`, `Finalizable`, `Finalizer`, `NativeFinalizer`, `Pointer`, `UserTag` e qualquer coisa anotada com `@pragma('vm:isolate-unsendable')`. Fora essas, diz a documentação, "qualquer objeto pode ser enviado".

A primeira saída é `Isolate.exit`. Ela "termina o isolate atual de forma síncrona" e entrega uma mensagem final e, como emissor e receptor estão no mesmo grupo e portanto no mesmo heap, "esse grafo de objetos da mensagem final será reatribuído ao isolate receptor sem cópia". Sem cópia, ao custo de o isolate terminar ali mesmo: blocos `finally` pendentes não rodam e trabalho assíncrono enfileirado nunca roda.

Na maior parte das vezes você ganha isso de graça. `Isolate.run`, adicionado no Dart 2.19, é implementado sobre `Isolate.spawn` mais `Isolate.exit` justamente para o resultado voltar sem cópia:

```dart
// Dart 3.12. One-shot work, result transferred rather than copied.
final parsed = await Isolate.run(() {
  final text = File('bulk.json').readAsStringSync();
  return jsonDecode(text) as Map<String, dynamic>;
});
```

A segunda saída é `TransferableTypedData`, que move a posse de um buffer de bytes entre isolates sem copiá-lo. Use quando a carga é de bytes (uma imagem, um arquivo baixado, um buffer de áudio decodificado) e não um grafo de objetos.

Se você se pegar enviando resultados grandes repetidamente, note o trade-off que o próprio guia do Flutter explicita: "existe uma sobrecarga de performance para criar novos isolates e para copiar objetos de um isolate para outro. Se você faz o mesmo cálculo com `Isolate.run` repetidamente, talvez tenha performance melhor criando isolates que não terminam imediatamente".

## async/await também não é uma thread

O mal-entendido mais comum da vizinhança é achar que `await` tira o trabalho do isolate atual. Não tira. `Future`, `Stream` e `await` são construções de agendamento sobre o único event loop do isolate em que você já está. Aguardar a leitura de um socket devolve o loop enquanto o sistema operacional faz a E/S, e é por isso que o assíncrono basta para trabalho de rede e de arquivos. Aguardar uma função que gasta 200 ms em um laço apertado não devolve nada, porque não existe ponto de suspensão dentro dela.

A regra é curta. Assincronia é para esperar; isolates são para calcular. Se a coisa cara é trabalho síncrono de CPU, só um isolate tira isso do loop. Se você vai ligar o resultado de volta nos widgets, a [comparação entre FutureBuilder, StreamBuilder e AsyncValue do Riverpod](/pt-br/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) cobre com qual primitiva assíncrona expor isso.

## Onde o modelo de threads aparece no Flutter

O Flutter roda seu app no isolate principal, também chamado de isolate raiz. Como diz a documentação do Flutter, "apps Flutter fazem todo o trabalho em um único isolate, o isolate principal", e "todas as tarefas de UI e o próprio Flutter estão acoplados ao isolate principal".

Por baixo, o engine realmente usa várias threads do sistema operacional para rasterização, E/S e trabalho de plataforma, e o arranjo delas mudou recentemente: a partir do Flutter 3.29, "as threads de UI e de plataforma são fundidas no iOS e no Android. Especificamente, a thread de UI é removida e o código Dart roda na thread nativa da plataforma". Essa é uma mudança de threads sem equivalente no nível de isolate, o que ilustra bem as duas camadas serem independentes. Seu código Dart não mudou de isolate, mudou de thread do sistema operacional, e nada no modelo de isolates percebeu.

Duas consequências mordem em isolates de fundo:

- Nada de UI e nada de assets. "Você não pode acessar assets usando `rootBundle` em isolates criados, nem realizar qualquer trabalho de widget ou de UI em isolates criados". Qualquer objeto de `dart:ui` pertence ao isolate principal.
- Platform channels precisam de bootstrap. Desde que os platform channels em isolates de fundo chegaram, um worker pode chamar Android ou iOS, mas só depois de se registrar no messenger do isolate raiz, e ainda assim ele "não pode receber mensagens não solicitadas da plataforma hospedeira".

```dart
// Dart 3.12, Flutter 3.44.7. Platform channels from a background isolate.
Future<void> _isolateMain(RootIsolateToken rootIsolateToken) async {
  BackgroundIsolateBinaryMessenger.ensureInitialized(rootIsolateToken);
  final prefs = await SharedPreferences.getInstance();
  // ... plugin calls now work here
}
```

Se você está atrás de frames perdidos e ainda não sabe se um isolate é a resposta, meça primeiro: o passo a passo sobre [perfilar jank com o DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) mostra como distinguir um callback síncrono longo de um problema de layout ou de rasterização, e os dois têm correções completamente diferentes. Quando o trabalho acaba pertencendo ao lado da plataforma, [adicionar código específico de plataforma sem escrever um plugin](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) é o caminho mais barato.

## FFI é onde você toca em threads de verdade

O único lugar em que a thread por baixo fica visível é o `dart:ffi`. Uma chamada FFI síncrona roda na thread do sistema operacional que no momento é a thread mutadora do isolate, e bloqueia essa thread e, portanto, o event loop do isolate até retornar. Chamadas nativas longas pertencem a um isolate worker exatamente pelo mesmo motivo que laços longos em Dart.

Callbacks no sentido contrário são limitados pela mesma regra de um isolate por thread, e é por isso que `NativeCallable` (Dart 3.1) tem variantes diferentes. `NativeCallable.isolateLocal` "precisa ser invocado a partir da mesma thread que o criou", enquanto `NativeCallable.listener` e `NativeCallable.isolateGroupBound` "podem ser invocados a partir de qualquer thread". Se uma biblioteca nativa te chama de volta a partir da própria thread de trabalho dela, `isolateLocal` é um crash esperando para acontecer e `listener` é o construtor que você quer.

## A web não tem nenhum dos dois

Na web não existem isolates. Dart compilado para JavaScript roda na única thread do navegador, então `compute` degrada com elegância em vez de paralelizar: "em plataformas web isso vai rodar o callback no event loop atual. Em plataformas nativas isso vai rodar o callback em um isolate separado". Web workers são a resposta do navegador, mas não são substituto direto, porque "você só consegue criar web workers declarando um entrypoint de programa separado e compilando-o separadamente", e eles copiam dados na fronteira sem as APIs de transferência que os isolates têm.

Se um caminho de código depende de paralelismo para o orçamento de frame estar correto, teste na web separadamente. Ele vai rodar, e vai travar.

## O que está mudando

O modelo estrito tem um custo conhecido: jogos, física e pipelines de imagem pagam por copiar dados que logicamente pertencem a um único cálculo. O time do Dart está explorando um relaxamento seletivo, acompanhado na issue guarda-chuva de multithreading com memória compartilhada no dart-lang/sdk, com uma proposta de linguagem de Vyacheslav Egorov. A primeira fase cobre memória nativa compartilhada, com isolates compartilhados, campos estáticos marcados com `@pragma('vm:shared')` para tipos trivialmente compartilháveis, e chamadas para dentro de um isolate group a partir de uma thread nativa arbitrária. `NativeCallable.isolateGroupBound` é a ponta visível desse trabalho.

Nada disso muda o modelo padrão e, no Dart 3.12, você deve tratar isso como experimental e ler a issue de acompanhamento antes de projetar em cima. A suposição segura para código de produção hoje continua sendo: isolates são donos do próprio estado, mensagens são cópias, e `Isolate.exit` mais `TransferableTypedData` são seus únicos caminhos sem cópia.

## Escolhendo o modelo mental certo

- Se você está procurando um lock, modelou o problema como threads. Em Dart não há nada para travar; reestruture como mensagem.
- Compartilhar um objeto grande entre dois isolates não é possível. Ou envie uma cópia, ou transfira uma vez com `Isolate.exit` ou `TransferableTypedData`, ou mantenha o objeto em um isolate e envie comandos para esse isolate.
- `await` nunca adiciona uma thread. Só isolates adicionam paralelismo, e só em targets nativos.
- Um worker de longa duração ganha de `Isolate.run` repetido quando você faz o mesmo cálculo muitas vezes, porque criar e copiar não são de graça.
- FFI, não Dart, é onde a identidade da thread importa. Escolha o construtor de `NativeCallable` que corresponde à thread de onde o lado nativo chama.

## Links de referência

- [Concurrency in Dart](https://dart.dev/language/concurrency)
- [Concurrency and isolates, documentação do Flutter](https://docs.flutter.dev/perf/isolates)
- [Introduction to Dart VM, internos de threads e isolates](https://mrale.ph/dartvm/)
- [Announcing Dart 2.15, isolate groups](https://dart.dev/blog/announcing-dart-2-15)
- [Better isolate management with Isolate.run](https://dart.dev/blog/better-isolate-management-with-isolate-run)
- [Referência da API de Isolate.exit](https://api.dart.dev/stable/dart-isolate/Isolate/exit.html)
- [Referência da API de NativeCallable](https://api.dart.dev/stable/dart-ffi/NativeCallable-class.html)
- [Flutter architectural overview](https://docs.flutter.dev/resources/architectural-overview)
- [Explore shared memory multithreading, dart-lang/sdk#55991](https://github.com/dart-lang/sdk/issues/55991)
