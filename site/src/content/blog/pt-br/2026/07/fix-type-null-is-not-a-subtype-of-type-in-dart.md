---
title: "Solução: type 'Null' is not a subtype of type 'X' no Dart"
description: "Esse erro em tempo de execução significa que um null chegou a uma conversão que esperava um tipo não anulável, quase sempre vindo de JSON. Torne o campo anulável, ou forneça um valor padrão antes da conversão."
pubDate: 2026-07-18
template: error-page
tags:
  - "errors"
  - "dart"
  - "flutter"
lang: "pt-br"
translationOf: "2026/07/fix-type-null-is-not-a-subtype-of-type-in-dart"
translatedBy: "claude"
translationDate: 2026-07-18
---

`type 'Null' is not a subtype of type 'X'` é um erro de tipo em tempo de execução: um `null` chegou a um ponto do seu código onde uma conversão ou uma atribuição insistia em um tipo não anulável. A origem esmagadoramente comum é a análise de JSON, onde uma chave está ausente ou chega como `null` e você a converte diretamente para `String`, `int` ou um tipo de modelo. A solução é impedir que a conversão veja um `null` cru: ou você declara o tipo de destino como anulável (`String?`) e trata o null, ou fornece um valor padrão com `?? fallback` antes de a conversão acontecer. Isso foi verificado contra o Dart 3.12 (Flutter 3.44); o comportamento tem sido o mesmo em cada versão com null safety sólido desde o Dart 2.12.

## O erro em contexto

A mensagem nomeia o tipo concreto que o valor deveria ser. A partir de uma decodificação de JSON, normalmente se parece com isto:

```
Unhandled Exception: type 'Null' is not a subtype of type 'String' in type cast
#0      _$UserFromJson (package:myapp/models/user.dart:12:34)
#1      new User.fromJson (package:myapp/models/user.dart:8:7)
#2      fetchUser (package:myapp/api/client.dart:41:24)
<asynchronous suspension>
```

Duas palavras nessa mensagem fazem todo o trabalho. A primeira, `'Null'`, é o tipo que o valor realmente tinha em tempo de execução: era `null`. A segunda, depois de "subtype of type", é o que o código exigia: `'String'`, `'int'`, `'List<dynamic>'`, `'Map<String, dynamic>'` ou uma das suas próprias classes de modelo. O `in type cast` final informa que a falha aconteceu em uma conversão `as` explícita ou implícita, que é a impressão digital reveladora de decodificar JSON `dynamic` sem tipo para campos tipados.

Você também verá a variante sem `in type cast`, por exemplo `type 'Null' is not a subtype of type 'String'`, quando o valor flui para um parâmetro ou campo não anulável em vez de uma expressão `as`. A mesma causa raiz, as mesmas soluções.

## Por que isso acontece

Sob null safety sólido, `Null` é seu próprio tipo e não é subtipo de nenhum tipo não anulável. Esse é todo o sentido do null safety: `String` genuinamente não pode conter `null`, então o runtime se recusa a deixar um `null` se passar por uma. Quando você escreve `json['name'] as String` e `json['name']` é `null`, você está pedindo ao runtime que trate `Null` como `String`, e ele lança o erro.

A razão pela qual isso aparece em tempo de execução em vez de em tempo de compilação é que JSON é `dynamic`. `jsonDecode` retorna `dynamic`, e cada busca em um `Map<String, dynamic>` também é `dynamic`. O compilador não consegue ver o que realmente há no mapa, então ele confia na sua conversão `as String` e adia a verificação para o tempo de execução. Se o valor real for `null`, a verificação falha no momento em que essa linha é executada. É por isso que o erro é tão comum nas fábricas `fromJson` e no código gerado por `json_serializable`: esses são exatamente os lugares onde os valores `dynamic` são forçados a formas tipadas.

Há três situações que o produzem, em ordem aproximada de frequência:

- A chave JSON está completamente ausente, então `json['key']` retorna `null`, e você converte esse `null` para um tipo não anulável.
- A chave está presente mas seu valor é JSON `null`, por exemplo uma coluna anulável serializada a partir de um backend.
- O valor está presente mas com a forma errada, por exemplo um número que chega como `int` quando você converte para `String`, ou um objeto onde você esperava uma lista. Isso lança uma mensagem de subtipo diferente mas é a mesma categoria de bug.

## Reprodução mínima

O menor trecho que reproduz o caso canônico:

```dart
// Dart 3.12, Flutter 3.44
import 'dart:convert';

class User {
  final String name;
  final int age;
  User({required this.name, required this.age});

  factory User.fromJson(Map<String, dynamic> json) => User(
        name: json['name'] as String, // throws if 'name' is null or missing
        age: json['age'] as int,
      );
}

void main() {
  // 'name' is absent from the payload
  final payload = jsonDecode('{"age": 30}') as Map<String, dynamic>;
  final user = User.fromJson(payload); // type 'Null' is not a subtype of type 'String'
  print(user.name);
}
```

`json['name']` é avaliado como `null` porque a chave não está no mapa. A conversão `as String` então tenta ver `null` como uma `String` e lança o erro. Observe que a exceção é lançada dentro de `User.fromJson`, não no `print`, razão pela qual a stack trace aponta para o seu arquivo de modelo e não para o widget que por fim exibiu os dados.

## Solução, em detalhe

Percorra estas em ordem. As duas primeiras cobrem quase toda ocorrência real; o resto trata das formas que as soluções simples não cobrem.

### 1. Torne o campo anulável se os dados realmente puderem estar ausentes

Se o backend puder omitir ou anular legitimamente o valor, modele isso com honestidade. Declare o campo do Dart como anulável e deixe a conversão apontar para um tipo anulável, do qual `null` é subtipo:

```dart
// Dart 3.12, Flutter 3.44
class User {
  final String? name; // was String
  final int age;
  User({this.name, required this.age});

  factory User.fromJson(Map<String, dynamic> json) => User(
        name: json['name'] as String?, // as String?, not as String
        age: json['age'] as int,
      );
}
```

`json['name'] as String?` tem sucesso quer o valor seja uma `String` quer seja `null`, porque `Null` é subtipo de `String?`. O custo é que cada consumidor de `name` agora tem que tratar o null, que é exatamente a corretude que o sistema de tipos está pedindo que você reconheça. Esta é a solução correta quando o campo é genuinamente opcional.

### 2. Forneça um valor padrão com ?? antes de o valor chegar a um campo não anulável

Se o campo precisa permanecer não anulável mas você pode escolher um valor padrão sensato, elimine o null antes de a conversão se completar:

```dart
// Dart 3.12, Flutter 3.44
factory User.fromJson(Map<String, dynamic> json) => User(
      name: json['name'] as String? ?? 'Unknown', // cast to nullable, then default
      age: json['age'] as int? ?? 0,
    );
```

A ordem importa. Converta primeiro para o tipo anulável (`as String?`), depois aplique `??`. Se você escrever `json['name'] ?? 'Unknown' as String`, a precedência o transforma em `json['name'] ?? ('Unknown' as String)`, que não protege o lado esquerdo e ainda lança o erro quando o valor é um tipo não nulo errado. Converter para anulável e aplicar a coalescência de nulos é o idioma que se lê de forma limpa e se comporta corretamente.

### 3. Nunca converta o valor de um mapa `dynamic` diretamente para um tipo não anulável

O hábito que causa esse erro é `json['x'] as ConcreteType`. Faça da forma segura o seu padrão: converta para o tipo anulável, depois decida o que um null significa. Para objetos e listas aninhados, a mesma regra se aplica um nível mais fundo:

```dart
// Dart 3.12, Flutter 3.44
// A list that may be absent -> default to empty, never null-cast the elements
final tags = (json['tags'] as List<dynamic>?)
        ?.map((e) => e as String)
        .toList() ??
    <String>[];

// A nested object that may be absent -> guard before recursing
final address = json['address'] == null
    ? null
    : Address.fromJson(json['address'] as Map<String, dynamic>);
```

Converter o contêiner externo para `List<dynamic>?` ou verificar `== null` antes de recorrer impede que o `null` chegue a um elemento ou a uma conversão aninhada. É aqui que o código `fromJson` escrito à mão mais frequentemente erra: o campo de nível superior está protegido mas os elementos da lista ou o mapa aninhado não estão.

### 4. Se você usa json_serializable, marque o campo como anulável ou dê a ele um valor padrão

O código `fromJson` gerado converte exatamente como você faria à mão, então um campo não anulável com `@JsonKey` produz o mesmo erro em tempo de execução quando os dados estão ausentes. Corrija isso na declaração do modelo e regenere:

```dart
// Dart 3.12, Flutter 3.44, json_serializable 6.x
@JsonSerializable()
class User {
  final String? name;                       // nullable -> generator emits `as String?`
  @JsonKey(defaultValue: 0) final int age;  // default -> used when the key is null/absent
  User({this.name, required this.age});

  factory User.fromJson(Map<String, dynamic> json) => _$UserFromJson(json);
}
```

Um campo anulável faz o gerador emitir `as String?`. Um `@JsonKey(defaultValue: ...)` faz ele substituir pelo valor padrão quando a chave está ausente ou é null. Execute `dart run build_runner build --delete-conflicting-outputs` depois de mudar as anotações, caso contrário a antiga conversão gerada é o que roda.

### 5. Corrija o descompasso de forma quando o valor não é de fato null

Se o erro nomeia um tipo como `'String'` mas o payload claramente tem um valor, o valor tem a forma errada. Um backend que envia `"age": "30"` (string) quando você converte `as int`, ou `"30"` onde você espera um número, dispara a mesma família de erro. Coaja explicitamente em vez de converter:

```dart
// Dart 3.12, Flutter 3.44
// Backend sends age as a string sometimes, an int other times
final age = json['age'] is int
    ? json['age'] as int
    : int.parse(json['age'].toString());
```

Este não é o caso de `Null`, mas leva as pessoas a esta página porque a forma da mensagem é idêntica. Quando o tipo na mensagem não é `'Null'` no lado esquerdo, olhe para o que o servidor realmente enviou, não para o seu tratamento de nulos.

## Armadilhas e variantes

- **A stack trace aponta para o modelo, não para a interface.** Como a conversão roda dentro de `fromJson`, o frame do topo é o seu arquivo de modelo. Os desenvolvedores frequentemente começam a depurar o widget que mostrou o campo em branco; a solução real está um ou dois frames abaixo, na conversão. Leia o primeiro frame que não pertence ao framework na trace.

- **`as String?` não é o mesmo que `as String`.** O único `?` é toda a solução na maioria dos casos. `as String?` permite `null`; `as String` o proíbe. Se você copiar uma conversão de um campo não anulável para um anulável, lembre-se de adicionar o `?`, ou você moveu o bug, não o corrigiu.

- **As conversões de `Map<String, dynamic>` falham da mesma maneira.** `jsonDecode` retorna `dynamic`. Se o payload inteiro for `null` (um corpo de resposta 204 vazio, por exemplo) então `jsonDecode(body) as Map<String, dynamic>` lança `type 'Null' is not a subtype of type 'Map<String, dynamic>'` antes mesmo de você chegar a um campo. Proteja a decodificação: `body.isEmpty ? null : jsonDecode(body)`. Isso se sobrepõe à entrada malformada tratada em [FormatException: Unexpected character ao analisar JSON no Dart](/pt-br/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/).

- **O operador bang move a falha, não a corrige.** Escrever `json['name']!` converte um erro de subtipo `Null` em `Null check operator used on a null value`. É o mesmo null subjacente, lançado por um mecanismo diferente. Veja [Null check operator used on a null value no Flutter](/pt-br/2026/06/fix-null-check-operator-used-on-a-null-value-in-flutter/) para saber por que `!` deve ser reservado para valores que você pode provar que não são nulos, não usado para silenciar um compilador com o qual você discorda.

- **Campos `late` transformam o mesmo null em um erro diferente.** Se você direcionar um valor possivelmente nulo para um campo `late` não anulável e o ler antes da atribuição, você obtém `LateInitializationError` em vez disso. A cura é a mesma: modele a ausência com honestidade em vez de prometer um valor que você não tem. Veja [LateInitializationError: Field has not been initialized no Flutter](/pt-br/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/).

- **Os argumentos de tipo genérico ocultam a conversão.** `List<String>.from(json['tags'])` e `(json['tags'] as List).cast<String>()` ambos lançam esse erro de forma preguiçosa, quando um elemento é `null`, e a trace pode apontar para `.cast` em vez do seu código. Prefira um `.map((e) => e as String?)` explícito para que a falha seja visível e sua para tratar.

- **Este é um erro em tempo de execução, então os testes o pegam e o analisador não.** O analisador não consegue ver dentro de um mapa JSON `dynamic`, então `dart analyze` fica verde enquanto a conversão é insegura. Um único teste unitário de `fromJson` com um payload que omite o campo traz o bug à tona antes que um usuário o faça. Se você está migrando uma base de código mais antiga, o [checklist de migração para null safety do Flutter](/pt-br/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) percorre onde essas conversões tendem a se esconder.

O modelo mental para levar: esse erro é o null safety se recusando a deixar um `null` fingir ser algo que não é. O valor entrou como `null`, e alguma conversão ou atribuição rio abaixo prometeu que ele não seria. A solução nunca é forçar a conversão com mais força; é decidir, na fronteira onde os dados `dynamic` entram no seu mundo tipado, se esse campo pode estar ausente. Se puder, torne-o anulável e trate o null. Se não puder, dê a ele um valor padrão antes de a conversão se completar. Faça isso em cada busca `json[...]` e esse erro para de aparecer.

## Relacionado

- [Solução: FormatException: Unexpected character ao analisar JSON no Dart](/pt-br/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) para o erro irmão quando o payload nem sequer é JSON válido.
- [Solução: Null check operator used on a null value no Flutter](/pt-br/2026/06/fix-null-check-operator-used-on-a-null-value-in-flutter/) para o que acontece quando você recorre a `!` para silenciar essa conversão.
- [Solução: LateInitializationError: Field has not been initialized no Flutter](/pt-br/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/) para a variante `late` de prometer um valor que você não tem.
- [Migre um app Flutter 2 para Flutter 3.x: checklist de null safety](/pt-br/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) para encontrar essas conversões inseguras em toda uma base de código.

## Fontes

- Dart, [Understanding null safety](https://dart.dev/null-safety/understanding-null-safety) (por que `Null` não é mais subtipo de todo tipo, e por que as conversões implícitas a partir de `dynamic` se tornaram conversões explícitas que falham em tempo de execução).
- Dart, [Sound null safety](https://dart.dev/null-safety) (as garantias que fazem uma `String` não anulável rejeitar `null` em tempo de execução).
- GitHub, [dart-lang/sdk issue #53700](https://github.com/dart-lang/sdk/issues/53700) ("type 'Null' is not a subtype of type 'String'" reportado contra código real de decodificação de JSON, com a causa raiz da chave ausente).
