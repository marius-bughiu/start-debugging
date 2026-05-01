---
title: "Cómo publicar un contenedor como tar.gz en .NET"
description: "Aprende a publicar un contenedor de .NET 8 como un archivo tar.gz usando la propiedad ContainerArchiveOutputPath con dotnet publish."
pubDate: 2023-11-11
tags:
  - "docker"
  - "dotnet"
lang: "es"
translationOf: "2023/11/how-to-publish-container-as-tar-gz-in-net"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir de .NET 8, es posible generar directamente un archivo de contenedor tar.gz. Esto resulta especialmente ventajoso para flujos de trabajo más complejos donde se necesitan actividades como escanear las imágenes antes de subirlas. Una vez creado el archivo, se puede transferir, escanear o incorporar a tu instalación local de Docker.

Para archivar durante la publicación, integra el atributo `ContainerArchiveOutputPath` en tu instrucción dotnet publish. Por ejemplo:

```bash
dotnet publish \
  -p PublishProfile=DefaultContainer \
  -p ContainerArchiveOutputPath=./containers/my-container.tar.gz
```
