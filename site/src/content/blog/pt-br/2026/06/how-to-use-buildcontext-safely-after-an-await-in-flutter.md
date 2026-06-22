---
title: "Como usar BuildContext com segurança depois de um await no Flutter"
description: "Capture o que você precisa do context antes do await e proteja a retomada com if (context.mounted) return. Aqui está o padrão completo, a regra do linter que o exige e os casos extremos que ela não pega."
pubDate: 2026-06-22
tags:
  - "flutter"
  - "dart"
  - "async"
lang: "pt-br"
translationOf: "2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-22
---

A regra é curta: um `BuildContext` só é válido enquanto seu widget está montado, e um `await` pode desmontar o widget antes que seu código retome. Por isso, capture tudo o que você precisa do context (um `NavigatorState`, um `ScaffoldMessengerState`, um valor de tema) antes do primeiro `await`, faça o trabalho assíncrono e proteja a retomada com `if (!context.mounted) return;` antes de tocar no context novamente. Esse único hábito previne toda a família de falhas do tipo "usei um context depois que ele saiu da árvore". Este guia usa Flutter 3.44 (estável, maio de 2026) e Dart 3.x.

Um `BuildContext` não é uma sacola de dados que você pode guardar e reutilizar. É um handle vivo para um `Element` na árvore de widgets. No momento em que o usuário navega para outra tela, o pai reconstrói você até desaparecer ou a rota é fechada, esse elemento é desativado e depois descartado. Ler um ancestral de um elemento morto (`Navigator.of`, `Theme.of`, `Provider.of`) é comportamento indefinido: em depuração você recebe uma asserção, em release você recebe um valor obsoleto ou uma desreferência nula muito mais tarde. O caso assíncrono é o que mais machuca porque o vão entre "o context era válido" e "o context é usado" é invisível no código-fonte: ele se esconde dentro do `await`.

## Por que o await é a parte perigosa

O Flutter chama `build` de forma síncrona e espera que ele termine antes que qualquer outra coisa toque a árvore. Enquanto seu código roda de forma síncrona a partir de um manipulador de eventos, o context continua válido o tempo todo. No instante em que você faz `await`, você devolve o controle ao loop de eventos. Outros frames rodam. O usuário pode tocar no botão de voltar, um `StreamBuilder` pai pode se reconstruir, um timeout pode disparar um fechamento de rota. Quando sua continuação retoma, você está em um frame posterior, e o widget que possuía `context` pode ter desaparecido.

```dart
// Flutter 3.44, Dart 3.x -- the gap is invisible but real
Future<void> _onSave() async {
  await api.save(form);            // <-- control leaves here, frames run
  Navigator.of(context).pop();     // <-- may execute on a dead context
}
```

Nada em `_onSave` parece errado. O bug é estrutural: `context` foi capturado de forma implícita no ponto da chamada e reutilizado através de um ponto de suspensão. Esta é exatamente a situação que o [falha na busca do ancestral de um widget desativado](/pt-br/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) descreve pelo lado da mensagem de erro. Aqui estamos olhando pelo lado da prevenção.

## O padrão seguro, passo a passo

Siga estes quatro passos sempre que um método assíncrono precisar de um context depois de se suspender. Os dois primeiros são os que sustentam tudo; o resto é como você os mantém honestos.

1. **Leia tudo do context antes do primeiro `await`.** Resolva `Navigator.of(context)`, `ScaffoldMessenger.of(context)`, `Theme.of(context)` e qualquer chamada a `Provider.of`/`context.read` em variáveis locais enquanto o widget ainda está montado. Elas retornam objetos de estado de longa duração que continuam válidos mesmo depois que o elemento de origem morre.
2. **Faça o trabalho assíncrono.** Agora o `await` pode demorar o quanto quiser. Você não está segurando o context ao longo dele; você está segurando os objetos de estado resolvidos, que sobrevivem ao elemento.
3. **Proteja a retomada com uma verificação de mounted.** Imediatamente após o `await`, escreva `if (!context.mounted) return;` (ou `if (!mounted) return;` dentro de um `State`). Se o widget saiu da árvore durante o await, você para aqui e nunca toca em um context morto.
4. **Use apenas os objetos capturados depois do vão.** Chame `navigator.pop()` e `messenger.showSnackBar(...)` nas variáveis locais que você capturou no passo 1, não em `Navigator.of(context)` de novo.

Aplicado ao exemplo defeituoso:

```dart
// Flutter 3.44, Dart 3.x -- safe
Future<void> _onSave() async {
  final navigator = Navigator.of(context);          // 1. capture
  final messenger = ScaffoldMessenger.of(context);

  await api.save(form);                              // 2. async work

  if (!context.mounted) return;                      // 3. guard

  messenger.showSnackBar(                            // 4. use captures
    const SnackBar(content: Text('Saved')),
  );
  navigator.pop();
}
```

Duas coisas independentes tornam isso correto. Capturar `navigator` e `messenger` antes do await significa que você nunca chama `.of(context)` em um elemento desativado. A verificação de `context.mounted` então pula o trabalho de UI por completo quando o usuário já saiu, que quase sempre é o comportamento que você quer: não faz sentido mostrar um snackbar em uma tela que ninguém está olhando.

## mounted em State versus mounted em BuildContext

Existem dois getters `mounted` e eles não são intercambiáveis quanto a onde você recorre a eles, embora respondam à mesma pergunta.

`State.mounted` existe desde sempre. Dentro da classe de estado de um `StatefulWidget`, escreva `if (!mounted) return;`. Ele é `true` entre `initState` e `dispose`, e, crucialmente, já é `false` durante `deactivate`, então captura corretamente o caso de "o widget está saindo", não apenas o de "o widget está totalmente morto".

`BuildContext.mounted` chegou no Flutter 3.7 (Dart 2.19) para o caso em que você só tem um context, não um `State`: funções auxiliares, callbacks em um `StatelessWidget`, métodos de extensão. Ele retorna se o elemento subjacente ainda está montado.

```dart
// Flutter 3.44, Dart 3.x
// Inside a State subclass:
if (!mounted) return;          // State.mounted

// In a helper that only has a context:
if (!context.mounted) return;  // BuildContext.mounted
```

Prefira `State.mounted` quando estiver dentro de uma classe de estado, porque ele lê o ciclo de vida do widget que você de fato possui. Use `context.mounted` quando um context é tudo o que você tem. Ambos devem ser verificados *depois* do await, nunca antes: o vão é o await, então uma verificação que roda antes dele não diz nada sobre o estado posterior.

## Por que capturar sozinho não basta, e proteger sozinho não basta

As pessoas frequentemente fazem uma das duas metades e supõem que estão cobertas. Não estão.

Se você só **captura** mas pula a proteção, você evita a falha do context desativado, mas ainda pode rodar efeitos colaterais de UI contra uma tela que o usuário já abandonou: um snackbar que pisca na rota errada, um `pop()` que fecha uma rota que não é mais a sua. Capturar torna a chamada legal; a proteção a torna *correta*.

Se você só **protege** mas pula a captura, você tem um bug sutil de ordem. Considere:

```dart
// Flutter 3.44, Dart 3.x -- still wrong despite the guard
Future<void> _onSave() async {
  await api.save(form);
  if (!context.mounted) return;
  Navigator.of(context).pop();   // re-reads context AFTER the gap
}
```

Isso geralmente funciona, porque a verificação de `context.mounted` passou no mesmo tick síncrono que a chamada a `Navigator.of`. Mas é frágil: se você adicionar um segundo `await` entre a verificação e a busca, a janela reabre. O padrão de capturar primeiro remove a busca do caminho pós-await por completo, então não sobra nada que possa ficar obsoleto. Trate "capturar antes, proteger depois, usar as capturas" como um único movimento indivisível.

## A regra do linter que o exige: use_build_context_synchronously

O Dart inclui uma regra do linter, `use_build_context_synchronously`, que sinaliza um `BuildContext` usado depois de um vão assíncrono sem uma proteção de `mounted` entre o await e o uso. Ela está habilitada por padrão no pacote `flutter_lints`, que os novos projetos Flutter incluem via `analysis_options.yaml`:

```yaml
# analysis_options.yaml -- on by default in flutter_lints
include: package:flutter_lints/flutter.yaml
```

Se o seu projeto é anterior ao padrão ou você removeu o include, adicione a regra explicitamente:

```yaml
# analysis_options.yaml
linter:
  rules:
    use_build_context_synchronously: true
```

A regra entende a proteção. Escrever `if (!context.mounted) return;` (ou `if (context.mounted) { ... }`) depois do await elimina o aviso, porque o analisador consegue provar que o context está vivo no caminho que o usa. É por isso que a forma canônica é `if (context.mounted)` e não algum equivalente que você escreveu à mão: o linter faz correspondência de padrões com as formas conhecidas como seguras. Versões anteriores do analisador até produziam um falso positivo quando `BuildContext.mounted` era usado fora da forma literal `if (context.mounted) {}`, registrado na lista de issues do SDK do Dart; as versões atuais lidam com as formas comuns, mas é mais um motivo para se ater à proteção idiomática.

O que o linter **não** pega é igualmente importante. É uma verificação sintática, então não consegue enxergar através dos limites das funções. Se você passar um `BuildContext` para uma função auxiliar e fizer `await` dentro dela, o analisador muitas vezes não consegue conectar o vão ao uso posterior. Ele também não vai salvar você de uma lógica que captura um context em um campo e o reutiliza muito mais tarde. O linter é uma forte primeira linha de defesa, não uma prova.

## Passar um context para uma função auxiliar

Uma saída frequente do linter é mover o await para uma função auxiliar que recebe `BuildContext` como parâmetro. O padrão é aceitável, mas a função auxiliar agora assume a responsabilidade da proteção, e deve reverificar `mounted` ela mesma em vez de confiar em quem a chama.

```dart
// Flutter 3.44, Dart 3.x -- the helper guards its own context use
Future<void> confirmAndDelete(BuildContext context, Item item) async {
  final messenger = ScaffoldMessenger.of(context);

  final ok = await showDialog<bool>(
    context: context,
    builder: (_) => const ConfirmDialog(),
  );

  if (ok != true) return;
  if (!context.mounted) return;   // guard inside the helper

  await repository.delete(item);
  if (!context.mounted) return;   // second await, second guard

  messenger.showSnackBar(const SnackBar(content: Text('Deleted')));
}
```

Dois awaits significam duas proteções. Cada ponto de suspensão reabre a janela, então uma verificação de `mounted` cabe depois de cada um que preceda um uso do context, não apenas do primeiro. Capturar `messenger` de antemão significa que a última linha nunca relê o context.

## Loops, retentativas e múltiplos awaits

Onde quer que um uso do context fique depois de mais de uma possível suspensão, audite cada caminho. Um loop de retentativas é o caso de manual:

```dart
// Flutter 3.44, Dart 3.x
Future<void> _uploadWithRetry() async {
  final messenger = ScaffoldMessenger.of(context);

  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      await api.upload(file);     // suspension point inside the loop
      break;
    } catch (_) {
      if (attempt == 3) rethrow;
      await Future<void>.delayed(const Duration(seconds: 1)); // another one
    }
  }

  if (!context.mounted) return;   // single guard after the loop is enough
  messenger.showSnackBar(const SnackBar(content: Text('Uploaded')));
}
```

Aqui você não precisa de uma proteção dentro do loop porque nada dentro do loop toca o context; o único uso do context é depois dele, então uma única proteção cobre todos os caminhos de saída. O princípio se generaliza: coloque a proteção imediatamente antes de cada uso do context, depois do último await que possa precedê-lo. Recorrer a uma abordagem estruturada como o [tratamento elegante de erros e carregamento](/pt-br/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) mantém esses fluxos legíveis, porque os estados de retentativa e de erro viram dados que seu widget renderiza em vez de chamadas imperativas de UI espalhadas depois dos awaits.

## StatelessWidget não tem mounted, então use o context

Um `StatelessWidget` não tem `State`, então não há campo `mounted`. Use `context.mounted`, que é exatamente para o que ele existe:

```dart
// Flutter 3.44, Dart 3.x -- StatelessWidget callback
ElevatedButton(
  onPressed: () async {
    final navigator = Navigator.of(context);
    await Future<void>.delayed(const Duration(seconds: 1));
    if (!context.mounted) return;
    navigator.pop();
  },
  child: const Text('Close'),
);
```

Se você se vê precisando de várias proteções nos callbacks de um widget sem estado, isso costuma ser sinal de que o widget deveria ser stateful, ou de que o trabalho assíncrono pertence a um controlador ou notifier em vez de ficar embutido no manipulador do botão.

## Armadilhas e casos parecidos

**`Navigator.pop` e depois um uso do context.** Um clássico de duas linhas: `Navigator.pop(context)` seguido de outra chamada a `.of(context)`. O pop começa a desativar o elemento da rota, então a segunda busca pode falhar mesmo sem nenhum await à vista. Capture o navigator (e qualquer outra coisa) antes de fechar.

**`initState` não pode fazer buscas de inherited.** `Theme.of`, `MediaQuery.of` e qualquer `dependOnInheritedWidgetOfExactType` são ilegais em `initState` porque o elemento ainda não está conectado às suas dependências herdadas. Mova essas leituras para `didChangeDependencies`, onde o context é totalmente válido. Essa é uma asserção diferente da assíncrona, mas decorre da mesma pergunta "o context é válido agora mesmo?".

**Builds de release escondem a falha.** A asserção do context desativado só dispara em depuração. Em profile e release a busca retorna null e você recebe um `Null check operator used on a null value` em algum ponto mais abaixo. Se uma falha aparece só em release e só depois de navegar, suspeite de um uso do context pós-await sem proteção. A [proteção de setState chamado durante build](/pt-br/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) tem o mesmo caráter de asserção só em depuração.

**O equivalente no Riverpod.** Se você tem um `WidgetRef` em vez de um `BuildContext`, a falha equivalente é [Cannot use "ref" after the widget was disposed](/pt-br/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/). Mesma causa raiz, mesma solução: ler antes do await, proteger depois. Modelar o trabalho assíncrono como [estados de carregamento e erro com AsyncValue](/pt-br/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) evita a maioria das proteções manuais, porque o framework rastreia o ciclo de vida do widget por você e você para de mexer no context na mão.

**Timers e listeners de streams.** Um context usado em um `Timer`, um `Stream.listen` ou um listener de estado de animação pode disparar depois que o widget já se foi. Proteja com `mounted`, e também cancele a fonte em `dispose` para que o callback pare de disparar de vez, a mesma disciplina que você aplica quando [descarta controladores para evitar vazamentos](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

## O único hábito que aposenta toda essa classe de erro

Trate um `BuildContext` como válido apenas do início de uma execução síncrona até o próximo `await`. Antes de se suspender, extraia os objetos de estado que você vai precisar. Depois de retomar, verifique `mounted` antes de tocar em qualquer coisa atada à árvore. Faça isso de forma mecânica e a falha do ancestral desativado, a falha do controlador descartado e a desreferência nula pós-await deixam de aparecer, porque nunca foram três bugs. Eram uma regra, quebrada de três maneiras.

## Fontes

- [Regra do linter use_build_context_synchronously](https://dart.dev/tools/linter-rules/use_build_context_synchronously), regras do linter do Dart, que define o que o analisador sinaliza e as formas de proteção que ele reconhece.
- [Propriedade BuildContext.mounted](https://api.flutter.dev/flutter/widgets/BuildContext/mounted.html), documentação da API do Flutter (adicionada no Flutter 3.7).
- [Propriedade State.mounted](https://api.flutter.dev/flutter/widgets/State/mounted.html), documentação da API do Flutter.
- [flutter/flutter#19462](https://github.com/flutter/flutter/issues/19462), o issue canônico que rastreia a falha do context desativado até os callbacks assíncronos.
