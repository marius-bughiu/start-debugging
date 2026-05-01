---
title: "Cómo instalar .NET Aspire (dotnet workload install aspire)"
description: "Instala .NET Aspire mediante `dotnet workload install aspire`. Configuración paso a paso de .NET 8, el workload de Aspire y Docker en Windows, macOS y Linux."
pubDate: 2023-11-15
tags:
  - "aspire"
  - "dotnet"
lang: "es"
translationOf: "2023/11/how-to-install-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET Aspire es un framework integral, orientado a la nube, diseñado para crear aplicaciones distribuidas escalables, observables y de nivel de producción. En este artículo veremos los requisitos previos para empezar con .NET Aspire. Si quieres una visión general de .NET Aspire y de lo que aporta, revisa nuestro artículo [What is .NET Aspire](/es/2023/11/what-is-net-aspire/).

Hay tres elementos principales que necesitarás para desarrollar aplicaciones con .NET Aspire:

-   [.NET 8](#install-net-8)
-   el [workload de .NET Aspire](#install-the-net-aspire-workload)
-   y [Docker Desktop](#install-docker-desktop)

Si planeas usar Visual Studio para desarrollar tu aplicación, ten en cuenta que necesitarás Visual Studio 2022 Preview, versión 17.9 o superior.

## Install .NET 8

Si usas Visual Studio y ya lo has actualizado a la última versión, entonces ya tienes .NET 8 instalado. Si no estás en la última versión, asegúrate de usar Visual Studio versión 17.9 o superior y con eso será suficiente.

Si no usas Visual Studio, puedes descargar e instalar el SDK de .NET 8 desde aquí: [https://dotnet.microsoft.com/en-us/download/dotnet/8.0](https://dotnet.microsoft.com/en-us/download/dotnet/8.0)

## Install the .NET Aspire workload

El workload de .NET Aspire se puede instalar de dos maneras:

-   desde la línea de comandos usando la CLI de dotnet
-   o usando el Visual Studio Installer (para Visual Studio ten en cuenta que necesitarás VS 17.9 o superior)

### Using .NET CLI

El comando para instalar .NET Aspire desde la línea de comandos es bastante simple. Solo asegúrate de tener el SDK de .NET 8 instalado y estarás listo para ejecutar el comando de instalación del workload:

```bash
dotnet workload install aspire
```

### Using the Visual Studio Installer

En tu Visual Studio Installer, asegúrate de seleccionar el workload **ASP.NET and web development** y, en el panel derecho, en **Optional**, marca **.NET Aspire SDK (Preview)** y luego haz clic en **Modify** para iniciar el proceso de instalación.

[![](/wp-content/uploads/2023/11/image-1-1024x524.png)](/wp-content/uploads/2023/11/image-1.png)

## Install Docker Desktop

Puedes descargar la última versión de Docker Desktop aquí: [https://www.docker.com/products/docker-desktop/](https://www.docker.com/products/docker-desktop/)

Pasa por el instalador con las opciones por defecto y, después de un reinicio, deberías estar listo.

[![](/wp-content/uploads/2023/11/image-2.png)](/wp-content/uploads/2023/11/image-2.png)

Ten en cuenta que Docker Desktop es gratis solo para uso personal por desarrolladores individuales, educación y la comunidad de código abierto. Cualquier otro tipo de uso está sujeto a una tarifa de licencia. Asegúrate de revisar [su página de precios](https://www.docker.com/pricing/) si tienes dudas.

Con todo instalado, ya estás listo para empezar a construir con .NET Aspire!
