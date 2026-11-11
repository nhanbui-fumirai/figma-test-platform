import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { exportStorybook, type ServedRoute } from "./index";

const r = (x: Partial<ServedRoute> & { id: string }): ServedRoute => ({
  method: "GET",
  host: "api.shop.test",
  path: "/api/products",
  query: {},
  operationName: null,
  variables: null,
  status: 200,
  contentType: "application/json",
  body: { id: x.id },
  ...x,
});

describe("exportStorybook", () => {
  it("writes handlers, fixtures, stories and a README", async () => {
    const zipped = await exportStorybook({
      project: { name: "Furniro Shop", slug: "furniro" },
      screens: [
        {
          id: "s1",
          name: "Cart",
          slug: "cart",
          storyId: "pages-cart--logged-in",
          viewport: { w: 1440, h: 900 },
          routes: [
            r({ id: "a", query: { limit: "8" }, body: { items: [{ name: "Sofa" }] } }),
            r({ id: "b", query: { limit: "4" }, body: { items: [] } }),
            r({ id: "c", method: "POST", path: "/graphql", operationName: "GetCart", variables: { id: "c1" }, body: { data: { cart: { total: 1 } } } }),
            r({ id: "d", method: "POST", path: "/graphql", operationName: "GetCart", variables: { id: "c2" }, body: { data: { cart: { total: 2 } } } }),
            r({ id: "e", method: "POST", path: "/graphql", operationName: "AddToCart", variables: {}, body: { data: { ok: true } }, status: 201 }),
            r({ id: "f", path: "/api/notice", contentType: "text/plain", body: "Closed on Monday" }),
          ],
        },
        { id: "s2", name: "Home */ page", slug: "home", storyId: null, viewport: { w: 375, h: 812 }, routes: [r({ id: "g" })] },
      ],
    });
    const zip = await JSZip.loadAsync(zipped);
    const files = Object.keys(zip.files).filter((f) => !zip.files[f]!.dir).sort();
    expect(files).toEqual([
      "README.md",
      "mocks/cart.handlers.ts",
      "mocks/fixtures/cart/1.json",
      "mocks/fixtures/cart/2.json",
      "mocks/fixtures/cart/3.json",
      "mocks/fixtures/cart/4.json",
      "mocks/fixtures/cart/5.json",
      "mocks/fixtures/cart/6.json",
      "mocks/fixtures/home/1.json",
      "mocks/home.handlers.ts",
      "stories/cart.stories.tsx",
      "stories/home.stories.tsx",
    ]);
    const text = (name: string) => zip.file(name)!.async("string");

    expect(JSON.parse(await text("mocks/fixtures/cart/1.json"))).toEqual({ items: [{ name: "Sofa" }] });
    expect(JSON.parse(await text("mocks/fixtures/cart/6.json"))).toBe("Closed on Monday");

    const handlers = await text("mocks/cart.handlers.ts");
    expect(handlers).toContain('import { graphql, http, HttpResponse } from "msw";');
    expect(handlers).toContain('import f1 from "./fixtures/cart/1.json";');
    expect(handlers).toContain('http.get("*/api/products", ({ request }) => {');
    expect(handlers).toContain('if (same(query, {"limit":"8"})) return HttpResponse.json(f1);');
    expect(handlers).toContain('if (same(query, {"limit":"4"})) return HttpResponse.json(f2);');
    expect(handlers).toContain('graphql.query("GetCart", ({ variables }) => {');
    expect(handlers).toContain('if (same(variables, {"id":"c2"})) return HttpResponse.json(f4);');
    expect(handlers).toContain('graphql.mutation("AddToCart", () => HttpResponse.json(f5, { status: 201 })),');
    expect(handlers).toContain('http.get("*/api/notice", () => new HttpResponse(String(f6), { status: 200, headers: { "Content-Type": "text/plain" } })),');
    expect(handlers).toContain("export const handlers = [");

    const home = await text("mocks/home.handlers.ts");
    expect(home).toContain('import { http, HttpResponse } from "msw";');
    expect(home).toContain('http.get("*/api/products", () => HttpResponse.json(f1)),');
    expect(home).not.toContain("same(");
    expect(home).not.toMatch(/Home \*\/ page/); // a name cannot end the comment

    const story = await text("stories/cart.stories.tsx");
    expect(story).toContain('import { handlers } from "../mocks/cart.handlers";');
    expect(story).toContain("msw: { handlers },");
    expect(story).toContain('id: "pages-cart",');
    expect(story).toContain("export const LoggedIn: Story");
    expect(story).toContain('styles: { width: "1440px", height: "900px" }');
    expect(story).toMatch(/TODO: import the page component/);

    const homeStory = await text("stories/home.stories.tsx");
    expect(homeStory).toContain('id: "screens-home",');
    expect(homeStory).toContain("export const Default: Story = {};");
    expect(homeStory).toContain('type: "mobile"');

    const readme = await text("README.md");
    expect(readme).toMatch(/msw-storybook-addon/);
    expect(readme).toMatch(/npx msw init public\//);
    expect(readme).toContain("`pages-cart--logged-in`");
    expect(readme).toContain("`screens-home--default` (new)");
  });

  it("makes an empty export for no screens", async () => {
    const zip = await JSZip.loadAsync(await exportStorybook({ project: { name: "P", slug: "p" }, screens: [] }));
    expect(Object.keys(zip.files)).toEqual(["README.md"]);
  });
});
