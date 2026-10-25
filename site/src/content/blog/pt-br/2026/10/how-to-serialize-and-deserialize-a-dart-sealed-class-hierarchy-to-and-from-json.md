---
title: "Como serializar e desserializar uma hierarquia de sealed classes do Dart de e para JSON"
description: "Coloque um campo discriminador no JSON, faça um switch nele em uma factory na base sealed e faça um switch no subtipo para escrevê-lo de volta. Três versões funcionais no Dart 3.13.7: correspondência de padrões escrita à mão, json_serializable 6.15.2 e Freezed 4.0.3 com unionKey e fallbackUnion, além das armadilhas que cada uma esconde."
pubDate: 2026-10-25
template: how-to
tags:
  - "dart"
  - "flutter"
  - "json"
  - "freezed"
  - "json-serializable"
  - "sealed-classes"
lang: "pt-br"
translationOf: "2026/10/how-to-serialize-and-deserialize-a-dart-sealed-class-hierarchy-to-and-from-json"
translatedBy: "claude"
translationDate: 2026-10-25
---

**Resposta curta:** o JSON não sabe de qual subclasse Dart um objeto veio, então você mesmo precisa escrever essa informação no payload, normalmente como um campo discriminador, como `"type": "circle"`. Desserialize com um `factory Shape.fromJson` na base sealed que faz um switch nesse campo e delega para a subclasse certa, e serialize com um `toJson` que faz um switch em `this` (de forma exaustiva, graças ao `sealed`) e adiciona o discriminador de volta. Você pode escrever isso à mão com os map patterns do Dart 3, deixar o json_serializable gerar o corpo de cada subclasse enquanto você escreve o despacho, ou deixar o Freezed gerar tudo com `@Freezed(unionKey: 'type')`. Tudo abaixo foi compilado e executado no Dart 3.13.7 (o SDK do Flutter 3.47.8) com json_serializable 6.15.2, json_annotation 4.12.0, Freezed 4.0.3, freezed_annotation 3.1.0 e build_runner 2.17.1.

## Por que uma hierarquia sealed não faz o round-trip sozinha

Uma `sealed class Shape` com as subclasses `Circle` e `Rect` dá a você verificação exaustiva de `switch` dentro do Dart, mas o `jsonDecode` só entrega `Map<String, dynamic>`, `List<dynamic>`, `String`, `num`, `bool` e `null`. Nada em `{"radius": 2}` diz "isto era um `Circle`". Então o trabalho se divide em duas direções que exigem ferramentas diferentes:

- **Dart para JSON** é fácil porque você tem um objeto real. Um `switch (this)` sobre um tipo sealed é verificado pelo compilador, então, se você adicionar um `Triangle` depois, todo `toJson` que o esqueceu vira um erro de compilação.
- **JSON para Dart** é a direção difícil. Você está fazendo um switch em uma *string* vinda da rede, e nenhum compilador consegue verificar que toda string possível corresponde a uma subclasse. Você precisa de uma política para discriminadores desconhecidos ou ausentes.

O discriminador não precisa se chamar `type`. O Freezed usa `runtimeType` por padrão, muitas APIs usam `kind` ou `@type`, e algumas APIs não têm discriminador nenhum e você precisa inferir o subtipo a partir de quais chaves estão presentes. As três abordagens abaixo cobrem esses casos.

## A hierarquia mínima e o formato na rede

Este é o formato usado em todos os exemplos:

```json
[
  { "type": "circle", "radius": 2 },
  { "type": "rect", "width": 3, "height": 4.5 }
]
```

Repare em `"radius": 2`. O `jsonDecode` transforma isso em um `int`, não em um `double`, o que importa assim que seu campo é declarado como `double`.

## Opção 1: escrita à mão com map patterns do Dart 3

Sem pacotes, sem geração de código. Os map patterns verificam que a chave existe *e* que o valor tem o tipo certo em um único passo:

```dart
// Dart 3.13.7, no packages
sealed class Shape {
  const Shape();

  factory Shape.fromJson(Map<String, dynamic> json) => switch (json) {
        {'type': 'circle', 'radius': num radius} => Circle(radius.toDouble()),
        {'type': 'rect', 'width': num w, 'height': num h} =>
          Rect(w.toDouble(), h.toDouble()),
        {'type': String type} =>
          throw FormatException('Unknown or malformed Shape "$type"', json),
        _ => throw FormatException('Missing "type" discriminator', json),
      };

  Map<String, dynamic> toJson() => switch (this) {
        Circle(:final radius) => {'type': 'circle', 'radius': radius},
        Rect(:final width, :final height) =>
          {'type': 'rect', 'width': width, 'height': height},
      };
}

final class Circle extends Shape {
  const Circle(this.radius);
  final double radius;
}

final class Rect extends Shape {
  const Rect(this.width, this.height);
  final double width;
  final double height;
}
```

Executando contra o payload acima:

```text
[Circle, Rect]
[{"type":"circle","radius":2.0},{"type":"rect","width":3.0,"height":4.5}]
manual unknown THREW FormatException: Unknown or malformed Shape "hexagon"
manual missing type THREW FormatException: Missing "type" discriminator
manual circle missing radius THREW FormatException: Unknown or malformed Shape "circle"
manual radius as string THREW FormatException: Unknown or malformed Shape "circle"
```

Três detalhes tornam esta versão melhor que o snippet usual `json['radius'] as double`:

1. **`num` e depois `.toDouble()`.** Fazer a correspondência com `'radius': double r` falharia para `2`, porque o valor decodificado é um `int`. Fazer a correspondência com `num` aceita ambos.
2. **Payloads inválidos falham com a sua mensagem, não com um `TypeError`.** Um círculo sem raio, ou com `"radius": "2"`, não corresponde ao primeiro case, cai no case `{'type': String type}` e lança uma `FormatException` que carrega o map problemático.
3. **O `toJson` é verificado pelo compilador.** Se você adicionar `final class Triangle extends Shape` e esquecê-lo, o analyzer o impede:

```text
error - The type 'Shape' isn't exhaustively matched by the switch cases since it doesn't match the pattern 'Triangle()'. Try adding a wildcard pattern or cases that match 'Triangle()'. - non_exhaustive_switch_expression
```

O `fromJson` não recebe nenhuma verificação assim, porque faz o switch no conteúdo do map. Mantenha os dois switches lado a lado na classe base, para que quem revisa veja ambos quando uma subclasse for adicionada.

### Quando a API não tem discriminador

Se você não controla o payload e ele se parece com `{"radius": 2}` ou `{"width": 3, "height": 4.5}`, os mesmos map patterns despacham pela *presença* das chaves:

```dart
// Dart 3.13.7: dispatch on key presence, no "type" field on the wire
factory Shape.fromJson(Map<String, dynamic> json) => switch (json) {
      {'radius': num r} => Circle(r.toDouble()),
      {'width': num w, 'height': num h} => Rect(w.toDouble(), h.toDouble()),
      _ => throw FormatException('Not a Shape', json),
    };
```

A ordem importa aqui: os map patterns ignoram chaves extras, então coloque o case mais específico primeiro. Um `RoundedRect` com `width`, `height` e `cornerRadius` precisa ser testado antes de `Rect`, ou todo retângulo arredondado vira um retângulo comum.

A versão escrita à mão é a escolha certa para três a cinco subclasses com poucos campos cada. Acima disso, o boilerplate por campo é onde os bugs vivem, e a geração de código compensa.

## Opção 2: json_serializable para as subclasses, seu próprio despacho na base

O json_serializable não entende hierarquias sealed. O pedido de recurso, [google/json_serializable.dart#1342 "Support dart3 sealed class"](https://github.com/google/json_serializable.dart/issues/1342), está aberto desde agosto de 2023 e continua aberto na versão 6.15.2. O que ele faz bem é gerar o código campo a campo de cada classe concreta, então o padrão é: anote as subclasses e escreva à mão os dois switches na base.

```dart
// Dart 3.13.7, json_serializable 6.15.2, json_annotation 4.12.0
import 'package:json_annotation/json_annotation.dart';

part 'shape.g.dart';

sealed class Shape {
  const Shape();

  factory Shape.fromJson(Map<String, dynamic> json) => switch (json['type']) {
        'circle' => Circle.fromJson(json),
        'rect' => Rect.fromJson(json),
        final type => throw CheckedFromJsonException(
            json, 'type', 'Shape', 'Unknown Shape type "$type"'),
      };

  Map<String, dynamic> toJson();
}

@JsonSerializable()
final class Circle extends Shape {
  const Circle(this.radius);
  final double radius;

  factory Circle.fromJson(Map<String, dynamic> json) => _$CircleFromJson(json);

  @override
  Map<String, dynamic> toJson() => {'type': 'circle', ..._$CircleToJson(this)};
}

@JsonSerializable()
final class Rect extends Shape {
  const Rect(this.width, this.height);
  final double width;
  final double height;

  factory Rect.fromJson(Map<String, dynamic> json) => _$RectFromJson(json);

  @override
  Map<String, dynamic> toJson() => {'type': 'rect', ..._$RectToJson(this)};
}
```

Execute `dart run build_runner build`. O `_$CircleToJson` gerado contém apenas `radius`; ele não sabe nada sobre o discriminador, e é por isso que cada override o espalha em um map que começa com `'type'`. Lançar `CheckedFromJsonException` para tipos desconhecidos mantém o formato do erro idêntico ao que o código gerado lança em outros lugares, então um único handler `on CheckedFromJsonException` cobre os dois.

Como `Shape` agora tem um factory `fromJson` e um método `toJson`, o json_serializable a trata como qualquer outro tipo serializável quando ela aparece como campo. Uma classe contêiner simplesmente funciona para a decodificação:

```dart
// Dart 3.13.7, json_serializable 6.15.2
@JsonSerializable(explicitToJson: true)
class Drawing {
  Drawing(this.name, this.shapes);
  final String name;
  final List<Shape> shapes;

  factory Drawing.fromJson(Map<String, dynamic> json) => _$DrawingFromJson(json);
  Map<String, dynamic> toJson() => _$DrawingToJson(this);
}
```

O decoder gerado chama `Shape.fromJson(e as Map<String, dynamic>)` para cada elemento, então o despacho que você escreveu é reaproveitado. Mantenha `explicitToJson: true`; o motivo está nas armadilhas abaixo.

A única fraqueza: quando um payload não tem um campo, o código gerado não diz qual. `Shape.fromJson({'type': 'circle'})` lança `type 'Null' is not a subtype of type 'num' in type cast`. Adicione `@JsonSerializable(checked: true)` às subclasses se quiser uma `CheckedFromJsonException` que nomeie a chave.

## Opção 3: o Freezed gera a union inteira

O Freezed modela uma hierarquia sealed como uma classe com vários factory constructors e, quando o json_serializable também é uma dev dependency, ele gera o despacho, o discriminador e o código de cada case:

```dart
// Dart 3.13.7, freezed 4.0.3, freezed_annotation 3.1.0, json_serializable 6.15.2
import 'package:freezed_annotation/freezed_annotation.dart';

part 'shape.freezed.dart';
part 'shape.g.dart';

@Freezed(unionKey: 'type', unionValueCase: FreezedUnionCase.snake)
sealed class Shape with _$Shape {
  const factory Shape.circle({required double radius}) = Circle;
  const factory Shape.rect({required double width, required double height}) =
      Rect;
  const factory Shape.roundedRect({
    required double width,
    required double height,
    required double cornerRadius,
  }) = RoundedRect;

  factory Shape.fromJson(Map<String, dynamic> json) => _$ShapeFromJson(json);
}
```

As dev dependencies são `build_runner`, `freezed` e `json_serializable`; as dependências normais são `freezed_annotation` e `json_annotation`. O Freezed 4.0.3 exige o Dart 3.13, então, no Flutter 3.44 (Dart 3.12), você fica no Freezed 3.2.x, onde as mesmas anotações funcionam.

O que o código gerado faz:

```text
[{"radius":2.0,"type":"circle"},{"width":3.0,"height":4.5,"type":"rect"},{"width":1.0,"height":2.0,"cornerRadius":0.5,"type":"rounded_rect"}]
fz unknown THREW CheckedFromJsonException: Could not create `Shape`. There is a problem with "type". Invalid union type "hexagon"!
fz missing type THREW CheckedFromJsonException: Could not create `Shape`. There is a problem with "type". Invalid union type "null"!
```

- `unionKey: 'type'` renomeia o discriminador. Sem ele, o Freezed escreve e lê `runtimeType`, então uma union `@freezed` simples produz `{"n": 1, "runtimeType": "a"}`. Isso quase nunca é o que um backend espera.
- `unionValueCase` controla como os nomes dos constructors viram valores: `roundedRect` vira `rounded_rect` com `FreezedUnionCase.snake`, `rounded-rect` com `kebab`, `RoundedRect` com `pascal` e continua `roundedRect` com o padrão `none`.
- `@FreezedUnionValue('rounded-rect')` em um constructor sobrescreve o valor apenas para aquele case, que é a forma de casar com um formato de rede que não segue nenhuma regra única de capitalização.
- As classes geradas são subtipos reais, então um `switch (shape) { Circle(:final radius) => ..., Rect() => ..., RoundedRect() => ... }` exaustivo funciona exatamente como na opção 1.

Se você quiser as configurações em todo lugar em vez de por classe, coloque-as no `build.yaml`:

```yaml
# build.yaml, freezed 4.0.3
targets:
  $default:
    builders:
      freezed:
        options:
          union_key: type
          union_value_case: snake
```

### Tipos desconhecidos: `fallbackUnion`

Os clientes sobrevivem aos deploys do servidor. Quando o backend adiciona um novo tipo de evento, um app que lança exceção em discriminadores desconhecidos quebra numa lista que, de outra forma, poderia ter renderizado. O `fallbackUnion` do Freezed encaminha todo valor não reconhecido para um único constructor:

```dart
// Dart 3.13.7, freezed 4.0.3
@Freezed(unionKey: 'type', fallbackUnion: 'unknown')
sealed class Event with _$Event {
  const factory Event.click({required int x, required int y}) = ClickEvent;
  const factory Event.unknown() = UnknownEvent;

  factory Event.fromJson(Map<String, dynamic> json) => _$EventFromJson(json);
}
```

Decodificar `{"type": "scroll", "dy": 120}` resulta em `Event.unknown()`, e o seu `toJson()` retorna `{type: scroll}`: o Freezed mantém o discriminador original no campo oculto `$type`, mas o payload (`dy`) se perde. Uma chave `type` ausente também cai no fallback. Se você precisa reenviar ou registrar eventos desconhecidos com fidelidade, dê ao constructor de fallback um campo `Map<String, dynamic>` e preencha-o com um `fromJson` personalizado, ou use a versão escrita à mão, em que o case `_` pode guardar o map inteiro.

## Armadilhas que pegam em todas as abordagens

1. **O `toJson` aninhado retorna objetos, não maps, a menos que você peça.** Sem `explicitToJson: true`, o json_serializable escreve `'shapes': instance.shapes`. O resultado de `Drawing.toJson()` é `{name: d, shapes: [Instance of 'Circle', Instance of 'Rect']}`. O `jsonEncode` esconde o problema porque chama `toJson()` em qualquer coisa que não consiga codificar, então a string parece correta. Qualquer coisa que consuma o *map* (Firestore, `shared_preferences` via um map, mensagens de `Isolate`, um teste que compara maps) recebe objetos Dart. O Freezed tem o mesmo padrão; a correção ali é anotar o factory constructor:

   ```dart
   // Dart 3.13.7, freezed 4.0.3
   @freezed
   abstract class FzDrawing with _$FzDrawing {
     @JsonSerializable(explicitToJson: true)
     const factory FzDrawing({required String name, required List<Shape> shapes}) =
         _FzDrawing;

     factory FzDrawing.fromJson(Map<String, dynamic> json) =>
         _$FzDrawingFromJson(json);
   }
   ```

   Depois dessa mudança, `toJson()` produziu `{name: d, shapes: [{radius: 2.0, type: circle}, ...]}` e o round-trip de decodificar, codificar e decodificar comparou como igual.

2. **`int` versus `double`.** O código gerado já faz `(json['radius'] as num).toDouble()`. O código escrito à mão que faz cast `as double` lança exceção em `2`, e o `jsonEncode` do Dart escreve `2.0` de volta, então uma comparação byte a byte com o payload original falha mesmo quando o valor fez o round-trip corretamente. Compare objetos decodificados, não strings.

3. **O discriminador não pode colidir com um campo.** Se um case já tem um campo chamado `type`, o Freezed não reclama. Com `unionKey: 'type'` e `const factory Note.email({required String type, required String to})`, o `toJson()` retornou `{type: urgent, to: a}`: o campo substituiu silenciosamente o discriminador, então decodificar essa saída lança `Invalid union type "urgent"!`. Na outra direção, `Note.fromJson({'type': 'email', 'to': 'a'})` enfia o discriminador no campo (`Note.email(type: email, ...)`). Escolha um `unionKey` que nenhum campo use, como `kind`. As versões escrita à mão e com json_serializable têm a mesma armadilha se o `toJson` de uma subclasse contiver uma chave `type`, porque o spread sobrescreve o literal.

4. **Renomear um constructor é uma mudança no formato de rede.** Com o Freezed, o valor do discriminador é derivado do nome do constructor. Renomear `Shape.rect` para `Shape.rectangle` muda silenciosamente o que você envia e quebra todo documento armazenado e todo cliente mais antigo. Fixe os valores com `@FreezedUnionValue('rect')` em tudo que é persistido ou compartilhado com outro serviço.

5. **As flags do `build_runner` mudaram.** No build_runner 2.17.1, `dart run build_runner build --delete-conflicting-outputs` imprime `These options have been removed and were ignored: --delete-conflicting-outputs` e ainda compila. READMEs e scripts de CI antigos ainda a passam; o aviso é inofensivo, mas remova a flag para que ele não esconda um aviso real.

6. **Generics precisam de `genericArgumentFactories`.** Uma `sealed class Result<T>` com os cases `Ok<T>` e `Err<T>` precisa de `@JsonSerializable(genericArgumentFactories: true)` (ou `@Freezed(genericArgumentFactories: true)`), e o `fromJson` passa então a receber um parâmetro extra `T Function(Object?) fromJsonT`. Planeje essa assinatura antes de espalhar `Result.fromJson` pelo código.

## Qual escolher

- **Escrita à mão** para hierarquias pequenas e estáveis, ou quando o payload não tem discriminador e você precisa inferir o tipo a partir das chaves. Zero dependências, as melhores mensagens de erro, mas cada campo é código que você mantém.
- **json_serializable nas subclasses** quando você já o usa para DTOs simples e quer manter as subclasses como classes normais com seus próprios métodos. Você escreve cerca de dez linhas de despacho por hierarquia.
- **Freezed** quando você também quer `copyWith`, igualdade por valor e `toString`, ou a hierarquia é grande. Defina o `unionKey` explicitamente, fixe os valores com `@FreezedUnionValue` para dados persistidos e decida de antemão se tipos desconhecidos lançam exceção ou vão para o `fallbackUnion`. A [comparação entre records e Freezed](/pt-br/2026/05/dart-records-vs-freezed-classes/) cobre quando a geração de código do Freezed vale a pena.

### Leia a seguir

- [Corrija FormatException: Unexpected character ao fazer parsing de JSON no Dart](/pt-br/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) para a etapa antes de o `fromJson` sequer rodar.
- [Corrija "type 'Null' is not a subtype of type" no Dart](/pt-br/2026/07/fix-type-null-is-not-a-subtype-of-type-in-dart/), o erro que um campo ausente produz no código `fromJson` gerado.
- [Como tratar erros de rede com elegância em um app Flutter](/pt-br/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/), incluindo onde uma falha de decodificação deve aparecer na UI.
- O equivalente em C#, [serializar uma hierarquia polimórfica com JsonDerivedType no System.Text.Json](/pt-br/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/), resolve o mesmo problema do discriminador com atributos.

### Fontes

- [Dart language: patterns, map patterns](https://dart.dev/language/pattern-types#map) e [class modifiers: sealed](https://dart.dev/language/class-modifiers#sealed)
- [Freezed README: fromJSON for classes with multiple constructors](https://pub.dev/packages/freezed#fromjson---classes-with-multiple-constructors) e o [Freezed changelog](https://pub.dev/packages/freezed/changelog)
- [json_serializable on pub.dev](https://pub.dev/packages/json_serializable) e [issue #1342, sealed class support](https://github.com/google/json_serializable.dart/issues/1342)
- [build_runner changelog](https://pub.dev/packages/build_runner/changelog)
