---
title: "Kebab case: todo sobre él y más"
description: "Kebab case es una convención de nomenclatura usada en programación para dar formato a nombres de variables, funciones o archivos separando las palabras con guiones ('-'). También se le conoce como 'kebab-case', 'hyphen-case' o 'spinal-case'. Por ejemplo, si tienes una variable que representa el nombre de pila de una persona, en kebab case la escribirías así: En kebab case, todas..."
pubDate: 2023-11-03
updatedDate: 2023-11-17
tags:
  - "informational"
lang: "es"
translationOf: "2023/11/kebab-case-everything-about-it-and-more"
translatedBy: "claude"
translationDate: 2026-05-01
---
Kebab case es una convención de nomenclatura usada en programación para dar formato a nombres de variables, funciones o archivos separando las palabras con guiones ('-'). También se le conoce como 'kebab-case', 'hyphen-case' o 'spinal-case'.

Por ejemplo, si tienes una variable que representa el nombre de pila de una persona, en kebab case la escribirías así:

```
first-name
```

En kebab case todas las letras van en minúsculas y las palabras se separan con guiones, lo que hace al código más legible y asegura que los nombres no contengan espacios ni caracteres especiales que podrían causar problemas en ciertos lenguajes de programación o sistemas de archivos.

Kebab case se usa habitualmente en HTML y CSS para nombrar propiedades, clases y variables.

## Una breve historia

El término 'kebab case' como convención de nomenclatura para programación ganó popularidad a finales del siglo XX y principios del siglo XXI, principalmente por su relevancia en el desarrollo web.

En los primeros días del desarrollo web, HTML y CSS usaban distintas convenciones de nomenclatura, como guiones bajos, espacios o camel case, lo que provocaba inconsistencias entre navegadores. Esta inconsistencia hizo necesaria una forma más estandarizada de nombrar elementos en documentos web.

La adopción de los Identificadores Uniformes de Recursos (URI) para los recursos web a principios de los años 2000 reforzó aún más la importancia de una nomenclatura consistente. Tener espacios o caracteres especiales en URLs podía provocar problemas de codificación y romper enlaces. Como resultado, kebab case se convirtió en la convención preferida para nombrar recursos en URLs.

A lo largo de la década de 2010, kebab case fue ampliamente adoptado por la comunidad de desarrollo web para atributos de HTML y para nombres de clases y variables de CSS. También se abrió camino en otros lenguajes de programación y convenciones de nomenclatura de archivos como una forma de crear nombres claros y consistentes.

Aunque kebab case puede no tener una historia tan larga como otras convenciones de nomenclatura, su simplicidad, consistencia y compatibilidad con el desarrollo web lo han convertido en una opción popular en la era moderna. Conviene recordar que las convenciones de nomenclatura pueden variar entre lenguajes de programación y comunidades, por lo que es recomendable seguir las que se hayan establecido dentro del proyecto o lenguaje específico con el que estés trabajando.

## Ejemplos de uso

Kebab case se usa con frecuencia en distintos contextos modernos de programación, especialmente en desarrollo web. Aquí tienes algunos ejemplos de uso:

### HTML y CSS

```html
<div class="user-profile">
```

En HTML y CSS, kebab case se usa habitualmente para nombres de clase para dar estilo a elementos específicos.

### URLs y rutas

```javascript
// Express.js route definition
app.get('/user-profile', (req, res) => {
  // Route handling logic
});
```

Kebab case se usa con frecuencia para definir rutas en frameworks web como Express.js. También es común en URLs.

### Opciones de línea de comandos

```bash
my-script --option-name value
```

En herramientas y scripts de línea de comandos, kebab case se usa a veces para nombrar opciones y argumentos.

### Nombres de archivo (desarrollo web)

```
header-styles.css
analytics-script.js
privacy-policy.html
```

Kebab case se usa a veces para nombrar archivos en desarrollo web para mantener la consistencia con las convenciones de HTML y CSS.

### Nombres de paquetes (Node.js)

```
npm install my-package-name
```

En Node.js, kebab case se usa a menudo para nombres de paquetes al publicar o instalar paquetes con npm.

### Nombres de atributos en HTML y XML

```xml
<button data-toggle-modal="my-modal">Open Modal</button>
```

Kebab case se usa para atributos de datos personalizados en HTML y XML para que sean más legibles para humanos y mantengan la consistencia.

### Variables de CSS

```css
--primary-color: #3498db;
```

Kebab case se usa habitualmente para nombrar variables de CSS, ya que mejora la legibilidad y la facilidad de mantenimiento.

### Frameworks de front-end

```xml
<MyComponent prop-name="value" />
```

Algunos frameworks y bibliotecas de front-end, como Angular y React, recomiendan kebab case para nombrar propiedades en componentes JSX.

_Editado el 17/11/2023: Una versión anterior de este artículo afirmaba incorrectamente que kebab-case era una convención de nomenclatura válida para variables y funciones de JavaScript y Python. Gracias @Art por señalar el error._
