// src/index.ts
import * as fs from 'fs';
import { Project, SyntaxKind, ObjectLiteralExpression, Node, SourceFile, VariableDeclaration } from 'ts-morph';

// --------------------
// Datový model
// --------------------
interface RouteNode {
  path: string;
  type: 'eager' | 'lazy-module' | 'lazy-component';
  name: string;
  title?: string;
  children?: RouteNode[];
}

// --------------------
// Parser
// --------------------
class RouteParser {
  constructor(public project: Project) {}

  parseRoutingFile(filePath: string): Node[] {
    console.log(`🔍 Parsing routing file: ${filePath}`);
    const sf = this.project.getSourceFile(filePath);
    if (!sf) {
      console.error(`❌ Soubor nenalezen: ${filePath}`);
      return [];
    }
    const routeObjs: Node[] = [];
    sf.forEachChild(node => {
      if (node.getKind() === SyntaxKind.VariableStatement) {
        node.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach(decl => {
          const init = decl.getInitializer();
          if (init?.getKind() === SyntaxKind.ArrayLiteralExpression) {
            init.forEachChild(child => {
              if (child.getKind() === SyntaxKind.ObjectLiteralExpression) {
                routeObjs.push(child);
              }
            });
          }
        });
      }
    });
    return routeObjs;
  }

  parseRouteObject(obj: Node): any {
    const route: any = {};
    (obj as ObjectLiteralExpression).getProperties().forEach(prop => {
      if (prop.getKind() === SyntaxKind.PropertyAssignment) {
        const name = (prop as any).getName();
        const init = (prop as any).getInitializer();
        switch (name) {
          case 'path':
            route.path = init?.getText().replace(/['"`]/g, '') || '';
            break;
          case 'component':
            route.component = init?.getText();
            route.type = 'eager';
            break;
          case 'loadChildren':
            route.loadChildren = init?.getText();
            route.type = 'lazy-module';
            break;
          case 'loadComponent':
            route.loadComponent = init?.getText();
            route.type = 'lazy-component';
            break;
          case 'children':
            if (init?.getKind() === SyntaxKind.ArrayLiteralExpression) {
              route.children = [];
              init.forEachChild(child => {
                if (child.getKind() === SyntaxKind.ObjectLiteralExpression) {
                  route.children.push(this.parseRouteObject(child));
                }
              });
            }
            break;
        }
      }
    });
    return route;
  }

  getComponentTitle(componentName: string): string | undefined {
    let foundClass = false;
    for (const sf of this.project.getSourceFiles()) {
      const cls = sf.getClass(componentName);
      if (!cls) continue;
      foundClass = true;
      console.log(`[getComponentTitle] Found class ${componentName} in file ${sf.getFilePath()}`);
      const decs = cls.getDecorators().map(d => d.getName());
      console.log(`[getComponentTitle] Decorators on ${componentName}: ${decs.join(', ')}`);

      for (const dec of cls.getDecorators()) {
        if (dec.getName() === 'FunselPage') {
          const arg = dec.getArguments()[0];
          if (arg?.getKind() === SyntaxKind.ObjectLiteralExpression) {
            const obj = arg as ObjectLiteralExpression;
            const tp = obj.getProperty('title');
            if (tp?.getKind() === SyntaxKind.PropertyAssignment) {
              const init = (tp as any).getInitializer();
              const kindName = SyntaxKind[init.getKind()];
              console.log(`[getComponentTitle] Found @FunselPage.title initializer of kind ${kindName}`);
              // 1) string literal
              if (init.getKind() === SyntaxKind.StringLiteral) {
                return init.getText().replace(/['"`]/g, '');
              }
              // 2) template literal without expressions
              if (init.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
                return init.getText().replace(/[`]/g, '');
              }
              // 3) general template expression
              if (init.getKind() === SyntaxKind.TemplateExpression) {
                // v jednoduchých případech bez výrazů vezmeme raw text
                return init.getText().replace(/[`]/g, '');
              }
              // 4) identifier → konstantu resolve
              if (init.getKind() === SyntaxKind.Identifier) {
                const constName = init.getText();
                const resolved = this.resolveConstant(constName);
                console.log(`🔗 Resolved constant ${constName} => '${resolved}'`);
                return resolved;
              }
              console.warn(`[getComponentTitle] Unsupported initializer kind for title: ${kindName}`);
            } else {
              console.log(`[getComponentTitle] No title property assignment found in @FunselPage of ${componentName}`);
            }
          }
        }
      }
      console.log(`[getComponentTitle] @FunselPage decorator not found or no title for class ${componentName}`);
    }
    if (!foundClass) {
      console.warn(`[getComponentTitle] Class ${componentName} not found in any source file`);
    }
    return undefined;
  }

  extractLazyComponentInfo(loadComponentText: string): { alias: string; componentName: string } | undefined {
    const imp = /import\((['"`])(.*?)\1\)/.exec(loadComponentText);
    const thenM = /\.then\(\s*\w+\s*=>\s*\w+\.(\w+)\s*\)/.exec(loadComponentText);
    if (imp && imp[2] && thenM && thenM[1]) {
      return { alias: imp[2], componentName: thenM[1] };
    }
    console.warn(`⚠️ extractLazyComponentInfo failed for: ${loadComponentText}`);
    return undefined;
  }

  private resolveConstant(name: string): string {
    for (const sf of this.project.getSourceFiles()) {
      const decl = sf.getVariableDeclaration(name);
      if (decl) {
        const init = (decl as VariableDeclaration).getInitializer();
        if (init?.getKind() === SyntaxKind.StringLiteral) {
          return init.getText().replace(/['"`]/g, '');
        }
      }
    }
    return name;
  }
}

// --------------------
// Director + debug logy s indentací dle hloubky
// --------------------
class RouteDirector {
  tsconfigPaths: any;
  constructor(
    public project: Project,
    public parser: RouteParser
  ) {
    this.tsconfigPaths = this.loadTsconfigPaths();
  }

  private loadTsconfigPaths(): any {
    try {
      const cfg = JSON.parse(fs.readFileSync('tsconfig.base.json', 'utf8'));
      return cfg.compilerOptions?.paths || {};
    } catch {
      return {};
    }
  }

  processRoutingModules(): RouteNode[] {
    const root = 'apps/funsel/src/app/app-routing.module.ts';
    console.log(`🛠️  Starting root: ${root}`);
    const objs = this.parser.parseRoutingFile(root);
    return objs.map(o => this.handleRoute(this.parser.parseRouteObject(o), '', 0));
  }

  private handleRoute(route: any, parentPath: string, depth: number): RouteNode {
    const indent = '  '.repeat(depth);
    const fullPath = `${parentPath}/${route.path || ''}`;
    // EAGER
    if (route.type === 'eager' && route.component) {
      const title = this.parser.getComponentTitle(route.component) ?? 'NOT FOUND';
      console.log(`${indent}✅ EAGER ROUTE ${fullPath}, component='${route.component}', title='${title}'`);
      const children = (route.children || []).map((c: any) => this.handleRoute(c, fullPath, depth + 1));
      return { path: route.path, type: 'eager', name: route.component, title, children };
    }
    // LAZY MODULE
    if (route.type === 'lazy-module' && route.loadChildren) {
      const alias = this.extractModuleFilePath(route.loadChildren) || 'UNKNOWN';
      console.log(`${indent}📦 LAZY MODULE ${fullPath}, import='${alias}'`);
      const children = alias ? this.processLazyModule(alias, fullPath, depth + 1) : [];
      return { path: route.path, type: 'lazy-module', name: alias, children };
    }
    // LAZY COMPONENT
    if (route.type === 'lazy-component' && route.loadComponent) {
      const info = this.parser.extractLazyComponentInfo(route.loadComponent)!;
      const title = this.parser.getComponentTitle(info.componentName) ?? 'NOT FOUND';
      console.log(`${indent}🚀 LAZY COMPONENT ${fullPath}, component='${info.componentName}', title='${title}'`);
      const children = (route.children || []).map((c: any) => this.handleRoute(c, fullPath, depth + 1));
      return {
        path: route.path,
        type: 'lazy-component',
        name: info.componentName,
        title,
        children
      };
    }
    // UNKNOWN
    console.log(`${indent}❓ UNKNOWN ROUTE TYPE ${fullPath}`);
    const children = (route.children || []).map((c: any) => this.handleRoute(c, fullPath, depth + 1));
    return { path: route.path, type: 'eager', name: 'Unknown', children };
  }

  private extractModuleFilePath(loadChildrenText: string): string | undefined {
    const m = /import\((['"`])(.*?)\1\)/.exec(loadChildrenText);
    return m?.[2];
  }

  private processLazyModule(modulePath: string, parentPath: string, depth: number): RouteNode[] {
    const indent = '  '.repeat(depth);
    console.log(`${indent}🔄 Processing lazy module path: ${modulePath}`);
    const mapped = this.tsconfigPaths[modulePath]?.[0];
    if (!mapped) {
      console.warn(`${indent}⚠️ Alias not in tsconfig.paths: ${modulePath}`);
      return [];
    }
    const baseDir = mapped.replace(/\/[^/]+$/, '');
    const patterns = [`${baseDir}/lib/*-routing.module.ts`, `${baseDir}/lib/*.routes.ts`];
    let files: SourceFile[] = [];
    for (const p of patterns) {
      files = this.project.getSourceFiles(p);
      if (files.length) break;
    }
    if (!files.length) {
      console.error(`${indent}❌ No routing file for module ${modulePath}`);
      return [];
    }
    const result: RouteNode[] = [];
    for (const sf of files) {
      console.log(`${indent}➡️ Found routing file: ${sf.getFilePath()}`);
      const objs = this.parser.parseRoutingFile(sf.getFilePath());
      for (const o of objs) {
        result.push(this.handleRoute(this.parser.parseRouteObject(o), parentPath, depth + 1));
      }
    }
    return result;
  }
}

// --------------------
// Finální textový výpis
// --------------------
function generateTreeText(nodes: RouteNode[], prefix = ''): string {
  let out = '';
  nodes.forEach((n, i) => {
    const last = i === nodes.length - 1;
    const ptr = last ? '└─ ' : '├─ ';
    let titlePart = '';
    if (n.type === 'eager' || n.type === 'lazy-component') {
      titlePart = ` (title=${n.title ?? 'NOT FOUND'})`;
    }
    out += `${prefix}${ptr}/${n.path} ${n.name} [${n.type}]${titlePart}\n`;
    if (n.children?.length) {
      out += generateTreeText(n.children, prefix + (last ? '   ' : '│  '));
    }
  });
  return out;
}

// --------------------
// Main
// --------------------
const project = new Project({ tsConfigFilePath: 'tsconfig.json' });
project.addSourceFilesAtPaths('apps/funsel/**/*');
project.addSourceFilesAtPaths('libs/**/*');

const parser = new RouteParser(project);
const director = new RouteDirector(project, parser);
const tree = director.processRoutingModules();

console.log('\n📋 Generated route tree:\n');
console.log(generateTreeText(tree));
