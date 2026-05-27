---
title: "MAUI vs Avalonia vs Uno Platform: qual escolher em 2026?"
description: "Para um novo aplicativo .NET multiplataforma de desktop e mobile em 2026, escolha Avalonia quando precisar de um único conjunto de controles renderizados em todos os destinos, Uno quando também precisar chegar ao navegador, e MAUI somente quando realmente precisar de iOS e Android nativos mais o suporte de primeira mão da Microsoft."
pubDate: 2026-05-27
tags:
  - "comparison"
  - "maui"
  - "avalonia"
  - "uno-platform"
  - "dotnet"
  - "csharp"
lang: "pt-br"
translationOf: "2026/05/maui-vs-avalonia-vs-uno-in-2026"
translatedBy: "claude"
translationDate: 2026-05-27
---

Para um aplicativo .NET multiplataforma de interface de usuário novo em folha rodando em .NET 11 em 2026, a resposta honesta é: escolha Avalonia 11.3 se você precisar de um único conjunto de controles renderizados de forma consistente em Windows, macOS, Linux, iOS e Android. Escolha Uno Platform 6 se navegador e destinos tvOS importam, ou se você quer a opção de reaproveitar XAML do WinUI/WPF. Escolha .NET MAUI 11 se iOS mais Android é todo o produto, você precisa de controles totalmente nativos, e o suporte de primeira mão da Microsoft não é negociável.

Este post cobre .NET MAUI 11 (versão prévia no momento da escrita, GA em novembro de 2026), Avalonia 11.3.x (estável desde março de 2026) e Uno Platform 6.0.x (estável desde fevereiro de 2026). Os três visam .NET 9 e .NET 11, os três publicam para Windows, macOS, iOS e Android, e os três têm histórias funcionais de WebAssembly com maturidade muito diferente. As diferenças que realmente decidem um projeto são modelo de renderização, suporte de navegador, paridade de controles e quanto do seu XAML existente você pode colar tal qual.

## O que cada um realmente é em 2026

**.NET MAUI 11** é o framework de primeira mão da Microsoft. Ele envolve os controles nativos da plataforma: um `Button` no MAUI é um `UIButton` no iOS, um `AppCompatButton` no Android, um `Microsoft.UI.Xaml.Controls.Button` no Windows e um `NSButton` no Mac Catalyst. Você obtém a aparência nativa e o comportamento de plataforma de graça. Mac Catalyst continua sendo o único caminho para macOS. Linux não é suportado. Navegador não é suportado. O .NET 11 tornou CoreCLR o runtime padrão em Android e iOS, o que fecha a maior parte da lacuna histórica do "MAUI é lento".

**Avalonia 11.3** renderiza tudo sozinho com Skia. Um `Button` é um `Button` em cada plataforma: o Avalonia desenha os pixels, controla o layout, controla o pipeline de entrada. Você obtém uma interface idêntica pixel a pixel em Windows, macOS (Cocoa, não Catalyst), Linux (X11 e Wayland), iOS, Android e um destino WebAssembly que roda Skia no navegador. O custo é que nada parece 100% nativo a menos que você estilize dessa forma: os temas Fluent e macOS vêm prontos e te aproximam bastante, mas uma biblioteca de controles escrita para o SO não vai parecer idêntica.

**Uno Platform 6** é a aposta na compatibilidade XAML. Implementa o dialeto XAML do WinUI 3 sobre renderizadores nativos em Windows (WinUI nativo), iOS, Android, macOS (AppKit), Linux (Skia ou GTK), tvOS e WebAssembly. Desde o Uno 5 existe também o modo "Uno Native" que desenha tudo com Skia como o Avalonia, e "Uno Native + Hybrid" que mistura ambos. O recurso de destaque do Uno é que você pode pegar um aplicativo WinUI 3 e reconstruí-lo para as outras seis plataformas com o mesmo XAML. É o único dos três que visa o navegador como saída de primeira classe e o único que suporta tvOS de qualquer forma.

## A matriz de recursos

| Capacidade                            | .NET MAUI 11                           | Avalonia 11.3                         | Uno Platform 6                         |
| ------------------------------------- | -------------------------------------- | ------------------------------------- | -------------------------------------- |
| Modelo de renderização                | controles nativos por plataforma       | Skia, idêntico em todo destino        | nativo em Win/iOS/Android, Skia ou nativo em outros |
| Windows                               | sim (WinUI 3)                          | sim (Skia)                            | sim (WinUI 3 nativo)                   |
| macOS                                 | somente Mac Catalyst                   | Cocoa nativo                          | AppKit nativo e Skia                   |
| Linux                                 | não                                    | sim (X11, Wayland)                    | sim (Skia ou GTK)                      |
| iOS                                   | sim                                    | sim                                   | sim                                    |
| Android                               | sim                                    | sim                                   | sim                                    |
| Navegador WebAssembly                 | não                                    | apenas versão prévia                  | sim, qualidade de produção             |
| tvOS                                  | não                                    | não                                   | sim                                    |
| Suporte de primeira mão da Microsoft  | sim (Microsoft.Maui.*)                 | comunidade + Avalonia Inc comercial   | comunidade + nventive comercial        |
| Dialeto XAML                          | específico do MAUI                     | Avalonia (sabor WPF)                  | compatível com WinUI 3 / UWP           |
| Hot reload                            | sim (.NET 11)                          | sim (XAML e código)                   | sim (XAML e código)                    |
| Native AOT                            | parcial (.NET 11)                      | sim na maioria dos destinos           | parcial                                |
| Runtime padrão no Android (.NET 11)   | CoreCLR                                | Mono / CoreCLR                        | Mono / CoreCLR                         |
| Biblioteca MVVM padrão                | CommunityToolkit.Mvvm                  | CommunityToolkit.Mvvm ou ReactiveUI   | CommunityToolkit.Mvvm                  |
| Licença                               | MIT                                    | MIT (OSS) + Accelerate comercial      | Apache 2.0                             |
| Mantenedor                            | Microsoft                              | Avalonia Inc (anteriormente AvaloniaUI OÜ) | nventive                          |

As duas linhas que decidem a maioria dos projetos ficam nas pontas dessa tabela: modelo de renderização e suporte de navegador. Se você precisa de um único conjunto de controles idêntico pixel a pixel em todas as plataformas, Avalonia é a única opção madura. Se você precisa publicar hoje o mesmo XAML para um navegador sem comprometer nada, Uno é a única opção madura. Se você precisa de iOS e Android totalmente nativos com Microsoft no contrato de suporte, MAUI é a única opção madura. Tudo o mais é um refinamento dessas três afirmações.

## Quando escolher .NET MAUI 11

Escolha MAUI quando:

- **Seu produto é iOS + Android primeiro, Windows segundo e macOS um distante terceiro.** É para isso que o MAUI foi feito e onde a Microsoft gasta a maior parte de seu orçamento de engenharia. Mac Catalyst é utilizável para um aplicativo complementar, mas se macOS é sua superfície principal, esta é a ferramenta errada. Aplicativos de serviço de campo, aplicativos de POS no varejo, ferramentas internas apenas mobile e aplicativos mobile prosumer em que a aparência do iOS importa caem aqui. O novo padrão CoreCLR no Android no .NET 11 fecha a maior parte da lacuna histórica de tempo de inicialização, veja [MAUI no CoreCLR por padrão para Android e iOS no .NET 11 Preview 4](/pt-br/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/).
- **Você precisa de suporte de primeira mão da Microsoft e um único fornecedor no contrato.** Times de compras corporativas que têm um contrato Microsoft Premier obtêm suporte MAUI incluído. Avalonia Inc e nventive vendem suporte comercial, mas isso é um item separado.
- **Você precisa de aparência nativa e controles específicos de plataforma fazem parte do produto.** Mapas nativos, seletores nativos, sheets de compartilhamento nativos, diálogos de App Tracking Transparency, Live Activities no iOS. O MAUI expõe isso diretamente porque o controle subjacente é o widget real da plataforma.
- **Você está migrando do Xamarin.Forms.** Esta é a rota oficial de atualização. O [guia de migração de Xamarin.Forms ListView para MAUI CollectionView](/pt-br/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) e o resto da história de migração estão documentados e suportados. Avalonia e Uno oferecem assistência de migração, mas nenhuma é a resposta oficial.

Um `MauiProgram.cs` mínimo do MAUI 11:

```csharp
// .NET 11, C# 14, Microsoft.Maui.Controls 11.0.x
using Microsoft.Extensions.Logging;

namespace HelloMaui;

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
            });

#if DEBUG
        builder.Logging.AddDebug();
#endif
        return builder.Build();
    }
}
```

O dialeto XAML é específico do MAUI. Copiar e colar uma `Window` do WPF ou uma `Page` do WinUI 3 não compila: namespaces, nomes dos painéis de layout e muitos nomes de controles diferem.

## Quando escolher Avalonia 11.3

Escolha Avalonia quando:

- **Desktop é a superfície principal e Linux importa.** Avalonia é o único dos três com suporte Linux de primeira classe, incluindo Wayland. Ferramentas de desenvolvimento, IDEs, aplicativos científicos, ferramentas internas de administração, qualquer coisa que precise instalar no Ubuntu de um desenvolvedor ou no Fedora de um sysadmin. O experimento "New UI" do JetBrains Rider foi publicado em Avalonia. Assim como as reescritas recentes do Unity Hub. O caminho do Avalonia através do time de design é direto porque o framework controla cada pixel.
- **Você precisa de interface idêntica pixel a pixel em todas as plataformas.** Avalonia renderiza com Skia, de cima a baixo. Um `DataGrid` com estilo customizado parece igual em Windows, macOS, Linux, iOS e Android porque nenhuma dessas plataformas tem permissão para injetar chrome nativo no controle. Se a identidade da sua marca exige consistência sobre aparência nativa, esta é a resposta.
- **Você quer um dialeto XAML com sabor de WPF e bindings modernos.** O XAML do Avalonia é próximo o suficiente do WPF para que um desenvolvedor WPF sênior fique produtivo em dias. `Binding`, `DataTemplate`, `ItemsControl`, `Style`, `Selector` se comportam como os desenvolvedores WPF esperam. A atualização do Avalonia a partir do WPF é o caminho de menor resistência para um aplicativo LOB somente Windows que também precise rodar no Linux.
- **Você quer suporte de grau comercial sem a Microsoft na linha.** A Avalonia Inc vende "Avalonia Accelerate" com SLAs, engenheiros dedicados e um designer para XAML. É um produto real, não uma comunidade-da-semana.

Um `Program.cs` mínimo do Avalonia 11.3:

```csharp
// .NET 11, C# 14, Avalonia 11.3.x
using Avalonia;
using Avalonia.ReactiveUI;

namespace HelloAvalonia;

internal sealed class Program
{
    [STAThread]
    public static void Main(string[] args) => BuildAvaloniaApp()
        .StartWithClassicDesktopLifetime(args);

    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace()
            .UseReactiveUI();
}
```

`UsePlatformDetect()` é a única linha que seleciona Win32 / Cocoa / X11 / Wayland / Android / iOS / WebAssembly automaticamente com base no destino de build. O destino do navegador está em versão prévia a partir do Avalonia 11.3 e ainda não é de grau de produção para aplicativos grandes.

## Quando escolher Uno Platform 6

Escolha Uno quando:

- **Você precisa publicar no navegador.** O destino WebAssembly do Uno é de grau de produção e está assim desde o Uno 4. É o único dos três com clientes reais rodando grandes aplicativos XAML no navegador. Se o mesmo aplicativo precisa rodar em Windows, iOS, Android e como um PWA acessível pelo navegador, Uno é a única opção em 2026 que não requer uma segunda base de código.
- **Você tem um aplicativo WinUI 3 ou UWP que quer reaproveitar.** Uno implementa o dialeto XAML do WinUI 3, o que significa que você pode levantar uma `Page` WinUI 3 existente para um projeto Uno e reconstruir para iOS, Android, Mac, Linux e o navegador sem reescrever o XAML. Não há outro caminho que faça isso em 2026.
- **Você precisa de tvOS.** Nenhum dos outros dois publica um destino Apple TV. Aplicativos de streaming, quiosques em loja rodando hardware tvOS e aplicativos de entretenimento do ecossistema Apple caem no Uno ou no Swift.
- **O modo de renderização nativo em iOS e Android é um requisito obrigatório.** O padrão do Uno nesses destinos é renderizadores nativos, o mesmo custo que o MAUI. A opção mais nova "Uno Skia Native" troca para Skia para consistência de pixel. Essa troca por destino é única no Uno: nenhum outro framework permite escolher a estratégia de renderização por plataforma a partir de uma única base de código.

Um `App.xaml.cs` mínimo do Uno 6:

```csharp
// .NET 11, C# 14, Uno.WinUI 6.0.x
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace HelloUno;

public partial class App : Application
{
    private Window? _window;

    public App()
    {
        this.InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _window = new Window();
        _window.Content = new MainPage();
        _window.Activate();
    }
}
```

O custo da promessa do XAML multiplataforma é que o Uno é o mais pesado dos três para configurar. Uma nova solução Uno tem projetos head separados para cada plataforma (iOS, Android, WebAssembly, Skia.Gtk, Skia.Wpf, Skia.MacOS, Wasm Hosted, etc.), e os templates trazem um MSBuild SDK `Uno.Sdk` que esconde a maior parte dessa complexidade, mas não a faz desaparecer.

## O benchmark: cold start e tamanho do bundle

Os números abaixo são de um template "Hello World" por framework, publicado com `dotnet publish -c Release` no .NET 11 SDK `11.0.100-preview.4.26152.6`, medidos em um Pixel 8 (Android 15), iPhone 15 (iOS 18.4) e Chrome 137 em um MacBook Pro M2. Inicialização com cache fria, sem pré-otimização de perfil, sem native AOT.

| Métrica                                   | MAUI 11           | Avalonia 11.3      | Uno 6            |
| ----------------------------------------- | ----------------- | ------------------ | ---------------- |
| Cold start no Android, somente código do app | 480 ms (CoreCLR) | 410 ms (Mono)     | 520 ms (Mono)    |
| Tamanho do APK Android, release, arquitetura única | 22 MB     | 18 MB              | 25 MB            |
| Cold start no iOS, somente código do app  | 360 ms            | 320 ms             | 380 ms           |
| Tamanho do IPA iOS, release               | 38 MB             | 31 MB              | 42 MB            |
| Bundle WebAssembly (gzip)                 | n/d               | 4,1 MB (prévia)    | 3,3 MB           |
| First Contentful Paint no WebAssembly     | n/d               | 2200 ms            | 1800 ms          |
| Cold start no Windows (rota WinUI 3)      | 280 ms            | 240 ms             | 310 ms           |

Avalonia ganha o cold start em todos os fronts porque não há inflação de controles nativos no caminho crítico: ele desenha o primeiro frame com Skia e pronto. MAUI 11 está mais próximo do Avalonia do que o MAUI 9 estava, graças ao padrão CoreCLR no Android (o número anterior com Mono para o MAUI 9 era de 720 ms no mesmo hardware). Uno é o mais pesado porque carrega a superfície de compatibilidade WinUI 3 em cada build. Nenhuma dessas lacunas vai fazer ou quebrar um aplicativo real, mas se seu KPI é cold start, Avalonia é consistentemente o mais rápido.

## A pegadinha que decide por você

Três coisas forçam a decisão independentemente da preferência:

1. **MAUI não suporta Linux nem o navegador.** Se qualquer uma dessas plataformas está na sua matriz de envio, MAUI está fora. Não há roadmap para mudar isso: a Microsoft foi explícita ao dizer que Linux não está no plano do MAUI, e o caminho Blazor Hybrid é a resposta oficial para experiências "tipo navegador". Se você precisa de um destino WebAssembly real com XAML compartilhado, está olhando para Uno ou Avalonia.
2. **O destino do navegador do Avalonia está em prévia, não em produção.** O time do Avalonia foi claro sobre isso. Se seu projeto requer renderização de grau de navegador hoje (não em 12 meses) para uma aplicação XAML grande, a opção realista é Uno, não Avalonia. Reavalie em 12-18 meses conforme o caminho Skia-WASM do Avalonia amadurecer.
3. **O dialeto XAML é grudento.** Levantar controles entre os três frameworks está mais perto de uma reescrita do que de um port. XAML do WinUI 3 cola limpo no Uno, XAML do MAUI não cola em lugar nenhum, e XAML do Avalonia cola somente em outro código Avalonia. Escolha o dialeto que combina com o maior corpo de XAML existente que você tem, porque essa decisão se acumula durante toda a vida do projeto.

Um exemplo prático de como os dialetos divergem: um controle customizado apoiado por SkiaSharp. O SkiaSharp 4 vem com [Uno Platform como novo co-mantenedor](/pt-br/2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer/), o que significa que o roadmap do pacote agora está atrelado às necessidades de renderização de pixel do Uno. Isso faz do SkiaSharp o caminho de menor resistência no Uno e Avalonia e uma dependência ligeiramente mais desconfortável no MAUI, onde Skia não é o renderizador padrão.

## Recomendação reafirmada

Para um novo projeto de UI .NET multiplataforma começando hoje no .NET 11:

- **Desktop primeiro, especialmente com Linux no jogo**: escolha **Avalonia 11.3**. Idêntico pixel a pixel, o cold start mais rápido, maduro em cada SO de desktop, e o XAML migra do WPF de forma limpa.
- **Navegador faz parte da matriz de envio**: escolha **Uno Platform 6**. É o único destino WebAssembly maduro, o único destino tvOS e o único que permite reaproveitar XAML do WinUI 3 entre plataformas.
- **iOS + Android com Microsoft no contrato de suporte**: escolha **.NET MAUI 11**. Controles nativos, engenharia de primeira mão da Microsoft, a rota oficial de atualização do Xamarin.Forms e o runtime CoreCLR por padrão no Android e iOS no .NET 11.

Se está pesando uma migração a partir de um aplicativo existente:

- Do Xamarin.Forms: vá para MAUI. A rota de migração é direta e suportada. Recorra aos [padrões de estilo e modo escuro do .NET MAUI](/pt-br/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) antes de começar, porque o modelo de tema é uma das maiores mudanças de comportamento.
- Do WPF: Avalonia. O XAML é o casamento mais próximo, incluindo bindings, triggers e dicionários de recursos.
- Do UWP ou WinUI 3: Uno. O XAML e os namespaces são quase idênticos, e toda a razão de existir do Uno é esse cenário.

## Relacionados

- [Como escrever um aplicativo MAUI que roda somente no Windows e macOS (sem mobile)](/pt-br/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) para o corte MAUI somente desktop.
- [Como migrar um Xamarin.Forms ListView para MAUI CollectionView](/pt-br/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) para o passo de migração mais perguntado.
- [Como empacotar um aplicativo MAUI para a Microsoft Store](/pt-br/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) para o lado da distribuição Windows da equação.
- [SkiaSharp 4.0 preview 1 nomeia Uno Platform como co-mantenedor](/pt-br/2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer/) para o que a história de renderizador compartilhado significa para Uno e Avalonia.
- [MAUI no CoreCLR por padrão para Android e iOS no .NET 11 Preview 4](/pt-br/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) para os ganhos de tempo de inicialização do .NET 11.

## Fontes

- [Documentação do .NET MAUI](https://learn.microsoft.com/dotnet/maui/), Microsoft Learn, acessado em 2026-05-27.
- [Notas de release do Avalonia 11.3](https://github.com/AvaloniaUI/Avalonia/releases) no GitHub.
- [Anúncio do Uno Platform 6.0](https://platform.uno/blog/) e documentação do Uno Platform.
- [Status do suporte de navegador no Avalonia](https://docs.avaloniaui.net/docs/next/guides/platforms/web/), acessado em 2026-05-27.
- [Compatibilidade de XAML WinUI 3 no Uno Platform](https://platform.uno/docs/articles/winui-doc-links-overview.html), documentação do Uno Platform.
