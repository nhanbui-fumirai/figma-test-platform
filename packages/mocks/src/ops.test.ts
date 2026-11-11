import { describe, expect, it } from "vitest";
import type { MockOp } from "@figtest/contracts";
import { applyOps, applyOpsChecked } from "./index";

const recorded = () => ({
  data: {
    total: 3,
    available: true,
    asOf: "2026-05-05T16:00:00+09:00",
    flights: [
      { id: "F1", code: "NH123", from: "NRT", seat: "A12", status: "ON_TIME", cabinType: "economy", name: "Morning", date: "2026-05-05", price: 47000 },
      { id: "F2", code: "JL5", from: "HND", seat: "B3", status: "DELAYED", cabinType: "business", name: "Evening", date: "2026-05-06", price: 98000 },
    ],
    tags: ["new", "sale"],
  },
});

describe("applyOps", () => {
  it("sets, removes, inserts and duplicates by JSON Pointer without changing the input", () => {
    const input = recorded();
    const before = JSON.stringify(input);
    const out = applyOps(input, [
      { op: "set", path: "/data/flights/0/price", value: 12000 },
      { op: "set", path: "/data/new~1key", value: { a: 1 } },
      { op: "remove", path: "/data/tags/0" },
      { op: "insert", path: "/data/tags", index: 1, value: "hot" },
      { op: "duplicate", path: "/data/flights", index: 1, count: 2 },
      { op: "set", path: "/data/tags/-", value: "last" },
    ]) as ReturnType<typeof recorded> & { data: { "new/key": unknown } };
    expect(JSON.stringify(input)).toBe(before);
    expect(out.data.flights[0]?.price).toBe(12000);
    expect(out.data["new/key"]).toEqual({ a: 1 });
    expect(out.data.tags).toEqual(["sale", "hot", "last"]);
    expect(out.data.flights.map((f) => f.id)).toEqual(["F1", "F2", "F2", "F2"]);
    // the copies are separate values
    (out.data.flights[2] as { id: string }).id = "X";
    expect(out.data.flights[3]?.id).toBe("F2");
  });

  it("replaces the whole body with path \"\"", () => {
    const value = { other: [1, 2] };
    const out = applyOps(recorded(), [{ op: "set", path: "", value }]);
    expect(out).toEqual(value);
    expect(out).not.toBe(value);
  });

  it("throws on a bad path", () => {
    expect(() => applyOps(recorded(), [{ op: "set", path: "/nope/deeper", value: 1 }])).toThrow(/\/nope\/deeper/);
    expect(() => applyOps(recorded(), [{ op: "remove", path: "/data/flights/9" }])).toThrow(/out of the list/);
    expect(() => applyOps(recorded(), [{ op: "insert", path: "/data/total", index: 0, value: 1 }])).toThrow(/not a list/);
    expect(() => applyOps(recorded(), [{ op: "set", path: "data", value: 1 }])).toThrow(/starts with "\/"/);
    expect(() => applyOps(recorded(), [{ op: "remove", path: "" }])).toThrow(/whole body/);
  });

  it("keeps __proto__ a plain key", () => {
    const out = applyOps({}, [{ op: "set", path: "/__proto__", value: { polluted: true } }]) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("applyOpsChecked", () => {
  const check = (ops: MockOp[]) => applyOpsChecked(recorded(), ops);
  const flights = (body: unknown) => (body as ReturnType<typeof recorded>).data.flights;

  it("accepts edits of the same kind", () => {
    const r = check([
      { op: "set", path: "/data/flights/0/price", value: 51000 },
      { op: "set", path: "/data/flights/0/from", value: "KIX" },
      { op: "set", path: "/data/flights/0/seat", value: "C34" },
      { op: "set", path: "/data/flights/0/code", value: "ANA1234" },
      { op: "set", path: "/data/flights/0/status", value: "DELAYED" },
      { op: "set", path: "/data/flights/0/date", value: "2026-12-24" },
      { op: "set", path: "/data/asOf", value: "2026-12-24T09:30:00Z" },
      { op: "set", path: "/data/flights/0/name", value: "朝の便 NRT" },
      { op: "set", path: "/data/available", value: false },
      { op: "set", path: "/data/flights/0/price", value: null },
    ]);
    expect(r.violations).toEqual([]);
    expect(flights(r.body)[0]).toMatchObject({ from: "KIX", seat: "C34", code: "ANA1234", status: "DELAYED", name: "朝の便 NRT", price: null });
  });

  it("refuses a value of another kind and explains it", () => {
    const r = check([
      { op: "set", path: "/data/flights/0/price", value: "47,000円" },
      { op: "set", path: "/data/available", value: "yes" },
      { op: "set", path: "/data/total", value: { n: 3 } },
      { op: "set", path: "/data/flights/1/price", value: 1 },
    ]);
    expect(r.violations).toEqual([
      "/data/flights/0/price: number expected, got string",
      "/data/available: boolean expected, got string",
      "/data/total: number expected, got object",
    ]);
    // a refused op is skipped, the others apply
    expect(flights(r.body)[0]?.price).toBe(47000);
    expect(flights(r.body)[1]?.price).toBe(1);
  });

  it("keeps ISO dates, code patterns and enum values", () => {
    const r = check([
      { op: "set", path: "/data/asOf", value: "2026年5月5日(金) 16:00時点" },
      { op: "set", path: "/data/flights/0/date", value: "2026-05-05T10:00:00Z" },
      { op: "set", path: "/data/flights/0/from", value: "Tokyo Narita" },
      { op: "set", path: "/data/flights/0/seat", value: "12A" },
      { op: "set", path: "/data/flights/0/status", value: "CANCELLED" },
      { op: "set", path: "/data/flights/0/cabinType", value: "first" },
      { op: "set", path: "/data/flights/0/cabinType", value: "business" },
    ]);
    expect(r.violations).toHaveLength(6);
    expect(r.violations[0]).toMatch(/^\/data\/asOf: an ISO date-time expected/);
    expect(r.violations[1]).toMatch(/^\/data\/flights\/0\/date: an ISO date expected/);
    expect(r.violations[2]).toMatch(/^\/data\/flights\/0\/from: a code like "NRT" expected/);
    expect(r.violations[3]).toMatch(/^\/data\/flights\/0\/seat: a code like "A12" expected/);
    expect(r.violations[4]).toMatch(/^\/data\/flights\/0\/status: one of "ON_TIME", "DELAYED" expected/);
    expect(r.violations[5]).toMatch(/^\/data\/flights\/0\/cabinType: one of "economy", "business" expected/);
    expect(flights(r.body)[0]?.cabinType).toBe("business");
  });

  it("checks a whole-body set node by node", () => {
    const body = recorded();
    const bad = structuredClone(body) as unknown as { data: { flights: { price: unknown }[] } };
    bad.data.flights[1]!.price = "98,000";
    const r = check([{ op: "set", path: "", value: bad }]);
    expect(r.violations).toEqual(["/data/flights/1/price: number expected, got string"]);
    expect(r.body).toEqual(recorded());

    const good = structuredClone(body);
    good.data.flights[1]!.price = 99000;
    expect(check([{ op: "set", path: "", value: good }])).toEqual({ body: good, violations: [] });
  });

  it("checks an inserted item against the other items", () => {
    const r = check([{ op: "insert", path: "/data/flights", index: 2, value: { id: "F3", price: "free" } }]);
    expect(r.violations).toEqual(["/data/flights/2/price: number expected, got string"]);
    expect(flights(r.body)).toHaveLength(2);
  });

  it("keeps the items of a list distinct", () => {
    // a copy left equal to its original is refused
    const r = check([{ op: "duplicate", path: "/data/flights", index: 0, count: 1 }]);
    expect(r.violations).toEqual([expect.stringMatching(/^\/data\/flights: duplicate refused: items 0 and 1 of \/data\/flights would be the same record/)]);
    expect(flights(r.body)).toHaveLength(2);

    // a copy made distinct by the next ops is fine
    const ok = check([
      { op: "duplicate", path: "/data/flights", index: 0, count: 2 },
      { op: "set", path: "/data/flights/1/id", value: "F7" },
      { op: "set", path: "/data/flights/2/id", value: "F8" },
    ]);
    expect(ok.violations).toEqual([]);
    expect(flights(ok.body).map((f) => f.id)).toEqual(["F1", "F7", "F8", "F2"]);

    // the code pattern of the id still holds for the copies
    // (the copy stays equal, so the duplicate goes too)
    expect(check([{ op: "duplicate", path: "/data/flights", index: 0 } as MockOp, { op: "set", path: "/data/flights/1/id", value: "F1-copy" }]).violations).toEqual([
      expect.stringMatching(/^\/data\/flights: duplicate refused/),
      expect.stringMatching(/^\/data\/flights\/1\/id: a code like "F\d" expected/),
    ]);

    // a set that makes two items equal is refused
    const same = check([{ op: "set", path: "/data/flights/1", value: recorded().data.flights[0] }]);
    expect(same.violations).toEqual([expect.stringMatching(/^\/data\/flights\/1: set refused: items 0 and 1/)]);
    expect(flights(same.body)[1]?.id).toBe("F2");

    // equal strings in a list are not records: allowed
    expect(check([{ op: "set", path: "/data/tags/1", value: "new" }]).violations).toEqual([]);
  });

  it("does not change the recorded body and reports bad paths", () => {
    const input = recorded();
    const before = JSON.stringify(input);
    const r = applyOpsChecked(input, [
      { op: "set", path: "/data/missing/x", value: 1 },
      { op: "set", path: "/data/flights/0/price", value: 1 },
    ]);
    expect(JSON.stringify(input)).toBe(before);
    expect(r.violations).toEqual([expect.stringMatching(/^\/data\/missing\/x: no such place/)]);
    expect(flights(r.body)[0]?.price).toBe(1);
  });
});
