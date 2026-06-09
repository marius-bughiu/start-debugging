---
title: "Como inicializar um Future para que o FutureBuilder nao o recrie a cada reconstrucao no Flutter"
description: "O FutureBuilder reexecuta seu trabalho assincrono toda vez que o pai reconstroi porque voce criou o Future dentro do build. Mova-o para State.initState (ou memoize-o) e o FutureBuilder reutilizara o mesmo Future. Aqui esta o porque, o caso reproduzivel e cada variante que morde."
pubDate: 2026-06-09
template: how-to
tags:
  - "flutter"
  - "dart"
  - "futurebuilder"
  - "how-to"
lang: "pt-br"
translationOf: "2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-09
---

Se o seu `FutureBuilder` pisca de volta para o indicador de carregamento, recupera dados novamente ou dispara a mesma chamada de rede varias vezes, a causa quase sempre e que voce criou o `Future` dentro do `build`. Cada reconstrucao do widget ao redor entao chama `build` novamente, constroi um `Future` totalmente novo, e o `FutureBuilder` o reinicia obedientemente. A solucao e criar o `Future` exatamente uma vez, armazena-lo em um campo do seu `State` e passar esse campo armazenado para o `FutureBuilder`. Este guia usa Flutter 3.44 (estavel, maio de 2026) e Dart 3.x.

A equipe do Flutter e explicita sobre isso na [documentacao da API FutureBuilder](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html): "The future must have been obtained earlier, e.g. during State.initState, State.didUpdateWidget, or State.didChangeDependencies. It must not be created during the State.build or StatelessWidget.build method call when constructing the FutureBuilder." A razao vem logo em seguida: "If the future is created at the same time as the FutureBuilder, then every time the FutureBuilder's parent is rebuilt, the asynchronous task will be restarted." Esse e o bug inteiro, declarado pelo proprio framework.

## Por que um Future novo reinicia tudo

O `FutureBuilder` nao rastreia "a operacao que voce queria executar". Ele rastreia um objeto `Future` especifico por identidade. Em `didUpdateWidget`, ele compara `oldWidget.future` com o novo `widget.future`. Se nao forem a mesma instancia, ele descarta a assinatura antiga, redefine seu `AsyncSnapshot` para `ConnectionState.waiting` (ou `none`) e assina o novo. Nao ha deduplicacao baseada em valor nem memoizacao embutida. A identidade e o unico sinal que ele tem.

Agora pense no que o `build` faz. Chamar `algo()` que retorna um `Future` produz uma nova instancia de `Future` a cada invocacao, mesmo que o trabalho subjacente seja identico. `Future.delayed(...)`, `http.get(...)`, `repository.load()`: cada chamada aloca um objeto distinto. Entao, se o argumento `future:` e uma expressao avaliada dentro do `build`, o `FutureBuilder` ve uma identidade diferente a cada frame e conclui, corretamente pelas suas proprias regras, que voce lhe entregou uma nova tarefa.

E o `build` roda muito mais frequentemente do que as pessoas esperam. Um `setState` do pai, um widget herdado que muda (`MediaQuery` na rotacao, `Theme` ao alternar o brilho), um `Scaffold` que abre um teclado, uma animacao ancestral, um hot reload: qualquer um desses reconstroi seu widget e reavalia a expressao `future:`. O trabalho assincrono nao e lento nem esta quebrado. Ele e descartado e reiniciado do zero toda vez.

## Um caso reproduzivel minimo que recupera novamente a cada reconstrucao

Aqui esta o antipadrao em sua forma mais pura. O `Future` e construido em linha dentro do `build`, e um contador forca reconstrucoes para que voce possa ve-lo se comportar mal.

```dart
// Flutter 3.44, Dart 3.x
// BROKEN: future is created inside build()
class ProfilePage extends StatefulWidget {
  const ProfilePage({super.key});
  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  int _counter = 0;

  Future<String> _loadName() async {
    // Pretend this is a network call.
    await Future<void>.delayed(const Duration(seconds: 2));
    return 'Marius';
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        FutureBuilder<String>(
          // New Future every build -> restarts every rebuild.
          future: _loadName(),
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const CircularProgressIndicator();
            }
            return Text('Hello, ${snapshot.data}');
          },
        ),
        ElevatedButton(
          onPressed: () => setState(() => _counter++),
          child: Text('Rebuilt $_counter times'),
        ),
      ],
    );
  }
}
```

Toque o botao. Cada toque chama `setState`, que chama `build`, que chama `_loadName()` novamente, que retorna um novo `Future` de dois segundos. O indicador volta a cada toque. Em um app real onde `_loadName()` e uma requisicao HTTP, voce acabou de transformar uma recuperacao em uma-recuperacao-por-reconstrucao, e o usuario ve a tela piscar em branco repetidamente. Este e o mesmo tipo de erro que [chamar setState durante o build](/pt-br/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/): fazer no `build` um trabalho que o `build` nao tem permissao de possuir.

## A solucao, passo a passo

Mova o `Future` para fora do `build` e para um campo que e inicializado exatamente uma vez.

1. **Converta o widget em um `StatefulWidget`** se ele ja nao for um. Um `StatelessWidget` nao tem `initState` nem um lugar para reter um `Future` de forma duravel, entao nao pode satisfazer a regra de "obtido antes". (Mais sobre o caso sem estado abaixo.)
2. **Declare um campo `late final Future<T>`** na classe `State`. `late final` permite atribui-lo em `initState` e garante que ele e escrito exatamente uma vez.
3. **Atribua o campo em `initState`**, chamando ali seu metodo assincrono em vez de no `build`. `initState` roda uma unica vez durante a vida do `State`, nao importa quantas vezes o widget reconstrua.
4. **Passe o campo armazenado para o `FutureBuilder`**, nunca uma chamada em linha. O argumento `future:` se torna uma referencia de campo simples sem parenteses.
5. **Verifique com uma reconstrucao forcada**: dispare `setState` repetidamente e confirme que o indicador nao volta e o trabalho nao roda novamente.

Aplicado ao caso reproduzivel:

```dart
// Flutter 3.44, Dart 3.x
// FIXED: future is created once in initState
class _ProfilePageState extends State<ProfilePage> {
  late final Future<String> _nameFuture;
  int _counter = 0;

  @override
  void initState() {
    super.initState();
    _nameFuture = _loadName(); // created exactly once
  }

  Future<String> _loadName() async {
    await Future<void>.delayed(const Duration(seconds: 2));
    return 'Marius';
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        FutureBuilder<String>(
          future: _nameFuture, // same instance every build
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const CircularProgressIndicator();
            }
            return Text('Hello, ${snapshot.data}');
          },
        ),
        ElevatedButton(
          onPressed: () => setState(() => _counter++),
          child: Text('Rebuilt $_counter times'),
        ),
      ],
    );
  }
}
```

Agora o botao incrementa o contador, `build` roda novamente, mas `future: _nameFuture` aponta para a instancia identica de `Future` criada antes em `initState`. `FutureBuilder.didUpdateWidget` ve que `oldWidget.future == widget.future`, mantem sua assinatura existente e nunca redefine o snapshot. A recuperacao acontece uma vez. Este e o padrao canonico e cobre a grande maioria dos casos reais.

## Quando o Future depende de um parametro do widget

A abordagem do `initState` tem uma aresta afiada: `initState` nao pode ver um novo valor de `widget`. Se o seu `Future` depende de um `widget.userId` que o pai pode mudar, inicializar apenas em `initState` significa que os dados ficam desatualizados quando o pai passa um id diferente, porque o objeto `State` e reutilizado atraves dessa mudanca.

A propria lista de lugares aprovados do framework ja nomeou a resposta: `State.didUpdateWidget`. Recrie o `Future` ali, mas apenas quando a entrada relevante realmente mudou, para nao reintroduzir o reinicio a cada reconstrucao.

```dart
// Flutter 3.44, Dart 3.x
class _UserPageState extends State<UserPage> {
  late Future<User> _userFuture;

  @override
  void initState() {
    super.initState();
    _userFuture = _fetchUser(widget.userId);
  }

  @override
  void didUpdateWidget(covariant UserPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Only refetch when the id genuinely changed.
    if (oldWidget.userId != widget.userId) {
      _userFuture = _fetchUser(widget.userId);
    }
  }

  Future<User> _fetchUser(String id) async {
    // ...network call keyed by id...
    return User(id: id);
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<User>(
      future: _userFuture,
      builder: (context, snapshot) {
        // ...render data / loading / error...
        return const SizedBox.shrink();
      },
    );
  }
}
```

A guarda `if (oldWidget.userId != widget.userId)` e todo o ponto. Sem ela voce recuperaria novamente a cada reconstrucao do pai, apenas uma camada mais distante do erro original. Se o seu `Future` depende de um `InheritedWidget` (um valor lido via `context.dependOnInheritedWidgetOfExactType`, como um `Locale` ou um escopo de provedor), use `didChangeDependencies` com a mesma guarda de deteccao de mudanca, ja que esse e o callback que o Flutter dispara quando uma dependencia herdada muda.

## Forcar uma recarga deliberada

Mover o `Future` para um campo levanta uma pergunta obvia: como recarregar de proposito, por exemplo em puxar-para-atualizar? Reatribua o campo dentro de `setState`. Isso da ao `FutureBuilder` uma nova identidade exatamente quando voce pretende.

```dart
// Flutter 3.44, Dart 3.x
void _refresh() {
  setState(() {
    _nameFuture = _loadName(); // new instance, intentional restart
  });
}
```

Esta e a versao controlada do padrao quebrado: o novo `Future` e criado em resposta a uma acao do usuario, nao como efeito colateral de uma reconstrucao nao relacionada. Combine-o com um `RefreshIndicator` cujo `onRefresh` retorne o novo future para que o indicador permaneca ate a recuperacao resolver. Enquanto voce conecta a recarga, decida como o builder representa uma recarga falha; os padroes de [tratar erros de rede com elegancia em um app Flutter](/pt-br/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) se aplicam diretamente ao ramo `snapshot.hasError`.

## Memoizar sem escrever o codigo repetitivo de initState

Se voce mantem muitos desses e a cerimonia de `initState` mais `didUpdateWidget` te incomoda, o `AsyncMemoizer` do pacote `async` a colapsa: ele executa um callback no maximo uma vez e retorna o mesmo `Future` em chamadas subsequentes, entao mesmo uma chamada em linha no `build` resolve para uma unica operacao subjacente.

```dart
// Flutter 3.44, Dart 3.x
// package: async ^2.11
import 'package:async/async.dart';

class _CatalogPageState extends State<CatalogPage> {
  final _memoizer = AsyncMemoizer<List<Item>>();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<Item>>(
      // runOnce returns the SAME future after the first call.
      future: _memoizer.runOnce(() => _repository.loadItems()),
      builder: (context, snapshot) => const SizedBox.shrink(),
    );
  }
}
```

`runOnce` executa seu callback na primeira vez e cacheia o `Future` resultante; chamadas posteriores ignoram o novo callback e retornam o cacheado. O memoizer ainda vive no `State`, entao compartilha as mesmas garantias de vida que um campo `late final`. Para o caso dependente de parametros voce teria que associar um memoizer novo por id, o que e mais contabilidade do que `didUpdateWidget`, entao recorra ao `AsyncMemoizer` principalmente quando a operacao nao tem entradas.

## Por que um StatelessWidget nao pode consertar isso

Um `StatelessWidget` nao tem `initState`, nem `State`, nem um lugar estavel para guardar um `Future`. Qualquer campo que voce adicione e recriado quando o pai reconstroi o widget, porque o Flutter descarta e reconstroi instancias de `StatelessWidget` livremente. Entao a regra de "cria-lo antes" e insatisfativel em um `StatelessWidget`: o mais cedo que voce pode criar o `Future` e no `build`, que e exatamente o lugar que a documentacao proibe. Se voce se pega querendo um `Future` de vida longa dentro de um `StatelessWidget`, esse e o sinal para promove-lo a um `StatefulWidget` ou elevar o `Future` para uma camada de gerenciamento de estado que sobreviva ao widget por completo.

Essa segunda opcao e cada vez mais a idiomatica. Um `FutureProvider` ou `AsyncNotifier` do Riverpod cacheia seu `Future` por voce e so recalcula quando uma dependencia muda, o que remove a danca manual do `initState` e sobrevive as reconstrucoes do widget e ate as mudancas de rota. Se voce esta escolhendo uma abordagem de longo prazo em vez de remendar uma tela, os trade-offs estao expostos em [Provider vs Riverpod vs Bloc para gerenciamento de estado no Flutter em 2026](/pt-br/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/), e a representacao de tres estados que voce obtem do `AsyncValue` de um provedor e coberta em [mostrar estados de carregamento e erro com AsyncValue no Flutter Riverpod](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## Dois gotchas relacionados que o padrao de campo nao resolve

Mover o `Future` conserta o reinicio, mas dois problemas adjacentes sobrevivem. Primeiro, um `FutureBuilder` dentro de uma lista rolavel que usa `AutomaticKeepAliveClientMixin` de forma incorreta ainda pode reconstruir quando a linha volta a vista; o campo `Future` protege os dados, mas garanta que o estado da linha em si seja mantido vivo se voce quiser evitar um piscar de reconstrucao. Segundo, um `Future` que completa depois que o widget se foi tentara entregar em um `State` ja descartado. O proprio `FutureBuilder` se protege internamente contra `setState`-apos-descarte, mas se o seu metodo assincrono toca outros controladores quando resolve, voce ainda pode encontrar erros de ciclo de vida. A disciplina de descarte de [descartar controladores no Flutter para evitar vazamentos de memoria](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) e o habito complementar: possua cada recurso que voce cria e libere-o em `dispose`.

O modelo mental para reter: o `FutureBuilder` e um adaptador fino que observa um `Future` por identidade. E seu trabalho tornar essa identidade estavel. Crie o `Future` em `initState`, atualize-o em `didUpdateWidget` ou `didChangeDependencies` apenas quando uma entrada mudou, e reatribua-o em `setState` apenas quando o usuario pediu dados frescos. Faca isso e o indicador aparece exatamente uma vez, a rede e acessada exatamente uma vez, e a tela para de piscar.

## Fontes

- [FutureBuilder class - widgets library](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html): a regra "must have been obtained earlier" e o aviso de reinicio, citados acima.
- [State.initState method](https://api.flutter.dev/flutter/widgets/State/initState.html): roda uma vez por vida do State.
- [State.didUpdateWidget method](https://api.flutter.dev/flutter/widgets/State/didUpdateWidget.html): o gancho para reagir a configuracao alterada do widget.
- [AsyncMemoizer class - async package](https://pub.dev/documentation/async/latest/async/AsyncMemoizer-class.html): executa um callback no maximo uma vez.
