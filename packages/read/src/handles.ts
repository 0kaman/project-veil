/**
 * The handle store — handle-not-payload for reads.
 *
 * A full extract can be 10k tokens; seven of them kills the model's context.
 * So the full text stays HERE, host-side, and the caller gets a short handle.
 * `pull(handle, query)` returns only the relevant paragraphs on demand — which
 * is also search-within-page, so there is no separate grep verb.
 */
import { budgetParagraphs } from "./budget.js";
import { countWords } from "./extract.js";

export interface StoredRead {
  url: string;
  title: string | null;
  /** Full extracted text, paragraphs separated by blank lines. */
  fullText: string;
  outline: string[];
}

export interface Pull {
  text: string;
  words: number;
  totalWords: number;
  /** Paragraphs returned, of the total available. */
  matched: number;
  paragraphs: number;
  note?: string;
}

export class HandleStore {
  private map = new Map<string, StoredRead>();
  private seq = 0;

  put(r: StoredRead): string {
    const id = `r${++this.seq}`;
    this.map.set(id, r);
    return id;
  }

  get(id: string): StoredRead | undefined {
    return this.map.get(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  /**
   * Pull from a stored read. With a query, return the paragraphs that mention it
   * (search-within-page); without one, return from the top up to the budget.
   * Returns null for an unknown handle so the caller can report it honestly
   * rather than silently returning nothing.
   */
  pull(
    id: string,
    query: string | undefined,
    budgetWords: number,
    budgetChars: number = budgetWords * 8,
  ): Pull | null {
    const stored = this.map.get(id);
    if (!stored) return null;

    const paras = stored.fullText.split(/\n\n+/).filter((p) => p.trim());
    const totalWords = countWords(stored.fullText);

    let picked: string[];
    let matched: number;
    if (query && query.trim()) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = paras.filter((p) => {
        const low = p.toLowerCase();
        return terms.some((t) => low.includes(t));
      });
      matched = hits.length;
      picked = hits;
    } else {
      matched = paras.length;
      picked = paras;
    }

    // Fill up to the budget, paragraph by paragraph. Cutting mid-paragraph is a
    // last resort — but it IS done, and reported, because a single paragraph
    // that is the whole document used to be returned entire (budget.ts).
    const cut = budgetParagraphs(picked, budgetWords, budgetChars);

    const note =
      query && matched === 0
        ? `no paragraph mentions "${query}" — try the outline, or a broader term`
        : cut.hardCut
          ? (cut.cause === "chars"
              ? `cut mid-paragraph at the ${budgetChars}-character ceiling`
              : `cut mid-paragraph — this text has no paragraph breaks to cut on`) +
            (query ? "; narrow the query to land on a smaller span" : "")
          : cut.offered > cut.kept
            ? `returned ${cut.kept} of ${cut.offered} ${query ? "matching " : ""}paragraphs — ${query ? "narrow the query for more" : "pull with a query for a specific part"}`
            : undefined;

    return {
      text: cut.text,
      words: cut.words,
      totalWords,
      matched,
      paragraphs: paras.length,
      note,
    };
  }

  /** For tests and long-running processes — drop everything. */
  clear(): void {
    this.map.clear();
    this.seq = 0;
  }
}
