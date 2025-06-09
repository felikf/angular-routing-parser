// src/index.ts
import * as fs from 'fs';
import * as path from 'path';
import { Project, SyntaxKind, ObjectLiteralExpression, Node, SourceFile, VariableDeclaration } from 'ts-morph';

// --------------------
// Model uzlu routy
// --------------------
interface RouteNode {
  path: string;
  type: 'eager' | 'lazy-module' | 'lazy-component';
  name: string;
  title?: string;
  children?: RouteNode[];
}

// --------------------
// Parser – načítá routing soubory a dekorátory
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
    const objs: Node[] = [];
    sf.forEachChild(node => {
      if (node.getKind() === SyntaxKind.VariableStatement) {
        node.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach(decl => {
          const init = decl.getInitializer();
          if (init?.getKind() === SyntaxKind.ArrayLiteralExpression) {
            init.forEachChild(child => {
              if (child.getKind() === SyntaxKind.ObjectLiteralExpression) {
                objs.push(child);
              }
            });
          }
        });
      }
    });
    return objs;
  }

  parseRouteObject(obj: Node): any {
    const route: any = {};
    (obj as ObjectLiteralExpression).getProperties().forEach(prop => {
      if (prop.getKind() !== SyntaxKind.PropertyAssignment) return;
      const name = (prop as any).getName();
      const init = (prop as any).getInitializer();
      if (name === 'path') {
        route.path = init?.getText().replace(/['"`]/g, '') || '';
      } else if (name === 'component') {
        route.component = init?.getText();
        route.type = 'eager';
      } else if (name === 'loadChildren') {
        route.loadChildren = init?.getText();
        route.type = 'lazy-module';
      } else if (name === 'loadComponent') {
        route.loadComponent = init?.getText();
        route.type = 'lazy-component';
      } else if (name === 'children' && init?.getKind() === SyntaxKind.ArrayLiteralExpression) {
        route.children = [];
        init.forEachChild(child => {
          if (child.getKind() === SyntaxKind.ObjectLiteralExpression) {
            route.children.push(this.parseRouteObject(child));
          }
        });
      }
    });
    return route;
  }

  getComponentTitle(componentName: string): string | undefined {
    let found = false;
    for (const sf of this.project.getSourceFiles()) {
      const cls = sf.getClass(componentName);
      if (!cls) continue;
      found = true;
      console.log(`[getComponentTitle] Class ${componentName} in ${sf.getFilePath()}`);
      const decs = cls.getDecorators().map(d => d.getName());
      console.log(`[getComponentTitle] Decorators: ${decs.join(', ')}`);
      for (const dec of cls.getDecorators()) {
        if (dec.getName() !== 'FunselPage') continue;
        const arg = dec.getArguments()[0];
        if (arg?.getKind() === SyntaxKind.ObjectLiteralExpression) {
          const obj = arg as ObjectLiteralExpression;
          const tp = obj.getProperty('title');
          if (tp?.getKind() === SyntaxKind.PropertyAssignment) {
            const init = (tp as any).getInitializer();
            const kindName = SyntaxKind[init.getKind()];
            console.log(`[getComponentTitle] title initializer kind: ${kindName}`);
            if (init.getKind() === SyntaxKind.StringLiteral) {
              return init.getText().replace(/['"`]/g, '');
            }
            if (
              init.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral ||
              init.getKind() === SyntaxKind.TemplateExpression
            ) {
              return init.getText().replace(/[`]/g, '');
            }
            if (init.getKind() === SyntaxKind.Identifier) {
              const constName = init.getText();
              const val = this.resolveConstant(constName);
              console.log(`🔗 Resolved constant ${constName} => '${val}'`);
              return val;
            }
            console.warn(`[getComponentTitle] Unsupported title init kind: ${kindName}`);
          } else {
            console.log('[getComponentTitle] No title prop in @FunselPage');
          }
        }
      }
      console.log('[getComponentTitle] @FunselPage not found or no title');
    }
    if (!found) {
      console.warn(`[getComponentTitle] Class ${componentName} not found at all`);
    }
    return undefined;
  }

  extractLazyComponentInfo(loadComponentText: string): { alias: string; componentName: string } | undefined {
    const imp = /import\(\s*['"`]([\s\S]*?)['"`]\s*\)/.exec(loadComponentText);
    const thenM = /\.then\(\s*\w+\s*=>\s*\w+\.(\w+)\)/.exec(loadComponentText);
    if (imp && imp[1] && thenM && thenM[1]) {
      return { alias: imp[1], componentName: thenM[1] };
    }
    console.warn(`⚠️ extractLazyComponentInfo failed: ${loadComponentText}`);
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
// Director – rekurzivní zpracování s fallbacky v baseDir
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
    const entry = 'apps/funsel/src/app/app-routing.module.ts';
    console.log(`🛠️  Starting root routing: ${entry}`);
    const objs = this.parser.parseRoutingFile(entry);
    return objs.map(o => this.handleRoute(this.parser.parseRouteObject(o), '', 0, entry));
  }

  private handleRoute(route: any, parentPath: string, depth: number, currentFile: string): RouteNode {
    const indent = '  '.repeat(depth);
    const fullPath = `${parentPath}/${route.path || ''}`;

    // EAGER
    if (route.type === 'eager' && route.component) {
      const title = this.parser.getComponentTitle(route.component) ?? 'NOT FOUND';
      console.log(`${indent}✅ EAGER ${fullPath}, comp='${route.component}', title='${title}'`);
      const children = (route.children || []).map((c: any) => this.handleRoute(c, fullPath, depth + 1, currentFile));
      return { path: route.path, type: 'eager', name: route.component, title, children };
    }

    // LAZY MODULE
    if (route.type === 'lazy-module' && route.loadChildren) {
      const alias = this.extractModuleFilePath(route.loadChildren) || 'UNKNOWN';
      console.log(`${indent}📦 LAZY-MODULE ${fullPath}, import='${alias}'`);
      let children: RouteNode[] = [];
      if (alias.startsWith('@')) {
        children = this.processAliasModule(alias, fullPath, depth + 1);
      } else if (alias.startsWith('./') || alias.startsWith('../')) {
        children = this.processRelativeModule(alias, fullPath, depth + 1, currentFile);
      } else {
        console.warn(`${indent}⚠️ Unrecognized import format: ${alias}`);
      }
      return { path: route.path, type: 'lazy-module', name: alias, children };
    }

    // LAZY COMPONENT
    if (route.type === 'lazy-component' && route.loadComponent) {
      const info = this.parser.extractLazyComponentInfo(route.loadComponent)!;
      const title = this.parser.getComponentTitle(info.componentName) ?? 'NOT FOUND';
      console.log(`${indent}🚀 LAZY-COMP ${fullPath}, comp='${info.componentName}', title='${title}'`);
      const children = (route.children || []).map((c: any) => this.handleRoute(c, fullPath, depth + 1, currentFile));
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
    const children = (route.children || []).map((c: any) => this.handleRoute(c, fullPath, depth + 1, currentFile));
    return { path: route.path, type: 'eager', name: 'Unknown', children };
  }

  private extractModuleFilePath(loadChildrenText: string): string | undefined {
    // allow import(...) across newlines
    const m = /import\(\s*['"`]([\s\S]*?)['"`]\s*\)/.exec(loadChildrenText);
    return m?.[1];
  }

  private processAliasModule(alias: string, parentPath: string, depth: number): RouteNode[] {
    const indent = '  '.repeat(depth);
    console.log(`${indent}🔄 Alias lookup: ${alias}`);
    const mapped = this.tsconfigPaths[alias]?.[0];
    if (!mapped) {
      console.warn(`${indent}⚠️ Alias not in tsconfig.paths: ${alias}`);
      return [];
    }
    const baseDir = path.dirname(mapped);
    return this.findAndParseRoutingFiles(baseDir, parentPath, depth);
  }

  private processRelativeModule(relPath: string, parentPath: string, depth: number, currentFile: string): RouteNode[] {
    const indent = '  '.repeat(depth);
    const dir = path.dirname(currentFile);
    const moduleFile = path.resolve(dir, relPath) + '.ts';
    console.log(`${indent}🔄 Rel. lookup: trying module file ${moduleFile}`);
    const sf = this.project.getSourceFile(moduleFile);
    if (!sf) {
      console.error(`${indent}❌ Rel. module file not found: ${moduleFile}`);
      return [];
    }
    const baseDir = path.dirname(sf.getFilePath());
    return this.findAndParseRoutingFiles(baseDir, parentPath, depth);
  }

  private findAndParseRoutingFiles(baseDir: string, parentPath: string, depth: number): RouteNode[] {
    const indent = '  '.repeat(depth);
    const patterns = [
      `${baseDir}/*-routing.module.ts`,
      `${baseDir}/*.routes.ts`,
      `${baseDir}/lib/*-routing.module.ts`,
      `${baseDir}/lib/*.routes.ts`
    ];

    let files: SourceFile[] = [];
    for (const pat of patterns) {
      console.log(`${indent}🔍 Globbing for ${pat}`);
      files = this.project.getSourceFiles(pat);
      if (files.length) break;
    }

    // fallback barrel index.ts
    if (!files.length) {
      const idx = path.join(baseDir, 'index.ts');
      console.log(`${indent}🔍 Checking barrel file: ${idx}`);
      const sfIdx = this.project.getSourceFile(idx);
      if (sfIdx) {
        console.log(`${indent}➡️ Found barrel index.ts, parsing as routing source`);
        files = [sfIdx];
      }
    }

    if (!files.length) {
      console.error(`${indent}❌ No routing files found in ${baseDir}`);
      return [];
    }

    const result: RouteNode[] = [];
    for (const rf of files) {
      console.log(`${indent}➡️ Parsing routing file: ${rf.getFilePath()}`);
      const objs = this.parser.parseRoutingFile(rf.getFilePath());
      for (const o of objs) {
        result.push(this.handleRoute(this.parser.parseRouteObject(o), parentPath, depth + 1, rf.getFilePath()));
      }
    }
    return result;
  }
}

// --------------------
// Generátor finálního textového výpisu
// --------------------
function generateTreeText(nodes: RouteNode[], prefix = ''): string {
  let out = '';
  nodes.forEach((n, i) => {
    const last = i === nodes.length - 1;
    const ptr = last ? '└─ ' : '├─ ';
    const titlePart = n.type === 'eager' || n.type === 'lazy-component' ? ` (title=${n.title ?? 'NOT FOUND'})` : '';
    out += `${prefix}${ptr}/${n.path} ${n.name} [${n.type}]${titlePart}\n`;
    if (n.children?.length) {
      out += generateTreeText(n.children, prefix + (last ? '   ' : '│  '));
    }
  });
  return out;
}

// --------------------
// Hlavní spuštění
// --------------------
const project = new Project({ tsConfigFilePath: 'tsconfig.json' });
project.addSourceFilesAtPaths('apps/funsel/**/*');
project.addSourceFilesAtPaths('libs/**/*');

const parser = new RouteParser(project);
const director = new RouteDirector(project, parser);
const tree = director.processRoutingModules();

console.log('\n📋 Generated route tree:\n');
console.log(generateTreeText(tree));
