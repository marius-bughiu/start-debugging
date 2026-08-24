---
title: ".NET MAUI 10.0.100 adiciona UsePlatformHandler para backends customizados de BlazorWebView"
description: "O MAUI 10.0.100 traz MauiBlazorWebViewBuilderExtensions.UsePlatformHandler, um ponto de extensão suportado para substituir o BlazorWebViewHandler sem reimplementar tudo o que AddMauiBlazorWebView() registra. Duas sobrecargas e uma armadilha de ordem."
pubDate: 2026-08-24
tags:
  - "dotnet"
  - "maui"
  - "blazor"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/08/maui-10-0-100-useplatformhandler-custom-blazorwebview-backends"
translatedBy: "claude"
translationDate: 2026-08-24
---

O .NET MAUI 10.0.100 [foi publicado em 2026-08-20](https://github.com/dotnet/maui/releases/tag/10.0.100) com 209 commits, e a maior parte é o de sempre em uma versão de serviço: regressões de rolagem no `CollectionView`, insets de safe area no flyout do Shell no Android, um `ActivityIndicator` do iOS que se recusava a sumir. Escondida na lista existe uma API pública realmente nova, e ela destrava uma categoria de projeto que estava travada desde que o Blazor Hybrid saiu: `MauiBlazorWebViewBuilderExtensions.UsePlatformHandler`.

## Por que AddMauiBlazorWebView() era um beco sem saída para plataformas customizadas

`AddMauiBlazorWebView()` faz dois trabalhos. Ele registra a infraestrutura compartilhada de que todo BlazorWebView precisa (JSInterop, navegação, resolução de assets estáticos) e fixa `BlazorWebViewHandler` como o handler de `IBlazorWebView`.

O segundo trabalho era o problema. Se você estava construindo um backend para uma plataforma para a qual o MAUI não distribui handlers, sendo o caso motivador um renderizador GTK para Linux, o handler embutido simplesmente não servia e não havia ponto de extensão para trocá-lo. A [issue #34103](https://github.com/dotnet/maui/issues/34103) descreve a solução alternativa que o pessoal acabou adotando: pular `AddMauiBlazorWebView()` por completo, registrar de novo cada serviço interno na mão e depois correr atrás desses registros toda vez que eles mudam upstream.

## O novo ponto de extensão

O [PR #34225](https://github.com/dotnet/maui/pull/34225) adiciona dois métodos de extensão sobre `IMauiBlazorWebViewBuilder`:

```csharp
public static IMauiBlazorWebViewBuilder UsePlatformHandler<THandler>(
    this IMauiBlazorWebViewBuilder builder)
    where THandler : IViewHandler, new();

public static IMauiBlazorWebViewBuilder UsePlatformHandler(
    this IMauiBlazorWebViewBuilder builder,
    Func<IServiceProvider, IViewHandler> factory);
```

No `MauiProgram.cs` isso reduz toda a solução alternativa a uma única chamada encadeada:

```csharp
builder.Services
    .AddMauiBlazorWebView()
    .UsePlatformHandler<GtkBlazorWebViewHandler>();
```

Tudo o que `AddMauiBlazorWebView()` registra continua no lugar. Só o handler muda. Internamente o método encaminha para `ConfigureMauiHandlers(h => h.AddHandler<IBlazorWebView, THandler>())`, que é a mesma coleção de handlers na qual o registro embutido escreve.

Repare na restrição genérica: `where THandler : IViewHandler, new()`. O parâmetro de tipo também vem anotado com `[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicConstructors)]`, para que o trimmer preserve o construtor sem parâmetros em um build com trimming ou NativeAOT em vez de removê-lo silenciosamente. Handlers que precisam de argumentos de construtor passam pela outra sobrecarga, a de fábrica.

## A ordem é o fio da navalha

A substituição segue a regra de que o último registro vence, e isso corta dos dois lados. Chame `UsePlatformHandler` depois de `AddMauiBlazorWebView()` ou ele não faz nada. Pior ainda: se uma biblioteca a jusante chamar `AddMauiBlazorWebView()` de novo mais adiante no seu pipeline de inicialização, essa segunda chamada registra novamente o handler padrão e o seu backend some sem erro e sem aviso. Quando você compõe a configuração do MAUI Blazor a partir de várias fontes, chame `UsePlatformHandler` por último.

A sobrecarga de fábrica tem uma segunda armadilha que vale conhecer. O `IServiceProvider` que ela entrega é o provider da fábrica de handlers do MAUI, não o provider raiz da aplicação. Ele resolve os serviços registrados via `ConfigureMauiHandlers` e nada mais, então tentar buscar ali um singleton de nível de aplicação vai falhar.

As duas sobrecargas estão ausentes no `Microsoft.AspNetCore.Components.WebView.Maui` 10.0.90 e presentes no 10.0.100, ou seja, é uma entrada direta do 10.0.100 e não algo retroportado silenciosamente. Se você acompanha o trem de versões de serviço do .NET MAUI 10, o [rollout do Material 3 no Android foi concluído no SR6](/pt-br/2026/05/maui-10-material-3-android-usematerial3-flag/).
