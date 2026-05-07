---
title: "Migrando uma ListView de alto desempenho do Xamarin.Forms para CollectionView do MAUI"
description: "Migração passo a passo da ListView do Xamarin.Forms 5.0 para a CollectionView do .NET MAUI 11 para apps que já espremiam desempenho da ListView. Cobre reciclagem de células, virtualização, agrupamento, pull-to-refresh, ações de contexto, seleção, ItemsLayout, EmptyView e as armadilhas que pegam apps reais."
pubDate: 2026-05-07
updatedDate: 2026-05-07
template: migration
tags:
  - "maui"
  - "xamarin"
  - "xamarin-forms"
  - "collectionview"
  - "listview"
  - "migration"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview"
translatedBy: "claude"
translationDate: 2026-05-07
---

A versão curta: substitua `ListView` por `CollectionView` envolto em um `RefreshView` se você precisava de pull-to-refresh, troque `ContextActions` por `SwipeView`, descarte `HasUnevenRows`, `RowHeight` e `CachingStrategy` porque virtualização com reciclagem de células é o único modo no MAUI, e reescreva a seleção de `ItemTapped` / `ItemSelected` para `SelectionMode` mais `SelectionChangedCommand`. Se sua `ListView` antiga estava ajustada com `CachingStrategy="RecycleElement"`, `HasUnevenRows="True"` e um `DataTemplateSelector`, a mudança é majoritariamente mecânica. Testado com .NET MAUI 11.0 GA em `net11.0-android35.0`, `net11.0-ios18.0` e `net11.0-maccatalyst18.0`. Espere de um a três dias de trabalho focado para um app com cinco a dez listas, mais tempo se você depender muito de agrupamento estilo `TableView` ou de renderers customizados de `ViewCell`.

O Xamarin.Forms saiu de suporte em [1 de maio de 2024](https://dotnet.microsoft.com/en-us/platform/support/policy/maui), e o MAUI 11 GA chegou em novembro de 2025 com a terceira geração de correções da CollectionView para travamentos no Android. Se você estava adiando porque o desempenho do seu app foi ajustado manualmente em torno de peculiaridades da `ListView` como `RecycleElementAndDataTemplate`, vale a pena fazer a atualização agora: a CollectionView no MAUI 11 finalmente iguala ou supera a antiga `ListView` do Xamarin.Forms no Android assim que você desliga `ItemSizingStrategy.MeasureAllItems`. Este guia é para esse público.

## Por que migrar agora

- O Xamarin.Forms está sem suporte. Sem patches de CVE, sem correções para Android 15 / iOS 18. As lojas de apps continuarão exigindo aumentos de target SDK; você não consegue acompanhá-los no Xamarin.Forms.
- A CollectionView é o único controle de coleção no MAUI que usa coleções com virtualização nativa da plataforma (`RecyclerView` no Android, `UICollectionView` no iOS). A `ListView` existe no MAUI por compatibilidade retroativa, mas é um [wrapper fino que delega para a CollectionView por baixo dos panos](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/listview) e herda o formato da API legada, não o renderer legado.
- `ItemsLayout` permite alternar entre layouts lineares e em grade sem subclasses ou gambiarras de repeater. O mesmo controle cobre o que antes precisava de `ListView` mais `FlowListView`.
- `EmptyView` é uma propriedade templada de verdade, não um toggle manual de `IsVisible` em um label irmão.

## O que quebra

| Área | Xamarin.Forms ListView | MAUI CollectionView | Severidade |
| ---- | ---------------------- | ------------------- | -------- |
| Estratégia de cache | `CachingStrategy="RetainElement"` ou `RecycleElement` | Sempre recicla. A propriedade não existe. | média |
| Altura da linha | `HasUnevenRows`, `RowHeight` | `ItemSizingStrategy="MeasureAllItems"` ou `MeasureFirstItem` | média |
| Pull to refresh | `IsPullToRefreshEnabled`, `RefreshCommand` na `ListView` | Envolva em `RefreshView` | alta |
| Tipo de célula | `ViewCell`, `TextCell`, `ImageCell` | `DataTemplate` simples com qualquer layout raiz | alta |
| Tratamento de toque | `ItemTapped`, `ItemSelected` | `SelectionMode`, `SelectionChanged`, `SelectionChangedCommand` | alta |
| Ações de swipe | `ContextActions` | `SwipeView` | alta |
| Separadores | `SeparatorVisibility`, `SeparatorColor` | Nenhum. Adicione um `BoxView` no template. | baixa |
| Cabeçalhos / rodapés | `Header`, `Footer` (objeto ou template) | Mesmos nomes, mas apenas como templates / views | baixa |
| Agrupamento | `IsGroupingEnabled`, `GroupHeaderTemplate` | `IsGrouped`, `GroupHeaderTemplate`, `GroupFooterTemplate` | média |
| Scroll para | `ScrollTo(item, ScrollToPosition)` | `ScrollTo(item, position, animate)` | baixa |
| Estado vazio | Label irmão manual | `EmptyView`, `EmptyViewTemplate` | baixa |

As duas mudanças que doem são pull-to-refresh e seleção. Tudo o mais é renomeação direta ou exclusão.

## Checklist de pré-voo

1. SDK do .NET 11 instalado (`dotnet --version` reporta `11.0.x`). O MAUI 11 exige o SDK do .NET 11. SDKs anteriores não têm o manifesto do workload.
2. Workload do MAUI instalado: `dotnet workload install maui`. Se você atualizou sobre uma instalação mais antiga, rode `dotnet workload repair` antes.
3. Plataformas Android SDK 35, iOS 18 e Mac Catalyst 18 disponíveis. Visual Studio 2022 17.13 ou Visual Studio Code com a extensão .NET MAUI 1.6+.
4. Um branch `git` que você possa descartar. Mantenha o projeto Xamarin.Forms compilando na `main` até o build do MAUI estar verde em um dispositivo real.
5. Uma lista de cada instância de `ListView` no projeto. Agrupe-as por área de recurso; migre um recurso por vez e entregue atrás de uma feature flag se sua cadência de release é mensal.
6. Rode o [.NET Upgrade Assistant](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview) no projeto uma vez para tratar as mudanças de `csproj`, namespace e `MauiProgram`. O Upgrade Assistant não reescreve o XAML da `ListView` para você, que é o que o resto deste post cobre.

## Passos da migração

### 1. Substitua `ListView` por `CollectionView`

O caso mais simples é uma lista plana com um `DataTemplate` customizado:

```xml
<!-- Before. Xamarin.Forms 5.0 -->
<ListView ItemsSource="{Binding Articles}"
          CachingStrategy="RecycleElementAndDataTemplate"
          HasUnevenRows="True"
          SeparatorVisibility="None"
          ItemTapped="OnArticleTapped">
    <ListView.ItemTemplate>
        <DataTemplate>
            <ViewCell>
                <Grid Padding="12" RowDefinitions="Auto,Auto">
                    <Label Text="{Binding Title}" FontAttributes="Bold" />
                    <Label Grid.Row="1" Text="{Binding Excerpt}" />
                </Grid>
            </ViewCell>
        </DataTemplate>
    </ListView.ItemTemplate>
</ListView>
```

```xml
<!-- After. .NET MAUI 11.0 -->
<CollectionView ItemsSource="{Binding Articles}"
                SelectionMode="Single"
                SelectionChangedCommand="{Binding OpenArticleCommand}"
                SelectionChangedCommandParameter="{Binding Source={RelativeSource Self}, Path=SelectedItem}">
    <CollectionView.ItemTemplate>
        <DataTemplate x:DataType="vm:ArticleVm">
            <Grid Padding="12" RowDefinitions="Auto,Auto">
                <Label Text="{Binding Title}" FontAttributes="Bold" />
                <Label Grid.Row="1" Text="{Binding Excerpt}" />
            </Grid>
        </DataTemplate>
    </CollectionView.ItemTemplate>
</CollectionView>
```

O que mudou:

- `ViewCell` foi embora. A raiz do template é um layout (`Grid`, `VerticalStackLayout` etc.) diretamente.
- `CachingStrategy` foi embora. A reciclagem está sempre ligada. O antigo `RecycleElementAndDataTemplate` é o análogo mais próximo e é o único modo agora.
- `HasUnevenRows="True"` foi embora. A CollectionView mede cada célula por padrão. Se suas linhas são todas do mesmo tamanho, defina `ItemSizingStrategy="MeasureFirstItem"` para um ganho mensurável de desempenho de scroll no Android.
- `SeparatorVisibility="None"` é o novo padrão. Adicione um `BoxView HeightRequest="1"` dentro do template se você realmente quer um.
- `x:DataType` no template ativa bindings compilados. Sempre defina. O desempenho da CollectionView despenca com bindings via reflexão no Android.

**Verifique**: compile para Android (`dotnet build -t:Run -f net11.0-android35.0`) e role uma lista de 1000 itens em um dispositivo intermediário. O frame time deve ficar abaixo de 16 ms na visualização Profile GPU Rendering do Android Studio. Se não estiver, verifique se `x:DataType` está definido e se nenhum binding dentro do template usa `Source={x:Reference ...}`.

### 2. Envolva em `RefreshView` para pull-to-refresh

`IsPullToRefreshEnabled`, `IsRefreshing` e `RefreshCommand` não estão mais na lista. Eles vivem no `RefreshView`, que envolve qualquer conteúdo rolável.

```xml
<!-- After. .NET MAUI 11.0 -->
<RefreshView IsRefreshing="{Binding IsRefreshing}"
             Command="{Binding RefreshCommand}">
    <CollectionView ItemsSource="{Binding Articles}"
                    SelectionMode="Single">
        <CollectionView.ItemTemplate>
            <DataTemplate x:DataType="vm:ArticleVm">
                <!-- as before -->
            </DataTemplate>
        </CollectionView.ItemTemplate>
    </CollectionView>
</RefreshView>
```

O `RefreshView` só dispara quando o rolável envolto está no offset zero, então o comportamento bate com a antiga `ListView`. Não há `IsPullToRefreshEnabled`; se você precisa desativar, defina `IsEnabled="False"` no `RefreshView`.

**Verifique**: puxe para baixo na lista enquanto estiver no offset zero. O spinner da plataforma deve aparecer e `RefreshCommand` deve disparar exatamente uma vez por gesto.

### 3. Reescreva a seleção

O evento `ItemTapped` do Xamarin.Forms dispara em cada toque, mesmo quando `SelectedItem` não mudou. A CollectionView separa isso claramente: toque é seleção, e seleção é observável via `SelectionChanged` ou `SelectionChangedCommand`. Se você dependia do toque para navegar para o mesmo item duas vezes seguidas, precisa optar por sair do estado de seleção lendo e limpando `SelectedItem` após cada navegação:

```csharp
// MainViewModel.cs, .NET MAUI 11.0, C# 14
[RelayCommand]
private async Task OpenArticleAsync(ArticleVm? selected)
{
    if (selected is null) return;
    await Shell.Current.GoToAsync(nameof(ArticleDetailPage),
        new Dictionary<string, object> { ["article"] = selected });
    SelectedArticle = null; // re-arm so the same row can fire next time
}
```

`SelectionMode="None"` mais um `TapGestureRecognizer` dentro do template é o equivalente mais próximo da antiga semântica de `ItemTapped`. Use só se você tiver um motivo. O padrão baseado em seleção é o que as plataformas esperam e é o que te dá anéis de foco de acessibilidade de graça no Windows.

**Verifique**: toque um item, navegue de volta, toque o mesmo item. Os dois toques devem abrir a página de detalhes.

### 4. Substitua `ContextActions` por `SwipeView`

```xml
<!-- Before. Xamarin.Forms 5.0 -->
<ViewCell>
    <ViewCell.ContextActions>
        <MenuItem Text="Delete" IsDestructive="True"
                  Command="{Binding DeleteCommand}" />
    </ViewCell.ContextActions>
    <Grid>...</Grid>
</ViewCell>
```

```xml
<!-- After. .NET MAUI 11.0 -->
<SwipeView>
    <SwipeView.RightItems>
        <SwipeItems Mode="Execute">
            <SwipeItem Text="Delete"
                       BackgroundColor="Crimson"
                       Command="{Binding DeleteCommand}" />
        </SwipeItems>
    </SwipeView.RightItems>
    <Grid>...</Grid>
</SwipeView>
```

`SwipeView` é um swipe real para esquerda e direita com fundos customizados. `IsDestructive` vira um `BackgroundColor` normal. `Mode="Execute"` corresponde ao comportamento antigo de descartar ao tocar; `Mode="Reveal"` mantém o menu aberto. O long-press do iOS para revelar um menu acabou; se você precisa, use `MenuFlyout` no MAUI 11 (novo nesta release).

**Verifique**: deslize para a esquerda no iOS e Android. Toque em delete. O item é removido. Deslize de novo na próxima linha para confirmar que apenas um swipe fica aberto por vez.

### 5. Troque o agrupamento

```xml
<!-- After. .NET MAUI 11.0 -->
<CollectionView ItemsSource="{Binding ArticlesByDay}"
                IsGrouped="True">
    <CollectionView.GroupHeaderTemplate>
        <DataTemplate x:DataType="vm:ArticleDayVm">
            <Label Text="{Binding Day, StringFormat='{0:D}'}"
                   FontAttributes="Bold"
                   Padding="12,8" />
        </DataTemplate>
    </CollectionView.GroupHeaderTemplate>
    <CollectionView.ItemTemplate>
        <DataTemplate x:DataType="vm:ArticleVm">
            <!-- as before -->
        </DataTemplate>
    </CollectionView.ItemTemplate>
</CollectionView>
```

Duas coisas mudam. A flag é `IsGrouped`, não `IsGroupingEnabled`. E a fonte precisa ser uma coleção de coleções onde cada item externo é, por sua vez, enumerável. O padrão mais limpo é uma classe `Grouping<TKey, TItem>` que deriva de `List<TItem>` e expõe `Key`. É o mesmo padrão que o Xamarin.Forms usava e ele porta sem alterações.

**Verifique**: role uma lista agrupada por 30 dias. Os cabeçalhos de grupo devem grudar no topo do seu grupo no iOS por padrão (`GroupHeadersStick="True"` no nativo do iOS; o padrão do MAUI espelha isso).

### 6. Escolha um `ItemsLayout`

O padrão é `LinearItemsLayout` vertical, que combina com a `ListView`. Mude para uma grade com uma única linha:

```xml
<CollectionView ItemsSource="{Binding Photos}">
    <CollectionView.ItemsLayout>
        <GridItemsLayout Orientation="Vertical"
                         Span="3"
                         HorizontalItemSpacing="4"
                         VerticalItemSpacing="4" />
    </CollectionView.ItemsLayout>
    <CollectionView.ItemTemplate>
        <DataTemplate x:DataType="vm:PhotoVm">
            <Image Source="{Binding ThumbnailUrl}" Aspect="AspectFill" />
        </DataTemplate>
    </CollectionView.ItemTemplate>
</CollectionView>
```

`Span="3"` é uma contagem fixa de colunas. Não há grade adaptativa embutida; para isso você dimensiona as células com base na largura disponível usando um behaviour ou refazendo o bind em mudanças de tamanho.

**Verifique**: gire o dispositivo. A grade deve ser redesenhada sem perder a posição de scroll.

### 7. Adicione um `EmptyView`

```xml
<CollectionView ItemsSource="{Binding Articles}">
    <CollectionView.EmptyView>
        <VerticalStackLayout HorizontalOptions="Center"
                             VerticalOptions="Center" Spacing="8">
            <Label Text="No articles yet" FontSize="18" />
            <Button Text="Refresh" Command="{Binding RefreshCommand}" />
        </VerticalStackLayout>
    </CollectionView.EmptyView>
</CollectionView>
```

Para múltiplos estados vazios (sem dados vs erro), faça o bind de `EmptyView` a uma propriedade e use `EmptyViewTemplate` com um `DataTemplateSelector`.

**Verifique**: limpe a fonte. A empty view aparece. Reabasteça a fonte. A empty view some sem um frame de sobreposição.

## Checklist de verificação

Depois que cada lista é migrada:

- `dotnet build -c Release` para `net11.0-android35.0`, `net11.0-ios18.0`, `net11.0-maccatalyst18.0` e `net11.0-windows10.0.19041.0` produz zero avisos sobre APIs obsoletas da `ListView`.
- `dotnet test` contra a camada de ViewModel está verde. A lógica de seleção é a regressão mais provável; cubra-a.
- No Android, role uma lista de 1000 itens em um Pixel 6 ou equivalente. O frame time fica abaixo de 16 ms com `MeasureFirstItem` se as linhas são uniformes. Com `MeasureAllItems` e 1000 itens, espere um custo único de medição na primeira exibição.
- No iOS, segure o dedo em uma linha. Nenhum feedback de seleção deve persistir após soltar se `SelectionMode="None"`.
- Pull-to-refresh dispara exatamente uma vez por gesto, em cada plataforma.
- Ações de swipe revelam no lado correto (idiomas RTL espelham automaticamente; verifique em uma localidade árabe se você entrega uma).
- `EmptyView` é anunciado pelo VoiceOver / TalkBack. A CollectionView entrega texto de acessibilidade para o estado vazio automaticamente; um `SemanticProperties.Description` manual sobrescreve.

## Plano de rollback

Esta é, na prática, uma migração de mão única. Uma vez que o projeto está nos target frameworks `net11.0-*` e no `MauiProgram.cs`, voltar para o Xamarin.Forms significa restaurar o formato antigo do `csproj`, o `Xamarin.Forms.Forms.Init` e os pontos de entrada do app específicos da plataforma. Nada neste post sobre a CollectionView em si é reversível separadamente da atualização do projeto. Planeje entregar um build do MAUI funcionando antes de deletar o branch do Xamarin.Forms.

## Armadilhas que pegamos

- Semântica de `ItemTapped`. Se seu código antigo chamava `ListView.SelectedItem = null` no `ItemTapped` para tornar a mesma linha tocável duas vezes, você precisa continuar limpando `SelectedItem` (ou `SelectedItems`) depois de cada navegação. A CollectionView não auto-limpa.
- `RemainingItemsThreshold` para scroll infinito está na CollectionView (`RemainingItemsThreshold` mais `RemainingItemsThresholdReachedCommand`). O padrão antigo de `ItemAppearing` ainda funciona mas dispara por item; o padrão de threshold dispara uma vez perto do fundo, que é o que a maioria das UIs de scroll infinito realmente quer.
- `ScrollTo` não aceita mais o valor `MakeVisible` do enum `ScrollToPosition`. O mapeamento mais próximo é `ScrollToPosition.MakeVisible` para `ScrollToPosition.MakeVisible` (mesmo nome, mesmo enum), mas o segundo argumento agora é o índice do grupo. Para uma lista não agrupada passe `null`. Leia a [documentação do ScrollTo da CollectionView](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/collectionview/scrolling) antes de portar qualquer lógica customizada de scroll.
- Bindings compilados (`x:DataType`) são obrigatórios para desempenho. Sem eles, o scroll trava no Android porque cada binding resolve via reflexão a cada reciclagem.
- `ItemSizingStrategy.MeasureAllItems` em uma lista longa com altura variável força um passe completo de medição na primeira exibição. Se você tem dez mil itens e a lista é a primeira coisa na tela, seu time-to-first-frame regride. Use uma altura fixa de célula quando puder.
- Renderers customizados de `ViewCell` não portam. Não existe `ViewCellRenderer` no MAUI. Se você tinha um, a célula vira um layout normal no MAUI, e a lógica do renderer move para um [handler](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/) sobre o controle filho que precisava dela.
- `TableView` ainda existe no MAUI para telas estáticas estilo configurações. Não use para dados dinâmicos. Ele não virtualiza.

## Relacionados

- [Como dar suporte ao modo escuro corretamente em um app MAUI](/pt-br/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) cobre os padrões de `AppThemeBinding` que templates dentro da CollectionView precisam.
- [Como implementar arrastar e soltar no MAUI 11](/pt-br/2026/05/how-to-implement-drag-and-drop-in-maui-11/) mostra como combinar `DragGestureRecognizer` com itens de `CollectionView`, que é o substituto moderno para reordenamento na ListView.
- [Como empacotar um app MAUI para a Microsoft Store](/pt-br/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) é o próximo passo depois que a migração está pronta e você quer entregar para o Windows de novo.
- [Como escrever um app MAUI que roda apenas no Windows e macOS](/pt-br/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) é a referência certa se você está descartando mobile de um projeto Xamarin.Forms ao mesmo tempo.

## Fontes

- [Documentação da CollectionView no .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/collectionview/)
- [Documentação da ListView no .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/listview)
- [Política de suporte do Xamarin.Forms](https://dotnet.microsoft.com/en-us/platform/support/policy/maui)
- [Atualizar a partir do Xamarin.Forms](https://learn.microsoft.com/en-us/dotnet/maui/migration/) no MS Learn
- [.NET Upgrade Assistant](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview)
