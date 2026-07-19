---
title: "No mobile, MAUI é só CoreCLR no .NET 11 Preview 6: a saída de emergência do Mono acabou"
description: "O .NET 11 Preview 6 remove o caminho separado do Mono para MAUI no Android, iOS e Mac Catalyst. CoreCLR agora é o único runtime móvel, a saída de emergência UseMonoRuntime foi fechada e a GA está marcada para novembro de 2026."
pubDate: 2026-07-19
tags:
  - "dotnet-11"
  - "maui"
  - "coreclr"
  - "mono"
  - "runtime"
lang: "pt-br"
translationOf: "2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6"
translatedBy: "claude"
translationDate: 2026-07-19
---

Há dois meses, [o MAUI trocou seu runtime móvel padrão para CoreCLR no .NET 11 Preview 4](/pt-br/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/), e as notas da versão te entregaram uma saída de emergência: defina `<UseMonoRuntime>true</UseMonoRuntime>` e suas builds de Android, iOS e Mac Catalyst voltavam para o runtime antigo. Essa saída está se fechando. Em [CoreCLR Progress and the Mono Timeline for .NET MAUI](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/), David Ortinau confirma que, a partir do .NET 11 Preview 6 (publicado em 2026-07-10), CoreCLR é o único runtime exposto para os aplicativos móveis do MAUI. A Microsoft "não expõe mais um caminho de Mono separado para Android, iOS ou Mac Catalyst".

## De padrão para único

A distinção importa. No Preview 4, CoreCLR era o padrão e o Mono estava a uma troca de propriedade de distância, apresentado explicitamente como um desbloqueio temporário enquanto você abria uma regressão. O Preview 6 remove essa postura de runtime duplo no mobile. Não existe mais um target de Mono suportado para as cabeças móveis do MAUI, e a propriedade de exclusão que costumava revertê-las não faz mais parte da história. Se o seu projeto ou uma dependência transitiva se apoiava em `UseMonoRuntime` para contornar uma regressão do CoreCLR, esse plano expira agora, não na GA.

Blazor WebAssembly não é afetado. WebAssembly continua rodando sobre Mono porque o CoreCLR não tem um target de Wasm, e nada disso muda isso.

```xml
<!-- Preview 4: still an option -->
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-android'">
  <UseMonoRuntime>true</UseMonoRuntime>
</PropertyGroup>

<!-- Preview 6: no separate Mono path for MAUI mobile -->
```

## Onde os números pararam

A parte honesta do anúncio do Preview 4 foi admitir regressões em aplicativos Android maiores. O Preview 6 se lê com mais calma. Ortinau relata que iOS e Mac Catalyst estão em geral mais rápidos do que estavam sobre Mono, e que o Android agora fica dentro de aproximadamente 10% do Mono tanto no tempo de inicialização quanto no tamanho do aplicativo. Isso é perto o suficiente para que a unificação do runtime, que compartilha o mesmo JIT, GC e diagnósticos do ASP.NET Core, deixe de ser uma troca que você discute e comece a ser uma base sobre a qual você constrói. Também mantém o NativeAOT para MAUI em cima da mesa como próximo passo, algo que nunca foi possível enquanto o mobile ficou sobre um runtime separado.

## O que testar antes de novembro

A GA é em novembro de 2026, e a janela de preview é exatamente quando as prioridades ainda podem mudar com base no seu feedback. Concretamente:

- Compile seu aplicativo no Preview 6 e confirme que ele carrega. As plataformas que o CoreCLR descartou mais cedo no ciclo do .NET 11 (Android x86, API 23 e inferiores, as antigas APIs de embedding do Xamarin.Android) falham em tempo de build ou de carga, não silenciosamente em produção.
- Rode uma build em Release em um dispositivo Android de baixo custo representativo e compare inicialização a frio, inicialização a quente e tamanho do pacote contra o .NET 10. O número de 10% é o agregado da Microsoft, não uma promessa sobre o seu grafo de dependências.
- Audite qualquer biblioteca de Xamarin.Android intocada há muito tempo. Se ela usar as APIs de embedding, não carregará sobre o CoreCLR e você precisa ter um substituto na fila antes de o trem da GA partir.

O runtime sobre o qual você publicar o MAUI em novembro é decidido agora. O Preview 6 é o último momento confortável para descobrir se o seu aplicativo concorda. O relatório de progresso completo e o cronograma estão no [.NET Blog](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/).
