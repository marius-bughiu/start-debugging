---
title: "Como interceptar o botão voltar do Android em uma página raiz do Shell no .NET MAUI"
description: "Sobrescreva OnBackButtonPressed na página raiz e use o .NET MAUI 10.0.101 ou posterior. Por que as páginas raiz deixaram de receber o toque em voltar a partir da 10.0.70 (Android 16) e da 10.0.100 (todas as versões do Android), por que o .NET 11 RC 1 ainda é afetado, por que Shell.OnNavigating e BackButtonBehavior.Command não ajudam, e um workaround no MainActivity para as versões quebradas."
pubDate: 2026-09-13
template: how-to
tags:
  - "dotnet-maui"
  - "android"
  - "maui-shell"
  - "predictive-back"
  - "dotnet-10"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/09/how-to-intercept-the-android-back-button-on-a-dotnet-maui-shell-root-page"
translatedBy: "claude"
translationDate: 2026-09-13
---

**Resposta curta:** sobrescreva `OnBackButtonPressed()` no `ContentPage` raiz (ou no seu `AppShell`), retorne `true` para engolir o toque e garanta que você está no **.NET MAUI 10.0.101** (lançado em 2026-09-07) ou posterior. Entre a 10.0.70 e a 10.0.100, e no .NET MAUI 11 RC 1 (`11.0.0-rc.1.26451.6`), essa sobrescrita nunca é chamada em uma página raiz: o MAUI desativa seu callback de voltar do Android sempre que acha que não há nada para desempilhar, então o Android manda o usuário para a tela inicial sem consultar o seu código. No Android 16 isso começou na 10.0.70; em todas as outras versões do Android, começou na 10.0.100. Se você não pode atualizar, registre seu próprio `OnBackPressedCallback` no `MainActivity` (código abaixo). `Shell.OnNavigating` com `ShellNavigationSource.Pop` e `BackButtonBehavior.Command` não interceptam o voltar por hardware ou por gesto em uma página raiz, nem mesmo na 10.0.101.

A correção da 10.0.101 não está no .NET 11 RC 1. Desde então ela chegou ao `main` e ao branch `net11.0` (pelo merge de servicing SR10, [dotnet/maui#38301](https://github.com/dotnet/maui/pull/38301)), então espere vê-la no .NET 11 RC 2.

## Por que a página raiz parou de ouvir o botão voltar

O Android 16 ativa o predictive back por padrão para apps que têm como alvo a API 36. Com o predictive back, o sistema decide *antes de o gesto começar* se o app quer o evento de voltar. Se nenhum callback estiver ativado, ele reproduz a animação de prévia de volta para a tela inicial e manda a tarefa para segundo plano. Ele nunca chama o obsoleto `Activity.OnBackPressed()` e nunca despacha `KeyEvent.KEYCODE_BACK` para `OnKeyDown`.

O .NET MAUI costumava registrar seu callback de voltar incondicionalmente, o que matava essa animação em todos os apps MAUI ([dotnet/maui#34594](https://github.com/dotnet/maui/issues/34594)). A correção, [dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223), substituiu isso por um `OnBackPressedCallback` do AndroidX cuja flag `Enabled` o MAUI recalcula a cada mudança de navegação. O `MauiAppCompatActivity` ativa o callback apenas quando `Window.CanConsumeBackNavigation` diz que a página atual pode consumir o voltar:

- há uma página modal na pilha, ou
- a pilha de navegação da seção do Shell tem mais de uma página, ou
- um `NavigationPage` tem mais de uma página, ou
- um flyout que o usuário pode fechar está aberto.

Um `ContentPage` raiz simples não se encaixa em nenhum desses casos, então o callback fica desativado e o toque vai direto para o sistema. Sua sobrescrita de `OnBackButtonPressed()` fica no final de uma cadeia (`MauiOnBackPressedCallback` -> `AndroidLifecycle.OnBackPressed` -> `IWindow.BackButtonClicked()` -> `Shell.OnBackButtonPressed()` -> `Page.OnBackButtonPressed()`) que nunca começa.

Por que o Android 16 quebrou primeiro? Da 10.0.70 à 10.0.90, o `MauiAppCompatActivity` ainda sobrescrevia o obsoleto `OnBackPressed()` e executava o tratamento de voltar do MAUI incondicionalmente a partir dali. Dispositivos que não usam predictive back (Android 15 e anteriores, a menos que você tenha optado com `android:enableOnBackInvokedCallback="true"`) ainda entregavam o toque por essa sobrescrita, então a verificação não importava. A 10.0.100 removeu a sobrescrita e moveu tudo para o `OnBackPressedDispatcher`, então a verificação passa a valer em todas as versões do Android. A triagem das issues bate exatamente com isso: [#37657](https://github.com/dotnet/maui/issues/37657) e [#38030](https://github.com/dotnet/maui/issues/38030) estão marcadas como `regressed-in-10.0.70` para o Android 16, e [#37706](https://github.com/dotnet/maui/issues/37706) relata falhas no Android 15 e 17 a partir da 10.0.100.

## O que a 10.0.101 mudou, medido

[dotnet/maui#37709](https://github.com/dotnet/maui/pull/37709), portado como [#37729](https://github.com/dotnet/maui/pull/37729), adiciona uma verificação no início de `CanConsumeBackNavigation`: se o `OnBackButtonPressed` efetivo da página for declarado em qualquer assembly diferente de `Microsoft.Maui.Controls`, o callback é ativado. O MAUI detecta a sobrescrita pelo `MethodInfo.DeclaringType` de um delegate, sem invocar o seu código. O resultado fica em cache por instância de página.

Eu queria ver a decisão em si em vez de confiar na descrição do PR, então chamei o método interno `Window.CanConsumeBackNavigation(Page)` por reflexão a partir de um app baseado em arquivo do .NET 10. Ele usa o build `net10.0` simples de `Microsoft.Maui.Controls`, então nenhum emulador é necessário:

```csharp
// probe.cs -- dotnet run probe.cs (SDK 10.0.302; net11.0 + SDK 11.0.100-rc.1 for the RC 1 run)
#:package Microsoft.Maui.Controls@10.0.101
#:property PublishAot=false
#:property TargetFramework=net10.0
using System.Reflection;
using Microsoft.Maui.Controls;

var canConsume = typeof(Window).GetMethod("CanConsumeBackNavigation",
    BindingFlags.NonPublic | BindingFlags.Static)!;
bool Check(Page p) => (bool)canConsume.Invoke(null, [p])!;

Console.WriteLine($"root page with override        -> {Check(new OverridePage())}");
Console.WriteLine($"Shell override, plain root     -> {Check(MakeShell(new OverrideShell(), new PlainPage()))}");
Console.WriteLine($"Shell OnNavigating only        -> {Check(MakeShell(new NavigatingShell(), new PlainPage()))}");
// ...plus a plain Shell + plain root, and a root with a BackButtonBehavior.Command

static Shell MakeShell(Shell shell, ContentPage root)
{
    shell.Items.Add(new ShellContent { Content = root });
    return shell;
}

class PlainPage : ContentPage { }
class OverridePage : ContentPage { protected override bool OnBackButtonPressed() => true; }
class OverrideShell : Shell { protected override bool OnBackButtonPressed() => true; }
class NavigatingShell : Shell
{
    protected override void OnNavigating(ShellNavigatingEventArgs args)
    {
        base.OnNavigating(args);
        if (args.Source == ShellNavigationSource.Pop) args.Cancel();
    }
}
```

`True` significa que o MAUI ativa seu callback naquela página raiz, então o seu código roda. `False` significa que o Android manda o app para segundo plano sem perguntar:

| Configuração da página raiz | 10.0.90 | 10.0.101 | 11.0.0-rc.1.26451.6 |
|---|---|---|---|
| `ContentPage` simples, sem sobrescritas | False | False | False |
| `ContentPage` sobrescrevendo `OnBackButtonPressed` | False | **True** | False |
| `AppShell` sobrescrevendo `OnBackButtonPressed`, raiz simples | False | **True** | False |
| `Shell` simples, página raiz sobrescrevendo `OnBackButtonPressed` | False | **True** | False |
| `AppShell` sobrescrevendo apenas `OnNavigating` (cancela `Pop`) | False | False | False |
| Página raiz com `Command` em `Shell.BackButtonBehavior` | False | False | False |

Esse teste mede a verificação, não uma execução em dispositivo. Para o resultado em dispositivo, o #37709 inclui uma verificação em um emulador Android 16. A equipe do MAUI também confirmou a correção com a reprodução de abas do Shell no #37657, e quem abriu o #37706 confirmou que o build do PR corrigiu o app com NavigationPage.

## Passo a passo: interceptar o toque em voltar em uma página raiz

1. **Verifique sua versão do MAUI.** Procure o pacote `Microsoft.Maui.Controls` no seu `.csproj`, ou execute `dotnet list package`. Se ele resolver para qualquer versão entre a 10.0.70 e a 10.0.100, suba para a 10.0.101 ou posterior. No .NET 11 RC 1, use o workaround do passo 4 até o RC 2.

   ```xml
   <!-- .NET MAUI 10, MyApp.csproj -->
   <PackageReference Include="Microsoft.Maui.Controls" Version="10.0.101" />
   ```

2. **Sobrescreva `OnBackButtonPressed` na página que precisa disso.** O método é síncrono, então retorne `true` imediatamente e mostre qualquer diálogo de confirmação no próximo ciclo do dispatcher. Não torne a sobrescrita `async`: uma sobrescrita `async` retorna `false` no seu primeiro `await`, antes de o usuário responder.

   ```csharp
   // .NET MAUI 10.0.101, C# 14 -- MainPage.xaml.cs (a Shell root page)
   public partial class MainPage : ContentPage
   {
       bool _confirming;

       protected override bool OnBackButtonPressed()
       {
           if (_confirming)
               return true;

           _confirming = true;
           Dispatcher.Dispatch(async () =>
           {
               try
               {
                   bool leave = await DisplayAlertAsync(
                       "Leave the app?", "Unsaved changes will be lost.", "Leave", "Stay");
                   if (leave)
                       LeaveApp();
               }
               finally
               {
                   _confirming = false;
               }
           });
           return true; // swallow this press; the dialog decides what happens next
       }

       static void LeaveApp()
       {
   #if ANDROID
           // Same as Android's own root back since Android 12: background the task, keep the process.
           Platform.CurrentActivity?.MoveTaskToBack(true);
   #endif
       }
   }
   ```

   `MoveTaskToBack(true)` é intencional. `Application.Current.Quit()` no Android chama `FinishAndRemoveTask()` e depois `Environment.Exit(0)`, o que mata o processo e joga fora o warm start que o Android daria na próxima abertura.

3. **Para regras no nível das abas, sobrescreva no `AppShell`.** Um requisito comum é "voltar na raiz de qualquer aba retorna para a primeira aba, e só a primeira aba sai do app". Isso pertence ao Shell, que enxerga todas as páginas raiz:

   ```csharp
   // .NET MAUI 10.0.101, C# 14 -- AppShell.xaml.cs
   public partial class AppShell : Shell
   {
       protected override bool OnBackButtonPressed()
       {
           var section = CurrentItem?.CurrentItem;
           bool atTabRoot = section is not null && section.Stack.Count <= 1;

           if (atTabRoot && CurrentItem is TabBar tabs && tabs.CurrentItem != tabs.Items[0])
           {
               tabs.CurrentItem = tabs.Items[0];
               return true;
           }

           return base.OnBackButtonPressed(); // pops pages, then raises Navigating(Pop)
       }
   }
   ```

   Retornar `base.OnBackButtonPressed()` mantém o comportamento normal do Shell. Ele chama o `OnBackButtonPressed` da página visível, desempilha a pilha da seção se houver algo para desempilhar e, caso contrário, dispara `Navigating` com `ShellNavigationSource.Pop` e retorna `args.Cancelled`. Isso também significa que o padrão documentado de cancelamento em `OnNavigating` *funciona* em uma página raiz depois que alguma sobrescrita tiver ativado o callback. Sozinho, ele nunca roda.

4. **Na 10.0.70 a 10.0.100 ou no .NET 11 RC 1, adicione seu próprio callback no `MainActivity`.** O dispatcher do AndroidX chama primeiro o callback ativado adicionado mais recentemente. Um callback adicionado depois de `base.OnCreate` portanto roda antes do callback do MAUI, inclusive nos casos em que o callback do próprio MAUI está desativado:

   ```csharp
   // .NET MAUI 10.0.70-10.0.100 and 11.0.0-rc.1 only -- Platforms/Android/MainActivity.cs
   using Android.App;
   using Android.Content.PM;
   using Android.OS;
   using AndroidX.Activity;

   [Activity(Theme = "@style/Maui.SplashTheme", MainLauncher = true, LaunchMode = LaunchMode.SingleTop,
       ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation | ConfigChanges.UiMode |
                              ConfigChanges.ScreenLayout | ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
   public class MainActivity : MauiAppCompatActivity
   {
       protected override void OnCreate(Bundle? savedInstanceState)
       {
           base.OnCreate(savedInstanceState);
           OnBackPressedDispatcher.AddCallback(this, new RootBackCallback(this));
       }

       sealed class RootBackCallback(MainActivity activity) : OnBackPressedCallback(true)
       {
           public override void HandleOnBackPressed()
           {
               // Runs the same chain MAUI would: modal stack, Shell, then the visible page.
               var window = Microsoft.Maui.Controls.Application.Current?.Windows.FirstOrDefault()
                   as Microsoft.Maui.IWindow;
               if (window?.BackButtonClicked() == true)
                   return;

               // Nothing consumed it: step aside and let the system (or MAUI) handle this press.
               Enabled = false;
               try { activity.OnBackPressedDispatcher.OnBackPressed(); }
               finally { Enabled = true; }
           }
       }
   }
   ```

   Isso é um shim de compatibilidade, não um padrão para manter. O callback fica sempre ativado, então a animação de volta para a tela inicial nunca é reproduzida. Além disso, quando o callback do próprio MAUI também está ativado (um flyout aberto, por exemplo) e nenhuma página trata o toque, sua sobrescrita roda duas vezes. Apague o shim quando migrar para a 10.0.101. Deixá-lo na 10.0.101 faz com que todo toque não tratado em uma página com sobrescrita passe por `OnBackButtonPressed` duas vezes. O [#37657](https://github.com/dotnet/maui/issues/37657) tem uma variante mais curta que reentra no obsoleto `Activity.OnBackPressed()`. A versão acima evita chamar uma API obsoleta a partir de código novo.

5. **Verifique em um dispositivo Android 16 real ou em um emulador com API 36.** Use tanto a navegação por gestos quanto a navegação por 3 botões. Deslize a partir da borda e segure em uma página raiz que sobrescreve o método: você não deve ver a prévia de volta para a tela inicial, e ao soltar seu handler deve rodar. Em uma página raiz sem sobrescrita, você ainda deve ver a animação de prévia. É assim que você sabe que não desativou o predictive back no app inteiro.

## Coisas que parecem que deveriam funcionar, mas não funcionam

**`BackButtonBehavior.Command` não é um handler de voltar por hardware no Android.** `Shell.OnBackButtonPressed` só executa o comando sob `#if WINDOWS || !PLATFORM`. No Android, o comando roda a partir de `ShellToolbarTracker.OnClick`, ou seja, a seta na barra de navegação. Uma página raiz não tem seta de voltar (em um Shell com flyout, esse espaço é o menu hambúrguer), então para a página raiz o comando é irrelevante. O teste confirma que ele também não ativa o callback.

**Eventos de ciclo de vida não liberam a verificação.** `builder.ConfigureLifecycleEvents(e => e.AddAndroid(a => a.OnBackPressed(...)))` registra mais um delegate de `AndroidLifecycle.OnBackPressed`. A verificação só checa se *algum* delegate existe, e o MAUI sempre registra o próprio `HandleWindowBackButtonPressed`, então o seu não acrescenta nada. Quando a página não pode consumir o voltar, o callback continua desativado e o seu delegate nunca roda.

**Sobrescritas de `OnKeyDown(Keycode.Back, ...)` e `OnBackPressed()` no `MainActivity` são código morto no Android 16.** O guia de predictive back do Google afirma que interceptar eventos de voltar a partir de `KEYCODE_BACK` "não é mais suportado". O checklist de migração em [como ter como alvo a API level 36 do Android a partir do .NET MAUI](/pt-br/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) cobre as outras sobrescritas que ficam em silêncio com o alvo 36.

**Toda sobrescrita custa a animação de volta para a tela inicial naquela página.** O MAUI decide pelo tipo, não pelo que a sua sobrescrita retorna. Assim que uma página declara `OnBackButtonPressed`, o callback é ativado naquela página mesmo que o método apenas retorne `base.OnBackButtonPressed()`. O mesmo vale para sobrescritas herdadas de uma classe base fora de `Microsoft.Maui.Controls`, então um `BasePage` compartilhado com uma sobrescrita inclui todas as páginas derivadas, e uma sobrescrita no `AppShell` inclui todas as páginas. A orientação do Android é ativar callbacks de voltar apenas para lógica de UI (confirmar alterações não salvas, fechar um popup dentro da página) e nunca para logging ou analytics. Coloque a sobrescrita na página mais restrita que precisa dela.

**`android:enableOnBackInvokedCallback="false"` não é uma correção.** Ele desativa as animações de predictive back e impede o `OnBackInvokedCallback` de funcionar. As chamadas de `OnBackPressedCallback`, que o MAUI usa, continuam funcionando. Da 10.0.70 à 10.0.90, ele por acaso faz o voltar do Android 16 passar de novo pelo caminho legado. Na 10.0.100 não resta nenhuma sobrescrita legada, então ele não muda nada na verificação da página raiz.

**Páginas modais nunca foram afetadas.** Uma pilha modal não vazia sempre ativa o callback, e é por isso que `protected override bool OnBackButtonPressed() => true;` em uma página modal continuou funcionando durante tudo isso. Veja [como mostrar uma janela modal no .NET MAUI 11](/pt-br/2026/08/how-to-show-a-modal-window-in-dotnet-maui-11/).

**Não faça fire and forget a partir da sobrescrita.** Retornar `true` e depois aguardar um diálogo é seguro porque `Dispatcher.Dispatch` roda a lambda na thread de UI. Um helper `async void` que lança exceção ainda derrubaria o processo. [Encontrar os handlers `async void` que causam ANRs em um app MAUI Android](/pt-br/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/) mostra como rastreá-los.

## Leitura relacionada

- A navegação de volta que carrega dados (`..?saved=true`) e as propriedades de `BackButtonBehavior`, incluindo o `AccessibilityLabel` do .NET MAUI 11, são abordadas em [parâmetros de rota e query properties do Shell no .NET MAUI 11](/pt-br/2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11/).
- O passo de predictive back da migração para a API 36, e a correção da 10.0.90 que restaurou a animação de volta para a tela inicial, estão em [migrar um app MAUI Android para ter como alvo a API level 36](/pt-br/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/).
- Engolir o voltar em uma página modal, e por que uma página modal não é uma janela modal, está em [como mostrar uma janela modal no .NET MAUI 11](/pt-br/2026/08/how-to-show-a-modal-window-in-dotnet-maui-11/).
- O padrão com dispatcher do passo 2 é a forma segura do código fire and forget dissecado em [encontrar handlers `async void` que causam ANRs](/pt-br/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/).

## Fontes

- [Navegação do Shell no .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/shell/navigation) (Microsoft Learn: `BackButtonBehavior`, `Navigating`, `ShellNavigationSource.Pop`, adiamento de navegação)
- [Add support for the predictive back gesture](https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture) (Android Developers: quando callbacks desativam a animação, `KEYCODE_BACK`, `enableOnBackInvokedCallback`)
- [dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223): `OnBackPressedCallback` condicionado para a animação de volta para a tela inicial
- [dotnet/maui#37709](https://github.com/dotnet/maui/pull/37709) e o backport para a 10.0.101 [#37729](https://github.com/dotnet/maui/pull/37729): `OnBackButtonPressed` em páginas raiz
- Relatos de regressão: [#37657](https://github.com/dotnet/maui/issues/37657) (abas do Shell), [#37706](https://github.com/dotnet/maui/issues/37706) (`ContentPage` raiz), [#38030](https://github.com/dotnet/maui/issues/38030) (`FlyoutPage`)
- Código-fonte nas tags de release: [`Window.cs` na 10.0.101](https://github.com/dotnet/maui/blob/10.0.101/src/Controls/src/Core/Window/Window.cs), [`MauiAppCompatActivity.cs` na 10.0.101](https://github.com/dotnet/maui/blob/10.0.101/src/Core/src/Platform/Android/MauiAppCompatActivity.cs), [`Shell.cs` na 10.0.101](https://github.com/dotnet/maui/blob/10.0.101/src/Controls/src/Core/Shell/Shell.cs) e [`Window.cs` na 11.0.100-rc.1.26458.5](https://github.com/dotnet/maui/blob/11.0.100-rc.1.26458.5/src/Controls/src/Core/Window/Window.cs)
