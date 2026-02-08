---
title: "Kebab case – everything about it and more"
description: "Kebab case is a naming convention used in programming to format variable, function, or file names by separating words with hyphens (“-“). It is also known as “kebab-case”, “hyphen-case”, or “spinal-case”. For example, if you have a variable representing a person’s first name, you would write it in kebab case as: In kebab case, all…"
pubDate: 2023-11-03
updatedDate: 2023-11-17
tags:
  - "informational"
---
Kebab case is a naming convention used in programming to format variable, function, or file names by separating words with hyphens (“-“). It is also known as “kebab-case”, “hyphen-case”, or “spinal-case”.

For example, if you have a variable representing a person’s first name, you would write it in kebab case as:

```
first-name
```

In kebab case, all letters are lowercase, and words are separated by hyphens, making the code more readable and ensuring that names do not contain spaces or special characters that might cause issues in certain programming languages or file systems.

Kebab case is commonly used in HTML and CSS for naming properties, classes and variables.

## A brief history

The term “kebab case” as a naming convention for computer programming gained popularity in the late 20th century and early 21st century, primarily due to its relevance in web development.

In the early days of web development, HTML and CSS used various naming conventions, such as underscores, spaces, or camel case, which led to inconsistencies across different browsers. This inconsistency prompted the need for a more standardized way to name elements in web documents.

The adoption of Uniform Resource Identifiers (URIs) for web resources in the early 2000s further emphasized the importance of consistent naming. Having spaces or special characters in URLs could cause encoding issues and break links. As a result, kebab case became the preferred convention for naming resources in URLs.

Throughout the 2010s, kebab case became widely adopted in the web development community for HTML attributes, CSS class and variable names. It also found its way into other programming languages and file-naming conventions as a way to create clear and consistent names.

While kebab case may not have as long a history as other naming conventions, its simplicity, consistency, and suitability for web development have made it a popular choice in the modern era. It’s essential to keep in mind that naming conventions can vary across programming languages and communities, so it’s advisable to follow the conventions established within the specific project or language you’re working with.

## Usage examples

Kebab case is commonly used in various modern programming contexts, especially in web development. Here are some usage examples:

###### HTML and CSS

```javascript
<div class="user-profile">
```

In HTML and CSS, kebab case is often used for class names to style specific elements.

###### URLs and Routing

```php
// Express.js route definition
app.get('/user-profile', (req, res) => {
  // Route handling logic
});
```

Kebab case is often used for defining routes in web frameworks like Express.js. It’s also commonly used in URLs.

###### Command-Line Options

```bash
my-script --option-name value
```

In command-line tools and scripts, kebab case is sometimes used for naming command-line options and arguments.

###### File Names (Web Development)

```css
header-styles.css
analytics-script.js
privacy-policy.html
```

Kebab case is sometimes used for naming files in web development to maintain consistency with HTML and CSS conventions.

###### Package Names (Node.js)

```
npm install my-package-name
```

In Node.js, kebab case is often used for package names when publishing or installing packages via npm.

###### Attribute Names in HTML and XML

```xml
<button data-toggle-modal="my-modal">Open Modal</button>
```

Kebab case is used for custom data attributes in HTML and XML to make them more human-readable and maintain consistency.

###### CSS Variables

```css
--primary-color: #3498db;
```

Kebab case is commonly used for naming CSS variables for better readability and maintainability.

###### Front-End Frameworks

```xml
<MyComponent prop-name="value" />
```

Some front-end frameworks and libraries, like Angular and React, encourage kebab case for naming properties in JSX components.

_Edited on 17/11/2023: A previous version of this article incorrectly stated that kebab-case is valid naming convention for JavaScript and Python variables and functions. Thanks @Art for pointing out the mistake._
