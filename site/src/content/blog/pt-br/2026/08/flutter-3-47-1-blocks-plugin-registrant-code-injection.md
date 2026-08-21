---
title: "Flutter 3.47.1 impede que um pacote transitivo injete código nativo no seu app"
description: "O hotfix 3.47.1 valida os identificadores de classe e pacote dos plugins antes que eles cheguem ao GeneratedPluginRegistrant. Veja a brecha que ele fecha, a expressão regular que faz isso e as outras 11 correções da versão."
pubDate: 2026-08-21
tags:
  - "flutter"
  - "dart"
  - "security"
  - "flutter-tools"
lang: "pt-br"
translationOf: "2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection"
translatedBy: "claude"
translationDate: 2026-08-21
---

O Flutter 3.47.1 chegou ao canal stable em 2026-08-19 trazendo o Dart 3.13.1, exatamente uma semana depois de [3.47.0 tornar o Impeller o renderizador padrão no desktop](/pt-br/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/). Doze issues é um hotfix grande para os padrões do Flutter, e uma delas não é uma correção de crash. É uma brecha de cadeia de suprimentos em tempo de build dentro do `flutter_tools`.

## Identificadores de plugin iam para o código nativo gerado sem escape

Quando você roda `flutter pub get` ou `flutter build`, a ferramenta percorre o seu grafo de dependências transitivas e escreve um `GeneratedPluginRegistrant` para cada plataforma. Os valores `pluginClass` e o `package` do Android vindos do `pubspec.yaml` de cada plugin são interpolados literalmente nesse arquivo, dentro de templates como `new {{package}}.{{class}}()` para Java, `{{prefix}}{{class}}.register(...)` para Swift e `#import <{{name}}/{{class}}.h>` para Objective-C. O renderizador de templates roda com `htmlEscapeValues` em `false`, então nada é escapado no caminho.

A validação só checava se esses campos eram strings. Confirmei isso contra um SDK 3.44.2 local, onde `AndroidPlugin.validate` ainda é apenas um teste de tipo:

```dart
static bool validate(YamlMap yaml) {
  return (yaml['package'] is String && yaml[kPluginClass] is String) ||
      yaml[kDartPluginClass] is String ||
      yaml[kFfiPlugin] == true ||
      yaml[kDefaultPackage] is String;
}
```

Uma string com ponto e vírgula, chaves e quebras de linha passa nessa checagem. Ou seja, uma dependência que declare isto compila código nativo arbitrário em qualquer app que dependa dela:

```yaml
flutter:
  plugin:
    platforms:
      macos:
        pluginClass: "SomePlugin(); evilInjectedCall(); if (false) { SomePlugin"
```

O que torna isso urgente de corrigir é o alcance. Os plugins são coletados via `computeTransitiveDependencies`, sem nenhuma adesão explícita do app consumidor. Um pacote três níveis abaixo na sua árvore de dependências pode acionar isso, e a carga roda em tempo de build numa máquina de desenvolvimento ou num runner de CI, não em tempo de execução do app, onde uma revisão poderia pegá-la.

## O que a 3.47.1 passa a exigir

O [PR 191294](https://github.com/flutter/flutter/pull/191294) adiciona um padrão de identificador e o aplica a todo campo de identificador presente, não apenas àqueles que tornavam a declaração válida:

```dart
final RegExp _pluginIdentifierPattern = RegExp(
  r'^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$',
);
```

Caminhos de código Dart têm uma regra separada, já que `fileName` e `dartFileName` são interpolados dentro de um `import`: `RegExp(r'^\w[\w./-]*\.dart$')`, mais uma rejeição explícita de qualquer valor que contenha `..`.

Os modos de falha variam por plataforma. Um identificador ruim de Android, iOS, macOS, Linux ou Windows faz `validate` retornar false, e você recebe `Invalid plugin specification <name>`. Plugins web falham com uma saída de ferramenta mais específica: `The plugin <name> has an invalid pluginClass in its web plugin declaration.` Se você mantém um plugin e o seu build passa a falhar na 3.47.1, verifique se a classe declarada é um identificador pontuado simples.

## Os outros onze

O resto do hotfix é em boa parte incômodo de tooling, e dois já justificam a atualização sozinhos: o hot restart foi corrigido para builds web WASM ([flutter/186445](https://github.com/flutter/flutter/issues/186445)), e o hot reload não ignora mais edições em pacotes membros de um pub workspace que ficam sob o `lib/` do pacote raiz ([flutter/190284](https://github.com/flutter/flutter/issues/190284)). Também entram: uma condição de corrida do SwiftPM que lançava `FileSystemException` em builds multi-target paralelos de iOS e macOS, um crash do `impellerc` no Windows com caminhos contendo caracteres Unicode, um deadlock no adaptador de depuração quando o processo alvo termina antes de o VM service conectar, e a adesão em nível de projeto ao Flutter GPU em builds release no Linux e no Windows.

```bash
flutter channel stable
flutter upgrade
```

A lista completa está no [changelog de hotfixes do Flutter](https://github.com/flutter/flutter/blob/main/CHANGELOG.md).
