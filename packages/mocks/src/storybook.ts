import JSZip from "jszip";
import type { ServedRoute, StorybookExportInput } from "./types";

type Screen = StorybookExportInput["screens"][number];

/**
 * A zip to drop into a frontend repo: msw handlers per screen (mocks/<slug>.handlers.ts), the bodies as JSON fixtures
 * (mocks/fixtures/<slug>/*.json), a stories file per screen using msw-storybook-addon parameters, and a README.
 */
export async function exportStorybook(input: StorybookExportInput): Promise<Buffer> {
  const zip = new JSZip();
  const used = new Set<string>();
  const rows: Row[] = [];
  for (const screen of input.screens) {
    const slug = uniqueSlug(fileSafe(screen.slug || screen.name || screen.id), used);
    screen.routes.forEach((route, i) => {
      zip.file(`mocks/fixtures/${slug}/${i + 1}.json`, `${JSON.stringify(route.body === undefined ? null : route.body, null, 2)}\n`);
    });
    const story = storyIdOf(screen, slug);
    zip.file(`mocks/${slug}.handlers.ts`, handlersFile(input, screen, slug));
    zip.file(`stories/${slug}.stories.tsx`, storiesFile(input, screen, slug, story));
    rows.push({ screen, slug, story });
  }
  zip.file("README.md", readme(input, rows));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

interface Row {
  screen: Screen;
  slug: string;
  story: { id: string; componentId: string; exportName: string; kept: boolean };
}

// ---------------------------------------------------------------- handlers

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const MUTATION = /^(create|update|delete|remove|add|set|save|submit|send|cancel|login|logout|sign|register|reset|change|apply|confirm|place|checkout|pay|book|reserve|upload|toggle|mark|start|stop|verify|insert|upsert|edit|modify|clear|accept|reject|approve|assign|subscribe|unsubscribe|follow|unfollow|like|unlike|invite|join|leave|move|archive|restore|publish|unpublish|enable|disable|attach|detach|merge|refresh|generate|mutate)(?=[A-Z_0-9]|$)/i;

/** the fixture of a route as a response: JSON, text, or no body */
function responseOf(route: ServedRoute, id: string): string {
  const status = Number.isInteger(route.status) ? route.status : 200;
  if (status === 204 || status === 304) return `new HttpResponse(null, { status: ${status} })`;
  const statusInit = status !== 200 ? `, { status: ${status} }` : "";
  if (typeof route.body === "string") {
    const type = route.contentType || "text/plain";
    return `new HttpResponse(String(${id}), { status: ${status}, headers: { "Content-Type": ${JSON.stringify(type)} } })`;
  }
  return `HttpResponse.json(${id}${statusInit})`;
}

function handlersFile(input: StorybookExportInput, screen: Screen, slug: string): string {
  const routes = screen.routes.map((route, i) => ({ route, id: `f${i + 1}` }));
  const rest = new Map<string, typeof routes>();
  const gql = new Map<string, typeof routes>();
  for (const r of routes) {
    const group = r.route.operationName ? gql : rest;
    const key = r.route.operationName ?? `${r.route.method.toUpperCase()} ${r.route.path}`;
    group.set(key, [...(group.get(key) ?? []), r]);
  }

  let needsSame = false;
  const handlers: string[] = [];
  for (const [key, group] of rest) {
    const first = group[0]!.route;
    const method = first.method.toLowerCase();
    const fn = HTTP_METHODS.has(method) ? method : "all";
    const path = JSON.stringify(`*${first.path.startsWith("/") ? "" : "/"}${first.path}`);
    if (group.length === 1) {
      handlers.push(`  // ${comment(key)}${Object.keys(first.query ?? {}).length ? `?${new URLSearchParams(first.query).toString()}` : ""}\n  http.${fn}(${path}, () => ${responseOf(first, group[0]!.id)}),`);
      continue;
    }
    needsSame = true;
    const branches = group.map((g) => `    if (same(query, ${JSON.stringify(g.route.query ?? {})})) return ${responseOf(g.route, g.id)};`);
    handlers.push(
      [
        `  // ${comment(key)}: ${group.length} answers by query`,
        `  http.${fn}(${path}, ({ request }) => {`,
        `    const query = Object.fromEntries(new URL(request.url).searchParams);`,
        ...branches,
        `    return ${responseOf(first, group[0]!.id)};`,
        `  }),`,
      ].join("\n"),
    );
  }
  for (const [name, group] of gql) {
    const first = group[0]!.route;
    if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(name)) {
      handlers.push(`  // ${comment(name)}: a batched GraphQL call, which msw handlers do not match one by one (fixtures ${group.map((g) => g.id).join(", ")})`);
      continue;
    }
    const kind = MUTATION.test(name) ? "mutation" : "query";
    const note = `  // GraphQL ${kind} ${name} (a ${kind} by its name: change to graphql.${kind === "query" ? "mutation" : "query"} if it is not)`;
    if (group.length === 1) {
      handlers.push(`${note}\n  graphql.${kind}(${JSON.stringify(name)}, () => ${responseOf(first, group[0]!.id)}),`);
      continue;
    }
    needsSame = true;
    const branches = group.map((g) => `    if (same(variables, ${JSON.stringify(g.route.variables ?? {})})) return ${responseOf(g.route, g.id)};`);
    handlers.push([`${note}: ${group.length} answers by variables`, `  graphql.${kind}(${JSON.stringify(name)}, ({ variables }) => {`, ...branches, `    return ${responseOf(first, group[0]!.id)};`, `  }),`].join("\n"));
  }

  const hosts = [...new Set(screen.routes.map((r) => r.host).filter(Boolean))];
  const imports = ["HttpResponse"];
  if (gql.size) imports.unshift("graphql");
  if (rest.size) imports.push("http");
  return [
    "/**",
    ` * msw handlers of the screen ${comment(JSON.stringify(screen.name))} (project ${comment(JSON.stringify(input.project.name))}), generated by figtest from its mock data:`,
    ` * the API answers the page gets in the tests. Bodies: ./fixtures/${slug}/<n>.json.`,
    hosts.length ? ` * Recorded on ${comment(hosts.join(", "))}; the REST handlers match the path on any origin.` : " * No API call.",
    " */",
    `import { ${[...new Set(imports)].sort((a, b) => (a === "HttpResponse" ? 1 : b === "HttpResponse" ? -1 : a.localeCompare(b))).join(", ")} } from "msw";`,
    ...routes.map((r) => `import ${r.id} from "./fixtures/${slug}/${r.id.slice(1)}.json";`),
    "",
    ...(needsSame
      ? [
          "/** equal JSON values, the keys of objects in any order */",
          "const canon = (v: unknown): string =>",
          "  JSON.stringify(v ?? {}, (_k, x: unknown) =>",
          "    x && typeof x === \"object\" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x);",
          "const same = (a: unknown, b: unknown): boolean => canon(a) === canon(b);",
          "",
        ]
      : []),
    "export const handlers = [",
    ...handlers,
    "];",
    "",
    "export default handlers;",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- stories

/** Storybook's id of a story part: lower case, words joined by "-" */
const storybookSanitize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[ ’–—―′¿'`~!@#$%^&*()_|+\-=?;:'",.<>{}[\]\\/]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

/** the screen's storyId when it is one ("screens-cart--default"), else screens-<slug>--default */
function storyIdOf(screen: Screen, slug: string) {
  const wanted = screen.storyId?.trim() ?? "";
  const m = /^([a-z0-9][a-z0-9-]*)--([a-z][a-z0-9-]*)$/.exec(wanted);
  if (m?.[1] && m[2]) {
    const exportName = m[2]
      .split("-")
      .filter(Boolean)
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join("");
    return { id: wanted, componentId: m[1], exportName, kept: true };
  }
  const componentId = `screens-${storybookSanitize(slug) || "screen"}`;
  return { id: `${componentId}--default`, componentId, exportName: "Default", kept: false };
}

function storiesFile(input: StorybookExportInput, screen: Screen, slug: string, story: Row["story"]): string {
  const w = Math.round(screen.viewport.w);
  const h = Math.round(screen.viewport.h);
  const placeholder = `TODO: render the page component of ${screen.name} (stories/${slug}.stories.tsx)`;
  return [
    "/**",
    ` * Story of the screen ${comment(JSON.stringify(screen.name))} (project ${comment(JSON.stringify(input.project.name))}), generated by figtest: the page gets`,
    ` * the API data of the screen from ../mocks/${slug}.handlers.ts (msw-storybook-addon), at the size of its Figma frame (${w}x${h}).`,
    ` * Story id: ${story.id}${story.kept ? " (the story id of the screen in figtest)" : ""}.`,
    " */",
    'import type { Meta, StoryObj } from "@storybook/react";',
    `import { handlers } from "../mocks/${slug}.handlers";`,
    "",
    "// TODO: import the page component of this screen (with its providers: router, store, theme) and remove the placeholder:",
    `//   import { ${pascal(slug)}Page as Page } from "../src/pages/${pascal(slug)}Page";`,
    `const Page = () => <p style={{ padding: 24, fontFamily: "sans-serif" }}>{${JSON.stringify(placeholder)}}</p>;`,
    "",
    "const meta = {",
    `  title: ${JSON.stringify(`Screens/${screen.name}`)},`,
    `  id: ${JSON.stringify(story.componentId)},`,
    "  component: Page,",
    "  parameters: {",
    '    layout: "fullscreen",',
    "    msw: { handlers },",
    "    viewport: {",
    `      viewports: { figma: { name: ${JSON.stringify(`Figma frame ${w}x${h}`)}, styles: { width: "${w}px", height: "${h}px" }, type: "${w < 768 ? "mobile" : "desktop"}" } },`,
    '      defaultViewport: "figma",',
    "    },",
    "  },",
    "} satisfies Meta<typeof Page>;",
    "",
    "export default meta;",
    "type Story = StoryObj<typeof meta>;",
    "",
    `export const ${story.exportName}: Story = {${story.exportName === "Default" ? "" : ` name: ${JSON.stringify(screen.name)} `}};`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- README

function readme(input: StorybookExportInput, rows: Row[]): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const table = rows.length
    ? [
        "| Screen | Story id | Handlers | Viewport | API calls |",
        "| --- | --- | --- | --- | --- |",
        ...rows.map(
          (r) =>
            `| ${cell(r.screen.name)} | \`${r.story.id}\`${r.story.kept ? "" : " (new)"} | \`mocks/${r.slug}.handlers.ts\` | ${Math.round(r.screen.viewport.w)}x${Math.round(r.screen.viewport.h)} | ${r.screen.routes.length} |`,
        ),
      ].join("\n")
    : "(no screen)";
  return `# Storybook stories with the API data of ${input.project.name}

Generated by figtest: for each screen, the API answers its page gets in the tests (recorded from the website, then
edited) as [msw](https://mswjs.io) v2 handlers, and a story that renders the page with them at the size of its Figma
frame.

## Files

- \`mocks/<screen>.handlers.ts\`: the msw handlers of a screen (REST by method and path, GraphQL by operation name;
  several answers of one call are told apart by their query or variables)
- \`mocks/fixtures/<screen>/<n>.json\`: the response bodies
- \`stories/<screen>.stories.tsx\`: a CSF3 story per screen with \`parameters.msw.handlers\` and its viewport

## Set up (once)

1. Install msw and the Storybook addon:

   \`\`\`sh
   npm install --save-dev msw msw-storybook-addon
   \`\`\`

2. Create the mock service worker in the public folder Storybook serves:

   \`\`\`sh
   npx msw init public/ --save
   \`\`\`

   and in \`.storybook/main.ts\`: \`staticDirs: ["../public"]\`.

3. Initialize msw in \`.storybook/preview.ts\`:

   \`\`\`ts
   import { initialize, mswLoader } from "msw-storybook-addon";

   initialize({ onUnhandledRequest: "bypass" });

   const preview = {
     loaders: [mswLoader],
   };
   export default preview;
   \`\`\`

4. Copy \`mocks/\` and \`stories/\` into the repo (next to each other, for example under \`src/\`), and check that the
   \`stories\` globs of \`.storybook/main.ts\` include \`stories/*.stories.tsx\`. The fixtures are imported as JSON
   (\`"resolveJsonModule": true\` in tsconfig.json).

5. In each \`stories/*.stories.tsx\`, replace the TODO placeholder with the page component of the screen, wrapped in
   the providers it needs (router, store, theme, i18n).

6. Run Storybook:

   \`\`\`sh
   npm run storybook
   \`\`\`

## Screens

${table}

Screens whose test target is Storybook are opened by these story ids: keep the \`id\` of the meta and the name of the
exported story, or change the story id of the screen in figtest to match. A story id marked (new) is not set on the
screen yet.
`;
}

// ---------------------------------------------------------------- names

/** a file name: letters, digits, "-", "_" and "." (never ".." or a path) */
function fileSafe(s: string): string {
  const out = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return out || "screen";
}

function uniqueSlug(slug: string, used: Set<string>): string {
  let out = slug;
  for (let n = 2; used.has(out.toLowerCase()); n++) out = `${slug}-${n}`;
  used.add(out.toLowerCase());
  return out;
}

const pascal = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("") || "Screen";

/** text safe inside a block or line comment */
const comment = (s: string) => s.replace(/\*\//g, "* /").replace(/\r?\n/g, " ");
