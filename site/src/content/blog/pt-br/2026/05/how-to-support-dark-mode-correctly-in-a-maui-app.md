---
title: "Como suportar o modo escuro corretamente em um aplicativo .NET MAUI"
description: "Modo escuro de ponta a ponta no .NET MAUI 11: AppThemeBinding, SetAppThemeColor, RequestedTheme, sobrescrita com UserAppTheme e persistência, o evento RequestedThemeChanged e os ajustes por plataforma do Info.plist e MainActivity que a documentação deixa passar."
pubDate: 2026-05-03
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "dark-mode"
  - "theming"
  - "how-to"
lang: "pt-br"
translationOf: "2026/05/how-to-support-dark-mode-correctly-in-a-maui-app"
translatedBy: "claude"
translationDate: 2026-05-03
---

Resposta curta: no .NET MAUI 11.0.0, vincule cada valor sensível ao tema com a extensão de marcação `AppThemeBinding`, organize as cores claras e escuras como chaves `StaticResource` em `App.xaml`, defina `Application.Current.UserAppTheme = AppTheme.Unspecified` na inicialização para que o app siga o sistema operacional, e persista qualquer sobrescrita do usuário através de `Preferences`. No Android você também precisa de `ConfigChanges.UiMode` em `MainActivity` para que a activity não seja destruída em uma troca de tema do sistema; no iOS, você precisa que o `Info.plist` não tenha a chave `UIUserInterfaceStyle` ou que ela esteja como `Automatic`, para que o sistema possa entregar tanto o claro quanto o escuro. Recorra a `Application.Current.RequestedThemeChanged` apenas quando precisar mutar algo de forma imperativa, porque a extensão de marcação já reavalia os bindings.

Este artigo percorre toda a superfície do suporte a tema do sistema no .NET MAUI 11.0.0 sobre .NET 11, incluindo as partes que mordem em produção: persistência entre reinicializações do app, configuração por plataforma de `Info.plist` e `MainActivity`, atualização dinâmica de recursos quando você troca `Application.Current.UserAppTheme`, cores da barra de status e da splash, e o evento `RequestedThemeChanged` que famosamente para de disparar se você esquecer a flag do manifesto. Cada trecho foi verificado contra `dotnet new maui` do SDK do .NET 11 com `Microsoft.Maui.Controls` 11.0.0.

## O que os sistemas operacionais realmente te dão

Modo escuro não é um único recurso, é a união de três comportamentos diferentes que entregam no nível do sistema operacional, e você precisa optar por cada um deles individualmente:

1. O sistema operacional reporta um tema atual. iOS 13+ expõe `UITraitCollection.UserInterfaceStyle`, Android 10 (API 29)+ expõe `Configuration.UI_MODE_NIGHT_MASK`, macOS 10.14+ expõe `NSAppearance`, Windows 10+ expõe `UISettings.GetColorValue(UIColorType.Background)` mais a chave de registro `app-mode`. O MAUI normaliza os quatro no enum `Microsoft.Maui.ApplicationModel.AppTheme`: `Unspecified`, `Light`, `Dark`.

2. O SO notifica o app quando o usuário aciona a chave. No iOS isso chega via `traitCollectionDidChange:`, no Android via `Activity.OnConfigurationChanged` (apenas se você optar, mais sobre isso abaixo), no Windows via `UISettings.ColorValuesChanged`. O MAUI expõe a união como o evento estático `Application.RequestedThemeChanged`.

3. O SO permite que o app sobrescreva o tema renderizado. iOS usa `UIWindow.OverrideUserInterfaceStyle`, Android usa `AppCompatDelegate.SetDefaultNightMode`, Windows usa `FrameworkElement.RequestedTheme`. O MAUI expõe a sobrescrita como a propriedade de leitura/escrita `Application.Current.UserAppTheme`.

Pular qualquer uma dessas camadas te dá a versão "parece bem no simulador e quebra no celular do usuário" do modo escuro. O resto deste artigo é como conectar as três camadas corretamente para que um app MAUI responda da forma esperada pelas convenções da plataforma.

## Defina recursos claros e escuros uma única vez no App.xaml

O padrão mais limpo é manter cada valor sensível ao tema como `StaticResource` em `App.xaml`, e então vincular através de `AppThemeBinding`. Colocar os recursos no escopo da aplicação significa que cada página enxerga a mesma paleta e você pode renomear uma única chave quando o design system muda.

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<?xml version = "1.0" encoding = "UTF-8" ?>
<Application xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             x:Class="HelloDarkMode.App">
    <Application.Resources>
        <ResourceDictionary>

            <!-- Light palette -->
            <Color x:Key="LightBackground">#FFFFFF</Color>
            <Color x:Key="LightSurface">#F5F5F7</Color>
            <Color x:Key="LightText">#0A0A0B</Color>
            <Color x:Key="LightAccent">#0066FF</Color>

            <!-- Dark palette -->
            <Color x:Key="DarkBackground">#0F1115</Color>
            <Color x:Key="DarkSurface">#1A1D23</Color>
            <Color x:Key="DarkText">#F2F2F2</Color>
            <Color x:Key="DarkAccent">#5B9BFF</Color>

            <Style TargetType="ContentPage" ApplyToDerivedTypes="True">
                <Setter Property="BackgroundColor"
                        Value="{AppThemeBinding Light={StaticResource LightBackground},
                                                Dark={StaticResource DarkBackground}}" />
            </Style>

            <Style TargetType="Label">
                <Setter Property="TextColor"
                        Value="{AppThemeBinding Light={StaticResource LightText},
                                                Dark={StaticResource DarkText}}" />
            </Style>

        </ResourceDictionary>
    </Application.Resources>
</Application>
```

`AppThemeBinding` é a forma de extensão de marcação da classe `AppThemeBindingExtension` em `Microsoft.Maui.Controls.Xaml`. Ela expõe três valores: `Default`, `Light`, `Dark`. O parser de XAML trata `Default=` como propriedade de conteúdo, então `{AppThemeBinding Red, Light=Green, Dark=Blue}` é uma forma abreviada legítima de "use vermelho a menos que o sistema seja claro ou escuro". Quando o tema do sistema muda, o MAUI percorre cada binding que aponta para uma `AppThemeBindingExtension`, reavalia, e empurra o novo valor pelo pipeline de propriedades vinculáveis. Você não escreve nenhum código para atualizar.

Para valores únicos que não merecem uma chave de recurso, escreva as cores em linha:

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<Border Stroke="{AppThemeBinding Light=#DDD, Dark=#333}"
        BackgroundColor="{AppThemeBinding Light={StaticResource LightSurface},
                                          Dark={StaticResource DarkSurface}}">
    <Label Text="Hello, theme" />
</Border>
```

Para imagens, a mesma extensão aceita referências a arquivos:

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<Image Source="{AppThemeBinding Light=logo_light.png, Dark=logo_dark.png}"
       HeightRequest="48" />
```

## Aplique temas a partir do code-behind

Quando você constrói views em C# ou as modifica após a construção, troque a extensão de marcação pelas extensões `SetAppThemeColor` e `SetAppTheme<T>` sobre `VisualElement`. Elas vivem em `Microsoft.Maui.Controls` e se comportam exatamente como a extensão de marcação: armazenam os dois valores, avaliam o tema atual e reavaliam a cada mudança de tema.

```csharp
// .NET MAUI 11.0.0, .NET 11
using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;

var label = new Label { Text = "Hello, theme" };
label.SetAppThemeColor(
    Label.TextColorProperty,
    light: Colors.Black,
    dark: Colors.White);

var image = new Image { HeightRequest = 48 };
image.SetAppTheme<FileImageSource>(
    Image.SourceProperty,
    light: "logo_light.png",
    dark: "logo_dark.png");
```

`SetAppTheme<T>` é a chamada certa para qualquer valor que não seja `Color`. Funciona com `FileImageSource`, `Brush`, `Thickness` e qualquer outro tipo que a propriedade alvo aceite. Não existe um `SetAppThemeBrush` ou `SetAppThemeThickness` separado, porque a versão genérica cobre todos.

## Detecte e sobrescreva o tema atual

`Application.Current.RequestedTheme` retorna o valor `AppTheme` resolvido a qualquer momento, levando em conta tanto o SO quanto qualquer sobrescrita de `UserAppTheme`. Recorra a ele com moderação: um único bool armazenado em uma viewmodel dizendo "estamos no escuro agora" é quase sempre um sinal de que você deveria estar usando `AppThemeBinding`.

```csharp
// .NET MAUI 11.0.0, .NET 11
AppTheme current = Application.Current!.RequestedTheme;
bool isDark = current == AppTheme.Dark;
```

Sobrescrever o tema é a contraparte dentro do app. `Application.Current.UserAppTheme` é de leitura/escrita e aceita o mesmo enum:

```csharp
// .NET MAUI 11.0.0, .NET 11
Application.Current!.UserAppTheme = AppTheme.Dark;     // force dark
Application.Current!.UserAppTheme = AppTheme.Light;    // force light
Application.Current!.UserAppTheme = AppTheme.Unspecified; // follow system
```

O setter dispara `RequestedThemeChanged`, o que significa que cada `AppThemeBinding` ativo reavalia imediatamente. Você não precisa reconstruir páginas, trocar dicionários de recursos ou disparar um flush de navegação.

A sobrescrita não sobrevive a uma reinicialização do app. Se você quer que a escolha do usuário persista entre execuções, persista-a através de `Microsoft.Maui.Storage.Preferences`:

```csharp
// .NET MAUI 11.0.0, .NET 11
public static class ThemeService
{
    private const string Key = "user_app_theme";

    public static void Apply()
    {
        var stored = (AppTheme)Preferences.Default.Get(Key, (int)AppTheme.Unspecified);
        Application.Current!.UserAppTheme = stored;
    }

    public static void Set(AppTheme theme)
    {
        Preferences.Default.Set(Key, (int)theme);
        Application.Current!.UserAppTheme = theme;
    }
}
```

Chame `ThemeService.Apply()` a partir de `App.OnStart` (ou no construtor de `App` logo depois de `InitializeComponent`) para que a sobrescrita esteja em vigor antes da primeira janela renderizar. Armazene o enum como `int` porque `Preferences` não tem uma sobrecarga tipada para enums arbitrários em todas as plataformas, e converter via `int` é portável.

## Notifique suas viewmodels quando o tema mudar

Quando você precisa reagir a uma mudança de tema em código, por exemplo para trocar um `GraphicsView` desenhado à mão ou para empurrar uma cor diferente para a `StatusBar`, assine `Application.Current.RequestedThemeChanged`:

```csharp
// .NET MAUI 11.0.0, .NET 11
public App()
{
    InitializeComponent();
    Application.Current!.RequestedThemeChanged += OnThemeChanged;
}

private void OnThemeChanged(object? sender, AppThemeChangedEventArgs e)
{
    AppTheme theme = e.RequestedTheme;
    UpdateStatusBar(theme);
    UpdateMapStyle(theme);
}
```

O handler do evento roda na thread principal. `AppThemeChangedEventArgs.RequestedTheme` é o novo tema resolvido, então você não precisa ler `Application.Current.RequestedTheme` de novo dentro do handler.

Se o evento nunca dispara no Android, sua `MainActivity` está sem a flag `UiMode`. O template padrão do Visual Studio a inclui, mas já vi projetos feitos à mão perderem isso durante uma migração do Xamarin.Forms. Adicione:

```csharp
// .NET MAUI 11.0.0, .NET 11, Platforms/Android/MainActivity.cs
[Activity(
    Theme = "@style/Maui.SplashTheme",
    MainLauncher = true,
    LaunchMode = LaunchMode.SingleTop,
    ConfigurationChanges =
        ConfigChanges.ScreenSize |
        ConfigChanges.Orientation |
        ConfigChanges.UiMode |       // load-bearing for dark mode
        ConfigChanges.ScreenLayout |
        ConfigChanges.SmallestScreenSize |
        ConfigChanges.Density)]
public class MainActivity : MauiAppCompatActivity { }
```

Sem `ConfigChanges.UiMode`, o Android destrói e recria a activity a cada mudança de tema do sistema, o que significa que o MAUI vê uma activity nova em vez de uma atualização de configuração, e o evento `RequestedThemeChanged` não dispara a partir da mesma instância de `Application`. O sintoma visível é que a primeira troca funciona, mas as trocas seguintes não fazem nada até o app ser morto.

## Configuração por plataforma que ninguém te conta

A superfície do MAUI é majoritariamente multiplataforma, mas o modo escuro tem pequenos botões específicos por plataforma que são fáceis de ignorar.

**iOS / Mac Catalyst.** Se `Info.plist` contém `UIUserInterfaceStyle` definido como `Light` ou `Dark`, o SO trava o app naquele modo de forma definitiva e `Application.RequestedTheme` retorna o valor travado para sempre. O template padrão do MAUI omite a chave, o que significa que o app segue o sistema. Se você precisa optar por sair explicitamente, use `Automatic`:

```xml
<!-- Platforms/iOS/Info.plist or Platforms/MacCatalyst/Info.plist -->
<key>UIUserInterfaceStyle</key>
<string>Automatic</string>
```

`Automatic` também é o valor certo se um desenvolvedor anterior definiu a chave como `Light` para "consertar" alguma coisa e depois esqueceu. Remover a chave inteiramente tem o mesmo efeito.

**Android.** Além da flag `ConfigChanges.UiMode`, a única coisa que você precisa verificar é se o tema do app herda de uma base DayNight em `Platforms/Android/Resources/values/styles.xml`. O template padrão do MAUI usa `Maui.SplashTheme` e `Maui.MainTheme`, e ambos estendem `Theme.AppCompat.DayNight.NoActionBar`. Se você customizou o tema da splash, mantenha o pai em um ancestral `DayNight` ou sua splash vai ficar clara para sempre mesmo quando o resto do app for para o escuro.

Para drawables que precisam de uma variante escura, coloque-os em `Resources/values-night/colors.xml` ou use as pastas qualificadoras de recurso `-night`. Qualquer coisa que flua através de `AppThemeBinding` não precisa disso, mas a arte nativa de splash e os ícones de notificação precisam.

**Windows.** Nenhuma alteração em `Package.appxmanifest` é necessária. O host Windows lê o tema do sistema através da propriedade `Application.RequestedTheme` do app WinUI, e a mecânica de `AppThemeBinding` do MAUI passa por ela automaticamente. Se você encontrar uma superfície somente Windows que não atualiza, pode forçar definindo `MauiWinUIApplication.Current.MainWindow.Content` para uma raiz nova, mas eu não precisei disso na 11.0.0.

## Barra de status, splash e outras superfícies nativas

Duas coisas não são cobertas por `AppThemeBinding` e tropeçam quase todo projeto na primeira vez:

- **A cor do texto/ícones da barra de status no Android e iOS** é controlada pela plataforma, não pelo fundo da página. No iOS, defina `UIViewController.PreferredStatusBarStyle` por página; no Android, defina `Window.SetStatusBarColor` a partir de `MainActivity`. O padrão multiplataforma mais simples é colocar o código por plataforma atrás de um bloco `ConditionalCompilation` no handler `RequestedThemeChanged` mostrado acima.

- **As splash screens** são renderizadas pelo SO antes do MAUI carregar, então não podem consumir `AppThemeBinding`. O template do Android entrega cores claras e noturnas separadas via `values/colors.xml` e `values-night/colors.xml`. iOS usa um único storyboard de lançamento, então você ou escolhe uma cor neutra que funciona nos dois modos ou fornece dois storyboards via a configuração `LaunchStoryboard`.

Se você precisa que um estilo de mapa customizado, paleta de gráfico ou conteúdo de `WebView` siga o tema, faça a troca em `RequestedThemeChanged`. Para mapas em particular, o [tutorial de cluster de pinos no MAUI 11](/pt-br/2026/04/dotnet-maui-11-map-pin-clustering/) mostra como manter o estado do controle de mapa em sincronia com transições de tema sem reconstruir o renderer.

## Cinco pegadinhas que vão comer uma tarde

**1. `Page.BackgroundColor` nem sempre atualiza ao mudar `UserAppTheme`.** O problema conhecido em [dotnet/maui#6596](https://github.com/dotnet/maui/issues/6596) significa que algumas propriedades perdem o passo de reavaliação quando você define `UserAppTheme` programaticamente. A solução confiável é definir o fundo da página através de um `Setter` de `Style` (como no exemplo de `App.xaml` acima) em vez de diretamente no elemento da página. Setters baseados em estilo reavaliam de forma confiável.

**2. `RequestedThemeChanged` dispara uma vez e depois fica em silêncio.** Esse é o sintoma de [dotnet/maui#15350](https://github.com/dotnet/maui/issues/15350), e no Android é quase sempre a flag `ConfigChanges.UiMode` faltando. No iOS, o sintoma equivalente aparece quando uma página modal está na pilha no momento da troca de tema do sistema; fechar e reabrir a modal restaura os eventos. Assinar uma vez em `App.xaml.cs` e manter a assinatura viva é o padrão seguro.

**3. `AppTheme.Unspecified` nem sempre volta para o SO no iOS.** Como rastreado em [dotnet/maui#23411](https://github.com/dotnet/maui/issues/23411), definir `UserAppTheme = AppTheme.Unspecified` após uma sobrescrita dura às vezes deixa a janela do iOS travada na sobrescrita anterior. A solução na 11.0.0 é definir `UIWindow.OverrideUserInterfaceStyle = UIUserInterfaceStyle.Unspecified` a partir de um `MauiUIApplicationDelegate` customizado depois que o MAUI definir `UserAppTheme`. Algumas linhas, e só é necessário se seu app expõe um botão de "seguir sistema" nas configurações.

**4. Controles customizados que cacheiam cores na construção ficam claros para sempre.** Se você cacheia um valor `Color` no construtor do seu controle (ou em um campo estático), ele nunca atualiza. Leia valores de tema de forma preguiçosa em `OnHandlerChanged` ou vincule-os através do pipeline de propriedades vinculáveis para que a mecânica de `AppThemeBinding` do MAUI possa reavaliá-los.

**5. Hot reload nem sempre reflete mudanças de tema.** Quando você alterna o simulador ou emulador de claro para escuro com o app suspenso, o hot reload às vezes serve o recurso cacheado. Force uma recompilação completa após alternar o tema do sistema durante o desenvolvimento. Isso é um artefato de tooling, não um bug do `AppThemeBinding`, e diagnosticar problemas reais fica muito mais fácil quando você remove isso como variável.

## Onde o modo escuro encontra o resto do framework

Modo escuro é o recurso de tematização mais fácil que o MAUI entrega e o que a documentação cobre com mais profundidade, mas interage com outras duas partes do framework que você provavelmente vai tocar na mesma semana. O padrão de customização de handler de [como mudar a cor do ícone do SearchBar no .NET MAUI](/pt-br/2025/04/how-to-change-searchbars-icon-color-in-net-maui/) é a forma certa quando você tem um controle cuja parte nativa ignora `TextColor` no modo escuro (o `UISearchBar` do iOS é o ofensor canônico). Para o tour da configuração por plataforma, o post [novidades no .NET MAUI 10](/pt-br/2025/04/whats-new-in-net-maui-10/) cobre as adições de `Window` e `MauiWinUIApplication` que chegaram no MAUI 10 e ainda são os ganchos certos na 11.0.0. Se você está empacotando controles sensíveis ao tema dentro de uma biblioteca de classes, [como registrar handlers em uma biblioteca MAUI](/pt-br/2023/11/maui-library-register-handlers/) percorre a mecânica de `MauiAppBuilder`, incluindo as regras de ordem de operações que determinam quando um handler vê o tema resolvido. E se seu trabalho de modo escuro está acontecendo dentro de um build somente desktop, a [configuração de MAUI 11 só para Windows e macOS](/pt-br/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) mostra como descartar os alvos de Android e iOS para você só ter que depurar duas plataformas em vez de quatro.

## Links das fontes

- [Respond to system theme changes - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/system-theme-changes?view=net-maui-10.0)
- [AppThemeBindingExtension Class - Microsoft.Maui.Controls.Xaml](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.xaml.appthemebindingextension)
- [Application.UserAppTheme Property - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.application.userapptheme?view=net-maui-9.0)
- [AppTheme Enum - Microsoft.Maui.ApplicationModel](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.applicationmodel.apptheme)
- [Preferences - Microsoft.Maui.Storage](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/storage/preferences)
- [MAUI sample: Respond to system theme changes](https://learn.microsoft.com/en-us/samples/dotnet/maui-samples/userinterface-systemthemes/)
