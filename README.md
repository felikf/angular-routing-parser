1. Načtení projektu a definice datové struktury
   Importy a inicializace ts-morph

Načte se modul fs pro čtení souborů a z ts-morph třídy pro manipulaci s TypeScript AST (Project, SyntaxKind, atd.).

Vytvoří se Project, který načte veškeré zdrojové soubory podle tsconfig.json a glob patternů (apps/funsel/**/*, libs/**/*).

Rozhraní RouteNode
Popisuje strukturu uzlu v routovacím stromu:

ts
Copy
Edit
interface RouteNode {
path: string;
type: 'eager' | 'lazy-module' | 'lazy-component';
name: string;
title?: string;
children?: RouteNode[];
}
2. Stavitel (RouteBuilder)
   Třída s metodami, které na základě parametrů vrací instanci RouteNode:

buildEagerRoute(path, componentName, title?, children)

buildLazyModule(path, moduleName, children)

buildLazyComponent(path, componentName, title?, children)

3. Parser (RouteParser)
   Třída zajišťující:

Parse routing array
Metoda parseRoutingFile(filePath) najde v souboru všechny VariableStatement, které inicializují pole rout (ArrayLiteralExpression), a vrátí pole jednotlivých ObjectLiteralExpression.

Parse jednoho routovacího objektu
parseRouteObject(routeObject) projde všechny property assignments a podle názvu:

path → extrahuje string nebo vytvoří z PropertyAccessExpression

component → označí jako 'eager'

loadChildren → označí jako 'lazy-module'

loadComponent → označí jako 'lazy-component'

children → rekurzivně zavolá samo sebe

Extrahuje metadata z komponent

getComponentTitle(componentName) prohledá projektové soubory a najde třídu s daným jménem, podívá se na dekorátor @FunselPage({ title: '...' }) a vrátí hodnotu title.

getComponentTitleFromFile obdobně, ale pro konkrétní SourceFile.

Rozbor lazy‐component importu
extractLazyComponentInfo(loadComponentText) vytáhne z textu importu alias cesty i jméno komponenty z .then(x => x.NěcoComponent).

4. Řídicí vrstva (RouteDirector)
   Načtení aliasů z tsconfig
   loadTsconfigPaths() čte tsconfig.base.json a uloží compilerOptions.paths.

Základní zpracování rout
processRoutingModules()

Najde app-routing.module.ts

Z něj získá pole routovacích objektů

Pro každý objekt vybere, zda je eager, lazy‐module nebo lazy‐component, a pomocí builderu vytvoří uzel, přičemž pro lazy‐moduly/komponenty se volají speciální metody.

Zpracování lazy‐modulu
processLazyModule(modulePath, visited)

Podporuje dvě cesty:

Relativní (./… nebo ../…): hledá *-routing.module.ts nebo jako fallback *.routes.ts

Aliasové (@…): pomocí tsconfig.paths vytvoří kandidátní cesty v lib/, opět s vícestupňovými fallbacky

Z nalezených souborů znovu parsuje routy a rekurzivně zpracovává podsložky

Zpracování lazy‐komponenty
processLazyComponent(loadComponentText)

Pomocí parseru získá { alias, componentName }

Podle aliasu najde reálnou složku, vygeneruje pattern pro .component.ts (kebab-case)

Pro první nalezený soubor se pokusí získat title z dekorátoru, jinak fallback na globální hledání

5. Pomocné funkce
   toKebabCase(str) – převádí PascalCase/camelCase na kebab-case

transformRoutePath(path) – pokud je ve formátu Something.ROUTE, vezme část za tečkou a udělá z ní kebab-case

filterTree(nodes) – odstraní uzly BlockedStepComponent rekurzivně

generateTreeText(nodes, prefix) – vygeneruje ASCII strom (├─, └─) s popisky /path componentName – eager (title), – lazy module, – lazy component

6. Výstup
   Na závěr:

Vytvoří se instance Project, RouteParser, RouteBuilder, RouteDirector.

Zavolá se director.processRoutingModules() → získá se RouteNode[].

Aplikuje se filterTree.

Vygeneruje se textový strom pomocí generateTreeText a vypíše se do konzole.

Výsledek je přehledný „tree“ výpis všech route-uzlů aplikace, včetně informací, zda jde o eager routu (přímá komponenta), lazy-module či lazy-component a případného titulu z dekorátoru.
