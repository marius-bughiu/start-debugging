---
title: "Migre um app desktop Flutter para Windows ou Linux para o Impeller (Flutter 3.47)"
description: "O Flutter 3.47 torna o Impeller o renderizador padrão no Windows e no Linux. O que realmente muda por baixo (ainda é OpenGL ES, não Vulkan), como fazer um teste A/B contra o Skia em um binário compilado, um kill switch por máquina para builds de release e por que seus testes golden não vão perceber."
pubDate: 2026-10-08
updatedDate: 2026-10-08
template: migration
tags:
  - "migration"
  - "flutter"
  - "impeller"
  - "windows"
  - "linux"
lang: "pt-br"
translationOf: "2026/10/migrate-a-flutter-windows-or-linux-desktop-app-to-impeller"
translatedBy: "claude"
translationDate: 2026-10-08
---

O Flutter 3.47.0 (estável desde 2026-08-12, Dart 3.13) troca o Skia pelo Impeller nos apps desktop Windows e Linux sem mudar uma linha do código do seu runner. Para a maioria dos apps, a migração leva uma tarde: atualizar, confirmar que o log do engine diz `Using the Impeller rendering backend (OpenGLESSDF)`, comparar capturas de tela e tempos de frame com uma execução `--no-enable-impeller` e só então decidir se vai publicar com o Impeller ou fixar o Skia temporariamente em `windows/runner/main.cpp` ou `linux/runner/my_application.cc`. O que quebra é, em sua maior parte, visual: a rasterização de texto (o Impeller força texto com campo de distância assinada no desktop, além de uma nova correção de gama), o anti-aliasing em GPUs sem MSAA implícito e um ou outro shader customizado. Tudo abaixo foi conferido no código-fonte do engine do Flutter 3.47.0 e do `flutter_tools`.

## O que realmente muda por baixo do seu app

O primeiro ponto a saber é o que **não** muda: a API gráfica. O embedder do Windows continua renderizando via OpenGL ES com ANGLE, que traduz para Direct3D 11. O `flutter_windows_engine.cc` no 3.47.0 cria um `egl::Manager` e um `CompositorOpenGL` independentemente do renderizador, e o embedder do Linux só conhece dois tipos de renderizador, `opengl` e `software`. Não existe caminho Vulkan em nenhum dos embedders desktop. O Impeller no desktop é o backend GLES do Impeller rodando sobre o mesmo contexto GL que o Skia usava antes. No macOS, é o backend Metal do Impeller.

O que muda é tudo que fica acima das chamadas GL:

- **Os shaders são pré-compilados.** O Impeller entrega um conjunto fixo de shaders já compilados, em vez de gerar e compilar shaders no primeiro uso, que é de onde vinha o jank da primeira execução do Skia.
- **O texto é desenhado com SDFs.** No Windows, o embedder acrescenta `--impeller-use-sdfs=true` sempre que o Impeller está ativo, a menos que você passe a flag por conta própria. No Linux, ele acrescenta `--impeller-use-sdfs` incondicionalmente. As notas de versão do 3.47 também adicionam correção de gama dos glifos nas duas plataformas ([#187122](https://github.com/flutter/flutter/pull/187122), [#187871](https://github.com/flutter/flutter/pull/187871)).
- **O padrão está no código do engine, não no seu projeto.** `ImpellerSwitch::Default` significa "o que o engine decidir", e no 3.47 isso é `true` no Windows ([#188140](https://github.com/flutter/flutter/pull/188140)) e `TRUE` em `fl_dart_project_init` no Linux ([#187573](https://github.com/flutter/flutter/pull/187573)). O seu runner gerado é byte a byte idêntico ao do 3.44.

Esse último ponto é o motivo de isto exigir uma passada de migração deliberada. Nada no seu diff avisa os revisores de que o renderizador mudou.

## O que quebra

| Área | Mudança no 3.47 | Gravidade |
| --- | --- | --- |
| Renderização de texto | Glifos SDF com correção de gama; bordas e pesos dos glifos mudam levemente | média |
| Anti-aliasing | GPUs no Windows sem MSAA implícito precisam do caminho de MSAA offscreen ([#190374](https://github.com/flutter/flutter/pull/190374), cherry-pick no 3.47) | média |
| Capturas de tela de integração | Diffs de pixels contra baselines capturadas no Skia | média |
| Fragment shaders customizados | Compilados pelo `impellerc` para o alvo GLES; bugs específicos de driver aparecem de forma diferente | baixa a média |
| Goldens do `flutter test` | Não afetados por padrão (veja as armadilhas) | nenhuma |
| Código do runner | Sem mudança no template; desativar exige uma edição manual | baixa |

## Checklist prévio

- O Flutter 3.44.x ainda instalado em algum lugar (FVM, um segundo checkout ou uma imagem de CI) para que você consiga compilar uma baseline do Skia. Se você já roda [várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), adicione o 3.47 como uma nova etapa em vez de substituir a antiga.
- Uma lista das máquinas que você realmente suporta: no mínimo uma máquina Windows com GPU Intel integrada, uma com GPU dedicada NVIDIA ou AMD e uma máquina Linux com drivers Mesa. VMs e sessões RDP merecem uma linha própria.
- Um punhado de telas que estressam a renderização: texto denso, texto rotacionado ou escalado, custom painters, blurs e sombras, qualquer shader `FragmentProgram`.
- Se você também publica para macOS a partir da mesma base de código, note que o 3.47 eleva o requisito mínimo para o macOS 12. Essa é uma [migração separada](/pt-br/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/) que você vai encontrar na mesma atualização do SDK.

## Passos da migração

1. **Capture uma baseline do Skia no 3.44.** Compile binários profile e tire capturas das suas telas de estresse em cada máquina alvo:

   ```bash
   # Flutter 3.44.x
   flutter build windows --profile
   flutter build linux --profile
   ```

   Registre também os tempos de frame. Um [trace de desempenho no DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) dos primeiros 10 segundos após a inicialização e da sua rolagem mais pesada já basta. Verifique: você tem um trace e um conjunto de capturas de tela por máquina.

2. **Atualize para o 3.47 e recompile.**

   ```bash
   flutter upgrade
   flutter --version   # expect Flutter 3.47.x, Dart 3.13.x
   flutter clean
   flutter build windows --profile
   ```

   Verifique: `git status` não mostra mudanças em `windows/runner/` nem em `linux/runner/`. Se mostrar, alguém executou `flutter create .` e você deve revisar esse diff separadamente.

3. **Confirme qual backend o engine escolheu.** Execute o app com `flutter run -d windows` (ou `-d linux`) e procure a linha de inicialização do engine:

   ```text
   [IMPORTANT:flutter/shell/platform/embedder/embedder_surface_gl_impeller.cc(126)] Using the Impeller rendering backend (OpenGLESSDF).
   ```

   `OpenGLESSDF` significa Impeller com texto SDF, que é o resultado esperado nas duas plataformas. Se em vez disso você vir `Could not create Impeller context.`, o contexto GL não conseguiu atender ao Impeller e você tem um problema de driver para investigar antes de qualquer outra coisa. Note que não há fallback silencioso para o Skia na superfície do embedder: a superfície do Impeller simplesmente fica inválida. Verifique: a linha aparece exatamente uma vez por janela.

4. **Faça um A/B do mesmo binário contra o Skia.** Para `flutter run`, a flag funciona em todas as plataformas desktop:

   ```bash
   flutter run -d windows --profile --no-enable-impeller
   ```

   Para um binário debug ou profile já compilado, você pode alternar o renderizador com as variáveis de ambiente de switches do engine, que os dois embedders desktop leem por meio de `GetSwitchesFromEnvironment()`:

   ```powershell
   # Flutter 3.47, Windows, debug or profile build only
   $env:FLUTTER_ENGINE_SWITCHES = "1"
   $env:FLUTTER_ENGINE_SWITCH_1 = "enable-impeller=false"
   .\build\windows\x64\runner\Profile\my_app.exe
   ```

   ```bash
   # Flutter 3.47, Linux, debug or profile build only
   FLUTTER_ENGINE_SWITCHES=1 FLUTTER_ENGINE_SWITCH_1=enable-impeller=false \
     ./build/linux/x64/profile/bundle/my_app
   ```

   Essa é a forma mais rápida de entregar a um testador um build e dois atalhos. Verifique: a linha de log de inicialização desaparece quando o switch está definido e volta quando não está.

5. **Compare capturas de tela e traces.** Coloque lado a lado as capturas do Skia no 3.44, as do Skia no 3.47 e as do Impeller no 3.47. A comparação útil é Skia 3.47 contra Impeller 3.47, porque ela isola o renderizador de todas as outras mudanças da versão. Espere que o texto pareça um pouco diferente em todo lugar. Procure o que está errado, não o que está apenas diferente: glifos cortados, sombras ausentes, bordas serrilhadas em retângulos arredondados, regiões pretas. Verifique: cada diferença foi aceita ou tem um repro mínimo.

6. **Decida e, se necessário, fixe o Skia no runner.** Se você encontrou uma regressão real, desative o Impeller no build implantado. No Windows, em `windows/runner/main.cpp`:

   ```cpp
   // Flutter 3.47, windows/runner/main.cpp
   flutter::DartProject project(L"data");
   project.set_impeller_switch(flutter::ImpellerSwitch::Disabled);
   ```

   No Linux, em `linux/runner/my_application.cc`, antes de `fl_view_new(project)`:

   ```c
   // Flutter 3.47, linux/runner/my_application.cc
   g_autoptr(FlDartProject) project = fl_dart_project_new();
   fl_dart_project_set_enable_impeller(project, FALSE);
   ```

   Verifique: recompile, execute e confirme que a linha `Using the Impeller rendering backend` sumiu.

7. **Abra o bug no mesmo dia.** A [documentação do Impeller](https://docs.flutter.dev/perf/impeller) diz que a opção de desativar será removida em uma versão futura, como aconteceu no iOS. Abra uma issue com o prefixo `[Impeller]` no título, um repro mínimo, a GPU e a versão do driver, capturas de tela e um trace de desempenho compactado. Verifique: o link da issue está em um comentário ao lado da linha que desativa o Impeller, para que quem a remover depois saiba por que ela está ali.

## Um kill switch por máquina para builds de release

O truque do `FLUTTER_ENGINE_SWITCHES` do passo 4 não funciona em builds de release. O `engine_switches.cc` envolve toda a busca em `#ifndef FLUTTER_RELEASE`, então um app publicado a ignora. Se você quer publicar com o Impeller mas manter uma saída de emergência para o cliente cujo notebook de 2017 desenha uma janela preta, leia sua própria variável de ambiente no runner:

```cpp
// Flutter 3.47, windows/runner/main.cpp
#include <cwchar>

flutter::DartProject project(L"data");

wchar_t value[8];
DWORD length = ::GetEnvironmentVariableW(L"MYAPP_DISABLE_IMPELLER", value, 8);
if (length > 0 && length < 8 && std::wcscmp(value, L"1") == 0) {
  project.set_impeller_switch(flutter::ImpellerSwitch::Disabled);
}
```

```c
// Flutter 3.47, linux/runner/my_application.cc
g_autoptr(FlDartProject) project = fl_dart_project_new();
if (g_strcmp0(g_getenv("MYAPP_DISABLE_IMPELLER"), "1") == 0) {
  fl_dart_project_set_enable_impeller(project, FALSE);
}
```

O suporte pode então pedir ao usuário afetado que defina uma variável, em vez de esperar por um novo build. Um valor no registro ou uma linha em um arquivo de configuração ao lado do executável funciona da mesma forma, se variáveis de ambiente forem inconvenientes para seus usuários. Trate isso como um andaime temporário, com o mesmo tempo de vida da opção de desativar do engine.

## Verificação

Depois da migração, em cada máquina da sua matriz:

- O app inicia e o log mostra `OpenGLESSDF` (ou nenhuma linha do Impeller, se você fixou o Skia).
- Seus testes de integração passam. Os baseados em captura de tela precisam de novas baselines; regenere-as no 3.47 de propósito, em vez de deixar uma execução em massa de "update goldens" esconder uma regressão real.
- A primeira inicialização após uma instalação limpa não tem jank de compilação de shaders na timeline. Essa é a melhoria pela qual você está pagando, então meça.
- Os tempos de frame em regime estável na sua tela mais pesada estão dentro do seu orçamento. O Impeller não é uniformemente mais rápido em todo frame; ele é mais previsível.
- Redimensionar a janela rapidamente não causa crash no Linux (um crash de redimensionamento foi corrigido durante o ciclo do 3.47 em [#187626](https://github.com/flutter/flutter/pull/187626), o que é um bom motivo para não fazer cherry-pick de uma beta mais antiga).

## Plano de rollback

O rollback é barato e reversível nos dois sentidos. Você pode voltar para o 3.44.x, que nunca habilitou o Impeller por padrão no Windows ou no Linux, ou ficar no 3.47 e adicionar ao runner a opção de desativar do passo 6. A segunda opção é melhor: você mantém todas as outras correções do 3.47 e pode voltar atrás apagando uma linha. Apenas não conte com essa opção existindo para sempre.

## Armadilhas

**As variáveis de ambiente vencem o switch do projeto no Windows.** No construtor de `FlutterWindowsEngine`, o `ImpellerSwitch` do projeto é lido primeiro e depois o laço sobre os switches de ambiente o sobrescreve. Um desenvolvedor com `FLUTTER_ENGINE_SWITCH_1=enable-impeller=true` esquecido no perfil do shell verá o Impeller mesmo em um branch que fixou `Disabled`. Confira o `env` antes de depurar qualquer outra coisa.

**`ImpellerSwitch::Default` não é `Enabled`.** Se você quer o Impeller travado como ligado, não importa o que uma versão futura decida, defina `ImpellerSwitch::Enabled` explicitamente. O `Default` acompanha o engine, que é exatamente o que mudou debaixo de você no 3.47.

**Os goldens do `flutter test` não enxergam o Impeller.** O `flutter_tester_device.dart` inicia o shell de teste com `--enable-software-rendering --skia-deterministic-rendering`, a menos que você passe `--enable-impeller`. Os goldens dos seus widget tests continuam passando depois da atualização, o que não diz nada sobre o renderizador desktop. Somente testes de integração que executam o `.exe` real ou o bundle Linux exercitam o Impeller.

**A opção de desativar no Linux precisa acontecer antes de a view existir.** `fl_dart_project_set_enable_impeller` define um campo que o `FlEngine` lê quando inicia. Chame-a logo depois de `fl_dart_project_new()` e antes de `fl_view_new(project)`, não mais tarde em `my_application_activate`.

**Notebooks com GPU híbrida escolhem uma GPU antes de o renderizador importar.** No Windows, `DartProject::set_gpu_preference` com `flutter::GpuPreference::HighPerformancePreference` ou `LowPowerPreference` decide qual adaptador o ANGLE usa. Se uma regressão só se reproduz em um notebook com GPU Intel e NVIDIA, teste as duas preferências antes de culpar o Impeller.

**VMs e sessões remotas.** Máquinas sem suporte a MSAA implícito caíam em tela preta no Windows no início do ciclo do 3.47; o [#187288](https://github.com/flutter/flutter/pull/187288) e o fallback de MSAA offscreen no [#190374](https://github.com/flutter/flutter/pull/190374) trataram disso. Se você vir uma janela preta em uma VM, confirme que está no patch mais recente do 3.47 antes de abrir uma nova issue.

**Shaders customizados.** Os shaders `FragmentProgram` continuam funcionando, mas agora são executados pelo backend GLES do Impeller, em qualquer driver que o ANGLE ou o Mesa exponham. Teste novamente cada arquivo `.frag` na sua GPU suportada mais antiga e evite depender de comportamentos de precisão que por acaso funcionavam no Skia.

**A opção de desativar tem prazo.** Cada opt-out que você adiciona é uma dívida com um prazo que você não controla. Coloque o link da issue ao lado dele e reavalie a cada atualização do Flutter.

## Veja também

- O resumo do dia do lançamento desta mudança: [Flutter 3.47 makes Impeller the default renderer on Windows, Linux, and macOS](/pt-br/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/).
- Medindo o antes e o depois: [como fazer o profiling de jank em um app Flutter com o DevTools](/pt-br/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).
- Rodando o 3.44 e o 3.47 lado a lado: [como mirar várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).
- A outra migração desktop da mesma versão: [elevar o deployment target de um app Flutter macOS para o macOS 12](/pt-br/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/).
- A decisão equivalente de renderizador na web: [CanvasKit vs skwasm para Flutter web em 2026](/pt-br/2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026/).

## Fontes

- [Impeller rendering engine](https://docs.flutter.dev/perf/impeller) em docs.flutter.dev (status no desktop, trechos para desativar, checklist para reportar bugs).
- [Notas de versão do Flutter 3.47.0](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0).
- [flutter/flutter#188140](https://github.com/flutter/flutter/pull/188140): torna o Impeller o renderizador padrão no Windows.
- [flutter/flutter#187573](https://github.com/flutter/flutter/pull/187573): ativa o Impeller por padrão no Linux.
- [flutter/flutter#188044](https://github.com/flutter/flutter/pull/188044): adiciona o switch de projeto do Windows.
- [flutter/flutter#187288](https://github.com/flutter/flutter/pull/187288): corrige a tela preta no caminho OpenGL do Windows.
- Código-fonte do Flutter 3.47.0: `engine/src/flutter/shell/platform/windows/flutter_windows_engine.cc`, `engine/src/flutter/shell/platform/linux/fl_engine.cc`, `engine/src/flutter/shell/platform/common/engine_switches.cc` e `packages/flutter_tools/lib/src/test/flutter_tester_device.dart`.
