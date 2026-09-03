---
title: "Migre um app Android do .NET MAUI de Mono para CoreCLR no .NET 11"
description: "Uma migração passo a passo de Mono para CoreCLR no .NET MAUI para Android: o piso da API 24, as propriedades de MSBuild exclusivas do Mono que agora quebram sua build, por que seu APK cresceu, como perfilar a regressão de inicialização com dotnet-dsrouter e dotnet-trace, e como é um rollback de verdade agora que o caminho do Mono acabou."
pubDate: 2026-09-03
updatedDate: 2026-09-03
template: migration
tags:
  - "migration"
  - "dotnet-11"
  - "maui"
  - "android"
  - "coreclr"
  - "mono"
lang: "pt-br"
translationOf: "2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-03
---

Para um app pequeno, esta migração é uma troca de `TargetFramework`, uma troca de `android:minSdkVersion` e uma tarde de medições. Para um app grande, reserve uma semana, e espere que a semana inteira vá para duas coisas: apagar propriedades de MSBuild da era Mono que agora não fazem nada ou quebram a build ativamente, e caçar uma regressão de inicialização que não tem nada a ver com o seu código. O retorno é real (diagnóstico unificado, JIT em camadas, PGO dinâmico, um caminho plausível para o Native AOT no Android), mas a leitura honesta é que isso não é opcional. Desde o [.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/), a Microsoft não expõe mais um caminho separado do Mono para Android, iOS ou Mac Catalyst. Este guia mira o .NET 11 Preview 7 (`11.0.100-preview.7`, lançado em 2026-08-11) com o .NET MAUI `11.0.0-preview.7`, migrando a partir do .NET 10 com Mono. A versão final do .NET 11 está marcada para 2026-11-10.

## Por que vale a pena além de "você não tem escolha"

- **Seu profiler finalmente funciona.** `dotnet-trace` e `dotnet-counters` agora se conectam a um app Android em execução do mesmo jeito que se conectam a um processo ASP.NET Core, através do `dotnet-dsrouter`. Acabou o dialeto de tracing específico do Mono.
- **Compilação em camadas e PGO dinâmico chegam ao celular.** O Mono AOT compilava uma vez em tempo de build e a história de otimização terminava ali. O CoreCLR instrumenta no Tier 0 e recompila os métodos quentes no Tier 1 com dados reais de perfil, então o throughput em regime permanente de um app de vida longa melhora sem que você mude nada.
- **ReadyToRun substitui o Mono AOT como mecanismo de inicialização.** No Android, o MAUI usa por padrão R2R *composto parcial* para builds Release com CoreCLR, guiado por perfis `.mibc` que vêm no workload. Só os métodos que o perfil considera importantes são pré-compilados, e é isso que impede que o custo de tamanho seja catastrófico.
- **Um runtime, um rastreador de bugs.** Um bug de `System.Text.Json` ou de `HttpClient` no Android agora é o mesmo bug que no servidor, corrigido no mesmo lugar.

## O que quebra

| Área | Mudança | Severidade |
| --- | --- | --- |
| API mínima do Android | Sobe de 21 (Android 5.0) para 24 (Android 7.0) | alta |
| ABIs do Android | Android x86 (32 bits) não é suportado no CoreCLR | alta |
| Propriedades do Mono AOT | `RunAOTCompilation`, `AndroidAotMode`, `UseInterpreter` são exclusivas do Mono; `RunAOTCompilation=true` ainda pode invocar o `MonoAOTCompiler` e quebrar a build | alta |
| Tempo de inicialização | Apps grandes relataram regressões de vários segundos e ANRs | alta (depende do caso) |
| Tamanho do APK | As imagens R2R ficam dentro dos seus arquivos `.dll`, então os assemblies crescem | média |
| Pacotes NuGet | `NU1703` quando um pacote resolve ativos `MonoAndroid` em vez de `net6.0-android` ou posterior | média |
| Recursos legados | `XA0149` para recursos legados do Xamarin.Android embutidos em uma dependência | baixa |
| `Microsoft.Maui.Controls.Compatibility` | Pacote removido no Preview 6 | média (só se referenciado explicitamente) |
| Erros HTTP | Falhas de transporte do `AndroidMessageHandler` lançam `HttpRequestException` em vez de `WebException` | baixa |
| Embedding do runtime | As APIs de embedding do Android não seguem para o CoreCLR | alta (se você as usa) |

O piso de nível de API é o que chega aos seus usuários. Segundo o [aviso de breaking change](https://learn.microsoft.com/en-us/dotnet/core/compatibility/maui/11/android-minimum-api-level), apps compilados com .NET 11 não podem ser instalados nem executados em API 21, 22 ou 23. Confira seus números de distribuição no Play Console antes de começar, porque esta é uma decisão sobre usuários, não uma configuração de build.

## Checklist de preparação

- SDK do .NET 11 `11.0.100-preview.7` ou posterior, com o workload `maui-android` instalado.
- `$ANDROID_HOME` apontando para um caminho válido do SDK do Android. O `dotnet-dsrouter` usa o `adb` de lá para configurar o encaminhamento de portas, e não vai encontrá-lo de forma confiável de outro jeito.
- As ferramentas de diagnóstico instaladas globalmente: `dotnet tool install --global dotnet-dsrouter`, `dotnet-trace`, `dotnet-counters`.
- Uma **linha de base numérica capturada no .NET 10 com Mono, antes de mudar qualquer coisa.** Esse é o passo que todo mundo pula e depois se arrepende, porque "parece mais lento" não é algo que você consiga bissecar.
- Um aparelho real, não só o emulador. As regressões relatadas são regressões de inicialização, e o tempo de inicialização do emulador não é representativo.

## Passos da migração

1. **Capture a linha de base do Mono.** Na sua build Release atual do .NET 10, instale o APK e meça a inicialização a frio com o gerenciador de atividades do Android, que reporta `TotalTime` em milissegundos:

   ```console
   # .NET 10, Mono, Release
   adb shell am force-stop com.example.myapp
   adb shell am start -W -n com.example.myapp/crc64...MainActivity
   ```

   Rode cinco vezes, descarte a primeira e anote a mediana. Anote também o tamanho do APK ou AAB de Release. **Verifique:** você tem dois números escritos em algum lugar que não seja o histórico do terminal.

2. **Mova o target framework e o piso de API juntos.** As duas mudanças, no mesmo commit, porque o CoreCLR no Android exige API 24:

   ```xml
   <!-- .NET 11 Preview 7, MAUI 11.0.0-preview.7 -->
   <PropertyGroup>
     <TargetFrameworks>net11.0-android;net11.0-ios;net11.0-maccatalyst</TargetFrameworks>
     <SupportedOSPlatformVersion Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">24.0</SupportedOSPlatformVersion>
   </PropertyGroup>
   ```

   Se você define `android:minSdkVersion` na mão em `Platforms/Android/AndroidManifest.xml`, suba para `24` para que o manifesto e o projeto concordem. **Verifique:** `dotnet build -f net11.0-android -c Release` passa e o manifesto gerado mostra `minSdkVersion="24"`.

3. **Apague ou condicione toda propriedade de MSBuild exclusiva do Mono.** Faça grep no seu `.csproj`, no `Directory.Build.props` e em qualquer propriedade injetada pelo CI atrás de `RunAOTCompilation`, `AndroidAotMode`, `AndroidEnableProfiledAot`, `UseInterpreter` e `UseMonoRuntime`. Deixar `RunAOTCompilation=true` em um `Directory.Build.props` é uma quebra de build conhecida: o target `MonoAOTCompiler` ainda roda mesmo com o app no CoreCLR ([dotnet/android#11068](https://github.com/dotnet/android/issues/11068)). Apague de vez ou, se você ainda compila um TFM antigo em paralelo, condicione:

   ```xml
   <PropertyGroup Condition="'$(UseMonoRuntime)' == 'true'">
     <RunAOTCompilation>true</RunAOTCompilation>
     <AndroidEnableProfiledAot>true</AndroidEnableProfiledAot>
   </PropertyGroup>
   ```

   **Verifique:** `dotnet build -f net11.0-android -c Release -bl` e depois procure `MonoAOTCompiler` no log binário. Zero ocorrências é a condição de aprovação.

4. **Limpe a lista de ABIs e os avisos de pacote.** Tire `x86` de `RuntimeIdentifiers` se ainda estiver lá, já que o CoreCLR não distribui essa arquitetura:

   ```xml
   <RuntimeIdentifiers>android-arm64;android-x64</RuntimeIdentifiers>
   ```

   Depois lide com o `NU1703`. Introduzido no Preview 5, ele dispara quando um pacote resolve ativos da pasta obsoleta `MonoAndroid`: "Package 'PackageName' 1.0.0 uses the deprecated MonoAndroid framework instead of 'net6.0-android' or later." Atualize o pacote se existir uma versão moderna. Se não existir, você encontrou uma dependência da era Xamarin que está com os dias contados, e suprimir o aviso é uma decisão de carregar esse risco, não uma correção. **Verifique:** `dotnet restore` está limpo, ou cada `NU1703` restante é um pacote que você triou conscientemente.

5. **Recompile em Release e meça de novo contra o passo 1.** Mesmo aparelho, mesmo procedimento, mesmo número de execuções:

   ```console
   # .NET 11 Preview 7, CoreCLR, Release
   dotnet publish -f net11.0-android -c Release
   adb install -r bin/Release/net11.0-android/publish/com.example.myapp-Signed.apk
   adb shell am force-stop com.example.myapp
   adb shell am start -W -n com.example.myapp/crc64...MainActivity
   ```

   A posição da própria Microsoft é que o Android fica "dentro de 10 por cento do Mono em inicialização e tamanho de app" para um app de template base. **Verifique:** se você está dentro dessa faixa, o trabalho de desempenho acabou. Se está em 2x ou pior, vá para o passo 6 em vez de sair alternando propriedades de MSBuild na sorte.

6. **Perfile a regressão em vez de adivinhar.** Adicione um arquivo `app.env` ao lado do `.csproj` contendo `DOTNET_DiagnosticPorts=127.0.0.1:9000,suspend` e referencie de forma condicional:

   ```xml
   <ItemGroup Condition="'$(AndroidEnableProfiler)'=='true'">
     <AndroidEnvironment Include="app.env" />
   </ItemGroup>
   ```

   Suba o router, compile com o profiler habilitado, abra o app e então conecte:

   ```console
   dotnet-dsrouter server-server -ipcs ~/mylocalport -tcps 127.0.0.1:9000 --forward-port Android &
   dotnet build -f net11.0-android -c Release -t:Run /p:AndroidEnableProfiler=true
   dotnet-trace collect --diagnostic-port ~/mylocalport,connect
   ```

   Como a porta foi configurada com `suspend`, o runtime trava na inicialização até o `dotnet-trace` conectar, que é exatamente o que você precisa para ver o caminho de inicialização e não tudo o que vem depois. No Windows, use `mylocalport` em vez de `~/mylocalport`, já que o canal IPC é um named pipe. **Verifique:** você tem um arquivo `.nettrace` com uma janela de inicialização preenchida e consegue nomear os três métodos com maior tempo inclusivo.

7. **Ajuste só o que o trace justificar.** Se o problema é o tamanho dos assemblies, o R2R é o primeiro botão, porque as imagens R2R vão empacotadas dentro dos arquivos `.dll` e é por isso que seus assemblies cresceram:

   ```xml
   <PropertyGroup Condition="'$(Configuration)' == 'Release'">
     <PublishReadyToRun>false</PublishReadyToRun>  <!-- smaller APK, slower startup -->
     <TrimMode>full</TrimMode>                     <!-- default is partial -->
   </PropertyGroup>
   ```

   Os dois puxam em direções opostas: desligar o R2R troca inicialização por tamanho, e `TrimMode=full` recupera tamanho mas passa a recortar o seu código e suas referências NuGet, então exige uma rodada completa de regressão. Mude um de cada vez e refaça o passo 5 entre cada um. **Verifique:** cada botão está justificado por um delta medido que você consegue citar, não por um post de blog.

8. **Faça um rollout em fases.** Publique primeiro em uma trilha interna e observe especificamente a taxa de ANR, não só a de crashes. O modo de falha relatado do CoreCLR em apps grandes é uma inicialização que demora o suficiente para o Android matar o processo, o que aparece como ANR e não como exceção. **Verifique:** a taxa de ANR no Play Console depois de uma semana de teste interno está estável em relação à sua build com Mono.

## Checklist de verificação

- `dotnet build -f net11.0-android -c Release` não produz nenhuma invocação do `MonoAOTCompiler` no log binário.
- A mediana de inicialização a frio em um aparelho real está dentro da faixa aceita em relação à linha de base do .NET 10.
- O delta de tamanho do APK/AAB está registrado e aceito.
- A suíte de testes completa passa, incluindo testes que tocam reflexão, caminhos de erro do `HttpClient` ou serialização.
- O Hot Reload funciona. No CoreCLR isso passa por Edit and Continue em vez do interpretador do Mono, então é um caminho de código genuinamente diferente do que você testou na última versão.
- Não há aparelhos com API 21-23 na sua base ativa de instalações, ou você já comunicou o corte.

## Plano de rollback

Diga isso em voz alta: **não existe mais rollback no nível do runtime.** `<UseMonoRuntime>true</UseMonoRuntime>` foi documentado como a saída de emergência quando o CoreCLR virou padrão no Preview 4, e na época foi apresentado como um desbloqueio temporário enquanto você reportava uma regressão. O Preview 6 removeu o caminho separado do Mono para Android, iOS e Mac Catalyst. Trate a propriedade como inexistente e não monte um plano de release em cima dela.

Seu rollback de verdade é o target framework: mantenha a build `net10.0-android` verde em um branch até a build do .NET 11 sobreviver a um rollout real em produção. Isso é um rollback bem mais pesado do que virar uma propriedade, e é exatamente por isso que os passos 1 e 5 existem.

## Armadilhas que custam tempo de verdade

**A regressão de inicialização é real e não está distribuída de forma uniforme.** Duas issues documentam o modo de falha: a [dotnet/android#10588](https://github.com/dotnet/android/issues/10588) relata que "an app that takes 1s to launch on mono can take 6s on coreclr", com ANRs no `ControlCatalog.Android` do Avalonia, e a [dotnet/android#10914](https://github.com/dotnet/android/issues/10914) relata cerca de 1,0 s para 6,0 s de inicialização a frio e um crescimento de APK de 21 MB para 38 MB no `11.0.100-preview.2`. As duas são do Avalonia, não do MAUI, e as duas são anteriores ao trabalho de R2R composto parcial e de perfis MIBC que chegou mais tarde no ciclo de preview, então não leia isso como o seu resultado esperado. Leia como o motivo pelo qual o passo 1 é obrigatório.

**Os caminhos de inicialização pesados em XAML são os que doem.** O fio comum nos relatos é reflexão e parsing de XAML durante a inicialização, que é exatamente o trabalho que o R2R parcial não consegue pré-compilar se o perfil `.mibc` distribuído não cobrir o formato do seu app. Se o seu app monta uma árvore visual grande antes do primeiro frame, é ali que se olha primeiro.

**O `UseInterpreter` silenciosamente deixa de importar.** Ele era `true` por padrão em Debug no Mono, e era o que fazia o Hot Reload da era Mono funcionar. No CoreCLR ele é inerte. Se você o tinha ligado por um motivo (algum caminho de código dinâmico que o Mono AOT não dava conta), esse motivo não sumiu, só mudou de lugar: o CoreCLR no Android roda um JIT de verdade em Debug, então o código vai funcionar, mas teste de novo de propósito em vez de assumir.

**O conteúdo do seu APK muda de forma.** No Mono você distribuía `libmonosgen-2.0.so` mais imagens `libaot-*.dll.so`. No CoreCLR você distribui `libcoreclr.so`, `libclrjit.so`, `libmonodroid.so` (a cola do Android mantém o nome da era Mono) e um único `libassemblies.arm64-v8a.so` com MSIL comprimido e imagens R2R. Se você tem scripts de build, orçamentos de tamanho ou configuração de ProGuard/R8 que citam esses arquivos, eles precisam ser atualizados.

**O tamanho está mesmo no trimming.** O MAUI ainda usa `TrimMode=partial` por padrão, que recorta os assemblies do framework mas deixa o seu código e suas referências NuGet intactos. A maioria das reclamações de tamanho vira reclamação de trimming assim que você olha o detalhamento por assembly.

## Relacionados

- A troca de runtime foi anunciada quando [o MAUI tornou o CoreCLR padrão no Android, iOS e Mac Catalyst no Preview 4](/pt-br/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/), de onde saiu a propriedade de opt-out.
- A saída de emergência fechou dois meses depois, quando [o MAUI mobile passou a ser só CoreCLR no Preview 6](/pt-br/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/).
- Se você ainda está na pilha antiga, a migração pré-requisito é [Xamarin.Forms para MAUI 11](/pt-br/2026/05/migrate-from-xamarin-forms-to-maui-11/), não esta.
- O trade-off entre R2R e Mono AOT do passo 7 é coberto a fundo em [Native AOT vs ReadyToRun vs JIT no .NET 11](/pt-br/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/), e o objetivo final que o CoreCLR destrava no Android está descrito em [o que o Native AOT realmente custa](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/).
- Se o `TrimMode=full` do passo 7 quebrar sua serialização, a falha aparece como [reflection-based serialization has been disabled for this application](/pt-br/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/).
- Mudar a lista de ABIs distribuídas no passo 4 pode gerar [a falha de instalação "doesn't support required ABI"](/pt-br/2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app/) em aparelhos que você atendia antes.

## Fontes

- [.NET MAUI Moves to CoreCLR in .NET 11](https://devblogs.microsoft.com/dotnet/dotnet-maui-moves-to-coreclr-in-dotnet-11/), o blog do .NET
- [CoreCLR Progress and the Mono Timeline for .NET MAUI](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/), o blog do .NET
- [Runtimes and compilation in .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/deployment/runtimes-compilation), Microsoft Learn
- [Breaking change: Minimum Android API level raised to 24](https://learn.microsoft.com/en-us/dotnet/core/compatibility/maui/11/android-minimum-api-level), Microsoft Learn
- [Breaking change: NU1703 warning for packages that use deprecated MonoAndroid framework assets](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/11/nu1703-deprecated-monoandroid-framework), Microsoft Learn
- [dotnet-dsrouter](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dsrouter), Microsoft Learn
- [dotnet/maui#33386, o epic de acompanhamento do CoreCLR no Android](https://github.com/dotnet/maui/issues/33386)
- [dotnet/android#10588, ANR while running large app](https://github.com/dotnet/android/issues/10588)
- [dotnet/android#11068, RunAOTCompilation runs MonoAOTCompiler under CoreCLR](https://github.com/dotnet/android/issues/11068)
