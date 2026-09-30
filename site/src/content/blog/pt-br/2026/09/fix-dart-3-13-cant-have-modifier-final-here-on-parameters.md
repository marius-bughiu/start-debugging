---
title: "Correção: Can't have modifier 'final' here em parâmetros após atualizar para o Dart 3.13"
description: "O Dart 3.13 reserva final e var em listas de parâmetros para construtores primários. Execute dart fix --apply --code=extraneous_modifier para removê-los e use parameter_assignments no lugar."
pubDate: 2026-09-30
template: error-page
tags:
  - "errors"
  - "dart"
  - "flutter"
  - "dart-3-13"
lang: "pt-br"
translationOf: "2026/09/fix-dart-3-13-cant-have-modifier-final-here-on-parameters"
translatedBy: "claude"
translationDate: 2026-09-30
---

O Dart 3.13 (o SDK do Flutter 3.47) não permite mais escrever `final` ou `var` nos parâmetros de funções comuns, métodos, closures e construtores com corpo. As duas palavras-chave agora são reservadas para declarar parâmetros em construtores primários, então `int add(int a, final int b)` falha com `extraneous_modifier` assim que o seu `pubspec.yaml` declara `sdk: ^3.13.0`. Execute `dart fix --apply --code=extraneous_modifier` para remover todos os modificadores problemáticos de uma só vez. Se você usava `final` para impedir que parâmetros fossem reatribuídos, habilite o lint `parameter_assignments` no lugar.

Tudo abaixo foi reproduzido no Dart 3.13.3 (Flutter 3.47.4) e no Dart 3.12.2 (Flutter 3.44.8) em macOS arm64, e conferido com o changelog da 3.13.0, a especificação aceita de construtores primários e a triagem de [dart-lang/sdk#64151](https://github.com/dart-lang/sdk/issues/64151), onde o time do Dart confirmou que a restrição é intencional.

## O erro em contexto

O `dart analyze` e a IDE relatam isso como um erro do analisador:

```text
error - lib/a.dart:2:16 - Can't have modifier 'final' here. Try removing 'final'. - extraneous_modifier
```

`dart run`, `flutter run` e `flutter build` passam pelo compilador front-end, que imprime o mesmo texto com um cursor sob a palavra-chave:

```text
lib/a.dart:2:16: Error: Can't have modifier 'final' here.
Try removing 'final'.
int add(int a, final int b) => a + b;
               ^^^^^
```

Para `var`, a mensagem troca a palavra-chave: `Can't have modifier 'var' here. Try removing 'var'.` Um parâmetro `var int n` com tipo também relata `var_and_type`, mas esse já era um erro antes da 3.13.

O que confunde é o gatilho. Ninguém mexeu no arquivo. O que mudou foi a restrição do SDK: alguém aumentou `environment: sdk:` para `^3.13.0` para testar construtores primários, ou um template gerou um pacote novo com o limite inferior 3.13, e código que compilava há anos passou a falhar. Uma falha típica de CI é a de #64151: um método auxiliar privado escrito meses antes com `final int precision` na lista de parâmetros, em uma classe que não tem construtor primário em lugar nenhum.

## Por que o Dart 3.13 rejeita final em parâmetros

O Dart 3.13.0 lançou os [construtores primários](https://dart.dev/language/primary-constructors) em 2026-08-12. Um construtor primário fica no cabeçalho da classe, e um parâmetro marcado com `final` ou `var` ali é um *parâmetro declarante*: ele declara um campo de instância além de ser um parâmetro do construtor.

```dart
// Dart 3.13.3
class Point(final int x, final int y); // declares fields x and y
```

Para manter esse significado sem ambiguidade, a [especificação do recurso](https://github.com/dart-lang/language/blob/main/accepted/3.13/primary-constructors/feature-specification.md) proíbe `var x`, `final x` e `final T x` como declarações de parâmetros formais em toda função que não seja um construtor primário. O time do Dart escolheu consistência em vez de uma regra mais estreita: em #64151, Leaf Petersen respondeu com um simples sim à pergunta "isso deveria ser mais restrito?", é intencional.

Dois detalhes fazem parecer uma regressão em vez de uma mudança de linguagem:

1. **Depende da versão da linguagem.** A restrição vale apenas para bibliotecas com versão de linguagem 3.13 ou superior. A versão da linguagem vem do limite inferior de `sdk:` no `pubspec.yaml`, então o mesmo código com `sdk: ^3.12.0` ainda compila no SDK 3.13. É também por isso que o time do Dart não tratou isso como uma quebra de compatibilidade no sentido formal.
2. **Quase não foi documentada no lançamento.** O changelog original da 3.13.0 descrevia construtores primários, mas não sinalizava o efeito em funções comuns. Depois de #64151, o changelog ganhou uma entrada "**Breaking change**: You can no longer use `final` or `var` on non-declaring parameters" na seção Language, e a página de construtores primários ganhou uma seção "Constraints and breaking changes". O único sinal anterior foi a descontinuação do lint `prefer_final_parameters` no Dart 3.11.

## Reprodução mínima

Dois arquivos bastam. O pubspec define a versão da linguagem:

```yaml
# Dart 3.13.3
name: fp
environment:
  sdk: ^3.13.0
```

E uma biblioteca que usa `final` e `var` em todas as posições comuns de parâmetro:

```dart
// Dart 3.13.3, language version 3.13
int add(int a, final int b) => a + b;                   // error

void named({required final String id, final int retries = 3}) {} // 2 errors

void positional([final int? x]) {}                      // error

void callback(final void Function(int) onTap) {}        // error

void untypedVar(var x) {}                               // error

class Money {
  final int cents;
  Money(final int c) : cents = c;                       // error, in-body constructor
  Money operator +(final Money other) => Money(cents + other.cents); // error
  set value(final int v) {}                             // error
  static Money zero(final int unused) => Money(0);      // error
}

void loops(List<int> xs) {
  for (final x in xs) {                                 // fine, not a parameter
    print(x);
  }
  final local = xs.length;                              // fine, local variable
  xs.forEach((final v) => print(v + local));            // error, closure parameter
}

class Point(final int x, final int y);                  // fine, declaring parameters
```

O `dart analyze` na 3.13.3 relata um erro `extraneous_modifier` para cada parâmetro marcado acima. Trocar o pubspec para `sdk: ^3.12.0` faz todos desaparecerem, e os únicos erros restantes ficam na linha de `Point`, que passa a dizer `This requires the 'primary-constructors' language feature to be enabled`.

Parâmetros formais de campo e super parâmetros também são pegos. `T2(final this.x)` e `C(final super.y)` produzem `extraneous_modifier` na 3.13, além de um aviso `unnecessary_final`, porque esses parâmetros sempre foram implicitamente final.

O que *não* é afetado: variáveis locais, `for (final ... in ...)`, variáveis de padrão, campos e parâmetros simples `this.x` / `super.x`.

## A correção, em detalhes

Escolha uma destas, em ordem de preferência.

### 1. Deixe o dart fix remover os modificadores

O analisador traz uma correção para `extraneous_modifier`, então a migração é mecânica:

```bash
dart fix --dry-run
```

No pacote de reprodução, isso relata `extraneous_modifier - 11 fixes` em `lib/a.dart`, um por erro. Aplique apenas esse código para que nada mais no projeto seja reescrito:

```bash
dart fix --apply --code=extraneous_modifier
```

O diff resultante é exatamente o que você escreveria à mão:

```dart
// Dart 3.13.3, after dart fix
int add(int a, int b) => a + b;
void named({required String id, int retries = 3}) {}
void positional([int? x]) {}
void callback(void Function(int) onTap) {}
void untypedVar(x) {}

class Money {
  final int cents;
  Money(int c) : cents = c;
  Money operator +(Money other) => Money(cents + other.cents);
  set value(int v) {}
  static Money zero(int unused) => Money(0);
}
```

Depois da correção, o `dart analyze` não relata nenhum problema e o programa roda. Em um app Flutter o comando é o mesmo; o `flutter` apenas usa o SDK do Dart que ele embute, então execute `dart fix` a partir da raiz do projeto com o Flutter 3.47 no path.

Note que `var x` vira apenas `x`, que é um parâmetro implicitamente `dynamic`. Isso compila, mas se você usa `strict-raw-types` ou configurações parecidas do analisador, aproveite para dar um tipo de verdade.

### 2. Mantenha a regra "não reatribuir parâmetros" com um lint

A maioria das pessoas escrevia `final` em parâmetros para transformar a reatribuição em erro de compilação. Essa garantia agora vem do linter:

```yaml
# analysis_options.yaml, Dart 3.13.3
linter:
  rules:
    - parameter_assignments
```

```dart
// Dart 3.13.3
int clamp(int value, int max) {
  if (value > max) value = max; // info: Invalid assignment to the parameter 'value'.
  return value;
}
```

Não use `prefer_final_parameters` para recuperar o comportamento antigo. Ele está descontinuado desde o Dart 3.11, e na 3.13 habilitá-lo produz `The lint rule 'prefer_final_parameters' is deprecated and shouldn't be enabled`. O conselho dele agora apontaria para código que não compila. Se o pacote de lints compartilhado da sua equipe ainda o habilita, esse pacote também precisa de atualização.

### 3. Fixe um único arquivo na versão antiga da linguagem

Quando você não pode mexer em um arquivo hoje, por exemplo código gerado ou uma biblioteca vendorizada, um comentário de versão da linguagem no topo do arquivo tira aquela biblioteca da regra:

```dart
// @dart=3.12
// Dart 3.13.3 SDK, this library uses language version 3.12
int legacyAdd(int a, final int b) => a + b; // compiles
```

O restante do pacote pode usar construtores primários. Isso é um paliativo: um arquivo fixado na 3.12 não pode usar nenhum recurso da 3.13, e você vai querer apagar o comentário assim que o arquivo for limpo.

### 4. Mantenha a restrição do SDK na 3.12 até estar pronto

Como a verificação depende da versão da linguagem do seu pacote, e não do SDK que você executa, o SDK 3.13 compila sem problemas um pacote cuja restrição é `sdk: ^3.12.0`. Se você aumentou a restrição apenas porque um template ou um `pub upgrade --major-versions` fez isso por você, reverter o limite inferior é uma correção válida a curto prazo. As dependências não são afetadas de qualquer forma: na minha reprodução, uma dependência por path com `sdk: ^3.12.0` e `final` em um parâmetro compilou e rodou normalmente dentro de um app 3.13, porque cada pacote é compilado na sua própria versão da linguagem.

## Prepare uma base de código 3.12 antes da atualização

Se você ainda está no Flutter 3.44 / Dart 3.12, dá para encontrar e corrigir tudo antes de aumentar a restrição. A página de construtores primários recomenda dois lints que existem na 3.12.2:

```yaml
# analysis_options.yaml, Dart 3.12.2
linter:
  rules:
    - avoid_final_parameters
    - var_with_no_type_annotation
```

Na 3.12.2 eles relatam `Parameters should not be marked as 'final'` e `Avoid declaring parameters with var and no type annotation`, e ambos têm suporte a `dart fix` (`--code=avoid_final_parameters` e `--code=var_with_no_type_annotation`). Corrija os avisos, depois aumente `sdk:` para `^3.13.0`, e a atualização não produz nenhum erro `extraneous_modifier`.

## Pegadinhas e casos parecidos

- **Geradores de código também emitem isso.** O freezed 3.x gerava construtores como `const _Example({required final List<String> someField})` para campos de coleção, o que quebra em um pacote 3.13 ([rrousselGit/freezed#1365](https://github.com/rrousselGit/freezed/issues/1365)). O freezed 4.0.0 (2026-08-22) removeu o `final` dos parâmetros de construtores gerados, e a 4.0.2 é a versão atual. Atualize o gerador e execute `dart run build_runner build` de novo. Rodar `dart fix` em arquivos `.freezed.dart` não adianta, porque o próximo build os regenera. Se você usa outro gerador, procure "Dart 3.13" ou "primary constructors" no changelog dele antes de culpar o seu código.
- **Ferramentas que analisam seu código podem esbarrar nisso até na 3.12.** Em #64151, a falha veio de uma ferramenta que chamava `parseString()` do analisador sem um `featureSet`. Isso assume por padrão a versão de linguagem mais nova que o analisador conhece, então o analyzer 13.1.0 e posteriores rejeitaram parâmetros `final` em um pacote que ainda estava em uma versão de linguagem mais antiga. Se um builder customizado, uma ferramenta de documentação ou um script de métricas de código falha enquanto o `dart analyze` passa, essa é a causa, e a correção pertence à ferramenta.
- **A mensagem nunca menciona construtores primários.** O time do Dart discutiu uma mensagem mais longa em #64151 e decidiu contra, então `Try removing 'final'` é o que você recebe. Se você chegou aqui por essa string exata, esta página é a explicação.
- **`var` sem tipo vira `dynamic`.** O `dart fix` transforma `(var x)` em `(x)`, não em `(Object? x)`. Adicione um tipo se isso importa para você.
- **Mapeamento de versões do Flutter.** O Flutter 3.47.0 até 3.47.5 embute o Dart 3.13.0 até 3.13.4. Atualizar só o Flutter não muda nada; os erros aparecem apenas quando o limite inferior de `sdk:` de um pacote chega à 3.13, então depois desse aumento, trechos copiados de respostas antigas que usam parâmetros `final` falham imediatamente.
- **Não é o mesmo que campos `final` em um construtor primário.** `class User(final String name);` é código 3.13 válido e declara um campo. Se você recebe `extraneous_modifier` em um parâmetro de construtor primário, confira se a lista de parâmetros realmente está no cabeçalho da classe e não em um construtor com corpo.

## Relacionados

- O recurso que causou isso, nos tempos experimentais: [construtores primários no Dart 3.12](/pt-br/2026/06/dart-3-12-experimental-primary-constructors/).
- Outra surpresa da atualização para a 3.13 que não aparece no seu diff: [CERTIFICATE_VERIFY_FAILED na imagem Docker do Dart 3.13](/pt-br/2026/09/fix-certificate-verify-failed-in-dart-3-13-docker-image/).
- Se aumentar a restrição do SDK também quebrou a resolução de dependências, veja [como corrigir version solving failed no pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/).
- Escolhendo entre classes de dados geradas e tipos nativos após a atualização para o freezed 4.0: [records do Dart vs classes freezed](/pt-br/2026/05/dart-records-vs-freezed-classes/).
- Se o `dart fix` e o analisador estão lentos em um repositório grande, [acelere o servidor de análise do Dart no VS Code](/pt-br/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/).

## Fontes

- [dart-lang/sdk#64151: `final` no longer allowed on parameters of normal functions/methods](https://github.com/dart-lang/sdk/issues/64151)
- [Dart SDK CHANGELOG, 3.13.0 Language section](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [Primary constructors feature specification (accepted/3.13)](https://github.com/dart-lang/language/blob/main/accepted/3.13/primary-constructors/feature-specification.md)
- [Primary constructors, dart.dev](https://dart.dev/language/primary-constructors)
- [`parameter_assignments` lint rule](https://dart.dev/tools/linter-rules/parameter_assignments)
- [`avoid_final_parameters` lint rule](https://dart.dev/tools/linter-rules/avoid_final_parameters)
- [rrousselGit/freezed#1365: invalid `final` keyword in generated constructor parameters](https://github.com/rrousselGit/freezed/issues/1365)
- [freezed CHANGELOG (4.0.0, 4.0.2)](https://github.com/rrousselGit/freezed/blob/master/packages/freezed/CHANGELOG.md)
