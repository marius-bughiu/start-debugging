---
title: "Como instalar o .NET Aspire (dotnet workload install aspire)"
description: "Instale o .NET Aspire via `dotnet workload install aspire`. Configuração passo a passo do .NET 8, do workload do Aspire e do Docker no Windows, macOS e Linux."
pubDate: 2023-11-15
tags:
  - "aspire"
  - "dotnet"
lang: "pt-br"
translationOf: "2023/11/how-to-install-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---
O .NET Aspire é um framework abrangente, orientado para a nuvem, projetado para criar aplicações distribuídas escaláveis, observáveis e de nível de produção. Neste artigo vamos ver os pré-requisitos para começar com o .NET Aspire. Se você quer uma visão geral do .NET Aspire e do que ele oferece, confira nosso artigo [What is .NET Aspire](/pt-br/2023/11/what-is-net-aspire/).

Existem três coisas principais que você vai precisar para desenvolver aplicações com o .NET Aspire:

-   [.NET 8](#install-net-8)
-   o [workload do .NET Aspire](#install-the-net-aspire-workload)
-   e o [Docker Desktop](#install-docker-desktop)

Se você planeja usar o Visual Studio para desenvolver sua aplicação, observe que vai precisar do Visual Studio 2022 Preview, versão 17.9 ou superior.

## Install .NET 8

Se você usa o Visual Studio e já atualizou para a versão mais recente, então já tem o .NET 8 instalado. Se não está na versão mais recente, certifique-se de usar o Visual Studio versão 17.9 ou superior e isso deve resolver.

Se você não usa o Visual Studio, pode baixar e instalar o SDK do .NET 8 aqui: [https://dotnet.microsoft.com/en-us/download/dotnet/8.0](https://dotnet.microsoft.com/en-us/download/dotnet/8.0)

## Install the .NET Aspire workload

O workload do .NET Aspire pode ser instalado de duas formas:

-   pela linha de comando usando a CLI do dotnet
-   ou usando o Visual Studio Installer (para o Visual Studio observe que vai precisar do VS 17.9 ou superior)

### Using .NET CLI

O comando para instalar o .NET Aspire pela linha de comando é bem simples. Apenas certifique-se de ter o SDK do .NET 8 instalado e você está pronto para executar o comando de instalação do workload:

```bash
dotnet workload install aspire
```

### Using the Visual Studio Installer

No Visual Studio Installer, certifique-se de selecionar o workload **ASP.NET and web development** e, no painel direito, em **Optional**, marque **.NET Aspire SDK (Preview)** e depois clique em **Modify** para iniciar o processo de instalação.

[![](/wp-content/uploads/2023/11/image-1-1024x524.png)](/wp-content/uploads/2023/11/image-1.png)

## Install Docker Desktop

Você pode baixar a versão mais recente do Docker Desktop aqui: [https://www.docker.com/products/docker-desktop/](https://www.docker.com/products/docker-desktop/)

Passe pelo instalador com as opções padrão e, após reiniciar, deve estar tudo certo.

[![](/wp-content/uploads/2023/11/image-2.png)](/wp-content/uploads/2023/11/image-2.png)

Observe que o Docker Desktop é gratuito apenas para uso pessoal por desenvolvedores individuais, educação e comunidade de código aberto. Qualquer outro tipo de uso está sujeito a uma taxa de licença. Confira [a página de preços](https://www.docker.com/pricing/) se tiver dúvidas.

Com tudo instalado, você está pronto para começar a construir com o .NET Aspire!
