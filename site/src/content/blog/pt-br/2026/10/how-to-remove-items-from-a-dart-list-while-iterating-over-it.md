---
title: "Como remover itens de uma List em Dart enquanto você itera sobre ela sem um ConcurrentModificationError"
description: "Chamar remove dentro de um loop for-in ou de forEach lança ConcurrentModificationError. Use removeWhere para filtrar no lugar, crie uma lista nova com where ou um collection-for, ou percorra o índice de trás para frente. Verificado no Dart 3.13.7, com um benchmark mostrando por que removeAt em um loop é a opção lenta."
pubDate: 2026-10-25
template: how-to
tags:
  - "dart"
  - "flutter"
  - "collections"
  - "errors"
lang: "pt-br"
translationOf: "2026/10/how-to-remove-items-from-a-dart-list-while-iterating-over-it"
translatedBy: "claude"
translationDate: 2026-10-25
---

**Resposta curta:** você não pode chamar `remove`, `removeAt` ou `add` em uma `List` enquanto um loop `for (final x in list)` ou `list.forEach` está percorrendo essa lista, porque o iterador confere o tamanho da lista a cada passo e lança `ConcurrentModificationError` assim que ele muda. Troque o loop por `list.removeWhere((x) => condition)` para filtrar no lugar, ou crie uma lista nova com `list.where((x) => !condition).toList()` (ou um collection-for) quando quiser uma atualização imutável. Se você realmente precisa de um loop por índice, percorra de trás para frente, de `list.length - 1` até `0`. Tudo abaixo foi executado no Dart 3.13.7 (o SDK que vem com o Flutter 3.47.8), na VM, como AOT e compilado para JavaScript.

## O erro em contexto

Este é o código que quase todo mundo escreve primeiro:

```dart
// Dart 3.13.7
void main() {
  final numbers = [1, 2, 3];
  for (final n in numbers) {
    if (n == 1) numbers.remove(n);
  }
}
```

E isto é o que a VM imprime:

```
Unhandled exception:
Concurrent modification during iteration: Instance(length:2) of '_GrowableList'.
#0      ListIterator.moveNext (dart:_internal/iterable.dart:366:7)
#1      main (file:///.../main.dart:4:19)
```

O `length:2` na mensagem é o tamanho da lista *depois* da sua modificação, e `_GrowableList` é a classe de implementação da VM para um literal `[]` comum. Na web o mesmo código falha com `Concurrent modification during iteration: Instance of 'JSArray<int>'.`, então não procure `_GrowableList` nos seus logs se o relato do bug veio de um build do Flutter web. Maps e sets produzem suas próprias variantes, `_Map len:2.` e `_Set len:2.`, com a mesma causa raiz.

## Por que o iterador lança um erro em vez de simplesmente pular

Um loop `for-in` sobre uma `List` é açúcar sintático para pegar `list.iterator` e chamar `moveNext()` até ele retornar `false`. O iterador que o Dart usa para listas, `ListIterator` em `dart:_internal`, guarda o tamanho da lista quando é criado e compara esse valor a cada `moveNext()`:

```dart
// dart:_internal, sdk/lib/internal/iterable.dart (Dart 3.13.7)
bool moveNext() {
  int length = _iterable.length;
  if (_length != length) {
    throw ConcurrentModificationError(_iterable);
  }
  if (_index >= length) {
    _current = null;
    return false;
  }
  _current = _iterable.elementAt(_index);
  _index++;
  return true;
}
```

`List.forEach` faz a mesma checagem depois de cada callback, `removeWhere` checa dentro do próprio loop, e o erro é lançado no *próximo* passo, não na linha que modificou a lista. É por isso que o stack trace aponta para `moveNext` e não para `remove`.

A [documentação de `Iterable`](https://api.dart.dev/dart-core/Iterable-class.html) deixa o contrato claro: alterar uma coleção enquanto ela está sendo iterada em geral não é permitido, e a quebra costuma ser sinalizada com um ConcurrentModificationError na próxima chamada de Iterator.moveNext. A checagem existe porque a alternativa é pior. Remover o elemento `i` desloca tudo o que vem depois uma posição para a esquerda, então um iterador baseado em índice pularia silenciosamente o elemento que escorregou para a posição `i`. O Dart prefere falhar de forma ruidosa.

Duas consequências do "próximo `moveNext()`" surpreendem as pessoas:

- **Remover o último elemento também lança o erro.** Você pode esperar que remover `4` de `[1, 2, 3, 4]` na última iteração seja seguro porque não sobra nada para visitar. Não é. O loop chama `moveNext()` mais uma vez para descobrir que terminou, vê que o tamanho mudou e lança o erro.
- **Adicionar também lança.** `numbers.add(x)` dentro do loop muda o tamanho do mesmo jeito que `remove`. O Dart não tem um `Iterator.remove()` como o do Java, então não existe um jeito "seguro" de modificar a lista pelo próprio iterador.

## Escolha a correção certa

Esta é a ordem de decisão que eu uso. Cada opção é detalhada abaixo.

1. Se você quer tirar elementos da lista existente no lugar, chame `removeWhere` (ou `retainWhere` para o inverso).
2. Se a lista faz parte de um estado imutável (Riverpod, Bloc, `ValueNotifier`, um campo `final` passado para widgets), crie uma lista nova com `where(...).toList()` ou um collection-for e atribua.
3. Se a decisão de remover depende do índice ou dos elementos vizinhos, percorra o índice de trás para frente e use `removeAt`.
4. Se o corpo do loop faz bastante trabalho e só parte dele remove itens, itere sobre uma cópia (`for (final x in list.toList())`) e remova da original.

## Correção 1: `removeWhere` para filtrar no lugar

Esta é a resposta canônica e deve ser o seu padrão:

```dart
// Dart 3.13.7
void main() {
  final numbers = [1, 2, 2, 3];
  numbers.removeWhere((n) => n == 2);
  print(numbers); // [1, 3]

  final tasks = <({String title, bool done})>[
    (title: 'write post', done: true),
    (title: 'review PR', done: false),
  ];
  tasks.retainWhere((t) => !t.done);
  print(tasks); // [(done: false, title: review PR)]
}
```

`removeWhere` faz uma única passada. Na implementação compartilhada de `ListBase`, ele percorre a lista uma vez, junta os sobreviventes, escreve tudo de volta com um único `setRange` e reduz o tamanho. Ele remove todas as correspondências, ao contrário de `remove`, que só remove o primeiro elemento igual ao argumento. Também é a opção mais rápida com folga, veja o benchmark mais abaixo.

Maps e sets têm o mesmo método. `map.removeWhere((key, value) => value == 2)` e `set.removeWhere((x) => x.isEven)` são as correções para as versões `_Map` e `_Set` deste erro.

Uma regra continua valendo dentro do predicado: não modifique a lista a partir de `test`. Um predicado que chama `numbers.add(...)` lança `ConcurrentModificationError` de dentro de `removeWhere`, pelo mesmo motivo que o loop `for-in` lançava.

## Correção 2: criar uma lista nova em vez de modificar

Se a lista pertence a um estado ao qual outro código tem referência, modificar no lugar é o verdadeiro bug, e o `ConcurrentModificationError` é só o sintoma que apareceu. Crie uma lista nova:

```dart
// Dart 3.13.7
void main() {
  final numbers = [1, 2, 3, 4];

  final odds = numbers.where((n) => n.isOdd).toList();
  final alsoOdds = [for (final n in numbers) if (n.isOdd) n];

  print(odds);     // [1, 3]
  print(alsoOdds); // [1, 3]
  print(numbers);  // [1, 2, 3, 4], untouched
}
```

No Flutter, este é o formato que você quer para tudo o que dispara um rebuild:

```dart
// Flutter 3.47.8, Dart 3.13.7, flutter_riverpod 3.x
class TodoList extends Notifier<List<Todo>> {
  @override
  List<Todo> build() => const [];

  void clearCompleted() {
    state = [for (final t in state) if (!t.done) t];
  }
}
```

Riverpod, Bloc e `ValueNotifier` só notificam os listeners quando um novo valor é atribuído e ele é diferente do anterior. Chamar `state.removeWhere(...)` modifica a mesma instância da lista sem atribuir nada, então nada é reconstruído, e se `state` foi criado com `const []` ou `List.unmodifiable`, ele lança `UnsupportedError: Cannot remove from an unmodifiable list`. Se você está levando um widget com `setState` para esse modelo, a [migração de setState para um Notifier do Riverpod](/pt-br/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/) mostra o resto da conversão.

Cuidado com a avaliação preguiçosa. `where` retorna um `Iterable` lazy que lê da lista original conforme você consome, então isto ainda lança o erro:

```dart
// Dart 3.13.7: throws ConcurrentModificationError
for (final n in numbers.where((n) => n.isEven)) {
  numbers.remove(n);
}
```

O `.toList()` é o que materializa o resultado e quebra o vínculo com a origem.

## Correção 3: percorrer o índice de trás para frente

Às vezes a decisão depende da posição: "remova um item se ele for igual ao anterior" ou "remova todas as entradas depois do primeiro erro". Um loop por índice serve aqui, desde que ande de trás para frente:

```dart
// Dart 3.13.7
void main() {
  final values = [1, 2, 2, 3, 3, 3, 4];

  // Remove consecutive duplicates.
  for (var i = values.length - 1; i > 0; i--) {
    if (values[i] == values[i - 1]) values.removeAt(i);
  }
  print(values); // [1, 2, 3, 4]
}
```

Loops por índice nunca tocam no iterador, então nunca lançam `ConcurrentModificationError`. Isso não torna um loop para frente correto:

```dart
// Dart 3.13.7: no exception, wrong answer for adjacent matches
final numbers = [1, 2, 2, 3];
for (var i = 0; i < numbers.length; i++) {
  if (numbers[i] == 2) numbers.removeAt(i);
}
print(numbers); // [1, 2, 3]  (one 2 survived)
```

Quando `removeAt(1)` roda, o segundo `2` escorrega para o índice 1, e então `i++` passa por cima dele. Andar de trás para frente evita isso porque remover o índice `i` só desloca elementos que você já visitou. Se você insiste em um loop para frente, só incremente `i` quando não removeu nada, mas o loop de trás para frente é mais difícil de errar.

## Correção 4: iterar sobre uma cópia

Quando o corpo do loop faz trabalho de verdade (log, disparar callbacks, atualizar outras estruturas) e a remoção é um efeito colateral de algumas iterações, iterar sobre um snapshot mantém o código legível:

```dart
// Dart 3.13.7
void main() {
  final pending = [1, 2, 2, 3];
  for (final job in pending.toList()) {
    final ok = job != 2; // pretend this ran the job
    if (ok) pending.remove(job);
  }
  print(pending); // [2, 2]
}
```

`toList()` custa uma alocação e uma cópia das referências, algo desprezível para listas do tamanho de uma tela. Lembre que `remove(job)` remove o *primeiro* elemento igual a `job`, o que é ok para objetos únicos e surpreendente para valores duplicados. Para um `Map`, o equivalente é `for (final key in map.keys.toList())`.

## Por que `removeAt` em um loop é a opção lenta

Cada `removeAt(i)` desloca todos os elementos depois de `i` uma posição para a esquerda, então remover `k` itens de uma lista de `n` custa aproximadamente `O(n * k)` movimentações de elementos. `removeWhere` e `where(...).toList()` fazem uma única passada `O(n)`. Medi as três opções em uma `List<int>` de 200.000 elementos, removendo os 100.000 números pares, compilado com `dart compile exe` em um Mac com Apple Silicon:

```dart
// Dart 3.13.7, dart compile exe, macOS arm64
void main() {
  const n = 200000;
  var a = List<int>.generate(n, (i) => i);
  var sw = Stopwatch()..start();
  for (var i = a.length - 1; i >= 0; i--) {
    if (a[i].isEven) a.removeAt(i);
  }
  print('removeAt backwards: ${sw.elapsedMilliseconds} ms');

  var b = List<int>.generate(n, (i) => i);
  sw = Stopwatch()..start();
  b.removeWhere((x) => x.isEven);
  print('removeWhere: ${sw.elapsedMicroseconds} us');

  var c = List<int>.generate(n, (i) => i);
  sw = Stopwatch()..start();
  final d = c.where((x) => x.isOdd).toList();
  print('where.toList: ${sw.elapsedMicroseconds} us (${d.length})');
}
```

| Abordagem | Tempo (mediana de 3 execuções) |
| --- | --- |
| loop `removeAt` de trás para frente | ~3.720 ms |
| `removeWhere` | ~1,0 ms |
| `where(...).toList()` | ~1,45 ms |

São três ordens de grandeza e meia. Para uma lista de 20 tarefas, nada disso importa e você deve escolher a versão que fica mais legível. Para qualquer coisa que processe dados (linhas de CSV parseadas, entradas de log, uma limpeza de cache), use `removeWhere` e guarde o loop por índice para a lógica que realmente precisa de posições. Se você precisa processar uma lista muito grande fora da thread da UI, [rodar o trabalho em um isolate do Dart](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) mantém os frames fluidos, mas não conserta um loop `O(n^2)`.

## Quando você também precisa dos itens removidos

`removeWhere` retorna `void`, então você não consegue ver o que ele tirou. A correção tentadora chama o predicado duas vezes:

```dart
final removed = items.where(isExpired).toList();
items.removeWhere(isExpired);
```

Isso só é correto se `isExpired` for determinístico. Se ele lê `DateTime.now()`, um item pode expirar entre as duas chamadas e sumir sem aparecer em `removed`. Particione em uma única passada:

```dart
// Dart 3.13.7
extension RemoveAndCollect<E> on List<E> {
  List<E> removeWhereAndCollect(bool Function(E element) test) {
    final removed = <E>[];
    final kept = <E>[];
    for (final e in this) {
      (test(e) ? removed : kept).add(e);
    }
    if (removed.isNotEmpty) {
      setRange(0, kept.length, kept);
      length = kept.length;
    }
    return removed;
  }
}

void main() {
  final items = [1, 2, 3, 4, 5];
  final evens = items.removeWhereAndCollect((x) => x.isEven);
  print(items); // [1, 3, 5]
  print(evens); // [2, 4]
}
```

O `for-in` aqui é seguro porque nada modifica `this` até o loop terminar.

## Armadilhas que escondem o erro ou o mudam

**Remover e depois adicionar na mesma iteração corrompe o loop em silêncio.** O iterador só compara tamanhos. Se uma iteração remove um elemento e adiciona outro, o tamanho não muda e nada é lançado:

```dart
// Dart 3.13.7: no exception, element 3 is never visited
final l = [1, 2, 3, 4];
for (final x in l) {
  print('visit $x'); // visit 1, visit 2, visit 4, visit 20
  if (x == 2) {
    l.remove(x);
    l.add(20);
  }
}
```

O `3` escorregou para a posição que já tinha sido visitada e foi pulado. A ausência de um `ConcurrentModificationError` não prova que o código está correto. Substituir um elemento no lugar, `l[i] = newValue`, é legitimamente seguro, porque nunca muda o tamanho e nunca desloca nada.

**Um `await` dentro do loop abre a porta para outro código.** Esta é a versão que aparece em apps Flutter como um crash intermitente:

```dart
// Dart 3.13.7
import 'dart:async';

Future<void> main() async {
  final items = [1, 2, 3];
  Timer(const Duration(milliseconds: 5), () => items.removeAt(0));

  for (final x in items) {
    await Future<void>.delayed(const Duration(milliseconds: 10));
    print('processed $x');
  }
  // processed 1, then ConcurrentModificationError
}
```

Nada dentro do corpo do loop toca em `items`. Quem toca é um timer, um listener de stream ou um handler de toque em botão que roda durante o `await`. A correção é a mesma da Correção 4: itere sobre `items.toList()`, ou torne a lista compartilhada imutável e substitua. Se o loop assíncrono vive em um `State`, essa mesma lacuna é onde você também precisa da [checagem de mounted antes de chamar setState](/pt-br/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/), e uma chamada sem `await` no loop é exatamente o que os [lints `unawaited_futures` e `discarded_futures`](/pt-br/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/) existem para pegar.

**Maps toleram atualização de valores, não mudança de chaves.** `for (final k in map.keys) map[k] = 0;` funciona porque atualizar uma chave existente não muda a estrutura do map. `map.remove(k)` ou adicionar uma chave nova lança o erro. Remover uma chave que não existe não faz nada e não lança.

**`addAll` sobre a própria lista lança na hora.** `list.addAll(list)` em uma lista growable da VM lança `ConcurrentModificationError` sem nenhum loop à vista. Use `list.addAll(list.toList())` ou `[...list, ...list]`.

**Listas de tamanho fixo e não modificáveis lançam `UnsupportedError`, não este erro.** `List.filled(3, 0).removeWhere(...)` lança `Unsupported operation: Cannot remove from a fixed-length list`, e uma lista `const` ou `List.unmodifiable` lança `Cannot remove from an unmodifiable list`. A [documentação de `removeWhere`](https://api.dart.dev/dart-core/List/removeWhere.html) avisa: a lista precisa ser growable. Use a Correção 2 nesses casos.

**Remover de uma lista que alimenta um `ListView` exige keys.** Depois de `setState(() => _items.removeWhere(...))`, o Flutter associa os filhos antigos e novos pela posição, a menos que você dê keys a eles, então o estado de cada item (um checkbox, um campo de texto, uma animação) pode pular para a linha errada. O [post sobre keys no Flutter](/pt-br/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/) cobre a correção com `ValueKey(item.id)`.

### Leia a seguir

- [Como proteger o setState com a checagem de mounted depois de uma lacuna assíncrona no Flutter](/pt-br/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/)
- [O que é uma Key no Flutter e quando omiti-la causa bugs?](/pt-br/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)
- [Migrar um StatefulWidget com setState para um Notifier do Riverpod](/pt-br/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)
- [Lint unawaited_futures vs discarded_futures no Dart](/pt-br/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/)

### Fontes

- [Documentação da classe `Iterable`](https://api.dart.dev/dart-core/Iterable-class.html), seção sobre alterar uma coleção durante a iteração
- [Classe `ConcurrentModificationError`](https://api.dart.dev/dart-core/ConcurrentModificationError-class.html)
- [`List.removeWhere`](https://api.dart.dev/dart-core/List/removeWhere.html) e [`List.retainWhere`](https://api.dart.dev/dart-core/List/retainWhere.html)
- Código-fonte do SDK do Dart: [`ListIterator.moveNext` em `sdk/lib/internal/iterable.dart`](https://github.com/dart-lang/sdk/blob/main/sdk/lib/internal/iterable.dart) e [`ListBase._filter` em `sdk/lib/collection/list.dart`](https://github.com/dart-lang/sdk/blob/main/sdk/lib/collection/list.dart)
