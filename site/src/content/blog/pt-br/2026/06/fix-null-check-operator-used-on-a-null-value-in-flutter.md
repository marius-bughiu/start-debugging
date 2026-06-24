---
title: "Solução: Null check operator used on a null value no Flutter"
description: "O operador ! encontrou um null em runtime. Substitua-o por ?. e ?? para um valor padrão, ou proteja com uma verificação de null explícita, em vez de afirmar um valor que não estava lá."
pubDate: 2026-06-24
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "pt-br"
translationOf: "2026/06/fix-null-check-operator-used-on-a-null-value-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-24
---

Você escreveu `something!` e `something` era `null` quando a linha rodou. O operador de verificação de null (bang) promete ao compilador "isto nunca é null", e o Dart faz cumprir essa promessa em runtime lançando o erro no instante em que ela é quebrada. A solução quase sempre é parar de afirmar e começar a tratar: use `?.` para curto-circuitar, `??` para fornecer um valor padrão, ou uma proteção `if (x != null)` que deixa o compilador estreitar o tipo por você. Esta página usa Flutter 3.44 (estável, maio de 2026) e Dart 3.x.

## O erro em contexto

Quando o operador bang encontra um `null`, você recebe um `TypeError` com esta mensagem exata:

```
Unhandled Exception: Null check operator used on a null value
```

Na camada de widgets ele geralmente aparece envolvido pelo framework, que é onde a maioria das pessoas de fato o vê:

```
======== Exception caught by widgets library =======================================================
The following _TypeError was thrown building ProfilePage(dirty):
Null check operator used on a null value

The relevant error-causing widget was:
  ProfilePage ProfilePage:file:///lib/profile_page.dart:18:12
```

A classe é `_TypeError` (um subtipo de `TypeError`), a mesma família que o Dart usa para casts que falham. Essa é a pista: o operador bang é um cast. Ele converte `T?` para `T`, e como qualquer cast pode falhar em runtime.

## Por que isso acontece: o operador bang é um cast verificado

Em null safety sólida, `String?` e `String` são tipos diferentes. O `!` posfixo é uma forma abreviada que, nas palavras da documentação do Dart, "pega a expressão à esquerda e a converte para o seu tipo não anulável subjacente". Um cast de um tipo anulável para um não anulável não pode ser provado como seguro em tempo de compilação, então o compilador insere uma verificação em runtime. Se o valor for `null` quando a verificação rodar, você recebe `Null check operator used on a null value`.

Então isso nunca é um bug do compilador nem do framework. É um valor sendo `null` em um momento em que o seu código jurou que ele não seria. O trabalho é encontrar o valor e decidir o que deve acontecer quando ele estiver genuinamente ausente, em vez de encobri-lo com outro `!`.

## Reprodução mínima

A versão mais simples é uma única variável anulável à qual ainda não foi atribuído nada:

```dart
// Flutter 3.44, Dart 3.x
String? name;          // nullable, defaults to null
void main() {
  print(name!.length); // throws: Null check operator used on a null value
}
```

Em código Flutter real, o formato mais comum são dados que ainda não carregaram. O campo é `null` até uma chamada de rede preenchê-lo, mas `build` roda imediatamente e o desreferencia:

```dart
// Flutter 3.44, Dart 3.x -- crashes on first build
class ProfilePage extends StatefulWidget {
  const ProfilePage({super.key});
  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  User? _user; // null until the fetch returns

  @override
  void initState() {
    super.initState();
    _loadUser(); // async, completes some frames later
  }

  Future<void> _loadUser() async {
    final u = await api.fetchUser();
    setState(() => _user = u);
  }

  @override
  Widget build(BuildContext context) {
    return Text(_user!.name); // <-- _user is null on the first build
  }
}
```

`build` é chamado antes de `_loadUser` resolver, então `_user` ainda é `null` no primeiro frame e `_user!` lança o erro.

## A solução, em ordem de preferência

A solução correta depende de `null` ser um estado legítimo (dados ainda carregando, campo opcional, chave ausente) ou um bug (você esperava um valor e a ausência dele significa que algo mais acima está quebrado). Na maioria das vezes é o primeiro caso, e o framework te dá ferramentas idiomáticas para isso.

### 1. Forneça um valor padrão com `??`

Se existe um valor de fallback sensato, o operador de coalescência de null é a solução correta mais curta. Ele retorna o lado direito quando o esquerdo é `null`:

```dart
// Flutter 3.44, Dart 3.x
Text(_user?.name ?? 'Loading...');
```

`_user?.name` é `null` quando `_user` é `null` (o `?.` curto-circuita toda a cadeia), e `??` substitui o marcador. Sem lançamento de erro, e a interface mostra algo útil enquanto os dados carregam.

### 2. Ramifique no estado de carregamento explicitamente

Quando não há um bom valor padrão, renderize widgets diferentes para o estado carregado e o ainda-não-carregado. Uma verificação `if (x != null)` promove a variável local para não anulável dentro do ramo, então você não precisa de `!` algum:

```dart
// Flutter 3.44, Dart 3.x
@override
Widget build(BuildContext context) {
  final user = _user;            // copy to a local for promotion
  if (user == null) {
    return const Center(child: CircularProgressIndicator());
  }
  return Text(user.name);        // user is User here, not User?
}
```

Copie o campo para uma variável local primeiro. O Dart só promove variáveis locais, não campos de instância, porque outro método (ou outro isolate) poderia mutar um campo entre a verificação e o uso. A variável local é a parte que sustenta esse padrão.

### 3. Deixe o `FutureBuilder` cuidar do estado null

Se o valor vem de uma única chamada assíncrona, não improvise o flag na mão. O `FutureBuilder` modela carregamento, erro e dados como um único objeto, e você só lê `data` depois de confirmar que ele está presente:

```dart
// Flutter 3.44, Dart 3.x
FutureBuilder<User>(
  future: _userFuture, // created once, not in build -- see below
  builder: (context, snapshot) {
    if (snapshot.connectionState != ConnectionState.done) {
      return const CircularProgressIndicator();
    }
    if (snapshot.hasError) {
      return Text('Failed: ${snapshot.error}');
    }
    return Text(snapshot.data!.name); // safe: hasData is implied here
  },
);
```

O `snapshot.data!` aqui é legítimo porque você já provou que o future completou sem erro. Uma ressalva que pega muita gente: crie o future uma única vez e armazene-o, nunca inline dentro de `build`, ou cada reconstrução inicia um novo fetch. Esse é um problema próprio, coberto em [por que o FutureBuilder fica recriando o seu Future](/pt-br/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).

### 4. Use `late` somente quando a inicialização realmente precede a primeira leitura

Se um valor é atribuído exatamente uma vez, antes de qualquer coisa lê-lo, `late` remove a nulabilidade sem o bang. Mas isso é uma troca, não um ganho grátis: um campo `late` lido antes da atribuição lança `LateInitializationError`, um crash diferente e possivelmente pior, porque é fácil supor que `late` tornou o valor seguro. Recorra a ele apenas quando a ordem é garantida, por exemplo um valor definido em `initState` e lido em `build`:

```dart
// Flutter 3.44, Dart 3.x
late final AnimationController _controller;

@override
void initState() {
  super.initState();
  _controller = AnimationController(vsync: this); // assigned before any build
}
```

Se a ordem não é garantida, mantenha o campo anulável e proteja-o. O detalhamento completo de quando `late` ajuda e quando atrapalha está em [como resolver o LateInitializationError no Flutter](/pt-br/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/).

## Os suspeitos de sempre além de um flag de carregamento

O erro se disfarça de várias formas. Estas são as de maior frequência, cada uma com a mesma causa subjacente e o mesmo formato de solução.

**`GlobalKey.currentState!` antes de o widget estar montado.** Chamar `_formKey.currentState!.validate()` quando o `Form` não está na árvore (ou ainda não foi construído) lança o erro, porque `currentState` é `null` até o widget se anexar. Use `?.`:

```dart
// Flutter 3.44, Dart 3.x
if (_formKey.currentState?.validate() ?? false) {
  // form is valid and present
}
```

**Argumentos de rota que não foram passados.** `ModalRoute.of(context)!.settings.arguments as Args` assume tanto que existe uma rota quanto que argumentos foram fornecidos. Se você empurra a rota sem argumentos, `arguments` é `null` e o `as` posterior ou um `!` seguinte explode. Leia de forma defensiva:

```dart
// Flutter 3.44, Dart 3.x
final args = ModalRoute.of(context)?.settings.arguments as Args?;
if (args == null) return const ErrorScreen('Missing arguments');
```

**Acesso a Map e JSON com `[key]!`.** Uma busca em um map retorna `null` para uma chave ausente, e `json['email']!` lança o erro no momento em que o campo está ausente ou a API o renomeou. Decodifique através de um modelo com nulabilidade explícita ou atribua um valor padrão a cada campo:

```dart
// Flutter 3.44, Dart 3.x
final email = (json['email'] as String?) ?? '';
```

**`firstWhere` com um bang sobre o resultado.** Às vezes as pessoas escrevem `list.firstWhere((e) => e.id == id, orElse: () => null)!` para "encontrar ou estourar". Isso é exatamente uma suposição não verificada. Prefira `firstWhereOrNull` do `package:collection` e trate o caso vazio:

```dart
// Flutter 3.44, Dart 3.x
final match = list.firstWhereOrNull((e) => e.id == id);
if (match == null) { /* handle not found */ }
```

## Variantes que isto não é, e para onde ir em vez disso

O tráfego de busca para esse erro muitas vezes pertence a uma página vizinha. Três parecidos:

`LateInitializationError: Field '_x' has not been initialized` é um irmão, não o mesmo erro. Ele vem de ler uma variável `late` antes da atribuição, não de um `!` sobre um anulável. Se o seu stack trace diz `LateInitializationError`, a solução está na [página do LateInitializationError](/pt-br/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/), não aqui.

Uma verificação de null que só falha depois de navegar, e só em release, costuma ser um sintoma de contexto morto. A busca sobre um contexto desativado retorna `null` em builds de release (o assert que o detecta é só de debug), e esse `null` então dispara um `!` em algum ponto mais abaixo. Se o crash se correlaciona com um `await` seguido de um uso do contexto, leia [usar BuildContext com segurança depois de um await](/pt-br/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/), porque o erro real está acima do bang.

Um `TextEditingController` ou outro controlador usado depois de `dispose` também pode alimentar um `null` para uma afirmação posterior. Se o controlador é a fonte, [como resolver o erro de controlador descartado](/pt-br/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter) aborda o ciclo de vida diretamente.

## O lint que pega isso antes do runtime

O Dart não pode avisar sobre cada `!` que possa falhar, porque esse é justamente o sentido do operador: você está sobrepondo o analisador. Mas ele pode sinalizar os que consegue provar que são inúteis. A regra `unnecessary_non_null_assertion`, ativada por padrão no `flutter_lints`, dispara quando você aplica um bang a um valor que o analisador já sabe ser não nulo, o que normalmente significa que o seu modelo mental e o sistema de tipos não concordam:

```yaml
# analysis_options.yaml -- on by default via flutter_lints
include: package:flutter_lints/flutter.yaml
```

A disciplina mais ampla é tratar cada `!` que você digita como uma afirmação que você precisa defender. Se você não consegue apontar a linha que garante que o valor é não nulo naquele caminho, você não tem um `!`, você tem um `Null check operator used on a null value` latente. Modelar os dados assíncronos como estados explícitos de carregamento e erro, como em [estados de carregamento e erro com AsyncValue](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/), elimina a maioria dessas afirmações por completo, porque o framework entrega o valor só no ramo onde ele existe.

## O hábito que aposenta o erro

O operador bang é uma promessa ao compilador, quitada em runtime, e `Null check operator used on a null value` é o recibo de uma promessa quebrada. Sempre que você for tentado a escrever `!`, pergunte-se o que deve acontecer quando o valor for realmente `null`: um marcador (`??`), um widget diferente (`if (x != null)`), ou um erro real que você levanta de propósito. Escolha uma dessas opções e o crash nunca chega a um usuário. Reserve `!` para o caso raro em que `null` seria uma violação genuína de uma invariante, e mesmo assim, prefira lançar um `StateError` com uma mensagem que explique o que deu errado a um bang pelado que diz apenas "isto era null".

## Fontes

- [Understanding null safety](https://dart.dev/null-safety/understanding-null-safety), documentação do Dart, que define o operador `!` como um cast verificado para o tipo não anulável e explica por que a verificação precisa rodar em runtime.
- [Null safety unsound migration and the `!` operator](https://dart.dev/null-safety), documentação da linguagem Dart.
- [unnecessary_non_null_assertion lint rule](https://dart.dev/tools/linter-rules/unnecessary_non_null_assertion), regras do linter do Dart.
- [firstWhereOrNull](https://pub.dev/documentation/collection/latest/collection/IterableExtension/firstWhereOrNull.html), documentação da API do `package:collection`.
