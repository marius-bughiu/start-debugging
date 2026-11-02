---
title: "Cómo instalar la CLI de Aspire para un AppHost de C#"
description: "Instala y verifica la CLI de Aspire para un AppHost de C#. Por qué dotnet workload install aspire corresponde a la preview original de .NET 8."
pubDate: 2023-11-15
updatedDate: 2026-11-02
tags:
  - "aspire"
  - "dotnet"
lang: "es"
translationOf: "2023/11/how-to-install-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---

Para un **AppHost de C#** con Aspire 13.x, instala el SDK de .NET 10 y la CLI de Aspire. Comprueba en una terminal que aparece un SDK 10.x, instala la CLI como herramienta global de .NET y verifica que el shell la encuentra:

```sh
dotnet --list-sdks
dotnet tool install --global Aspire.Cli
aspire --version
```

Si el último comando no encuentra `aspire`, vuelve a abrir la terminal y comprueba que el directorio de herramientas globales de .NET esté en `PATH`. Para un gestor de paquetes de Windows, Homebrew u otros métodos, consulta [la guía de instalación de la CLI](https://aspire.dev/get-started/install-cli/). Elige un método de instalación.

Un AppHost que inicia Redis o una base de datos en un contenedor también necesita un runtime de contenedores en ejecución. Docker Desktop y Podman son dos opciones. Los [requisitos de Aspire](https://aspire.dev/get-started/prerequisites/) explican su configuración y distinguen el SDK necesario para el AppHost de C# de los frameworks de destino de sus servicios.

## Por qué las instrucciones antiguas instalan un workload de Aspire

**Corrección — 2 de noviembre de 2026:** `dotnet workload install aspire` era el comando de instalación de la [preview de .NET 8 de noviembre de 2023](https://devblogs.microsoft.com/dotnet/introducing-dotnet-aspire-simplifying-cloud-native-development-with-dotnet-8/). [Aspire 9 trasladó las plantillas a paquetes NuGet](https://aspire.dev/whats-new/aspire-9/) y eliminó el requisito del workload. El comando y las capturas siguientes documentan esa instalación anterior:

```sh
dotnet workload install aspire
```

En la preview, Visual Studio Installer ofrecía el componente opcional **.NET Aspire SDK (Preview)** dentro del workload de desarrollo web. La segunda imagen muestra el instalador de Docker Desktop para Windows de aquella época.

[![Visual Studio Installer con ASP.NET and web development seleccionado y .NET Aspire SDK (Preview) marcado en Optional.](/wp-content/uploads/2023/11/image-1-1024x524.png)](/wp-content/uploads/2023/11/image-1.png)

[![Instalador de Docker Desktop con las opciones de usar WSL 2 en lugar de Hyper-V y crear un acceso directo marcadas.](/wp-content/uploads/2023/11/image-2.png)](/wp-content/uploads/2023/11/image-2.png)

Cuando `aspire --version` funcione, [crea tu primera aplicación de Aspire](/es/2023/11/getting-started-with-net-aspire/). Para entender el papel del AppHost, consulta [cómo conecta Aspire los servicios](/es/2023/11/what-is-net-aspire/).
