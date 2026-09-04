---
title: "O que é a flag W^X no .NET e o Native AOT precisa dela?"
description: "W^X (write xor execute) é a regra de que nenhuma página de memória seja gravável e executável ao mesmo tempo. No .NET é a opção DOTNET_EnableWriteXorExecute, ligada por padrão desde o .NET 7, e existe inteiramente para o JIT. O Native AOT nunca a lê. Veja como o runtime a implementa, quanto ela custa e quando desligá-la é uma correção legítima."
pubDate: 2026-09-04
tags:
  - "dotnet"
  - "native-aot"
  - "jit"
  - "performance"
  - "security"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/09/what-is-the-w-xor-x-flag-in-dotnet-and-does-native-aot-need-it"
translatedBy: "claude"
translationDate: 2026-09-04
---

W^X ("write xor execute") é uma política de proteção de memória: qualquer página de memória pode ser gravável ou executável, nunca as duas coisas ao mesmo tempo. No .NET ela é exposta como a opção `DOTNET_EnableWriteXorExecute`, e seu valor padrão é `1` desde o .NET 7. A premissa embutida na formulação usual dessa pergunta está invertida, então vamos corrigi-la logo de cara: o Native AOT não precisa da flag W^X, e não a lê. A flag configura o alocador de memória executável do CoreCLR, que existe para servir ao JIT. O Native AOT não tem JIT nem alocador de memória executável. A relação real vai na direção oposta: plataformas que impõem W^X sem exceção (iOS, tvOS) tornam a compilação JIT impossível, e o Native AOT é a resposta a essa restrição, não um consumidor da flag.

Tudo abaixo tem como alvo `<TargetFramework>net11.0</TargetFramework>` com o SDK do .NET 11, mas a mecânica está estável desde o .NET 7. Quando um comportamento depender de uma versão específica, eu digo.

## Por que é um problema uma página ser gravável e executável

O exploit clássico de corrupção de memória tem duas metades: colocar bytes controlados pelo atacante dentro do processo, e depois fazer a CPU pular para eles. Se toda página do processo for gravável ou executável, a segunda metade para de funcionar. Os bytes que você gravou vivem em uma página que a CPU se recusa a executar, e as páginas que a CPU vai executar são páginas nas quais você não consegue gravar. A política saiu do OpenBSD em 2003 e hoje é o mínimo: o Windows chama sua versão de DEP, o Linux se apoia no bit NX mais as permissões de página do carregador, e o Apple silicon a impõe no nível do kernel para todo processo.

Para código compilado comum isso é de graça. O carregador mapeia sua seção `.text` como leitura-execução e sua seção `.data` como leitura-escrita, e nada nunca precisa mudar. O caso desconfortável é um runtime que gera código de máquina enquanto o programa roda.

## Por que o JIT é o caso desconfortável

Um compilador JIT grava bytes de código de máquina na memória e depois chama esse código. A implementação ingênua aloca uma página RWX, grava e pula. Essa é exatamente a forma que o W^X foi desenhado para proibir, e entrega ao atacante uma página garantidamente gravável e executável em um endereço mais ou menos estável.

A correção óbvia é alocar a página como leitura-escrita, emitir o código e então passá-la para leitura-execução com `mprotect`. Isso não basta para o CoreCLR, por duas razões. Primeiro, existe uma janela em que a página é gravável e seu endereço já é conhecido. Segundo, e mais importante, o runtime não grava o código uma vez só. Ele o corrige continuamente: stubs de contagem de chamadas são reescritos quando um método cruza o limiar de camadas, a [compilação em camadas](/pt-br/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/) troca o código da camada 0 pelo da camada 1, células de despacho de stub virtual são recorrigidas conforme sites de chamada monomórficos se resolvem. Alternar uma página entre RW e RX a cada correção é lento e sujeito a condição de corrida entre threads.

## Como o CoreCLR realmente implementa isso: mapeamento duplo

A resposta do CoreCLR é criar dois mapeamentos virtuais da mesma memória física. Um mapeamento é leitura-execução e é o que a CPU roda. O outro é leitura-escrita e é por onde o runtime grava. Nenhum endereço virtual é as duas coisas ao mesmo tempo, então a política se mantém, mas o runtime ainda consegue corrigir código sem mudar nenhuma permissão de página.

O encanamento é o `ExecutableAllocator` e o auxiliar RAII `ExecutableWriterHolder` em `src/coreclr/inc/executableallocator.h`. Todo ponto da VM que quer modificar código pega um writer holder, grava através de `holder.GetRW()` e deixa o destrutor descartar a visão gravável. O armazenamento de apoio é criado em `src/coreclr/minipal/Unix/doublemapping.cpp`, que no Linux faz:

```c
// dotnet/runtime, src/coreclr/minipal/Unix/doublemapping.cpp
int fd = memfd_create("doublemapper", MFD_CLOEXEC);
```

No FreeBSD ele usa `shm_open(SHM_ANON, ...)`, e em outros sistemas Unix recorre a um objeto de memória compartilhada POSIX chamado `/shm-dotnet-<pid>` que sofre `shm_unlink` imediatamente. Esse memfd é a peça que você consegue de fato observar de fora do processo:

```bash
# Linux, .NET 11. Count the double mappings in a running .NET process.
grep -c doublemapper /proc/$(pgrep -n MyApp)/maps
```

As plataformas da Apple seguem outro caminho. `CreateDoubleMemoryMapper` retorna cedo na Apple sem criar descritor de arquivo nenhum, porque o macOS em arm64 oferece um mecanismo por thread no lugar: páginas alocadas com `MAP_JIT` podem alternar entre gravável e executável apenas para a thread que chama, via `pthread_jit_write_protect_np`. O runtime empacota isso como `PAL_JitWriteProtect`, e em `HOST_APPLE && HOST_ARM64` o writer holder simplesmente devolve o mesmo endereço em vez de um segundo mapeamento:

```cpp
// dotnet/runtime, executableallocator.h, Apple arm64 path
m_addressRW = addressRX;
PAL_JitWriteProtect(true);
```

Esse escopo por thread é a parte que passa despercebida: no Apple silicon a permissão de escrita pertence a uma thread, não à página, e é por isso que você nunca deve deixar uma thread gravar uma região enquanto outra a executa.

## A flag, e como configurá-la

A opção é declarada uma única vez, em `src/coreclr/inc/clrconfigvalues.h`:

```cpp
// dotnet/runtime, src/coreclr/inc/clrconfigvalues.h
RETAIL_CONFIG_DWORD_INFO(EXTERNAL_EnableWriteXorExecute, W("EnableWriteXorExecute"), 1,
                         "Enable W^X for executable memory.");
```

Padrão `1` em toda arquitetura exceto `TARGET_RISCV64`, onde a mesma declaração entrega um padrão de `0`. Ela virou padrão no [PR #69672](https://github.com/dotnet/runtime/pull/69672), integrado em maio de 2022 para o .NET 7. Antes disso, o .NET 6 a entregava ligada por padrão apenas para macOS arm64 (onde o sistema operacional não te dá escolha) e como opt-in em todo o resto, exatamente como o [anúncio do .NET 6](https://devblogs.microsoft.com/dotnet/announcing-net-6/) prometeu.

Existem duas formas de configurá-la. A variável de ambiente funciona em todo lugar:

```bash
# Disables W^X for this process only. .NET 7 and later.
DOTNET_EnableWriteXorExecute=0 ./MyApp
```

Do .NET 9 em diante você também pode colocá-la no `runtimeconfig.json`, graças ao [PR #101490](https://github.com/dotnet/runtime/pull/101490):

```json
{
  "configProperties": {
    "System.Runtime.EnableWriteXorExecute": 0
  }
}
```

Em um projeto no estilo SDK, expresse isso como um item do MSBuild para que sobreviva a uma recompilação:

```xml
<!-- .NET 9 and later. Ignored by .NET 8 and earlier, which need the env var. -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="System.Runtime.EnableWriteXorExecute" Value="0" />
</ItemGroup>
```

O caminho via runtimeconfig nunca foi retroportado para o .NET 8; o pedido na [issue #103340](https://github.com/dotnet/runtime/issues/103340) foi fechado como não planejado. No .NET 8 a variável de ambiente é sua única opção. E note a mudança de precedência do .NET 9: variáveis de ambiente agora vencem o `runtimeconfig.json`, então um `DOTNET_EnableWriteXorExecute` perdido em uma imagem de contêiner vai sobrescrever silenciosamente a configuração do seu projeto.

## Quanto ela custa

Essa não é uma mitigação de graça, e o time do runtime a mediu antes de ligá-la. Os números do [PR #69672](https://github.com/dotnet/runtime/pull/69672) nos benchmarks plaintext, json, fortunes e orchard do ASP.NET em x64 Windows, x64 Linux e arm64 Linux foram uma regressão de inicialização de 5 a 10 por cento, com a análise seguinte colocando o tempo até a primeira requisição em cerca de 10 por cento pior. O estado estável não mostrou diferença mensurável, o que faz sentido: uma vez que os métodos quentes estão compilados pelo JIT e corrigidos, o alocador de memória executável deixa de estar em qualquer caminho que importe.

A primeira versão entregue era pior do que isso em cargas com muita compilação JIT. O [PR #74526](https://github.com/dotnet/runtime/pull/74526) acompanhou uma regressão nos testes de expressões regulares que acabou sendo causada por compilar cerca de 50.000 métodos, cada um alocando e liberando um novo mapeamento gravável. Fazer cache do último mapeamento gravável usado em vez de desmapeá-lo de imediato corrigiu isso por completo, e foi entregue no .NET 7 junto com a virada do padrão. Se você está medindo inicialização no .NET 7 ou posterior, já tem essa correção.

A leitura prática: W^X custa inicialização, não throughput. Isso importa para processos de vida curta e cold starts, e importa bem menos para um servidor de longa duração. É o mesmo eixo em que [Native AOT versus ReadyToRun versus JIT puro](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) negocia.

## Onde o Native AOT realmente se encaixa

Agora a parte que a pergunta inverte. O Native AOT publica um binário cujo código é totalmente compilado em tempo de compilação e mapeado pelo carregador do sistema operacional como leitura-execução, exatamente como um programa em C. Não há JIT, nem camadas, nem recorreção de stubs, e portanto nenhum `ExecutableAllocator`. Faça um grep no runtime do Native AOT em `src/coreclr/nativeaot/Runtime` e você não vai encontrar `EnableWriteXorExecute` em lugar nenhum. Configurar a flag contra um binário Native AOT não faz absolutamente nada: a opção é um valor de configuração da VM do CoreCLR, e o runtime do Native AOT é um runtime diferente e bem menor que nunca lê configuração do CLR.

Você pode confirmar a ausência de geração de código em tempo de execução a partir de código gerenciado:

```csharp
// .NET 11, C# 14. Prints False under Native AOT, True under CoreCLR.
using System.Runtime.CompilerServices;

Console.WriteLine(RuntimeFeature.IsDynamicCodeCompiled);
```

Isso não é bem a mesma coisa que dizer que o Native AOT não aloca memória executável em tempo de execução. Ele aloca um pouco, por uma razão específica: delegates marshalados. Quando você entrega um delegate de instância gerenciado para código nativo como um ponteiro de função, o endereço de destino precisa codificar qual instância do delegate invocar, e isso não pode ser embutido na imagem porque a instância não existe em tempo de compilação. O runtime materializa um pequeno thunk por delegate:

```csharp
// .NET 11, C# 14. This is the call that forces a runtime-allocated thunk.
using System.Runtime.InteropServices;

Action<int> callback = Console.WriteLine;
nint fnPtr = Marshal.GetFunctionPointerForDelegate(callback);
// fnPtr points at a thunk allocated from a thunk pool, not at compiled image code.
GC.KeepAlive(callback);
```

Esses thunks vêm de `PalAllocateThunksFromTemplate`, cuja assinatura em `src/coreclr/nativeaot/Runtime/unix/PalUnix.cpp` é:

```cpp
UInt32_BOOL PalAllocateThunksFromTemplate(HANDLE hTemplateModule, uint32_t templateRva,
                                          size_t templateSize, void** newThunksOut);
```

O design, adicionado para plataformas do tipo iOS no [PR #82317](https://github.com/dotnet/runtime/pull/82317), nunca produz uma página RWX. Em alvos da Apple ele reserva dois intervalos adjacentes com `vm_allocate`, e então usa `vm_remap` com `VM_FLAGS_FIXED | VM_FLAGS_OVERWRITE` para mapear a página de código de template já compilada da imagem carregada para a metade executável, enquanto a metade gravável guarda apenas os *dados* por thunk (o endereço de destino e o handle do delegate). O código nunca é gravado em tempo de execução, apenas apontado. Isso é conformidade com W^X por construção e não por política, que é exatamente o motivo de funcionar em uma plataforma que não oferece saída de emergência.

`PalVirtualAlloc` no mesmo arquivo passa `MAP_JIT` ao alocar memória executável no macOS arm64, já que o kernel exige isso lá.

## A direção em que a causalidade realmente corre

A Apple não deixa um aplicativo de terceiros da App Store mapear memória RWX nem virar uma página para executável depois de gravar nela. Não existe entitlement que mude isso para apps que são publicados. Essa única restrição elimina a compilação JIT, e com ela o modo JIT do Mono, as camadas do CoreCLR e o hot reload de código compilado. É a mesma parede em que o Flutter bate, e por isso um [build debug de Flutter para iOS falha com mprotect permission denied](/pt-br/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/) em versões recentes do iOS enquanto os builds de release, totalmente compilados AOT, não são afetados.

Então o enquadramento correto é: o iOS impõe W^X, W^X proíbe JIT, e o Native AOT é como o .NET entrega código para uma plataforma que proíbe JIT. O Native AOT suporta plataformas do tipo iOS desde o .NET 9, e é o modo de compilação padrão para builds de release do .NET MAUI em iOS e Mac Catalyst. Nada nessa cadeia envolve a flag `EnableWriteXorExecute`, que só governou como o JIT do CoreCLR coloca seus bytes na memória em plataformas que, de outro modo, teriam deixado ele ser desleixado.

## Quando desligá-la é uma correção legítima

W^X é uma mitigação de defesa em profundidade. Desligá-la é uma redução real da postura de segurança do seu processo, então trate `DOTNET_EnableWriteXorExecute=0` primeiro como ferramenta de diagnóstico e só como configuração permanente com um motivo. Estes são os motivos que se sustentam:

**Fazer profiling de frames compilados pelo JIT com o `perf` do Linux.** O runtime escreve seu mapa de perf usando o endereço do mapeamento RW, não do mapeamento RX que a CPU de fato executa, então frames do JIT resolvem para símbolos errados ou para nada. Isso está aberto desde julho de 2022 como a [issue #71786](https://github.com/dotnet/runtime/issues/71786) e continua estacionada no marco Future. Se você precisa de um profile de `perf` usável do código compilado pelo JIT, desligue W^X para essa execução. Para profiling do dia a dia, prefira o [dotnet-trace, que lê seus próprios eventos de rundown](/pt-br/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) e não é afetado.

**Entradas `/memfd:doublemapper (deleted)` crescendo.** A [issue #89776](https://github.com/dotnet/runtime/issues/89776) relata esses mapeamentos se acumulando no Linux (eles são liberados no macOS, mas não no Linux), o que aparece como contagem de mapeamentos e memória virtual subindo em um serviço de longa duração. No ARM32 o mesmo mecanismo foi relatado como um vazamento de memória de fato, causando mortes por OOM na [issue #121455](https://github.com/dotnet/runtime/issues/121455). Se seu `/proc/<pid>/maps` está cheio de `doublemapper`, é disso que se trata.

**`SIGXFSZ` sob um rlimit de tamanho de arquivo.** O memfd é um arquivo no que diz respeito ao kernel, então um `ulimit -f` abaixo do tamanho pedido pelo mapeador mata o processo com `SIGXFSZ`. Essa foi a [issue #117819](https://github.com/dotnet/runtime/issues/117819).

**Depuradores nativos colocando pontos de interrupção.** Gravar um `int3` através do mapeamento RX em vez do RW produzia violações de acesso, acompanhadas na [issue #107444](https://github.com/dotnet/runtime/issues/107444). Se você anexa `lldb` ou `gdb` a um processo .NET e vê falhas ao inserir pontos de interrupção, desligue W^X para essa sessão de depuração.

**Rosetta.** Aqui você não precisa fazer nada. O mapeamento duplo nunca funcionou corretamente sob a emulação do Rosetta ([issue #70910](https://github.com/dotnet/runtime/issues/70910)), e o runtime detecta o Rosetta e desliga W^X por você.

O que não está nessa lista é "meu app inicia devagar". Se cold start é o seu problema, a flag te compra 5 a 10 por cento enquanto uma correção de verdade, ReadyToRun ou [Native AOT com seu próprio balanço de custos](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/), te compra muito mais e não enfraquece o processo. Recorra à flag quando tiver um dos sintomas concretos acima, e deixe um comentário ao lado dizendo qual.

## Relacionados

- [O que é Native AOT e quanto ele custa para você?](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Native AOT vs ReadyToRun vs JIT no .NET 11: qual você deveria publicar?](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [O que é compilação em camadas e como raciocinar sobre ela?](/pt-br/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/)
- [Como fazer profiling de uma app .NET com dotnet-trace e ler a saída](/pt-br/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)
- [Correção: mprotect failed: 13 (Permission denied) em um build debug de Flutter para iOS](/pt-br/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/)

## Fontes

- [W^X support, dotnet/runtime PR #54954](https://github.com/dotnet/runtime/pull/54954)
- [Enable W^X by default, dotnet/runtime PR #69672](https://github.com/dotnet/runtime/pull/69672)
- [Enable caching of writeable W^X mappings, dotnet/runtime PR #74526](https://github.com/dotnet/runtime/pull/74526)
- [Read EnableWriteXorExecute from runtimeConfig, dotnet/runtime PR #101490](https://github.com/dotnet/runtime/pull/101490)
- [NativeAOT thunk page generation and mapping for iOS-like platforms, PR #82317](https://github.com/dotnet/runtime/pull/82317)
- [clrconfigvalues.h, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/coreclr/inc/clrconfigvalues.h)
- [doublemapping.cpp, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/coreclr/minipal/Unix/doublemapping.cpp)
- [Announcing .NET 6, .NET Blog](https://devblogs.microsoft.com/dotnet/announcing-net-6/)
- [.NET Runtime config options, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/)
- [Native AOT support for iOS-like platforms, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/ios-like-platforms/)
- [pthread_jit_write_protect_np(3), Apple](https://keith.github.io/xcode-man-pages/pthread_jit_write_protect_np.3.html)
