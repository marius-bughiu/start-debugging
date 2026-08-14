---
title: "Correção: mprotect failed: 13 (Permission denied) em um build debug de Flutter para iOS"
description: "O iOS impede que a Dart VM marque páginas de memória como executáveis, então o JIT morre na inicialização. Atualize para Flutter 3.35.0 ou posterior no iOS 26, e 3.32.0 no iOS 18.4. Nenhum entitlement resolve isso."
pubDate: 2026-08-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "ios"
  - "xcode"
lang: "pt-br"
translationOf: "2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build"
translatedBy: "claude"
translationDate: 2026-08-14
---

Atualize o Flutter. Esse crash é o iOS se recusando a deixar a Dart VM transformar uma página de memória gravável em executável, que é exatamente o que o JIT precisa e exatamente o que o modo debug usa para rodar. O Flutter 3.35.0 (Dart 3.9.0, 2025-08-14) é a primeira versão estável que sobrevive a isso em aparelhos físicos com iOS 26; o Flutter 3.32.0 (Dart 3.8.0) foi a primeira que sobreviveu no iOS 18.4. Não existe entitlement, chave de Info.plist ou flag de compilação que você possa adicionar a um SDK antigo para resolver. Se você já está no 3.35.0 ou posterior e ainda vê o crash, o seu scheme do Xcode está sem o LLDB Init File, que é a segunda metade da correção.

## O crash, na íntegra

O app morre durante o `Dart_Initialize`, antes de um único widget ser construído:

```
../../../flutter/third_party/dart/runtime/vm/virtual_memory_posix.cc: 428: error: mprotect failed: 13 (Permission denied)
version=3.7.0 (stable) (Wed Feb 5 04:53:58 2025 -0800) on "ios_arm64"
pid=726, thread=259, isolate_group=vm-isolate(0x11ea52800), isolate=vm-isolate(0x11ebe5800)
os=ios, arch=arm64, comp=no, sim=no
  pc 0x0000000110302e84 fp 0x000000016eee4f50 Dart_DumpNativeStackTrace+0x18
  pc 0x000000010feb1428 fp 0x000000016eee4f70 dart::Assert::Fail(char const*, ...) const+0x30
  pc 0x000000010ffac33c fp 0x000000016eee5420 dart::Code::FinalizeCode(...)+0x82c
  pc 0x0000000110039cb0 fp 0x000000016eee5a30 dart::StubCode::Init()+0x320
  pc 0x000000010fefc4f4 fp 0x000000016eee64e0 dart::Dart::DartInit(Dart_InitializeParams const*)+0x2b18
  pc 0x00000001102e9754 fp 0x000000016eee6960 Dart_Initialize+0x60
  pc 0x000000010fe71e24 fp 0x000000016eee6f30 flutter::DartVM::Create(...)+0x1d64
=== Crash occurred when compiling unknown function in unoptimized JIT mode in unknown pass
```

Três detalhes identificam o problema sem margem para dúvida. O frame é `dart::StubCode::Init()`, que roda antes do seu código existir, então nada no seu Dart é responsável. O `13` é `EACCES` do `mprotect` do POSIX. E a última linha cita o modo JIT explicitamente.

## Por que o iOS recusa a chamada mprotect

Builds debug do Flutter rodam a Dart VM em modo JIT. Isso não é um detalhe de implementação do qual você possa abrir mão: o hot reload funciona compilando Dart novo em código de máquina dentro do processo em execução, o que significa que a VM escreve bytes em uma página e depois os executa.

A política W^X da Apple diz que uma página pode ser gravável ou executável, nunca as duas coisas ao mesmo tempo. A saída clássica é alocar a página como RW, escrever o código compilado e então chamar `mprotect(PROT_READ | PROT_EXEC)` para virá-la. A Dart VM fazia exatamente isso, em `VirtualMemory::Protect` no `runtime/vm/virtual_memory_posix.cc`.

A partir das betas do iOS 18.4, e apertado de novo no iOS 26, o kernel parou de permitir essa transição para apps de terceiros, mesmo com o entitlement `get-task-allow` que um build de desenvolvimento carrega. O `mprotect` retorna `EACCES`, o `ASSERT` da VM dispara e o processo aborta. Isso é todo o conteúdo da [flutter/flutter#163984](https://github.com/flutter/flutter/issues/163984), uma P1 que ficou aberta de fevereiro a julho de 2025 e acumulou 61 comentários.

Duas consequências que vale internalizar antes de começar a mexer nas coisas:

**Builds release e profile não são afetados.** Eles são compilados AOT. O código de máquina já está no binário do app, mapeado como executável pelo loader, e a VM nunca pede mudança de proteção. Se seu CI está verde e seu build do TestFlight roda, isso é o esperado e não é evidência de que sua configuração está correta.

**O simulador não é afetado.** Ele roda sobre o kernel do macOS, que não aplica a restrição. Um time onde uma pessoa testa no simulador e outra no aparelho vai ver isso dividido exatamente ao meio, e é isso que torna a primeira hora de investigação tão confusa.

## De qual versão do Flutter eu realmente preciso?

A correção chegou em duas partes, em duas versões estáveis diferentes. Verifiquei a ancestralidade dos commits com a API de comparação do GitHub contra as tags de release do SDK do Dart, em vez de confiar na thread da issue.

| Alvo | Primeira estável que funciona | Dart | Publicada |
| --- | --- | --- | --- |
| Aparelho físico com iOS 18.4 | Flutter 3.32.0 | 3.8.0 | 2025-05-20 |
| Aparelho físico com iOS 26 | Flutter 3.35.0 | 3.9.0 | 2025-08-14 |
| iOS 26, a ferramenta controla o LLDB | Flutter 3.38.0 | 3.10.0 | 2025-11-12 |

A primeira parte é o hook `NOTIFY_DEBUGGER_ABOUT_RX_PAGES` na VM, adicionado no commit `939699a9` do Dart em 2025-02-28. Ele é ancestral da tag `3.8.0`, então tudo do Flutter 3.32.0 em diante já tem.

A segunda parte é o mapeamento duplo de páginas de código, três commits de junho de 2025 (`d194fcec`, `dc0567c0`, `c111f693`). Esses são ancestrais de `3.9.0` mas não de `3.8.1`, e é por isso que o 3.32.x quebra no iOS 26 enquanto o 3.35.0 não. Em vez de virar a proteção de um único mapeamento, a VM agora mapeia a mesma memória física duas vezes: uma visão RW pela qual o compilador escreve, e uma visão RX separada de onde a CPU executa. Nenhuma chamada `mprotect`, nada para o kernel recusar.

Então a instrução prática é uma linha:

```bash
# Latest stable at time of writing is 3.47.0 (Dart 3.13.0, 2026-08-12)
flutter upgrade
flutter clean
```

O `flutter clean` não é superstição. A ferramenta do Flutter escreve arquivos LLDB gerados em `ios/Flutter/ephemeral/`, e cópias obsoletas de um SDK anterior causaram falhas relatadas repetidamente na issue enquanto a correção era distribuída.

## Estou no Flutter 3.35 ou posterior e ainda quebra

Então a VM está certa e o lado do depurador não. O mapeamento duplo é necessário mas não suficiente: o mapeamento RX só se torna válido quando o depurador toca as páginas, então o LLDB precisa fazer parte do lançamento. O Flutter conecta isso pelo scheme do Xcode, e se o scheme estiver sem essa configuração você recebe o mesmo crash de `mprotect` de volta.

A ferramenta tenta migrar o scheme para você em todo build debug ou profile. Quando não consegue, ela imprime isto:

```
Running Flutter in debug mode on new iOS versions requires a LLDB Init File,
but the Runner scheme does not have it set. To ensure debug mode works, please
complete the following:
  * Open Xcode > Product > Scheme > Edit Scheme and for the Run and Test actions,
    set LLDB Init File to:

  $(SRCROOT)/Flutter/ephemeral/flutter_lldbinit
```

Faça exatamente isso, e note que ela quer tanto a ação Run quanto a ação Test. A migração verifica cada uma separadamente e vai reclamar da que estiver faltando. Se você já tem seu próprio LLDB Init File, o Flutter não sobrescreve; em vez disso ele manda encadear o arquivo dele a partir do seu:

```
command source /path/to/ios/Flutter/ephemeral/flutter_lldbinit
```

Em um projeto add-to-app o caminho é diferente, porque o módulo Flutter é compilado como um pacote Swift e os arquivos gerados vão parar na saída do pacote. Configure o LLDB Init File do scheme como `$(FLUTTER_SWIFT_PACKAGE_OUTPUT)/Scripts/flutter_lldbinit`, ou inclua-o de forma relativa ao seu próprio arquivo:

```
command source --relative-to-command-file "../my_flutter_app/build/ios/SwiftPackages/Scripts/flutter_lldbinit"
```

Hosts add-to-app recebem aqui um aviso em vez de um erro, porque a ferramenta não tem como saber qual dos seus schemes é o que você usa para lançar. Ela varre todo `.xcscheme` do projeto procurando a string `customLLDBInitFile` e só avisa se nenhum deles a tiver. Um projeto com cinco schemes onde o configurado é o errado passa nessa verificação e continua quebrando.

## Como o JIT funciona agora, se o mprotect está bloqueado?

Vale entender, porque explica a restrição da próxima seção.

O `ios/Flutter/ephemeral/flutter_lldb_helper.py` gerado coloca um ponto de interrupção em um símbolo que a VM exporta puramente como sinal para o depurador, e então escreve nas páginas pelo lado do depurador, que tem permissão para modificar a memória executável de um processo depurado:

```python
# Generated by Flutter 3.44.2 into ios/Flutter/ephemeral/flutter_lldb_helper.py
import lldb

def handle_new_rx_page(frame: lldb.SBFrame, bp_loc, extra_args, intern_dict):
    """Intercept NOTIFY_DEBUGGER_ABOUT_RX_PAGES and touch the pages."""
    base = frame.register["x0"].GetValueAsAddress()
    page_len = frame.register["x1"].GetValueAsUnsigned()

    data = bytearray(page_len)
    data[0:8] = b'IHELPED!'

    error = lldb.SBError()
    frame.GetThread().GetProcess().WriteMemory(base, data, error)
    if not error.Success():
        print(f'Failed to write into {base}[+{page_len}]', error)
        return

def __lldb_init_module(debugger: lldb.SBDebugger, _):
    target = debugger.GetDummyTarget()
    bp = target.BreakpointCreateByRegex("^NOTIFY_DEBUGGER_ABOUT_RX_PAGES$")
    bp.SetScriptCallbackFunction('{}.handle_new_rx_page'.format(__name__))
    bp.SetAutoContinue(True)
    print("-- LLDB integration loaded --")
```

O marcador `IHELPED!` é um diagnóstico: o `NOTIFY_DEBUGGER_ABOUT_RX_PAGES` lê os primeiros oito bytes de volta e consegue assim distinguir entre "o depurador cuidou disso" e "nenhum ponto de interrupção foi definido", que é a diferença entre uma configuração funcional e o crash do começo deste artigo.

Se você vir `-- LLDB integration loaded --` no console do Xcode, o init file está conectado corretamente.

## O que mudou no Flutter 3.38 e posteriores?

A partir do Flutter 3.38.0 a ferramenta parou de delegar ao Xcode para aparelhos físicos e passou a controlar `devicectl` e `lldb` diretamente (PRs [#173417](https://github.com/flutter/flutter/pull/173417), [#173443](https://github.com/flutter/flutter/pull/173443) e [#173724](https://github.com/flutter/flutter/pull/173724)). O `flutter run` lança o app parado e então alimenta o LLDB com esta sequência:

```
device select <device-id>
breakpoint set --func-regex '^NOTIFY_DEBUGGER_ABOUT_RX_PAGES$'
breakpoint command add --script-type python <breakpoint-id>
device process attach --pid <app-pid>
process continue
```

Isso está atrás de uma feature flag ligada por padrão em todos os canais. Confirmado contra uma instalação local do Flutter 3.44.2, o `packages/flutter_tools/lib/src/features.dart` declara:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/features.dart
const lldbDebugging = Feature(
  name: 'support for debugging with LLDB for physical iOS devices',
  configSetting: 'enable-lldb-debugging',
  environmentOverride: 'FLUTTER_LLDB_DEBUGGING',
  master: FeatureChannelSetting(available: true, enabledByDefault: true),
  beta: FeatureChannelSetting(available: true, enabledByDefault: true),
  stable: FeatureChannelSetting(available: true, enabledByDefault: true),
);
```

Exige iOS 17 ou mais novo e Xcode 26 ou mais novo. Abaixo de qualquer um dos dois limites a ferramenta cai silenciosamente para o lançamento via Xcode, e é por isso que uma máquina ainda no Xcode 16 pode apresentar sintomas completamente diferentes dos de um colega na mesma versão do Flutter. Verifique `xcodebuild -version` antes de comparar anotações.

Você pode desligar globalmente ou por projeto se der problema:

```bash
flutter config --no-enable-lldb-debugging
```

```yaml
# pubspec.yaml, disables LLDB debugging for this project only
flutter:
  config:
    enable-lldb-debugging: false
```

## E se eu não puder atualizar o Flutter?

Se você está preso a um SDK antigo, e pins em 3.7.x eram comuns na thread da issue, não há backport nem solução dentro do app. Suas opções são testar no simulador, testar em um aparelho ainda no iOS 18.3 ou anterior, ou rodar `flutter run --profile`, que é AOT e portanto imune. O modo profile custa o hot reload mas mantém DevTools, a timeline e o inspetor de widgets, então é um paliativo utilizável para trabalho de UI que não seja muito iterativo.

Atualizar um SDK preso há muito tempo através de quatro versões estáveis é um projeto por si só. Se você cuida de vários apps com pins diferentes, [mirar várias versões do Flutter em um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) é a forma mais barata de escalonar do que atualizar tudo de uma vez.

## Armadilhas que parecem esse bug mas não são

**Um build debug agora precisa do depurador conectado o tempo todo.** Iniciar um debugserver no aparelho é o que torna o JIT legal, então um build debug lançado pela tela inicial sem depurador conectado vai quebrar do mesmo jeito. Isso não é uma regressão para reportar; é o mecanismo. Use um build profile ou release para qualquer coisa que você entregar a um testador.

**Depuração sem fio no iOS 26 é lenta, não está quebrada.** O Flutter 3.44 imprime "Wireless debugging on iOS 26 may be slower than expected. For better performance, consider using a wired (USB) connection." Cada entrega de página RX é uma ida e volta ao depurador, e por Wi-Fi isso acumula. Vários relatos de travadas de dez segundos na issue original eram exatamente isso. Conecte o cabo antes de abrir um bug.

**Builds release no CI reclamando de `customLLDBInitFile`.** A migração de scheme só roda para builds debug e profile, mas um scheme mal configurado ainda pode aparecer em pipelines de release. Se seu CI falha por causa do init file em um build release, o problema é o scheme, não este crash: um build release não tem JIT e não precisa de LLDB.

**Flavors têm seus próprios schemes.** O Flutter migra o scheme que resolve para o flavor sendo compilado. Se você tem schemes `dev`, `staging` e `prod` e só roda `dev` localmente, os outros dois ficam sem migração até alguém compilá-los, e cada um vai falhar uma vez.

**Qualquer coisa mencionando `mprotect` no Android é outro problema.** Falhas de build no Android envolvendo páginas de memória quase sempre são o requisito de páginas de 16 KB, que é uma questão de empacotamento e alinhamento, não de JIT. Isso tem [sua própria correção envolvendo NDK r28 e zipalign](/pt-br/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).

## Relacionados

Se o app nem chega a ser lançado, a falha está antes da VM: [Failed to build iOS app com Xcode 16 e Flutter 3.x](/pt-br/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/) e [CocoaPods não encontra versões compatíveis para um pod](/pt-br/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/) cobrem as duas falhas que explicam a maior parte do resto. Como esse crash só reproduz em hardware, também vale ter um [fluxo de trabalho com aparelho real para depurar Flutter iOS a partir do Windows](/pt-br/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) para que um Mac não seja pré-requisito para reproduzir. E se a atualização para 3.35 ou posterior trouxer muita outra quebra junto, o [checklist de null safety do Flutter 3.x](/pt-br/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) é a ordem que eu uso em bases de código antigas.

## Fontes

- [Debug mode and hot reload fail on iOS 26 due to JIT restriction `error: mprotect failed: 13 (Permission denied)`](https://github.com/flutter/flutter/issues/163984), a issue P1 de acompanhamento, pelo dump original do crash e pela cronologia da correção.
- [Add lldb init file](https://github.com/flutter/flutter/pull/164344) (flutter/flutter#164344, mergeado em 2025-03-06), incluído nas [notas de versão do Flutter 3.32.0](https://docs.flutter.dev/release/release-notes/release-notes-3.32.0).
- [Notas de versão do Flutter 3.38.0](https://docs.flutter.dev/release/release-notes/release-notes-3.38.0), pelo LLDB e `devicectl` se tornando o caminho padrão de lançamento no iOS 17+ com Xcode 26+.
- [Integrate a Flutter app into your iOS project](https://docs.flutter.dev/add-to-app/ios/project-setup), pelos caminhos do LLDB Init File em add-to-app.
- Commits do SDK do Dart `939699a9` (`[vm] Add NOTIFY_DEBUGGER_ABOUT_RX_PAGES hook`), `d194fcec` (`[vm] Use dual mapping of code pages on certain OS versions`), `dc0567c0` e `c111f693`, com a ancestralidade das tags verificada contra as tags de release `3.8.1` e `3.9.0`.
- Código citado de uma instalação local do Flutter 3.44.2 stable: `packages/flutter_tools/lib/src/features.dart`, `lib/src/ios/lldb.dart`, `lib/src/xcode_project.dart`, `lib/src/migrations/lldb_init_migration.dart` e `lib/src/build_system/targets/ios.dart`.
