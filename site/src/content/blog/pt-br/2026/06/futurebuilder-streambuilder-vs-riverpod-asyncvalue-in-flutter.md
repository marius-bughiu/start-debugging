---
title: "FutureBuilder/StreamBuilder vs AsyncValue do Riverpod no Flutter: qual usar?"
description: "Use FutureBuilder ou StreamBuilder para um widget assincrono autocontido e descartavel. Recorra ao AsyncValue do Riverpod quando o resultado for compartilhado, cacheado ou mutado. Aqui esta a decisao, os detalhes traicoeiros e codigo executavel para ambos. Testado no Flutter 3.44 e flutter_riverpod 3.3.1."
pubDate: 2026-06-15
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "futurebuilder"
lang: "pt-br"
translationOf: "2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-15
---

Se voce esta decidindo entre os `FutureBuilder` / `StreamBuilder` integrados do Flutter e o `AsyncValue` do Riverpod, a resposta curta e: mantenha os builders para um widget unico e autocontido que possui um resultado assincrono descartavel, e migre para o `AsyncValue` do Riverpod no momento em que esse resultado for compartilhado entre telas, cacheado, atualizado ou mutado. Os builders nao sao "a versao para iniciantes" da mesma coisa. Eles sao uma primitiva de UI que se inscreve em um objeto assincrono. `AsyncValue` e um modelo de estado que vive fora da arvore de widgets. Este guia foi testado no Flutter 3.44 (estavel, 2026-05-18), Dart 3.12 e `flutter_riverpod` 3.3.1 (a linha 3.0 saiu em 2025-09-10).

## Eles resolvem problemas sobrepostos em camadas diferentes

`FutureBuilder` e `StreamBuilder` sao widgets. Voce passa para cada um deles um `Future` ou `Stream`, e ele entrega ao seu callback `builder` um `AsyncSnapshot<T>` que descreve o estado de conexao atual (waiting, active, done) mais os ultimos dados ou o erro. O widget se inscreve quando e inserido, cancela a inscricao quando e removido e se reinscreve se voce passar uma instancia diferente de `Future`/`Stream`. Esse e todo o contrato. Nao ha cache, nem compartilhamento, nem memoria do resultado depois que o widget sai da arvore.

O `AsyncValue<T>` do Riverpod nao e um widget de forma alguma. E uma uniao selada com tres subtipos (`AsyncData`, `AsyncLoading`, `AsyncError`) que um provider expoe como seu valor. O trabalho assincrono roda dentro de um provider que vive fora da arvore de widgets, entao qualquer widget pode le-lo, varios widgets podem ler a mesma instancia e o resultado sobrevive a reconstrucoes e a navegacao. Voce o renderiza com `value.when(...)` ou um `switch` do Dart 3, do mesmo jeito que voce renderiza um `AsyncSnapshot`, mas a fonte de verdade e um provider em vez de um campo do widget.

Entao a verdadeira pergunta nao e "qual renderiza tres estados melhor". Ambos renderizam tres estados bem. A pergunta e onde o resultado assincrono deve viver e quantas coisas precisam ve-lo.

## Matriz de recursos

| Aspecto | FutureBuilder / StreamBuilder (Flutter 3.44) | AsyncValue do Riverpod (flutter_riverpod 3.3.1) |
| --- | --- | --- |
| O que e | Um widget que se inscreve em um Future/Stream | Um tipo de estado selado exposto por um provider |
| Onde o resultado vive | No widget, morre quando o widget e desmontado | Em um provider, fora da arvore, sobrevive a navegacao |
| Compartilhar entre telas | Nao, cada builder reexecuta seu proprio trabalho | Sim, um provider lido por muitos widgets |
| Cache / dedup | Nenhum, voce memoiza o Future voce mesmo | Integrado, o provider cacheia ate invalidar |
| Disparo a cada reconstrucao | Sim, se o Future for criado no `build` | Nao, o `build` do provider roda uma vez ate invalidar |
| Loading + dados anteriores | Manual, o snapshot perde `data` enquanto aguarda | `value.isLoading` mantem `value` durante a atualizacao |
| Mutacoes / atualizacao | Reatribuir o Future e `setState` | `ref.invalidate` ou `AsyncValue.guard` em um notifier |
| Testar sem um widget | Dificil, precisa de `pumpWidget` | Facil, le o provider em um `ProviderContainer` simples |
| Dependencias | Zero, vem com o SDK | Pacote `flutter_riverpod` |
| Linhas de boilerplate para algo unico | Minimas | Mais configuracao para uma unica chamada descartavel |

## Quando FutureBuilder ou StreamBuilder e a escolha certa

Recorra aos builders integrados quando o resultado assincrono pertence genuinamente a um widget e ninguem mais precisa dele.

- **Um widget folha autocontido.** Um dialogo que carrega um registro, um tile que resolve a dimensao de uma imagem, uma linha de configuracoes que le uma unica preferencia. O trabalho comeca quando o widget aparece e e irrelevante depois que ele some. Envolver isso em um provider e cerimonia sem retorno.
- **Um stream que voce ja possui e quer renderizar diretamente.** Se voce tem um `Stream` de um plugin (um stream de posicao do `Geolocator`, um stream de status do `connectivity_plus`) e so o exibe em um lugar, `StreamBuilder` e o caminho mais direto. O `StreamBuilder` do Flutter 3.44 cuida do ciclo de vida de inscricao/cancelamento para voce.
- **Zero dependencias adicionadas.** Um app pequeno, um exemplo de codigo, um exemplo de pacote ou uma tela em uma base de codigo que deliberadamente evitou uma biblioteca de gerenciamento de estado. Os builders fazem parte do SDK, entao nao ha nada para adicionar.
- **Voce esta ensinando ou prototipando.** Os builders tornam o mapeamento de assincrono para UI visivel em um unico lugar. Essa clareza vale muito quando o objetivo e entender o ciclo de vida em vez de entregar um recurso.

Aqui esta a forma correta. O `Future` e criado uma vez no `initState`, nao no `build`, entao o widget nao refaz o fetch a cada reconstrucao do pai.

```dart
// Flutter 3.44, Dart 3.12
class UserCard extends StatefulWidget {
  const UserCard({super.key, required this.id});
  final String id;

  @override
  State<UserCard> createState() => _UserCardState();
}

class _UserCardState extends State<UserCard> {
  late Future<User> _user;

  @override
  void initState() {
    super.initState();
    _user = api.fetchUser(widget.id); // created ONCE, not in build
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<User>(
      future: _user,
      builder: (context, snapshot) {
        return switch (snapshot) {
          AsyncSnapshot(connectionState: ConnectionState.waiting) =>
            const CircularProgressIndicator(),
          AsyncSnapshot(hasError: true, :final error) =>
            Text('Failed: $error'),
          AsyncSnapshot(hasData: true, :final data?) =>
            Text(data.name),
          _ => const SizedBox.shrink(),
        };
      },
    );
  }
}
```

O bug mais comum com esse widget e criar o `Future` inline, como `future: api.fetchUser(widget.id)` diretamente no `build`. Cada reconstrucao entao aloca um novo `Future`, o `FutureBuilder` ve uma nova identidade e reinicia a partir do estado de loading. Esse modo de falha e comum o bastante para ter seu proprio artigo: veja [por que o FutureBuilder recria seu Future a cada reconstrucao](/pt-br/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/) para a reproducao completa e todas as variantes que o disparam.

## Quando o AsyncValue do Riverpod e a escolha certa

Migre para o `AsyncValue` quando o resultado assincrono deixa de ser um detalhe privado de um widget.

- **O resultado e compartilhado.** Duas telas mostram o mesmo perfil de usuario, ou um cabecalho e um corpo ambos leem o carrinho atual. Com builders, cada inscrito reexecuta o fetch. Com um provider, o trabalho roda uma vez e ambos os widgets leem o mesmo `AsyncValue`.
- **Voce precisa de cache e dedup.** O Riverpod cacheia o valor de um provider ate que algo o invalide. Navegue para fora e volte, e os dados ainda estao la em vez de piscar um spinner. A linha 3.0 ate adiciona `AsyncValue.isFromCache`, entao a UI pode distinguir os dados do servidor dos dados persistidos offline.
- **Voce muta e atualiza.** Um pull-to-refresh, uma atualizacao otimista, uma nova tentativa. `ref.invalidate(provider)` reexecuta a carga, e durante essa recarga `value.isLoading` e `true` enquanto `value.hasValue` permanece `true`, entao voce continua mostrando os dados antigos em vez de deixar a tela em branco. Fazer isso com `FutureBuilder` significa malabarismo com um `Future` armazenado, um `setState` e sua propria logica de "manter os dados anteriores".
- **Voce quer testar sem montar um widget.** A logica de um provider pode ser exercitada em um `ProviderContainer` simples sem `WidgetTester`, sem `pumpWidget` e sem um `BuildContext` falso.

O mesmo render de tres estados, agora com origem em um provider:

```dart
// Flutter 3.44, Dart 3.12, flutter_riverpod 3.3.1
final userProvider = FutureProvider.family<User, String>((ref, id) {
  return api.fetchUser(id); // runs once, cached per id, shared everywhere
});

class UserCard extends ConsumerWidget {
  const UserCard({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(userProvider(id));
    return switch (user) {
      AsyncData(:final value) => Text(value.name),
      AsyncError(:final error) => Text('Failed: $error'),
      _ => const CircularProgressIndicator(),
    };
  }
}
```

Dois widgets chamando `ref.watch(userProvider('42'))` compartilham um fetch e um resultado cacheado. Nao ha `initState`, nem campo armazenado, nem disciplina de "criar o Future uma vez" para lembrar, porque o provider ja roda seu `build` exatamente uma vez por argumento ate ser invalidado. Para o conjunto completo de estados, mutacoes com `AsyncValue.guard` e manter os dados anteriores na atualizacao, veja [como mostrar estados de loading e erro com AsyncValue](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## O comportamento de reconstrucao e refetch que de fato decide

O desempenho nao e o eixo aqui. Ambas as abordagens renderizam na mesma taxa de frames. O que difere e quantas vezes seu trabalho assincrono roda, e isso e uma questao de correcao e de custo, nao de velocidade bruta.

Coloque um contador dentro da chamada assincrona e observe o que acontece quando o widget ao redor se reconstroi (uma troca de tema, um teclado abrindo, um `setState` do pai):

- **Future criado no `build` com FutureBuilder**: o fetch dispara a cada reconstrucao. Uma tela que se reconstroi dez vezes durante um scroll faz dez chamadas de rede. Esse e o erro padrao, nao um caso limite.
- **Future elevado ao `initState` com FutureBuilder**: o fetch dispara uma vez por instancia de widget. Navegue para fora e volte, o widget e reconstruido do zero e refaz o fetch porque o antigo `State` nao existe mais.
- **FutureProvider com AsyncValue**: o fetch dispara uma vez por argumento de provider e e cacheado. Reconstrucoes nao o reexecutam. Navegar para fora e voltar le o cache. So reexecuta quando voce o invalida ou suas dependencias mudam.

Se seu trabalho assincrono e uma leitura local barata, nada disso importa e o builder ganha em simplicidade. Se e uma chamada de rede, uma consulta a banco de dados ou qualquer coisa com um custo ou um limite de taxa, o cache e toda a razao pela qual o `AsyncValue` existe, e reimplementar o mesmo comportamento na mao em torno do `FutureBuilder` reimplementa uma versao pior do cache de provider do Riverpod.

## O detalhe traicoeiro que decide por voce

Algumas restricoes resolvem a decisao independentemente do gosto.

**Voce ja esta usando Riverpod.** Se o app tem providers, nao misture `FutureBuilder` em uma tela que os le. Ler os dados de um provider e depois envolver um segundo `FutureBuilder` em torno de outra chamada assincrona te da dois ciclos de vida nao relacionados em uma tela e dois lugares onde "loading" pode ser true. Exponha a segunda chamada como um provider tambem e renderize ambos com `AsyncValue`. A consistencia aqui previne a classe de bug onde metade da tela fica desatualizada.

**O resultado precisa sobreviver ao widget.** Qualquer coisa buscada no `initState` morre com o `State`. Se o usuario navega para frente e volta e voce nao quer um spinner novo e uma chamada de rede nova toda vez, voce precisa de um cache que viva acima do widget. Isso e um provider. `FutureBuilder` nao pode te dar persistencia entre rotas nao importa como voce o organize.

**Voce toca `ref` depois de um await.** Essa e uma armadilha especifica do Riverpod, nao um motivo para evita-lo: se voce faz `await` dentro de um notifier e depois le `ref` depois que o widget que o disparou nao existe mais, voce encontra `Cannot use "ref" after the widget was disposed`. A correcao e capturar o que voce precisa antes do await. Vale a pena saber antes de se comprometer, e isso e coberto em [a correcao para usar ref apos o descarte](/pt-br/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/).

**Voce quer explicitamente zero dependencias.** Um exemplo de pacote pub, um caso de reproducao ou uma politica de equipe contra bibliotecas de gerenciamento de estado forca os builders. Essa e uma restricao legitima, e os builders sao perfeitamente capazes para UI assincrona autocontida.

## StreamBuilder tem um detalhe extra

Tudo acima se aplica ao trabalho com `Future`. Streams adicionam um ciclo de vida de inscricao, e isso inclina a decisao um pouco mais para o Riverpod em qualquer coisa nao trivial. `StreamBuilder` se reinscreve quando voce passa uma nova instancia de `Stream` e cancela a inscricao quando sai da arvore, mas nao faz multicast: dois `StreamBuilder` sobre o mesmo stream de inscricao unica vao lancar um erro, porque um `Stream` de inscricao unica permite apenas um listener. O `StreamProvider` do Riverpod fica na frente do stream, entao varios widgets leem um `AsyncValue` sem brigar pela inscricao, e o ultimo valor e cacheado para inscritos tardios. Se um stream e exibido em exatamente um lugar, `StreamBuilder` esta bem. Se mais de um widget precisa dele, `StreamProvider` elimina o problema do listener unico por completo.

## A recomendacao, com todo o contexto por tras

Por padrao, use o `AsyncValue` do Riverpod para qualquer resultado assincrono que seja compartilhado, cacheado, atualizado ou mutado, que em um app real e a maioria deles. Voce obtem um fetch em vez de N, cache gratis entre navegacoes, um `isLoading` que preserva os dados anteriores na atualizacao e logica que voce pode testar sem um widget. Mantenha `FutureBuilder` e `StreamBuilder` para UI assincrona genuinamente autocontida e descartavel: um widget folha que carrega uma coisa, mostra e esquece ao ser desmontado, especialmente em apps que nao carregam nenhuma dependencia de gerenciamento de estado. Os builders nao sao rodinhas que voce supera. Eles sao a ferramenta certa quando o resultado assincrono tem uma audiencia de um, e a ferramenta errada no momento em que tem uma audiencia de dois. Escolha por propriedade, nao por familiaridade.

Se voce ainda esta escolhendo uma abordagem de gerenciamento de estado de forma mais ampla, os trade-offs entre pacotes estao em [Provider vs Riverpod vs Bloc para gerenciamento de estado no Flutter em 2026](/pt-br/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/). E se sua UI assincrona continua expondo falhas, [como lidar com erros de rede com elegancia em um app Flutter](/pt-br/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) cobre como transformar excecoes lancadas em um estado de erro limpo em ambos os modelos.

## Fontes

- [Classe FutureBuilder, documentacao da API do Flutter](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html)
- [Classe StreamBuilder, documentacao da API do Flutter](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html)
- [Classe AsyncValue, documentacao da API do flutter_riverpod](https://pub.dev/documentation/flutter_riverpod/latest/flutter_riverpod/AsyncValue-class.html)
- [Novidades no Riverpod 3.0](https://riverpod.dev/docs/whats_new)
- [Changelog do riverpod no pub.dev](https://pub.dev/packages/riverpod/changelog)
