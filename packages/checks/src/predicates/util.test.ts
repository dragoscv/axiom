import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findCardNumber, luhnValid } from "./content.js";
import {
  caseInsensitivePlatform,
  DEFAULT_GLOB_NOCASE,
  escapeRouteGroups,
  globMatcher,
} from "./util.js";

describe("escapeRouteGroups (S-408)", () => {
  it("escapes a plain parenthesised segment", () => {
    expect(escapeRouteGroups("app/(app)/**")).toBe("app/\\(app\\)/**");
    expect(escapeRouteGroups("src/app/(marketing)/(home)/page.tsx")).toBe(
      "src/app/\\(marketing\\)/\\(home\\)/page.tsx",
    );
  });
  it("leaves already-escaped groups and real extglobs alone", () => {
    for (const g of [
      "app/\\(app\\)/**",
      "src/@(a|b)/**",
      "src/!(test)/**",
      "src/+(x)/**",
      "src/?(y)/**",
      "src/*(z)/**",
      "src/(a|b)/**",
      "src/(a*)/**",
    ]) {
      expect(escapeRouteGroups(g)).toBe(g);
    }
  });
  it("globMatcher matches Next route groups literally", () => {
    const m = globMatcher(["apps/web/src/app/(app)/**"], false);
    expect(m("apps/web/src/app/(app)/dashboard/page.tsx")).toBe(true);
    expect(m("apps/web/src/app/(marketing)/page.tsx")).toBe(false);
    expect(m("apps/web/src/app/app/page.tsx")).toBe(false);
  });
});

describe("globMatcher case sensitivity follows the filesystem", () => {
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  it.runIf(caseInsensitive)(
    "win32/darwin: `.ENV` is caught by a `.env` deny glob by default",
    () => {
      const m = globMatcher(["**/.env", ".env"], false);
      expect(m(".ENV")).toBe(true);
      expect(m("apps/web/.Env")).toBe(true);
    },
  );
  it.runIf(!caseInsensitive)("linux: case-sensitive by default", () => {
    const m = globMatcher(["**/.env", ".env"], false);
    expect(m(".ENV")).toBe(false);
    expect(m(".env")).toBe(true);
  });
  it("the default follows the platform on every OS (win32/darwin insensitive, linux sensitive)", () => {
    expect(globMatcher([".env"], false, { platform: "win32" })(".ENV")).toBe(true);
    expect(globMatcher([".env"], false, { platform: "darwin" })(".ENV")).toBe(true);
    expect(globMatcher([".env"], false, { platform: "linux" })(".ENV")).toBe(false);
    expect(DEFAULT_GLOB_NOCASE).toBe(caseInsensitivePlatform(process.platform));
  });
  it("explicit nocase overrides the platform default both ways", () => {
    expect(globMatcher([".env"], false, { nocase: true })(".ENV")).toBe(true);
    expect(globMatcher([".env"], false, { nocase: false })(".ENV")).toBe(false);
  });
});

describe("luhnValid / findCardNumber (S-408)", () => {
  it("known test PANs pass, their neighbours fail", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(luhnValid("378282246310005")).toBe(true);
    expect(luhnValid("")).toBe(false);
    expect(luhnValid("12a4")).toBe(false);
  });
  it("property: appending the Luhn check digit always validates", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9]{12,15}$/), (body) => {
        // compute check digit
        let sum = 0;
        let double = true;
        for (let i = body.length - 1; i >= 0; i--) {
          let d = body.charCodeAt(i) - 48;
          if (double) {
            d *= 2;
            if (d > 9) d -= 9;
          }
          sum += d;
          double = !double;
        }
        const check = (10 - (sum % 10)) % 10;
        return luhnValid(body + String(check));
      }),
    );
  });
  it("property: a repeated single digit is never a card, whatever its Luhn status", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9 }), fc.integer({ min: 13, max: 16 }), (d, n) => {
        return findCardNumber(`x ${String(d).repeat(n)} y`) === false;
      }),
    );
  });
  it("property: digits inside a UUID never form a card", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.stringMatching(/^[0-9]{8}$/),
          fc.stringMatching(/^[0-9]{4}$/),
          fc.stringMatching(/^[0-9]{4}$/),
          fc.stringMatching(/^[0-9]{4}$/),
          fc.stringMatching(/^[0-9]{12}$/),
        ),
        ([a, b, c, d, e]) => findCardNumber(`id: ${a}-${b}-${c}-${d}-${e};`) === false,
      ),
    );
  });
});
