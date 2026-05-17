---
title: "Fix: Version solving failed em pubspec.yaml"
description: "A correção em 30 segundos: leia a cadeia 'because' do erro, encontre a única restrição que prende o pub, e ou amplie essa restrição ou adicione uma entrada em dependency_overrides. Não comece com flutter clean."
pubDate: 2026-05-17
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "pub"
  - "pubspec"
lang: "pt-br"
translationOf: "2026/05/fix-version-solving-failed-in-pubspec-yaml"
translatedBy: "claude"
translationDate: 2026-05-17
---

A correção em uma frase: `Version solving failed` não é um bug, é o `dart pub` te dizendo que as restrições que você escreveu no `pubspec.yaml` não podem ser satisfeitas todas ao mesmo tempo. Leia a cadeia de linhas `because ... depends on ...` de baixo para cima, encontre a única restrição impossível de satisfazer (normalmente um limite inferior do SDK do Dart ou um pacote fixado em uma versão mais antiga do que um dos seus consumidores precisa) e então amplie essa restrição ou adicione uma entrada em `dependency_overrides` para forçar uma versão específica. `flutter clean` e apagar o `pubspec.lock` não vão resolver isso.

```text
Resolving dependencies...
Because every version of flutter_test from sdk depends on collection 1.19.0
        and my_app depends on collection ^1.18.0, flutter_test from sdk is forbidden.
So, because my_app depends on flutter_test any from sdk, version solving failed.

pub get failed (1; So, because my_app depends on flutter_test any from sdk,
version solving failed.)
exit code 1
```

Este guia foi escrito contra Dart 3.11 e Flutter 3.41.5, o canal stable em maio de 2026. O comportamento do resolvedor descrito abaixo é o mesmo algoritmo `PubGrub` que vem no `dart pub` desde o Dart 2.10, então tudo aqui se aplica diretamente a qualquer projeto Flutter 3.x ou Dart 3.x. O código-fonte relevante fica em [dart-lang/pub](https://github.com/dart-lang/pub) dentro de `lib/src/solver/`.

## O que o erro realmente significa

`dart pub get` roda um resolvedor estilo SAT chamado [PubGrub](https://github.com/dart-lang/pub/blob/master/doc/solver.md). Ele percorre todas as restrições do seu `pubspec.yaml`, incluindo as restrições transitivas extraídas do `pubspec.yaml` de cada dependência, e tenta encontrar um único conjunto de versões de pacotes em que toda restrição seja satisfeita ao mesmo tempo. Quando esse conjunto não existe, ele não desiste após uma tentativa. Volta atrás, aprende um fato sobre quais combinações são impossíveis e tenta de novo. A saída que você vê é a **explicação** da prova de que não existe solução.

Cada linha é um fato. Leia de baixo para cima: a linha inferior é a conclusão (`version solving failed`), e as linhas acima dela são a cadeia de fatos que forçou essa conclusão. O fato no topo da cadeia é a restrição que você de fato escreveu, e provavelmente a que precisa mudar.

A mensagem de erro tem estrutura. O pub nomeia cada pacote relevante, imprime a restrição exata e te diz quem está pedindo aquilo. Não há por que adivinhar quando você desacelera e lê.

## Uma reprodução mínima que demonstra a falha

Crie um pacote novo e fixe duas dependências cujas restrições transitivas se contradizem:

```yaml
# pubspec.yaml, Flutter 3.41.5, Dart 3.11
name: my_app
environment:
  sdk: '>=2.17.0 <3.0.0'

dependencies:
  flutter:
    sdk: flutter
  http: ^1.5.0
  some_legacy_package: 0.4.2
```

Rode `flutter pub get` e você obtém:

```text
Because http >=1.0.0 requires SDK version >=3.0.0 <4.0.0
        and my_app requires SDK version >=2.17.0 <3.0.0, http >=1.0.0 is forbidden.
So, because my_app depends on http ^1.5.0, version solving failed.
```

Essa é a forma mais comum do erro em projetos reais. A restrição que quebra a resolução é o seu próprio limite inferior do SDK. O pacote que você pediu está em ordem; o SDK que você disse suportar é a parte impossível.

Uma segunda forma comum é uma colisão transitiva:

```text
Because flutter_test from sdk depends on collection 1.19.0
        and riverpod 3.0.0 depends on collection ^1.18.0,
        flutter_test from sdk is incompatible with riverpod 3.0.0.
So, because my_app depends on both flutter_test from sdk and riverpod ^3.0.0,
version solving failed.
```

Mesmo algoritmo, causa diferente. Aqui o pin de SDK do `flutter_test` é exato (`1.19.0`) e o `riverpod` aceita qualquer coisa de `1.18.0` até, mas sem incluir, `2.0.0`. Os dois podem ser satisfeitos se você atualizar o `riverpod` para uma versão cujo limite inferior de `collection` seja `1.19.0` ou superior. A correção está na versão que você escolhe, não na sintaxe da restrição.

## Correção, em ordem de frequência com que é a resposta

Execute os passos abaixo em ordem. Não pule nenhum. Cada passo assume que o anterior não resolveu o erro.

### 1. Leia o erro e identifique o gargalo

Abra a saída do terminal. Encontre a primeira linha `Because ...` e a restrição nomeada bem no topo da cadeia. Esse é o fato impossível. No exemplo de SDK acima é `my_app requires SDK version >=2.17.0 <3.0.0`. No exemplo transitivo é `flutter_test from sdk depends on collection 1.19.0`.

Anote duas coisas:

1. O pacote cuja restrição não pode ser satisfeita (a **vítima**).
2. A restrição que o encurrala (o **culpado**).

Se você não consegue identificar os dois, não leu a cadeia com atenção. Leia de novo.

### 2. Suba o limite inferior do seu SDK

Em 2026, a causa mais comum é uma restrição de SDK desatualizada. Qualquer pacote publicado nos últimos 18 meses que use recursos do Dart 3 (records, patterns, sealed classes, as novas expressões `switch`) vai definir sua restrição de SDK como `^3.0.0`. Se seu `pubspec.yaml` ainda diz `>=2.17.0 <3.0.0`, você não consegue instalar esse pacote. Atualize para a sintaxe de caret contra a versão de Dart que você realmente tem:

```yaml
# pubspec.yaml, after running `dart --version`
environment:
  sdk: ^3.0.0
  flutter: '>=3.10.0'
```

Use `^3.0.0` (tudo de 3.0.0 até, sem incluir, 4.0.0), não `^3.11.0`. O limite inferior comunica "este é o Dart mais antigo contra o qual eu testei"; deixá-lo igual à versão do seu notebook obriga todo colaborador a atualizar sem motivo. Veja a [documentação do pubspec](https://dart.dev/tools/pub/pubspec) para a sintaxe.

### 3. Atualize a dependência em conflito

Se o culpado é um pacote de terceiros, a segunda correção mais comum é que você está fixado em uma versão major antiga. `flutter pub outdated` mostra cada dependência, qual versão foi resolvida e qual é a mais recente:

```bash
# Flutter 3.41.5
flutter pub outdated
```

Procure pelo pacote nomeado no passo 1. Se a coluna **latest** está mais alta do que a que você tem, rode:

```bash
flutter pub upgrade --major-versions <package_name>
```

Isso reescreve a restrição no `pubspec.yaml` para a última versão major compatível e roda o resolvedor de novo. Se o pacote segue semver, você pode ter que arrumar mudanças incompatíveis no seu código, mas o erro do resolvedor some.

### 4. Afrouxe uma restrição apertada demais

Se você escreveu uma restrição na mão e a fixou mais estrita do que o necessário, amplie. Os dois erros de fixação excessiva mais comuns:

```yaml
# Apertado demais: pin exato
some_package: 1.5.3

# Apertado demais: caret em versão pré-1.0
some_package: ^0.4.2  # permite >=0.4.2 <0.5.0, muitas vezes estreito demais
```

Substitua por um caret na versão major (`^1.5.3` permite `>=1.5.3 <2.0.0`) ou por um intervalo explícito que cubra as versões que você está disposto a aceitar (`'>=0.4.0 <0.6.0'`). A [documentação do Dart sobre restrições de dependências](https://dart.dev/tools/pub/dependencies) explica a sintaxe de caret tanto para pacotes pré-1.0 quanto pós-1.0.

### 5. Use `dependency_overrides` para conflitos transitivos que você não consegue resolver

Quando o culpado é uma dependência transitiva sobre a qual duas das suas dependências diretas discordam, e nenhuma tem uma versão que resolva o conflito, sobrescreva explicitamente. Isso vai no `pubspec.yaml` do pacote raiz apenas; sobrescritas em uma dependência que você consome são ignoradas pelo resolvedor.

```yaml
# pubspec.yaml, Flutter 3.41.5, Dart 3.11
name: my_app
environment:
  sdk: ^3.0.0

dependencies:
  flutter:
    sdk: flutter
  riverpod: ^3.0.0
  some_other_package: ^2.0.0

dependency_overrides:
  collection: ^1.19.0
```

`dependency_overrides` é uma marreta. O resolvedor para de impor restrições sobre o pacote sobrescrito e usa a sua versão em todo lugar onde ele aparecer no grafo. Se algum consumidor de `collection` depende de uma API removida no `1.19.0`, vai compilar mas falhar em runtime. Use isso só depois de verificar que a versão que está forçando é de fato compatível, e remova a sobrescrita assim que a dependência upstream se atualizar.

### 6. Último recurso: regenere o `pubspec.lock`

O lockfile fica a jusante da resolução, não a montante. Apagá-lo não pode consertar um problema de restrição, e a maioria dos posts de blog que recomendam isso como primeiro passo está errada. A única hora em que apagar o `pubspec.lock` ajuda é se você já mudou o `pubspec.yaml` e o lockfile agora está impedindo o resolvedor de escolher uma nova versão compatível:

```bash
# Flutter 3.41.5
rm pubspec.lock
flutter pub get
```

Faça isso só depois dos passos 1 ao 5. Se `pub get` ainda falha depois de regenerar o lockfile, as restrições continuam impossíveis e você não consertou nada de verdade.

## Pegadinhas e casos parecidos

Alguns casos que produzem um erro parecido ou parecem ser resolução de versão mas não são:

- **`pub get failed (server unavailable)`**: é um problema de rede ou de registro, não de resolução. Verifique `PUB_HOSTED_URL` se você configurou; uma URL de mirror incorreta vai retornar 404s e a falha aparece próxima a, mas não como, `version solving failed`.
- **`The current Dart SDK version is X.Y.Z. Because my_app requires SDK version ^A.B.C, version solving failed.`**: essa é a forma mais direta do erro. Você rodou `flutter pub get` com um SDK Dart mais antigo do que o que seu próprio `pubspec.yaml` declara. Ou atualize o Flutter (`flutter upgrade`) ou baixe a restrição.
- **`pub get` funciona local mas falha no CI**: a sua versão de Flutter no CI é mais antiga que a local. Fixe a versão do Flutter no CI para coincidir. O post [como mirar em várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) cobre o padrão de matriz.
- **`Gradle build failed to produce an .apk file` logo depois de um `pub get`**: não é erro do resolvedor de jeito nenhum. A fase de build nativo está falhando. Veja [Gradle build failed to produce an apk file](/pt-br/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) (a mesma correção se aplica ao Flutter Android).
- **Versões pré-release são silenciosamente ignoradas**: por padrão, o resolvedor não vai escolher `2.0.0-beta.1` quando você pede `^1.0.0`, mesmo que não exista um `2.0.0` estável. Para optar, use a versão explícita: `some_package: ^2.0.0-beta.1`.
- **Um pacote com dependências `git:` ou `path:`**: o resolvedor continua aplicando restrições de versão, mas a fonte é a referência git ou o caminho que você escreveu, não pub.dev. Uma resolução de versão que falha numa dependência git quase sempre é porque o próprio `pubspec.yaml` da branch referenciada está quebrado; clone o pacote localmente e rode `dart pub get` lá dentro para ver.

Se você está recorrendo a `dependency_overrides` mais de uma vez por trimestre, sua árvore de dependências tem problemas estruturais. Ou você está usando pacotes demais do mesmo micro-domínio (três clientes HTTP, dois gerenciadores de estado), ou suas dependências diretas não estão acompanhando as transitivas delas. Podar a árvore corrige mais erros do resolvedor do que qualquer edição isolada de restrição.

## Relacionados

- [Fix: FormatException: Unexpected character ao fazer parse de JSON em Dart](/pt-br/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/)
- [Fix: A RenderFlex overflowed by N pixels em Flutter](/pt-br/2026/05/fix-renderflex-overflowed-in-flutter/)
- [Como mirar em várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Como escrever um isolate de Dart para trabalho intensivo em CPU](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)
- [Como fazer profile de jank em um app Flutter com DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)

## Fontes

- [The pubspec file](https://dart.dev/tools/pub/pubspec) (dart.dev)
- [Package dependencies](https://dart.dev/tools/pub/dependencies) (dart.dev)
- [PubGrub solver design doc](https://github.com/dart-lang/pub/blob/master/doc/solver.md) (dart-lang/pub)
- [dart-lang/pub issue 2470: "version solving failed"](https://github.com/dart-lang/pub/issues/2470) (thread canônica do bug)
- [dart-lang/pub issue 3755: SDK version constraint edge cases](https://github.com/dart-lang/pub/issues/3755)
