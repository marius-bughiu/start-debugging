---
title: "Correção: MediaPicker.CapturePhotoAsync retorna um PNG em vez de um JPEG no .NET MAUI 10"
description: "No iOS, o MAUI 10 recodifica fotos da câmera como PNG sempre que CompressionQuality é 90 ou mais e nenhum MaximumWidth/Height está definido, o que inclui o padrão. Defina CompressionQuality como 89 ou menos, ou adicione um MaximumWidth apenas no iOS."
pubDate: 2026-09-27
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "ios"
  - "android"
  - "csharp"
lang: "pt-br"
translationOf: "2026/09/fix-mediapicker-capturephotoasync-returns-png-instead-of-jpeg-in-maui-10"
translatedBy: "claude"
translationDate: 2026-09-27
---

Se `MediaPicker.Default.CapturePhotoAsync()` no .NET MAUI 10 entrega a você um `3f2c9a....png` com `ContentType` `image/png`, não foi a câmera que produziu um PNG. Foi o MAUI. No iOS, o caminho da câmera entrega ao MAUI um `UIImage` decodificado, e o MAUI 10 o recodifica com `AsPNG()` sempre que `CompressionQuality` é 90 ou mais e nem `MaximumWidth` nem `MaximumHeight` estão definidos. A qualidade padrão é 100, então uma chamada sem opções sempre retorna um PNG. A correção que funciona em todas as plataformas e em todo build 10.x e 11 é `new MediaPickerOptions { CompressionQuality = 85 }` (qualquer valor de 0 a 89). Se você quer o JPEG de maior qualidade do iOS, mantenha a qualidade 100 e defina um `MaximumWidth` superdimensionado apenas no iOS. No Android e no Windows, uma qualidade de 95 a 99 também gera bytes PNG, e no Windows eles ainda mantêm um nome `.jpg`.

## O erro em contexto

Não há exceção aqui. O sintoma é um arquivo que você não pediu:

```text
// .NET 10, Microsoft.Maui.Essentials 10.0.110, iPhone, CapturePhotoAsync() with no options
FileName:    6b1e0c52-8f0d-4c1e-9a55-2f0b7d3c41aa.png
ContentType: image/png
First bytes: 89 50 4E 47 0D 0A 1A 0A
```

As buscas sobre isso costumam começar em algum ponto mais adiante no pipeline: um endpoint de upload que só aceita `image/jpeg` rejeita o arquivo com 415, um bucket de blob storage se enche de PNGs de vários megabytes, um redimensionador de imagens no servidor engasga com entrada RGBA, ou os dados EXIF que o backend esperava (horário da captura, GPS) estão ausentes. Os quatro casos levam à mesma linha de código do MAUI.

Veja o que cada chamada a `CapturePhotoAsync` retorna, com base no código-fonte do `MediaPicker` em cada tag de release:

| Opções | iOS, MAUI 10.0.0 a 10.0.51 | iOS, MAUI 10.0.60 a 10.0.110 e 11.0 RC 1/RC 2 | Android, todo 10.x e 11 RC | Windows, todo 10.x e 11 RC |
| --- | --- | --- | --- | --- |
| nenhuma (qualidade 100) | PNG | PNG | JPEG da câmera, intacto | JPEG da câmera, intacto |
| `CompressionQuality` 95 a 99 | PNG | PNG | PNG | bytes PNG com nome `.jpg` |
| `CompressionQuality` 90 a 94 | JPEG, qualidade 0,9 | PNG | JPEG, recodificado | JPEG, recodificado |
| `CompressionQuality` 0 a 89 | JPEG, qualidade q/100 | JPEG, qualidade q/100 | JPEG, recodificado | JPEG, recodificado |
| qualidade 100 + `MaximumWidth` | JPEG, qualidade 0,95 | JPEG, qualidade 0,95 | PNG | bytes PNG com nome `.jpg` |
| qualidade 95 a 99 + `MaximumWidth` | JPEG, qualidade 0,9 | JPEG, qualidade 0,9 | PNG | bytes PNG com nome `.jpg` |

Duas coisas se destacam. A única configuração que gera um JPEG em todas as colunas é uma qualidade de 89 ou menos. E a regra do iOS ficou mais rígida na 10.0.60 (SR6), então um app que usava `CompressionQuality = 90` para obter JPEGs na 10.0.51 passou a receber PNGs depois de uma atualização rotineira do MAUI.

## Por que o MAUI 10 transforma uma foto da câmera em PNG

`CapturePhotoAsync` no iOS apresenta um `UIImagePickerController` com a câmera como fonte. Uma foto recém-tirada ainda não está na biblioteca de fotos, então não existe um `PHAsset` de onde ler os bytes HEIC ou JPEG originais. O MAUI recorre à entrada `UIImagePickerController.OriginalImage`, que é um `UIImage` decodificado, e a envolve em um `CompressedUIImageFileResult` interno. Essa classe precisa escolher um formato de arquivo antes de ter qualquer nome de arquivo original para se basear, e faz isso em `ShouldUsePngFormat`:

```csharp
// .NET MAUI 10.0.110, src/Essentials/src/MediaPicker/MediaPicker.ios.cs
bool ShouldUsePngFormat()
{
    bool originalWasPng = !string.IsNullOrEmpty(originalFileName) &&
        Path.GetExtension(originalFileName).Equals(".png", StringComparison.OrdinalIgnoreCase);

    return originalWasPng || (compressionQuality >= 90 && !maximumWidth.HasValue && !maximumHeight.HasValue);
}
```

Para uma captura da câmera, `originalFileName` é `null`, então a segunda metade é a decisão inteira. `MediaPickerOptions.CompressionQuality` tem padrão 100, o que significa que "sem opções" cai em `workingImage.AsPNG()`. O nome do arquivo é um `Guid` mais `.png`, e `FileResult.ContentType` é derivado dessa extensão, então tudo mais adiante concorda que se trata de um PNG.

Isso não é tanto um comportamento novo quanto um resquício. No MAUI 9 e anteriores, o mesmo caminho da câmera usava um `UIImageFileResult` que sempre chamava `AsPNG()`, sem nenhuma opção envolvida (veja [dotnet/maui#11379](https://github.com/dotnet/maui/issues/11379), de 2022). O MAUI 10 adicionou `CompressionQuality`, `MaximumWidth`, `MaximumHeight`, `RotateImage` e `PreserveMetaData` a `MediaPickerOptions`, e manteve o PNG como a saída de "maior qualidade". Até a 10.0.51, o limite era 95. A [dotnet/maui#33119](https://github.com/dotnet/maui/issues/33119) apontou que o método calculava um limite de 90 e depois retornava um de 95, e o [PR #33140](https://github.com/dotnet/maui/pull/33140) (milestone .NET 10 SR6, lançado pela primeira vez na 10.0.60 no NuGet em 2026-04-29) fixou o valor em 90. O mesmo código está na tag `11.0.100-rc.1.26458.5` e no branch `release/11.0.1xx-rc2`.

Android e Windows seguem outro caminho. Lá a câmera grava um arquivo JPEG de verdade (`Guid.jpg` no Android, uma captura `CameraCaptureUIPhotoFormat.Jpeg` no Windows), e o MAUI só mexe nele quando `ImageProcessor.IsProcessingNeeded` é verdadeiro, ou seja, uma qualidade abaixo de 100 ou uma dimensão máxima. O `ImageProcessor.ProcessImageAsync` compartilhado então escolhe o formato com sua própria regra, `qualityPercent >= 95 || (qualityPercent >= 90 && originalWasPng)`, que ignora completamente as opções de redimensionamento. Assim, no Android uma qualidade de 97 converte o JPEG da câmera em PNG, e no iOS uma qualidade de 97 com um `MaximumWidth` não converte. Mesmo objeto de opções, formatos de arquivo diferentes. O Windows acrescenta mais uma reviravolta: seu `ProcessedImageFileResult` nomeia a saída com `ImageProcessor.DetermineOutputExtension(imageData, 75, originalFileName)`, um 75 fixo no código em vez da sua qualidade, então os bytes PNG recebem um nome `.jpg` e um content type `image/jpeg`.

## Reprodução mínima

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110, run on a physical iPhone
FileResult? photo = await MediaPicker.Default.CapturePhotoAsync();
if (photo is null) return; // user cancelled

Console.WriteLine($"{photo.FileName} | {photo.ContentType}");
// 6b1e0c52-8f0d-4c1e-9a55-2f0b7d3c41aa.png | image/png
```

O iOS Simulator não tem câmera (`IsCaptureSupported` é falso lá), então isso exige um dispositivo. Se você ainda não configurou um para um projeto MAUI, a [correção do provisioning profile para MAUI iOS](/pt-br/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) cobre o primeiro obstáculo habitual.

## Correção 1: defina CompressionQuality como 89 ou menos

Esta é a recomendação para quase todo app. É uma linha, produz um JPEG no iOS, no Android e no Windows, e se comporta da mesma forma em todo release de serviço do MAUI 10 e no MAUI 11 RC 1:

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110
FileResult? photo = await MediaPicker.Default.CapturePhotoAsync(new MediaPickerOptions
{
    CompressionQuality = 85,
});
```

No iOS, isso chama `UIImage.AsJPEG(0.85f)` na imagem com orientação normalizada. No Android e no Windows, carrega o JPEG da câmera por meio do Microsoft.Maui.Graphics e o salva novamente como JPEG com qualidade 0,85. Uma qualidade de 85 é visualmente indistinguível do original para fotos nos tamanhos de visualização de um celular e reduz bastante o tamanho do arquivo em comparação com um PNG sem perdas dos mesmos pixels. Se você também quer limitar a resolução antes do upload, adicione `MaximumWidth` e `MaximumHeight` junto. Com uma qualidade abaixo de 90, eles nunca trocam o formato em nenhuma plataforma.

Não "corrija" isso com uma qualidade de 90 a 94. Essa faixa gerava JPEG no iOS até a 10.0.51 e passou a gerar PNG na 10.0.60, que é exatamente o tipo de configuração que quebra silenciosamente na próxima atualização de workload.

## Correção 2: mantenha a qualidade máxima no iOS com um MaximumWidth superdimensionado

Se você precisa do JPEG com a menor perda que o MAUI consegue produzir, há uma peculiaridade que vale conhecer: no iOS, definir qualquer `MaximumWidth` ou `MaximumHeight` desativa o ramo PNG, e o MAUI nunca amplia a imagem (`CalculateResizedDimensions` limita a escala a 1). Com qualidade 100, isso resulta em `AsJPEG(0.95f)` na resolução completa. No Android e no Windows, as mesmas opções fariam o contrário e produziriam um PNG, e lá o JPEG intacto da câmera obtido com uma chamada simples já é o que você quer. Então separe por plataforma:

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110
using Microsoft.Maui.Devices;
using Microsoft.Maui.Media;

static MediaPickerOptions JpegCaptureOptions()
{
    if (DeviceInfo.Platform == DevicePlatform.iOS ||
        DeviceInfo.Platform == DevicePlatform.MacCatalyst)
    {
        // Any maximum dimension disables the PNG branch on iOS.
        // 16384 is larger than any iPhone sensor, so nothing is resized.
        return new MediaPickerOptions
        {
            CompressionQuality = 100, // encoded as AsJPEG(0.95f)
            MaximumWidth = 16384,
            MaximumHeight = 16384,
        };
    }

    // Android and Windows: quality 100 and no limits means MAUI returns
    // the camera's own JPEG file without re-encoding it.
    return new MediaPickerOptions();
}

FileResult? photo = await MediaPicker.Default.CapturePhotoAsync(JpegCaptureOptions());
```

Isso depende de um detalhe de implementação de `ShouldUsePngFormat`, então trate-o como um workaround e confira de novo a tabela acima quando migrar para um novo release do MAUI. A Correção 1 não tem essa dependência.

## Correção 3: pare de confiar na extensão mais adiante no fluxo

Mesmo com as opções corrigidas, um app MAUI é apenas um cliente, e no Windows o nome do arquivo pode estar errado no sentido oposto. Qualquer coisa que receba fotos deve verificar os bytes, não o nome do arquivo. JPEG começa com `FF D8 FF`, PNG com a assinatura de 8 bytes `89 50 4E 47 0D 0A 1A 0A`:

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110
using Microsoft.Maui.Storage;

static async Task<string?> DetectImageFormatAsync(FileResult file)
{
    await using var stream = await file.OpenReadAsync();
    var header = new byte[8];
    var read = await stream.ReadAtLeastAsync(header, header.Length, throwOnEndOfStream: false);

    if (read >= 3 && header[0] == 0xFF && header[1] == 0xD8 && header[2] == 0xFF)
        return "image/jpeg";

    if (read >= 8 && header.AsSpan().SequenceEqual(
            new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }))
        return "image/png";

    return null;
}
```

Use o tipo detectado ao montar o upload, para que o servidor veja um `Content-Type` honesto mesmo para fotos tiradas por uma versão mais antiga do app que ainda envia PNGs:

```csharp
// .NET 10, C# 14
static async Task UploadAsync(HttpClient http, FileResult photo)
{
    var contentType = await DetectImageFormatAsync(photo) ?? "application/octet-stream";
    var extension = contentType == "image/png" ? ".png" : ".jpg";

    await using var stream = await photo.OpenReadAsync();
    using var content = new MultipartFormDataContent();
    var file = new StreamContent(stream);
    file.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(contentType);
    content.Add(file, "photo", $"capture{extension}");

    using var response = await http.PostAsync("api/photos", content);
    response.EnsureSuccessStatusCode();
}
```

Se o servidor armazena o arquivo em blob storage ao lado de uma linha do banco de dados, o [post sobre consistência entre gravação no banco de dados e upload de blob](/pt-br/2026/09/how-to-keep-a-database-write-and-an-azure-blob-upload-consistent-in-one-request/) cobre o que fazer quando uma das duas operações falha.

Todo o C# acima compila com `Microsoft.Maui.Essentials` 10.0.110 no SDK do .NET 10.0.302. A tabela de formatos vem da leitura de `MediaPicker.ios.cs`, `MediaPicker.android.cs`, `MediaPicker.windows.cs` e `ImageProcessor.shared.cs` nas tags `10.0.0`, `10.0.51`, `10.0.60`, `10.0.110` e `11.0.100-rc.1.26458.5`, e não de uma matriz de dispositivos, então, se o seu dispositivo discordar, a tag que você está realmente usando é a primeira coisa a verificar (`dotnet list package --include-transitive | grep Maui`).

## Armadilhas que vêm junto com o PNG

**O EXIF desaparece nas capturas do iOS, não importa o que `PreserveMetaData` diga.** `CompressedUIImageFileResult` é construído apenas a partir do `UIImage`, e `PreserveMetaData` nunca é passado para ele. `AsPNG()` e `AsJPEG()` em um `UIImage` não gravam metadados da câmera, então horário da captura, GPS e dados da lente não estão no arquivo com nenhuma das correções. Se você precisa deles, leia você mesmo o dicionário `UIImagePickerController.MediaMetadata` em um picker personalizado, ou registre o horário e a localização no app quando a captura terminar. Escolher uma foto existente (`PickPhotoAsync`) passa pelo `PHPicker` e pelo asset original, que é outro caminho. A [dotnet/maui#36581](https://github.com/dotnet/maui/issues/36581) acompanha APIs de metadados adequadas para o .NET 12.

**Fotos rotacionadas viram RGBA.** Uma foto em retrato da câmera do iPhone chega como um bitmap em paisagem com `UIImageOrientation.Right`. O MAUI sempre chama `NormalizeOrientation()` antes de codificar, o que redesenha a imagem com um `UIGraphicsImageRenderer` cujo formato tem `Opaque = false`. O resultado carrega um canal alfa de que não precisa, e um PNG dele fica ainda maior. O lado bom é que os pixels já estão na orientação correta, então `RotateImage = true` não é necessário para capturas do iOS.

**O `SaveToGallery` do MAUI 11 também salva o PNG.** O MAUI 11 adiciona `MediaPickerOptions.SaveToGallery` para chamadas de captura. No iOS, ele grava o mesmo `FileResult` que o MAUI retorna para você em um arquivo temporário e o passa para `PHAssetChangeRequest.FromImage`. Com as opções padrão, isso significa que um PNG vai parar na biblioteca de fotos do usuário. Defina uma qualidade abaixo de 90 e a cópia na galeria também será um JPEG.

**`PickPhotoAsync` pode retornar PNGs por outro motivo.** Se o usuário escolhe uma captura de tela, o original realmente é um PNG, e o MAUI o mantém como PNG com qualidade 90 ou mais por design (`originalWasPng`). Isso não é este bug; detecte o formato como na Correção 3 e trate os dois casos.

**A seleção múltipla no iOS tem seu próprio problema na 10.0.100.** Se `PickPhotosAsync` lança uma exceção quando o usuário seleciona várias imagens, trata-se da [regressão de UIKitThreadAccessException em MediaPicker.PickPhotosAsync](/pt-br/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/), corrigida na 10.0.110.

## Relacionados

- [Correção: UIKitThreadAccessException em MediaPicker.PickPhotosAsync no .NET MAUI iOS](/pt-br/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/) cobre a outra regressão do MediaPicker na linha 10.0.1xx.
- [Novidades do .NET MAUI 10](/pt-br/2025/04/whats-new-in-net-maui-10/) para o restante do release em que as novas opções do picker foram lançadas.
- [Correção: o provisioning profile não inclui o dispositivo atualmente selecionado](/pt-br/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) para levar código de câmera a um iPhone real.
- [Mantendo uma gravação no banco de dados e um upload no Azure Blob consistentes em uma única requisição](/pt-br/2026/09/how-to-keep-a-database-write-and-an-azure-blob-upload-consistent-in-one-request/) para o lado do servidor de um upload de foto.

## Fontes

- [Seletor de mídia para fotos e vídeos, documentação do .NET MAUI (MS Learn)](https://learn.microsoft.com/dotnet/maui/platform-integration/device-media/picker?view=net-maui-10.0)
- [`MediaPicker.ios.cs` na tag 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Essentials/src/MediaPicker/MediaPicker.ios.cs)
- [`ImageProcessor.shared.cs` na tag 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Essentials/src/MediaPicker/ImageProcessor.shared.cs)
- [dotnet/maui#33119: MediaPicker ShouldUsePngFormat method has conflicting/redundant code](https://github.com/dotnet/maui/issues/33119)
- [dotnet/maui#33140: Refactor image rotation and PNG format logic](https://github.com/dotnet/maui/pull/33140)
- [dotnet/maui#11379: CapturePhotoAsync returns PNG in which the orientation data is lost](https://github.com/dotnet/maui/issues/11379)
- [dotnet/maui#36581: Add image metadata APIs and non-destructive MediaPicker processing](https://github.com/dotnet/maui/issues/36581)
