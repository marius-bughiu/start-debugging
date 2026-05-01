---
title: "Obtener el stream de un Embedded Resource en .NET Core"
description: "Aprende a obtener el stream de un recurso embebido en .NET Core entendiendo cómo se compone el nombre del recurso y usando GetManifestResourceStream."
pubDate: 2020-11-20
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "es"
translationOf: "2020/11/get-embedded-resource-stream-in-net-core"
translatedBy: "claude"
translationDate: 2026-05-01
---
Para obtener un recurso embebido en .NET Core, primero hay que entender cómo se compone el nombre del recurso. Tiene 3 elementos, unidos por puntos (`.`):

-   el namespace raíz
-   el namespace extendido o de archivo
-   el nombre del archivo

Veamos un ejemplo concreto. Tenemos un proyecto (assembly) con namespace raíz `MyApp.Core`. Dentro del proyecto, tenemos una carpeta + subcarpeta como `Assets` > `Images`. Y dentro de ella, tenemos un recurso embebido llamado `logo.png`. En este caso:

-   namespace raíz: `MyApp.Core`
-   namespace extendido: `Assets.Images`
-   nombre del archivo: `logo.png`

Únelos con `.` y obtienes: `MyApp.Core.Assets.Images.logo.png`.

Una vez que sabes el identificador del recurso, solo necesitas una referencia al assembly que contiene el recurso real. Podemos obtenerla fácilmente desde cualquier clase definida en ese assembly. Suponiendo que tenemos una clase `MyClass`:

```cs
typeof(MyClass).Assembly.GetManifestResourceStream("MyApp.Core.Assets.Images.logo.png")
```

## Obtener una lista con todos los recursos embebidos en un assembly

Si no encuentras el recurso, normalmente se debe a una de las siguientes razones:

-   tienes el identificador mal
-   no has marcado el archivo como Embedded Resource
-   estás buscando en el assembly equivocado

Para ayudar a depurar, puedes listar todos los recursos embebidos en un assembly y partir de ahí. Para hacerlo:

```cs
typeof(MyClass).Assembly.GetManifestResourceNames()
```

Esto devolverá un simple `string[]`, que puedes usar fácilmente en la `Immediate Window` para depurar.
