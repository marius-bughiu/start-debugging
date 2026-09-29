---
title: "Correção: ícones da barra de status do Android ficam ilegíveis após habilitar UseMaterial3 no .NET MAUI 10"
description: "O MAUI 10.0.100 escolhe a cor dos ícones da barra de status a partir de colorPrimary, que tem o brilho oposto ao da superfície do Material 3, resultando em branco sobre branco ou preto sobre preto. Atualize Microsoft.Maui.Controls para 10.0.101 ou posterior, ou redefina AppearanceLightStatusBars em MainActivity."
pubDate: 2026-09-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "android"
  - "material-3"
  - "csharp"
lang: "pt-br"
translationOf: "2026/09/fix-android-status-bar-icons-unreadable-after-enabling-usematerial3-in-maui-10"
translatedBy: "claude"
translationDate: 2026-09-29
---

Se o seu app .NET MAUI 10 mostra ícones brancos de relógio e bateria sobre uma barra de status branca no modo claro, e ícones pretos sobre uma barra de status preta no modo escuro, logo depois de você definir `<UseMaterial3>true</UseMaterial3>`, você está no `Microsoft.Maui.Controls` 10.0.100. Essa versão passou a escolher a cor dos ícones da barra de status a partir da luminância do `colorPrimary` do tema. O Material 3 desenha `colorSurface` atrás da barra de status transparente edge-to-edge, e as cores primária e de superfície do Material 3 sempre têm brilho oposto, então os ícones saem invertidos. A correção é atualizar para 10.0.101 ou posterior (10.0.110 é a atual, lançada em 2026-09-22). Se você ainda não pode atualizar, defina `AppearanceLightStatusBars` você mesmo em `MainActivity` depois de `base.OnCreate`. No .NET 11 RC 1 a janela principal fica correta, mas as páginas modais ainda mostram o bug; o RC 2 traz a correção.

## O erro em contexto

Não há exceção nem nada no log. O sintoma é visual, e aparece assim no Android 15, 16 e 17 com edge-to-edge (que o .NET MAUI 10 habilita para API 30+):

```text
// .NET 10, Microsoft.Maui.Controls 10.0.100, <UseMaterial3>true</UseMaterial3>
Light mode: status bar background near-white (Material 3 surface), icons and clock white
Dark mode:  status bar background near-black (Material 3 surface), icons and clock black
```

O relatório é o [dotnet/maui#37705](https://github.com/dotnet/maui/issues/37705), com os rótulos `i/regression` e `regressed-in-10.0.100`. Voltar para a 10.0.90 torna os ícones legíveis de novo, a primeira pista de que se trata de uma mudança do MAUI e não de algo no seu tema.

Veja o que cada versão faz, conforme lido em `WindowExtensions.cs` e no handler da janela em cada tag de release:

| Microsoft.Maui.Controls | Como a cor dos ícones da barra de status é escolhida | Resultado no Material 3 |
| --- | --- | --- |
| 10.0.90 e anteriores | Dia/noite: tema claro recebe ícones escuros | Legível |
| 10.0.100 (2026-08-20) | Luminância de `android:colorPrimary` | Invertido, ilegível |
| 10.0.101 (2026-09-07), 10.0.110 | Luminância de `colorSurface` para Material 3, `colorPrimary` para Material 2 | Legível |
| 11.0 RC 1 | `colorPrimary`, depois sobrescrito por `Window.StatusBarTheme` (padrão: dia/noite) somente na janela principal | Janela principal legível, páginas modais invertidas |
| Branch do 11.0 RC 2 | Igual à 10.0.101 | Legível |

## Por que os ícones invertem: colorPrimary vs colorSurface

O Android não deixa o app escolher uma cor exata para os ícones da barra de status. Ele oferece um booleano: `WindowInsetsControllerCompat.AppearanceLightStatusBars`. Quando é `true`, o sistema assume que o fundo da barra de status é claro e desenha ícones escuros. Quando é `false`, desenha ícones claros.

Até a 10.0.90, o MAUI definia esse flag apenas a partir do modo dia/noite:

```csharp
// .NET MAUI 10.0.90, src/Core/src/Platform/Android/WindowExtensions.cs
var configuration = activity.Resources?.Configuration;
var isLightTheme = configuration is null ||
    (configuration.UiMode & UiMode.NightMask) != UiMode.NightYes;

windowInsetsController.AppearanceLightStatusBars = isLightTheme;
windowInsetsController.AppearanceLightNavigationBars = isLightTheme;
```

Isso funciona quando o que fica atrás da barra de status acompanha o modo dia/noite, e quebra quando não acompanha. O [dotnet/maui#32987](https://github.com/dotnet/maui/issues/32987) foi o segundo caso: um app Material 2 com tema claro e uma app bar com `colorPrimary` preto sob a barra de status recebia ícones escuros sobre uma barra escura. A correção, [dotnet/maui#36214](https://github.com/dotnet/maui/pull/36214), foi integrada em 2026-07-01 e lançada na 10.0.100. Ela resolve `android:colorPrimary` a partir do tema atual e usa a luminância dele no lugar:

```csharp
// .NET MAUI 10.0.100, src/Core/src/Platform/Android/WindowExtensions.cs
if (TryGetThemeColor(activity, global::Android.Resource.Attribute.ColorPrimary, out var statusBarColor))
    windowInsetsController.AppearanceLightStatusBars = IsLightColor(statusBarColor);
else
    windowInsetsController.AppearanceLightStatusBars = isLightTheme;

// ...
static bool IsLightColor(AColor color) =>
    ColorUtils.CalculateLuminance(color.ToArgb()) > 0.5;
```

Para uma app bar do Material 2 pintada com `colorPrimary`, isso está correto. Para o Material 3 é exatamente o contrário. Com `UseMaterial3` ativado, o MAUI troca o tema da activity para `Maui.Material3.Theme.NoActionBar`, cujo pai é `Theme.Material3.DayNight`. Os estilos Material 3 do próprio MAUI não sobrescrevem a cor primária, então você recebe a paleta base do Material 3. O Material 3 coloca a cor de superfície atrás da barra de status, não a cor primária, e a paleta é projetada para que a primária contraste com a superfície:

| Tema | `colorPrimary` | Luminância relativa | A 10.0.100 decide | Fundo real |
| --- | --- | --- | --- | --- |
| Claro | `#6750A4` | 0.11 (escuro) | Ícones claros | Superfície quase branca |
| Escuro | `#D0BCFF` | 0.57 (claro) | Ícones escuros | Superfície quase preta |

O roxo `#512BD4` do template em `Platforms/Android/Resources/values/colors.xml` não salva você: esse recurso de cor alimenta o `Maui.MainTheme` do Material 2, não o tema Material 3, e de qualquer forma é escuro (luminância 0.08). Qualquer paleta Material 3 de tema claro com uma primária saturada acaba no mesmo lugar.

A correção da 10.0.101, [dotnet/maui#37710](https://github.com/dotnet/maui/pull/37710) com backport para o branch SR10 como [dotnet/maui#37730](https://github.com/dotnet/maui/pull/37730), mantém a ideia da luminância, mas lê o atributo que de fato fica atrás da barra:

```csharp
// .NET MAUI 10.0.101 and 10.0.110, src/Core/src/Platform/Android/WindowExtensions.cs
internal static bool GetStatusBarAppearance(Context context, bool isLightTheme, bool isMaterial3)
{
    // Material 3 draws its surface behind the transparent edge-to-edge status bar.
    // The Material 2 app bar uses colorPrimary in the same area.
    var backgroundAttribute = isMaterial3
        ? Resource.Attribute.colorSurface
        : global::Android.Resource.Attribute.ColorPrimary;

    return TryGetThemeColor(context, backgroundAttribute, out var backgroundColor)
        ? IsLightColor(backgroundColor)
        : isLightTheme;
}
```

## Repro mínimo

Comece pelo template padrão e fixe o pacote afetado:

```xml
<!-- .NET 10 SDK, dotnet new maui, MyApp.csproj -->
<PropertyGroup>
  <TargetFrameworks>net10.0-android;net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
  <UseMaterial3>true</UseMaterial3>
</PropertyGroup>

<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="10.0.100" />
</ItemGroup>
```

Execute em um emulador Android 11 (API 30) ou mais recente. Os ícones da barra de status ficam brancos na página inicial no modo claro. Mude o emulador para o modo escuro, reinicie o app, e eles ficam pretos. Troque `10.0.100` por `10.0.90` e os dois modos ficam legíveis. Troque por `10.0.110` e os dois modos ficam legíveis novamente.

Se você quer confirmar o que o MAUI decidiu em vez de apertar os olhos no emulador, registre o flag no log após a inicialização:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.100, Platforms/Android/MainActivity.cs
protected override void OnResume()
{
    base.OnResume();
    var controller = AndroidX.Core.View.WindowCompat.GetInsetsController(Window!, Window!.DecorView);
    Android.Util.Log.Info("StatusBar", $"AppearanceLightStatusBars={controller.AppearanceLightStatusBars}");
}
```

No modo claro na 10.0.100 você verá `False`, significando "o fundo é escuro, desenhe ícones claros", sobre uma superfície quase branca.

## Correção 1: atualize Microsoft.Maui.Controls para 10.0.101 ou posterior

Esta é a correção de verdade, e é uma versão de patch na mesma linha do .NET 10, então não há mudança de target framework. Defina a versão explicitamente em vez de depender de `$(MauiVersion)` do workload que estiver instalado na máquina de build:

```xml
<!-- .NET 10, MyApp.csproj -->
<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="10.0.110" />
</ItemGroup>
```

O código alterado fica em `Microsoft.Maui.Core`, que o `Microsoft.Maui.Controls` traz na mesma versão. Se o seu projeto também referencia `Microsoft.Maui.Core` ou `Microsoft.Maui.Controls.Compatibility` diretamente, atualize-os para a mesma versão, ou o NuGet pode resolver um conjunto misto. `dotnet list package --include-transitive` mostra o que você realmente obteve.

Depois faça clean e recompile. Mudanças de recursos e de tema do Android são fáceis de passar despercebidas em um deploy incremental, então desinstale o app do dispositivo uma vez (`adb uninstall com.companyname.myapp`) antes de avaliar o resultado.

A 10.0.110 também traz a correção da [UIKitThreadAccessException de MediaPicker.PickPhotosAsync](/pt-br/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/), outra regressão da 10.0.100, então há poucos motivos para ficar na 10.0.100. Uma ressalva no sentido contrário: a 10.0.101 e a 10.0.110 têm um problema no Resizetizer com [ícones de app SVG que usam elementos filter ou text](/pt-br/2026/09/fix-maui-resizetizer-mauir0001-missingmethodexception-svg-filter-text/). Verifique o seu ícone antes de atualizar um branch de release.

## Correção 2: redefina AppearanceLightStatusBars em MainActivity

Se você está preso à 10.0.100 por enquanto, sobrescreva o flag você mesmo. `MauiAppCompatActivity.OnCreate` chama `CreatePlatformWindow`, que conecta o `WindowHandler`, que executa `ConfigureTranslucentSystemBars` e grava o valor errado. Tudo isso acontece dentro de `base.OnCreate`, então qualquer coisa que você definir depois dessa chamada prevalece na janela principal:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.100, Platforms/Android/MainActivity.cs
using Android.App;
using Android.Content.PM;
using Android.Content.Res;
using Android.OS;
using AndroidX.Core.View;

namespace MyApp;

[Activity(Theme = "@style/Maui.SplashTheme", MainLauncher = true, LaunchMode = LaunchMode.SingleTop,
    ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation | ConfigChanges.UiMode |
                           ConfigChanges.ScreenLayout | ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
public class MainActivity : MauiAppCompatActivity
{
    protected override void OnCreate(Bundle? savedInstanceState)
    {
        // MAUI sets the status bar appearance inside base.OnCreate. Correct it afterwards.
        base.OnCreate(savedInstanceState);
        ApplyStatusBarIconContrast(Resources?.Configuration);
    }

    public override void OnConfigurationChanged(Configuration newConfig)
    {
        base.OnConfigurationChanged(newConfig);
        ApplyStatusBarIconContrast(newConfig);
    }

    void ApplyStatusBarIconContrast(Configuration? configuration)
    {
        // MAUI only configures edge-to-edge system bars on API 30+, so mirror that.
        if (!OperatingSystem.IsAndroidVersionAtLeast(30) || Window is null)
            return;

        var isNight = configuration is not null &&
            (configuration.UiMode & UiMode.NightMask) == UiMode.NightYes;

        // true means "light background": Android draws dark icons.
        WindowCompat.GetInsetsController(Window, Window.DecorView)
            .AppearanceLightStatusBars = !isNight;
    }
}
```

Isso restaura o comportamento da 10.0.90. O override de `OnConfigurationChanged` importa porque o `ConfigurationChanges` do template inclui `ConfigChanges.UiMode`: quando o usuário alterna o tema do sistema, o Android não recria a activity, e o MAUI 10 só define o flag quando o window handler se conecta. Sem o override, os ícones mantêm a cor do modo anterior até a próxima inicialização a frio.

Remova esse override quando migrar para a 10.0.101 ou posterior. A correção embutida deriva o flag do seu `colorSurface` real, o que é mais preciso que dia/noite se você personaliza a cor da superfície.

## Correção 3: no .NET 11, use Window.StatusBarTheme

O .NET 11 adicionou `Window.StatusBarTheme` ([dotnet/maui#34903](https://github.com/dotnet/maui/pull/34903)), um enum com `Default`, `Light` e `Dark`. No RC 1, `WindowHandler.ConnectHandler` chama `ConfigureTranslucentSystemBars` (que ainda tem a lógica de `colorPrimary`) e em seguida aplica `StatusBarTheme` imediatamente. `Default` recorre ao dia/noite, então a janela principal de um app .NET 11 RC 1 fica legível sem você fazer nada.

As páginas modais são diferentes. `ModalNavigationManager` exibe cada modal em sua própria janela de diálogo e chama `ConfigureTranslucentSystemBars` nela, mas não aplica `StatusBarTheme` depois. Então, no RC 1, uma página aberta com `Navigation.PushModalAsync` recebe os ícones invertidos de volta. A correção está no branch `release/11.0.1xx-rc2`, então o RC 2 resolve os dois casos.

`StatusBarTheme` também é a ferramenta certa quando a sua página coloca algo diferente da superfície atrás da barra de status, como uma imagem hero escura em um tema claro:

```csharp
// .NET 11 RC 1, Microsoft.Maui.Controls 11.0.0-rc.1.26451.6, App.xaml.cs
protected override Window CreateWindow(IActivationState? activationState)
{
    var window = new Window(new AppShell());

    // Light = light status bar background, so Android draws dark icons.
    window.SetAppTheme(Window.StatusBarThemeProperty, StatusBarTheme.Light, StatusBarTheme.Dark);

    return window;
}
```

Ou por página, quando uma única tela precisa de ícones claros sobre um cabeçalho escuro, defina na janela da página e restaure quando a página sair:

```csharp
// .NET 11 RC 1, Microsoft.Maui.Controls 11.0.0-rc.1.26451.6, HeroPage.xaml.cs
protected override void OnAppearing()
{
    base.OnAppearing();
    if (Window is not null)
        Window.StatusBarTheme = StatusBarTheme.Dark;
}

protected override void OnDisappearing()
{
    base.OnDisappearing();
    if (Window is not null)
        Window.StatusBarTheme = StatusBarTheme.Default;
}
```

Observe a nomenclatura: `StatusBarTheme` descreve a barra, não os ícones. `Dark` significa "a barra é escura", o que produz ícones claros, a mesma convenção de `AppearanceLightStatusBars`.

## Pegadinhas e casos parecidos

**Apps Material 2 podem sofrer o espelho do problema.** A 10.0.101 e a 10.0.110 ainda derivam a barra de status do Material 2 a partir de `colorPrimary`, de propósito, porque a app bar do Material 2 é pintada com ele. Se o seu app Material 2 oculta a barra de navegação (`Shell.NavBarIsVisible="False"`) e mostra uma página branca sob a barra de status enquanto `colorPrimary` é escuro, o código escolherá ícones claros sobre branco. Isso decorre do mesmo código-fonte e não é rastreado como bug, já que o layout padrão do Material 2 mantém a app bar sob a barra de status. O override em `MainActivity` da Correção 2 resolve.

**Os ícones da barra de navegação não são afetados.** Todas as versões acima ainda definem `AppearanceLightNavigationBars` a partir do dia/noite. Se a sua barra de gestos ou a barra de 3 botões está ilegível, é outro problema, geralmente conteúdo desenhado sob a barra após as [mudanças de edge-to-edge da API 36](/pt-br/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/).

**Android 10 e anteriores parecem normais.** O MAUI só executa esse código na API 30 e superiores. Abaixo disso, o window handler nunca chama `ConfigureTranslucentSystemBars`, então testar em um emulador antigo não reproduz o bug.

**Definir a cor da barra de status não faz nada no Android 15+.** Uma primeira reação comum é chamar `Window.SetStatusBarColor(...)` a partir de `MainActivity`. Em apps que têm como alvo a API 35 ou superior rodando no Android 15 e posterior, o edge-to-edge é obrigatório e essa chamada é ignorada. A barra continua transparente, e por isso o flag de aparência dos ícones é a única alavanca que importa aqui.

**Não é a sua configuração de modo escuro.** Se os ícones estão errados apenas após uma mudança de `Application.Current.UserAppTheme` em tempo de execução, e corretos após uma inicialização a frio, é a reaplicação ausente descrita na Correção 2, não esta regressão. [Como oferecer suporte correto ao modo escuro em um app MAUI](/pt-br/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) cobre o resto das superfícies nativas que não seguem `AppThemeBinding`.

## Relacionados

- [O .NET MAUI 10 SR6 conclui o Material 3 no Android por trás de um único flag UseMaterial3](/pt-br/2026/05/maui-10-material-3-android-usematerial3-flag/) explica o que o flag muda e quais controles ele estiliza.
- [Migre um app Android .NET MAUI para a API level 36 do Android](/pt-br/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) para as mudanças de edge-to-edge e de safe area que tornam a barra de status transparente logo de início.
- [Como oferecer suporte correto ao modo escuro em um app MAUI](/pt-br/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) para cores adaptadas ao tema e para reagir a `RequestedThemeChanged`.
- [Correção: .NET MAUI Resizetizer MissingMethodException (MAUIR0001) em um ícone de app SVG](/pt-br/2026/09/fix-maui-resizetizer-mauir0001-missingmethodexception-svg-filter-text/) antes de atualizar para a 10.0.101 ou 10.0.110.

## Fontes

- [dotnet/maui#37705: Status bar icons become unreadable when UseMaterial3 is enabled in 10.0.100](https://github.com/dotnet/maui/issues/37705)
- [dotnet/maui#36214: Fix status bar icon contrast with custom colorPrimary](https://github.com/dotnet/maui/pull/36214) (a mudança que introduziu a regressão)
- [dotnet/maui#37710: Fix Material 3 status bar icon contrast](https://github.com/dotnet/maui/pull/37710) e o backport da 10.0.101 [dotnet/maui#37730](https://github.com/dotnet/maui/pull/37730)
- [dotnet/maui#34903: Add Window.StatusBarTheme](https://github.com/dotnet/maui/pull/34903)
- [`WindowExtensions.cs` na tag 10.0.100](https://github.com/dotnet/maui/blob/10.0.100/src/Core/src/Platform/Android/WindowExtensions.cs) e [na tag 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Core/src/Platform/Android/WindowExtensions.cs)
- [`styles-material3.xml` na tag 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Core/src/Platform/Android/Resources/values/styles-material3.xml)
- [WindowInsetsControllerCompat.setAppearanceLightStatusBars (Android Developers)](https://developer.android.com/reference/androidx/core/view/WindowInsetsControllerCompat#setAppearanceLightStatusBars(boolean))
- [Microsoft.Maui.Controls no NuGet](https://www.nuget.org/packages/Microsoft.Maui.Controls) para datas de lançamento
