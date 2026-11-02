---
title: "Como instalar a CLI do Aspire para um AppHost em C#"
description: "Instale e confira a CLI do Aspire para um AppHost em C#. Entenda por que dotnet workload install aspire pertence à prévia original do .NET 8."
pubDate: 2023-11-15
updatedDate: 2026-11-02
tags:
  - "aspire"
  - "dotnet"
lang: "pt-br"
translationOf: "2023/11/how-to-install-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---

Para um **AppHost em C#** com Aspire 13.x, instale o SDK do .NET 10 e a CLI do Aspire. No terminal, confira se há um SDK 10.x listado, instale a CLI como ferramenta global do .NET e verifique se o shell a encontra:

```sh
dotnet --list-sdks
dotnet tool install --global Aspire.Cli
aspire --version
```

Se o último comando não encontrar `aspire`, reabra o terminal e confira se o diretório de ferramentas globais do .NET está no `PATH`. Para usar um gerenciador de pacotes do Windows, Homebrew ou outro método, consulte o [guia de instalação da CLI](https://aspire.dev/get-started/install-cli/). Escolha um método de instalação.

Um AppHost que inicia um contêiner de Redis ou de banco de dados também precisa de um runtime de contêineres em execução. Docker Desktop e Podman são opções. Os [pré-requisitos do Aspire](https://aspire.dev/get-started/prerequisites/) explicam a configuração do runtime e distinguem o SDK necessário ao AppHost em C# dos frameworks de destino dos serviços que ele executa.

## Por que instruções antigas instalam um workload do Aspire

**Correção — 2 de novembro de 2026:** `dotnet workload install aspire` era o comando de instalação da [prévia do .NET 8 de novembro de 2023](https://devblogs.microsoft.com/dotnet/introducing-dotnet-aspire-simplifying-cloud-native-development-with-dotnet-8/). O [Aspire 9 moveu os templates para pacotes NuGet](https://aspire.dev/whats-new/aspire-9/) e eliminou a necessidade do workload. O comando e as capturas abaixo documentam a configuração anterior:

```sh
dotnet workload install aspire
```

Na prévia, o Visual Studio Installer oferecia o componente opcional **.NET Aspire SDK (Preview)** no workload de desenvolvimento web. A segunda imagem mostra o instalador do Docker Desktop para Windows daquela época.

[![Visual Studio Installer com ASP.NET and web development selecionado e .NET Aspire SDK (Preview) marcado em Optional.](/wp-content/uploads/2023/11/image-1-1024x524.png)](/wp-content/uploads/2023/11/image-1.png)

[![Instalador do Docker Desktop com as opções de usar WSL 2 em vez de Hyper-V e criar um atalho marcadas.](/wp-content/uploads/2023/11/image-2.png)](/wp-content/uploads/2023/11/image-2.png)

Quando `aspire --version` funcionar, [crie seu primeiro aplicativo de exemplo com Aspire](/pt-br/2023/11/getting-started-with-net-aspire/). Para entender o papel do AppHost, veja [como o Aspire conecta os serviços](/pt-br/2023/11/what-is-net-aspire/).
