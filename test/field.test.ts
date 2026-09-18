import { describe, expect, test } from "bun:test";
import { extract, parsePath } from "../src/field";
import { UsageError } from "../src/questions";

const get = (item: unknown, path: string) => extract(item, path, parsePath(path));

describe("--field paths", () => {
  test("a top-level key", () => {
    expect(get({ txt: "hello" }, ".txt")).toEqual({ ok: true, text: "hello" });
  });

  test("a nested key", () => {
    expect(get({ user: { name: "ada" } }, ".user.name")).toEqual({ ok: true, text: "ada" });
  });

  test("an array index", () => {
    expect(get({ items: [{ body: "first" }] }, ".items[0].body")).toEqual({
      ok: true,
      text: "first",
    });
  });

  test("'.' selects the whole item, serialized", () => {
    expect(get({ a: 1 }, ".")).toEqual({ ok: true, text: '{"a":1}' });
  });

  test("numbers and booleans are stringified", () => {
    expect(get({ n: 42 }, ".n")).toEqual({ ok: true, text: "42" });
    expect(get({ b: false }, ".b")).toEqual({ ok: true, text: "false" });
  });

  test("an object or array is serialized compactly", () => {
    expect(get({ o: { a: [1, 2] } }, ".o")).toEqual({ ok: true, text: '{"a":[1,2]}' });
  });
});

describe("--field: every way of not finding text is a named coverage event", () => {
  test("a missing key", () => {
    expect(get({ other: 1 }, ".txt")).toEqual({ ok: false, reason: "field .txt missing" });
  });

  test("a path walking through a non-object", () => {
    expect(get({ txt: "hello" }, ".txt.deeper")).toEqual({
      ok: false,
      reason: "field .txt.deeper missing",
    });
  });

  test("an index past the end of an array", () => {
    expect(get({ items: [] }, ".items[3]")).toEqual({
      ok: false,
      reason: "field .items[3] missing",
    });
  });

  test("an index into something that is not an array", () => {
    expect(get({ items: { a: 1 } }, ".items[0]")).toEqual({
      ok: false,
      reason: "field .items[0] missing",
    });
  });

  test("a null value is named as null, not answered about", () => {
    expect(get({ txt: null }, ".txt")).toEqual({ ok: false, reason: "field .txt is null" });
  });

  test("an empty or whitespace-only value", () => {
    expect(get({ txt: "" }, ".txt")).toEqual({ ok: false, reason: "field .txt empty" });
    expect(get({ txt: "  \n " }, ".txt")).toEqual({ ok: false, reason: "field .txt empty" });
  });

  test("an empty container, which would otherwise be sent as the text {}", () => {
    expect(get({}, ".")).toEqual({ ok: false, reason: "field . empty" });
    expect(get({ a: {} }, ".a")).toEqual({ ok: false, reason: "field .a empty" });
    expect(get({ a: [] }, ".a")).toEqual({ ok: false, reason: "field .a empty" });
  });

  test("a container with anything in it is still real content — the control", () => {
    expect(get({ a: {} }, ".")).toEqual({ ok: true, text: '{"a":{}}' });
    expect(get({ a: [0] }, ".a")).toEqual({ ok: true, text: "[0]" });
  });
});

describe("--field: a malformed path is a usage error, before any spending", () => {
  test.each([["txt"], [".items[a]"], [".items[0"], [".a..b"], ["..a"]])("%s", (path) => {
    expect(() => parsePath(path)).toThrow(UsageError);
  });
});
