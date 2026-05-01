---
title: "Cómo empezar a programar con C#"
description: "Una guía para principiantes sobre cómo empezar a programar en C#, desde la instalación de Visual Studio hasta escribir tu primer programa y encontrar recursos para aprender."
pubDate: 2023-06-11
tags:
  - "csharp"
  - "dotnet"
lang: "es"
translationOf: "2023/06/how-to-start-programming-with-c"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# es un lenguaje de programación moderno, de propósito general y orientado a objetos, desarrollado por Microsoft. Se utiliza ampliamente para aplicaciones de escritorio en Windows, videojuegos (especialmente con el motor Unity) y desarrollo web a través del framework ASP.NET.

C# se considera amigable para principiantes y es un gran lenguaje para nuevos programadores. A continuación exploramos algunas de las razones por las que C# se considera amigable para principiantes:

-   **Sintaxis** -- la sintaxis de C# es clara, consistente y fácil de entender, lo que es ideal para principiantes. Además, si conoces C# es relativamente fácil aprender otros lenguajes derivados de C (Java, C++).
-   **Lenguaje fuertemente tipado** -- al ser un lenguaje fuertemente tipado, C# obliga a definir con qué tipo de datos estás trabajando, como enteros o cadenas. Esto puede llevar a un código menos propenso a errores.
-   **Soporte de IDE** -- C# cuenta con un sólido soporte de IDE, con herramientas como Visual Studio y Visual Studio Code que ofrecen funciones como IntelliSense (autocompletado de código), depuración y muchas otras utilidades, lo que hace que la experiencia de programación sea fluida y manejable para principiantes.
-   **Documentación exhaustiva y comunidad** -- Microsoft proporciona documentación detallada para C#. Además, existe una comunidad amplia y activa de C# que puede ayudarte a responder preguntas y resolver los problemas que encuentres.
-   **Programación orientada a objetos** -- C# es fundamentalmente orientado a objetos. Aprender sobre clases, objetos, herencia y polimorfismo es crítico para desarrollar software a gran escala y videojuegos, y C# es un gran lenguaje para aprender estos conceptos.
-   **Amplia variedad de usos** -- aprender C# abre oportunidades para programar en una amplia variedad de plataformas, incluyendo aplicaciones de Windows, sitios web con ASP.NET y desarrollo de videojuegos con Unity.
-   **Manejo de errores** -- C# es bueno señalando errores en el código. Está diseñado para detener la compilación en cuanto encuentra errores, lo que ayuda a los nuevos programadores a detectarlos y corregirlos fácilmente.

## Cómo empezar

Lo primero es preparar tu entorno. Puedes usar cualquier sistema operativo para escribir C# y también hay múltiples opciones de editores. Incluso puedes escribir y ejecutar código C# en el navegador desde tu teléfono o tablet usando sitios como [.NET Fiddle](https://dotnetfiddle.net/).

Un entorno típico de desarrollo sería Visual Studio ejecutándose en Windows. Visual Studio incluye una edición Community gratuita que puedes [descargar desde aquí](https://visualstudio.microsoft.com/downloads/). Una vez descargado el instalador, sigue el asistente de instalación con las cargas de trabajo predeterminadas y, al terminar, deberías tener todo listo para escribir tu primer programa en C#.

## Cómo escribir tu primera línea de código en C#

Los archivos de código C# se escriben y se compilan como parte de un proyecto. Varios proyectos forman una solución. Para empezar, necesitamos crear primero un **Nuevo proyecto**. Puedes usar las **Acciones rápidas** en la página de **Bienvenida** para crear un nuevo proyecto C#.

[![](/wp-content/uploads/2023/06/image.png)](/wp-content/uploads/2023/06/image.png)

Acciones rápidas en Visual Studio 2022, con Nuevo proyecto resaltado.

Para empezar de forma simple, queremos crear una nueva aplicación de consola. Busca en la lista de plantillas 'console' y elige la que tenga la insignia de C# como se muestra abajo:

[![](/wp-content/uploads/2023/06/image-1.png)](/wp-content/uploads/2023/06/image-1.png)

Una lista de plantillas de proyecto en Visual Studio 2022, con la plantilla de aplicación de consola C# resaltada.

Continúa con el asistente usando los valores predeterminados y deberías terminar en un estado similar a este:

[![](/wp-content/uploads/2023/06/image-2.png)](/wp-content/uploads/2023/06/image-2.png)

Visual Studio 2022 mostrando una nueva aplicación de consola C# usando instrucciones de nivel superior.

A la derecha tienes el **Explorador de soluciones**, que muestra tu solución, tu proyecto y tu archivo de código: **Program.cs**. La extensión del archivo: **.cs** -- significa **CSharp** (C#). Todos tus archivos de código C# tendrán la misma extensión.

En el centro del editor tienes este archivo **Program.cs** abierto. El archivo contiene dos líneas de código.

-   **Línea 1**: esta línea representa un comentario en C#. Cualquier cosa escrita después de `//` en la misma línea es un comentario y el compilador la ignora; no se ejecuta cuando ejecutas el programa. Los comentarios se utilizan para explicar el código y son especialmente útiles para recordar a ti mismo y a otros el propósito y los detalles del código.
-   **Línea 2**: Esta línea de código escribe la cadena "Hello, World!" en la consola y luego termina la línea actual.
    -   `Console` es una clase estática en el espacio de nombres `System`, que representa los flujos estándar de entrada, salida y error para aplicaciones de consola. Esta clase se utiliza con mayor frecuencia para leer y escribir en la consola.
    -   `WriteLine` es un método de la clase `Console`. Este método escribe una línea en el flujo de salida estándar, que normalmente es la consola. La línea que se va a escribir se pasa como argumento a este método. En este caso, es la cadena "Hello, World!".
    -   El punto y coma `;` al final de la línea indica el final de la instrucción, similar al punto al final de una oración en español.

A continuación, ejecutemos el programa y veamos lo que produce. Para compilar y ejecutar el programa, puedes usar el botón Run en la barra de herramientas, o simplemente presionar **F5**.

[![](/wp-content/uploads/2023/06/image-3.png)](/wp-content/uploads/2023/06/image-3.png)

Una barra de herramientas en Visual Studio 2022, con el botón Run resaltado.

Visual Studio primero compilará tu proyecto y luego lo ejecutará. Al ser una aplicación de consola, aparecerá una ventana de consola con el mensaje "Hello, World!" en la primera línea.

[![](/wp-content/uploads/2023/06/image-4.png)](/wp-content/uploads/2023/06/image-4.png)

Una ventana de consola mostrando "Hello, World!".

## Recursos para aprender

Ahora que tu entorno está correctamente configurado y has ejecutado tu primer programa C#, es momento de empezar a aprender más sobre el lenguaje. Para ello, hay varios recursos excelentes disponibles para empezar. Enumeramos algunos a continuación:

-   [Microsoft Learn](https://dotnet.microsoft.com/en-us/learn/csharp) -- la plataforma oficial de Microsoft ofrece varios planes de aprendizaje, módulos y tutoriales gratuitos de C#. Es un gran recurso para aprender C# directamente desde la fuente.
-   [Codecademy](https://www.codecademy.com/learn/learn-c-sharp) -- Codecademy ofrece lecciones interactivas y proyectos que pueden ayudarte a aprender C#. Es amigable para principiantes y la naturaleza interactiva del aprendizaje es muy efectiva para muchos estudiantes.
-   [Coursera](https://www.coursera.org/courses?query=c%20sharp) -- Coursera ofrece cursos de universidades y empresas. La especialización C# Programming for Unity Game Development de la Universidad de Colorado es un buen curso si te interesa el desarrollo de videojuegos.
-   [Pluralsight](https://www.pluralsight.com/browse/software-development/c-sharp) -- Pluralsight tiene una biblioteca completa de cursos de C# que cubre desde temas para principiantes hasta avanzados. Es una plataforma de pago pero ofrece una prueba gratuita.
-   [Udemy](https://www.udemy.com/topic/c-sharp/) -- Udemy tiene una amplia variedad de cursos de C# para diferentes niveles y usos, incluyendo desarrollo web con ASP.NET, desarrollo de videojuegos con Unity, etc. Espera sus frecuentes ofertas para conseguir un buen precio.
-   [LeetCode](https://leetcode.com/) -- LeetCode es una plataforma de resolución de problemas donde puedes practicar programando en C#. No es un sitio de tutoriales, pero es invaluable para practicar y mejorar tus habilidades una vez que conoces los conceptos básicos.
