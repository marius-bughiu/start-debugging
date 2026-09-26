---
title: "Correção: o depurador do Flutter pula para binding.dart no hot reload sem mostrar nenhum erro"
description: "Um bug do dwds no Flutter 3.35 para web enviava uma pausa falsa a cada hot reload. Atualize para o Flutter 3.38+ ou volte o VS Code para 'Debug my code' para que os frames de pacotes sejam ignorados."
pubDate: 2026-09-26
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-web"
  - "hot-reload"
  - "vs-code"
  - "debugging"
lang: "pt-br"
translationOf: "2026/09/fix-flutter-debugger-jumps-into-binding-dart-on-hot-reload"
translatedBy: "claude"
translationDate: 2026-09-26
---

Se você executa um app Flutter web a partir do VS Code ou do Android Studio e todo hot reload abre `package:flutter/src/foundation/binding.dart` (geralmente perto da linha 845) sem nenhuma exceção à vista, você não está fazendo nada de errado. É um bug no dwds, o serviço de depuração web, que veio com o Flutter 3.35: durante um hot reload ele pausava o Chrome para registrar novamente os pontos de interrupção e relatava essa pausa interna à IDE como se fosse real. Ele foi corrigido no dwds 25.1.0+1, que chegou ao stable pela primeira vez no Flutter 3.38.0. Atualize (o stable atual é o 3.47.5). Se você está preso no 3.35.x, volte o modo de depuração do VS Code na barra de status para "Debug my code" (depurar meu código) ou passe `--no-web-experimental-hot-reload`.

Tudo o que está abaixo foi conferido nos códigos-fonte do Flutter 3.35.4, 3.35.7, 3.38.0 e 3.47.5, nos changelogs do dwds 24.4.0+2 e 25.1.0+1 e no schema de configurações do Dart-Code 3.144.

## O erro em contexto

Não há texto de erro, e essa é a parte confusa. Você salva um arquivo (ou aperta o botão de hot reload), o reload termina e então o editor muda para um arquivo que você nunca abriu:

```text
package:flutter/src/foundation/binding.dart   (line 845, highlighted as the current frame)

  @protected
  void postEvent(String eventKind, Map<String, dynamic> eventData) {
    developer.postEvent(eventKind, eventData);   // <- debugger "paused" here
  }
```

O painel CALL STACK diz que o isolate está pausado, mas não em uma exceção nem em um ponto de interrupção. Você aperta Continue, o app continua rodando e tudo se repete no próximo reload. Algumas pessoas veem um arquivo diferente, com uma mensagem em vez do código-fonte:

```text
Could not load source 'package:flutter/src/foundation/binding.dart': Bad state: source reference is no longer valid.
```

Variantes do mesmo relato citam `package:flutter/src/painting/decoration_image.dart` ou `package:provider/src/devtool.dart`. Essa lista acaba sendo a melhor pista do que está acontecendo.

O relato típico é Flutter 3.35.4 ou 3.35.5 no canal stable, Dart 3.9.2, rodando no Chrome, depurado pelo VS Code. O mesmo sintoma foi confirmado no Android Studio. Executar `flutter run -d chrome` em um terminal não mostra o problema, porque nada em um terminal pula para um arquivo de código-fonte.

## Por que o depurador para em binding.dart

O Flutter 3.35 ativou por padrão o hot reload com preservação de estado para a web (a flag `--web-experimental-hot-reload` passou para `defaultsTo: true`). Para manter seus pontos de interrupção funcionando através de um reload, o dwds pausa o isolate JavaScript no Chrome, registra novamente os pontos de interrupção no código novo e retoma a execução. Essa pausa é um detalhe de implementação. O bug era que o dwds 24.4.x sempre emitia um evento `PauseInterrupted` ao pausar, inclusive nessa pausa interna.

A IDE não consegue diferenciar. Como disse o mantenedor do Dart-Code, Danny Tuppeny, em [flutter/flutter#176693](https://github.com/flutter/flutter/issues/176693), o evento `PauseInterrupted` enviado durante o reload "to DAP/VS Code looks like a legitimate pause" (para o DAP/VS Code parece uma pausa legítima). Então o VS Code faz o que faz em qualquer pausa: escolhe o frame do topo da pilha de chamadas e abre aquele arquivo.

Qual arquivo? O código Dart que estava executando quando o Chrome pausou. Em um build de debug, o Flutter publica eventos do VM service o tempo todo: `SchedulerBinding` envia `Flutter.Frame` depois dos frames, as service extensions enviam `Flutter.ServiceExtensionStateChanged`, e tudo isso passa por um único método em `BindingBase`:

```dart
// Flutter 3.35.4, packages/flutter/lib/src/foundation/binding.dart, lines 843-846
@protected
void postEvent(String eventKind, Map<String, dynamic> eventData) {
  developer.postEvent(eventKind, eventData);
}
```

No código-fonte do 3.35.4, `developer.postEvent(eventKind, eventData);` está exatamente na linha 845, e é por isso que tantos relatos mencionam essa linha. Os outros arquivos onde as pessoas caem também chamam `postEvent`: `decoration_image.dart` chama `developer.postEvent('Flutter.ImageSizesForFrame', ...)`, e o `devtool.dart` do `provider` publica seus próprios eventos para a extensão Provider do DevTools. A pausa cai em quem estiver falando com o VM service naquele instante.

A variante "source reference is no longer valid" é a mesma pausa com um timing pior: o reload acabou de trocar os scripts, então a referência de script associada ao frame obsoleto não resolve mais.

### Por que só alguns desenvolvedores viram isso

O VS Code só pula para um frame pausado se ele contar como seu código. O Dart-Code decide isso com duas configurações, ambas `false` por padrão:

- `dart.debugSdkLibraries`: marca as bibliotecas `dart:*` como depuráveis.
- `dart.debugExternalPackageLibraries`: marca pacotes externos do pub como depuráveis, e o schema do Dart-Code deixa explícito que isso inclui `package:flutter`.

São as mesmas configurações que o item da barra de status alterna enquanto uma sessão de depuração está rodando: "Debug my code", "Debug my code + packages", "Debug my code + packages + SDK". Com o padrão "Debug my code", todo frame da pausa falsa pertence a `package:flutter`, nenhum deles conta como código do usuário e o VS Code não tem para onde pular. Se você alguma vez mudou para "+ packages" para entrar em um método do framework, `binding.dart` virou "seu" código e o editor pulava para lá a cada reload. É também por isso que um membro do time do Flutter testou primeiro o 3.35.6, não viu problema nenhum e marcou a issue como corrigida, antes de Danny apontar que a gravação estava usando "Debug my code".

## Reprodução mínima

Você só precisa disso se quiser confirmar que está esbarrando neste bug e não em outra coisa.

```bash
# Flutter 3.35.4 stable, Dart 3.9.2, Chrome, VS Code with Dart-Code
flutter create repro_binding
cd repro_binding
code .
```

```jsonc
// .vscode/settings.json -- Flutter 3.35.x, Dart-Code extension
{
  "dart.debugExternalPackageLibraries": true
}
```

Selecione o Chrome como dispositivo, aperte F5, mude o texto do contador em `lib/main.dart` e salve. No 3.35.x o editor abre `binding.dart` na linha do `developer.postEvent`. Remova a configuração (ou escolha "Debug my code" na barra de status) e o salto para, embora o isolate ainda pause brevemente. No Flutter 3.38.0 ou posterior nenhuma das duas coisas acontece.

## Correção 1: atualize para o Flutter 3.38 ou posterior

Esta é a correção de verdade. A mudança no dwds é [dart-lang/webdev#2695](https://github.com/dart-lang/webdev/pull/2695), "Don't send PauseInterrupted event during a hot reload", mesclada em 2025-10-09. Em vez de enviar um evento de pausa normal, o `ChromeProxyService` agora informa ao depurador que a pausa é interna, e o depurador sinaliza a conclusão por meio de um completer em vez de um evento. Ela saiu no hotfix `25.1.0+1` do dwds, cuja entrada no changelog diz "Fix an issue in `reloadSources` where a `PauseInterrupted` event was sent" e aponta para [dart-lang/sdk#61560](https://github.com/dart-lang/sdk/issues/61560).

O que importa para você é qual versão do dwds o seu SDK do Flutter fixa em `packages/flutter_tools/pubspec.yaml`:

| Flutter | dwds fixado | Pausa falsa no hot reload web |
| --- | --- | --- |
| 3.32.8 | 24.3.10 | Não (hot reload web com estado desativado por padrão) |
| 3.35.4 | 24.4.0+2 | Sim |
| 3.35.7 (último hotfix do 3.35) | 24.4.0+2 | Sim |
| 3.38.0 | 25.1.0+2 | Não |
| 3.47.5 (stable, setembro de 2026) | 27.1.2 | Não |

A correção nunca recebeu cherry-pick para a linha 3.35, então nenhum hotfix do 3.35 vai ajudar. Verifique em qual versão você está e avance:

```bash
# any Flutter version
flutter --version
flutter channel stable
flutter upgrade
```

Se o projeto fixa o SDK via FVM ou um arquivo `.flutter-version`, atualize isso, senão a IDE continua iniciando o SDK antigo mesmo depois de você atualizar o global:

```bash
# FVM 3.x
fvm install 3.47.5
fvm use 3.47.5
```

Depois reinicie a sessão de depuração. Uma sessão em execução mantém seu processo `flutter run` original, e esse processo segura o dwds antigo.

## Correção 2: volte o VS Code para "Debug my code"

Se você ainda não pode atualizar (uma imagem de CI travada, um plugin que não suporta um Dart mais novo), esconda o sintoma. Com uma sessão de depuração rodando, clique no item de modo de depuração à esquerda da barra de status e escolha "Debug my code". Ou defina isso para o workspace:

```jsonc
// .vscode/settings.json -- Flutter 3.35.x workaround, Dart-Code extension
{
  "dart.debugExternalPackageLibraries": false,
  "dart.debugSdkLibraries": false
}
```

Este é o workaround que Danny recomendou na issue. O isolate ainda pausa brevemente durante o reload, mas como todo frame está em `package:flutter` ou `dart:*`, o VS Code trata todos como código externo e não rouba o foco. Quando você realmente precisar entrar em um pacote, mude para "+ packages" naquela sessão e aceite os saltos até voltar.

Isso não ajuda no Android Studio nem no IntelliJ, que não têm um toggle equivalente para este caso. Use a Correção 3 neles.

## Correção 3: desative o hot reload web com estado no 3.35

A opção mais bruta é voltar ao formato de módulo web anterior ao 3.35, que não faz a dança de pausar e registrar novamente:

```bash
# Flutter 3.35.x, terminal
flutter run -d chrome --no-web-experimental-hot-reload
```

No VS Code, coloque isso em `launch.json` para que valha só para este projeto:

```jsonc
// .vscode/launch.json -- Flutter 3.35.x, Dart-Code extension
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "web (no stateful reload)",
      "type": "dart",
      "request": "launch",
      "program": "lib/main.dart",
      "deviceId": "chrome",
      "toolArgs": ["--no-web-experimental-hot-reload"]
    }
  ]
}
```

A configuração de usuário `dart.flutterRunAdditionalArgs` também funciona, mas vale para todos os projetos da máquina, e é assim que as pessoas acabam esquecendo que ela está lá um ano depois. No Android Studio, abra Run > Edit Configurations, selecione a configuração do Flutter e coloque `--no-web-experimental-hot-reload` em "Additional run args".

O custo é real: sem o novo formato de módulo, o alvo web volta ao comportamento antigo, em que um reload reinicia o app e você perde o estado a cada salvamento. Trate isso como uma ponte até poder atualizar e remova depois. No Flutter 3.47.5 o texto de ajuda da flag já diz "(deprecated; will be removed in a future release)", então uma entrada `toolArgs` esquecida vai acabar quebrando sua configuração de execução.

## Pegadinhas e casos parecidos

**Você está no 3.38 ou posterior e ainda acontece.** Olhe o cabeçalho do painel CALL STACK antes de qualquer coisa. Se ele diz "Paused on exception", não é o bug do dwds, é uma exceção real, e o painel Breakpoints vai mostrar "Uncaught Exceptions" ou "All Exceptions" marcado. Com "All Exceptions", o depurador também para em exceções que o código do framework ou de pacotes lança e captura por conta própria. Desmarque, faça o reload e veja se a pausa some. Se ele diz "Paused on breakpoint", abra o painel Breakpoints: o VS Code persiste pontos de interrupção por workspace, incluindo os que você colocou dentro de `binding.dart` enquanto percorria o framework meses atrás. Remova-o.

**Acontece no Android, iOS ou desktop.** A pausa falsa era exclusiva da web, porque vivia no dwds, que só roda para alvos web. O VM service nativo não pausa o isolate para registrar novamente os pontos de interrupção no reload. Em um alvo móvel ou desktop, uma parada em `binding.dart` é uma exceção ou um ponto de interrupção perdido, então use as verificações acima.

**O hot reload derruba a sessão de depuração em vez de pausar.** O Flutter 3.35.2 tinha um bug web separado em que o hot reload lançava um erro a partir de `dwds/src/injected/client.js` e quebrava a sessão ([flutter/flutter#174932](https://github.com/flutter/flutter/issues/174932)). Bug diferente, mesma cura: atualizar.

**A página mostra código antigo depois de um reload.** Se o reload "funciona" mas o navegador executa um build obsoleto, você está diante de cache, não do depurador. Veja [por que o Flutter web serve um build em cache obsoleto após o reload](/pt-br/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/).

**O hot reload trava com um ponto de interrupção definido.** Se você tem um ponto de interrupção dentro de um override de `State.reassemble` (ou em código chamado por ele), a chamada de serviço `ext.flutter.reassemble` para ali a cada reload, e a ferramenta pode estourar o tempo limite esperando por ela ([flutter/flutter#23285](https://github.com/flutter/flutter/issues/23285)). Isso é um ponto de interrupção real fazendo seu trabalho, não o bug do dwds: continue a partir dele ou mova-o.

## Relacionados

- Se você está fazendo profiling em vez de depuração, [como fazer profiling de jank em um app Flutter com o DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) cobre a visão Performance que consome esses eventos `Flutter.Frame`.
- [Por que `appFlavor` fica nulo após um hot restart com `flutter attach`](/pt-br/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/) é outro caso em que o caminho do reload se comporta de forma diferente de uma inicialização normal.
- O [servidor MCP do Dart e do Flutter](/pt-br/2026/05/dart-flutter-mcp-server-claude-code-cursor/) conversa com o mesmo VM service e o mesmo DTD que o dwds expõe na web.
- Escolhendo um renderizador web ao mesmo tempo em que atualiza? [CanvasKit vs skwasm para Flutter web em 2026](/pt-br/2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026/) percorre os trade-offs.

## Fontes

- [dart-lang/sdk#61560: Hot Reload opens `binding.dart` at line 845 on every reload (no errors shown)](https://github.com/dart-lang/sdk/issues/61560)
- [flutter/flutter#176693: [Web] Hot Reload jumping on binding.dart file even if "uncaught exceptions" are turned off](https://github.com/flutter/flutter/issues/176693)
- [flutter/flutter#174951: Error when hot reload since latest versions](https://github.com/flutter/flutter/issues/174951)
- [dart-lang/webdev#2695: Don't send PauseInterrupted event during a hot reload](https://github.com/dart-lang/webdev/pull/2695)
- [Changelog do dwds no pub.dev](https://pub.dev/packages/dwds/changelog)
- [Documentação da API BindingBase.reassembleApplication](https://api.flutter.dev/flutter/foundation/BindingBase/reassembleApplication.html)
- [Documentação do Flutter: Hot reload](https://docs.flutter.dev/tools/hot-reload)
- [Novidades do Flutter 3.38](https://blog.flutter.dev/whats-new-in-flutter-3-38-3f7b258f7228)
