// src/index.ts
import * as fs from 'fs';
import { Project, SyntaxKind, ObjectLiteralExpression, Node, SourceFile } from 'ts-morph';

// Definice uzlu stromu rout
interface RouteNode {
  path: string;
  type: 'eager' | 'lazy-module' | 'lazy-component';
  name: string; // u eager rout: jméno komponenty, u lazy rout: označení modulu/komponenty
  title?: string; // hodnota z dekorátoru @FunselPage, pokud existuje
  children?: RouteNode[];
}

// Builder – vytváří jednotlivé uzly stromu
class RouteBuilder {
  buildEagerRoute(path: string, componentName: string, title?: string, children: RouteNode[] = []): RouteNode {
    return { path, type: 'eager', name: componentName, title, children };
  }
  buildLazyModule(path: string, moduleName: string, children: RouteNode[] = []): RouteNode {
    return { path, type: 'lazy-module', name: moduleName, children };
  }
  buildLazyComponent(path: string, componentName: string, title?: string, children: RouteNode[] = []): RouteNode {
    return { path, type: 'lazy-component', name: componentName, title, children };
  }
}

// Parser – načítá a rozparsovává routing soubory (včetně vnořených children)
class RouteParser {
  project: Project;
  constructor(project: Project) {
    this.project = project;
  }
  parseRoutingFile(filePath: string): Node[] {
    const sourceFile = this.project.getSourceFile(filePath);
    if (!sourceFile) {
      console.error(`Soubor nenalezen: ${filePath}`);
      return [];
    }
    const routeObjects: Node[] = [];
    sourceFile.forEachChild(node => {
      if (node.getKind() === SyntaxKind.VariableStatement) {
        const declarations = node.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
        declarations.forEach(declaration => {
          const initializer = declaration.getInitializer();
          if (initializer && initializer.getKind() === SyntaxKind.ArrayLiteralExpression) {
            initializer.forEachChild(child => {
              if (child.getKind() === SyntaxKind.ObjectLiteralExpression) {
                routeObjects.push(child);
              }
            });
          }
        });
      }
    });
    return routeObjects;
  }
  parseRouteObject(routeObject: Node): any {
    const route: any = {};
    const properties = (routeObject as ObjectLiteralExpression).getProperties();
    properties.forEach((prop: Node) => {
      if (prop.getKind() === SyntaxKind.PropertyAssignment) {
        const propName = (prop as any).getName();
        if (propName === 'path') {
          let pathText = prop.getInitializer()?.getText().replace(/['"`]/g, '') || '';
          if (!pathText) {
            const initializer = prop.getInitializer();
            if (initializer && initializer.getKind() === SyntaxKind.PropertyAccessExpression) {
              const parts = initializer.getText().split('.');
              if (parts.length > 1) {
                pathText = parts[1].toLowerCase().replace(/_/g, '-');
              }
            }
          }
          route.path = pathText;
        } else if (propName === 'component') {
          route.component = prop.getInitializer()?.getText();
          route.type = 'eager';
        } else if (propName === 'loadChildren') {
          route.loadChildren = prop.getInitializer()?.getText();
          route.type = 'lazy-module';
        } else if (propName === 'loadComponent') {
          route.loadComponent = prop.getInitializer()?.getText();
          route.type = 'lazy-component';
        } else if (propName === 'children') {
          const initializer = prop.getInitializer();
          if (initializer && initializer.getKind() === SyntaxKind.ArrayLiteralExpression) {
            route.children = [];
            initializer.forEachChild(child => {
              if (child.getKind() === SyntaxKind.ObjectLiteralExpression) {
                route.children.push(this.parseRouteObject(child));
              }
            });
          }
        }
      }
    });
    return route;
  }
  getComponentTitle(componentName: string): string | undefined {
    const sourceFiles = this.project.getSourceFiles();
    for (const file of sourceFiles) {
      const classDeclaration = file.getClass(componentName);
      if (classDeclaration) {
        const decorators = classDeclaration.getDecorators();
        for (const decorator of decorators) {
          if (decorator.getName() === 'FunselPage') {
            const args = decorator.getArguments();
            if (args.length > 0 && args[0].getKind() === SyntaxKind.ObjectLiteralExpression) {
              const objLiteral = args[0] as ObjectLiteralExpression;
              const titleProp = objLiteral.getProperty('title');
              if (titleProp && titleProp.getKind() === SyntaxKind.PropertyAssignment) {
                const initializer = (titleProp as any).getInitializer();
                if (initializer) {
                  return initializer.getText().replace(/['"`]/g, '');
                }
              }
            }
          }
        }
      }
    }
    return undefined;
  }
  extractLazyComponentInfo(loadComponentText: string): { alias: string; componentName: string } | undefined {
    const importRegex = /import\((['"`])(.*?)\1\)/;
    const thenRegex = /\.then\(\s*\w+\s*=>\s*\w+\.(\w+)\s*\)/;
    const importMatch = importRegex.exec(loadComponentText);
    const thenMatch = thenRegex.exec(loadComponentText);
    if (importMatch && importMatch[2] && thenMatch && thenMatch[1]) {
      return { alias: importMatch[2], componentName: thenMatch[1] };
    }
    return undefined;
  }
  getComponentTitleFromFile(file: SourceFile, componentName: string): string | undefined {
    const classDeclaration = file.getClass(componentName);
    if (classDeclaration) {
      const decorators = classDeclaration.getDecorators();
      for (const decorator of decorators) {
        if (decorator.getName() === 'FunselPage') {
          const args = decorator.getArguments();
          if (args.length > 0 && args[0].getKind() === SyntaxKind.ObjectLiteralExpression) {
            const objLiteral = args[0] as ObjectLiteralExpression;
            const titleProp = objLiteral.getProperty('title');
            if (titleProp && titleProp.getKind() === SyntaxKind.PropertyAssignment) {
              const initializer = (titleProp as any).getInitializer();
              if (initializer) {
                return initializer.getText().replace(/['"`]/g, '');
              }
            }
          }
        }
      }
    }
    return undefined;
  }
}

// NOVÁ pomocná funkce: převod PascalCase/camelCase na kebab-case
function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

// Director – řídí proces parsování a sestavování stromu
class RouteDirector {
  parser: RouteParser;
  builder: RouteBuilder;
  project: Project;
  tsconfigPaths: any;
  constructor(project: Project, parser: RouteParser, builder: RouteBuilder) {
    this.project = project;
    this.parser = parser;
    this.builder = builder;
    this.tsconfigPaths = this.loadTsconfigPaths();
  }
  loadTsconfigPaths(): any {
    try {
      const tsconfigBase = JSON.parse(fs.readFileSync('tsconfig.base.json', 'utf8'));
      return tsconfigBase.compilerOptions?.paths || {};
    } catch (err) {
      console.error('Chyba při čtení tsconfig.base.json', err);
      return {};
    }
  }
  // Vstup z kořenového app-routing.module.ts
  processRoutingModules(): RouteNode[] {
    const rootRoutingFile = this.project.getSourceFile('apps/funsel/src/app/app-routing.module.ts');
    if (!rootRoutingFile) {
      console.error('Kořenový routing soubor app-routing.module.ts nebyl nalezen.');
      return [];
    }
    const routeObjects = this.parser.parseRoutingFile(rootRoutingFile.getFilePath());
    const tree: RouteNode[] = [];
    routeObjects.forEach(routeObj => {
      const routeData = this.parser.parseRouteObject(routeObj);
      let node: RouteNode;
      if (routeData.type === 'eager' && routeData.component) {
        const title = this.parser.getComponentTitle(routeData.component);
        node = this.builder.buildEagerRoute(
          routeData.path,
          routeData.component,
          title,
          this.processRouteData(routeData.children || [])
        );
      } else if (routeData.type === 'lazy-module' && routeData.loadChildren) {
        const modulePath = this.extractModuleFilePath(routeData.loadChildren);
        let lazyChildren: RouteNode[] = [];
        if (modulePath) {
          lazyChildren = this.processLazyModule(modulePath);
        }
        node = this.builder.buildLazyModule(routeData.path, 'LazyModule', lazyChildren);
      } else if (routeData.type === 'lazy-component' && routeData.loadComponent) {
        const lazyResult = this.processLazyComponent(routeData.loadComponent);
        node = this.builder.buildLazyComponent(
          routeData.path,
          lazyResult.componentName,
          lazyResult.title,
          this.processRouteData(routeData.children || [])
        );
      } else {
        node = this.builder.buildEagerRoute(
          routeData.path,
          'Unknown',
          undefined,
          this.processRouteData(routeData.children || [])
        );
      }
      tree.push(node);
    });
    return tree;
  }
  processRouteData(routeDatas: any[]): RouteNode[] {
    return routeDatas.map(routeData => {
      if (routeData.type === 'eager' && routeData.component) {
        const title = this.parser.getComponentTitle(routeData.component);
        return this.builder.buildEagerRoute(
          routeData.path,
          routeData.component,
          title,
          this.processRouteData(routeData.children || [])
        );
      } else if (routeData.type === 'lazy-module' && routeData.loadChildren) {
        const modulePath = this.extractModuleFilePath(routeData.loadChildren);
        let lazyChildren: RouteNode[] = [];
        if (modulePath) {
          lazyChildren = this.processLazyModule(modulePath);
        }
        return this.builder.buildLazyModule(routeData.path, 'LazyModule', lazyChildren);
      } else if (routeData.type === 'lazy-component' && routeData.loadComponent) {
        const lazyResult = this.processLazyComponent(routeData.loadComponent);
        return this.builder.buildLazyComponent(
          routeData.path,
          lazyResult.componentName,
          lazyResult.title,
          this.processRouteData(routeData.children || [])
        );
      }
      return this.builder.buildEagerRoute(
        routeData.path,
        'Unknown',
        undefined,
        this.processRouteData(routeData.children || [])
      );
    });
  }
  extractModuleFilePath(loadChildrenText: string): string | undefined {
    const importRegex = /import\((['"`])(.*?)\1\)/;
    const match = importRegex.exec(loadChildrenText);
    if (match && match[2]) {
      return match[2];
    }
    return undefined;
  }
  processLazyModule(modulePath: string, visited: Set<string> = new Set()): RouteNode[] {
    if (visited.has(modulePath)) {
      console.warn(`Cyklické načtení modulu ${modulePath} - přeskočeno.`);
      return [];
    }
    visited.add(modulePath);
    let children: RouteNode[] = [];

    // Relativní cesta – použijeme ji přímo
    if (!modulePath.startsWith('@') && (modulePath.startsWith('./') || modulePath.startsWith('../'))) {
      const parts = modulePath.split('/');
      const lastSegment = parts[parts.length - 1];
      const baseName = lastSegment.replace(/\.module$/, '');
      const candidateFileName = `${baseName}-routing.module.ts`;
      let foundFiles = this.project.getSourceFiles().filter(file => file.getFilePath().endsWith(candidateFileName));
      if (foundFiles.length > 0) {
        foundFiles.forEach(file => {
          console.log(`Parsing lazy module [relative]: ${modulePath} -> ${file.getFilePath()}`);
          const routeObjects = this.parser.parseRoutingFile(file.getFilePath());
          routeObjects.forEach(routeObj => {
            const routeData = this.parser.parseRouteObject(routeObj);
            let parsedChildren: RouteNode[] = [];
            if (routeData.children) {
              parsedChildren = this.processRouteData(routeData.children);
            }
            if (routeData.type === 'eager' && routeData.component) {
              const title = this.parser.getComponentTitle(routeData.component);
              children.push(this.builder.buildEagerRoute(routeData.path, routeData.component, title, parsedChildren));
            } else if (routeData.type === 'lazy-module' && routeData.loadChildren) {
              const subModulePath = this.extractModuleFilePath(routeData.loadChildren);
              let subChildren: RouteNode[] = [];
              if (subModulePath) {
                subChildren = this.processLazyModule(subModulePath, visited);
              }
              children.push(this.builder.buildLazyModule(routeData.path, 'LazyModule', subChildren));
            } else if (routeData.type === 'lazy-component' && routeData.loadComponent) {
              const lazyResult = this.processLazyComponent(routeData.loadComponent);
              children.push(
                this.builder.buildLazyComponent(
                  routeData.path,
                  lazyResult.componentName,
                  lazyResult.title,
                  parsedChildren
                )
              );
            }
          });
        });
      } else {
        console.warn(`!!! RELATIVE ROUTING FILE NOT FOUND: ${candidateFileName} for module ${modulePath}`);
        // Další fallback: zkusíme hledat *.routes.ts
        const fallbackFileName = `${baseName}.routes.ts`;
        foundFiles = this.project.getSourceFiles().filter(file => file.getFilePath().endsWith(fallbackFileName));
        if (foundFiles.length > 0) {
          foundFiles.forEach(file => {
            console.debug(`RELATIVE: Nalezen fallback routing soubor: ${file.getFilePath()}`);
            const routeObjects = this.parser.parseRoutingFile(file.getFilePath());
            routeObjects.forEach(routeObj => {
              const route
