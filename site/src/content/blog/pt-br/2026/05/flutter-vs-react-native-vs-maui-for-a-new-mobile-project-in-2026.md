---
title: "Flutter vs React Native vs .NET MAUI: qual escolher para um novo projeto mobile em 2026?"
description: "Para um aplicativo mobile novo em folha em 2026, escolha Flutter 3.44 quando a UI idêntica pixel a pixel e o orçamento de animação importam, React Native 0.82 quando seu time já vive em TypeScript e você precisa de um irmão real no navegador, e .NET MAUI 11 quando iOS e Android fazem parte de um produto .NET mais amplo e você precisa do suporte de primeira mão da Microsoft."
pubDate: 2026-05-27
tags:
  - "comparison"
  - "flutter"
  - "react-native"
  - "maui"
  - "mobile"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026"
translatedBy: "claude"
translationDate: 2026-05-27
---

Para um novo app iOS e Android começando hoje, a resposta honesta é: escolha Flutter 3.44 se UI idêntica pixel a pixel, animação a 120 Hz sem jank e uma única base de código em Dart são as prioridades. Escolha React Native 0.82 se seu time de engenharia é TypeScript primeiro, você quer o ecossistema de pacotes JS à mão e uma futura versão para navegador está no escopo. Escolha .NET MAUI 11 se mobile é uma superfície de um produto .NET 11 mais amplo e a Microsoft no contrato de suporte não é negociável. O desempenho é um empate para 95% dos aplicativos de negócio. A adequação do time e a adequação do ecossistema escolhem por você.

Este post cobre Flutter 3.44 (estável desde maio de 2026, pacotes Material 3 separados), React Native 0.82 (estável desde abril de 2026, New Architecture obrigatória, Bridgeless por padrão) e .NET MAUI 11 (versão prévia no momento da escrita, GA em novembro de 2026, CoreCLR por padrão em Android e iOS). Os três publicam para iOS 18 e Android 15+, os três suportam hot reload e os três têm exemplos em produção na App Store e na Play Store. As diferenças que de fato decidem um projeto são linguagem, modelo de renderização, maturidade do ecossistema e em qual plataforma você pode acomodar o time sem reescrever o back end.

## O que cada um realmente é em 2026

**Flutter 3.44** é um toolkit de UI Dart-first, renderizado com Skia. Ele desenha tudo sozinho: um `Button` não é um `UIButton` nem um `AppCompatButton`, ele é o que quer que sejam os pixels que o engine do Flutter desenhou com base no widget `Material` ou `Cupertino` que você usou. Usuários de iOS recebem widgets com tema Cupertino que parecem nativos, usuários de Android recebem widgets Material 3, mas o framework controla cada layout e gesto. A versão 3.44 moveu `material` e `cupertino` para pacotes separados distribuídos via Swift Package Manager no lado iOS, o que facilita acompanhar deltas por módulo, mas adiciona um custo único de migração no seu `pubspec.yaml`.

**React Native 0.82** é um framework JavaScript / TypeScript que mapeia para views nativas de iOS e Android através de uma ponte de turbo-modules. Desde a 0.78 a New Architecture (renderizador Fabric + TurboModules + JSI) é o padrão para novos projetos; desde a 0.82 a ponte legada foi removida por completo. O modo Bridgeless significa que JavaScript chama código nativo de forma síncrona quando possível, o que torna a queixa histórica de "RN parece lento" substancialmente menos verdadeira em 2026 do que era em 2022. O engine JS é Hermes por padrão em ambas as plataformas, e `expo` é o orquestrador de build de fato: um template `react-native init` puro ainda existe, mas não é mais o caminho recomendado para novos apps.

**.NET MAUI 11** é o framework de primeira mão da Microsoft. Ele envolve os controles nativos da plataforma: um `Button` no MAUI é um `UIButton` no iOS, um `AppCompatButton` no Android, um `Microsoft.UI.Xaml.Controls.Button` no Windows e um `NSButton` no Mac Catalyst. O CoreCLR agora é o runtime padrão em Android e iOS no .NET 11, o que fecha a maior parte da lacuna histórica de tempo de inicialização em relação ao Flutter e ao RN. O MAUI compartilha o mesmo stack XAML / C# do WinUI 3 e do Blazor Hybrid, então ele faz mais sentido quando iOS e Android são irmãos de um produto desktop Windows ou de um produto web Blazor, não quando mobile é o universo inteiro.

## A matriz de recursos

| Capacidade                            | Flutter 3.44                        | React Native 0.82                   | .NET MAUI 11                          |
| ------------------------------------- | ----------------------------------- | ----------------------------------- | ------------------------------------- |
| Linguagem principal                   | Dart 3.7                            | TypeScript / JavaScript             | C# 14                                 |
| Modelo de renderização                | Skia, pixels idênticos por plataforma | views nativas via Fabric / TurboModules | controles nativos por plataforma   |
| iOS                                   | sim                                 | sim                                 | sim                                   |
| Android                               | sim                                 | sim                                 | sim                                   |
| Desktop Windows                       | sim (estável desde 3.16)            | comunidade (`react-native-windows`) | sim (WinUI 3)                         |
| Desktop macOS                         | sim (estável desde 3.16)            | comunidade (`react-native-macos`)   | Mac Catalyst                          |
| Desktop Linux                         | sim (estável desde 3.10)            | não                                 | não                                   |
| Web (navegador)                       | versão prévia, não produção para apps grandes | sim (via React DOM, compartilhamento de código limitado) | não (Blazor Hybrid é separado) |
| Hot reload                            | abaixo de um segundo, com estado    | Fast Refresh, com estado            | sim (.NET 11)                         |
| Runtime padrão no Android (.NET 11)   | Dart compilado em AOT               | Hermes JS                           | CoreCLR                               |
| IDE padrão                            | VS Code, Android Studio             | VS Code, WebStorm                   | Visual Studio 2026, Rider             |
| Ecossistema de pacotes                | pub.dev, 50 mil+ pacotes            | npm, o mundo JS inteiro             | NuGet, ecossistema .NET               |
| Suporte de primeira mão               | Google                              | Meta + comunidade                   | Microsoft                             |
| New Architecture / linha de base do runtime | AOT sempre ligado             | obrigatória desde 0.80              | CoreCLR padrão desde .NET 11 Preview 4 |
| Licença                               | BSD-3                               | MIT                                 | MIT                                   |
| Gerenciamento de estado padrão        | Riverpod, Bloc, Provider            | Redux Toolkit, Zustand, TanStack Query | CommunityToolkit.Mvvm              |

Três linhas decidem a maioria dos projetos: linguagem principal, modelo de renderização e suporte de primeira mão. O resto é refinamento. Se seu time de engenharia escreve TypeScript e seu back end é Node, o esforço para chegar ao React Native é de dias, não meses. Se seu time escreve C# contra .NET e Entity Framework Core, o MAUI permite compartilhar DTOs, validação e até ViewModels com a camada web. Flutter é o único onde a linguagem produtiva é essencialmente única do framework, o que é um imposto real se seu time nunca escreveu Dart.

## Quando escolher Flutter 3.44

Escolha Flutter quando:

- **UI idêntica pixel a pixel entre iOS e Android faz parte do produto.** Um sistema de design customizado, um app orientado por marca, um app próximo a um jogo ou um produto de consumo onde o time de design tem opiniões fortes. O Flutter renderiza com Skia de cima a baixo, então um `CustomPainter` parece igual em um Pixel 8 e em um iPhone 15 sem ajustes por plataforma. Este é o motivo isolado mais comum para times escolherem Flutter em 2026.
- **O orçamento de animação importa e 120 Hz está na especificação.** O pipeline de renderização do Flutter é construído em torno de um alvo de 120 Hz. O Impeller (o novo backend gráfico, padrão no iOS desde a 3.7 e no Android desde a 3.16) elimina o jank de compilação de shader que prejudicava os primeiros apps Flutter. Se você tem UI pesada orientada por gestos, uma lista animada complexa ou está construindo qualquer coisa próxima a um jogo, Flutter é a aposta mais segura dos três.
- **Você quer uma base de código para alcançar iOS, Android e desktop sem comprometer.** O Flutter Desktop é GA em Windows, macOS e Linux. O catálogo de widgets é o mesmo; só o modelo de entrada e o chrome de janela mudam. Nenhum dos outros dois entrega uma história comparável de desktop Linux.
- **O time consegue absorver aprender Dart.** O Dart 3.7 em 2026 é uma linguagem forte, com null safety sólida, correspondência de padrões, records e palavras-chave modificadoras de classe (`sealed`, `final`, `interface`). Engenheiros sêniores vindos de TypeScript ou C# alcançam produtividade em cerca de duas semanas. Engenheiros juniores levam mais tempo porque o ecossistema fora do Flutter é pequeno.

Um `main.dart` mínimo do Flutter 3.44:

```dart
// Flutter 3.44, Dart 3.7
import 'package:flutter/material.dart';

void main() => runApp(const HelloApp());

class HelloApp extends StatelessWidget {
  const HelloApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Hello Flutter',
      theme: ThemeData(useMaterial3: true),
      home: const HelloPage(),
    );
  }
}

class HelloPage extends StatelessWidget {
  const HelloPage({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Hello')),
        body: const Center(child: Text('Hello, Flutter')),
      );
}
```

A flag `useMaterial3: true` agora é o padrão na 3.44 (veja [a separação dos pacotes Material e Cupertino do Flutter 3.44](/pt-br/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) para o que mudou por baixo dos panos), então você pode descartar a linha em novos projetos.

## Quando escolher React Native 0.82

Escolha React Native quando:

- **Seu time já escreve React e TypeScript para a web.** Este é o motivo isolado mais forte para o RN ganhar uma seleção em 2026. Hooks, o modelo de componentes, as bibliotecas de busca de dados (TanStack Query, SWR) e a maioria das bibliotecas de validação (Zod) funcionam inalteradas. Um engenheiro React sênior entrega um recurso RN funcional em dias, não semanas. Flutter e MAUI exigem aprender um novo modelo de componentes.
- **Você precisa reaproveitar pacotes npm, especialmente em torno de AI, pagamentos e analytics.** O ecossistema JavaScript ofusca o `pub.dev` do Dart e os pacotes NuGet específicos para mobile do .NET. Se seu roadmap inclui Stripe, Segment, o Anthropic SDK, o OpenAI SDK, LangChain ou qualquer coisa da camada de tooling de AI, você vai encontrar uma biblioteca JS / TS de primeira mão antes de encontrar um equivalente em Dart ou C#.
- **O mesmo produto precisa de uma versão web e o compartilhamento de código entre web e mobile faz parte do plano.** React Native e React DOM são alvos de renderização diferentes, mas compartilham hooks, lógica de negócio, validação e cerca de 60-70% do código de apresentação se você usar [React Native for Web](https://github.com/necolas/react-native-web) ou os apps universais do Expo. O Flutter tem um alvo web mas é de qualidade de versão prévia para apps grandes em 2026, e o MAUI não tem história real para navegador (Blazor Hybrid é um stack separado).
- **Você quer Hermes + a New Architecture sem dores de cabeça da ponte legada.** A partir da 0.82, a ponte legada se foi. Módulos usam TurboModules com JSI, o renderizador é Fabric, e pacotes antigos que não foram migrados não vão carregar. Esta é uma linha de base mais limpa do que o RN já teve desde o lançamento, e as reclamações da era de 2022 sobre latência de thread-hopping em sua maior parte já não se aplicam.

Um `App.tsx` mínimo do React Native 0.82:

```typescript
// React Native 0.82, Expo SDK 53, TypeScript 5.6
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <Text>Hello, React Native</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
```

O Expo agora é o scaffold padrão. `npx create-expo-app` para um novo projeto, `expo prebuild` se você precisar de um módulo nativo customizado e EAS Build para artefatos `.ipa` e `.aab` compilados na nuvem. O "bare workflow" ainda existe, mas o time não o recomenda para novos projetos desde o Expo SDK 51.

## Quando escolher .NET MAUI 11

Escolha MAUI quando:

- **iOS e Android são superfícies acompanhantes de um produto .NET mais amplo.** Uma ferramenta de serviço de campo que também tem um console administrativo Blazor Server, um POS de varejo que compartilha um domínio Entity Framework Core com um back office Windows, um app de saúde cujas regras de validação rodam tanto em uma API ASP.NET Core quanto no dispositivo. O MAUI permite compartilhar o modelo de dados, os DTOs, regras do FluentValidation e até os ViewModels com `CommunityToolkit.Mvvm`. Nenhum outro framework te dá esse alcance com uma única linguagem.
- **Você está migrando do Xamarin.Forms.** Este é o caminho oficial. O [guia de migração de Xamarin.Forms ListView para MAUI CollectionView](/pt-br/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) é o passo de migração mais perguntado, e a tooling amadureceu desde os dolorosos dias do 8.0.
- **Você precisa de suporte de primeira mão da Microsoft e um único fornecedor no contrato.** Times de compras corporativas que têm um contrato Microsoft Premier ou Unified obtêm o MAUI incluído. O Flutter tem o Google, mas nenhum contrato corporativo, e o React Native tem o Meta mais uma comunidade de fornecedores.
- **O time escreve C# e o back end é .NET.** Compartilhar uma única linguagem entre mobile, web, desktop e servidor é um multiplicador real de produtividade. DTOs tipados na rede (geradores de código-fonte do System.Text.Json), validação compartilhada, primitivas de log idênticas. Flutter e RN não conseguem fazer isso sem um passo de geração de código ou uma implementação duplicada.

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

A mudança do CoreCLR por padrão no [.NET 11 Preview 4 fecha a maior parte da lacuna histórica de cold start do MAUI](/pt-br/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) no Android e iOS, que é a maior atualização ao framework desde o GA do 8.0.

## O benchmark: cold start e tamanho do bundle

Os números abaixo são de um template "Hello World" por framework, compilado em release e instalado em um Pixel 8 (Android 15) e um iPhone 15 (iOS 18.4). Cold start medido a partir de `am start` (Android) e de um trace Launch do Instruments (iOS), sem pré-otimização de perfil, sem Native AOT para o MAUI, Impeller ligado para o Flutter, Hermes + Fabric para o RN.

| Métrica                                   | Flutter 3.44     | React Native 0.82 | MAUI 11 (CoreCLR) |
| ----------------------------------------- | ---------------- | ----------------- | ----------------- |
| Cold start no Android, somente código do app | 320 ms        | 450 ms            | 480 ms            |
| Tamanho do APK Android, release, arquitetura única | 19 MB    | 24 MB             | 22 MB             |
| Cold start no iOS, somente código do app  | 280 ms           | 340 ms            | 360 ms            |
| Tamanho do IPA iOS, release               | 28 MB            | 35 MB             | 38 MB             |
| Pegada de memória em idle (Android)       | 78 MB            | 110 MB            | 132 MB            |
| Frames por segundo sob scroll pesado      | 119,2            | 117,8             | 118,4             |

O Flutter ganha o cold start em todos os fronts porque seu engine é Dart compilado em AOT desde o lançamento e não sobe um runtime JS ou CoreCLR primeiro. O React Native está mais perto do MAUI do que costumava estar porque Hermes + Fabric pagam o custo de inicialização uma vez, não a cada frame. MAUI no CoreCLR está mais perto do RN do que o número MAUI-no-Mono que você pode ter visto citado (que era ~720 ms no Android para o mesmo template). A linha de FPS é essencialmente um empate: os três renderizam no teto de refresh do dispositivo uma vez que o app está em execução. Cold start importa para a percepção do lançamento do app. FPS sustentado importa para a sensação dentro do app. A primeira linha decide "o ícone parece ágil". A última linha decide "o app parece moderno". A diferença na primeira linha é real, mas pequena; a diferença na última linha não é mensurável.

## A pegadinha que decide por você

Três coisas forçam a decisão independentemente da preferência:

1. **A linguagem existente do seu time.** Um time TypeScript escolhe React Native. Um time C# escolhe MAUI. Apenas um time sem stack incumbente, ou um especificamente disposto a aprender Dart, escolhe Flutter. O custo de ensinar a um engenheiro sênior uma terceira linguagem que ele só vai usar no projeto mobile é real, e não aparece em uma tabela de matriz de recursos.
2. **Web está no roadmap, mesmo que não em v1.** Se "vamos publicar uma versão web em algum momento" está na especificação do produto, RN com `react-native-web` ou Flutter Web são os dois caminhos viáveis, e apenas o RN está pronto para produção em 2026. O Flutter Web é um alvo de qualidade de versão prévia para apps não triviais; o time do Flutter já disse isso. O MAUI não tem história para navegador (Blazor Hybrid é um stack separado com um modelo de programação diferente). Se você escolher o MAUI e precisar de uma versão web depois, você está escrevendo um segundo app.
3. **Módulos nativos de primeira mão que você não consegue abstrair.** Diálogos de App Tracking Transparency, App Clips, Live Activities, widgets de Dynamic Island, tiles de Wear OS, Health Connect, App Intents. O Flutter tem plugins para a maioria deles; alguns ainda são mantidos pela comunidade. O RN tem a cobertura mais ampla de plugins graças ao ecossistema Expo. O MAUI expõe as APIs nativas da plataforma diretamente porque o controle subjacente é o widget real da plataforma, então lacunas por recurso são menos frequentes. Se a especificação do seu produto lista três ou mais recursos específicos de plataforma iOS no primeiro trimestre, o MAUI tem o menor atrito; se lista três ou mais recursos específicos de plataforma Android, Flutter ou RN são mais fáceis porque o ecossistema de plugins é mais amplo.

Um exemplo prático de como os ecossistemas divergem: integração com AI. O Anthropic SDK para TypeScript e Python é de primeira mão; o [Anthropic SDK para Dart](https://pub.dev/) é mantido pela comunidade; o Anthropic SDK para .NET é mantido pela comunidade, mas é coberto por [Microsoft.Extensions.AI no .NET 11](/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/), que é de primeira mão na camada de abstração, se não no cliente do provedor. Se seu app mobile faz chamadas diretas a AI, o RN é o caminho de menor atrito em 2026 por uma margem notável.

## Recomendação reafirmada

Para um novo app mobile começando hoje:

- **UI idêntica pixel a pixel, animação a 120 Hz, produto orientado pelo time de design, disposto a investir em Dart**: escolha **Flutter 3.44**. Cold start mais rápido, pipeline de renderização apoiado pelo Impeller, desktop Linux GA dentro do escopo.
- **Time TypeScript, roadmap pesado em npm, irmão web no roadmap**: escolha **React Native 0.82**. A New Architecture é obrigatória e limpa, o Expo é o scaffold padrão, o ecossistema JavaScript é o mais profundo dos três.
- **Mobile é uma superfície de um produto .NET 11 mais amplo, Microsoft no contrato de suporte**: escolha **.NET MAUI 11**. Stack C# compartilhado entre mobile, desktop e servidor. CoreCLR por padrão fecha a maior parte da lacuna histórica de cold start.

Se você está pesando uma migração a partir de um app existente:

- Do Xamarin.Forms: vá para MAUI. O caminho de migração é direto.
- De uma base de código React para web: RN com Expo é o menor esforço.
- De um stack híbrido infeliz (Cordova, Ionic, Capacitor) onde o WebView é o gargalo: Flutter ou RN resolvem o problema; escolha pela adequação de linguagem.

## Relacionados

- [MAUI vs Avalonia vs Uno Platform: qual escolher em 2026?](/pt-br/2026/05/maui-vs-avalonia-vs-uno-in-2026/) para a comparação multiplataforma interna ao .NET.
- [A separação dos pacotes Material e Cupertino do Flutter 3.44, com Swift Package Manager como padrão](/pt-br/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) para a versão mais recente do Flutter.
- [MAUI no CoreCLR por padrão para Android e iOS no .NET 11 Preview 4](/pt-br/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) para a mudança de runtime que atualizou os números de cold start do MAUI neste post.
- [Como empacotar um aplicativo MAUI para a Microsoft Store](/pt-br/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) para o lado da distribuição Windows, quando o MAUI é sua escolha de irmão-de-desktop.
- [Como migrar um Xamarin.Forms ListView para MAUI CollectionView](/pt-br/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) para o passo de migração mais perguntado no movimento Xamarin para MAUI.

## Fontes

- [Notas de release do Flutter 3.44](https://docs.flutter.dev/release/release-notes), documentação do Flutter, acessado em 2026-05-27.
- [Notas de release do React Native 0.82](https://reactnative.dev/blog), Meta open source.
- [Documentação do .NET MAUI](https://learn.microsoft.com/dotnet/maui/), Microsoft Learn, acessado em 2026-05-27.
- [Changelog do Expo SDK 53](https://docs.expo.dev/), documentação do Expo.
- [Visão geral da New Architecture do React Native](https://reactnative.dev/docs/the-new-architecture/landing-page), documentação do React Native.
- [Backend gráfico Impeller](https://docs.flutter.dev/perf/impeller), documentação do Flutter.
