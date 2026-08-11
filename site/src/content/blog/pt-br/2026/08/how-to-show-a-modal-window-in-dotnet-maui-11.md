---
title: "Como mostrar uma janela modal no .NET MAUI 11"
description: "Duas coisas bem diferentes são chamadas de janela modal no .NET MAUI 11. PushModalAsync entrega uma página modal em todas as plataformas. Uma janela do sistema operacional que desabilite a janela dona não tem API nenhuma no MAUI, então aqui está a interoperabilidade com OverlappedPresenter.IsModal do WinUI e o handle de dono do Win32 que realmente funciona no Windows, e o que fazer no Mac Catalyst."
pubDate: 2026-08-11
template: how-to
tags:
  - "dotnet-maui"
  - "dotnet"
  - "csharp"
  - "windows"
  - "winui"
  - "navigation"
  - "how-to"
lang: "pt-br"
translationOf: "2026/08/how-to-show-a-modal-window-in-dotnet-maui-11"
translatedBy: "claude"
translationDate: 2026-08-11
---

Se você chegou aqui procurando isso, provavelmente quer uma de duas coisas completamente diferentes, e o .NET MAUI trata cada uma de um jeito. Uma **página modal** (uma página em tela cheia que bloqueia a interação com o que está atrás até ser fechada) é um recurso multiplataforma de primeira classe: `Navigation.PushModalAsync`. Uma **janela modal** no sentido de desktop (uma segunda janela de nível superior que escurece e desabilita a janela dona até você resolver o que ela pede, como o `ShowDialog` do WPF faz) não tem API nenhuma no MAUI, nem no .NET MAUI 11 nem em versões anteriores. `Application.Current.OpenWindow` abre uma segunda janela *não modal*. Para conseguir modalidade de verdade no Windows você desce pelo handler até o `AppWindow` do WinUI, define um dono com uma chamada Win32 e liga `OverlappedPresenter.IsModal`. No Mac Catalyst não existe equivalente, e ali o certo é usar uma página modal.

O .NET MAUI 11 está em `11.0.0-preview.6.26360.8` no NuGet em agosto de 2026, então a superfície de API ainda está se mexendo. Todos os trechos abaixo foram compilados contra o workload estável .NET MAUI 10.0.20 no SDK do .NET 10.0.201, com destino `net10.0-windows10.0.19041.0`. As versões prévias do MAUI 11 mantêm todos esses membros sem alteração; a única renomeação que você precisa conhecer chegou no MAUI 10 e está coberta abaixo.

## Qual dos dois "modal" você quer de fato

| O que você quer | API a usar | Onde funciona |
| --- | --- | --- |
| Uma página que cobre o app e da qual não dá para sair navegando | `Navigation.PushModalAsync` | Android, iOS, Mac Catalyst, Windows |
| Uma pergunta de sim/não ou uma única entrada de texto | `DisplayAlertAsync`, `DisplayPromptAsync` | todas |
| Uma sobreposição menor que a tela, sobre a página atual | `ShowPopupAsync` do Community Toolkit | todas |
| Uma janela do sistema operacional separada que desabilita a janela dona | Sem API no MAUI. Interoperabilidade WinUI + Win32 | só Windows |

A quarta linha é a resposta honesta para a pergunta de desktop, e é o motivo de o pedido estar aberto no repositório do MAUI desde 2022. Todo o resto é problema resolvido.

## Páginas modais, e o que as diferencia do `PushAsync`

A navegação modal usa uma pilha separada da navegação hierárquica. `Navigation` expõe as duas, e a modal é propositalmente menor:

```csharp
// .NET MAUI 10.0.20 / 11.0 preview
async void OnOpenModalClicked(object sender, EventArgs e)
{
    await Navigation.PushModalAsync(new ConfirmPage());
}

async void OnCloseModalClicked(object sender, EventArgs e)
{
    await Navigation.PopModalAsync();
}
```

Não existe `PopModalToRootAsync`, nem `InsertPageBefore`, nem `RemovePage` para a pilha modal, porque essas operações não são suportadas universalmente pelas plataformas subjacentes. Você tem `ModalStack` para inspeção e nada mais. Também não precisa de um `NavigationPage` para empilhar de forma modal, o que importa em um app com Shell: `NavigationPage` lança exceção se usado dentro do Shell, mas a navegação modal funciona normalmente ali. Se você já roteia pelo Shell, veja os detalhes sobre [passar dados por parâmetros de rota e propriedades de consulta do Shell](/pt-br/2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11/) antes de recorrer a uma página modal para movimentar estado.

A classe `Window` dispara `ModalPushing`, `ModalPushed`, `ModalPopping`, `ModalPopped` e `PopCanceled`, que é como você observa a pilha modal de fora das próprias páginas. `ModalPoppingEventArgs` carrega uma flag `Cancel`, então esse também é o ponto de encaixe para um "tem certeza que quer descartar?":

```csharp
// .NET MAUI 10.0.20: veto a modal dismissal from the Window
Window.ModalPopping += (s, e) =>
{
    if (HasUnsavedChanges(e.Modal))
        e.Cancel = true;
};
```

## Receber um resultado de uma página modal

`PushModalAsync` devolve uma `Task` que completa quando a animação de entrada termina, não quando o usuário terminou. Isso pega quase todo mundo na primeira vez. A correção idiomática é um `TaskCompletionSource<T>` na página modal:

```csharp
// .NET MAUI 10.0.20, C# 14
public sealed class ConfirmPage : ContentPage
{
    readonly TaskCompletionSource<bool> _tcs = new();

    public Task<bool> Result => _tcs.Task;

    public ConfirmPage()
    {
        var ok = new Button { Text = "OK" };
        ok.Clicked += async (s, e) =>
        {
            _tcs.TrySetResult(true);
            await Navigation.PopModalAsync();
        };
        Content = ok;
    }

    protected override void OnDisappearing()
    {
        base.OnDisappearing();
        // Covers swipe-to-dismiss on iOS and the Android back button.
        _tcs.TrySetResult(false);
    }
}
```

No ponto de chamada:

```csharp
var confirm = new ConfirmPage();
await Navigation.PushModalAsync(confirm);
bool accepted = await confirm.Result;
```

Usar `TrySetResult` em vez de `SetResult` não é ruído defensivo: `OnDisappearing` realmente roda depois que o manipulador do botão já definiu o resultado, e `SetResult` lançaria `InvalidOperationException` na segunda chamada.

## Deixar a página realmente inescapável

No Android o botão voltar por hardware ou por gesto desempilha a modal quer você queira ou não. Sobrescreva `OnBackButtonPressed` na página modal e devolva `true` para engolir o evento:

```csharp
protected override bool OnBackButtonPressed() => true;
```

No iOS, modais em estilo folha podem ser fechados com um deslize para baixo. Isso é assunto do estilo de apresentação, que vem a seguir.

## Controlar a aparência do modal no iOS e no Mac Catalyst

Por padrão uma página modal é apresentada em tela cheia. O platform-specific do iOS muda isso, e é um dos poucos ajustes que também afeta o Mac Catalyst, porque o Catalyst roda a maquinaria de apresentação do UIKit:

```xaml
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             xmlns:ios="clr-namespace:Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific;assembly=Microsoft.Maui.Controls"
             x:Class="MyApp.ConfirmPage"
             ios:Page.ModalPresentationStyle="FormSheet">
</ContentPage>
```

Ou pelo código:

```csharp
using Microsoft.Maui.Controls.PlatformConfiguration;
using Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific;
using Page = Microsoft.Maui.Controls.Page; // see the gotcha below

On<iOS>().SetModalPresentationStyle(UIModalPresentationStyle.FormSheet);
```

`UIModalPresentationStyle` oferece `FullScreen`, `FormSheet`, `PageSheet`, `OverFullScreen`, `Automatic` e, desde o .NET MAUI 10, `Popover`. `FormSheet` é o mais próximo de um diálogo de desktop que o Mac Catalyst entrega: um painel centralizado e menor que a tela, sobre a janela do app. `OverFullScreen` é o que você quer se a página modal tiver fundo transparente ou translúcido.

## Passos para mostrar uma janela modal de verdade no Windows

Este é o caso de desktop: uma janela genuinamente separada, com barra de título própria, que desabilita a janela de onde veio.

1. Crie uma `Window` e abra com `Application.Current.OpenWindow`. Nesse instante a janela não tem handler nem view de plataforma, então ainda não dá para configurar nada.
2. Espere o handler. Assine `HandlerChanged` na nova `Window` antes de abri-la, ou verifique `Handler` primeiro caso ele já esteja anexado. Tudo daqui em diante fica dentro de um bloco `#if WINDOWS`.
3. Faça o cast da view de plataforma para `MauiWinUIWindow` e leia a propriedade `AppWindow`. Esse é o objeto do Windows App SDK que controla a apresentação.
4. Defina um dono. Chame `SetWindowLongPtr` com `GWLP_HWNDPARENT` (`-8`), passando o HWND da janela dona. Pular isso é de longe a falha mais comum.
5. Aplique um `OverlappedPresenter` e defina `IsModal` como `true`. Use `OverlappedPresenter.CreateForDialog()` para os padrões de diálogo: sem minimizar, sem maximizar, não redimensionável.
6. Reative a janela dona quando a modal fechar. Trate `Destroying` na `Window` do MAUI e chame `Activate` na dona; caso contrário o foco vai para outro aplicativo.

## A interoperabilidade do Windows, completa

```csharp
// ModalWindowService.cs
// Verified against .NET MAUI 10.0.20 / .NET SDK 10.0.201, net10.0-windows10.0.19041.0
#if WINDOWS
using System.Runtime.InteropServices;
using Microsoft.Maui.Platform;   // MauiWinUIWindow
using Microsoft.UI.Windowing;    // AppWindow, OverlappedPresenter
using WinRT.Interop;             // WindowNative
#endif

namespace MyApp;

public static partial class ModalWindowService
{
    public static void ShowModal(Window owner, Page content, string title)
    {
        var modal = new Window(content) { Title = title, Width = 520, Height = 360 };

#if WINDOWS
        WhenHandlerReady(modal, () => MakeModal(modal, owner));
        modal.Destroying += (s, e) => Application.Current?.ActivateWindow(owner);
#endif

        Application.Current?.OpenWindow(modal);
    }

    static void WhenHandlerReady(Window window, Action action)
    {
        if (window.Handler?.PlatformView is not null)
        {
            action();
            return;
        }

        void OnChanged(object? sender, EventArgs e)
        {
            window.HandlerChanged -= OnChanged;
            if (window.Handler?.PlatformView is not null)
                action();
        }

        window.HandlerChanged += OnChanged;
    }

#if WINDOWS
    const int GWLP_HWNDPARENT = -8;

    static void MakeModal(Window modal, Window owner)
    {
        var nativeModal = (MauiWinUIWindow)modal.Handler!.PlatformView!;
        var nativeOwner = (MauiWinUIWindow)owner.Handler!.PlatformView!;

        nint modalHwnd = WindowNative.GetWindowHandle(nativeModal);
        nint ownerHwnd = WindowNative.GetWindowHandle(nativeOwner);

        // Ownership must be established before IsModal is set.
        SetWindowLongPtr(modalHwnd, GWLP_HWNDPARENT, ownerHwnd);

        AppWindow appWindow = nativeModal.AppWindow;
        var presenter = OverlappedPresenter.CreateForDialog();
        appWindow.SetPresenter(presenter);
        presenter.IsModal = true;
    }

    [LibraryImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    private static partial nint SetWindowLongPtr(nint hWnd, int nIndex, nint dwNewLong);
#endif
}
```

`IsModal` é quem faz o trabalho de verdade. O Windows App SDK documenta a propriedade como tendo precedência sobre a janela dona e bloqueando toda entrada até que a janela modal seja fechada ou deixe de ser modal. Você não precisa de uma chamada separada a `EnableWindow(ownerHwnd, false)` depois que `IsModal` está definido, e acrescentá-la deixa você com uma janela dona desabilitada que depois precisa lembrar de reabilitar na mão.

`OverlappedPresenter.CreateForDialog()` já preenche valores com formato de diálogo, então você não precisa desligar `IsMinimizable`, `IsMaximizable` e `IsResizable` um a um. Se quiser uma janela normal que apenas por acaso é modal, use `OverlappedPresenter.Create()`. Note também que o .NET MAUI 10 acrescentou `Window.IsMinimizable` e `Window.IsMaximizable` como propriedades vinculáveis na `Window` multiplataforma, então para esses dois ajustes específicos não é mais preciso interoperabilidade.

## Armadilhas que custam tempo real

**`IsModal` sem dono lança exceção.** Definir `IsModal = true` em uma janela sem dono produz `System.ArgumentException: Value does not fall within the expected range.` Isso está reportado no repositório do Windows App SDK e é a razão de existir o passo 4. Se sua janela modal funciona em um caminho de código e falha em outro, verifique se o HWND do dono que você passou não era zero.

**`Handler` é null logo depois de `OpenWindow`.** O MAUI cria a janela de plataforma de forma assíncrona. Ler `window.Handler.PlatformView` na linha seguinte ao `OpenWindow` lança `NullReferenceException`. O helper `WhenHandlerReady` acima existe puramente por causa disso, e assinar `HandlerChanged` *antes* da chamada a `OpenWindow` é o que o torna confiável.

**`[LibraryImport]` exige um tipo `partial`.** Se você colar o P/Invoke em uma `static class` comum recebe `SYSLIB1050: Method 'SetWindowLongPtr' is contained in a type 'ModalWindowService' that is not marked 'partial'`, seguido de `CS8795` e `CS0751`. Marque a classe como `partial`. O atributo `[DllImport]` mais antigo não tem essa exigência, mas a interoperabilidade gerada por código-fonte é o que você quer em um build com trimming ou Native AOT.

**O namespace do platform-specific do iOS sombreia `Page`.** Adicionar `using Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific;` a um arquivo que também usa `Microsoft.Maui.Controls` dá `CS0104: 'Page' is an ambiguous reference between 'Microsoft.Maui.Controls.Page' and 'Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific.Page'`. Acrescente `using Page = Microsoft.Maui.Controls.Page;` ou qualifique o nome completo.

**`DisplayAlert` foi renomeado no .NET MAUI 10.** Os métodos de pop-up em `Page` agora são `DisplayAlertAsync`, `DisplayActionSheetAsync` e `DisplayPromptAsync`. `DisplayPromptAsync` manteve o nome porque sempre teve um. Se você está portando uma base de código do MAUI 8 ou 9 para frente, essa é uma fonte silenciosa de quebras de compilação.

**Multijanela precisa de configuração por plataforma, e nunca funciona no iPhone.** Até o caminho não modal do `OpenWindow` exige `LaunchMode.Multiple` na `MainActivity` para Android, e uma classe `SceneDelegate` mais uma entrada `UIApplicationSceneManifest` no `Info.plist` para iPadOS e Mac Catalyst. O Windows não precisa de nada. O iOS no iPhone não consegue de jeito nenhum. Se o seu app é só desktop mesmo, [enxugar um projeto MAUI para Windows e Mac Catalyst](/pt-br/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) remove boa parte dessa superfície de configuração.

**O Mac Catalyst não tem equivalente de `IsModal`.** Não existe análogo do `OverlappedPresenter` no Catalyst, e o MAUI não expõe `beginSheet`. No Catalyst, apresente uma página modal com `FormSheet` e aceite que ela fica no escopo da janela, não do app. Se janelas modais de verdade por aplicativo forem um requisito duro de produto em todas as plataformas de desktop, esse é um dos casos concretos em que [o MAUI perde para Avalonia e Uno](/pt-br/2026/05/maui-vs-avalonia-vs-uno-in-2026/).

## Quando um popup é a melhor resposta

Se o que você quer de fato é uma sobreposição menor que a tela e flutuando sobre a página atual, nem uma página modal nem uma segunda janela são o certo. O .NET MAUI Community Toolkit (15.0.0 em agosto de 2026) tem `ShowPopupAsync`, `Popup<T>` para resultados tipados e `IPopupService` para exibição dirigida pelo view model. Defina `CanBeDismissedByTappingOutsideOfPopup` como `false` e você tem uma sobreposição bloqueante sem nada da interoperabilidade acima. Vale saber que o popup do toolkit é implementado como uma sobreposição de `ContentPage`, então a página que o chama continua recebendo `OnNavigatingFrom`, `OnDisappearing` e `OnNavigatedFrom`. Se você dependia desses eventos para significar "o usuário saiu desta tela", um popup também vai dispará-los.

Escolha por escopo, não por hábito. Bloquear uma tarefa dentro de uma janela é página modal. Bloquear o aplicativo inteiro no Windows é a interoperabilidade acima. Todo o resto é popup.

## Relacionados

- [Como usar parâmetros de rota e propriedades de consulta do Shell para navegação no .NET MAUI 11](/pt-br/2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11/)
- [Como escrever um app MAUI que roda só no Windows e no macOS (sem mobile)](/pt-br/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/)
- [Como implementar arrastar e soltar no .NET MAUI 11](/pt-br/2026/05/how-to-implement-drag-and-drop-in-maui-11/)
- [Como dar suporte correto ao modo escuro em um app .NET MAUI](/pt-br/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/)
- [MAUI vs Avalonia vs Uno Platform: qual escolher em 2026?](/pt-br/2026/05/maui-vs-avalonia-vs-uno-in-2026/)

## Fontes

- [Window - .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/window?view=net-maui-11.0)
- [NavigationPage, Perform modal navigation - .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/pages/navigationpage?view=net-maui-11.0)
- [Display pop-ups - .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/pop-ups?view=net-maui-11.0)
- [Modal page presentation style on iOS - .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/ios/platform-specifics/page-presentation-style?view=net-maui-11.0)
- [OverlappedPresenter.IsModal Property, Windows App SDK](https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.windowing.overlappedpresenter.ismodal)
- [OverlappedPresenter Class, Windows App SDK](https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.windowing.overlappedpresenter)
- [microsoft/WindowsAppSDK#3258, ArgumentException when OverlappedPresenter.IsModal is set to true](https://github.com/microsoft/WindowsAppSDK/issues/3258)
- [microsoft/WindowsAppSDK discussion #4435, on the issue of modal windows](https://github.com/microsoft/WindowsAppSDK/discussions/4435)
- [dotnet/maui#6210, Multi-Window in Windows with all options](https://github.com/dotnet/maui/issues/6210)
- [SYSLIB1050, source-generated P/Invoke diagnostics](https://learn.microsoft.com/dotnet/fundamentals/syslib-diagnostics/syslib1050)
- [.NET MAUI Community Toolkit Popup documentation](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/maui/views/popup)
