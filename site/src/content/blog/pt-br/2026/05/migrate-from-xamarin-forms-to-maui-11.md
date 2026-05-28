---
title: "Migrar do Xamarin.Forms 5.0 para o .NET MAUI 11: a lista completa"
description: "Migração de ponta a ponta do Xamarin.Forms 5.0 para o .NET MAUI 11 GA em net11.0, cobrindo a reescrita do csproj, a conversão de renderers customizados para handlers, o cabeamento do AppShell, a remoção do DependencyService, a aposentadoria do MessagingCenter, os recursos do Resizetizer e as ciladas que pegam um código de produção de verdade."
pubDate: 2026-05-28
updatedDate: 2026-05-28
tags:
  - "migration"
  - "xamarin"
  - "xamarin-forms"
  - "maui"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/05/migrate-from-xamarin-forms-to-maui-11"
translatedBy: "claude"
translationDate: 2026-05-28
---

O Xamarin.Forms ficou sem suporte em 2024-05-01 e a Microsoft não publicou uma única correção desde então. O .NET MAUI 11 é o destino LTS para toda app Xamarin.Forms 5.0 que vem vivendo de tempo emprestado, e a partir do MAUI 11.0 GA em novembro de 2025 a plataforma finalmente tem o encanamento de renderer, o desempenho de `RecyclerView` e o suporte a iOS 18 / Android 15 que os primeiros lançamentos do MAUI não tinham. Uma migração focada de um desenvolvedor para uma app média, de dez a vinte telas com um punhado de renderers customizados, leva entre uma e três semanas. As partes difíceis não são XAML nem o sistema de build; são os renderers customizados, o `DependencyService` e qualquer código que tocou os projetos de plataforma diretamente. Este post fixa `Xamarin.Forms 5.0.0.2622` como origem e `.NET MAUI 11.0.0` em `net11.0` como destino, com `net11.0-android35.0`, `net11.0-ios18.0` e `net11.0-maccatalyst18.0` como os TFMs ativos.

O rollback não é trivial: uma vez que o `.csproj` muda para o estilo SDK com `Microsoft.NET.Sdk` e `UseMaui=true`, você não volta para um projeto compartilhado do Xamarin.Forms sem restaurar o csproj original e o packages.config do controle de versão. Trate a migração como uma viagem só de ida e organize as branches conforme isso.

## Por que migrar agora

- O Xamarin.Forms não tem suporte. Não há patches para o ajuste de target SDK do Android 15 que o Google Play começou a exigir em 2025-08-31, e a Apple agora rejeita builds linkadas contra o SDK legado do iOS 17 no App Store Connect.
- O MAUI 11 roda em CoreCLR no Android e iOS por padrão, não em Mono. A inicialização fria em um Pixel 8 cai de cerca de 1.6 s para 0.9 s em uma app Shell padrão, e as alocações em regime caem porque o GC é geracional em vez de `SGen`. A mudança está coberta em [nosso artigo sobre CoreCLR por padrão no MAUI](/pt-br/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/).
- A arquitetura de handlers substitui os renderers customizados com uma superfície menor e evita os apêndices de `Effect` mais `PlatformEffect` que o Xamarin.Forms acumulou ao longo da vida.
- O Resizetizer vem embutido. O pipeline `Resources/Images/*.svg` gera os PNGs específicos de plataforma em tempo de build, então você finalmente deleta o zoológico de `drawable-xhdpi`, `drawable-xxhdpi`, `Assets.xcassets` e `LaunchScreen.storyboard`.

## O que quebra

| Área                     | Mudança                                                                       | Severidade |
| ------------------------ | ----------------------------------------------------------------------------- | ---------- |
| Layout do projeto        | Projeto compartilhado mais três projetos head colapsam em um csproj SDK       | alta       |
| Namespace `Xamarin.Forms`| Substituído por `Microsoft.Maui.Controls`, `Microsoft.Maui.Graphics`, etc.    | alta       |
| Renderers customizados   | `ExportRenderer` e `IVisualElementRenderer` removidos. Use handlers           | alta       |
| `DependencyService`      | Removido. Use `Microsoft.Extensions.DependencyInjection`                      | alta       |
| `MessagingCenter`        | Obsoleto e marcado para remoção. Use [`IMessenger` do CommunityToolkit.Mvvm](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/mvvm/messenger) | alta |
| `Application.Properties` | Removido. Use `Microsoft.Maui.Storage.Preferences`                            | média      |
| `ListView`               | Wrapper sobre `CollectionView`. Melhor migrar, ver [o guia de ListView para CollectionView](/pt-br/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) | média |
| `MasterDetailPage`       | Renomeado para `FlyoutPage`. O XAML precisa ser atualizado                    | baixa      |
| `Frame`                  | Quase-obsoleto. Use `Border` mais `StrokeShape`                               | baixa      |
| `OpenGLView`             | Removido por completo                                                         | baixa      |
| `MainActivity` Android   | Divide em `MainActivity.cs` mais `MainApplication.cs`, ambos parciais         | média      |
| `AppDelegate` iOS        | Substitui `FormsApplicationDelegate` por `MauiUIApplicationDelegate`          | média      |
| `App.xaml.cs`            | `Application.MainPage` funciona no MAUI 11 mas Shell-first é o novo padrão    | baixa      |
| Targeting                | `MonoAndroid12.0`, `Xamarin.iOS10` desapareceram. Só `net11.0-android35.0`    | alta       |

O upgrade assistant upstream é distribuído como `dotnet tool` e cobre uma fração relevante das reescritas de namespace e da conversão do arquivo de projeto. Ele não cuida de renderers customizados nem de registros de `DependencyService`, que é onde o tempo realmente vai.

## Checklist de pré-voo

1. Instale o SDK do .NET 11 e os workloads do MAUI. Verifique com `dotnet workload list`. Você quer `maui`, `maui-android`, `maui-ios` e `maui-maccatalyst` todos na versão `11.0.x`.

   ```bash
   # .NET 11.0
   dotnet workload install maui
   dotnet workload list
   ```

2. Fixe o SDK no `global.json` para que a branch de migração não role para frente sozinha no meio do PR:

   ```json
   // global.json, repo root
   {
     "sdk": {
       "version": "11.0.100",
       "rollForward": "latestFeature"
     }
   }
   ```

3. Marque o build atual do Xamarin.Forms no controle de versão. `git tag pre-maui-migration` é suficiente. Se a migração descarrilar na segunda semana, você quer um ponto limpo para restaurar.
4. Tire um snapshot dos recursos de plataforma. Percorra as pastas `Drawable*`, `Assets.xcassets`, os storyboards de splash e as entradas de Info.plist / AndroidManifest.xml. O Resizetizer reorganiza toda essa árvore e você quer um inventário do estado anterior caso um recurso seja perdido.
5. Inventarie os registros de `DependencyService`. `grep -rn "DependencyService\\|Dependency(typeof" .` devolve a lista exaustiva. Cada um vira uma chamada `services.AddSingleton` ou `services.AddTransient`.
6. Inventarie os renderers customizados. Procure por `ExportRenderer` e leia cada um. Alguns podem ser deletados direto (os defaults do MAUI são melhores que os do Xamarin.Forms), outros viram handlers, outros viram `Behaviors`.
7. Rode `dotnet test` na árvore do Xamarin.Forms e guarde o verde de referência. Uma migração que introduz três regressões de teste é muito mais fácil de diagnosticar do que uma que pousa numa base que já tinha cinco testes flaky.

## Passos de migração

1. **Rode o upgrade assistant no projeto compartilhado primeiro.** Ele reescreve o csproj para SDK-style, atualiza os namespaces mais óbvios (`Xamarin.Forms` → `Microsoft.Maui.Controls`) e sinaliza os pontos de renderer e `DependencyService` que ele não consegue tratar.

   ```bash
   # .NET 11
   dotnet tool install -g upgrade-assistant
   upgrade-assistant upgrade ./src/MyApp/MyApp.csproj --target-tfm net11.0
   ```

   Verificação: `dotnet restore` tem sucesso no novo csproj e `git status` mostra as reescritas esperadas. Não rode ainda nos projetos head; você está prestes a apagá-los.

2. **Colapse os projetos head em um único csproj SDK-style.** O Xamarin.Forms se distribui como um projeto compartilhado mais `MyApp.Android`, `MyApp.iOS` e opcionalmente `MyApp.UWP`. O MAUI se distribui como um csproj com multi-targeting. Mova o código específico do Android para `Platforms/Android/`, o do iOS para `Platforms/iOS/` e apague os csproj head. O cabeçalho do novo csproj fica assim:

   ```xml
   <!-- src/MyApp/MyApp.csproj, .NET MAUI 11, net11.0 -->
   <Project Sdk="Microsoft.NET.Sdk">
     <PropertyGroup>
       <TargetFrameworks>net11.0-android35.0;net11.0-ios18.0;net11.0-maccatalyst18.0</TargetFrameworks>
       <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net11.0-windows10.0.19041.0</TargetFrameworks>
       <OutputType>Exe</OutputType>
       <UseMaui>true</UseMaui>
       <SingleProject>true</SingleProject>
       <ImplicitUsings>enable</ImplicitUsings>
       <Nullable>enable</Nullable>
       <RootNamespace>MyApp</RootNamespace>
       <ApplicationId>net.mycompany.myapp</ApplicationId>
       <ApplicationDisplayVersion>1.0</ApplicationDisplayVersion>
       <ApplicationVersion>1</ApplicationVersion>
     </PropertyGroup>
   </Project>
   ```

   Verificação: `dotnet build -t:Restore` tem sucesso e o projeto abre no Visual Studio 2026 17.14 ou Rider 2026.1 sem avisos de "tipo de projeto não suportado".

3. **Reescreva `App.xaml.cs` para usar `MauiProgram.CreateMauiApp`.** O Xamarin.Forms inicializava em `MainActivity.OnCreate` via `LoadApplication(new App())`. O MAUI passa isso para o `MauiAppBuilder`. O ponto de entrada vira:

   ```csharp
   // MauiProgram.cs, .NET MAUI 11, C# 14
   using Microsoft.Extensions.Logging;
   using Microsoft.Maui.Hosting;

   namespace MyApp;

   public static class MauiProgram
   {
       public static MauiApp CreateMauiApp()
       {
           var builder = MauiApp.CreateBuilder();
           builder
               .UseMauiApp<App>()
               .ConfigureFonts(fonts =>
               {
                   fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
                   fonts.AddFont("OpenSans-Semibold.ttf", "OpenSansSemibold");
               });

           builder.Services.AddSingleton<IAuthService, AuthService>();
           builder.Services.AddTransient<MainPageViewModel>();

           return builder.Build();
       }
   }
   ```

   Verificação: `dotnet build -f net11.0-android35.0` sai com 0 e a IDE resolve `MauiProgram` a partir de qualquer construtor de página.

4. **Converta todo registro de `DependencyService` para `IServiceCollection`.** Isso é mecânico mas obrigatório; `DependencyService.Get<T>()` saiu de cena no MAUI 11. A substituição:

   ```csharp
   // Before, Xamarin.Forms 5.0
   DependencyService.Register<IAuthService, AuthService>();
   var auth = DependencyService.Get<IAuthService>();

   // After, .NET MAUI 11
   // Registration moves to MauiProgram.CreateMauiApp (step 3).
   // Resolution moves to the constructor or to IPlatformApplication.Current.Services.
   public partial class MainPage : ContentPage
   {
       public MainPage(IAuthService auth) // injected
       {
           InitializeComponent();
       }
   }
   ```

   Para lugares onde injeção por construtor é impraticável (um helper estático, um handler de `AppShell`), `IPlatformApplication.Current!.Services.GetRequiredService<IAuthService>()` é a saída de emergência.

   Verificação: `grep -rn "DependencyService" src/` devolve zero ocorrências. O CI falha se não.

5. **Substitua os renderers customizados por handlers.** Esse é o passo que mais consome tempo. Um renderer customizado do Xamarin.Forms que sobrescrevia `OnElementPropertyChanged` vira [um handler MAUI com um dicionário `Mapper`](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/customize). Exemplo, um renderer que tira o sublinhado de um `Entry` Android:

   ```csharp
   // .NET MAUI 11, C# 14
   // Platforms/Android/EntryHandlerCustomization.cs
   using Microsoft.Maui.Handlers;

   public static class EntryHandlerCustomization
   {
       public static void Apply()
       {
           EntryHandler.Mapper.AppendToMapping("NoUnderline", (handler, entry) =>
           {
               handler.PlatformView.BackgroundTintList =
                   Android.Content.Res.ColorStateList.ValueOf(
                       Android.Graphics.Color.Transparent);
           });
       }
   }
   ```

   Registre a customização em `MauiProgram.CreateMauiApp` via `builder.ConfigureMauiHandlers(...)` ou chame `Apply()` a partir de um `partial void` em `MauiProgram` para rodar apenas no Android. Mantenha o mesmo padrão para iOS em `Platforms/iOS/`.

   Verificação: toda página que dependia do renderer antigo renderiza corretamente com `dotnet build -t:Run -f net11.0-android35.0`. Teste visual, não só compilação.

6. **Aposente o `MessagingCenter` em favor do messenger do CommunityToolkit.** O `MessagingCenter` está marcado como obsoleto no MAUI 11 e está agendado para remoção no MAUI 12. Adote `CommunityToolkit.Mvvm` 8.4.0 ou superior:

   ```bash
   # .NET MAUI 11
   dotnet add package CommunityToolkit.Mvvm --version 8.4.0
   ```

   A troca de padrão:

   ```csharp
   // Before, Xamarin.Forms 5.0
   MessagingCenter.Subscribe<LoginViewModel>(this, "LoggedIn", _ => RefreshUi());
   MessagingCenter.Send(this, "LoggedIn");

   // After, .NET MAUI 11 with CommunityToolkit.Mvvm 8.4.0
   public sealed record LoggedInMessage;
   WeakReferenceMessenger.Default.Register<LoggedInMessage>(this, (r, m) => RefreshUi());
   WeakReferenceMessenger.Default.Send(new LoggedInMessage());
   ```

   O `WeakReferenceMessenger` evita os bugs de ciclo de vida que faziam o `MessagingCenter` vazar memória em apps shell de longa duração.

7. **Mova os recursos para o Resizetizer.** Apague `Resources/drawable-*`, `Assets.xcassets` e as splash screens duplicadas. Coloque um `appicon.svg` e um `splash.svg` em `Resources/AppIcon/` e `Resources/Splash/`. O csproj já os conhece pelos items `MauiIcon` e `MauiSplashScreen` que o upgrade assistant emitiu. O redimensionamento em tempo de build substitui toda a escada de densidades.

   ```xml
   <!-- src/MyApp/MyApp.csproj fragment -->
   <ItemGroup>
     <MauiIcon Include="Resources\AppIcon\appicon.svg" ForegroundFile="Resources\AppIcon\appiconfg.svg" Color="#512BD4" />
     <MauiSplashScreen Include="Resources\Splash\splash.svg" Color="#512BD4" BaseSize="128,128" />
     <MauiImage Include="Resources\Images\*" />
     <MauiFont Include="Resources\Fonts\*" />
   </ItemGroup>
   ```

   Verificação: `dotnet build -f net11.0-android35.0` produz `bin/Debug/net11.0-android35.0/Resources/drawable-xxhdpi/appicon.png` sem você ter feito à mão.

8. **Atualize `MainActivity` e `MainApplication` do Android.** O Xamarin.Forms tinha um `MainActivity` que derivava de `FormsAppCompatActivity`. O MAUI divide isso em `MainActivity` mais `MainApplication`:

   ```csharp
   // Platforms/Android/MainActivity.cs, .NET MAUI 11
   using Android.App;
   using Android.Content.PM;
   using Android.OS;

   namespace MyApp;

   [Activity(Theme = "@style/Maui.SplashTheme",
             MainLauncher = true,
             ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation |
                                    ConfigChanges.UiMode | ConfigChanges.ScreenLayout |
                                    ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
   public class MainActivity : MauiAppCompatActivity { }

   // Platforms/Android/MainApplication.cs, .NET MAUI 11
   [Application]
   public class MainApplication : MauiApplication
   {
       public MainApplication(IntPtr handle, Android.Runtime.JniHandleOwnership ownership)
           : base(handle, ownership) { }

       protected override MauiApp CreateMauiApp() => MyApp.MauiProgram.CreateMauiApp();
   }
   ```

   No iOS o equivalente é um único `AppDelegate` que deriva de `MauiUIApplicationDelegate`. O padrão é idêntico: sobrescreva `CreateMauiApp` e chame o `MauiProgram` compartilhado.

9. **Converta os namespaces XAML.** Todo `xmlns="http://xamarin.com/schemas/2014/forms"` vira `xmlns="http://schemas.microsoft.com/dotnet/2021/maui"`. O upgrade assistant cobre a maior parte, mas arquivos com namespaces mistos (bibliotecas de controles customizados que puxavam `xamarin.toolkit`) precisam de uma varredura manual. `Frame` continua funcionando por mais uma release mas gera um aviso de build. Planeje substituí-lo por `Border` mais `StrokeShape="RoundRectangle 12"` e um `BackgroundColor`. `MasterDetailPage` precisa ser renomeado para `FlyoutPage` tanto no XAML quanto no code-behind, incluindo qualquer `x:TypeArguments`.

10. **Audite `Application.Properties` para `Preferences`.** Qualquer código que escrevia em `Application.Current.Properties["key"] = value` precisa migrar para `Preferences.Set("key", value)` de `Microsoft.Maui.Storage`. A forma é parecida mas o backend de armazenamento difere, então na primeira execução talvez seja preciso uma cópia única. Faça a cópia idempotente com um flag `"migrated_to_preferences"` para não rodar de novo.

11. **Fixe toda dependência NuGet em uma versão compatível com MAUI.** Rode `dotnet list package --vulnerable` e `dotnet list package --outdated` depois do upgrade. Suspeitos comuns: `Xamarin.Essentials` (sumiu, dobrado no MAUI), `Xamarin.Forms.Maps` (substituído por `Microsoft.Maui.Controls.Maps`), `Xamarin.Forms.Visual.Material` (substituído pelos estilos Material 3 do MAUI, ver [o artigo sobre Material 3 no MAUI 10](/pt-br/2026/05/maui-10-material-3-android-usematerial3-flag/)).

## Verificação

Após os passos acima:

- `dotnet restore` sai com 0 num clone limpo da branch de migração.
- `dotnet build -f net11.0-android35.0` e `-f net11.0-ios18.0` saem ambos com 0.
- O projeto de testes unitários, retargeted para `net11.0`, roda `dotnet test` em verde limpo.
- `dotnet build -t:Run -f net11.0-android35.0` lança a app num emulador e chega à primeira tela sem exceção não tratada.
- Teste manual em dispositivo real de toda tela que continha renderer customizado na árvore Xamarin.Forms.
- Compare o tempo de inicialização fria antes e depois usando um cronômetro do toque no launcher até o primeiro frame. CoreCLR mais AOT devem colocar uma app média abaixo de um segundo num celular Android intermediário de 2024. Se houve regressão, recheque o passo 5; um handler que faz trabalho de layout síncrono na thread de UI é o culpado mais comum.

## Plano de rollback

Não existe rollback automatizado uma vez que o csproj é reescrito. O plano realista é:

1. Mantenha a tag git `pre-maui-migration` do checklist de pré-voo.
2. Mantenha a migração em sua própria branch até a verificação ficar verde no Android e no iOS.
3. Se você precisar reverter depois do merge em main, o caminho seguro é `git revert` do commit de merge seguido por uma restauração limpa da árvore Xamarin.Forms e um redeploy. Não existe "downgrade" in-place de um csproj SDK-style para o layout legado de projeto compartilhado.

Se sua janela de release não tolera uma migração de mão única, publique a build MAUI como um app paralelo (`net.mycompany.myapp.maui`) nas lojas por um ciclo, alcance taxa livre de crash acima de 99.5 % em tráfego de produção, e então troque o bundle ID com uma atualização forçada.

## Ciladas que pegamos

- **O shrinking de recursos do Android leva suas fontes embora.** `Resources/Fonts/OpenSans-Regular.ttf` termina sob `Resources/font/opensans_regular.ttf` depois do renomeamento do resizetizer. O resource shrinker do R8 alegremente remove fontes que parecem não referenciadas a partir do XAML. Conserte adicionando `<MauiAsset Include="Resources/Fonts/**/*.ttf" />` explicitamente e desabilitando o shrinking até a próxima release: `<AndroidLinkResources>false</AndroidLinkResources>` apenas no Debug.
- **O `UIRequiredDeviceCapabilities` do `Info.plist` no iOS precisa de `arm64`.** A troca de Mono para CoreCLR só entrega binários ARM64. Se o `Info.plist` ainda lista `armv7`, o App Store Connect rejeita o upload.
- **A extensão de marcação `OnPlatform` se comporta diferente para `Default`**. No Xamarin.Forms um `Default` não especificado caía no valor da plataforma. No MAUI 11 `Default` precisa ser fixado explicitamente quando usado como forma de extensão de marcação. Adicione um valor `Default` ou troque para a forma de elemento `<OnPlatform>`.
- **Um `Frame` dentro de um `Grid` colapsa para altura zero.** O substituto `Border` não herda o default `HorizontalOptions="Fill"` do `Frame`. Seja explícito: `HorizontalOptions="Fill" VerticalOptions="Fill"`.
- **`Microsoft.Maui.Controls.Compatibility` não é grátis.** Ele existe, e te permite manter um ou dois renderers teimosos vivos enquanto você termina a migração, mas toda referência ao `Compatibility` mantém a cadeia de renderers legada no seu build e desfaz parte do ganho de inicialização fria do CoreCLR. Use como ponte, não como destino.

## Relacionados

- [Migrar um ListView de alto desempenho de Xamarin.Forms para CollectionView do MAUI](/pt-br/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/)
- [Migrar do .NET 8 para o .NET 11: a lista completa](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)
- [Migrar do .NET Framework 4.8 para o .NET 11 em 2026](/pt-br/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/)
- [MAUI vs Avalonia vs Uno em 2026](/pt-br/2026/05/maui-vs-avalonia-vs-uno-in-2026/)
- [Flutter vs React Native vs MAUI para um novo projeto mobile em 2026](/pt-br/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/)

## Fontes

- [.NET MAUI upgrade from Xamarin.Forms](https://learn.microsoft.com/en-us/dotnet/maui/migration/) no MS Learn.
- [Documentação de handlers do .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/) cobrindo a substituição dos renderers.
- [Notas de release do .NET MAUI 11.0](https://github.com/dotnet/maui/releases) no GitHub.
- [`Microsoft.Maui.Storage.Preferences`](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/storage/preferences) substituindo o `Application.Properties`.
- [Guia do messenger do CommunityToolkit.Mvvm](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/mvvm/messenger) substituindo o `MessagingCenter`.
