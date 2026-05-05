---
title: "Como escrever um isolate de Dart para trabalho intensivo de CPU"
description: "Quando async/await não basta: lance um isolate de Dart para rodar trabalho intensivo de CPU fora da thread de UI. Isolate.run, a função compute do Flutter, workers de longa duração com SendPort/ReceivePort, o que pode atravessar a fronteira e o detalhe sobre JS/web. Testado em Dart 3.11 e Flutter 3.27.1."
pubDate: 2026-05-05
tags:
  - "dart"
  - "flutter"
  - "isolates"
  - "concurrency"
  - "performance"
  - "how-to"
lang: "pt-br"
translationOf: "2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work"
translatedBy: "claude"
translationDate: 2026-05-05
---

Resposta curta: para uma computação única, chame `await Isolate.run(myFunction)` (Dart 2.19+) ou `await compute(myFunction, arg)` no Flutter. Para um worker que atende várias requisições, use `Isolate.spawn` com um `ReceivePort` em cada lado e canalize as mensagens por um `SendPort`. A função que você passa para o isolate deve ser de nível superior ou `static`, a mensagem e o resultado devem ser enviáveis, e na web `compute` roda no event loop porque o dart2js não tem isolates de verdade. Testado em Dart 3.11 e Flutter 3.27.1 com Android Gradle Plugin 8.7.3.

Assincronia em Dart não é paralelismo. `Future`, `await` e `Stream` agendam trabalho no mesmo event loop de thread única em que sua UI roda. Se um passo síncrono dentro desse future gasta 80 ms parseando um documento JSON de 4 MB ou calculando o hash de um arquivo, o loop bloqueia por 80 ms, a GPU perde dois frames a 60 fps e `Skipped 5 frames!` aparece nos logs. Um isolate é a forma do Dart escapar da thread única: uma heap separada da VM com seu próprio event loop, seu próprio coletor de lixo e sem memória compartilhada com o isolate chamador. Você move o trabalho para lá, recebe a resposta de volta e a thread de UI continua desenhando.

## Quando um isolate é a ferramenta certa

A operação cara precisa ser **trabalho de CPU síncrono**, não uma chamada de rede longa. Embrulhar `http.get` em um isolate não te dá nada porque `http.get` já é assíncrono e cede ao event loop enquanto espera o socket. Candidatos reais:

- Parsing de um payload JSON acima de ~1 MB. `jsonDecode` é síncrono e escala linearmente com o tamanho do payload.
- Decodificação e redimensionamento de imagens com `package:image`. Dart puro, sem plugin de plataforma, e um JPEG de 12 MP leva centenas de milissegundos.
- Hashing criptográfico de um arquivo (SHA-256 sobre uma stream com buffer, BCrypt para verificação de senha).
- Regex sobre um documento grande, especialmente com `multiline: true` e lookbehinds.
- Compressão / descompressão com `package:archive`.
- Trabalho numérico: multiplicação de matrizes para um modelo de ML pequeno, FFT, convolução de kernel de imagem.

Se você não consegue apontar um stack frame que roda síncronamente por mais de ~16 ms (o orçamento de um frame a 60 fps), um isolate não vai ajudar. Faça profile com o CPU profiler do Flutter DevTools primeiro; a timeline da "UI thread" é a que importa olhar.

## O caminho mais barato: Isolate.run

`Isolate.run<R>(FutureOr<R> Function() computation, {String? debugName})` foi adicionado no Dart 2.19 e é a API que a documentação recomenda em 2026. Ele lança um isolate, executa o callback, devolve o resultado sem cópia na VM e desmonta o isolate.

```dart
// Dart 3.11
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

Future<List<dynamic>> parseLargeJson(File file) async {
  final text = await file.readAsString();
  return Isolate.run(() => jsonDecode(text) as List<dynamic>);
}
```

Duas coisas estão acontecendo aqui. Primeira, a leitura do arquivo permanece no isolate chamador porque `readAsString` já é assíncrono e não bloqueia o event loop. Segunda, `jsonDecode` roda em um isolate novo e a `List<dynamic>` resultante volta atravessando a fronteira. Lançar um isolate custa cerca de 1 a 3 ms em um celular moderno, então só vale a pena quando o trabalho em si é pelo menos dez vezes isso.

Um erro comum é passar uma closure que captura o escopo ao redor:

```dart
// Dart 3.11 - works, but copies state you did not intend to send
Future<int> countWordsBuggy(String text, Set<String> stopWords) async {
  return Isolate.run(() {
    return text
        .split(RegExp(r'\s+'))
        .where((w) => !stopWords.contains(w))
        .length;
  });
}
```

A closure captura `text` e `stopWords`, então ambos são copiados para o novo isolate. Tudo bem para entradas pequenas, mas se `text` tem 50 MB você acabou de pagar 50 MB de alocação e um passe de serialização. Pior: se o estado capturado contém um objeto não enviável (um `Socket` aberto, uma `DynamicLibrary`, um `ReceivePort`, qualquer coisa marcada com `@pragma('vm:isolate-unsendable')`) você vai receber um `ArgumentError` em runtime na chamada de spawn. A correção é manter o estado capturado mínimo, ou amarrar um ponto de entrada de nível superior e passar os argumentos explicitamente.

## A função compute do Flutter, e o que ela é de verdade

`compute<M, R>(ComputeCallback<M, R> callback, M message)` de `package:flutter/foundation.dart` é anterior a `Isolate.run` e ainda é a API mais citada em tutoriais de Flutter. A partir do Flutter 3.27.1 ela é documentada como equivalente a `Isolate.run(() => callback(message))` em plataformas nativas. No target web ela roda o callback síncronamente no mesmo event loop porque dart2js compila para JavaScript e não há isolates de verdade no navegador; você não vai obter paralelismo na web independentemente de qual API chamar.

```dart
// Flutter 3.27.1, Dart 3.11
import 'package:flutter/foundation.dart';

List<Person> _parsePeople(String body) {
  final raw = jsonDecode(body) as List<dynamic>;
  return raw.cast<Map<String, dynamic>>().map(Person.fromJson).toList();
}

Future<List<Person>> fetchPeople(http.Client client) async {
  final res = await client.get(Uri.parse('https://api.example.com/people'));
  return compute(_parsePeople, res.body);
}
```

`_parsePeople` é uma função de nível superior, não uma closure nem um método. Essa é a regra que mais pega gente: o callback que você passa para `compute` (ou para `Isolate.spawn`) precisa ser uma função de nível superior ou `static` para que somente a identidade dele seja enviada, não o escopo envolvente. Se você escrever `compute(this._parsePeople, body)` cai na mesma armadilha de captura de closure de antes, e ainda pode terminar tentando enviar a árvore de widgets envolvente inteira.

## Workers de longa duração: Isolate.spawn com portas bidirecionais

`Isolate.run` é de uso único. Se você quer um worker que atende várias requisições (um índice de busca que carrega 200 MB uma vez e depois responde 50 consultas) você precisa de `Isolate.spawn` mais seu próprio protocolo em cima de `SendPort` / `ReceivePort`.

O padrão é simétrico: cada lado abre um `ReceivePort` e envia o `SendPort` correspondente para o outro lado, e então ambos os lados conversam por essas portas.

```dart
// Dart 3.11
import 'dart:async';
import 'dart:isolate';

class SearchWorker {
  late final SendPort _toWorker;
  late final ReceivePort _fromWorker;
  final Map<int, Completer<List<int>>> _pending = {};
  int _nextId = 0;

  static Future<SearchWorker> start(List<String> corpus) async {
    final fromWorker = ReceivePort('search.fromWorker');
    await Isolate.spawn(_entry, [fromWorker.sendPort, corpus],
        debugName: 'search-worker');
    final ready = Completer<SendPort>();
    final iter = StreamIterator(fromWorker);
    if (await iter.moveNext()) ready.complete(iter.current as SendPort);

    final w = SearchWorker._();
    w._toWorker = await ready.future;
    w._fromWorker = fromWorker;
    fromWorker.listen(w._onMessage);
    return w;
  }

  SearchWorker._();

  Future<List<int>> query(String term) {
    final id = _nextId++;
    final c = Completer<List<int>>();
    _pending[id] = c;
    _toWorker.send([id, term]);
    return c.future;
  }

  void _onMessage(dynamic msg) {
    final list = msg as List;
    final id = list[0] as int;
    final hits = (list[1] as List).cast<int>();
    _pending.remove(id)?.complete(hits);
  }

  void dispose() {
    _toWorker.send(null); // sentinel
    _fromWorker.close();
  }
}

void _entry(List args) async {
  final replyTo = args[0] as SendPort;
  final corpus = (args[1] as List).cast<String>();
  final inbound = ReceivePort('search.inbound');
  replyTo.send(inbound.sendPort);

  await for (final msg in inbound) {
    if (msg == null) {
      inbound.close();
      break;
    }
    final list = msg as List;
    final id = list[0] as int;
    final term = (list[1] as String).toLowerCase();
    final hits = <int>[];
    for (var i = 0; i < corpus.length; i++) {
      if (corpus[i].toLowerCase().contains(term)) hits.add(i);
    }
    replyTo.send([id, hits]);
  }
  Isolate.exit();
}
```

Vale destacar algumas coisas. O handshake (o worker cria um `ReceivePort` de entrada, manda seu `SendPort` de volta pela porta que o host deu) é boilerplate, mas é inevitável: não existe um registro global de portas de isolates. O mapa `_pending` mais um id monotônico é o que permite ter várias consultas em voo; sem ids só dá para serializar as requisições. O `null` sentinela desliga o worker de forma limpa, e `Isolate.exit()` é mais rápido do que deixar `main` retornar porque envia a última mensagem sem copiar.

Se você quer semântica de pause / resume ou kill, capture o `Isolate` retornado por `Isolate.spawn` e chame `isolate.kill(priority: Isolate.immediate)`. Saiba que `kill` não roda os finalizers no worker, então qualquer arquivo aberto ou handle de banco de dados que o worker estivesse segurando vai vazar até o fim do processo.

## O que pode atravessar a fronteira

A maioria dos objetos Dart pode ser enviada. As exceções, a partir do Dart 3.11, são:

- Objetos com recursos nativos: `Socket`, `RawSocket`, `RandomAccessFile`, `Process`.
- `ReceivePort`, `RawReceivePort`, `DynamicLibrary`, `Pointer`, todos os finalizers de `dart:ffi`.
- Qualquer coisa anotada com `@pragma('vm:isolate-unsendable')`.
- Closures que capturam estado não enviável. A captura é checada de forma transitiva, então uma closure que referencia uma instância de classe que tem um campo `Socket` também é não enviável.

Tipos enviáveis incluem todos os primitivos, `String`, `Uint8List` e as outras listas tipadas, `List`, `Map`, `Set`, `DateTime`, `Duration`, `BigInt`, `RegExp`, e qualquer instância de classe cujos campos sejam, eles mesmos, enviáveis. Enviar um buffer de typed-data o copia através da heap, a menos que você o envolva em um `TransferableTypedData`, que dá uma entrega de zero-cópia:

```dart
// Dart 3.11
import 'dart:typed_data';
import 'dart:isolate';

Future<int> sumBytes(Uint8List bytes) async {
  final transferable = TransferableTypedData.fromList([bytes]);
  return Isolate.run(() {
    final view = transferable.materialize().asUint8List();
    var sum = 0;
    for (final b in view) {
      sum += b;
    }
    return sum;
  });
}
```

`materialize()` é de uso único por `TransferableTypedData`, então o remetente perde acesso ao buffer assim que o worker o materializa. Esse é o ponto: a memória é movida, não duplicada. Para payloads acima de alguns megabytes, a diferença entre `TransferableTypedData` e uma cópia comum é a diferença entre 1 ms e 30 ms.

## Armadilhas que pegam todos os times

**Closures capturam mais do que você imagina.** Até uma closure vazia dentro de um método captura `this`. Se `this` é o state de um `StatefulWidget`, você acabou de prender toda a subárvore de widgets na heap do worker até a chamada terminar. Sempre puxe os dados de que precisa para variáveis locais e passe-os como argumentos para uma função de nível superior.

**Lançar um isolate não é de graça.** Um `Isolate.run` cru com um callback no-op custa cerca de 2 ms num Pixel 7 e de 4 a 6 ms num dispositivo Android mais antigo. Se você se vê chamando `compute` 60 vezes por segundo para processar taps, você escreveu seu próprio gargalo. Ou faça batch do trabalho, ou construa um worker de longa duração.

**O target web é uma mentira para paralelismo.** `compute` e `Isolate.run` ambos caem em executar no event loop atual na web, porque Dart compilado para JavaScript roda em uma única thread do navegador. Se paralelismo na web importa, você precisa de um Web Worker de verdade, escrito separadamente, com seu próprio protocolo de mensagens. Há trabalho em andamento no suporte a workers de `dart:js_interop`, mas a partir do Dart 3.11 ele não é um substituto direto para `Isolate.run`.

**`debugPrint` de um worker pode se intercalar.** Cada isolate tem seu próprio pipeline de `print`. No Android a ordem no `logcat` é best-effort. Se você está debugando uma condição de corrida, anexe um número de sequência a cada linha de log no worker para que você possa reordenar offline.

**Não compartilhe estado por referência.** Um padrão comum de bug é assumir que um `Map` enviado para um isolate é "o mesmo" mapa. Não é; o worker recebeu uma cópia profunda. Mutá-lo no worker não tem efeito no chamador. Trate cada fronteira de isolate como uma fronteira de serialização.

## Como isso se encaixa no resto do seu pipeline Flutter

Para projetos Flutter especificamente, as peças ao redor importam tanto quanto o isolate em si. Faça profile do custo de cold-start no DevTools antes de partir para spawn, já que o trabalho do primeiro frame tende a dominar em Android de baixo desempenho. Se você escrever um worker de longa duração que carrega recursos nativos, as mesmas regras de threading se aplicam de quando você [vai até o código de plataforma com method channels](/pt-br/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/), porque chamadas de `MethodChannel` a partir de um isolate worker não são suportadas no Android (somente o isolate raiz tem o binary messenger por padrão). Para reprodutibilidade no CI, fixe explicitamente tanto Flutter quanto Dart e rode os testes intensivos em isolates contra cada versão que você libera; o [workflow de matriz de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) é a forma mais barata de pegar uma regressão em que o custo de spawn ou o codec mudou por baixo. E quando você for debugar um worker que trava, o [workflow de iOS a partir do Windows](/pt-br/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) cobre como anexar a observer port pela rede para que você veja stack frames do worker ao vivo.

A versão mais curta da regra: se você escreveu `await` e a UI ainda trava, há trabalho síncrono em algum lugar na cadeia que você aguardou. `Isolate.run` para uma única chamada, `compute` se você vive dentro do Flutter e quer um import a menos, `Isolate.spawn` mais seu próprio protocolo de portas quando o worker tem estado de setup que vale manter aquecido. Todo o resto (as tabelas de tipos, as armadilhas de closure, o detalhe da web) é a papelada ao redor dessas três escolhas.

## Source links

- [Dart concurrency and isolates](https://dart.dev/language/concurrency)
- [Isolate.run API reference](https://api.dart.dev/stable/dart-isolate/Isolate/run.html)
- [Isolate.spawn API reference](https://api.dart.dev/stable/dart-isolate/Isolate/spawn.html)
- [Flutter compute function](https://api.flutter.dev/flutter/foundation/compute.html)
- [TransferableTypedData](https://api.dart.dev/stable/dart-isolate/TransferableTypedData-class.html)
- [`@pragma('vm:isolate-unsendable')` annotation](https://github.com/dart-lang/sdk/blob/main/runtime/docs/pragmas.md)
