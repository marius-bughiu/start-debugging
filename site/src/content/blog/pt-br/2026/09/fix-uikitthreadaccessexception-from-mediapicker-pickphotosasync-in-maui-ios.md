---
title: "Correção: UIKitThreadAccessException em MediaPicker.PickPhotosAsync ao selecionar várias fotos no .NET MAUI iOS"
description: "Selecionar 2 ou mais fotos no iOS lança UIKitThreadAccessException no MAUI 10.0.100 e 10.0.101. O MAUI lê PHPickerResult.ItemProvider depois de um await, fora da thread principal. Fixe 10.0.90, atualize para 10.0.110 ou use um PHPicker próprio."
pubDate: 2026-09-16
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "ios"
  - "csharp"
  - "async"
lang: "pt-br"
translationOf: "2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios"
translatedBy: "claude"
translationDate: 2026-09-16
---

Se `MediaPicker.PickPhotosAsync` lança `UIKit.UIKitThreadAccessException` no iOS sempre que o usuário seleciona 2 ou mais itens, você esbarrou em uma regressão do .NET MAUI introduzida na 10.0.100. O MAUI lê `PHPickerResult.ItemProvider`, uma propriedade protegida pelo UIKit, dentro de um laço que aguarda com `ConfigureAwait(false)`, então toda iteração depois da primeira roda em uma thread do pool. Nada que você faça no ponto de chamada resolve. Fixe `<MauiVersion>10.0.90</MauiVersion>`, vá para 10.0.110 (SR11) ou MAUI 11.0.0-rc.2 quando forem lançados, ou chame `PHPickerViewController` você mesmo e leia os item providers antes do primeiro await. Selecionar exatamente uma foto sempre funciona, e é por isso que o problema parece intermitente até você perceber o padrão.

## O erro em contexto

```text
UIKit.UIKitThreadAccessException: UIKit Consistency error: you are calling a UIKit method that can only be invoked from the UI thread.
   at UIKit.UIApplication.EnsureUIThread()
   at PhotosUI.PHPickerResult.get_ItemProvider()
   at Microsoft.Maui.Media.MediaPickerImplementation.PickerResultsToMediaFiles(PHPickerResult[] results, MediaPickerOptions options)
   at Microsoft.Maui.Media.MediaPickerImplementation.CompletePickerResultsAsync(PHPickerResult[] results, MediaPickerOptions options, TaskCompletionSource`1 tcs)
```

Versões afetadas, conferidas nos branches de release do `dotnet/maui`:

| Versão do MAUI | Lançada | `PickPhotosAsync` com 2+ itens |
| --- | --- | --- |
| 10.0.90 (SR9) | 2026-07-22 | funciona |
| 10.0.100 (SR10) | 2026-08-20 | lança exceção |
| 10.0.101 | 2026-09-07 | lança exceção |
| 11.0.0-rc.1 | 2026-09-08 | lança exceção |
| 10.0.110 (SR11) | não lançada | corrigido |
| 11.0.0-rc.2 | não lançada | corrigido |

`PickPhotosAsync` e `PickVideosAsync` são novos no .NET MAUI 10 ([dotnet/maui#6903](https://github.com/dotnet/maui/issues/6903)), então não existe uma versão maior anterior para onde voltar. Android e Windows não são afetados: o código quebrado está só em `MediaPicker.ios.cs`.

## Por que isso acontece

`PickPhotosAsync` no iOS apresenta um `PHPickerViewController`. Quando o usuário confirma, o `PhotoPickerDelegate.DidFinishPicking` do MAUI fecha o controller e invoca o handler de conclusão a partir do callback de fechamento, que roda na thread principal. Esse handler chama `PickerResultsToMediaFiles`, e na 10.0.100 esse método era assim:

```csharp
// .NET MAUI 10.0.100 and 10.0.101, src/Essentials/src/MediaPicker/MediaPicker.ios.cs
var fileResults = new List<FileResult>(results.Length);
PHPickerFileResult fileResult = null;

foreach (var file in results)
{
    fileResult = new PHPickerFileResult(file.ItemProvider);   // UIKit call
    await fileResult.LoadFileRepresentationAsync().ConfigureAwait(false);
    fileResults.Add(fileResult);
    fileResult = null;
}
```

`PHPickerResult.ItemProvider` é vinculado com uma guarda `UIApplication.EnsureUIThread()`. A primeira iteração funciona, porque o callback do delegate nos deixou na thread principal. Em seguida `LoadFileRepresentationAsync` é aguardado com `ConfigureAwait(false)`, que descarta o contexto capturado, e a segunda iteração lê `file.ItemProvider` na thread onde a continuação caiu.

O que torna isso determinístico em vez de uma condição de corrida está dentro de `PHPickerFileResult`:

```csharp
// .NET MAUI 10.0.100, PHPickerFileResult.LoadFileRepresentationAsync
loadTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
```

`RunContinuationsAsynchronously` significa que a continuação nunca é executada inline pela thread que completa o `TaskCompletionSource`. Combinado com `ConfigureAwait(false)`, não há caminho de volta para a thread principal, então a segunda leitura sempre acontece no pool. Por isso a falha é perfeitamente reproduzível: 1 item sempre funciona, 2 ou mais sempre falham. Se você já caçou bugs assíncronos instáveis, este é o caso oposto, e vale entender [o que o ConfigureAwait(false) realmente descarta](/pt-br/2026/05/configureawait-false-vs-default-in-dotnet-11/) antes de procurar uma condição de corrida que não existe.

Isto é uma regressão do [dotnet/maui#35805](https://github.com/dotnet/maui/pull/35805) (".NET 10 SR10"), que corrigiu o `FullPath` vindo vazio para resultados do PHPicker. Antes daquele PR, todos os providers eram materializados de uma vez:

```csharp
// .NET MAUI 10.0.90 and earlier
var fileResults = results?
    .Select(file => (FileResult)new PHPickerFileResult(file.ItemProvider))
    .ToList() ?? [];
```

Cada `ItemProvider` era lido antes do primeiro `await`, então a guarda do UIKit nunca via uma thread do pool. Trocar isso por um laço com um `await` dentro foi o que quebrou. O bug está registrado como [dotnet/maui#37878](https://github.com/dotnet/maui/issues/37878), com o rótulo `regressed-in-10.0.100` e marco .NET 10 SR11.

## Reprodução mínima

```csharp
// .NET MAUI 10.0.100, net10.0-ios, iOS 26.4 simulator
private async void OnPickClicked(object sender, EventArgs e)
{
    try
    {
        var files = await MediaPicker.Default.PickPhotosAsync(new MediaPickerOptions
        {
            SelectionLimit = 5
        });

        StatusLabel.Text = $"Picked {files.Count}";
    }
    catch (Exception ex)
    {
        StatusLabel.Text = ex.ToString();   // UIKitThreadAccessException with 2+ items
    }
}
```

Em um simulador, popule a galeria primeiro ou o seletor abre vazio:

```bash
xcrun simctl addmedia booted photo1.png photo2.png photo3.png
```

Selecione uma foto: você recebe um `FileResult`. Selecione duas: você recebe a exceção. Note que o handler `async void` aqui só é aceitável porque todos os caminhos estão dentro de um `try`, que é o único formato em que [async void se justifica](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

## Correção 1: atualizar para além da regressão

A correção é [dotnet/maui#37879](https://github.com/dotnet/maui/pull/37879), integrada em 2026-08-27, retroportada para `release/10.0.1xx-sr11` como [#38481](https://github.com/dotnet/maui/pull/38481) e levada para `main` como [#38488](https://github.com/dotnet/maui/pull/38488), ambas em 2026-09-12. O código publicado agora lê todos os providers antes do primeiro await:

```csharp
// .NET MAUI 10.0.110 and 11.0.0-rc.2, MediaPicker.ios.cs
// PHPickerResult.ItemProvider is a UIKit call and must be read on the main thread.
var pickerResults = new List<PHPickerFileResult>(results.Length);
foreach (var file in results)
{
    pickerResults.Add(new PHPickerFileResult(file.ItemProvider));
}

var fileResults = new List<FileResult>(pickerResults.Count);
foreach (var pickerResult in pickerResults)
{
    await pickerResult.LoadFileRepresentationAsync().ConfigureAwait(false);
    fileResults.Add(pickerResult);
}
```

`NSItemProvider` é um tipo do Foundation sem guarda de thread de UI, então segurar os providers atravessando os awaits é seguro. O mesmo PR também fechou um vazamento de memória no caminho de erro: os resultados construídos depois da iteração que falhava ficavam sem ser descartados.

Em 2026-09-16, nem 10.0.110 nem 11.0.0-rc.2 estão no NuGet. Quando a 10.0.110 sair, é uma mudança de uma linha:

```xml
<!-- Directory.Build.props or the app .csproj -->
<PropertyGroup>
  <MauiVersion>10.0.110</MauiVersion>
</PropertyGroup>
```

## Correção 2: fixar de volta na 10.0.90

Até a SR11 chegar, fixar é a opção de menor risco se você não depende de mais nada que saiu na SR10:

```xml
<!-- app .csproj, .NET 10 SDK -->
<PropertyGroup>
  <MauiVersion>10.0.90</MauiVersion>
</PropertyGroup>
```

O custo é que você também abre mão do [dotnet/maui#35805](https://github.com/dotnet/maui/pull/35805), a correção do `FullPath`. Na 10.0.90, um `FileResult` vindo do caminho do PHPicker pode voltar com um caminho onde nenhum arquivo existe, então `File.Copy(result.FullPath, ...)` falha e você precisa passar por `await result.OpenReadAsync()`. Se o seu código de upload já usa streams em vez de copiar por caminho, você não vai perceber.

## Correção 3: chamar o PHPicker você mesmo

Se você não pode mudar de versão, substitua o caminho de seleção múltipla do iOS por umas sessenta linhas de interop. Todo o truque é ler cada `ItemProvider` dentro de `DidFinishPicking`, antes que algo aguarde.

```csharp
// .NET MAUI 10.0.100, net10.0-ios only
using Foundation;
using Microsoft.Maui.ApplicationModel;
using Microsoft.Maui.Storage;
using PhotosUI;
using UIKit;

sealed class PhotoPicker
{
    public static Task<List<string>> PickPhotosAsync(int selectionLimit)
    {
        var tcs = new TaskCompletionSource<List<string>>();

        var config = new PHPickerConfiguration
        {
            Filter = PHPickerFilter.ImagesFilter,
            SelectionLimit = selectionLimit
        };

        var picker = new PHPickerViewController(config)
        {
            Delegate = new PickerDelegate(tcs)
        };

        var vc = WindowStateManager.Default.GetCurrentUIViewController(true);
        vc.PresentViewController(picker, true, null);

        return tcs.Task;
    }

    sealed class PickerDelegate : PHPickerViewControllerDelegate
    {
        readonly TaskCompletionSource<List<string>> _tcs;

        public PickerDelegate(TaskCompletionSource<List<string>> tcs) => _tcs = tcs;

        public override void DidFinishPicking(PHPickerViewController picker, PHPickerResult[] results)
        {
            // Main thread. Read every provider now, before any await can move us off it.
            var providers = new List<NSItemProvider>(results.Length);
            foreach (var result in results)
            {
                providers.Add(result.ItemProvider);
            }

            picker.DismissViewController(true, () => _ = LoadAllAsync(providers));
        }

        async Task LoadAllAsync(List<NSItemProvider> providers)
        {
            try
            {
                var paths = new List<string>(providers.Count);
                foreach (var provider in providers)
                {
                    var identifier = provider.RegisteredTypeIdentifiers?.FirstOrDefault();
                    if (string.IsNullOrEmpty(identifier))
                    {
                        continue;
                    }

                    paths.Add(await CopyToCacheAsync(provider, identifier).ConfigureAwait(false));
                }

                _tcs.TrySetResult(paths);
            }
            catch (Exception ex)
            {
                _tcs.TrySetException(ex);
            }
        }

        static Task<string> CopyToCacheAsync(NSItemProvider provider, string identifier)
        {
            var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);

            provider.LoadFileRepresentation(identifier, (url, error) =>
            {
                if (error is not null)
                {
                    tcs.TrySetException(new NSErrorException(error));
                    return;
                }

                try
                {
                    // The URL is only valid inside this callback, so copy synchronously.
                    var destination = Path.Combine(
                        FileSystem.CacheDirectory,
                        Guid.NewGuid().ToString("n") + Path.GetExtension(url.Path));

                    File.Copy(url.Path, destination, overwrite: true);
                    tcs.TrySetResult(destination);
                }
                catch (Exception ex)
                {
                    tcs.TrySetException(ex);
                }
            });

            return tcs.Task;
        }
    }
}
```

Dois detalhes importam. O `NSUrl` entregue ao callback de `LoadFileRepresentation` aponta para um arquivo que o sistema apaga assim que o callback retorna, então a cópia precisa ser síncrona e dentro do callback. E `PickerDelegate` precisa continuar alcançável; atribuir à propriedade tipada `Delegate` mantém uma referência gerenciada, mas se você trocar para `WeakDelegate` tem que segurar a instância você mesmo, ou ela é coletada no meio da seleção.

O que você perde é tudo o que `MediaPickerOptions` faz depois da seleção: `CompressionQuality`, `MaximumWidth`, `MaximumHeight`, `RotateImage` e `PreserveMetaData` são aplicados pela passagem de pós-processamento do próprio MAUI, não pelo seletor. Se você precisa deles, redimensione com `SkiaSharp` ou `Microsoft.Maui.Graphics` depois de copiar.

## Correção 4: usar o FilePicker

`FilePicker.PickMultipleAsync` passa por `UIDocumentPickerViewController` e `NSUrl[]`, sem nunca tocar em `PHPickerResult`, então não é afetado:

```csharp
// .NET MAUI 10.0.100, cross-platform
var files = await FilePicker.Default.PickMultipleAsync(new PickOptions
{
    PickerTitle = "Select images",
    FileTypes = FilePickerFileType.Images
});
```

É uma experiência diferente: o app Arquivos em vez da grade de Fotos, sem pedido de permissão de Fotos e sem tratamento de live photos ou HEIC. É um paliativo razoável para fluxos de "anexar algumas imagens" e ruim para qualquer coisa centrada no rolo da câmera.

## Detalhes e casos parecidos

**Uma build Release faz a exceção sumir, e isso não é uma correção.** `EnsureUIThread` depende de `ObjCRuntime.Runtime.CheckForIllegalCrossThreadCalls`, que a substituição do ILLink desliga em builds Release. O acesso ao UIKit fora da thread continua acontecendo; você só perde o diagnóstico. Testar em Release e declarar vitória é como isso chega à App Store como um crash intermitente em vez de uma exceção determinística.

**Não use `UIApplication.CheckForIllegalCrossThreadCalls = false`.** Isso silencia todas as asserções de thread de UI do seu app, não só esta, e o acesso subjacente é genuinamente inseguro.

**Envolver a chamada em `MainThread.InvokeOnMainThreadAsync` não adianta nada.** A thread se perde dentro do MAUI, depois que o delegate do seletor retorna, e o `ConfigureAwait(false)` de lá descarta explicitamente qualquer contexto que você tenha estabelecido no ponto de chamada. Ajustes de thread do lado do chamador não alcançam isso, do mesmo jeito que não alcançam [um deadlock causado por bloquear com .Result mais abaixo na pilha](/pt-br/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

**`PickVideosAsync` é afetado de forma idêntica.** Ele passa pelo mesmo helper `PhotosAsync` e pelo mesmo `PickerResultsToMediaFiles`. Se a sua reprodução usa vídeos em vez de fotos, é o mesmo bug.

**`PickPhotoAsync` (no singular) está ok.** Ele compartilha o caminho de código, mas produz exatamente um `PHPickerResult`, então o laço nunca chega a uma segunda leitura. Se você vê `UIKitThreadAccessException` em uma seleção única, o problema é outro, normalmente a sua própria continuação tocando um controle fora da thread principal.

**`SelectionLimit = 1` em `PickPhotosAsync` também é seguro.** É uma solução alternativa apenas no sentido de que remove a seleção múltipla, que é o recurso pelo qual você chamou essa API.

**Não é o mesmo que [dotnet/maui#33954](https://github.com/dotnet/maui/issues/33954).** Aquele, corrigido na SR6, era `PickPhotosAsync` devolvendo menos imagens do que as selecionadas quando `CompressionQuality` estava definido. Sintoma diferente, sem exceção, e já publicado.

**ANRs no Android são outra classe de bug de threads no MAUI.** Se o seu app MAUI também bloqueia a thread de UI no Android, isso aparece como um ANR em vez de uma exceção, e o diagnóstico é completamente diferente: veja [como achar os handlers async void que causam ANRs em um app .NET MAUI Android](/pt-br/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/).

## Relacionado

- [ConfigureAwait(false) vs. o padrão no .NET 11: ainda importa?](/pt-br/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [async void vs. async Task em C#: quando cada um está certo](/pt-br/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [Correção: deadlock ao chamar .Result ou .Wait() em um método assíncrono em C#](/pt-br/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [Como achar os handlers async void que causam ANRs em um app .NET MAUI Android](/pt-br/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/)
- [Correção: o provisioning profile não inclui o dispositivo selecionado no MAUI iOS](/pt-br/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/)

## Fontes

- [dotnet/maui#37878 - MediaPicker.PickPhotosAsync lança UIKitThreadAccessException quando 2 ou mais itens são selecionados](https://github.com/dotnet/maui/issues/37878)
- [dotnet/maui#37879 - a correção](https://github.com/dotnet/maui/pull/37879), retroportada como [#38481](https://github.com/dotnet/maui/pull/38481) e [#38488](https://github.com/dotnet/maui/pull/38488)
- [dotnet/maui#35805 - a mudança da SR10 que introduziu a regressão](https://github.com/dotnet/maui/pull/35805)
- [dotnet/macios - Runtime.EnsureUIThread e CheckForIllegalCrossThreadCalls](https://github.com/dotnet/macios/blob/main/src/ObjCRuntime/Runtime.cs)
- [Documentação para desenvolvedores da Apple - PHPickerViewController](https://developer.apple.com/documentation/photokit/phpickerviewcontroller)
- [Microsoft Learn - Seletor de mídia no .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/device-media/picker)
