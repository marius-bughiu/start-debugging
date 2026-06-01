---
title: "Como tratar erros de rede de forma elegante em um app Flutter"
description: "Uma requisição pode falhar sem conectividade, por timeout, por falha de DNS, por um 500 ou por JSON malformado, e cada caso precisa de uma resposta diferente. Veja como capturar as exceções certas, classificá-las, repetir com segurança e mostrar uma interface sobre a qual o usuário possa agir."
pubDate: 2026-06-01
template: how-to
tags:
  - "flutter"
  - "dart"
  - "networking"
lang: "pt-br"
translationOf: "2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app"
translatedBy: "claude"
translationDate: 2026-06-01
---

Uma chamada de rede no Flutter falha de pelo menos cinco formas distintas, e um app elegante trata cada uma de forma diferente: sem conectividade, um timeout de conexão, uma falha de DNS ou de socket, um status HTTP que não é 2xx, e um corpo de resposta malformado ou inesperado. A solução é capturar o tipo de exceção específico em vez de um `catch (e)` cru, mapeá-lo para um conjunto reduzido de estados visíveis ao usuário (offline, timeout, erro de servidor, repetível, fatal), envolver a chamada em um timeout e em uma repetição limitada com backoff, e renderizar um estado sobre o qual o usuário realmente possa agir, em vez de um spinner que nunca se resolve. Este guia usa Flutter 3.44 (estável, maio de 2026), Dart 3.x, o pacote `http` 1.x, `dio` 5.9.2 e `connectivity_plus` 7.1.1.

O erro que quase todo app Flutter comete no início é tratar "a rede" como um único modo de falha. Você envolve a chamada em `try`/`catch`, mostra um snackbar dizendo "Algo deu errado" e segue em frente. Mas "sem Wi-Fi" e "o servidor retornou um 503" não são o mesmo problema, e um usuário olhando para um erro genérico não tem ideia se deve repetir, esperar ou desistir. Pior ainda, o erro mais comum nem chega ao catch: um `Future` que nunca se completa porque não havia timeout, deixando um spinner girando para sempre.

## As exceções que uma chamada HTTP do Flutter realmente lança

Quando você usa `dart:io` e o pacote `http`, uma requisição que falhou aparece como uma exceção tipada, e o tipo diz o que deu errado:

- `SocketException` é lançada quando a própria conexão não pode ser estabelecida ou é interrompida: sem rota para o host, falha na resolução de DNS, conexão recusada, ou o dispositivo está offline. Este é o grupo "a rede está inacessível".
- `TimeoutException` (de `dart:async`) é lançada quando você envolve um `Future` com `.timeout(...)` e a duração se esgota. O pacote `http` não aplica timeout por conta própria, então, se você não o adicionar, uma conexão travada congela sua interface indefinidamente.
- `HttpException` e `ClientException` cobrem problemas no nível do protocolo: uma resposta malformada, uma conexão fechada no meio da resposta, ou um loop de redirecionamento.
- `FormatException` é lançada por `jsonDecode` quando o corpo não é JSON válido. Um 200 OK com uma página de erro HTML (um portal cativo, um proxy, um gateway mal configurado) cai aqui, não em nenhum dos grupos de rede. Cobri essa armadilha específica em [no guia sobre FormatException Unexpected character](/pt-br/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/).

Um status que não é 2xx não é uma exceção com o pacote `http`. `http.get` retorna um `Response` com `statusCode == 500` e você tem que verificar isso por conta própria. Esta é a razão mais comum de um app mostrar dados vazios silenciosamente: a pessoa desenvolvedora fez o parse de `response.body` como JSON sem nunca olhar para `response.statusCode`, e o corpo era uma carga de erro.

## Um repro que engole tudo

Aqui está o padrão a evitar. Compila, funciona em uma conexão rápida, e falha de todas as formas interessantes.

```dart
// Flutter 3.44, Dart 3.x, http 1.x -- anti-pattern, do not copy.
import 'dart:convert';
import 'package:http/http.dart' as http;

Future<List<String>> fetchNames() async {
  try {
    final response =
        await http.get(Uri.parse('https://api.example.com/names'));
    final data = jsonDecode(response.body) as List;
    return data.cast<String>();
  } catch (e) {
    return []; // every failure looks like "no data"
  }
}
```

Há três coisas quebradas. Não há timeout, então uma conexão estagnada trava para sempre. O status nunca é verificado, então um 500 com um corpo JSON de erro ou lança uma exceção em `cast` ou retorna lixo. E o `catch (e)` colapsa offline, timeout, erro de servidor e JSON inválido em um único resultado: uma lista vazia, indistinguível de "o servidor legitimamente não tem nomes". A interface não consegue dizer nada útil ao usuário porque a função jogou fora a única informação que importava.

## Classifique a falha em um resultado que a interface possa renderizar

A primeira solução real é parar de retornar dados crus e começar a retornar um resultado que codifique como a chamada terminou. Uma hierarquia de classes seladas (classes seladas do Dart 3) faz o compilador obrigar você a tratar todos os casos.

```dart
// Flutter 3.44, Dart 3.x
sealed class NetworkResult<T> {
  const NetworkResult();
}

class Success<T> extends NetworkResult<T> {
  final T data;
  const Success(this.data);
}

class Offline<T> extends NetworkResult<T> {
  const Offline();
}

class TimedOut<T> extends NetworkResult<T> {
  const TimedOut();
}

class ServerError<T> extends NetworkResult<T> {
  final int statusCode;
  const ServerError(this.statusCode);
}

class BadResponse<T> extends NetworkResult<T> {
  final String detail;
  const BadResponse(this.detail);
}
```

Agora a camada de dados mapeia cada tipo de exceção e cada status para um destes, e nada escapa como um throw não tratado:

```dart
// Flutter 3.44, Dart 3.x, http 1.x
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;

Future<NetworkResult<List<String>>> fetchNames() async {
  try {
    final response = await http
        .get(Uri.parse('https://api.example.com/names'))
        .timeout(const Duration(seconds: 10));

    if (response.statusCode >= 500) {
      return ServerError(response.statusCode);
    }
    if (response.statusCode >= 400) {
      // 4xx is usually a client bug or auth issue, not retryable.
      return BadResponse('HTTP ${response.statusCode}');
    }

    final decoded = jsonDecode(response.body) as List;
    return Success(decoded.cast<String>());
  } on SocketException {
    return const Offline();
  } on TimeoutException {
    return const TimedOut();
  } on FormatException catch (e) {
    return BadResponse('Malformed JSON: ${e.message}');
  } on http.ClientException catch (e) {
    return BadResponse(e.message);
  }
}
```

Repare na ordem das cláusulas `on`. O Dart as avalia de cima para baixo e executa a primeira correspondência, então coloque as exceções mais específicas primeiro. `TimeoutException` e `SocketException` são irmãs, não pai e filha, então a ordem relativa entre elas não importa, mas `FormatException` e `ClientException` precisam vir antes de qualquer `catch` amplo. Aqui, deliberadamente, não há nenhum `catch (e)` cru, porque, se alguma exceção que eu não antecipei for lançada, quero que ela quebre em depuração e apareça no meu relatório de erros, não que seja mapeada silenciosamente para `BadResponse`.

## Renderize cada ramo no widget

Como `NetworkResult` é uma classe selada, uma expressão `switch` no widget é exaustiva: adicione um novo tipo de resultado e o compilador marca cada `switch` que não o tratar. Esta é a recompensa da hierarquia selada.

```dart
// Flutter 3.44, Dart 3.x
import 'package:flutter/material.dart';

Widget buildBody(NetworkResult<List<String>> result, VoidCallback onRetry) {
  return switch (result) {
    Success(data: final names) => ListView(
        children: [for (final n in names) ListTile(title: Text(n))],
      ),
    Offline() => _ErrorState(
        message: 'You appear to be offline. Check your connection.',
        onRetry: onRetry,
      ),
    TimedOut() => _ErrorState(
        message: 'The request took too long. Try again.',
        onRetry: onRetry,
      ),
    ServerError(statusCode: final code) => _ErrorState(
        message: 'The server had a problem (HTTP $code). Try again shortly.',
        onRetry: onRetry,
      ),
    BadResponse(detail: final detail) => _ErrorState(
        message: 'Something went wrong. ($detail)',
        onRetry: null, // not retryable, retry will not help
      ),
  };
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback? onRetry;
  const _ErrorState({required this.message, this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(message, textAlign: TextAlign.center),
          if (onRetry != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: FilledButton(onPressed: onRetry, child: const Text('Retry')),
            ),
        ],
      ),
    );
  }
}
```

A distinção que importa ao usuário: `Offline`, `TimedOut` e `ServerError` oferecem um botão de repetição porque repetir pode ter sucesso. `BadResponse` não, porque uma carga malformada ou um 400 falharão de forma idêntica na próxima tentativa, e um botão de repetição que nunca funciona é pior do que nenhum botão. Mantenha o widget de erro simples para que ele não introduza um segundo bug; uma tela de erro que estoura o próprio layout passa uma péssima imagem, e [o guia sobre o overflow do RenderFlex](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/) cobre por que isso acontece.

## Repita falhas transitórias com backoff exponencial

`Offline`, `TimedOut` e `ServerError` (especificamente 502, 503, 504) são transitórios: a mesma requisição pode ter sucesso segundos depois. Um app elegante os repete automaticamente um número limitado de vezes, com atraso crescente para não martelar um servidor que está sofrendo. Não repita os 4xx, e não repita para sempre.

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';
import 'dart:io';

Future<T> withRetry<T>(
  Future<T> Function() action, {
  int maxAttempts = 3,
  Duration baseDelay = const Duration(milliseconds: 400),
}) async {
  var attempt = 0;
  while (true) {
    attempt++;
    try {
      return await action();
    } on SocketException {
      if (attempt >= maxAttempts) rethrow;
    } on TimeoutException {
      if (attempt >= maxAttempts) rethrow;
    }
    // 2^attempt backoff: 0.8s, 1.6s, 3.2s ...
    final delay = baseDelay * (1 << attempt);
    await Future<void>.delayed(delay);
  }
}
```

O `1 << attempt` é um deslocamento de bits que dobra o multiplicador a cada rodada, que é a forma mais barata de escrever backoff exponencial. Em produção você também quer jitter (um pequeno deslocamento aleatório) para que mil clientes se recuperando da mesma queda não repitam todos no mesmo tique e criem uma debandada, mas a forma central é este loop. Envolva a chamada HTTP, não a função `fetchNames` inteira, para que a repetição veja a exceção crua antes de ela ser mapeada para um `NetworkResult`. Se o trabalho dentro da ação repetida for pesado para a CPU (decodificar uma carga enorme, por exemplo), empurre isso para fora do isolate da interface, como descrito em [no guia sobre isolates do Dart](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/), porque as repetições multiplicam esse custo.

## dio dá a você erros tipados e um interceptor para repetições

O pacote `http` está bem, mas `dio` 5.9.2 envolve cada falha em uma única `DioException` cujo campo `type` já classifica a falha por você, o que remove boa parte do encanamento manual de `on SocketException`. O enum `DioExceptionType` tem oito valores: `connectionTimeout`, `sendTimeout`, `receiveTimeout`, `badCertificate`, `badResponse`, `cancel`, `connectionError` e `unknown`. Você configura os timeouts uma vez em `BaseOptions` e eles se aplicam a cada requisição.

```dart
// Flutter 3.44, Dart 3.x, dio 5.9.2
import 'package:dio/dio.dart';

final dio = Dio(BaseOptions(
  baseUrl: 'https://api.example.com',
  connectTimeout: const Duration(seconds: 5),
  receiveTimeout: const Duration(seconds: 10),
));

Future<NetworkResult<List<String>>> fetchNames() async {
  try {
    final response = await dio.get<List<dynamic>>('/names');
    return Success((response.data ?? []).cast<String>());
  } on DioException catch (e) {
    return switch (e.type) {
      DioExceptionType.connectionError => const Offline(),
      DioExceptionType.connectionTimeout ||
      DioExceptionType.sendTimeout ||
      DioExceptionType.receiveTimeout =>
        const TimedOut(),
      DioExceptionType.badResponse =>
        ServerError(e.response?.statusCode ?? 0),
      _ => BadResponse(e.message ?? 'Unknown dio error'),
    };
  }
}
```

O `dio` também valida os status por padrão: uma resposta que não é 2xx lança `DioException` com `type == badResponse` em vez de retornar silenciosamente, então o bug de "esqueci de verificar o status" não pode acontecer. E como o `dio` expõe um pipeline de interceptores, você pode anexar a lógica de repetição de forma centralizada em vez de envolver cada chamada. O pacote da comunidade `dio_smart_retry` se conecta a esse pipeline e repete requisições idempotentes com backoff de fábrica, o que vale a pena adotar quando você tem mais do que um punhado de endpoints.

## connectivity_plus informa sobre o rádio, não sobre a internet

Um pedido frequente é "verificar se o usuário está online antes de fazer a chamada". `connectivity_plus` 7.1.1 faz parte disso, mas leia o próprio aviso dele com atenção: a disponibilidade do tipo de conexão não garante acesso à internet. A partir da versão 5, a API retorna um `List<ConnectivityResult>` (um dispositivo pode estar em Wi-Fi e em dados ao mesmo tempo), não um valor único, o que confunde o código escrito com base em exemplos antigos.

```dart
// Flutter 3.44, Dart 3.x, connectivity_plus 7.1.1
import 'package:connectivity_plus/connectivity_plus.dart';

Future<bool> hasNetworkInterface() async {
  final results = await Connectivity().checkConnectivity();
  return !results.contains(ConnectivityResult.none);
}
```

A armadilha é tratar isso como uma trava: "se está conectado, a requisição vai ter sucesso". Não vai. Um celular reporta `wifi` enquanto está conectado à rede de uma cafeteria que não foi autorizada pelo portal cativo dela, então cada requisição ainda falha com um `SocketException` ou um timeout. Use `connectivity_plus` para reagir a mudanças (mostrar um banner offline no momento em que o rádio cai, escondê-lo quando ele volta) e para decidir se vale a pena tentar repetir, mas nunca como substituto de realmente tratar a exceção da requisição. A verificação de conectividade é uma otimização, o tratador de exceções é a fonte da verdade.

```dart
// Flutter 3.44, Dart 3.x, connectivity_plus 7.1.1
// React to connectivity changes for a live offline banner.
final sub = Connectivity().onConnectivityChanged.listen(
  (List<ConnectivityResult> results) {
    final online = !results.contains(ConnectivityResult.none);
    // update a banner; this stream's subscription must be cancelled
    // in dispose() like any other.
  },
);
```

Esse `StreamSubscription` é exatamente o tipo de recurso que vaza se você esquecer de cancelá-lo, que é o tema completo de [liberar controllers e subscriptions no Flutter](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

## Casos de borda que separam um app robusto de uma demo

**Cancelamento no dispose.** Se o usuário navega para fora no meio da requisição, o `Future` pode se completar mesmo assim e chamar `setState` em um `State` já defunto, lançando uma exceção. Proteja com `if (!mounted) return;` após cada `await` em um widget, ou mova a chamada para uma camada de gerência de estado que sobreviva à navegação. A posse mal tratada aqui é um tema recorrente ao reestruturar um app, que é parte do motivo pelo qual [migrar de GetX para Riverpod](/pt-br/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) precisa ter cuidado com onde o trabalho assíncrono vive.

**Os timeouts devem ser mais curtos do que a paciência do usuário, não a do servidor.** Um timeout de 30 segundos é tecnicamente correto e uma experiência terrível. Escolha um connect timeout em torno de 5 segundos e um receive timeout em torno de 10, e mostre uma repetição bem antes de um usuário concluir que o app está congelado.

**Um 200 com o corpo errado ainda é uma falha.** Trate a validação de esquema como parte do tratamento de rede. Se `jsonDecode` tem sucesso, mas falta um campo obrigatório, isso é um `BadResponse`, não um `Success`. Valide o formato antes de construir seu modelo, ou você empurra a falha para o fundo da interface, onde ela é muito mais difícil de diagnosticar.

**Não faça log e rethrow em cada camada.** Escolha um único lugar (o mapeamento de exceções da camada de dados) para registrar o erro com seu stack trace, e deixe o resultado tipado carregar o resto. Registrar a mesma exceção três vezes enquanto ela borbulha para cima só deixa seus relatórios de falha mais ruidosos.

**As repetições amplificam a carga durante uma queda.** Quando um backend já está sofrendo, repetições agressivas do cliente pioram a situação. Limite as tentativas, use backoff com jitter, e respeite um cabeçalho `Retry-After` se o servidor o enviar. A degradação elegante tem tanto a ver com ser um bom cliente quanto com mostrar uma tela de erro bonita.

O fio condutor é que o "tratamento de erros de rede" são na verdade três trabalhos que as pessoas colapsam em um: capturar a falha específica, classificá-la em algo sobre o qual a interface e a lógica de repetição possam raciocinar, e apresentá-la como um estado sobre o qual o usuário possa agir. Acerte as cláusulas `catch` tipadas e o resultado selado, adicione um backoff limitado para os casos transitórios, e trate `connectivity_plus` como uma dica em vez de uma garantia, e o snackbar genérico de "Algo deu errado" desaparece do seu app de vez.

## Relacionado

- [Como liberar controllers no Flutter para evitar vazamentos de memória](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) cobre como cancelar o `StreamSubscription` que um listener de conectividade cria.
- [Fix: FormatException Unexpected character ao fazer parse de JSON em Dart](/pt-br/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) é o caso do corpo malformado em detalhe.
- [Como escrever um isolate de Dart para trabalho intensivo de CPU](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) é onde a decodificação pesada de respostas deve viver para que as repetições não causem jank na interface.
- [Como migrar um app Flutter de GetX para Riverpod](/pt-br/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) mostra onde o trabalho de rede assíncrono deve viver ao longo de uma mudança de gerência de estado.
- [Fix: RenderFlex overflowed no Flutter](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/) evita que seus widgets de erro e de carregamento quebrem o layout.

## Fontes

- [DioException class, referência da API do dio](https://pub.dev/documentation/dio/latest/dio/DioException-class.html)
- [DioExceptionType enum, referência da API do dio](https://pub.dev/documentation/dio/latest/dio/DioExceptionType.html)
- [connectivity_plus, pub.dev](https://pub.dev/packages/connectivity_plus)
- [Future.timeout, referência da API do Dart](https://api.dart.dev/stable/dart-async/Future/timeout.html)
- [SocketException class, referência da API do Dart](https://api.dart.dev/stable/dart-io/SocketException-class.html)
- [http package, pub.dev](https://pub.dev/packages/http)
