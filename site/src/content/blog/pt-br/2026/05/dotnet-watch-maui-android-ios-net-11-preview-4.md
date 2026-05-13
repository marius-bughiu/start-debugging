---
title: "dotnet watch finalmente chega ao MAUI no Android e no iOS no .NET 11 Preview 4"
description: "O .NET 11 Preview 4 liga o dotnet watch para dispositivos Android, emuladores Android e o Simulador do iOS. Você edita, salva e o app em execução se atualiza sem rebuild manual. Há uma pegadinha de csproj que vale para iOS."
pubDate: 2026-05-13
tags:
  - "dotnet-11"
  - "maui"
  - "dotnet-watch"
  - "hot-reload"
  - "mobile"
lang: "pt-br"
translationOf: "2026/05/dotnet-watch-maui-android-ios-net-11-preview-4"
translatedBy: "claude"
translationDate: 2026-05-13
---

A Microsoft [lançou o .NET 11 Preview 4 em 12 de maio de 2026](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/) e, para quem desenvolve em MAUI, a manchete é pequena no changelog mas enorme no dia a dia: o `dotnet watch` agora aciona Hot Reload em dispositivos Android, emuladores Android e no Simulador do iOS. Até esta versão prévia, o ciclo mobile do MAUI era "editar, recompilar, reimplantar" para qualquer coisa fora de XAML. O Preview 4 fecha essa lacuna.

## O fluxo na prática

Abra um app MAUI, escolha um target framework e um dispositivo, e rode:

```bash
dotnet watch --framework net11.0-android
```

Para iOS é o mesmo formato, com o target do Simulador do iOS:

```bash
dotnet watch --framework net11.0-ios
```

O `dotnet watch` implanta o app uma vez e depois traduz os eventos de alteração de arquivo em deltas de Hot Reload, que são enviados ao processo em execução. Corpos de método em C#, XAML e CSS fluem por esse canal. Adicionar um novo `PackageReference` ou `ProjectReference` no meio da sessão também funciona no .NET 11: o Roslyn valida a mudança, o target `ReferenceCopyLocalPathsOutputGroup` copia os novos assemblies para o diretório de saída e o aplicador de deltas in-process os carrega via o evento `AssemblyResolving`. Sem reinício.

## A pegadinha de iOS que você precisa conhecer

Há um problema conhecido que vale fixar no quadro. Conforme as [notas de versão do MAUI Preview 4](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/dotnetmaui.md), o `dotnet watch` não funciona em projetos iOS a menos que o `MtouchLink` esteja desabilitado. Coloque isto no `PropertyGroup` de iOS do seu `.csproj`:

```xml
<PropertyGroup Condition="$(TargetFramework.Contains('-ios'))">
  <MtouchLink>None</MtouchLink>
</PropertyGroup>
```

Isso desabilita o linker gerenciado para builds Debug de iOS, o que é ok para o inner loop de desenvolvimento, mas você não quer isso em Release. Mantenha a condição restrita ao TFM de iOS e ao Debug, ou mova para uma condição `Debug|iPhoneSimulator` se você tem configurações de plataforma separadas.

As outras correções que o Preview 4 trouxe para o caminho de iOS merecem destaque: os conflitos de entrada de console com o simulador foram resolvidos, a exceção de WebSocket que matava a sessão de Hot Reload sumiu e o deadlock que travava o app em edições rápidas foi corrigido. São os bugs que tornavam as versões prévias anteriores inutilizáveis no iOS mesmo quando o watch tecnicamente subia.

## Por que isso importa mais do que parece

O ciclo de feedback do MAUI tem sido a razão mais citada para veteranos de Xamarin e devs próximos do Flutter se manterem à distância. Um rebuild de 30 segundos depois de cada edição em C# mata o trabalho exploratório de UI. O `dotnet watch` para targets de desktop (Windows, Mac Catalyst) existe há tempos, mas mobile é onde o MAUI vive ou morre. O Preview 4 finalmente coloca o inner loop mobile do MAUI na mesma liga do hot reload do `flutter run`.

Se você já acompanha as versões prévias do .NET 11 em uma branch paralela, esta é a que vale a pena usar em um projeto real. Se estava esperando, [baixe o Preview 4](https://dotnet.microsoft.com/download/dotnet/11.0) e atualize o `.csproj` de iOS antes de rodar `dotnet watch` pela primeira vez.
