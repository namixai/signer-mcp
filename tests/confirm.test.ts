// Что считается согласием на трату чужих денег.
import { describe, it, expect } from "vitest";
import { interpretConfirmation } from "../src/confirm.js";

const buf = (s: string) => Buffer.from(s, "utf8");

describe("согласие требует нажатия, а не отсутствия возражений", () => {
  it("🔴 EOF — не согласие", () => {
    // `readSync` возвращает 0 при закрытом терминале, перенаправленном вводе и запуске
    // из скрипта. Раньше это давало пустую строку, а пустая строка означала Enter: платёж
    // уходил бы, хотя никто ничего не нажимал.
    expect(interpretConfirmation(0, Buffer.alloc(64))).toEqual({ ok: false, reason: "eof" });
    expect(interpretConfirmation(-1, Buffer.alloc(64)).ok).toBe(false);
  });

  it("Enter и явное y/yes — согласие", () => {
    for (const s of ["\n", "\r\n", "y\n", "Y\n", "yes\n", "  yes  \n"]) {
      expect(interpretConfirmation(buf(s).length, buf(s)).ok, JSON.stringify(s)).toBe(true);
    }
  });

  it("всё остальное — отказ, включая «no» и случайную клавишу", () => {
    for (const s of ["n\n", "no\n", "нет\n", "x\n", "да\n", "yep\n"]) {
      const r = interpretConfirmation(buf(s).length, buf(s));
      expect(r.ok, JSON.stringify(s)).toBe(false);
      expect(r.reason).toBe("declined");
    }
  });
});
