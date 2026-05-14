---
title: "MAUI muda para CoreCLR por padrão no Android, iOS e Mac Catalyst no .NET 11 Preview 4"
description: "O .NET 11 Preview 4 torna o CoreCLR o runtime padrão para o MAUI no Android, iOS, Mac Catalyst e tvOS. O Mono ainda está a uma propriedade do MSBuild de distância. Aqui está o que muda, o que quebra e como desativar."
pubDate: 2026-05-14
tags:
  - "dotnet-11"
  - "maui"
  - "coreclr"
  - "mono"
  - "runtime"
lang: "pt-br"
translationOf: "2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4"
translatedBy: "claude"
translationDate: 2026-05-14
---

A Microsoft [trocou o runtime padrão do MAUI para CoreCLR no .NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-maui-moves-to-coreclr-in-dotnet-11/), lançado em 13 de maio de 2026. Novos projetos MAUI direcionados a Android, iOS, Mac Catalyst e tvOS agora rodam no mesmo runtime que impulsiona o ASP.NET Core e aplicativos de console no desktop. O Mono não é mais a escolha implícita no celular. Esta é a maior mudança arquitetural única no MAUI desde a fusão com o Xamarin, e ela aterrissa silenciosamente atrás de uma flag padrão.

Se você está acompanhando a história móvel do .NET 11, isso se baseia na [chegada do `dotnet watch` ao MAUI no Android e iOS na mesma versão prévia](/pt-br/2026/05/dotnet-watch-maui-android-ios-net-11-preview-4/).

## Por que CoreCLR em um celular importa

Por cerca de uma década, Xamarin e depois MAUI rodaram sobre Mono no celular porque o CoreCLR não tinha uma história AOT funcional para alvos móveis ARM. O Mono trazia seu próprio compilador AOT, GC, JIT, profiler e depurador. Todo investimento em ferramentas que a Microsoft fez no CoreCLR (compilação em camadas, PGO dinâmico, o motor de regiões do Server GC, ReadyToRun) tinha que ser reimplementado ou pulado no celular.

A troca para CoreCLR resolve isso. O MAUI móvel agora obtém o mesmo JIT, GC e superfície de diagnóstico que um contêiner Linux rodando ASP.NET Core. Os números de inicialização da Microsoft são positivos para templates baseline com ReadyToRun e PGO, mas o anúncio é honesto sobre regressões em aplicativos maiores no Android e pede aos times que meçam em modo Release em dispositivos reais antes de assumir uma vitória de graça.

A outra razão pela qual isso importa: CoreCLR no Android desbloqueia NativeAOT para o MAUI, que o post chama de "um próximo passo natural".

## O que é desligado por padrão

CoreCLR no celular descarta algumas plataformas que o Mono carregava:

- Android x86 acabou.
- Android API 23 e inferiores acabou.
- As APIs de embedding do Android (o caminho que a maioria dos autores de bibliotecas Xamarin.Android usavam) acabaram.
- Android arm32 está "ainda em revisão".
- Blazor WebAssembly não é afetado. WASM permanece no Mono porque o CoreCLR não tem um alvo WebAssembly.

Se seu aplicativo ou qualquer dependência transitiva do NuGet depender das APIs de embedding ou de binários distribuídos para x86, a atualização vai falhar no build ou no load, não em runtime na produção.

## Como desativar

Uma propriedade do MSBuild reverte os target frameworks afetados para Mono:

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-android'">
  <UseMonoRuntime>true</UseMonoRuntime>
</PropertyGroup>
```

Remova a `Condition` para reverter todas as plataformas. Trate isso como uma saída temporária. A Microsoft não se comprometeu a manter o Mono distribuído para o MAUI móvel além do ciclo de vida do .NET 11, e o anúncio enquadra a propriedade como uma forma de desbloquear uma versão enquanto você abre uma issue de regressão, não como uma opção de configuração de longo prazo.

## O que realmente fazer esta semana

Três coisas valem a pena fazer agora, enquanto ainda é uma versão prévia:

1. Compile no .NET 11 Preview 4 e verifique falhas das plataformas descartadas.
2. Rode um build Release em um dispositivo Android de baixa especificação representativo e compare o cold start, warm start e tamanho do APK contra o mesmo aplicativo compilado no .NET 10. Relatos da comunidade incluem tanto ganhos quanto regressões, então números genéricos não vão prever seu aplicativo.
3. Se você depende de uma biblioteca Xamarin.Android que não foi tocada em anos, verifique se ela usa as APIs de embedding. Se usar, ela não vai carregar no CoreCLR e você precisa de uma substituta antes do trem do GA partir.

Esse é o tipo de mudança que parece bem em benchmarks e silenciosamente quebra produção seis meses depois, quando uma dependência transitiva acaba sendo só Mono. Melhor descobrir durante a versão prévia.
