import type { DomSnapshot } from "./types";

/**
 * The DOM collector, run INSIDE the page. Plain JavaScript in a string (not a stringified TS function: no emitted
 * helper, no bundler rename can leak into it), so it must stay self-contained.
 *
 * Every visible element: box (page coordinates, scroll 0), background, border, radius, padding, gap.
 * Elements showing text: the text (own text nodes, and the inner text of a block of inline content), its typography
 * and its geometry measured from the text itself (Range rects):
 *   - lines = text rects merged per line (inline badges and icons on the same line do not add lines)
 *   - box = the glyph rects grown by the half-leading, i.e. the line boxes: what a Figma text box is
 *   - line-height "normal" is measured (pitch of the lines, or a probe with the same font), so it can be compared
 * Left out: display none, visibility hidden, opacity 0 (self or ancestor), visually hidden text (sr-only, ≤ 1 px),
 * elements entirely clipped by an overflow ancestor or outside the page, svg internals, [data-figtest-ignore] and the
 * selectors of window.__FIGTEST_EXCLUDE__ (optional array). Waits for document.fonts.ready (3 s max) first.
 */
const SCRIPT = String.raw`(async () => {
  const LIMIT = 1500;
  try {
    if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]);
  } catch (e) { /* no FontFaceSet */ }

  const doc = document.documentElement;
  const body = document.body;
  const sx = window.scrollX, sy = window.scrollY;
  const round = (n) => Math.round(n * 100) / 100;
  const px = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const norm = (s) => String(s || "")
    .replace(/[\u{200B}-\u{200D}\u{2060}\u{FEFF}\u{AD}]/gu, "")
    .replace(/[\u{A0}\u{1680}\u{2000}-\u{200A}\u{202F}\u{205F}\u{3000}]/gu, " ")
    .replace(/\s+/g, " ").trim();
  const cjkRe = /[\u{3000}-\u{30FF}\u{3400}-\u{9FFF}\u{AC00}-\u{D7AF}\u{FF00}-\u{FFEF}]/u;

  const styles = new Map();
  const style = (el) => { let s = styles.get(el); if (!s) { s = getComputedStyle(el); styles.set(el, s); } return s; };

  // ---------------------------------------------------------------- colors -> #RRGGBB(AA), null = transparent
  const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0").toUpperCase();
  const colorMemo = new Map();
  let colorCtx = null;
  const toHex = (c) => {
    if (!c || c === "transparent" || c === "none") return null;
    if (colorMemo.has(c)) return colorMemo.get(c);
    let out = null;
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,\/]\s*([\d.]+%?))?\s*\)$/.exec(c);
    if (m) {
      const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      out = a <= 0 ? null : "#" + hex2(+m[1]) + hex2(+m[2]) + hex2(+m[3]) + (a < 0.999 ? hex2(a * 255) : "");
    } else {
      // color(), oklch(), lab()...: let a canvas convert it to sRGB
      try {
        if (!colorCtx) { const cv = document.createElement("canvas"); cv.width = 1; cv.height = 1; colorCtx = cv.getContext("2d", { willReadFrequently: true }); }
        colorCtx.clearRect(0, 0, 1, 1);
        colorCtx.fillStyle = "#000";
        colorCtx.fillStyle = c;
        colorCtx.fillRect(0, 0, 1, 1);
        const d = colorCtx.getImageData(0, 0, 1, 1).data;
        out = d[3] === 0 ? null : "#" + hex2(d[0]) + hex2(d[1]) + hex2(d[2]) + (d[3] < 255 ? hex2(d[3]) : "");
      } catch (e) { out = null; }
    }
    colorMemo.set(c, out);
    return out;
  };

  // ---------------------------------------------------------------- fonts: @font-face loaded, system, or missing
  const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif",
    "ui-monospace", "ui-rounded", "emoji", "math", "fangsong", "-apple-system", "blinkmacsystemfont", "inherit", "initial"]);
  const faces = new Map();
  try {
    document.fonts.forEach((f) => {
      const fam = String(f.family).replace(/["']/g, "").trim().toLowerCase();
      const w = String(f.weight).trim().split(/\s+/).map((x) => (x === "normal" ? 400 : x === "bold" ? 700 : parseFloat(x)));
      const lo = isNaN(w[0]) ? 400 : w[0];
      const hi = w.length > 1 && !isNaN(w[1]) ? w[1] : lo;
      const list = faces.get(fam) || [];
      list.push({ lo: lo, hi: hi, loaded: f.status === "loaded" });
      faces.set(fam, list);
    });
  } catch (e) { /* no FontFaceSet */ }
  const installedMemo = new Map();
  let fontCtx = null;
  const installed = (family) => {
    const k = family.toLowerCase();
    if (installedMemo.has(k)) return installedMemo.get(k);
    let ok = true;
    try {
      if (!fontCtx) fontCtx = document.createElement("canvas").getContext("2d");
      const sample = "mmmmmmmmmmlli1WQ@#\u{3042}\u{6C38}";
      const q = '"' + family.replace(/"/g, "") + '"';
      ok = ["monospace", "serif", "sans-serif"].some((g) => {
        fontCtx.font = "72px " + g;
        const base = fontCtx.measureText(sample).width;
        fontCtx.font = "72px " + q + ", " + g;
        return fontCtx.measureText(sample).width !== base;
      });
    } catch (e) { ok = true; }
    installedMemo.set(k, ok);
    return ok;
  };
  const fontStatus = (family, weight) => {
    const fam = family.toLowerCase();
    if (!fam || GENERIC.has(fam)) return "system";
    const list = faces.get(fam);
    if (list) {
      const cover = list.filter((f) => weight >= f.lo && weight <= f.hi);
      if (cover.some((f) => f.loaded)) return "loaded";
      // no face for this weight: the browser takes the nearest loaded one (or synthesizes bold)
      if (!cover.length && list.some((f) => f.loaded)) return "loaded";
      return "not-loaded";
    }
    return installed(family) ? "system" : "not-loaded";
  };
  const firstFamily = (ff) => String(ff || "").split(",")[0].replace(/["']/g, "").trim();

  // ---------------------------------------------------------------- names of an element
  const selector = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) s += "." + cls.join(".");
    const tid = el.getAttribute("data-testid");
    if (tid) s += '[data-testid="' + tid + '"]';
    return s;
  };
  const domPath = (el) => {
    const parts = [];
    for (let e = el; e && e.parentElement && e !== body; e = e.parentElement) {
      parts.unshift(e.tagName.toLowerCase() + ":nth-child(" + (Array.prototype.indexOf.call(e.parentElement.children, e) + 1) + ")");
    }
    return ["body"].concat(parts).join(" > ");
  };

  // ---------------------------------------------------------------- visibility
  const exclude = ["[data-figtest-ignore]"].concat(Array.isArray(window.__FIGTEST_EXCLUDE__) ? window.__FIGTEST_EXCLUDE__ : []);
  const excluded = (el) => exclude.some((s) => { try { return !!el.closest(s); } catch (e) { return false; } });
  const tinyEl = (cs, r) => r.width <= 1 || r.height <= 1
    || (cs.position === "absolute" && (cs.clip !== "auto" || cs.clipPath !== "none") && (r.width <= 2 || r.height <= 2));

  // area left visible by the overflow of the ancestors (viewport coordinates), null = not clipped
  const clipMemo = new Map();
  const ownClip = (e) => {
    if (!e || e === body || e === doc) return null;
    const s = style(e);
    if (s.overflowX === "visible" && s.overflowY === "visible") return null;
    const r = e.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  };
  const meet = (a, b) => (!a ? b : !b ? a : { l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) });
  const clipFor = (el) => {
    if (clipMemo.has(el)) return clipMemo.get(el);
    let clip = null;
    const s = style(el);
    if (s.position !== "fixed") {
      let cb = el.parentElement;
      // an absolute box escapes the overflow of the static ancestors between it and its containing block
      if (s.position === "absolute") {
        while (cb && cb !== body && cb !== doc && style(cb).position === "static" && style(cb).transform === "none") cb = cb.parentElement;
      }
      if (cb && cb !== doc) clip = meet(clipFor(cb), ownClip(cb));
    }
    clipMemo.set(el, clip);
    return clip;
  };
  const outside = (clip, r) => !!clip && (Math.min(clip.r, r.right) - Math.max(clip.l, r.left) <= 0.5 || Math.min(clip.b, r.bottom) - Math.max(clip.t, r.top) <= 0.5);
  const clippedOut = (el, r) => outside(clipFor(el), r);

  // ---------------------------------------------------------------- text
  const textNodesOf = (el, deep, hidden) => {
    const out = [];
    const walk = (parent) => {
      for (const c of Array.from(parent.childNodes)) {
        if (c.nodeType === 3) { if (norm(c.textContent)) out.push(c); continue; }
        if (!deep || c.nodeType !== 1 || c.ownerSVGElement || c.tagName.toLowerCase() === "svg") continue;
        const cs = style(c);
        if (cs.display === "none") continue;
        if (cs.display === "contents") { walk(c); continue; }
        if (cs.visibility !== "visible") continue;
        const r = c.getBoundingClientRect();
        if (tinyEl(cs, r) || clippedOut(c, r)) { if (hidden) hidden.push(norm(c.textContent)); continue; }
        walk(c);
      }
    };
    walk(el);
    return out;
  };

  /** Union of the client rects of text nodes, grouped into lines. */
  const textGeometry = (nodes) => {
    const rects = [];
    for (const n of nodes) {
      const range = document.createRange();
      range.selectNodeContents(n);
      const pe = n.parentElement;
      const clip = pe ? meet(clipFor(pe), ownClip(pe)) : null;
      for (const q of Array.from(range.getClientRects())) if (q.width > 0.5 && q.height > 0.5 && !outside(clip, q)) rects.push(q);
    }
    if (!rects.length) return null;
    rects.sort((a, b) => a.top - b.top || a.left - b.left);
    const lines = [];
    for (const q of rects) {
      const last = lines[lines.length - 1];
      // same line when the rects overlap vertically by more than half of the smaller one
      if (last && Math.min(last.bottom, q.bottom) - Math.max(last.top, q.top) > Math.min(last.bottom - last.top, q.height) / 2) {
        last.top = Math.min(last.top, q.top);
        last.bottom = Math.max(last.bottom, q.bottom);
      } else lines.push({ top: q.top, bottom: q.bottom });
    }
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const q of rects) { x1 = Math.min(x1, q.left); y1 = Math.min(y1, q.top); x2 = Math.max(x2, q.right); y2 = Math.max(y2, q.bottom); }
    const lineH = lines.reduce((s, l) => s + (l.bottom - l.top), 0) / lines.length;
    const pitch = lines.length > 1 ? (lines[lines.length - 1].top - lines[0].top) / (lines.length - 1) : null;
    return { x: x1 + sx, y: y1 + sy, w: x2 - x1, h: y2 - y1, lines: lines.length, lineH: lineH, pitch: pitch };
  };

  const alignOf = (a) => (a === "start" || a === "-webkit-left" ? "left" : a === "end" || a === "-webkit-right" ? "right" : a === "-webkit-center" ? "center" : a);

  // text decorations propagate from the ancestors, except into atomic inlines and out-of-flow boxes
  const decorationOf = (el) => {
    let lines = "";
    for (let e = el; e && e.nodeType === 1 && e !== doc; e = e.parentElement) {
      const s = style(e);
      lines += " " + s.textDecorationLine;
      if (s.display.indexOf("inline-") === 0 || s.float !== "none" || s.position === "absolute" || s.position === "fixed") break;
    }
    return lines.indexOf("underline") >= 0 ? "underline" : lines.indexOf("line-through") >= 0 ? "line-through" : "none";
  };

  const typography = (cs, el) => {
    const family = firstFamily(cs.fontFamily);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const normal = cs.lineHeight === "normal";
    return {
      lines: 1,
      fontFamily: family,
      fontWeight: weight,
      fontSize: px(cs.fontSize),
      lineHeight: normal ? null : round(px(cs.lineHeight)),
      lineHeightNormal: normal,
      letterSpacing: cs.letterSpacing === "normal" ? 0 : round(px(cs.letterSpacing)),
      color: toHex(cs.color) || "#00000000",
      decoration: decorationOf(el),
      transform: cs.textTransform,
      align: alignOf(cs.textAlign),
      fontStatus: fontStatus(family, weight),
    };
  };

  // line-height "normal" measured with a probe after the walk (adding it earlier could restyle the page)
  const pending = [];
  const bx = (x, y, w, h) => ({ x: round(x), y: round(y), w: round(w), h: round(h) });

  // ---------------------------------------------------------------- walk
  const SKIP = new Set(["script", "style", "noscript", "template", "link", "meta", "br", "wbr", "option", "optgroup", "datalist",
    "source", "track", "head", "title", "param", "area", "map"]);
  const MEDIA = ["img", "svg", "video", "canvas", "picture", "iframe", "object", "embed"];
  const NO_TEXT_INPUT = ["checkbox", "radio", "hidden", "range", "color", "file", "image"];
  const elements = [];
  const index = new Map();
  const list = body ? [body].concat(Array.from(body.querySelectorAll("*"))) : [];

  for (const el of list) {
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag) || el.ownerSVGElement) continue;
    const isBody = el === body;
    const cs = style(el);
    const rect = el.getBoundingClientRect();
    if (!isBody) {
      if (excluded(el)) continue;
      if (cs.display === "none" || cs.display === "contents" || cs.visibility !== "visible") continue;
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) continue;
      if (rect.right + sx <= 0 || rect.bottom + sy <= 0) continue;
      if (clippedOut(el, rect)) continue;
    }

    let p = -1;
    for (let a = el.parentElement; a; a = a.parentElement) { const k = index.get(a); if (k !== undefined) { p = k; break; } }
    const i = elements.length;
    const radiusRaw = cs.borderTopLeftRadius || "0";
    const borderStyled = cs.borderTopStyle !== "none" || cs.borderRightStyle !== "none" || cs.borderBottomStyle !== "none" || cs.borderLeftStyle !== "none";
    const bgImage = cs.backgroundImage || "none";
    const item = {
      i: i, p: p, tag: tag, sel: selector(el), path: domPath(el),
      box: bx(rect.left + sx, rect.top + sy, rect.width, rect.height),
      bg: isBody ? toHex(cs.backgroundColor) || toHex(style(doc).backgroundColor) : toHex(cs.backgroundColor),
      bgImage: bgImage.indexOf("url(") >= 0,
      bgGradient: bgImage.indexOf("gradient(") >= 0,
      img: MEDIA.indexOf(tag) >= 0,
      border: {
        t: cs.borderTopStyle === "none" ? 0 : px(cs.borderTopWidth),
        r: cs.borderRightStyle === "none" ? 0 : px(cs.borderRightWidth),
        b: cs.borderBottomStyle === "none" ? 0 : px(cs.borderBottomWidth),
        l: cs.borderLeftStyle === "none" ? 0 : px(cs.borderLeftWidth),
        color: borderStyled ? toHex(cs.borderTopStyle !== "none" ? cs.borderTopColor : cs.borderLeftStyle !== "none" ? cs.borderLeftColor : cs.borderBottomStyle !== "none" ? cs.borderBottomColor : cs.borderRightColor) : null,
      },
      radius: round(radiusRaw.indexOf("%") > 0 ? (px(radiusRaw) / 100) * rect.width : px(radiusRaw)),
      padding: { t: px(cs.paddingTop), r: px(cs.paddingRight), b: px(cs.paddingBottom), l: px(cs.paddingLeft) },
      gap: { row: px(cs.rowGap), col: px(cs.columnGap) },
      display: cs.display,
      flexDirection: cs.flexDirection,
      opacity: parseFloat(cs.opacity),
      shadow: !!cs.boxShadow && cs.boxShadow !== "none",
    };
    index.set(el, i);
    elements.push(item);
    if (item.img) continue;

    try {
      // form fields: their value (or placeholder) is text the design shows, but there is no text node
      const type = tag === "input" ? String(el.type || "text").toLowerCase() : "";
      if ((tag === "input" && NO_TEXT_INPUT.indexOf(type) < 0) || tag === "textarea" || tag === "select") {
        const value = tag === "select" ? (el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].textContent : "") : el.value;
        const usePlaceholder = !value && !!el.placeholder;
        const text = norm(usePlaceholder ? el.placeholder : value);
        if (!text) continue;
        const t = typography(cs, el);
        if (usePlaceholder) t.color = toHex(getComputedStyle(el, "::placeholder").color) || t.color;
        if (!fontCtx) fontCtx = document.createElement("canvas").getContext("2d");
        fontCtx.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
        const bl = px(cs.borderLeftWidth), br = px(cs.borderRightWidth), bt = px(cs.borderTopWidth), bb = px(cs.borderBottomWidth);
        const innerL = rect.left + bl + px(cs.paddingLeft);
        const innerW = rect.width - bl - br - px(cs.paddingLeft) - px(cs.paddingRight);
        const innerT = rect.top + bt + px(cs.paddingTop);
        const innerH = rect.height - bt - bb - px(cs.paddingTop) - px(cs.paddingBottom);
        const w = Math.min(fontCtx.measureText(text).width, innerW);
        const centered = (tag === "input" && ["submit", "button", "reset"].indexOf(type) >= 0) || t.align === "center";
        const x = (centered ? innerL + (innerW - w) / 2 : t.align === "right" ? innerL + innerW - w : innerL) + sx;
        const place = (lh) => {
          const y = (tag === "textarea" ? innerT : innerT + (innerH - lh) / 2) + sy;
          const b = bx(x, y, w, lh);
          return b;
        };
        const dt = Object.assign({ own: text, full: null, box: null, glyph: null }, t);
        if (usePlaceholder) dt.placeholder = true;
        if (dt.lineHeight === null) pending.push({ cs: cs, cjk: cjkRe.test(text), apply: (h) => { dt.lineHeight = round(h); dt.box = place(h); dt.glyph = place(h); } });
        else { dt.box = place(dt.lineHeight); dt.glyph = place(dt.lineHeight); }
        item.text = dt;
        continue;
      }

      if (isBody || !tinyEl(cs, rect)) {
        const own = textNodesOf(el, false, null);
        // React splits "Reviews [{n}]" into adjacent text nodes: glue those, put a space where an element sits between
        let ownText = "";
        own.forEach((t, k) => { ownText += (k && own[k - 1].nextSibling !== t ? " " : "") + t.textContent; });
        ownText = norm(ownText);
        let full = null;
        let deep = null;
        if (el.children.length && !isBody) {
          const tc = el.textContent || "";
          if (tc.length <= LIMIT * 3) {
            let inner = norm(el.innerText);
            if (inner && inner !== ownText && inner.length <= LIMIT) {
              const hidden = [];
              deep = textNodesOf(el, true, hidden);
              // innerText keeps visually hidden text (sr-only): take it out
              for (const h of hidden) {
                if (!h) continue;
                const k = inner.indexOf(h);
                if (k >= 0) inner = norm(inner.slice(0, k) + " " + inner.slice(k + h.length));
              }
              if (inner && inner !== ownText) full = inner;
            }
          }
        }
        if (ownText || full) {
          const geo = textGeometry(full ? deep : own);
          if (geo) {
            const dt = Object.assign({ own: ownText, full: full, box: null, glyph: bx(geo.x, geo.y, geo.w, geo.h) }, typography(cs, el));
            dt.lines = geo.lines;
            // line boxes: the glyph rects grown by the half-leading on both sides (Chrome floors the top half)
            const grow = (lh) => {
              const lead = lh - geo.lineH;
              const top = lead > 0 ? Math.floor(lead / 2 + 0.001) : lead / 2;
              dt.box = bx(geo.x, geo.y - top, geo.w, geo.h + lead);
            };
            if (dt.lineHeight === null && geo.pitch) dt.lineHeight = round(geo.pitch);
            if (dt.lineHeight === null) pending.push({ cs: cs, cjk: cjkRe.test(full || ownText), apply: (h) => { dt.lineHeight = round(h); grow(h); } });
            else grow(dt.lineHeight);
            item.text = dt;
          }
        }
      }
    } catch (e) { /* keep the element without its text */ }
  }

  if (pending.length && (body || doc)) {
    const probe = document.createElement("span");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden;display:inline-block;white-space:nowrap;line-height:normal;margin:0;padding:0;border:0;letter-spacing:normal;text-transform:none";
    (body || doc).appendChild(probe);
    const memo = new Map();
    try {
      for (const q of pending) {
        const key = [q.cs.fontFamily, q.cs.fontSize, q.cs.fontWeight, q.cs.fontStyle, q.cjk].join("|");
        let h = memo.get(key);
        if (h === undefined) {
          probe.style.fontFamily = q.cs.fontFamily;
          probe.style.fontSize = q.cs.fontSize;
          probe.style.fontWeight = q.cs.fontWeight;
          probe.style.fontStyle = q.cs.fontStyle;
          probe.textContent = q.cjk ? "Ag\u{3042}\u{6C38}" : "Ag";
          h = probe.getBoundingClientRect().height;
          memo.set(key, h);
        }
        q.apply(h);
      }
    } finally { probe.remove(); }
  }

  return {
    url: location.href,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    page: { w: Math.max(doc.scrollWidth, body ? body.scrollWidth : 0), h: Math.max(doc.scrollHeight, body ? body.scrollHeight : 0) },
    elements: elements,
  };
})()`;

/** A self-contained JS expression; `await page.evaluate(COLLECT_DOM_SCRIPT)` returns a DomSnapshot. */
export const COLLECT_DOM_SCRIPT: string = SCRIPT;

/** Runs the collector in a page (anything with evaluate(string), like a Playwright Page). */
export async function collectDom(page: { evaluate(script: string): Promise<unknown> }): Promise<DomSnapshot> {
  return (await page.evaluate(COLLECT_DOM_SCRIPT)) as DomSnapshot;
}
