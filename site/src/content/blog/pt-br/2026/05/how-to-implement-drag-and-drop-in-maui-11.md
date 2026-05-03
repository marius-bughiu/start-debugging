---
title: "Como implementar arrastar e soltar no .NET MAUI 11"
description: "Arrastar e soltar de ponta a ponta no .NET MAUI 11: DragGestureRecognizer, DropGestureRecognizer, payloads personalizados de DataPackage, AcceptedOperation, posição do gesto e as armadilhas de PlatformArgs por plataforma no Android, iOS, Mac Catalyst e Windows."
pubDate: 2026-05-03
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "drag-and-drop"
  - "gestures"
  - "how-to"
lang: "pt-br"
translationOf: "2026/05/how-to-implement-drag-and-drop-in-maui-11"
translatedBy: "claude"
translationDate: 2026-05-03
---

Resposta curta: no .NET MAUI 11, anexe um `DragGestureRecognizer` ao `View` de origem e um `DropGestureRecognizer` ao `View` de destino através da coleção `GestureRecognizers` deles. Para texto e imagens em controles internos (`Label`, `Entry`, `Image`, `Button` e similares), o framework conecta o `DataPackage` para você, então o valor solto chega automaticamente. Para qualquer outra coisa, popule `e.Data` no manipulador de `DragStarting` e leia de `e.Data` (um `DataPackageView`) no manipulador de `Drop`. Defina `e.AcceptedOperation = DataPackageOperation.Copy` ou `None` em `DragOver` para controlar o cursor, e desça até `e.PlatformArgs` quando precisar de uma prévia de arrasto personalizada, uma operação Move ou ler arquivos soltos a partir de outro aplicativo.

Este post percorre toda a superfície da API com XAML e C# executáveis para .NET MAUI 11.0.0 sobre .NET 11, incluindo as partes que a documentação oficial passa por cima: como o `DataPackagePropertySet` realmente move objetos gerenciados, por que sua operação Move é silenciosamente rebaixada para Copy no Android, por que sua forma personalizada é `null` no segundo arrasto e como ler um caminho de arquivo quando o drop vem do Explorador de Arquivos ou do Photos. Tudo abaixo foi verificado contra `dotnet new maui` do SDK do .NET 11 com `Microsoft.Maui.Controls` 11.0.0.

## Por que arrastar e soltar no MAUI é mais interessante do que parece

Os dois reconhecedores de gestos, `DragGestureRecognizer` e `DropGestureRecognizer`, foram herdados do Xamarin.Forms 5 e estão na caixa desde a primeiríssima release do MAUI. A forma da API não mudou no MAUI 11, mas a história específica de cada plataforma melhorou de forma significativa: as propriedades `PlatformArgs` que chegaram no MAUI 9 agora estão estáveis nas quatro cabeças suportadas, o que significa que você finalmente pode fazer coisas como prévias de arrasto personalizadas no iOS, drops de múltiplos arquivos a partir do Explorador de Arquivos do Windows e `UIDropOperation.Move` no Mac Catalyst sem cair em um handler personalizado.

A coisa para internalizar antes de escrever qualquer código: os reconhecedores de gestos são a abstração do MAUI sobre quatro sistemas nativos muito diferentes. O Android usa `View.startDragAndDrop` com `ClipData`, iOS e Mac Catalyst usam `UIDragInteraction` e `NSItemProvider`, o Windows usa a infraestrutura WinRT `DragDrop` em `FrameworkElement`. O `DataPackage` multiplataforma carrega texto, uma imagem e um saco de propriedades `Dictionary<string, object>`. Qualquer coisa que você coloque nesse saco de propriedades é **local ao processo**, porque os sistemas nativos subjacentes só conseguem serializar texto, imagens e URIs de arquivo entre fronteiras de aplicativos. Essa é a maior fonte de surpresa quando desenvolvedores migram de arrasto dentro do app para arrasto entre apps.

Se você vem do Xamarin.Forms, nenhum dos seus manipuladores existentes precisa mudar. Os nomes de classe, as assinaturas de evento e o enum `DataPackageOperation` são byte-idênticos. A história de `PlatformArgs` é nova; o resto é o mesmo código que foi entregue em 2020.

## Arrastar um Label de texto e soltar em um Entry

Comece com a coisa útil mais simples: arrastar um valor de texto de um `Label` e soltar em um `Entry`. Como ambos são controles de texto integrados, o MAUI popula o `DataPackage` e lê de volta automaticamente, então o recurso inteiro é XAML.

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<VerticalStackLayout Padding="20" Spacing="20">
    <Label Text="Drag this label"
           FontSize="20">
        <Label.GestureRecognizers>
            <DragGestureRecognizer />
        </Label.GestureRecognizers>
    </Label>

    <Entry Placeholder="Drop here">
        <Entry.GestureRecognizers>
            <DropGestureRecognizer />
        </Entry.GestureRecognizers>
    </Entry>
</VerticalStackLayout>
```

Um gesto de arrasto é iniciado com um long-press seguido de um arrasto em plataformas de toque, e com um mouse-down-and-move normal no Windows e Mac Catalyst. Não é necessário código no code-behind: o MAUI lê `Label.Text` para `DataPackage.Text` na saída, e escreve `DataPackage.Text` em `Entry.Text` na entrada.

A mesma fiação automática cobre `CheckBox.IsChecked`, `DatePicker.Date`, `Editor.Text`, `RadioButton.IsChecked`, `Switch.IsToggled` e `TimePicker.Time` tanto do lado da origem quanto do destino, além de imagens em `Button`, `Image` e `ImageButton`. Os booleanos e datas são convertidos via round-trip por `string`, o que significa que um drop malformado (arrastar o texto "yes" para um `CheckBox`) falha silenciosamente em alternar `IsChecked`.

## Mover um cartão entre duas colunas

O caso interessante é a sua própria interface: um quadro com cartões que você quer arrastar entre colunas. O `DataPackage` não consegue carregar um objeto gerenciado entre processos, mas para arrasto dentro do app ele absolutamente consegue carregar um através de `Properties`.

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<Grid ColumnDefinitions="*,*" Padding="20" ColumnSpacing="20">
    <VerticalStackLayout x:Name="TodoColumn" Grid.Column="0" Spacing="8">
        <VerticalStackLayout.GestureRecognizers>
            <DropGestureRecognizer DragOver="OnDragOver" Drop="OnDrop" />
        </VerticalStackLayout.GestureRecognizers>
        <Label Text="To do" FontAttributes="Bold" />
    </VerticalStackLayout>

    <VerticalStackLayout x:Name="DoneColumn" Grid.Column="1" Spacing="8">
        <VerticalStackLayout.GestureRecognizers>
            <DropGestureRecognizer DragOver="OnDragOver" Drop="OnDrop" />
        </VerticalStackLayout.GestureRecognizers>
        <Label Text="Done" FontAttributes="Bold" />
    </VerticalStackLayout>
</Grid>
```

Cada cartão é construído em código e recebe seu próprio `DragGestureRecognizer`:

```csharp
// .NET MAUI 11.0.0, .NET 11
public record Card(Guid Id, string Title);

Border BuildCardView(Card card)
{
    var border = new Border
    {
        Padding = 12,
        StrokeThickness = 1,
        BindingContext = card,
        Content = new Label { Text = card.Title }
    };

    var drag = new DragGestureRecognizer();
    drag.DragStarting += (s, e) =>
    {
        e.Data.Properties["Card"] = card;
        e.Data.Text = card.Title; // fallback for inter-app drops
    };
    border.GestureRecognizers.Add(drag);

    return border;
}
```

O evento `DragStarting` recebe um `DragStartingEventArgs` cuja propriedade `Data` é um `DataPackage` novo por arrasto. Definir `e.Data.Properties["Card"]` armazena a referência real do `Card` em um `Dictionary<string, object>`. Do lado do drop você acessa o mesmo dicionário:

```csharp
// .NET MAUI 11.0.0, .NET 11
void OnDragOver(object sender, DragEventArgs e)
{
    e.AcceptedOperation = e.Data.Properties.ContainsKey("Card")
        ? DataPackageOperation.Copy
        : DataPackageOperation.None;
}

void OnDrop(object sender, DropEventArgs e)
{
    if (e.Data.Properties.TryGetValue("Card", out var value) && value is Card card)
    {
        var targetColumn = (VerticalStackLayout)sender;
        MoveCard(card, targetColumn);
        e.Handled = true;
    }
}
```

Duas coisas não óbvias estão acontecendo aqui.

Primeiro, `e.Data` em um `DropEventArgs` é um `DataPackageView`, não um `DataPackage`. É intencionalmente somente leitura: o destino do drop não pode mutar o pacote. Você lê `Properties` (um `DataPackagePropertySetView`) e chama `await e.Data.GetTextAsync()` ou `await e.Data.GetImageAsync()` para os slots fixos de texto e imagem. Os métodos assíncronos retornam `Task<string?>` e `Task<ImageSource?>` respectivamente.

Segundo, definir `e.Handled = true` no manipulador de `Drop` diz ao MAUI para não aplicar seu comportamento padrão. Isso importa quando seu destino de drop é um `Label` ou `Image`, porque caso contrário o MAUI *também* tentará definir o texto ou a imagem a partir do data package por cima do que você fez manualmente, levando a um bug de dupla atualização doloroso de rastrear.

## Escolher o `AcceptedOperation` certo

O evento `DragOver` dispara continuamente enquanto o ponteiro está sobre um destino de drop. Sua função é definir `e.AcceptedOperation`, que determina o visual do cursor no Windows e Mac Catalyst e o feedback do sistema no iOS. O enum `DataPackageOperation` tem exatamente dois valores que vêm com o MAUI: `Copy` e `None`. Não há `Move`, não há `Link`, não há combinações de flags, independentemente do que o IntelliSense sugerir se você referenciou `Windows.ApplicationModel.DataTransfer`.

```csharp
// .NET MAUI 11.0.0, .NET 11
void OnDragOver(object sender, DragEventArgs e)
{
    var canAccept = e.Data.Properties.ContainsKey("Card");
    e.AcceptedOperation = canAccept
        ? DataPackageOperation.Copy
        : DataPackageOperation.None;
}
```

Quando um `DragEventArgs` é construído, `AcceptedOperation` assume `Copy` por padrão. Se você quer uma coluna que rejeite todos os drops (por exemplo, uma coluna "Arquivo" somente leitura quando estiver em modo visualização), você tem que defini-la ativamente como `None` em `DragOver`. Esquecer isso é a razão mais comum de um destino acidentalmente aceitar tudo.

Para conseguir uma semântica Move no iOS e Mac Catalyst, onde o sistema realmente distingue Copy de Move com um badge visível, desça para `PlatformArgs`:

```csharp
// .NET MAUI 11.0.0, .NET 11, iOS / Mac Catalyst
void OnDragOver(object sender, DragEventArgs e)
{
#if IOS || MACCATALYST
    e.PlatformArgs?.SetDropProposal(
        new UIKit.UIDropProposal(UIKit.UIDropOperation.Move));
#endif
}
```

No Android, arrastar e soltar não tem distinção Copy versus Move na camada entre apps, então a propriedade `AcceptedOperation` controla apenas a indicação visual dentro do app. No Windows, o cursor `Copy` versus `None` é dirigido diretamente por `AcceptedOperation`.

## Personalizar a prévia do arrasto

A prévia de arrasto padrão é uma captura da view de origem, o que normalmente é suficiente. Quando não é, cada plataforma expõe seu próprio gancho de prévia através de `PlatformArgs`.

```csharp
// .NET MAUI 11.0.0, .NET 11
void OnDragStarting(object sender, DragStartingEventArgs e)
{
#if IOS || MACCATALYST
    e.PlatformArgs?.SetPreviewProvider(() =>
    {
        var image = UIKit.UIImage.FromFile("dotnet_bot.png");
        var imageView = new UIKit.UIImageView(image)
        {
            Frame = new CoreGraphics.CGRect(0, 0, 200, 200),
            ContentMode = UIKit.UIViewContentMode.ScaleAspectFit
        };
        return new UIKit.UIDragPreview(imageView);
    });
#elif ANDROID
    var view = (Android.Views.View)((Microsoft.Maui.Controls.View)sender).Handler!.PlatformView!;
    e.PlatformArgs?.SetDragShadowBuilder(new Android.Views.View.DragShadowBuilder(view));
#endif
}
```

No Android, `SetDragShadowBuilder` controla a sombra que segue o dedo; no iOS e Mac Catalyst, `SetPreviewProvider` retorna um `UIDragPreview`; no Windows, defina as propriedades de `e.PlatformArgs.DragStartingEventArgs.DragUI` e lembre-se de definir `e.PlatformArgs.Handled = true` para que o MAUI não sobrescreva suas alterações.

Essa flag `Handled` é a armadilha mais fácil de toda a API: no Windows, cada `PlatformArgs` é uma camada fina sobre um objeto de event args do WinRT, e qualquer propriedade que você definir é silenciosamente sobrescrita pela fiação padrão do MAUI a menos que você defina `Handled = true` nos próprios platform args (separado de `DragEventArgs.Handled` e `DropEventArgs.Handled`, que controlam o processamento no nível do MAUI).

## Obter a posição do drop

No MAUI 11, todos os três event args (`DragStartingEventArgs`, `DragEventArgs` e `DropEventArgs`) expõem um método `GetPosition(Element?)` que retorna `Point?`. Passe `null` para coordenadas de tela, ou passe um elemento para obter coordenadas relativas a esse elemento.

```csharp
// .NET MAUI 11.0.0, .NET 11
void OnDrop(object sender, DropEventArgs e)
{
    var canvas = (Layout)sender;
    var point = e.GetPosition(canvas);
    if (point is { } p)
    {
        AbsoluteLayout.SetLayoutBounds(_draggedView!,
            new Rect(p.X, p.Y, AbsoluteLayout.AutoSize, AbsoluteLayout.AutoSize));
    }
}
```

Se você lembra da velha gambiarra de ler `MotionEvent.GetX/Y` do `PlatformArgs.DragEvent` do Android e `LocationInView` do `DropSession` do iOS, você não precisa mais. `GetPosition` retorna `null` apenas quando a plataforma genuinamente não reportou uma posição (raro, mas trate o nullable como crítico).

## Receber um arquivo de outro aplicativo

O arrasto entre apps é suportado no iOS, Mac Catalyst e Windows. O Android não pode ser destino de drop para itens de outro app através da API do reconhecedor de gestos.

A forma dos dados é específica de cada plataforma porque o payload entre processos é sempre nativo: uma coleção de `UIDragItem` no iOS e Mac Catalyst, um `DataPackageView` no Windows. O MAUI te dá os objetos nativos através de `PlatformArgs`.

```csharp
// .NET MAUI 11.0.0, .NET 11, Windows
async void OnDrop(object sender, DropEventArgs e)
{
#if WINDOWS
    var view = e.PlatformArgs?.DragEventArgs.DataView;
    if (view is null || !view.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.StorageItems))
        return;

    var items = await view.GetStorageItemsAsync();
    foreach (var item in items)
    {
        if (item is Windows.Storage.StorageFile file)
            HandleDroppedFile(file.Path);
    }
#endif
}
```

A variante para iOS/Mac Catalyst usa `e.PlatformArgs.DropSession.Items` e pede a cada `NSItemProvider` para carregar uma representação do arquivo no lugar. O padrão completo dos samples do .NET MAUI está documentado no Microsoft Learn em [Drag and drop between applications](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/gestures/drag-and-drop?view=net-maui-10.0#drag-and-drop-between-applications).

Para ambas as plataformas, o manipulador de `Drop` roda na thread de UI e o arquivo ainda não está copiado. Se você precisa dos bytes, copie-os dentro do manipulador antes de retornar, porque o app de origem tem permissão para revogar a sessão de arrasto assim que seu manipulador terminar.

## Cinco armadilhas que vão consumir uma tarde

**1. O `DataPackage` é de uso único.** Cada gesto de arrasto cria um `DataPackage` novo. Se você cachear `e.Data` e tentar lê-lo depois a partir de um drop diferente, vai obter os dados do arrasto *original*, não do atual, que é a fonte dos bugs "o segundo cartão que arrasto está errado".

**2. `Properties` é local ao processo.** Qualquer coisa que você colocar em `e.Data.Properties` funciona impecavelmente dentro do seu app e é invisível entre aplicativos. Se você quer um payload que sobreviva a um drop entre apps, defina também `e.Data.Text` (ou escreva em `PlatformArgs.SetClipData` no Android, `SetItemProvider` no iOS) para que o sistema tenha algo concreto para serializar.

**3. O drop padrão em `Label`/`Image`/`Entry` sempre dispara.** Se você manipula `Drop` e atualiza o destino manualmente, defina `e.Handled = true`, caso contrário a atribuição automática de texto ou imagem do MAUI vai rodar depois do seu manipulador e atropelar o resultado.

**4. `DropGestureRecognizer` não faz bubbling.** Cada elemento visual ou tem um reconhecedor ou não tem. Se você colocar o reconhecedor em um `Grid` pai e o `Border` filho não tiver reconhecedor próprio, o gesto funciona como esperado; mas se o filho tiver qualquer outro reconhecedor de gestos, o hit-testing para o drop pode cair no filho e pular o pai. Seja explícito: coloque o reconhecedor de drop no elemento mais profundo que deve aceitar o drop.

**5. Arrastar e soltar no Android exige uma `View` que participe do hit testing.** Um `Label` com `InputTransparent="True"` vai silenciosamente se recusar a iniciar um arrasto, e um `BoxView` sem cor de fundo só vai interceptar gestos sobre o retângulo que o rasterizador realmente pinta. Se o seu arrasto nunca começa no Android, defina um `BackgroundColor` na view de origem como teste de sanidade antes de partir para overrides de `Handler`.

## Blocos de construção para interações mais ricas

Arrastar e soltar é a forma com menor atrito de adicionar manipulação direta a um app MAUI de desktop ou tablet, mas os reconhecedores de gestos são também o bloco que você usa quando escreve uma lista reordenável, uma janela de tab-tear-out ou um quadro estilo Trello. Nenhum desses se compõe hoje em um único controle de biblioteca, razão pela qual todo app MAUI de desktop sério rola o seu próprio. A boa notícia é que a API subjacente é pequena o suficiente para que "rolar o seu próprio" geralmente signifique cem linhas de código, a maior parte das quais é a personalização da prévia específica de plataforma em vez do tratamento do gesto em si.

Se você está construindo uma cabeça de MAUI somente para desktop, o resto da [configuração do MAUI 11 para Windows e macOS apenas](/pt-br/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) percorre como remover os target frameworks móveis para que o seu `dotnet build` pare de arrastar workloads de Android e iOS. Para um tour pelo que mais é novo no framework, veja [novidades no .NET MAUI 10](/pt-br/2025/04/whats-new-in-net-maui-10/), que cobre as adições de `PlatformArgs` das quais este post depende. Se você precisa sobrescrever cores de tema que aparecem na sua prévia de arrasto, o mesmo padrão de handler em [como mudar a cor do ícone do SearchBar no .NET MAUI](/pt-br/2025/04/how-to-change-searchbars-icon-color-in-net-maui/) generaliza para a maioria dos ajustes nativos de prévia. E se o seu app é uma biblioteca de classes que hospeda esses gestos, [como registrar handlers em uma biblioteca MAUI](/pt-br/2023/11/maui-library-register-handlers/) cobre a fiação de `MauiAppBuilder` que você precisa para que os reconhecedores realmente se conectem quando o app consumidor inicia.

## Links de referência

- [Recognize a drag and drop gesture - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/gestures/drag-and-drop?view=net-maui-10.0)
- [DragGestureRecognizer Class - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.draggesturerecognizer)
- [DropGestureRecognizer Class - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.dropgesturerecognizer)
- [DataPackage Class - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.datapackage)
- [.NET MAUI Drag and Drop Gesture sample](https://learn.microsoft.com/en-us/samples/dotnet/maui-samples/gestures-draganddropgesture/)
