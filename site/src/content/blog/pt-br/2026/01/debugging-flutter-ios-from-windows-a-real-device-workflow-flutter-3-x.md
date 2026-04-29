---
title: "Depurando Flutter iOS no Windows: um fluxo com dispositivo real (Flutter 3.x)"
description: "Um fluxo pragmático para depurar apps Flutter iOS no Windows: delegue o build para macOS no GitHub Actions, instale o IPA num iPhone real e use flutter attach para hot reload e DevTools."
pubDate: 2026-01-23
tags:
  - "flutter"
lang: "pt-br"
translationOf: "2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x"
translatedBy: "claude"
translationDate: 2026-04-29
---
A cada poucas semanas a mesma dor reaparece: "Estou no Windows. Quero depurar meu app Flutter iOS num iPhone real. Preciso mesmo de um Mac?". Um post recente no r/FlutterDev propõe uma saída pragmática: delegar o build de iOS para macOS no GitHub Actions e depois instalar e atachar para depurar do Windows: [https://www.reddit.com/r/FlutterDev/comments/1qkm5pd/develop_flutter_ios_apps_on_windows_with_a_real/](https://www.reddit.com/r/FlutterDev/comments/1qkm5pd/develop_flutter_ios_apps_on_windows_with_a_real/)

O projeto open source por trás disso é [https://github.com/MobAI-App/ios-builder](https://github.com/MobAI-App/ios-builder).

## Divida o problema: build no macOS, depuração no Windows

iOS tem duas restrições duras:

-   As ferramentas do Xcode rodam em macOS.
-   Instalação em dispositivo real e assinatura têm regras que você não consegue contornar a partir do Windows.

Mas a depuração no Flutter é, na maior parte, "atachar num app em execução e conversar com o VM service". Isso significa que você pode desacoplar o build/install do ciclo de desenvolvimento, desde que consiga colocar no aparelho um app capaz de ser depurado.

O fluxo descrito no post é:

-   Disparar um job de CI em macOS que produza um `.ipa`.
-   Baixar o artefato no Windows.
-   Instalar num iPhone conectado fisicamente (via app de ponte).
-   Rodar `flutter attach` do Windows para ter hot reload e DevTools.

## Um build mínimo no GitHub Actions que produz um IPA

Isso não é a história completa (assinatura é uma toca de coelho à parte), mas mostra a ideia central: um runner de macOS compila e sobe um artefato.

```yaml
name: ios-ipa
on:
  workflow_dispatch:
jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: subosito/flutter-action@v2
        with:
          channel: stable
      - run: flutter pub get
      - run: flutter build ipa --debug --no-codesign
      - uses: actions/upload-artifact@v4
        with:
          name: ios-ipa
          path: build/ios/ipa/*.ipa
```

Se `--no-codesign` é aceitável depende de como você planeja instalar. Muitos caminhos para dispositivo real ainda exigem assinatura em alguma etapa, mesmo em fluxos de debug.

## O ciclo no lado Windows: instale e depois atache

Quando o app já está instalado e rodando no iPhone, a parte do Flutter vira o de sempre:

```bash
# From Windows
flutter devices
flutter attach -d <device-id>
```

O hot reload funciona porque você está se atachando a uma sessão de depuração, não porque você compilou na mesma máquina.

## Conheça os tradeoffs desde o começo

Esse fluxo é útil, mas não é mágica:

-   **A assinatura continua real**: você vai mexer com certificados, profiles ou um caminho de instalador de terceiros.
-   **Você ainda precisa de um aparelho**: simuladores não rodam no Windows.
-   **Seu job de CI vira parte do seu loop de desenvolvimento**: otimize os tempos de build e faça cache das dependências.

Se quiser o texto original e o repo que disparou essa discussão, comece aqui: [https://github.com/MobAI-App/ios-builder](https://github.com/MobAI-App/ios-builder). Para a orientação oficial do Flutter sobre depuração em iOS, mantenha a documentação da plataforma por perto: [https://docs.flutter.dev/platform-integration/ios/ios-debugging](https://docs.flutter.dev/platform-integration/ios/ios-debugging).
