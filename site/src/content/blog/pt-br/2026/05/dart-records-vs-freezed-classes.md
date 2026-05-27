---
title: "Dart records vs classes Freezed: qual escolher em 2026?"
description: "Escolha os records do Dart 3.12 para dados efêmeros com forma local e sem métodos, e as classes Freezed 3.x para modelos de domínio nomeados que precisam de copyWith, uniões seladas, serialização JSON ou qualquer comportamento."
pubDate: 2026-05-27
template: vs
tags:
  - "comparison"
  - "dart"
  - "flutter"
  - "freezed"
  - "records"
lang: "pt-br"
translationOf: "2026/05/dart-records-vs-freezed-classes"
translatedBy: "claude"
translationDate: 2026-05-27
---

No Dart 3.12 (a versão que chegou com Flutter 3.44 no Google I/O 2026), records e Freezed resolvem ambos "preciso de um tipo de valor imutável com igualdade estrutural", mas o fazem a partir de direções opostas. Records são um tipo estrutural, anônimo e nativo, sem geração de código. Freezed 3.x é um tipo nominal gerado por código com `copyWith`, uniões seladas, serialização JSON e o restante do conjunto de ferramentas para classes de dados. A resposta curta: use um record quando os dados forem uma forma local e efêmera que não precise de nome nem de método, e use Freezed para qualquer classe que faça parte do seu modelo de domínio, da sua árvore de estado ou do formato de transporte da sua API.

Este artigo cobre os records do Dart 3.12 (estáveis desde Dart 3.0 em maio de 2023, com a sintaxe curta para campos nomeados adicionada na 3.7 e os campos nomeados privados adicionados na 3.12) e Freezed 3.x sobre `build_runner` 2.4 (Freezed 3.0 foi lançado em março de 2025 com uma saída gerada menor e um padrão `@Freezed(toJson: false)` para uniões). Ambos miram a mesma base de Flutter 3.44 e Dart 3.12. A escolha não é "records são novos, Freezed é velho", porque ambos são mantidos ativamente e ambos têm lugar em um aplicativo Flutter de 2026. A escolha depende de para que o tipo serve.

## O que cada um é de fato

Um **record do Dart** é um tipo agregado nativo, imutável e anônimo. O tipo `(int, String)` é um record com dois campos posicionais. O tipo `({int id, String name})` é um record com dois campos nomeados. Records são estruturais: quaisquer dois records com a mesma forma de campos são o mesmo tipo, mesmo que tenham sido declarados em arquivos diferentes. O compilador gera `==`, `hashCode` e `toString` automaticamente. Não dá para adicionar métodos. Não dá para anexar comportamento. Não dá para dar a um record um nome em nível de classe (dá para fazer `typedef User = ({int id, String name});`, mas o typedef é apenas um alias para o tipo estrutural, não um novo tipo nominal).

Uma **classe Freezed 3.x** é uma classe Dart real com um mixin gerado. Você escreve uma classe normal com um construtor `factory` que lista os campos, executa `dart run build_runner build`, e o Freezed gera `==`, `hashCode`, `toString`, `copyWith`, opcionalmente `fromJson` e `toJson`, e (para uniões seladas) os auxiliares de correspondência de padrões `when` e `map`. A classe é nominal: `User` e `Customer` com os mesmos campos não são intercambiáveis. Dá para adicionar métodos, getters computados e construtores fábrica. Dá para marcar a classe como `sealed` e declarar vários casos de união que casem com padrões de forma exaustiva.

Os dois não são substitutos diretos. Se sobrepõem no caso de "desestruturar em algo parecido com uma tupla" e divergem em todo o resto.

## A matriz de recursos

| Capacidade                              | Record do Dart 3.12                  | Classe Freezed 3.x                      |
| --------------------------------------- | ------------------------------------ | --------------------------------------- |
| Custo de declaração                     | inline, sem arquivo                  | classe + factory + diretiva part + build_runner |
| Geração de código                       | nenhuma                              | sim (`*.freezed.dart` + `*.g.dart` opcional) |
| Identidade de tipo                      | estrutural                           | nominal                                 |
| Tipo nomeado                            | apenas via `typedef`                 | sim, classe completa                    |
| Nomes de campos na IDE / em erros       | apenas se declarados como nomeados   | sempre (o nome da classe aparece)       |
| `==` e `hashCode`                       | automático, baseado em valor         | automático, baseado em valor            |
| `toString`                              | automático (`(1, name: 'a')`)        | automático (`User(id: 1, name: 'a')`)   |
| `copyWith`                              | não                                  | sim, incluindo `copyWith.field(...)` profundo |
| `fromJson` / `toJson`                   | não (manual)                         | sim via `json_serializable`             |
| União selada / tipo soma                | não                                  | sim (`sealed class` + várias factories) |
| Métodos ou getters personalizados       | não                                  | sim (construtor privado + métodos)      |
| Valores padrão de campos                | não (devem ser explícitos em cada chamada) | sim (valores padrão na factory)   |
| Asserções / validação                   | não                                  | sim (no corpo da factory ou `@Assert`)  |
| Herança                                 | não                                  | sim apenas via uniões seladas           |
| Correspondência de padrões              | sim (posicional e nomeada)           | sim via `when` gerado ou correspondência de padrões sobre o sealed |
| Custo de build / IDE                    | zero                                 | `build_runner watch` rodando, arquivos gerados na árvore |
| Estabilidade da API pública             | renomear um campo é uma quebra porque muda a forma | renomear um campo é a mesma quebra, mas o nome da classe ancora o tipo |
| Pegada de memória                       | uma alocação, sem v-table além de Object | uma alocação, métodos de mixin gerados |

As três linhas que decidem a maioria dos casos: custo de declaração, tipo nomeado vs estrutural e se você precisa de `copyWith` ou JSON. Se não precisa de nenhum deles, o record ganha em peso. Se precisa de qualquer um, o Freezed ganha em ergonomia.

## Quando escolher um record do Dart

Escolha um record quando:

- **Você está retornando dois ou mais valores de um único método.** Esse é o caso de uso motivador original do Dart 3.0, e continua sendo o mais forte. Um record vence um parâmetro de saída, uma lista de dois elementos ou uma pequena classe auxiliar. O ponto de chamada desestrutura com um padrão.

  ```dart
  // Dart 3.12, Flutter 3.44
  (int rowsAffected, Duration elapsed) executeBatch(List<Update> updates) {
    final stopwatch = Stopwatch()..start();
    final n = _runBatch(updates);
    stopwatch.stop();
    return (n, stopwatch.elapsed);
  }

  // Caller
  final (rows, elapsed) = executeBatch(updates);
  print('Updated $rows rows in $elapsed');
  ```

  Uma classe Freezed para isso seriam três arquivos (`batch_result.dart`, `batch_result.freezed.dart`, opcionalmente `batch_result.g.dart`) para um valor que vive por uma linha.

- **A forma é local a uma função ou a um widget.** Um `_HitTestResult` que existe por dez linhas de cálculo de layout deveria ser um record, não uma classe. Se a forma vaza para fora do arquivo, esse é o sinal de que ela deveria virar uma classe Freezed.

- **Você está fazendo correspondência de padrões sobre a forma dos dados retornados.** Expressões switch sobre records são a forma como o Dart 3 espera que você lide com a saída de um parser, a saída de um validador ou qualquer valor de retorno "tag mais payload" em que o payload é uma de algumas poucas formas e vive apenas no ponto de chamada.

  ```dart
  // Dart 3.12
  sealed class ParseTag {}
  final ok = ParseTag(); // marker only - real code uses sealed subclasses

  ({bool ok, String? error, Map<String, dynamic>? data}) tryParse(String s) {
    try {
      return (ok: true, error: null, data: jsonDecode(s) as Map<String, dynamic>);
    } catch (e) {
      return (ok: false, error: e.toString(), data: null);
    }
  }

  final result = tryParse(input);
  switch (result) {
    case (ok: true, data: final m?, error: _):
      handle(m);
    case (ok: false, error: final msg?, data: _):
      reportError(msg);
    default:
      reportError('unknown parse failure');
  }
  ```

  Para um puro resultado de erro-ou-payload que sobe dois frames de pilha, um record é mais limpo do que introduzir uma união selada `Result<T>` com Freezed. No momento em que três pontos de chamada diferentes fazem switch sobre a mesma forma, promova-a a um tipo nomeado.

- **Você quer custo zero de `build_runner` nessa parte do código.** Records não adicionam geração de código, nem diretivas part, nem processo de watch. Em um pacote Flutter ou em uma biblioteca somente Dart em que você quer entregar sem nenhuma etapa de gerador, records são a única opção de tipo de valor imutável além de uma classe escrita à mão.

- **A contagem de campos é pequena e os tipos dos campos são óbvios pelo contexto.** Dois ou três campos cujo significado fica claro no ponto de chamada. Quando você tiver cinco campos e o ponto de chamada precisar de IntelliSense para lembrar para que serve cada um, você já passou do que um record comporta e precisa de uma classe nomeada.

## Quando escolher uma classe Freezed 3.x

Escolha Freezed quando:

- **O tipo é um modelo de domínio, um DTO de API ou um pedaço de estado do app.** Qualquer coisa que cruze um limite de camada, vá para log, seja serializada ou apareça em stack traces se beneficia de ter um nome de classe real. `User`, `Order`, `LineItem`, `AppState`, `AuthState`. Esses tipos merecem identidade nominal, um `toString` que imprima o nome da classe e uma experiência de depuração em que a IDE mostre `User { id, email, createdAt }` e não `({int id, String email, DateTime createdAt})`.

  ```dart
  // Dart 3.12, Flutter 3.44, freezed 3.x, json_serializable 6.x
  import 'package:freezed_annotation/freezed_annotation.dart';

  part 'user.freezed.dart';
  part 'user.g.dart';

  @freezed
  class User with _$User {
    const User._();

    const factory User({
      required int id,
      required String email,
      DateTime? createdAt,
      @Default(false) bool emailVerified,
    }) = _User;

    factory User.fromJson(Map<String, dynamic> json) => _$UserFromJson(json);

    bool get isVerified => emailVerified && email.contains('@');
  }
  ```

  Execute `dart run build_runner build --delete-conflicting-outputs` e você obtém `==`, `hashCode`, `toString`, `copyWith`, `fromJson`, `toJson` e o getter `isVerified`, tudo em uma só classe.

- **Você precisa de `copyWith` para imutabilidade de estado.** Esta é a razão mais comum pela qual projetos Flutter escolhem Freezed. Riverpod, Bloc e qualquer gerenciamento de estado no estilo reducer se apoiam em `state = state.copyWith(loading: true)`. Records não têm `copyWith`. Dá para escrever um à mão, mas você perde o motivo de ter usado um record em primeiro lugar.

- **Você precisa de uniões seladas para tipos de estado ou de resultado.** Um `LoadingState` com casos `Initial`, `Loading`, `Success(data)`, `Failure(error)` é a classe selada canônica do Freezed. A correspondência de padrões é exaustiva no Dart 3, o compilador avisa se você adicionar um caso e esquecer um `switch`, e o `copyWith` funciona por caso.

  ```dart
  // freezed 3.x
  @freezed
  sealed class AuthState with _$AuthState {
    const factory AuthState.signedOut() = AuthSignedOut;
    const factory AuthState.signingIn() = AuthSigningIn;
    const factory AuthState.signedIn(User user) = AuthSignedIn;
    const factory AuthState.failed(String reason) = AuthFailed;
  }

  // Pattern match
  Widget build(BuildContext context, AuthState state) => switch (state) {
        AuthSignedOut() => const LoginPage(),
        AuthSigningIn() => const Spinner(),
        AuthSignedIn(:final user) => HomePage(user: user),
        AuthFailed(:final reason) => ErrorPage(reason: reason),
      };
  ```

  Não dá para modelar isso com um record. Records são anônimos; herança selada exige tipos nomeados.

- **Você precisa de serialização JSON.** Freezed se integra com `json_serializable`, então você ganha `User.fromJson` e `user.toJson()` de graça. Um record não tem suporte JSON nativo; você escreve a conversão à mão toda vez.

- **A classe precisa de validação, valores padrão ou métodos.** Um corpo de factory pode asserir invariantes. `@Default(0)` define um valor padrão. Um construtor privado (`const User._();`) mais métodos ou getters regulares permite que a classe carregue comportamento. Records não conseguem fazer nada disso.

- **Você quer que os nomes dos campos apareçam em IDEs e em logs de falha.** Um record imprime como `(1, 'a@b.com', 2026-05-27 00:00:00.000)`. Uma classe Freezed imprime como `User(id: 1, email: a@b.com, createdAt: 2026-05-27 00:00:00.000, emailVerified: false)`. Em um stack trace, o segundo vale a etapa de geração de código.

## O benchmark: custo de instanciação, igualdade e tempo de build

Os números abaixo são em uma build release do Flutter 3.44, Dart 3.12 AOT, rodando em um Pixel 8 com a mesma forma de cinco campos (`int`, `String`, `DateTime`, `bool`, `String?`). Igualdade e hash rodam dentro do `BenchmarkRunner` por 1.000.000 de iterações.

| Métrica                                  | Record do Dart 3.12 | Classe Freezed 3.x |
| ---------------------------------------- | ------------------- | ------------------ |
| Alocação, ns / op                        | 18                  | 24                 |
| `==`, ns / op                            | 11                  | 14                 |
| `hashCode`, ns / op                      | 9                   | 12                 |
| `copyWith`, ns / op                      | n/a (sem API)       | 31                 |
| Custo de build (cold `build_runner build`) | 0 ms              | 4,1 s para 50 classes |
| Bytes gerados por classe                 | 0                   | ~2 KB              |
| Impacto na latência de hot reload        | nenhum              | nenhum (Freezed se dá bem com hot reload na 3.x) |

A diferença em runtime é pequena o bastante para não importar em código de aplicação. A diferença em tempo de build é o único número que afeta a vida diária: em um projeto com 200 classes Freezed, um `build_runner build` frio leva de 15 a 25 segundos, e o `build_runner watch` reconstrói incrementalmente em menos de um segundo por arquivo tocado. Se você já entregou um app Flutter com `json_serializable`, este é o mesmo perfil de custo.

A real diferença de desempenho entre os dois não é em nanossegundos. É o overhead mental no ponto de chamada. Um record não tem arquivo de classe, nem diretiva part, nem arquivo gerado nos diffs de controle de versão. Uma classe Freezed tem os três, mais a etapa de build que precisa estar rodando antes que sua IDE pare de pintar sublinhados vermelhos.

## O detalhe que decide por você

Algumas restrições decidem por você, independentemente da preferência:

1. **JSON cruzando uma fronteira de rede obriga a usar Freezed.** Records não têm `fromJson` nem `toJson`. Dá para escrever um conversor manual, mas para qualquer classe que existe por causa de uma resposta de backend, Freezed mais `json_serializable` é o caminho de menor fricção. Se você tentasse manter records para DTOs, reinventaria metade do `json_serializable` à mão.

2. **Gerenciamento de estado com `copyWith` obriga a usar Freezed.** Reducers do Riverpod e do Bloc são escritos em torno de `state = state.copyWith(loading: true)`. Records não conseguem fazer isso sem uma extensão manual que anula o motivo de usar um record. Se você está migrando de GetX para Riverpod (o caminho canônico de modernização em 2026 coberto no [guia de migração de GetX para Riverpod](/pt-br/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/)), suas classes de estado devem ser Freezed.

3. **Uniões seladas com payload obrigam a usar Freezed.** Records não conseguem modelar "um destes três casos nomeados, cada um com seu próprio payload". Classes seladas do Dart 3 conseguem, mas você ainda precisa de subclasses nomeadas, e a fricção de escrever cada uma à mão é exatamente o que o Freezed elimina.

4. **Um tipo que escapa do arquivo obriga a ter um nome.** Se mais alguém no time precisar importar o tipo, dê um nome a ele. Records são úteis dentro de uma função e aceitáveis dentro de um único arquivo. No momento em que outro arquivo o importa via `typedef`, o typedef só vale a pena porque o tipo subjacente é anônimo. Nesse ponto, escreva a classe.

5. **Um tipo com um ou dois campos e zero comportamento que vive por uma instrução obriga a usar um record.** Um par de doubles retornado por uma rotina de hit-test. Um `(width, height)` de um auxiliar de layout. Um `(success, errorOrNull)` de uma função estilo try. Escrever uma classe Freezed para isso é burocracia.

Uma heurística prática: se os nomes dos campos aparecem na sua depuração com `print` ou nos seus logs de falha, você quer uma classe Freezed. Se o valor nunca escapa de uma única função e nunca vai para log, um record é a escolha certa.

## Recomendação reafirmada

Para uma base de código Flutter 3.44 / Dart 3.12 em 2026:

- **Forma local, efêmera, anônima, sem comportamento, sem JSON**: escolha um **record**. Múltiplos retornos, tuplas desestruturadas, formas de correspondência de padrões dentro de uma única função.
- **Nomeado, escapa de um arquivo, precisa de `copyWith` / JSON / união selada / métodos**: escolha uma **classe Freezed 3.x**. Modelos de domínio, classes de estado, DTOs de API, qualquer coisa que termine em um stack trace.

Em um app real os dois coexistem. Os records ficam dentro de funções e arquivos de widget; as classes Freezed ficam em `models/` e `state/`. O erro é usar um para o trabalho do outro: uma classe Freezed para um valor de retorno de dois campos é sobre-engenharia, e um typedef de record para um modelo `User` é subengenharia.

Se você herdou uma base de código cheia de modelos baseados em `equatable`, o caminho de modernização em 2026 é movê-los para Freezed 3.x e não para records, pelo mesmo motivo: essas classes têm nomes, escapam de arquivos e precisam de `copyWith`. Records são uma ferramenta nova, não um substituto.

## Relacionados

- [Flutter vs React Native vs .NET MAUI para um novo projeto mobile em 2026](/pt-br/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/) para a escolha em nível de framework que está uma camada acima desta decisão.
- [Dart 3.12 elimina a lista de inicialização para campos privados](/pt-br/2026/05/dart-3-12-private-named-parameters-initializing-formals/) para a mudança de linguagem que interage com como você declara os parâmetros da factory do Freezed em 2026.
- [Como migrar um app Flutter de GetX para Riverpod](/pt-br/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) para a modernização de gerenciamento de estado em que o Freezed é a classe de estado canônica.
- [Como escrever um isolate em Dart para trabalho limitado por CPU](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) para o caso em que records cruzam um limite de isolate e você precisa pensar no que é serializado.
- [Como perfilar jank em um app Flutter com DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) para o fluxo de desempenho quando a alocação de uma classe de estado realmente aparece na timeline.

## Fontes

- [Tour da linguagem sobre records do Dart](https://dart.dev/language/records), documentação do Dart, acessado 2026-05-27.
- [Anúncio do Dart 3.0](https://medium.com/dartlang/announcing-dart-3-0-79bff52e1bb6), time do Dart, maio de 2023.
- [Pacote Freezed no pub.dev](https://pub.dev/packages/freezed), Remi Rousselet.
- [Pacote json_serializable](https://pub.dev/packages/json_serializable), time do Dart.
- [Notas de versão do Flutter 3.44](https://docs.flutter.dev/release/release-notes), documentação do Flutter, acessado 2026-05-27.
