---
title: "dotnetup: .NET por fin tiene un gestor de versiones del SDK al estilo de rustup"
description: "Microsoft esta construyendo dotnetup, una herramienta multiplataforma oficial para instalar, rastrear y cambiar entre SDKs y runtimes de .NET. Esto es lo que hace y en que punto esta en junio de 2026."
pubDate: 2026-06-22
tags:
  - "dotnet"
  - "tooling"
  - "sdk"
lang: "es"
translationOf: "2026/06/dotnetup-official-dotnet-sdk-version-manager"
translatedBy: "claude"
translationDate: 2026-06-22
---

Durante anos, gestionar los SDKs de .NET ha significado hacer malabares con tres cosas distintas: los instaladores independientes de la pagina de descargas, los scripts `dotnet-install` para CI y la herramienta `dotnet-core-uninstall` para limpiar el monton de versiones viejas que quedan atras. Nunca ha existido un unico comando que instale, rastree y cambie entre SDKs como lo hace `rustup` para Rust o `nvm` para Node. A partir de junio de 2026, eso esta cambiando. Microsoft esta construyendo `dotnetup`, y ya esta integrado en la forma en que el SDK de .NET se compila a si mismo.

## Que es realmente dotnetup

`dotnetup` es un gestor de versiones oficial y multiplataforma para SDKs y runtimes de .NET. Su unica tarea es instalar componentes en un directorio con alcance de usuario sin requerir elevacion, rastrear lo que tienes instalado en un manifiesto y cambiar la version activa de forma limpia. Sin solicitud de administrador, sin MSI, sin cirugia en el registro.

Los comportamientos principales:

- Instala SDKs y runtimes por usuario, asi que nunca necesitas `sudo` ni una terminal elevada.
- Lee `global.json` para resolver e instalar el SDK exacto que un repositorio fija.
- Rastrea los componentes instalados en un manifiesto para actualizaciones auditables y desinstalaciones limpias.
- Admite multiples runtimes en paralelo para escenarios de multi-targeting.
- Se distribuye como un binario compilado con AOT y firmado, para un arranque rapido y seguridad de la cadena de suministro.

El unico comando confirmado en el issue de seguimiento de `dotnet/sdk` es la ruta de instalacion, usada aqui para obtener un SDK preliminar en un script de compilacion:

```bash
dotnetup sdk install preview
```

El conjunto de comandos mas amplio (listar versiones instaladas, establecer un valor por defecto, desinstalar) todavia se esta finalizando en abierto, asi que trata cualquier ejemplo mas largo como ilustrativo y no como definitivo.

## Por que global.json es la verdadera ventaja

La parte dolorosa del trabajo con .NET en multiples repositorios hoy es la discrepancia con `global.json`. Clonas un repositorio, ejecutas `dotnet build` y obtienes un error porque fija un SDK que no tienes instalado. Tus unicas opciones son buscar el instalador correcto o editar el archivo.

```json
{
  "sdk": {
    "version": "10.0.301",
    "rollForward": "latestPatch"
  }
}
```

Con un gestor de versiones que entiende este archivo, la resolucion se convierte en un solo paso: apunta `dotnetup` al repositorio y deja que obtenga el SDK fijado en tu perfil de usuario. Esa es la misma ergonomia que los desarrolladores de Rust han tenido durante anos con `rust-toolchain.toml`.

## En que punto esta ahora mismo

`dotnetup` esta en version preliminar interna. Todavia no hay un instalador de una sola linea en el sitio de .NET, y la forma practica de probarlo hoy es compilarlo desde el codigo fuente. Se planea una version preliminar publica para los proximos meses. Cabe destacar que la rama `main` de `dotnet/sdk` ya usa `dotnetup` como parte de su propia compilacion, lo cual es una senal fuerte de que este es el futuro previsto para la instalacion de .NET y no un experimento.

Si mantienes pipelines de CI o incorporas desarrolladores a repositorios con SDKs fijados de forma estricta, esta es la herramienta a vigilar. Sigue el progreso en el [issue de dotnet/sdk sobre el uso de dotnetup en scripts de compilacion](https://github.com/dotnet/sdk/issues/52699) y en el [issue de concienciacion que senala que la rama main ahora se compila con el](https://github.com/dotnet/sdk/issues/54601).
