/**
 * Fitting text to a budget — the one primitive, used by both sites that cut.
 *
 * The rule that was missing: a budget must ALWAYS cut. Both cutters carried an
 * escape hatch (`&& kept.length > 0`, `&& out.length > 0`) meaning "if the very
 * first unit is already over budget, return it whole". On any body that is a
 * single paragraph that is the entire body — 7,500 words returned under a
 * receipt reading `truncated: true, words: 7500, totalWords: 7500`, and 805 KB
 * of minified JSON inline in a model's context.
 *
 * So the ladder is: whole paragraphs → whole lines → a hard character cut. Each
 * rung is tried before the one below it, and a cut below the paragraph rung is
 * reported as a hard cut, because a receipt that says `truncated` while having
 * sliced mid-sentence without saying so is the same defect in a smaller coat.
 *
 * `budgetChars` exists because whitespace word-counting is meaningless on
 * minified content: 805 KB of JSON is ~10,836 "words". It is a CEILING applied
 * after the word logic, never a competing budget evaluated first — evaluating it
 * first would change which paragraphs an ordinary article keeps.
 */
import { countWords } from "./extract.js";

export interface BudgetResult {
  text: string;
  /** Words in `text` — always the truth about what came back. */
  words: number;
  /** A unit had to be cut in the middle. The caller must surface this. */
  hardCut: boolean;
  /**
   * WHY it ended where it did. The distinction is not cosmetic: RFC 7231 has
   * paragraph breaks in abundance and is cut by the character ceiling, so a note
   * reading "this body has no paragraph breaks to cut on" would be false on the
   * very document that motivated the ceiling.
   * - `fit`           — whole paragraphs, nothing sliced.
   * - `chars`         — whole paragraphs kept, then trimmed at the char ceiling.
   * - `oversize-unit` — the first paragraph alone blew the budget; cut inside it.
   */
  cause: "fit" | "chars" | "oversize-unit";
  /** Whole units kept, of the units offered. */
  kept: number;
  offered: number;
}

/** Trim to a character ceiling, preferring a whitespace boundary when one sits
 * reasonably close to the limit rather than slicing mid-token. */
function capChars(text: string, budgetChars: number): { text: string; cut: boolean } {
  if (text.length <= budgetChars) return { text, cut: false };
  const slice = text.slice(0, budgetChars);
  const at = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
  const out = at > budgetChars * 0.5 ? slice.slice(0, at) : slice;
  return { text: out.trimEnd(), cut: true };
}

/** Cut a single over-budget unit: whole lines if any fit, else words, else
 * characters. Always returns something — that is the whole point. */
function cutUnit(unit: string, budgetWords: number, budgetChars: number): string {
  const lines = unit.split("\n");
  if (lines.length > 1) {
    const kept: string[] = [];
    let words = 0;
    for (const line of lines) {
      const w = countWords(line);
      if (words + w > budgetWords) break;
      kept.push(line);
      words += w;
    }
    if (kept.length > 0) return capChars(kept.join("\n"), budgetChars).text;
  }
  // A single line that is itself over budget — cut by words, then by chars.
  const parts = unit.trim().split(/\s+/);
  const byWords = parts.slice(0, Math.max(1, budgetWords)).join(" ");
  return capChars(byWords, budgetChars).text;
}

/**
 * Fit paragraphs to a word budget and a character ceiling.
 *
 * Whole paragraphs are kept while they fit — byte-for-byte the previous
 * behaviour for anything with paragraph structure, which is what keeps the
 * corpus-tuned fetch path from moving. Only when NOTHING fits does it descend to
 * lines and then to characters, and it says so when it does.
 */
export function budgetParagraphs(
  paras: string[],
  budgetWords: number,
  budgetChars: number,
): BudgetResult {
  const units = paras.filter((p) => p.trim());
  const kept: string[] = [];
  let words = 0;
  for (const p of units) {
    const w = countWords(p);
    if (words + w > budgetWords) break;
    kept.push(p);
    words += w;
  }

  if (kept.length > 0) {
    // The ceiling applies AFTER the word logic, and normally does nothing.
    const capped = capChars(kept.join("\n\n"), budgetChars);
    return {
      text: capped.text,
      words: capped.cut ? countWords(capped.text) : words,
      hardCut: capped.cut,
      cause: capped.cut ? "chars" : "fit",
      kept: capped.cut ? kept.length - 1 : kept.length,
      offered: units.length,
    };
  }

  // Nothing fit whole — the case the old code refused to handle.
  const first = units[0] ?? "";
  const text = cutUnit(first, budgetWords, budgetChars);
  return {
    text,
    words: countWords(text),
    hardCut: text.length < first.length,
    cause: "oversize-unit",
    kept: 0,
    offered: units.length,
  };
}
