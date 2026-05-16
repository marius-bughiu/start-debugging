---
title: "Flutter 3.44 separa Material e Cupertino do SDK e adota SwiftPM por padrão"
description: "Flutter 3.44 estável congela Material e Cupertino dentro do SDK e direciona o trabalho novo para os pacotes material_ui e cupertino_ui no pub.dev. SwiftPM também se torna o padrão para iOS e macOS, aposentando enfim o CocoaPods."
pubDate: 2026-05-16
tags:
  - "flutter"
  - "dart"
  - "swiftpm"
  - "material-design"
lang: "pt-br"
translationOf: "2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default"
translatedBy: "claude"
translationDate: 2026-05-16
---

Flutter 3.44 chegou ao canal estável esta semana, e a manchete é estrutural mais do que visual. As bibliotecas Material e Cupertino não estão mais presas ao trem de releases do SDK. Daqui pra frente, o lar canônico de `package:flutter/material.dart` e `package:flutter/cupertino.dart` são dois novos pacotes no pub.dev, `material_ui` e `cupertino_ui`, e as cópias dentro do SDK entram em uma janela longa de depreciação. Ao mesmo tempo, `flutter config --enable-swift-package-manager` é o novo padrão para builds iOS e macOS, o que finalmente deixa você tirar Ruby e CocoaPods de uma instalação nova do Flutter.

## Por que as bibliotecas de UI estão saindo do SDK

Material e Cupertino sempre foram entregues na cadência trimestral do próprio Flutter. Isso significava que cada ajuste de token do Material 3, cada correção de teclado do Cupertino e cada novo argumento de `MenuAnchor` esperava o próximo corte trimestral. Com a mudança para pacotes independentes, esses times são donos do próprio ritmo de releases. Fixe `material_ui: ^1.0.0` no `pubspec.yaml` e você recebe atualizações do Material assim que elas chegam ao pub.dev, desacopladas da versão do Dart SDK em que seu CI está.

A migração foi feita pra ter baixo atrito de propósito. No 3.44 os imports atuais ainda funcionam, mas você verá um aviso de depreciação em `package:flutter/material.dart`. A troca recomendada é mecânica:

```dart
// Before (still works in 3.44, deprecated)
import 'package:flutter/material.dart';

// After (new home on pub.dev)
import 'package:material_ui/material_ui.dart';
```

Adicione o pacote do jeito habitual:

```yaml
dependencies:
  flutter:
    sdk: flutter
  material_ui: ^1.0.0
  cupertino_ui: ^1.0.0
```

O benefício de segunda ordem é o tamanho do binário. Apps que só usam Cupertino podem parar de arrastar theming, tipografia e o conjunto de ícones do Material para dentro do bundle tree-shaken assim que as cópias do SDK forem removidas em um release futuro. As próprias [notas da versão 3.44.0](https://docs.flutter.dev/release/release-notes/release-notes-3.44.0) chamam isso de "code freeze" das bibliotecas embutidas: só correções de bugs, nenhuma API nova.

## SwiftPM agora é o padrão no iOS e macOS

A outra grande mudança é `flutter config --enable-swift-package-manager` ligado por padrão para projetos novos. `flutter create` não gera mais um `Podfile`. Plugins resolvidos via pub continuam recebendo um shim de `Package.swift`, e o Xcode abre o projeto como um grafo de pacotes Swift diretamente. Para apps existentes, o caminho de upgrade é curto:

```sh
flutter upgrade
flutter config --enable-swift-package-manager
cd ios && rm -rf Pods Podfile.lock
flutter run -d ios
```

CocoaPods não foi removido; ele fica como fallback quando você opta por sair, ou quando um plugin não publicou um `Package.swift`. Os avisos de depreciação agora sinalizam plugins que ainda enviam só Pods.

## O que mais entrou no 3.44

O release também introduz `Form.clearError()` para resetar o estado de validação sem reconstruir o formulário, `RoundedSuperellipseInputBorder` para campos de entrada no estilo iOS, janelas de tooltip no Win32, macOS e Linux, e suporte a predictive back em `FlutterFragment` e `FlutterFragmentActivity` no Android. Tem bastante coisa pra investigar, mas o split de pacotes é a mudança que vai remodelar primeiro os arquivos `pubspec.yaml` do ecossistema.

Se você mantém um pacote Flutter que reexporta widgets do Material ou Cupertino, agora é a hora de adicionar `material_ui` às suas dev dependencies e começar a publicar imports duplos. Os avisos de depreciação vão ficar barulhentos rápido.
