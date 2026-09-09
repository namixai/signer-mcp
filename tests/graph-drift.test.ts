// Пять файлов в src/graph/ — копии. Этот тест ловит момент, когда они перестали ими быть.
//
// 🔴 Сторож, который не может выполниться, обязан СКАЗАТЬ это, а не промолчать зелёным.
// Если чекаута сабмит-репозитория рядом нет, тест падает в skip с причиной — «нечего
// сравнить» это не «совпало».

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const VENDORED = new URL("../src/graph/", import.meta.url).pathname;

// Куда смотреть за истиной — за КОММИТ, а не за рабочую копию.
//
// 🔴 Первая редакция сравнивала с каталогом на диске, и он оказался на ветке недельной
// давности. Совпало по удаче: те пять файлов там не менялись. Сравнение с «тем, что
// случайно выкачено» — это сторож, который однажды молча одобрит дрейф. Поэтому истина
// читается из origin/main через git, а рабочая копия не участвует вовсе.
const REPO = process.env.GRAPH_SOURCE_REPO ?? join(process.env.HOME ?? "", "ethonline-sub");
const REF = process.env.GRAPH_SOURCE_REF ?? "origin/main";

function fromGit(file: string): Buffer | null {
  try {
    return execFileSync("git", ["-C", REPO, "show", `${REF}:integrations/graph/src/${file}`], {
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("перенесённые модули не разошлись с источником истины", () => {
  const files = readdirSync(VENDORED).filter((f) => f.endsWith(".js"));
  const source = existsSync(REPO) && fromGit(files[0]) !== null ? `${REPO}@${REF}` : undefined;

  it("копий ровно столько, сколько объявлено в PROVENANCE", () => {
    expect(files.sort()).toEqual(["attestation.js", "chain.js", "fetch.js", "snapshot.js", "usability.js"]);
  });

  it.skipIf(!source)("каждая копия побайтово равна источнику", () => {
    for (const f of files) {
      const theirs = fromGit(f);
      expect(theirs, `в ${source} нет ${f} — файл переименовали или удалили`).not.toBeNull();
      expect(sha(readFileSync(join(VENDORED, f))), `${f} разошёлся с ${source}`).toBe(sha(theirs!));
    }
  });

  it("отсутствие источника видно, а не проглочено", () => {
    if (source) {
      // `source` — это подпись «репозиторий@ref», а не путь на диске. Первая редакция
      // проверяла его через existsSync и падала: сравнение шло по git, а утверждение —
      // по файловой системе. Проверяем то, от чего зависит сравнение: читается ли файл
      // из указанного коммита.
      expect(fromGit(files[0]), `${REF} в ${REPO} не читается`).not.toBeNull();
      return;
    }
    // Сюда попадаем, только если сравнивать не с чем. Тест не падает — иначе он бы
    // валил чужие сборки, — но и не притворяется, что сравнение состоялось.
    console.warn(
      `[graph-drift] СРАВНЕНИЕ НЕ ВЫПОЛНЕНО: чекаут сабмит-репозитория не найден. ` +
        `Искал: ${REPO} @ ${REF}. Задай GRAPH_SOURCE_REPO, иначе дрейф этих пяти файлов никем не ловится.`,
    );
    expect(source).toBeUndefined();
  });
});
