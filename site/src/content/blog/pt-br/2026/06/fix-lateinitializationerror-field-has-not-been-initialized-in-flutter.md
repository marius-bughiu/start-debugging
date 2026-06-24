---
title: "Corrigir: LateInitializationError: Field '...' has not been initialized no Flutter"
description: "Esse crash significa que você leu um campo late antes de qualquer coisa atribuir um valor a ele. Inicialize-o de forma síncrona em initState, ou pare de usar late e modele o valor assíncrono como estado anulável."
pubDate: 2026-06-24
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "pt-br"
translationOf: "2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-24
---

Um campo `late` foi lido antes de qualquer código atribuir um valor a ele. O campo não tem expressão de inicialização, então o Dart não consegue computá-lo de forma preguiçosa, e a leitura aconteceu antes da atribuição que você pretendia. A causa mais comum no Flutter é um campo `late` que você atribui a partir de um método assíncrono (uma busca na rede, uma leitura de banco de dados) enquanto o `build()` roda primeiro e toca o campo antes que o future seja concluído. A correção depende do timing: se o valor está disponível de forma síncrona, atribua-o em `initState()` antes do primeiro build; se ele só chega depois, não use `late` de jeito nenhum -- declare o campo como anulável (`Type?`) e renderize um estado de carregamento até que ele seja definido. Este guia usa Flutter 3.44 (stable, maio de 2026) e Dart 3.x. O próprio modificador `late` existe desde o Dart 2.12.

## O erro em contexto

A mensagem completa que o Dart lança se parece com isto:

```
LateInitializationError: Field '_user' has not been initialized.
#0      _MyScreenState._user (package:my_app/screens/my_screen.dart)
#1      _MyScreenState.build (package:my_app/screens/my_screen.dart:42:25)
#2      StatefulElement.build (package:flutter/src/widgets/framework.dart)
...
```

O frame no topo, o getter sintético `_user`, é a leitura que falhou. O frame logo abaixo, aqui o `build`, é a linha no seu código que tocou o campo. Essa linha é onde o crash aparece, mas o bug é a ausência de uma atribuição que deveria ter rodado antes dela. `LateInitializationError` é um subtipo de `Error`, não de `Exception`, que é a forma do Dart de dizer que isto é um erro de programação, não uma condição de runtime recuperável. Você corrige o fluxo de controle; você não o captura.

A mensagem tem três primas próximas, e a redação diz qual delas você atingiu:

```
LateInitializationError: Field '_user' has not been initialized.
LateInitializationError: Local 'result' has not been initialized.
LateInitializationError: Field '_id' has already been initialized.
```

"Field" significa um campo de instância ou estático; "Local" significa uma variável local dentro de uma função. "has already been initialized" é o erro oposto: atribuir um valor a um campo `late final` duas vezes. Elas compartilham uma mesma família de causa raiz, mas não a mesma correção, e a seção de variantes abaixo cobre as outras.

## Por que isso acontece

Existem quatro causas, em ordem aproximada de com que frequência elas mordem.

O valor é atribuído de forma assíncrona, mas lido de forma síncrona. Você declarou `late User _user;` e o atribui dentro de um método `async` que você dispara a partir do `initState()`. Mas o `initState()` retorna imediatamente, o primeiro `build()` roda enquanto a busca ainda está em andamento, e o `build()` lê `_user`. Nada atribuiu um valor a ele ainda, então a leitura lança a exceção. Esta é de longe a forma mais comum do bug, e ela é traiçoeira porque é um crash garantido, não um intermitente: o future nunca é concluído antes do primeiro frame, então ele falha toda vez que a tela é aberta.

A atribuição vive em um branch que não rodou. Você escreveu `late String _label;` e só o atribui dentro de um `if` ou de um braço de `switch`. Quando a condição é falsa ou nenhum braço corresponde, o campo permanece sem atribuição, e a próxima leitura lança a exceção. O compilador do Dart aceita isso porque `late` é uma promessa sua para o analisador de que você vai atribuir antes de ler; o analisador para de checar atribuição definitiva e confia em você.

Você esqueceu a atribuição por completo. O campo foi declarado `late` durante uma refatoração, a linha que o definia foi deletada ou nunca foi escrita, e o analisador não disse nada porque `late` opta por sair da checagem de atribuição definitiva. Este é o caso em que a correção é simplesmente atribuir a coisa.

O campo precisa de dados de `InheritedWidget` e você o atribuiu cedo demais. Se o valor vem de `Theme.of(context)`, `MediaQuery.of(context)`, um `Provider`, ou qualquer `InheritedWidget`, você não pode lê-lo no construtor ou em inicializadores de campo, porque o element ainda não está montado na árvore. Atribuir em `initState()` também é cedo demais para dados herdados. O hook correto é `didChangeDependencies()`, e errar isso deixa o campo `late` sem atribuição no primeiro build.

O contrato subjacente, dos docs da linguagem Dart sobre o [modificador `late`](https://dart.dev/language/variables#late-variables): um campo `late` sem inicializador deve ser atribuído antes de ser lido, e lê-lo primeiro é um erro de runtime. Um campo `late` com inicializador é diferente: o inicializador roda de forma preguiçosa na primeira leitura, então ele nunca pode estar "não inicializado". Essa distinção é a chave para as correções mais limpas abaixo.

## Um repro mínimo

Esta tela dá crash toda vez que é aberta. Ela compila sem um aviso.

```dart
// Flutter 3.44, Dart 3.x -- throws "LateInitializationError: Field '_user' has not been initialized".
import 'package:flutter/material.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late User _user; // promise: I will assign this before reading it

  @override
  void initState() {
    super.initState();
    _load(); // fire-and-forget async; returns before _user is set
  }

  Future<void> _load() async {
    final fetched = await fetchUser(); // ~300ms network round trip
    setState(() => _user = fetched);
  }

  @override
  Widget build(BuildContext context) {
    // First build runs while _load() is still awaiting. This read throws.
    return Text(_user.name);
  }
}

class User {
  final String name;
  User(this.name);
}

Future<User> fetchUser() =>
    Future.delayed(const Duration(milliseconds: 300), () => User('Ada'));
```

A sequência é: `initState()` roda e inicia `_load()`, `_load()` atinge seu primeiro `await` e cede, o Flutter prossegue para o primeiro `build()`, `build()` lê `_user`, e nada atribuiu um valor a ele ainda. O `setState(() => _user = fetched)` que o teria definido roda 300ms depois. O primeiro frame perde a corrida toda vez.

## Correção, em detalhe

As correções estão ordenadas por quanto eu as recomendo. Escolha a que corresponde à sua causa.

### 1. Se o valor é assíncrono, não use late -- modele-o como estado anulável (recomendado)

`late` é a ferramenta errada para um valor que chega depois do primeiro build. Ele promete que o valor está pronto de forma síncrona; uma busca aguardada não está. Declare o campo como anulável e renderize um estado de carregamento enquanto ele for null. Agora o sistema de tipos força você a tratar o "ainda não carregado" em vez de dar crash nele.

```dart
// Flutter 3.44, Dart 3.x -- correct: nullable field, explicit loading state.
class _ProfileScreenState extends State<ProfileScreen> {
  User? _user; // null means "not loaded yet"

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final fetched = await fetchUser();
    if (!mounted) return; // the screen may be gone by now
    setState(() => _user = fetched);
  }

  @override
  Widget build(BuildContext context) {
    final user = _user;
    if (user == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return Text(user.name);
  }
}
```

A guarda `if (!mounted) return;` antes do `setState` não é opcional aqui: um callback assíncrono que se resolve depois que o usuário saiu da tela vai, caso contrário, lançar um erro diferente. Essa guarda é a mesma disciplina que você precisa para [usar BuildContext com segurança depois de um await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/), e ela acompanha todo callback aguardado em um `State`.

Para qualquer coisa além de um único valor, prefira um `FutureBuilder` ou, se você está usando Riverpod, um `AsyncValue` que codifica carregamento, erro e dados como três casos explícitos. Escrever o resultado direto em um campo depois de um await é exatamente o padrão que produz este crash e seus irmãos no momento do disposal; modelar a requisição como estado em vez disso é abordado em [mostrar estados de carregamento e erro com AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

### 2. Se o valor é síncrono, atribua-o em initState antes do primeiro build

`late` está correto quando o valor está genuinamente disponível antes do build, mas você não consegue computá-lo no inicializador de campo (por exemplo, ele precisa de `widget`). Atribua-o em `initState()`, que roda uma vez antes do primeiro `build()`.

```dart
// Flutter 3.44, Dart 3.x -- correct: late assigned synchronously, before build.
class _EditorState extends State<Editor> {
  late final TextEditingController _controller;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.initialText);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => TextField(controller: _controller);
}
```

Este é o uso legítimo de `late final` em um `State`: você precisa de `widget.initialText`, que não está disponível em um inicializador de campo, mas está disponível em `initState()`, que ainda roda antes de qualquer build. Como o controller é criado exatamente uma vez e nunca reatribuído, `late final` é o modificador correto, e você ainda lhe deve um `dispose()`, como o [guia de disposal de controllers](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) expõe.

### 3. Use um inicializador preguiçoso para que o campo nunca possa ficar sem atribuição

Se o valor pode ser computado sob demanda e não depende de `widget` ou `context`, dê ao campo `late` uma expressão de inicialização. O Dart então roda essa expressão de forma preguiçosa na primeira leitura, então o campo se inicializa sozinho na primeira vez que alguém o toca. Um campo `late` com inicializador não pode lançar "has not been initialized".

```dart
// Flutter 3.44, Dart 3.x -- correct: lazy initializer, computed on first read.
class Report {
  // Expensive to build; only built if something actually reads it.
  late final List<int> histogram = _buildHistogram();

  List<int> _buildHistogram() {
    // ...expensive work...
    return List<int>.filled(256, 0);
  }
}
```

Este é o único caso em que `late` justifica sua existência puramente por desempenho: o trabalho é adiado até ser necessário e pulado por completo se `histogram` nunca for lido. Se o inicializador é barato, descarte o `late` e inicialize na declaração; a inicialização preguiçosa só vale o modificador quando a computação é cara ou tem efeitos colaterais que você quer adiar.

### 4. Leia dados de InheritedWidget em didChangeDependencies, não antes

Se o campo `late` é alimentado por `Theme.of`, `MediaQuery.of`, ou um provider, mova a atribuição para `didChangeDependencies()`. Ela roda depois de `initState()` e novamente sempre que uma dependência herdada muda, e é o ponto mais cedo em que `context` pode resolver com segurança inherited widgets.

```dart
// Flutter 3.44, Dart 3.x -- correct: inherited data resolved in didChangeDependencies.
class _BannerState extends State<Banner> {
  late Color _accent;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _accent = Theme.of(context).colorScheme.primary;
  }

  @override
  Widget build(BuildContext context) => ColoredBox(color: _accent);
}
```

Fazer isso em `initState()` ou lança a exceção (Flutter mais antigo) ou retorna dados obsoletos que nunca atualizam quando o tema muda. `didChangeDependencies()` corrige ambos: o campo é atribuído antes do primeiro build e reatribuído sempre que o tema muda.

## Pegadinhas e variantes

`LateInitializationError: Field '...' has already been initialized.` A imagem espelhada. Você atribuiu um valor a um campo `late final` duas vezes. `late final` permite exatamente uma escrita; a segunda lança isto. Costuma acontecer quando `initState()` atribui o campo e um caminho de código posterior (um `didUpdateWidget`, um callback, um segundo `_load`) o atribui novamente. Se você genuinamente precisa reatribuir, descarte o `final` e mantenha apenas `late`; se você não precisa, encontre a escrita duplicada e a delete.

`LateInitializationError: Local '...' has not been initialized.` O mesmo erro em uma variável local em vez de um campo. Você escreveu `late int total;` dentro de uma função e um branch a deixou sem atribuição antes de uma leitura. `late` local raramente vale a pena: prefira inicializar a variável na sua declaração, ou reestruture para que todo caminho a atribua antes do uso. A checagem de atribuição definitiva do analisador teria pegado isto para você se a variável não fosse `late` -- essa checagem é precisamente o que `late` desliga.

Ele lança em release, mas a mensagem sumiu. Em builds de release, a maquinaria de assertion é removida, mas uma leitura de `late`-sem-inicializador ainda lança `LateInitializationError`; apenas a mensagem rica de debug é reduzida. Não presuma que crashes de `late` são exclusivos do debug. Eles vão para produção.

`late` versus o operador de null-check. Recorrer a `late` para silenciar "the non-nullable field must be initialized" é o mesmo instinto que faz as pessoas espalharem `!` para silenciar a nulabilidade. Ambos adiam uma garantia de tempo de compilação para um crash de runtime. Se um valor pode legitimamente estar ausente, modele-o como anulável e trate o null; `late` é apenas para valores que estão sempre presentes, mas atribuídos um pouco depois da declaração. O modelo mental mais amplo de null safety, incluindo quando `late` é e quando não é a válvula de escape correta, está no [checklist de null safety do Flutter 2 para 3.x](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/).

Um campo `late` lido dentro de seu próprio inicializador. Se um inicializador preguiçoso `late final x = ...x...;` lê `x`, você recebe um `LateInitializationError` sobre leitura durante a inicialização. O ciclo é o bug; quebre-o computando o valor sem referenciar o campo.

A única disciplina que remove toda esta classe de bugs: use `late` apenas para um valor que está sempre presente e atribuído de forma síncrona antes da primeira leitura (tipicamente em `initState()` ou `didChangeDependencies()`), e modele qualquer coisa que chega de forma assíncrona como estado anulável com um branch de carregamento explícito. Conecte essa distinção ao seu reflexo e o erro para de aparecer. No momento em que você se pegar atribuindo um campo `late` depois de um `await`, esse é o sinal para trocá-lo por `Type?` e renderizar o estado intermediário em vez disso.

## Relacionados

- [How to use BuildContext safely after an await in Flutter](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) cobre a guarda `mounted` da qual a correção assíncrona acima depende.
- [How to show loading and error states with AsyncValue in Flutter Riverpod](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) é a alternativa estruturada a escrever resultados assíncronos em um campo `late`.
- [Fix: A TextEditingController was used after being disposed in Flutter](/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) é a outra metade do ciclo de vida do controller da qual os controllers `late final` participam.
- [How to dispose controllers in Flutter to avoid memory leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) combina com o padrão `late final TextEditingController` da correção 2.
- [Migrate a Flutter 2 app to Flutter 3.x: null safety checklist](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) explica onde `late` se encaixa em null safety e onde tipos anuláveis são a melhor escolha.

## Fontes

- [late variables, Dart language tour](https://dart.dev/language/variables#late-variables) -- o contrato para campos `late` com e sem inicializadores.
- [Understanding null safety, dart.dev](https://dart.dev/null-safety/understanding-null-safety#late-variables) -- a justificativa para `late` e como ele interage com atribuição definitiva.
- [State.initState and State.didChangeDependencies, Flutter API reference](https://api.flutter.dev/flutter/widgets/State/didChangeDependencies.html) -- qual hook de ciclo de vida pode ler com segurança dados herdados.
- [LateInitializationError, Dart core library API](https://api.dart.dev/stable/dart-core/LateInitializationError-class.html) -- o tipo de erro e o que o dispara.
