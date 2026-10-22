---
title: "MAUI 10.0.120: o BlazorWebView finalmente aceita soltar arquivos no Windows e arrastar imagens no Android"
description: "O .NET MAUI 10.0.120 ativa AllowDrop no BlazorWebView do Windows e registra o DropDataContentProvider do AndroidX no Android, então as áreas de soltar do Blazor Hybrid funcionam sem código de plataforma. Veja o que mudou, a nova chave MauiEnableAndroidWebViewDragDrop e o aviso MAUI1002."
pubDate: 2026-10-22
tags:
  - "maui"
  - "blazor"
  - "blazor-hybrid"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/10/maui-10-0-120-blazorwebview-accepts-file-drops-on-windows-and-image-drags-on-android"
translatedBy: "claude"
translationDate: 2026-10-22
---

O [.NET MAUI 10.0.120](https://github.com/dotnet/maui/releases/tag/10.0.120) foi lançado em 21 de outubro de 2026 com 213 commits. A maior parte são correções, mas duas mudanças no BlazorWebView eliminam uma gambiarra que todo app Blazor Hybrid com uma caixa "solte seus arquivos aqui" carrega desde o .NET 6: arrastar um arquivo do Explorer para um `BlazorWebView` no Windows agora chega ao seu alvo de soltar em HTML, e arrastar imagens dentro de um `BlazorWebView` no Android agora gera dados de arrasto reais.

## Windows: AllowDrop agora vem ativado por padrão

Até agora, o handler do Windows criava o `WebView2` do WinUI com `AllowDrop` em `false`. O DOM nunca via um evento `drop` para arquivos vindos de fora do app, então uma área de soltar do Blazor que funcionava no navegador simplesmente não fazia nada na versão desktop. A correção habitual era um mapeamento de handler personalizado. O [PR #37904](https://github.com/dotnet/maui/pull/37904) altera `BlazorWebViewHandler.CreatePlatformView` para isto:

```csharp
protected override WebView2Control CreatePlatformView()
{
    return new WebView2Control
    {
        AllowDrop = true,
    };
}
```

Isso significa que um `InputFile` simples esticado sobre uma área de soltar agora funciona no Windows sem nenhum código de plataforma:

```razor
<div class="dropzone">
    <InputFile OnChange="OnFilesDropped" multiple />
    <p>Drop files here</p>
</div>

@code {
    async Task OnFilesDropped(InputFileChangeEventArgs e)
    {
        foreach (var file in e.GetMultipleFiles(maxAllowedFiles: 10))
        {
            await using var stream = file.OpenReadStream(maxAllowedSize: 20 * 1024 * 1024);
            // save or process the stream
        }
    }
}
```

Se você escreveu um mapper que definia `AllowDrop = true` por conta própria, pode removê-lo depois de atualizar. Uma limitação continua: o arrastar nativo de elementos e imagens dentro da página no Windows ainda não funciona com a dependência atual do MAUI, o Windows App SDK 1.8. O autor do PR testou o Windows App SDK 2.0.1 e descobriu que esses cenários passam a funcionar nele assim que `AllowDrop` está ativado, então essa configuração também prepara o terreno para essa migração.

## Android: o DropDataContentProvider é registrado para você

No Android, arrastar um `<img>` em um `BlazorWebView` disparava eventos de arrasto do DOM, mas não carregava dados de imagem utilizáveis. O WebView do Android precisa que o `DropDataContentProvider` do AndroidX WebKit esteja declarado no manifesto para isso. O [PR #37975](https://github.com/dotnet/maui/pull/37975) faz `Microsoft.AspNetCore.Components.WebView.Maui` depender de `Xamarin.AndroidX.WebKit` 1.16.0.1 nos alvos Android e mescla esse provider no seu manifesto por meio de um `AndroidManifestOverlay`:

```xml
<provider
  android:name="androidx.webkit.DropDataContentProvider"
  android:authorities="${applicationId}.DropDataProvider"
  android:exported="false"
  android:grantUriPermissions="true" />
```

Se o seu app já declara o mesmo provider, as duas entradas se mesclam em uma só. Se você o declara com uma configuração diferente, desative o registro automático:

```xml
<PropertyGroup>
  <MauiEnableAndroidWebViewDragDrop>false</MauiEnableAndroidWebViewDragDrop>
</PropertyGroup>
```

Essa propriedade controla apenas a entrada no manifesto. A referência de pacote `Xamarin.AndroidX.WebKit` permanece de qualquer forma.

## Atenção ao MAUI1002

Projetos que ainda definem `<AndroidManifestMerger>legacy</AndroidManifestMerger>` agora verão o aviso `MAUI1002`, porque o merger legado ignora itens `AndroidManifestOverlay` e o provider nunca chega ao manifesto. Mude para `manifestmerger.jar` (o padrão) ou defina `MauiEnableAndroidWebViewDragDrop` como `false` e declare o provider você mesmo em `Platforms/Android/AndroidManifest.xml`. Se você compila tratando avisos como erros, esta é a única linha no 10.0.120 que pode quebrar o seu CI.

## Atualizando

Atualize `Microsoft.Maui.Controls` e `Microsoft.AspNetCore.Components.WebView.Maui` para `10.0.120`, ambos já no NuGet. A mesma versão também continua a limpeza de vazamentos que cobri no [post sobre o 10.0.110](/pt-br/2026/10/maui-10-0-110-fixes-six-leaks-found-by-an-agentic-leak-hunter/), incluindo um vazamento do `BlazorWebView` no iOS em que `DisconnectHandlers()` nunca alcançava páginas dentro de um `Shell`.
