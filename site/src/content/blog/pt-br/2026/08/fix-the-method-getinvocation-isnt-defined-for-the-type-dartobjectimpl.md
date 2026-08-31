---
title: "Correção: The method 'getInvocation' isn't defined for the type 'DartObjectImpl'"
description: "O build_runner não compila porque source_gen 3.1.0 ou 4.0.0 chama uma API do analyzer removida no analyzer 8.4.0. Atualize o gerador que prende source_gen abaixo de 4.0.1."
pubDate: 2026-08-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "build-runner"
  - "source-gen"
lang: "pt-br"
translationOf: "2026/08/fix-the-method-getinvocation-isnt-defined-for-the-type-dartobjectimpl"
translatedBy: "claude"
translationDate: 2026-08-31
---

O `build_runner` está falhando ao compilar o próprio script de build, não o seu código. `source_gen` 3.1.0 e 4.0.0 chamam `DartObjectImpl.getInvocation()`, que o `analyzer` 8.4.0 removeu, e os dois pacotes declaram restrições folgadas o bastante para o pub emparelhá-los. Resolva atualizando o gerador de código do seu `pubspec.yaml` que prende `source_gen` abaixo de 4.0.1. Se não der para atualizar hoje, adicione `dependency_overrides: analyzer: 8.3.0` como paliativo.

## O erro, por inteiro

Você roda `dart run build_runner build` (ou `flutter pub run build_runner build`) e recebe um erro de compilação do front-end do Dart apontando para o seu cache do pub:

```text
[INFO] Generating build script...
../../.pub-cache/hosted/pub.dev/source_gen-3.1.0/lib/src/constants/revive.dart:82:40:
Error: The method 'getInvocation' isn't defined for the type 'DartObjectImpl'.
 - 'DartObjectImpl' is from 'package:analyzer/src/dart/constant/value.dart'
   ('../../.pub-cache/hosted/pub.dev/analyzer-8.4.1/lib/src/dart/constant/value.dart').
Try correcting the name to the name of an existing method, or defining a method
named 'getInvocation'.
  final i = (object as DartObjectImpl).getInvocation();
                                       ^^^^^^^^^^^^^
[SEVERE] Failed to compile build script. Check builder definitions and generated
script .dart_tool/build/entrypoint/build.dart.
```

Dois detalhes dessa saída fazem o diagnóstico por você. O arquivo que falha está em `source_gen`, não no seu projeto. E os números de versão nesses dois caminhos de cache são o bug inteiro: `source_gen-3.1.0` contra `analyzer-8.4.1`.

Tudo abaixo foi verificado contra os arquivos de pacote do pub.dev e vale para Flutter 3.47.0 com Dart 3.13.0, o canal estável em agosto de 2026, assim como para qualquer projeto Dart 3.x mais antigo que resolva o mesmo par.

## Por que o analyzer 8.4.0 removeu o método

O `source_gen` precisa responder uma pergunta para cada anotação que encontra: dado um objeto const que o analyzer já avaliou, qual código-fonte o recriaria. É isso que `reviveInstance` faz em `source_gen/lib/src/constants/revive.dart`, e é assim que `@JsonSerializable(fieldRename: FieldRename.snake)` vira configuração utilizável dentro de um builder.

Para isso, o `source_gen` precisava do construtor e dos valores dos argumentos por trás de um `DartObject`. Durante anos a única forma de obtê-los era um import de implementação:

```dart
// source_gen 3.1.0, lib/src/constants/revive.dart
// ignore: implementation_imports
import 'package:analyzer/src/dart/constant/value.dart' show DartObjectImpl;

// ...
final i = (object as DartObjectImpl).getInvocation();
```

Esse comentário `// ignore: implementation_imports` é o próprio lint do analyzer avisando o `source_gen` de que ele está entrando em um diretório `src/` sem nenhuma promessa de estabilidade de API.

A equipe do analyzer fechou a lacuna de fundo. A versão 8.1.0, publicada em 2025-08-07, adicionou `DartObject.constructorInvocation` à superfície pública de `package:analyzer/dart/constant/value.dart`, retornando um `ConstructorInvocation` com `constructor`, `positionalArguments` e `namedArguments`. Na 8.3.0 o ponto de entrada antigo ainda existia, marcado para remoção:

```dart
// analyzer 8.3.0, lib/src/dart/constant/value.dart
@Deprecated('Use constructorInvocation instead')
ConstructorInvocationImpl? getInvocation() {
  return constructorInvocation;
}
```

O analyzer 8.4.0, publicado em 2025-10-15, tirou esse método. `constructorInvocation` continua lá, mas não existe mais nada chamado `getInvocation` em lugar nenhum do pacote. Qualquer código que ainda o chame para de compilar no instante em que essa versão é resolvida.

O `source_gen` já tinha se movido. A versão 4.0.1, publicada em 2025-09-04, passou a usar o getter público e apertou a própria restrição para `analyzer: ^8.1.1`:

```dart
// source_gen 4.0.1 and later, lib/src/constants/revive.dart
final i = object.constructorInvocation;
if (i != null) {
  url = Uri.parse(urlOfElement(i.constructor.enclosingElement));
  // ...
}
```

Repare no import de implementação que sumiu. Essa é a correção de verdade, e é por isso que toda versão do `source_gen` a partir da 4.0.1 é imune.

## O buraco no resolvedor que junta as versões quebradas

Se o `source_gen` 4.0.1 corrigiu isso em setembro e o analyzer 8.4.0 chegou em outubro, por que alguém ainda esbarra nisso? Porque as versões quebradas nunca declararam a incompatibilidade, e o pub só lê declarações.

Estas são as restrições que importam:

| Pacote | Restrição sobre analyzer | Chama `getInvocation` |
| --- | --- | --- |
| `source_gen` 3.0.0 | `^7.4.0` | sim, mas limitado abaixo de 8.0.0, então é seguro |
| `source_gen` 3.1.0 | `>=7.4.0 <9.0.0` | sim, e 8.4.x está dentro da faixa |
| `source_gen` 4.0.0 | `>=7.4.0 <9.0.0` | sim, e 8.4.x está dentro da faixa |
| `source_gen` 4.0.1+ | `^8.1.1` | não |

`source_gen` 3.1.0 e 4.0.0 são as duas únicas versões publicadas que chamam o método removido e ao mesmo tempo permitem analyzer 8.4.x. O limite superior `<9.0.0` foi uma aposta de que um salto major carregaria qualquer mudança incompatível. A equipe do analyzer removeu um membro obsoleto em uma versão menor, o que é normal para algo que nunca foi API pública.

O pub prefere a versão mais nova que satisfaça todas as restrições, então um projeto sem outra pressão resolve `source_gen` 4.3.0 e nunca vê isso. A falha precisa que algo no seu grafo segure o `source_gen` para baixo. Esse algo quase sempre é um gerador de código com um pin de caret. O `objectbox_generator` 5.0.0, publicado em 2025-10-01, declarava `source_gen: ^3.1.0`, que resolve para exatamente uma versão, 3.1.0, porque 3.1.0 é o último lançamento da linha 3.x. Duas semanas depois o analyzer 8.4.0 saiu, e todo projeto com ObjectBox que rodou `dart pub upgrade` ganhou um script de build que não compilava.

O changelog do ObjectBox para a 5.0.1 nomeia a falha diretamente: "Generator: migrate to `analyzer` 8 APIs. Require at least `analyzer` 8.1.1 and `source_gen` 4.0.1. Resolves `Error: The method 'getInvocation' isn't defined` when running the generator using `analyzer` 8.4.0".

O ObjectBox não estava sozinho. O `json_serializable` 6.11.0 saiu com `source_gen: ^3.1.0` e alargou para `>=3.1.0 <5.0.0` na 6.11.1. `retrofit_generator` 10.0.2, `chopper_generator` 8.3.1, `built_value_generator` 8.11.1 e `envied_generator` 1.2.1 carregavam o mesmo formato de pin na mesma janela. Como `source_gen` é um único nó compartilhado do grafo de dependências, um gerador desatualizado arrasta todos os outros geradores do seu projeto junto para a 3.1.0. Um projeto que usa `freezed`, `json_serializable` e um builder sem manutenção vai culpar o pacote errado toda vez.

## Reproduzindo a partir de um pubspec limpo

```yaml
# pubspec.yaml
# Dart 3.9.x. Any SDK that admits analyzer 8.4.x reproduces this.
name: repro
environment:
  sdk: ^3.9.0

dependencies:
  objectbox: 5.0.0

dev_dependencies:
  build_runner: ^2.9.0
  objectbox_generator: 5.0.0
```

Rode `dart pub get` e depois leia o que foi realmente escolhido:

```bash
dart pub deps --style=compact | grep -E 'source_gen|analyzer'
```

Você vai ver `source_gen 3.1.0` e `analyzer 8.4.1`. Esse par é o bug. `dart run build_runner build` então falha com o erro do topo deste artigo, antes de uma única linha do seu código ser analisada.

## Correção 1: atualize o gerador que prende source_gen

Esta é a correção certa e costuma ser de uma linha. Encontre a restrição que está limitando o `source_gen` e suba ela.

Peça ao pub que identifique o culpado exigindo uma versão que ele não consegue dar:

```bash
dart pub add dev:source_gen:^4.0.1
```

A resolução de versões falha, e a explicação nomeia o pacote que segura o pin:

```text
Because objectbox_generator 5.0.0 depends on source_gen ^3.1.0 and no versions
        of objectbox_generator match >5.0.0 <6.0.0, objectbox_generator 5.0.0
        requires source_gen ^3.1.0.
So, because repro depends on both objectbox_generator 5.0.0 and
source_gen ^4.0.1, version solving failed.
```

Leia isso de baixo para cima, do mesmo jeito que você leria qualquer [falha de resolução de versões do pub](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/). A linha de cima é o fato que você precisa mudar.

Depois suba o pacote nomeado e deixe a correção fluir:

```bash
dart pub upgrade objectbox objectbox_generator
dart run build_runner build --delete-conflicting-outputs
```

Pisos comprovados, caso você prefira defini-los explicitamente:

- `objectbox_generator` 5.0.1 ou posterior
- `json_serializable` 6.11.1 ou posterior
- `chopper_generator` 8.5.0 ou posterior
- `envied_generator` 1.3.2 ou posterior
- `retrofit_generator` 10.2.3 ou posterior
- `built_value_generator` 8.11.2 ou posterior

Não adicione `source_gen` às suas próprias `dev_dependencies` como correção. Ele é uma dependência transitiva dos seus geradores, e prendê-lo no seu pubspec só move o conflito para o seu arquivo, onde ele vai apodrecer.

## Correção 2: prenda o analyzer como paliativo

Se o gerador problemático foi abandonado ou você está no meio de uma release e não pode aceitar uma atualização, segure o analyzer na última versão que ainda traz o método obsoleto:

```yaml
# pubspec.yaml
# Temporary. Delete once the generator is upgraded.
dependency_overrides:
  analyzer: 8.3.0
```

O analyzer 8.3.0 (2025-10-10) é o último lançamento com `getInvocation` presente. Isso funciona porque o método obsoleto era um encaminhamento de uma linha para `constructorInvocation`, então o comportamento é idêntico.

Dois custos, os dois reais. `dependency_overrides` silencia o resolvedor para todos os pacotes do grafo, então um segundo pacote que realmente precise do analyzer 8.4+ vai falhar em tempo de compilação em vez de no `pub get`. E overrides são ignorados quando o seu pacote é consumido como dependência, então um pacote publicado não pode entregar isso como correção para os próprios usuários. Trate como um desbloqueio no nível do branch com um TODO datado, e acompanhe com um job de CI que compile sem o override para você descobrir quando ele deixar de ser necessário. Se você mantém mais de um branch em SDKs diferentes, [mirar em várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) é o padrão para manter os dois honestos.

## Correção 3: se a chamada está no seu próprio builder

Se o caminho que falha no erro é o seu próprio pacote e não o `source_gen`, você escreveu a chamada e a migração é sua. É uma troca direta:

```dart
// Before. Requires the implementation import of DartObjectImpl.
// ignore: implementation_imports
import 'package:analyzer/src/dart/constant/value.dart' show DartObjectImpl;

final invocation = (object as DartObjectImpl).getInvocation();
```

```dart
// After. analyzer 8.1.0 and later. Public API, no src/ import.
import 'package:analyzer/dart/constant/value.dart';

final invocation = object.constructorInvocation;
if (invocation != null) {
  final ctor = invocation.constructor;
  final positional = invocation.positionalArguments;
  final named = invocation.namedArguments;
}
```

Apague o ignore de `implementation_imports` junto. Depois defina o seu próprio piso em `analyzer: '>=8.1.1'` para que o pub não possa entregar ao seu código um analyzer sem o getter. Esse limite inferior é a parte que as pessoas pulam, e é o que transforma um pacote corrigido de novo em um pacote quebrado para alguém em um SDK mais antigo.

Já que você está aí, note que `ConstructorInvocation.constructor2` existe e está obsoleto em favor de `constructor`. Migre os dois na mesma passada em vez de trocar uma remoção pela próxima.

## Pegadinhas e sósias

**`flutter clean` não resolve isso e nunca resolveu.** O conselho mais repetido para falhas do build_runner é apagar `.dart_tool` e recompilar. Aqui isso só roda a mesma compilação contra as mesmas versões resolvidas. Se o erro menciona um arquivo dentro de `.pub-cache`, a resolução está errada e nenhuma limpeza de cache muda isso.

**`--delete-conflicting-outputs` também não resolve.** Essa flag trata de um build que produziu um arquivo que outro builder quer escrever. Ela roda depois que o script de build compila, e aqui o script de build nunca compila.

**O lockfile é o gatilho de sempre.** Nada no seu pubspec mudou; um `dart pub upgrade`, um checkout limpo de CI sem `pubspec.lock` commitado, ou o `pub get` de um colega moveu o analyzer para 8.4.x enquanto o `source_gen` ficou preso em 3.1.0. Se a máquina de um colega ainda compila, compare os dois lockfiles antes de qualquer outra coisa.

**Erros irmãos, causa idêntica.** `The getter 'name' isn't defined for the class 'NamedType'`, `The getter 'tmp' isn't defined for the class 'Diagnostic'` e `DotShorthandConstructorInvocation isn't defined` são todos o mesmo modo de falha: um builder compilado contra uma API do analyzer que mudou de lugar. O diagnóstico não muda. Leia as duas versões nos caminhos de cache do erro, ache o pacote que prende a mais velha, atualize. É o mesmo formato de quebra de [um plugin que remove o construtor sem nome](/pt-br/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/), só que a API pertence a um pacote que você nunca escreveu.

**O analyzer 9.0.0 não é a fronteira que você quer.** Ele saiu em 2025-10-23, oito dias depois da 8.4.0. Colocar `analyzer: <9.0.0` não protege, porque 8.4.x já está abaixo disso. Os únicos pisos seguros são `source_gen: '>=4.0.1'` do lado do gerador e `analyzer: '>=8.1.1'` do seu.

## Relacionados

- Ler a prova de falha do pub é a habilidade central aqui: [Version solving failed in pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/) percorre a saída do PubGrub linha por linha.
- `freezed` é um builder de `source_gen` como qualquer outro, então essa falha pode atingir um projeto que só o usa para classes de dados. [Dart records vs classes Freezed](/pt-br/2026/05/dart-records-vs-freezed-classes/) cobre quando você precisa da geração de código afinal.
- O gerador do Riverpod se apoia na mesma pilha: [migrar do Riverpod 2.x para o Riverpod 3.0](/pt-br/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/) inclui o salto de codegen.
- Uma atualização de pacote que remove um construtor em vez de um método: [The class 'GoogleSignIn' doesn't have an unnamed constructor](/pt-br/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/).
- Para manter um projeto compilando enquanto uma atualização de gerador aterrissa, veja [mirar em várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Fontes

- [Changelog do source_gen](https://pub.dev/packages/source_gen/changelog), pela mudança da 4.0.1 para `analyzer: ^8.1.1`. As restrições de versão e as datas de publicação foram lidas dos arquivos de pacote do pub.dev de 3.1.0, 4.0.0 e 4.0.1.
- [Changelog do analyzer](https://pub.dev/packages/analyzer/changelog), pela 8.1.0 adicionando `DartObject.constructorInvocation`. A presença do `getInvocation()` obsoleto na 8.3.0 e sua ausência na 8.4.0 foram confirmadas contra os arquivos publicados das duas versões.
- [Changelog do objectbox](https://pub.dev/packages/objectbox/changelog), versão 5.0.1, publicada em 2025-10-29, que nomeia exatamente este erro e sua correção.
- [build_runner no pub.dev](https://pub.dev/packages/build_runner). A mensagem "Failed to compile build script" vem de `lib/src/bootstrap/bootstrapper.dart`.
- [dart pub deps](https://dart.dev/tools/pub/cmd/pub-deps) e [a documentação do resolvedor PubGrub](https://github.com/dart-lang/pub/blob/master/doc/solver.md) para os comandos de diagnóstico.
