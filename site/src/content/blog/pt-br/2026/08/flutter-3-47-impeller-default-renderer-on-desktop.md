---
title: "Flutter 3.47 torna o Impeller o renderizador padrão no Windows, Linux e macOS"
description: "O Flutter 3.47.0 estável muda os aplicativos de desktop de Skia para Impeller sem tocar em uma linha do código do seu runner. Veja o que muda, como desativar em cada plataforma e por que essa saída é temporária."
pubDate: 2026-08-16
tags:
  - "flutter"
  - "dart"
  - "impeller"
  - "windows"
lang: "pt-br"
translationOf: "2026/08/flutter-3-47-impeller-default-renderer-on-desktop"
translatedBy: "claude"
translationDate: 2026-08-16
---

O Flutter 3.47.0 chegou ao canal estável em 2026-08-12, trazendo o Dart 3.13.0. A maior parte da atenção está indo para os pacotes independentes `material_ui` e `cupertino_ui` na versão 1.0, que dão continuidade à separação iniciada no [Flutter 3.44](/pt-br/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/). A mudança que realmente altera como seu aplicativo desenha é mais discreta: o Impeller agora é o renderizador padrão no Windows, no Linux e no macOS.

## Nada muda no seu projeto, e esse é justamente o problema

O runner de desktop é código gerado que fica no seu repositório, então é tentador supor que uma troca de renderizador apareceria como um diff de template que você pode revisar. Não aparece. No Flutter 3.44, o ponto de entrada do Windows é este, e não há nenhuma seleção de renderizador nele:

```cpp
flutter::DartProject project(L"data");

std::vector<std::string> command_line_arguments = GetCommandLineArguments();
project.set_dart_entrypoint_arguments(std::move(command_line_arguments));
```

`ImpellerSwitch` não existe em lugar nenhum do SDK 3.44. Atualizar para o 3.47 deixa o `windows\runner\main.cpp` idêntico byte a byte e muda o padrão por baixo dele. Se uma build de Windows ou Linux começar a apresentar regressões visuais depois da atualização, a primeira coisa a verificar é o renderizador, não a sua árvore de widgets.

## Como desativar, por plataforma

Para depuração local, uma única flag cobre as três plataformas de desktop:

```bash
flutter run --no-enable-impeller
```

Para uma build implantada você precisa editar o runner. No Windows, em `windows\runner\main.cpp`:

```cpp
flutter::DartProject project(L"data");
project.set_impeller_switch(flutter::ImpellerSwitch::Disabled);
```

No Linux, em `linux/runner/my_application.cc`:

```c
g_autoptr(FlDartProject) project = fl_dart_project_new();
fl_dart_project_set_enable_impeller(project, FALSE);
```

No macOS, no `<dict>` de nível superior do `Info.plist`:

```xml
<key>FLTEnableImpeller</key>
<false />
```

Trate as três opções como paliativo. A [documentação do Impeller](https://docs.flutter.dev/perf/impeller) afirma que a possibilidade de desativar será removida em uma versão futura, a mesma sequência que iOS e Android já percorreram. Use a chave para destravar uma release e depois registre o bug de renderização.

## O que a troca traz de ganho

O Impeller mira Metal no macOS e Vulkan no Windows e no Linux, em vez de passar pelo caminho OpenGL do Skia. O ganho concreto está no tratamento de shaders: o Impeller os compila antecipadamente, durante a build, em vez de no primeiro uso, e é isso que elimina o travamento da primeira execução do qual usuários de desktop e mobile reclamam há anos. O Flutter 3.47 também habilita a renderização por campo de distância com sinal para texto e curvas vetoriais no macOS, Linux e Windows, deixando as bordas dos glifos e as curvas mais nítidas, e a cor de gama ampla vem ligada por padrão no macOS.

## O restante do 3.47 que vale ler antes de atualizar

- Os alvos mínimos de implantação sobem para iOS 15 e macOS 12 por compatibilidade com o Xcode 27.
- Widget Previews chega ao estável.
- Win32 e Linux ganham suporte a janelas pop-up, e a API de janelas renomeia `preferredSize` para `size` e `preferredConstraints` para `constraints`.
- Projetos Android novos usam templates com AGP 9 ou posterior e suporte embutido a Kotlin.

A lista completa está nas [notas de versão do Flutter 3.47.0](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0) e no [post de anúncio](https://flutter.dev/blog/whats-new-in-flutter-3-47). Se você publica um aplicativo Flutter de desktop, rode sua suíte de regressão visual antes de fazer o merge da atualização do SDK.
