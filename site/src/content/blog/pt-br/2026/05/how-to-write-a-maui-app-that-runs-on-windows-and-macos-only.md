---
title: "Como escrever um app MAUI que roda apenas no Windows e macOS (sem mobile)"
description: "Tire Android e iOS de um projeto .NET MAUI 11 para que ele publique apenas Windows e Mac Catalyst: as edições no csproj, os comandos de workload e o multi-targeting que mantém o código limpo."
pubDate: 2026-05-02
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "windows"
  - "macos"
  - "how-to"
lang: "pt-br"
translationOf: "2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only"
translatedBy: "claude"
translationDate: 2026-05-02
---

Resposta curta: abra seu `.csproj`, apague as entradas de Android e iOS de `<TargetFrameworks>` e deixe apenas `net11.0-windows10.0.19041.0` e `net11.0-maccatalyst`. Em seguida apague `Platforms/Android`, `Platforms/iOS` e `Platforms/Tizen` se existir. Remova as entradas `<ItemGroup>` de assets de imagem do MAUI que apontam para ícones somente mobile, desinstale os workloads `maui-android` e `maui-ios` se quiser uma máquina limpa, e seu layout Single Project, `MauiProgram`, hot reload de XAML e pipeline de recursos continuam funcionando. `dotnet build -f net11.0-windows10.0.19041.0` produz um MSIX, `dotnet build -f net11.0-maccatalyst` (executado no macOS) produz um `.app`, e nada tenta subir um emulador Android nunca mais.

Este artigo percorre as edições exatas para .NET MAUI 11.0.0 sobre .NET 11, o que é seguro apagar e o que não é, as armadilhas sutis de multi-targeting quando você remove heads de plataforma, e as mudanças de workload e CI que de fato economizam tempo. Tudo abaixo foi verificado contra `dotnet new maui` do SDK do .NET 11 e se aplica igual a um projeto Xamarin.Forms já migrado para MAUI.

## Por que publicar um head MAUI somente desktop

Existe uma cauda constante de equipes de aplicações de negócio que escolhem MAUI pelo modelo de XAML e binding em vez de pelo alcance mobile. Ferramentas administrativas internas, apps de quiosque, clientes de ponto de venda, dashboards de chão de fábrica e apps de serviço de campo onde o campo é "um Surface e um MacBook" se encaixam todos. Essas equipes pagam um custo real pelos heads mobile que nunca publicam: cada `dotnet build` avalia quatro alvos, cada restore do NuGet baixa os reference packs de Android e iOS, cada runner de CI precisa de um workload de Android, e cada onboarding de desenvolvedor esbarra numa dependência de Xcode e Android Studio antes de conseguir rodar o app.

Tirar os heads mobile não é o template padrão do Visual Studio, mas é totalmente suportado pelo SDK. O sistema de build lê `<TargetFrameworks>` e só emite os heads que você declara. Não há nenhuma flag para virar dentro do MAUI. O atrito está inteiramente no arquivo de projeto, na pasta `Platforms/` e nos itens condicionais de MSBuild que o template adiciona para os assets mobile.

## A edição de TargetFrameworks

Um `dotnet new maui -n DesktopApp` recém-criado no SDK do .NET 11 produz um projeto que abre com este `PropertyGroup` inicial:

```xml
<!-- .NET MAUI 11.0.0, .NET 11 SDK -->
<PropertyGroup>
  <TargetFrameworks>net11.0-android;net11.0-ios;net11.0-maccatalyst</TargetFrameworks>
  <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net11.0-windows10.0.19041.0</TargetFrameworks>
  <OutputType>Exe</OutputType>
  <RootNamespace>DesktopApp</RootNamespace>
  <UseMaui>true</UseMaui>
  <SingleProject>true</SingleProject>
  <ImplicitUsings>enable</ImplicitUsings>
  <Nullable>enable</Nullable>
</PropertyGroup>
```

Substitua as duas linhas `<TargetFrameworks>` por uma única lista explícita:

```xml
<!-- .NET MAUI 11.0.0, .NET 11 SDK -->
<PropertyGroup>
  <TargetFrameworks>net11.0-maccatalyst</TargetFrameworks>
  <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net11.0-windows10.0.19041.0</TargetFrameworks>
  <OutputType>Exe</OutputType>
  <RootNamespace>DesktopApp</RootNamespace>
  <UseMaui>true</UseMaui>
  <SingleProject>true</SingleProject>
  <ImplicitUsings>enable</ImplicitUsings>
  <Nullable>enable</Nullable>
</PropertyGroup>
```

Duas coisas importam aqui. Primeiro, o bloco condicional `IsOSPlatform('windows')` é preservado porque o head do Windows só pode compilar no Windows, assim como Mac Catalyst só pode compilar no macOS. Sem a condição, um desenvolvedor no macOS rodando `dotnet build` falharia com "The Windows SDK is not available." Segundo, o sufixo de versão em `net11.0-windows10.0.19041.0` é a versão do SDK do Windows 10 que o MAUI exige para WinUI; não retire o sufixo de versão nem o troque por `net11.0-windows10.0` sozinho, porque os targets do WinAppSDK estão presos a esse moniker específico.

Se você só quer macOS, retire a linha do Windows inteira. Se você só quer Windows, retire a linha do Mac Catalyst e a condicional. A forma `<TargetFramework>` (singular) também funciona se você realmente só tem um head, e isso te dá um único valor não condicional que algumas ferramentas tratam mais elegantemente. Para um app de fato multi-desktop, mantenha a forma multi-target.

## O que apagar em `Platforms/`

O template do MAUI te entrega `Platforms/Android`, `Platforms/iOS`, `Platforms/MacCatalyst`, `Platforms/Tizen` e `Platforms/Windows`. Cada uma contém uma pequena quantidade de código de bootstrap específico de plataforma: um `AppDelegate` para as plataformas Apple, um `MainActivity` e um `MainApplication` para Android, um `App.xaml` mais um `Package.appxmanifest` para Windows, um `Application.cs` para Mac Catalyst.

Para somente desktop, apague `Platforms/Android`, `Platforms/iOS` e `Platforms/Tizen` direto. Eles não são usados. Mantenha `Platforms/MacCatalyst` e `Platforms/Windows`. Não toque na pasta `Resources/` de jeito nenhum; esse é o pipeline de assets do Single Project e ele atende a todos os heads.

Após a remoção o layout fica assim:

```
DesktopApp/
  App.xaml
  App.xaml.cs
  AppShell.xaml
  AppShell.xaml.cs
  MainPage.xaml
  MainPage.xaml.cs
  MauiProgram.cs
  Platforms/
    MacCatalyst/
      AppDelegate.cs
      Info.plist
      Program.cs
    Windows/
      App.xaml
      App.xaml.cs
      Package.appxmanifest
      app.manifest
  Resources/
    AppIcon/
    Fonts/
    Images/
    Raw/
    Splash/
    Styles/
  DesktopApp.csproj
```

Essa é a árvore-fonte completa de um app MAUI 11 somente desktop.

## Tire os itens de asset de imagem somente mobile

Se você usou o template padrão, seu `.csproj` tem um bloco assim perto do final:

```xml
<!-- .NET MAUI 11.0.0 -->
<ItemGroup>
  <MauiIcon Include="Resources\AppIcon\appicon.svg" ForegroundFile="Resources\AppIcon\appiconfg.svg" Color="#512BD4" />
  <MauiSplashScreen Include="Resources\Splash\splash.svg" Color="#512BD4" BaseSize="128,128" />
  <MauiImage Include="Resources\Images\*" />
  <MauiImage Update="Resources\Images\dotnet_bot.png" Resize="True" BaseSize="300,185" />
  <MauiFont Include="Resources\Fonts\*" />
  <MauiAsset Include="Resources\Raw\**" LogicalName="%(RecursiveDir)%(Filename)%(Extension)" />
</ItemGroup>
```

Eles são agnósticos de plataforma e ficam como estão. O pipeline de recursos do Single Project transforma o SVG em PNGs por plataforma em tempo de build apenas para os heads que você declarou. Quando você remove o Android, nenhuma densidade Android é emitida; o mesmo arquivo `Resources/AppIcon/appicon.svg` alimenta o `AppIcon.icns` do Mac Catalyst e o `Square150x150Logo.scale-200.png` do Windows e isso é tudo o que você precisa.

Se seu projeto é anterior ao .NET 9, você pode também ter itens `<AndroidResource>` ou `<BundleResource>` explícitos remanescentes de uma migração do Xamarin.Forms. Apague-os. Eles não vão dar erro se ficarem, mas confundem a saída de build e você vai bater em avisos "file not found" se os arquivos referenciados não existirem mais.

## Multi-targeting do seu próprio código sem `#if ANDROID`

O template do MAUI traz alguns padrões para código específico de plataforma: classes `partial` divididas entre arquivos `Platforms/<head>/` e diretivas `#if`. Sem Android e iOS, você só precisa lidar com Windows e Mac Catalyst. Os símbolos de pré-processador que você de fato usa são:

```csharp
// .NET 11, MAUI 11.0.0
public static class PlatformInfo
{
    public static string Describe()
    {
#if WINDOWS
        return "Windows";
#elif MACCATALYST
        return "macOS (Mac Catalyst)";
#else
        return "Unknown";
#endif
    }
}
```

É só isso. `ANDROID` e `IOS` continuam sendo símbolos definidos quando esses heads estão presentes em `<TargetFrameworks>`, mas como não estão, esses ramos simplesmente nunca compilam. Você pode apagar com segurança todo bloco `#if ANDROID` e `#if IOS` da sua base de código como uma passada de limpeza separada.

Se você divide implementações por nome de arquivo (o [padrão oficial de multi-targeting documentado para MAUI](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/configure-multi-targeting?view=net-maui-10.0)), os blocos `<ItemGroup>` condicionais devem perder os ramos de Android e iOS:

```xml
<!-- Mac Catalyst -->
<ItemGroup Condition="$(TargetFramework.StartsWith('net11.0-maccatalyst')) != true">
  <Compile Remove="**\*.MacCatalyst.cs" />
  <None Include="**\*.MacCatalyst.cs" Exclude="$(DefaultItemExcludes);$(DefaultExcludesInProjectFolder)" />
</ItemGroup>

<!-- Windows -->
<ItemGroup Condition="$(TargetFramework.Contains('-windows')) != true">
  <Compile Remove="**\*.Windows.cs" />
  <None Include="**\*.Windows.cs" Exclude="$(DefaultItemExcludes);$(DefaultExcludesInProjectFolder)" />
</ItemGroup>
```

Duas regras em vez de cinco. A mesma lógica vale para multi-targeting baseado em pasta; mantenha apenas as regras de pasta `MacCatalyst` e `Windows`.

## Workloads: instale o que você compila, desinstale o que você não

Esta é a mudança que se paga mais rápido em um runner de CI. O manifesto de workload do MAUI é dividido em vários sub-workloads:

```bash
# .NET 11 SDK on macOS
dotnet workload install maui-maccatalyst

# .NET 11 SDK on Windows
dotnet workload install maui-windows
```

Para um projeto somente desktop você precisa exatamente desses dois no runner correspondente. Você não precisa do workload guarda-chuva `maui`, que arrasta Android e iOS como dependências transitivas de workload. Em uma imagem de CI que já tinha `maui` instalado, rode:

```bash
dotnet workload uninstall maui-android maui-ios
```

O head Mac Catalyst no macOS continua exigindo Xcode, já que o `mlaunch` e a toolchain da Apple fazem a construção real do `.app`. Você não precisa do SDK do Android, do JDK do Java nem de nenhuma dependência de deploy em dispositivo iOS. No Windows, o head Windows exige o Windows App SDK e o SDK do Windows 10 na versão presa em `<TargetFrameworks>`. O comando `dotnet workload install maui-windows` baixa os dois.

A economia em CI é significativa. Um runner Linux que provisionava workloads de Android e imagens de emulador para uma build hospedada em Linux de um app MAUI, só para pular tudo no portão de CI, pode tirar esses passos por completo; o build agora ignora Linux e você roda dois jobs separados, um por SO.

## Compilando e publicando cada head

Os comandos `dotnet build` e `dotnet publish` aceitam um argumento `-f` de framework explícito para que você não tente acidentalmente compilar um head no host errado:

```bash
# On Windows, .NET 11 SDK
dotnet build -f net11.0-windows10.0.19041.0 -c Release
dotnet publish -f net11.0-windows10.0.19041.0 -c Release -p:WindowsAppSDKSelfContained=true -p:WindowsPackageType=MSIX

# On macOS, .NET 11 SDK
dotnet build -f net11.0-maccatalyst -c Release
dotnet publish -f net11.0-maccatalyst -c Release -p:CreatePackage=true
```

O head Windows emite um pacote `.msix` ou, com `WindowsPackageType=None`, um diretório Win32 sem empacotamento. O head Mac Catalyst emite um `.app` e, com `CreatePackage=true`, um instalador `.pkg`. A assinatura de código é uma preocupação separada para os dois: um certificado Authenticode para o MSIX e um Apple Developer ID para o `.pkg`. Nenhum envolve um perfil de provisionamento, que é a dança específica de iOS da qual você acabou de sair.

Se você também quer Native AOT para os heads desktop, o head WinUI do MAUI suporta no .NET 11 com ressalvas, parecido com o [caminho de Native AOT para minimal APIs do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/). Mac Catalyst ainda não suporta Native AOT completo no MAUI 11; ele vem com mono-AOT para plataformas Apple.

## Armadilhas que vale lembrar

O template "Add new MAUI Page" do Visual Studio em alguns cenários adiciona silenciosamente de volta um bloco `<ItemGroup Condition="...android..."/>`. Fique de olho nos diffs do seu csproj. Se você commitar um csproj somente desktop limpo e um colega adicionar uma view nova pelo IDE, o diff pode ressuscitar os itens condicionais de Android e iOS mesmo que `<TargetFrameworks>` não inclua mais esses targets. Esses itens órfãos são inofensivos, mas vão acumular ruído.

Pacotes NuGet que dependem de `Xamarin.AndroidX.*` ou `Microsoft.Maui.Essentials` para APIs somente mobile ainda farão restore. O gerenciador de pacotes resolve contra os targets que você declara, e um pacote somente mobile sem asset compatível para `net11.0-windows10.0` ou `net11.0-maccatalyst` vai falhar com `NU1202`. A solução é remover o pacote; se for uma dependência transitiva de algo que você de fato usa, abra uma issue com o pacote upstream e fixe em uma versão que suporte targets desktop explicitamente.

XAML hot reload funciona em ambos os heads desktop no .NET 11. O depurador de inicialização tem que ser o SO host do head: você não consegue depurar dentro de uma sessão Mac Catalyst pelo Visual Studio no Windows. Rider no macOS lida com os dois heads a partir de um único workspace, que é o fluxo de trabalho em que a maioria das equipes multi-desktop se acomoda.

As APIs do MAUI Essentials que são explicitamente somente mobile (geocodificação, contatos, sensores, telefonia) lançam `FeatureNotSupportedException` em tempo de execução no Windows e no Mac Catalyst. Elas não falham em tempo de compilação. Envolva o uso dessas APIs atrás de uma verificação de capacidade ou de uma abstração segura para desktop. O mesmo vale para MAUI Maps antes das [mudanças de pin clustering que chegaram no .NET MAUI 11](/pt-br/2026/04/dotnet-maui-11-map-pin-clustering/); os heads desktop usam um controle de mapa diferente por baixo dos panos do que os heads mobile, e a paridade de recursos não é perfeita.

Se algum dia você precisar adicionar de volta os heads mobile (um cliente pede uma versão para iPad), as mudanças se revertem de forma limpa: adicione as entradas de volta em `<TargetFrameworks>`, restaure as pastas `Platforms/Android` e `Platforms/iOS` a partir de um template `dotnet new maui` recém-criado, reinstale os workloads. O layout Single Project, seu XAML, suas view models e seu pipeline de recursos vão junto sem alterações. A configuração somente desktop é um subconjunto estrito do template de quatro heads, não um fork.

## Relacionado

- [.NET MAUI 11 traz um LongPressGestureRecognizer embutido](/pt-br/2026/04/maui-11-long-press-gesture-recognizer/)
- [Pin clustering chega aos Maps do .NET MAUI 11](/pt-br/2026/04/dotnet-maui-11-map-pin-clustering/)
- [Como usar Native AOT com minimal APIs do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)
- [Como reduzir o cold-start de um AWS Lambda em .NET 11](/pt-br/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)

## Links de origem

- [Configurar multi-targeting do .NET MAUI (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/configure-multi-targeting?view=net-maui-10.0)
- [Target frameworks em projetos SDK-style (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/standard/frameworks)
- [Solução de problemas conhecidos do .NET MAUI (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting?view=net-maui-10.0)
- [Issue 11584 do `dotnet/maui` sobre remoção do target Mac Catalyst](https://github.com/dotnet/maui/issues/11584)
